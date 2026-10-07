/**
 * 采集器通用工具：文件遍历 + 增量 JSONL 读取。
 *
 * 增量读取策略：
 *  - 记录已消费的字节偏移与行号
 *  - 文件未增长且 mtime 未变 -> 跳过
 *  - 文件被截断（size < offset）-> 从头重读（事件表幂等，不会重复计数）
 *  - 只在完整行边界停下，避免读到半行
 */

import fs from "node:fs";
import path from "node:path";

/** 递归列出目录下匹配后缀的文件（带深度上限，避开巨型目录） */
export function walkFiles(root, { exts = null, maxDepth = 8, maxFiles = 20000 } = {}) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;

  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (ent.name === ".DS_Store" || ent.name === "node_modules") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        if (!exts || exts.some((e) => ent.name.endsWith(e))) out.push(full);
      }
    }
  };

  walk(root, 0);
  return out.sort();
}

const NL = 0x0a; // \n

/**
 * 生成字节级 filter：只有行首窗口内含任一标记的行才交给 JSON.parse。
 *
 * @param {string[]} markers  子串标记
 * @param {number}   head     扫描窗口大小（默认 8KB）
 */
export function bytesFilter(markers, head = 8192) {
  const bufs = markers.map((m) => Buffer.from(m));
  return (bytes, start, end) => {
    const win = bytes.subarray(start, Math.min(end, start + head));
    for (const b of bufs) if (win.includes(b)) return true;
    return false;
  };
}

/**
 * 增量读取 JSONL 文件（字节级，UTF-8 安全）。
 *
 * 性能要点：codex 的 rollout 文件动辄数百 MB 到数 GB，且绝大多数行是
 * 消息正文。逐行 JSON.parse 会成为瓶颈，所以提供 filter 钩子——
 * 在字节层面用 indexOf 粗筛，只有可能相关的行才付出 parse 成本。
 *
 * @param {string} file      文件路径
 * @param {object} cursor    { byteOffset, lineNo }
 * @param {function} onLine  (obj, lineNo) => void
 * @param {object} opts      { filter?: fn, yieldBytes?: number }
 * @returns {Promise<{byteOffset, lineNo, size, mtime, parsed, reset}>}
 *
 * 之所以是 async：解析大文件是同步阻塞的（fs.readSync + JSON.parse），
 * 不主动让出事件循环，HTTP/SSE 的写缓冲会一直攒到扫描结束才发出，
 * 前端就看不到「实时」进度了。所以每读满 yieldBytes 就 setImmediate 一次。
 */
export async function readJsonlIncremental(file, cursor, onLine, opts = {}) {
  const YIELD_BYTES = opts.yieldBytes ?? 8 << 20; // 每 8MB 让出一次
  const st = fs.statSync(file);
  let offset = cursor?.byteOffset || 0;
  let lineNo = cursor?.lineNo || 0;
  let reset = false;

  // 文件被截断或替换 -> 从头读
  if (st.size < offset) {
    offset = 0;
    lineNo = 0;
    reset = true;
  }
  if (st.size === offset && !reset) {
    return { byteOffset: offset, lineNo, size: st.size, mtime: st.mtimeMs, parsed: 0, reset };
  }

  const fd = fs.openSync(file, "r");
  const CHUNK = 1 << 20; // 每轮读 1MB
  let buf = Buffer.allocUnsafe(CHUNK * 2);
  let bufLen = 0; // buf[0..bufLen) 是未消费的残留数据
  let pos = offset; // 文件内绝对读取位置
  let parsed = 0;
  let eof = false;
  let sinceYield = 0;

  // 让出事件循环，让 HTTP/SSE 的写缓冲及时刷出去
  const breathe = () => new Promise((resolve) => setImmediate(resolve));

  try {
    const handle = (start, end) => {
      const slice = buf.subarray(start, end);
      // 空白行跳过
      for (let i = 0; i < slice.length; i++) {
        const c = slice[i];
        if (c !== 0x20 && c !== 0x09 && c !== 0x0d) {
          if (!opts.filter || opts.filter(buf, start, end)) {
            try {
              onLine(JSON.parse(slice.toString("utf8")), lineNo);
              parsed++;
            } catch {
              /* 坏行忽略 */
            }
          }
          return;
        }
      }
    };

    while (!eof) {
      // 缓冲不够就扩（应对超长单行）
      if (bufLen + CHUNK > buf.length) {
        const bigger = Buffer.allocUnsafe(Math.max(buf.length * 2, bufLen + CHUNK));
        buf.copy(bigger, 0, 0, bufLen);
        buf = bigger;
      }
      const read = fs.readSync(fd, buf, bufLen, CHUNK, pos);
      if (read === 0) {
        eof = true;
      } else {
        pos += read;
        bufLen += read;
      }

      // 消费所有完整行（不留最后一段，它可能是半行）
      let idx = buf.indexOf(NL, 0);
      while (idx !== -1 && idx < bufLen) {
        if (idx > 0) {
          lineNo++;
          handle(0, idx);
        }
        // 剩余部分前移
        const rest = bufLen - (idx + 1);
        buf.copy(buf, 0, idx + 1, bufLen);
        bufLen = rest;
        idx = buf.indexOf(NL, 0);
      }

      if (eof && bufLen > 0) {
        // 文件末尾无换行的最后一行
        lineNo++;
        handle(0, bufLen);
        bufLen = 0;
      }

      sinceYield += read;
      if (sinceYield >= YIELD_BYTES) {
        sinceYield = 0;
        await breathe();
      }
    }
    offset = pos;
  } finally {
    fs.closeSync(fd);
  }

  return { byteOffset: offset, lineNo, size: st.size, mtime: st.mtimeMs, parsed, reset };
}

/** 解析时间戳 -> epoch ms。支持 ISO 字符串 / 数字（秒或毫秒） */
export function toTs(v) {
  if (v == null) return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    // 小于 1e12 认为是秒
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** 取一个稳定的哈希，用于生成幂等 event id */
export function hashId(...parts) {
  const s = parts.filter((p) => p != null).join("|");
  // FNV-1a 32bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 识别 surface（客户端形态） */
export function surfaceOf(originator, source) {
  const s = `${originator || ""} ${source || ""}`.toLowerCase();
  if (s.includes("desktop") || s.includes("app") || s.includes("cockpit")) return "desktop";
  if (s.includes("vscode") || s.includes("ide") || s.includes("jetbrains")) return "ide";
  if (s.includes("exec")) return "exec";
  if (s.includes("cli") || s.includes("terminal")) return "cli";
  if (s.includes("web") || s.includes("chatgpt")) return "web";
  return null;
}

/** 人类可读的文件大小 */
export function fileSize(n) {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}