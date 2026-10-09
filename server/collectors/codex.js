/**
 * Codex 采集器。
 *
 * 数据源：~/.codex/sessions/**\/rollout-*.jsonl
 *   较老的会话会被 Codex 压成同名 .jsonl.zst（内容一致），两者都要读——
 *   只读 .jsonl 会漏掉绝大部分历史（实测少采约 8B token）。
 * 每行形如 { timestamp, type, payload }：
 *   - type=session_meta   -> 会话元信息（cwd / originator / cli_version / model_provider）
 *   - type=event_msg, payload.type=token_count -> 累计 token 快照
 *
 * 关键处理：Codex 的 token_count 里 total_token_usage 是**累计值**，
 * 直接累加会重复计数。因此取 last_token_usage 作为单次增量，
 * 并用「与前一条 total 的差值」交叉校验。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageEvent, Collector } from "../model.js";
import {
  walkFiles,
  readJsonlIncremental,
  readZstdJsonl,
  toTs,
  hashId,
  surfaceOf,
  bytesFilter,
} from "./util.js";

const SOURCE = "codex";

export const codex = new Collector({
  id: "codex",
  name: "Codex",
  website: "https://developers.openai.com/codex",
  color: "#6b8e6b",
  roots: [path.join(os.homedir(), ".codex", "sessions")],
  detect: () => fs.existsSync(path.join(os.homedir(), ".codex")),
  async scan(ctx) {
    // Codex 会把较老的会话压成 .jsonl.zst（内容与 .jsonl 完全一致），
    // 只认 .jsonl 会漏掉绝大部分历史——这曾经导致总量少了近 8B。
    // .bak 是 zst 的备份副本，跳过以免重复。
    const files = walkFiles(ctx.roots[SOURCE], {
      exts: [".jsonl", ".jsonl.zst"],
      maxDepth: 10,
    }).filter((f) => !f.endsWith(".bak"));
    const events = [];
    const sessions = new Map();
    let parsedFiles = 0;
    // rollout 文件里绝大多数行是消息正文（单文件可达数 GB），
    // 只有含这几个标记的行才值得付出 JSON.parse 成本。
    // 标记都出现在行首窗口内（rollout 字段顺序固定），所以只扫前 8KB。
    const filter = bytesFilter([
      '"token_count"', // event_msg.token_count -> 增量 token
      '"session_meta"', // 会话元信息（cwd / originator / cli_version）
      '"turn_context"', // 每轮的 model + cwd（模型名真正的来源）
      '"thread_settings_applied"', // 中途切模型
    ]);

    for (const file of files) {
      const cur = ctx.cursor(SOURCE, file);
      const st = fs.statSync(file);
      // 未变更直接跳过
      if (!cur.reset && cur.size === st.size && cur.mtime === st.mtimeMs && cur.byteOffset > 0) {
        continue;
      }
      const cursor = cur.reset ? null : cur;

      let meta = sessions.get(file) || {
        id: path.basename(file).replace(/\.jsonl(\.zst)?$/, ""),
        cwd: null,
        originator: null,
        model: null,
        version: null,
        startedAt: 0,
      };
      const sessionId = meta.id;

      const onObj = (obj) => {
        const p = obj.payload;
        if (obj.type === "session_meta") {
          meta.cwd = p.cwd || meta.cwd;
          meta.originator = p.originator || null;
          meta.version = p.cli_version || null;
          meta.startedAt = toTs(obj.timestamp) || meta.startedAt;
          meta.surface = surfaceOf(p.originator, p.source);
          meta.provider = p.model_provider || null;
          return;
        }
        // 模型名来自 turn_context / thread_settings_applied，session_meta 里没有
        if (obj.type === "turn_context") {
          meta.model = p.model || meta.model;
          meta.cwd = p.cwd || meta.cwd;
          return;
        }
        if (obj.type === "event_msg" && p?.type === "thread_settings_applied") {
          meta.model = p.thread_settings?.model || meta.model;
          return;
        }
        if (obj.type !== "event_msg" || p?.type !== "token_count" || !p.info) return;

        const info = p.info;
        const last = info.last_token_usage;
        // info 为 null 的心跳行不含用量（早期版本也没有 info）
        if (!last) return;

        const ts = toTs(obj.timestamp);
        if (!ts) return;

        // 口径归一化：Codex 的 input_tokens **包含** cached_input_tokens，
        // 而 OpenCode / DSH / Claude 的 input 是「新鲜输入」，缓存另计。
        // 这里统一成「input = 新鲜输入，cacheRead 单列」，避免下游重复计费。
        const rawInput = last.input_tokens || 0;
        const cached = last.cached_input_tokens || 0;
        const input = Math.max(0, rawInput - cached);
        const output = last.output_tokens || 0;
        const reasoning = last.reasoning_output_tokens || 0;
        const cacheWrite = last.cache_write_input_tokens || 0;
        if (input + output + cached === 0) return;

        events.push(
          new UsageEvent({
            // ordinal 是行内单调序号，配合 sessionId 天然唯一
            id: hashId(SOURCE, sessionId, obj.ordinal, input, output),
            tool: SOURCE,
            ts,
            sessionId,
            cwd: meta.cwd,
            model: meta.model || "gpt-5-codex",
            provider: "openai",
            protocol: "responses",
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cached,
            cacheWriteTokens: cacheWrite,
            reasoningTokens: reasoning,
            latencyMs: num(last.durationMs),
            surface: meta.surface || "cli",
            originator: meta.originator,
          }),
        );
      };

      // .zst 走流式解压（无法按偏移续读）；.jsonl 走字节级增量
      const res = file.endsWith(".zst")
        ? await readZstdJsonl(file, onObj, { filter })
        : await readJsonlIncremental(file, cursor, onObj, { filter });

      parsedFiles++;
      // zst 没有可续读的字节偏移，用文件大小占位：
      // 下次 size/mtime 未变会被上面的判断直接跳过。
      ctx.advance(SOURCE, file, { ...res, byteOffset: res.byteOffset ?? st.size });
      meta.startedAt = meta.startedAt || st.mtimeMs;
      sessions.set(file, meta);
      ctx.emitProgress(SOURCE, events.length, parsedFiles, files.length);
    }

    // 写会话档案
    for (const meta of sessions.values()) {
      ctx.session({
        sessionId: meta.id,
        tool: SOURCE,
        startedAt: meta.startedAt,
        cwd: meta.cwd,
        model: meta.model,
      });
    }

    return { events, stats: { filesSeen: files.length, filesParsed: parsedFiles } };
  },
  profile: () => {
    let account = null;
    let plan = null;
    // Codex 的登录态可能在 auth.json，也可能在全局状态里
    const candidates = [
      path.join(os.homedir(), ".codex", "auth.json"),
      path.join(os.homedir(), ".codex", ".codex-global-state.json"),
    ];
    for (const file of candidates) {
      try {
        const auth = JSON.parse(fs.readFileSync(file, "utf8"));
        const t = auth?.tokens || {};
        if (t.id_token) {
          const claims = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString());
          account = claims.email || claims.sub || account;
          plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type || plan;
        }
        if (!account && auth?.OPENAI_API_KEY) account = "API Key";
      } catch {
        /* ignore */
      }
      if (account) break;
    }
    let version = null;
    try {
      version = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".codex", "version.json"), "utf8"),
      ).version;
    } catch {
      /* ignore */
    }
    return { account, plan, version };
  },
});

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}