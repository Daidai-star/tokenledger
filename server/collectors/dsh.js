/**
 * dsh (DeepSeek Harness) 采集器。
 *
 * 数据源：~/.dsh/sessions/**\/session.v4.jsonl.zstd
 * zstd 压缩的 JSONL（Node 内置 zstdDecompressSync 解压，无需外部依赖）。
 * 行类型：
 *   {type:"session"}            -> 会话元信息（cwd / createdAt）
 *   {type:"assistant/message"}  -> data.usage {inputTokens,outputTokens,totalTokens,cacheReadTokens}
 *                                   data.source {provider, model}
 *
 * 压缩文件无法做字节级增量游标，改为「整文件哈希 + 内容指纹」：
 * 同一个 (path, size, mtime) 已处理过则跳过；变了就整读，事件表幂等兜底。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { UsageEvent, Collector } from "../model.js";
import { walkFiles, hashId, toTs } from "./util.js";

const SOURCE = "dsh";
const MAX_FILE_BYTES = 512 * 1024 * 1024;

export const dsh = new Collector({
  id: SOURCE,
  name: "DSH",
  website: null,
  color: "#c09553",
  roots: [path.join(os.homedir(), ".dsh", "sessions")],
  detect: () => fs.existsSync(path.join(os.homedir(), ".dsh")),
  async scan(ctx) {
    const files = walkFiles(ctx.roots[SOURCE], {
      exts: [".jsonl.zstd", ".jsonl.zst", ".jsonl"],
      maxDepth: 5,
    });
    const events = [];
    let parsedFiles = 0;

    for (const file of files) {
      const st = fs.statSync(file);
      if (st.size > MAX_FILE_BYTES) continue;

      // 用 size+mtime 当指纹判断是否变更
      const fingerprint = `${st.size}:${Math.round(st.mtimeMs)}`;
      const cur = ctx.cursor(SOURCE, file);
      if (!cur.reset && cur.size === st.size && cur.mtime === st.mtimeMs && cur.byteOffset > 0) continue;

      ctx.emitProgress(SOURCE, events.length, parsedFiles, files.length);
      let text;
      try {
        text = decompress(file);
      } catch {
        continue;
      }

      // 会话 id：优先取 session 记录里的 id，否则用目录名兜底
      const dirName = path.basename(path.dirname(file));
      let sessionId = sessionIdFromText(text) || dirName || path.basename(file);
      let cwd = null;
      let createdAt = 0;
      let model = null;
      let provider = null;
      let messages = 0;
      const lines = text.split("\n");
      let byteOffset = 0;
      // 解压后的会话文件可达数十 MB / 数十万行，周期性让出事件循环，
      // 否则 SSE 进度会一直卡到该文件处理完才发出
      let sinceYield = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        byteOffset += Buffer.byteLength(line, "utf8") + 1;
        sinceYield += line.length;
        if (sinceYield >= (4 << 20)) {
          sinceYield = 0;
          await new Promise((resolve) => setImmediate(resolve));
        }
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (obj.type === "session") {
          cwd = obj.cwd || cwd;
          createdAt = obj.createdAt || createdAt;
          continue;
        }
        const data = obj.data;
        if (obj.type === "request/header" && data?.header?.config) {
          provider = data.header.config.provider || provider;
          model = data.header.config.model || model;
          continue;
        }
        if (obj.type !== "assistant/message") continue;

        const usage = data?.usage;
        if (!usage) continue;
        messages++;
        const input = usage.inputTokens || 0;
        const output = usage.outputTokens || 0;
        if (!input && !output) continue;

        const src = data.source || {};
        const ts = toTs(obj.time) || toTs(data.message?.time);
        if (!ts) continue;
        const m = src.model || model || "deepseek-chat";
        const p = src.provider || provider;

        events.push(
          new UsageEvent({
            id: hashId(SOURCE, sessionId, obj.seq ?? i, input, output),
            tool: SOURCE,
            ts,
            sessionId,
            cwd,
            model: m,
            provider: p,
            protocol: "openai-chat",
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: usage.cacheReadTokens || usage.cache_read_tokens || 0,
            cacheWriteTokens: usage.cacheWriteTokens || 0,
            latencyMs: num(usage.latencyMs || data.latencyMs),
            surface: "desktop",
          }),
        );
      }

      ctx.session({ sessionId, tool: SOURCE, startedAt: createdAt || st.mtimeMs, cwd, model, messages });
      parsedFiles++;
      ctx.advance(SOURCE, file, {
        byteOffset,
        lineNo: lines.length,
        size: st.size,
        mtime: st.mtimeMs,
        fingerprint,
      });
      ctx.emitProgress(SOURCE, events.length, parsedFiles, files.length);
    }

    return { events, stats: { filesSeen: files.length, filesParsed: parsedFiles } };
  },
  profile: () => {
    let account = null;
    try {
      account = fs.readFileSync(path.join(os.homedir(), ".dsh", ".anonymous-user-id"), "utf8").trim();
    } catch {
      /* ignore */
    }
    return { account, plan: null, version: null };
  },
});

function sessionIdFromText(text) {
  for (const line of text.split("\n", 40)) {
    if (!line.includes('"session"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "session" && o.id) return o.id;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * dsh 的 session 文件是**多帧拼接**的 zstd（每帧独立压缩，滚动追加）。
 * Node 的 zstdDecompressSync 只解第一帧，所以：
 *   1) 优先用系统 zstd CLI（正确处理多帧）
 *   2) 退化到「按帧魔数切分逐帧解压」
 *   3) 再退化到单帧 API
 */
function decompress(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith(".zstd") && !file.endsWith(".zst")) {
    return buf.toString("utf8");
  }
  if (hasCli()) {
    try {
      return execFileSync("zstd", ["-dcq", file], {
        encoding: "utf8",
        maxBuffer: MAX_FILE_BYTES * 8,
      });
    } catch {
      /* CLI 不可用则走下面的实现 */
    }
  }
  return decompressMultiFrame(buf);
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressMultiFrame(buf) {
  // 先试单帧（最常见，也最快）
  if (buf.indexOf(ZSTD_MAGIC, 4) === -1) {
    return zlib.zstdDecompressSync(buf).toString("utf8");
  }
  const offsets = [];
  let i = 0;
  for (;;) {
    const j = buf.indexOf(ZSTD_MAGIC, i);
    if (j < 0) break;
    offsets.push(j);
    i = j + 1;
  }
  let out = "";
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k];
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      out += zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    } catch {
      // 魔数可能落在压缩流内部，切分点错误；跳过这一段
    }
  }
  return out;
}

let _cli = null;
function hasCli() {
  if (_cli !== null) return _cli;
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
    _cli = true;
  } catch {
    _cli = false;
  }
  return _cli;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}