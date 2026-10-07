/**
 * Claude Code 采集器。
 *
 * 数据源：~/.claude/projects/**\/*.jsonl（会话转录）
 * 形如：{ type:"assistant", requestId, uuid, timestamp, message:{ model, usage:{...} } }
 *
 * 注意：同一 requestId 会因重试/流式续写出现多条，
 * 用 requestId+uuid 去重，event_id 天然幂等。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageEvent, Collector } from "../model.js";
import { walkFiles, readJsonlIncremental, toTs, hashId, bytesFilter } from "./util.js";

const SOURCE = "claude-code";

export const claudeCode = new Collector({
  id: SOURCE,
  name: "Claude Code",
  website: "https://docs.anthropic.com/en/docs/claude-code",
  color: "#c15f3c",
  roots: [path.join(os.homedir(), ".claude", "projects")],
  detect: () => fs.existsSync(path.join(os.homedir(), ".claude")),
  async scan(ctx) {
    const files = walkFiles(ctx.roots[SOURCE], { exts: [".jsonl"], maxDepth: 6 });
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
      const cursor = cur.reset ? null : cur;

      // 项目目录 = 文件所在的一级子目录名（claude 会把路径编码进目录名）
      const projDir = path.basename(path.dirname(file));
      const cwd = decodeCwd(projDir);
      const sessionId = path.basename(file, ".jsonl");
      let model = null;
      let startedAt = 0;
      let title = null;
      let messages = 0;

      const res = await readJsonlIncremental(
        file,
        cursor,
        (obj) => {
          if (obj.type === "assistant") {
            messages++;
            if (!startedAt) startedAt = toTs(obj.timestamp);
            const m = obj.message || {};
            const usage = m.usage;
            if (!usage) return;
            const input = usage.input_tokens || 0;
            const output = usage.output_tokens || 0;
            const cacheRead = usage.cache_read_input_tokens || 0;
            const cacheWrite = usage.cache_creation_input_tokens || 0;
            if (input + output + cacheRead + cacheWrite === 0) return;

            if (m.model) model = m.model;
            const ts = toTs(obj.timestamp);
            if (!ts) return;

            events.push(
              new UsageEvent({
                // 同一 requestId 会有多条 assistant（流式续写 / 重试），uuid 区分具体那次
                id: hashId(SOURCE, obj.requestId || sessionId, obj.uuid || ts),
                tool: SOURCE,
                ts,
                sessionId,
                cwd,
                model: m.model || "claude-sonnet-4",
                provider: "anthropic",
                protocol: "messages",
                inputTokens: input,
                outputTokens: output,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                surface: "cli",
              }),
            );
            return;
          }
          // user / summary 行也要过 parse 才能统计消息数与标题，
          // 但它们通常很短（type 字段在行首），代价可接受
          if (obj.type === "summary" && obj.summary) title = obj.summary;
        },
        { filter: bytesFilter(['"type":"assistant"', '"type":"summary"']) },
      );

      parsedFiles++;
      ctx.advance(SOURCE, file, res);
      sessions.set(sessionId, { sessionId, cwd, model, startedAt: startedAt || st.mtimeMs, title, messages });
      ctx.emitProgress(SOURCE, events.length, parsedFiles, files.length);
    }

    for (const s of sessions.values()) ctx.session({ tool: SOURCE, ...s });
    return { events, stats: { filesSeen: files.length, filesParsed: parsedFiles } };
  },
  profile: () => {
    let account = null;
    let plan = null;
    let version = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
      account = cfg.oauthAccount?.emailAddress || cfg.userID || null;
      plan = cfg.oauthAccount?.subscriptionType || null;
    } catch {
      /* ignore */
    }
    try {
      version = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".claude", "config.json"), "utf8"),
      ).version;
    } catch {
      /* ignore */
    }
    return { account, plan, version };
  },
});

/**
 * Claude 把 /Users/foo/bar 编码成 -Users-foo-bar。
 * 这是有损的（目录名里的连字符无法还原），所以：
 *  - 常见前缀（/Users/<name>/...）按已知 home 反推，得到准确路径
 *  - 无法反推时退回简单替换，至少保证非空
 */
function decodeCwd(dirName) {
  if (!dirName || !dirName.startsWith("-")) return null;
  const rest = dirName.replace(/^-/, "");
  // 用本机 home 反推：目录名以 "-Users-<username>" 开头
  const home = os.homedir();
  const homeEnc = "-" + home.replace(/^\//, "").replace(/\//g, "-");
  if (rest === homeEnc || rest.startsWith(homeEnc + "-")) {
    const tail = rest.slice(homeEnc.length);
    return tail ? home + "/" + tail.replace(/-/g, "/") : home;
  }
  return "/" + rest.replace(/-/g, "/").replace(/^\/+/, "");
}