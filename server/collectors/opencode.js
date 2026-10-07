/**
 * OpenCode 采集器。
 *
 * 数据源：~/.local/share/opencode/opencode.db （SQLite）
 * 表 session_message：data JSON 里 assistant 消息带
 *   tokens: { input, output, reasoning, cache: { read, write } }
 *   cost, model: { id, providerID }, time.created
 *
 * 该库是本机当前正在使用的 OpenCode 存储格式；
 * 老版本是 storage/message/<id>/... 的 JSON 文件，故保留 JSONL 分支兼容。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageEvent, Collector } from "../model.js";
import { walkFiles, readJsonlIncremental, toTs, hashId } from "./util.js";

const SOURCE = "opencode";
const DATA_DIR = path.join(os.homedir(), ".local", "share", "opencode");

export const opencode = new Collector({
  id: SOURCE,
  name: "OpenCode",
  website: "https://opencode.ai",
  color: "#5b7a99",
  roots: [DATA_DIR],
  detect: () => fs.existsSync(DATA_DIR),
  async scan(ctx) {
    const events = [];
    const stats = { filesSeen: 0, filesParsed: 0 };

    const dbFile = path.join(DATA_DIR, "opencode.db");
    if (fs.existsSync(dbFile)) {
      const from = scanSqlite(ctx, dbFile, events);
      stats.filesSeen += from.seen;
      stats.filesParsed += from.parsed;
    }

    // 兼容旧版 JSON storage
    const legacy = walkFiles(path.join(DATA_DIR, "storage", "message"), { exts: [".json"], maxDepth: 6 });
    stats.filesSeen += legacy.length;
    for (const file of legacy) {
      const cur = ctx.cursor(SOURCE, file);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!cur.reset && cur.size === st.size && cur.mtime === st.mtimeMs && cur.byteOffset > 0) continue;
      const res = await readJsonlIncremental(file, cur.reset ? null : cur, (obj) => {
        const ev = fromLegacyMessage(obj, file);
        if (ev) events.push(ev);
      });
      stats.filesParsed++;
      ctx.advance(SOURCE, file, res);
    }

    for (const ev of events) ctx.emitProgress(SOURCE, events.length, stats.filesParsed, stats.filesSeen);
    return { events, stats };
  },
  profile: () => {
    let account = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "opencode", "opencode.json"), "utf8"));
      account = cfg.username || cfg.user?.name || null;
    } catch {
      /* ignore */
    }
    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "version.json"), "utf8")).version;
    } catch {
      /* ignore */
    }
    return { account, plan: null, version };
  },
});

/** 从 session_message 表读取 assistant 消息 */
function scanSqlite(ctx, file, events) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return { seen: 0, parsed: 0 };
  }
  let seen = 0;
  let parsed = 0;
  try {
    const rows = db
      .prepare("SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant'")
      .all();
    seen = rows.length;

    const cwdBySession = new Map();
    try {
      for (const s of db.prepare("SELECT id, directory, worktree FROM session_v2").all()) {
        cwdBySession.set(s.id, s.directory || s.worktree || null);
      }
    } catch {
      /* session_v2 结构可能随版本变化 */
    }

    for (const row of rows) {
      let d;
      try {
        d = JSON.parse(row.data);
      } catch {
        continue;
      }
      const t = d.tokens || {};
      const cache = t.cache || {};
      const input = t.input || 0;
      const output = t.output || 0;
      if (!input && !output) continue;

      const ts = d.time?.created || row.time_created;
      const modelId = d.model?.id || "unknown";
      const providerId = d.model?.providerID || null;

      events.push(
        new UsageEvent({
          id: hashId(SOURCE, row.id),
          tool: SOURCE,
          ts,
          sessionId: row.session_id,
          cwd: cwdBySession.get(row.session_id) || null,
          model: providerId ? `${providerId}/${modelId}` : modelId,
          provider: providerId,
          protocol: "openai-chat",
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cache.read || 0,
          cacheWriteTokens: cache.write || 0,
          reasoningTokens: t.reasoning || 0,
          costUsd: typeof d.cost === "number" && d.cost > 0 ? d.cost : null,
          surface: "cli",
        }),
      );
      parsed++;
    }
  } catch {
    /* 忽略锁库/结构异常 */
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  return { seen, parsed };
}

/** 旧版 storage/message/<id>.json 兼容 */
function fromLegacyMessage(obj, file) {
  if (!obj || typeof obj !== "object") return null;
  const t = obj.tokens || {};
  const cache = t.cache || {};
  const input = t.input || 0;
  const output = t.output || 0;
  if (!input && !output) return null;
  const ts = toTs(obj.time?.created) || toTs(obj.timeCreated);
  if (!ts) return null;
  const modelId = obj.modelID || obj.model?.id || "unknown";
  const providerId = obj.providerID || obj.model?.providerID || null;
  return new UsageEvent({
    id: hashId(SOURCE, path.basename(file)),
    tool: SOURCE,
    ts,
    sessionId: obj.sessionID || obj.sessionId || null,
    cwd: obj.directory || null,
    model: providerId ? `${providerId}/${modelId}` : modelId,
    provider: providerId,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cache.read || 0,
    cacheWriteTokens: cache.write || 0,
    reasoningTokens: t.reasoning || 0,
    costUsd: typeof obj.cost === "number" && obj.cost > 0 ? obj.cost : null,
    surface: "cli",
  });
}