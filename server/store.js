/**
 * SQLite 存储层。
 *
 * 设计要点：
 *  - 事件表 usage_events，event_id 主键保证重复扫描幂等
 *  - 文件游标表 file_cursors，支持增量读取（只读新增行）
 *  - 日聚合表 daily_rollups，图表查询直接吃聚合结果，避免全表扫描
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  event_id           TEXT PRIMARY KEY,
  tool               TEXT NOT NULL,
  ts                 INTEGER NOT NULL,
  day                TEXT NOT NULL,
  hour               INTEGER NOT NULL,
  session_id         TEXT,
  cwd                TEXT,
  model              TEXT NOT NULL,
  provider           TEXT,
  protocol           TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  status             INTEGER,
  success            INTEGER NOT NULL DEFAULT 1,
  latency_ms         INTEGER NOT NULL DEFAULT 0,
  ttft_ms            INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  cost_source        TEXT,
  surface            TEXT,
  originator         TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_day     ON usage_events(day);
CREATE INDEX IF NOT EXISTS idx_events_tool    ON usage_events(tool);
CREATE INDEX IF NOT EXISTS idx_events_model   ON usage_events(model);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_events_tool_day ON usage_events(tool, day);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT NOT NULL,
  tool       TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  cwd        TEXT,
  title      TEXT,
  model      TEXT,
  messages   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, tool)
);

CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool, started_at);

-- 增量游标：每个源文件读到哪一行了
CREATE TABLE IF NOT EXISTS file_cursors (
  source         TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  byte_offset    INTEGER NOT NULL DEFAULT 0,
  line_no        INTEGER NOT NULL DEFAULT 0,
  file_size      INTEGER NOT NULL DEFAULT 0,
  file_mtime     INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, file_path)
);

-- 扫描运行记录（UI 展示采集流程动画用）
CREATE TABLE IF NOT EXISTS scan_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT NOT NULL,
  files_seen   INTEGER NOT NULL DEFAULT 0,
  files_parsed INTEGER NOT NULL DEFAULT 0,
  events_new   INTEGER NOT NULL DEFAULT 0,
  events_total INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

-- 按 天 + 工具 + 模型 预聚合，供趋势图 / 排行榜直接查询
CREATE TABLE IF NOT EXISTS daily_rollups (
  day                TEXT NOT NULL,
  tool               TEXT NOT NULL,
  model              TEXT NOT NULL,
  provider           TEXT,
  requests           INTEGER NOT NULL DEFAULT 0,
  failures           INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  latency_ms_sum     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tool, model)
);

CREATE INDEX IF NOT EXISTS idx_rollup_day ON daily_rollups(day);
`;

export function dayOf(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this._stmts = new Map();
  }

  prep(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // ---------- 游标 ----------

  getCursor(source, filePath) {
    return (
      this.prep("SELECT * FROM file_cursors WHERE source = ? AND file_path = ?").get(source, filePath) ||
      null
    );
  }

  setCursor(source, filePath, { byteOffset, lineNo, size, mtime }) {
    this.prep(
      `INSERT INTO file_cursors (source, file_path, byte_offset, line_no, file_size, file_mtime, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, file_path) DO UPDATE SET
         byte_offset   = excluded.byte_offset,
         line_no       = excluded.line_no,
         file_size     = excluded.file_size,
         file_mtime    = excluded.file_mtime,
         last_synced_at = excluded.last_synced_at`,
    ).run(source, filePath, byteOffset, lineNo, size, mtime, Date.now());
  }

  // ---------- 事件写入 ----------

  /** 幂等批量插入，返回新增条数 */
  insertEvents(events) {
    if (!events.length) return 0;
    const stmt = this.prep(
      `INSERT OR IGNORE INTO usage_events (
        event_id, tool, ts, day, hour, session_id, cwd, model, provider, protocol,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        total_tokens, status, success, latency_ms, ttft_ms, cost_usd, cost_source,
        surface, originator
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        const r = stmt.run(
          e.id,
          e.tool,
          e.ts,
          dayOf(e.ts),
          new Date(e.ts).getHours(),
          e.sessionId,
          e.cwd,
          e.model,
          e.provider,
          e.protocol,
          e.inputTokens,
          e.outputTokens,
          e.cacheReadTokens,
          e.cacheWriteTokens,
          e.reasoningTokens,
          // 总 token = 新鲜输入 + 输出 + 缓存读 + 缓存写
          // （缓存读也要计入，否则 Codex 这类高缓存命中的工具总量会被严重低估）
          e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens,
          e.status,
          e.success,
          e.latencyMs,
          e.ttftMs,
          e.costUsd,
          e.costSource || null,
          e.surface,
          e.originator,
        );
        if (r.changes > 0) n++;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return n;
  }

  upsertSession(s) {
    this.prep(
      `INSERT INTO sessions (session_id, tool, started_at, ended_at, cwd, title, model, messages)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         ended_at = MAX(COALESCE(sessions.ended_at, 0), COALESCE(excluded.ended_at, 0)),
         cwd      = COALESCE(excluded.cwd, sessions.cwd),
         title    = COALESCE(excluded.title, sessions.title),
         model    = COALESCE(excluded.model, sessions.model),
         messages = MAX(sessions.messages, excluded.messages)`,
    ).run(
      s.sessionId,
      s.tool,
      s.startedAt,
      s.endedAt ?? null,
      s.cwd ?? null,
      s.title ?? null,
      s.model ?? null,
      s.messages ?? 0,
    );
  }

  // ---------- 扫描运行 ----------

  startScan() {
    const r = this.prep("INSERT INTO scan_runs (started_at, status) VALUES (?, 'running')").run(
      Date.now(),
    );
    return Number(r.lastInsertRowid);
  }

  finishScan(id, { filesSeen, filesParsed, eventsNew, status = "ok", error = null }) {
    const total = this.prep("SELECT COUNT(*) AS c FROM usage_events").get().c;
    this.prep(
      `UPDATE scan_runs SET finished_at=?, status=?, files_seen=?, files_parsed=?,
        events_new=?, events_total=?, error=? WHERE id=?`,
    ).run(Date.now(), status, filesSeen, filesParsed, eventsNew, total, error, id);
  }

  lastScan() {
    return this.prep("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get() || null;
  }

  // ---------- 聚合重建 ----------

  /**
   * 重建日聚合。
   * 注意：主键是 (day, tool, model)，所以 GROUP BY 不能带 provider，
   * 否则同一模型的多 provider 会撞主键导致插入中断。
   */
  rebuildRollups() {
    this.db.exec("DELETE FROM daily_rollups");
    this.db.exec(`
      INSERT INTO daily_rollups (
        day, tool, model, provider, requests, failures,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        total_tokens, cost_usd, latency_ms_sum
      )
      SELECT
        day, tool, model,
        COALESCE(MAX(NULLIF(provider,'')), ''),
        COUNT(*),
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END),
        SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
        SUM(reasoning_tokens), SUM(total_tokens),
        SUM(COALESCE(cost_usd, 0)), SUM(latency_ms)
      FROM usage_events
      GROUP BY day, tool, model
    `);
  }

  // ---------- 查询 ----------

  dataRange() {
    const r = this.prep("SELECT MIN(day) AS min, MAX(day) AS max, COUNT(*) AS n FROM usage_events").get();
    return { from: r?.min || null, to: r?.max || null, events: r?.n || 0 };
  }
}