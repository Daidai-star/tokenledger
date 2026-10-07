/**
 * Gemini CLI 采集器。
 *
 * 数据源：~/.gemini/tmp/<hash>/logs.json 与 chats/*.json
 * 新版 Gemini CLI 把请求记在 ~/.gemini/tmp/<projectHash>/logs.json：
 *   [{ sessionId, messageId, message, timestamp, ... }]
 * 其中 message 可能带 usageTokens {input, output, total, cached}。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageEvent, Collector } from "../model.js";
import { walkFiles, readJsonlIncremental, toTs, hashId } from "./util.js";

const SOURCE = "gemini";

export const gemini = new Collector({
  id: SOURCE,
  name: "Gemini CLI",
  website: "https://github.com/google-gemini/gemini-cli",
  color: "#8b6f8e",
  roots: [path.join(os.homedir(), ".gemini", "tmp")],
  detect: () => fs.existsSync(path.join(os.homedir(), ".gemini")),
  async scan(ctx) {
    const files = walkFiles(ctx.roots[SOURCE], { exts: [".json"], maxDepth: 4 });
    const events = [];
    const sessions = new Map();
    let parsedFiles = 0;

    for (const file of files) {
      const cur = ctx.cursor(SOURCE, file);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!cur.reset && cur.size === st.size && cur.mtime === st.mtimeMs && cur.byteOffset > 0) continue;

      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }

      let rows = [];
      try {
        const parsed = JSON.parse(raw);
        rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.logs) ? parsed.logs : [];
      } catch {
        // 退化为 JSONL 逐行解析
        const res = await readJsonlIncremental(file, cur.reset ? null : cur, (obj) => rows.push(obj));
        ctx.advance(SOURCE, file, res);
      }

      for (const row of rows) {
        const msg = row.message || row;
        const usage = msg.usageTokens || msg.usage || row.usage;
        if (!usage) continue;
        const input = usage.input || usage.promptTokenCount || 0;
        const output = usage.output || usage.candidatesTokenCount || 0;
        const cached = usage.cached || usage.cachedContentTokenCount || 0;
        if (!input && !output) continue;

        const ts = toTs(row.timestamp) || toTs(msg.timestamp);
        if (!ts) continue;
        const model = msg.model || row.model || "gemini-2.5-pro";
        const sessionId = row.sessionId || path.basename(path.dirname(file));

        events.push(
          new UsageEvent({
            id: hashId(SOURCE, row.messageId || row.requestId || `${sessionId}:${ts}`),
            tool: SOURCE,
            ts,
            sessionId,
            model,
            provider: "google",
            protocol: "generate-content",
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cached,
            surface: "cli",
          }),
        );
        const s = sessions.get(sessionId) || { sessionId, startedAt: ts, model, messages: 0 };
        s.messages++;
        sessions.set(sessionId, s);
      }

      parsedFiles++;
      ctx.advance(SOURCE, file, {
        byteOffset: st.size,
        lineNo: 0,
        size: st.size,
        mtime: st.mtimeMs,
      });
      ctx.emitProgress(SOURCE, events.length, parsedFiles, files.length);
    }

    for (const s of sessions.values()) ctx.session({ tool: SOURCE, ...s });
    return { events, stats: { filesSeen: files.length, filesParsed: parsedFiles } };
  },
});