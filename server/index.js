/**
 * TokenLedger HTTP 服务。
 *
 * 端点：
 *   GET  /api/health              健康检查
 *   GET  /api/tools               检测到的工具清单 + 安装状态
 *   GET  /api/overview            总览指标
 *   GET  /api/timeseries          时间序列（?byTool=true 可按工具拆分）
 *   GET  /api/by-model            模型排行
 *   GET  /api/by-tool             工具对比
 *   GET  /api/matrix              工具 × 模型矩阵
 *   GET  /api/hourly              24 小时分布
 *   GET  /api/rate                Token 速率（吞吐）统计
 *   GET  /api/weekday             星期分布
 *   GET  /api/sessions            最近会话
 *   GET  /api/events              最近事件流
 *   GET  /api/profile             档案（streak / 强度）
 *   GET  /api/profiles/:tool      单工具档案信息
 *   GET  /api/dashboard           一次性拉全部（首屏用，避免瀑布请求）
 *   POST /api/scan                触发扫描
 *   POST /api/reset               清库重扫
 *   GET  /api/scan/stream         SSE 扫描进度流（驱动采集动画）
 *   POST /api/pricing/reload      重新加载价目表
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { Scanner } from "./scanner.js";
import { Queries } from "./queries.js";
import { getCollector } from "./collectors/index.js";
import { PricingTable } from "./pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
// 桌面端把构建产物打平放在同一个目录，用 TOKENLEDGER_UI 指过来
const UI_DIR = process.env.TOKENLEDGER_UI || path.join(ROOT, "dist");
const DATA_DIR = process.env.TOKENLEDGER_DATA || path.join(os.homedir(), ".tokenledger");
const DB_FILE = path.join(DATA_DIR, "tokenledger.db");
const PORT = Number(process.env.PORT) || 8787;
// 只监听回环地址：桌面端与开发时都不该对外暴露
const HOST = process.env.TOKENLEDGER_HOST || "127.0.0.1";

const store = new Store(DB_FILE);
const scanner = new Scanner(store);
const queries = new Queries(store);

// ---------------------------------------------------------------- helpers

function parseRange(url) {
  const q = url.searchParams;
  const tools = (q.get("tools") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    from: q.get("from") || undefined,
    to: q.get("to") || undefined,
    tools: tools.length ? tools : undefined,
    limit: q.get("limit") || undefined,
    model: q.get("model") || undefined,
    byTool: q.get("byTool"),
  };
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** 一次性返回首屏所需的全部数据 */
function dashboardPayload(range) {
  return {
    range: { from: range.from || null, to: range.to || null, tools: range.tools || null },
    dataRange: store.dataRange(),
    tools: scanner.tools(),
    overview: queries.overview(range),
    profile: queries.profile(range),
    timeseries: queries.timeseries(range),
    timeseriesByTool: queries.timeseries({ ...range, byTool: true }),
    modelSeries: queries.modelSeries(range),
    byModel: queries.byModel(range),
    byTool: queries.byTool(range),
    matrix: queries.toolModelMatrix(range),
    hourly: queries.hourly(range),
    weekday: queries.weekday(range),
    rate: queries.rate(range),
    sessions: queries.sessions(range),
    recentEvents: queries.recentEvents({ ...range, limit: 40 }),
    lastScan: store.lastScan(),
    pricingSource: scanner.pricing.source,
  };
}

// ---------------------------------------------------------------- routes

const routes = {
  "GET /api/health": () => ({
    ok: true,
    version: "0.1.0",
    db: DB_FILE,
    dataRange: store.dataRange(),
    scanning: scanner.running,
  }),

  "GET /api/tools": () => scanner.tools(),

  "GET /api/overview": (range) => queries.overview(range),

  "GET /api/timeseries": (range) => queries.timeseries(range),

  "GET /api/by-model": (range) => queries.byModel(range),

  "GET /api/by-tool": (range) => queries.byTool(range),

  "GET /api/matrix": (range) => queries.toolModelMatrix(range),

  "GET /api/hourly": (range) => queries.hourly(range),

  "GET /api/rate": (range) => queries.rate(range),

  "GET /api/weekday": (range) => queries.weekday(range),

  "GET /api/sessions": (range) => queries.sessions(range),

  "GET /api/events": (range) => queries.recentEvents(range),

  "GET /api/profile": (range) => queries.profile(range),

  "GET /api/dashboard": (range) => dashboardPayload(range),

  "POST /api/scan": async () => {
    if (scanner.running) return { started: false, reason: "already running" };
    // 后台跑，客户端用 SSE 看进度
    scanner.run().catch(() => {});
    return { started: true };
  },

  "POST /api/reset": async () => {
    if (scanner.running) return { started: false, reason: "already running" };
    scanner.reset().catch(() => {});
    return { started: true };
  },

  "POST /api/pricing/reload": () => {
    scanner.pricing = PricingTable.load();
    return { ok: true, source: scanner.pricing.source };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  // CORS（开发时 vite 走 proxy，这里放开以支持直连）
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // SSE：扫描进度
  if (url.pathname === "/api/scan/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
    send("progress", scanner.progress());
    const onProgress = (p) => send("progress", p);
    scanner.on("progress", onProgress);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      scanner.off("progress", onProgress);
    });
    return;
  }

  // 单工具档案
  const profMatch = url.pathname.match(/^\/api\/profiles\/([\w-]+)$/);
  if (profMatch && req.method === "GET") {
    const id = profMatch[1];
    const c = getCollector(id);
    if (!c) return json(res, 404, { error: `unknown tool: ${id}` });
    let profile = null;
    try {
      profile = c.profile ? c.profile() : null;
    } catch (err) {
      profile = { error: String(err?.message || err) };
    }
    const usage = queries.byTool({ tools: [id] });
    return json(res, 200, { id, name: c.name, color: c.color, website: c.website, profile, usage });
  }

  const handler = routes[key];
  if (handler) {
    try {
      const range = parseRange(url);
      const out = await handler(range);
      return json(res, 200, out);
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err), stack: err?.stack });
    }
  }

  // 静态资源（生产构建）
  if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
    const dist = UI_DIR;
    let file = path.join(dist, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(dist) || !fs.existsSync(file)) file = path.join(dist, "index.html");
    if (fs.existsSync(file)) {
      const ext = path.extname(file);
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".json": "application/json",
      };
      const buf = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": types[ext] || "application/octet-stream",
        // index.html 不缓存，避免改完构建后浏览器还拿旧的入口
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      });
      return res.end(buf);
    }
  }

  json(res, 404, { error: "not found", path: url.pathname });
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
  // 桌面端在 0 端口启动以自动挑空闲口，再回读实际端口
  if (process.send) {
    process.send({ type: "ready", port: actualPort, ui: UI_DIR });
  }
  console.log(`[tokenledger] API  http://${HOST}:${actualPort}`);
  console.log(`[tokenledger] UI   ${UI_DIR}`);
  console.log(`[tokenledger] DB   ${DB_FILE}`);
  // 首次启动且库为空 -> 自动全量扫描
  const { events } = store.dataRange();
  if (events === 0) {
    console.log("[tokenledger] 首次启动，开始全量扫描…");
    scanner
      .run({ onProgress: (p) => process.stdout.write(`  ${p.stage} ${Math.round(p.percent)}%\r`) })
      .then((r) => console.log(`\n[tokenledger] 初始扫描完成：${r.eventsNew} 条事件`))
      .catch((e) => console.error("[tokenledger] 初始扫描失败", e));
  }
});

/** 优雅退出：桌面端关窗时会发 SIGTERM，必须保证 SQLite 正常落盘 */
function shutdown(signal) {
  console.log(`[tokenledger] 收到 ${signal}，正在退出`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // 兜底：3 秒内没关干净就强退，避免桌面端等不到进程结束
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));