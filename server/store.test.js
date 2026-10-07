/**
 * 存储与查询层测试：幂等写入、增量游标、聚合、筛选、streak 计算。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, dayOf } from "./store.js";
import { Queries } from "./queries.js";
import { UsageEvent } from "./model.js";

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-store-"));
  const store = new Store(path.join(dir, "t.db"));
  return { store, q: new Queries(store), dir };
}

function mk(init) {
  return new UsageEvent({
    tool: "codex",
    model: "gpt-5",
    ts: Date.parse("2026-03-10T12:00:00Z"),
    ...init,
  });
}

test("dayOf 用 UTC 生成 YYYY-MM-DD", () => {
  assert.equal(dayOf(Date.parse("2026-03-10T23:59:59Z")), "2026-03-10");
  assert.equal(dayOf(Date.parse("2026-03-11T00:00:00Z")), "2026-03-11");
});

test("事件写入幂等：重复 id 不重复计数", () => {
  const { store } = freshStore();
  const e = mk({ id: "e1", total_tokens: undefined, inputTokens: 100, outputTokens: 20 });
  assert.equal(store.insertEvents([e]), 1);
  assert.equal(store.insertEvents([e]), 0);
  assert.equal(store.dataRange().events, 1);
  store.close();
});

test("total_tokens 含缓存读与写", () => {
  const { store } = freshStore();
  store.insertEvents([
    mk({ id: "e1", inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 30 }),
  ]);
  const row = store.prep("SELECT total_tokens FROM usage_events").get();
  assert.equal(row.total_tokens, 650);
  store.close();
});

test("游标写入后可读回", () => {
  const { store } = freshStore();
  assert.equal(store.getCursor("s", "/a"), null);
  store.setCursor("s", "/a", { byteOffset: 100, lineNo: 5, size: 200, mtime: 123 });
  const c = store.getCursor("s", "/a");
  assert.equal(c.byte_offset, 100);
  assert.equal(c.line_no, 5);
  assert.ok(c.last_synced_at > 0);
  store.close();
});

test("游标可更新（同一文件二次同步）", () => {
  const { store } = freshStore();
  store.setCursor("s", "/a", { byteOffset: 100, lineNo: 5, size: 200, mtime: 1 });
  store.setCursor("s", "/a", { byteOffset: 250, lineNo: 9, size: 300, mtime: 2 });
  const c = store.getCursor("s", "/a");
  assert.equal(c.byte_offset, 250);
  assert.equal(c.line_no, 9);
  store.close();
});

test("upsertSession 合并而不覆盖已有字段", () => {
  const { store } = freshStore();
  store.upsertSession({ sessionId: "s1", tool: "codex", startedAt: 100, cwd: "/a", model: "m1", messages: 3 });
  store.upsertSession({ sessionId: "s1", tool: "codex", startedAt: 100, messages: 8 });
  const r = store.prep("SELECT * FROM sessions").get();
  assert.equal(r.cwd, "/a");
  assert.equal(r.model, "m1");
  assert.equal(r.messages, 8);
  store.close();
});

test("rebuildRollups 聚合到 天/工具/模型", () => {
  const { store, dir } = freshStore();
  store.insertEvents([
    mk({ id: "1", inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, costUsd: 0.1, latencyMs: 100 }),
    mk({ id: "2", inputTokens: 20, outputTokens: 2, cacheReadTokens: 5, costUsd: 0.2, latencyMs: 200 }),
    mk({ id: "3", model: "gpt-4", inputTokens: 30, outputTokens: 3, costUsd: 0.3 }),
  ]);
  store.rebuildRollups();
  const rows = store.prep("SELECT * FROM daily_rollups ORDER BY model").all();
  assert.equal(rows.length, 2);
  const gpt5 = rows.find((r) => r.model === "gpt-5");
  assert.equal(gpt5.requests, 2);
  assert.equal(gpt5.input_tokens, 30);
  assert.equal(gpt5.latency_ms_sum, 300);
  assert.ok(Math.abs(gpt5.cost_usd - 0.3) < 1e-6);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rebuildRollups 同日同模型多 provider 不撞主键", () => {
  const { store, dir } = freshStore();
  store.insertEvents([
    mk({ id: "1", provider: "openai", inputTokens: 1 }),
    mk({ id: "2", provider: "azure", inputTokens: 2 }),
  ]);
  store.rebuildRollups();
  const rows = store.prep("SELECT * FROM daily_rollups").all();
  assert.equal(rows.length, 1, "同一 (day,tool,model) 应合并成一行");
  assert.equal(rows[0].input_tokens, 3);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rebuildRollups 可重复执行（先清空）", () => {
  const { store, dir } = freshStore();
  store.insertEvents([mk({ id: "1", inputTokens: 5 })]);
  store.rebuildRollups();
  store.rebuildRollups();
  assert.equal(store.prep("SELECT COUNT(*) c FROM daily_rollups").get().c, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- Queries

function seeded() {
  const { store, dir } = freshStore();
  const q = new Queries(store);
  const day = (d) => Date.parse(`${d}T12:00:00Z`);
  store.insertEvents([
    mk({ id: "a1", ts: day("2026-03-01"), inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, costUsd: 1 }),
    mk({ id: "a2", ts: day("2026-03-02"), inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, costUsd: 2 }),
    mk({ id: "b1", tool: "claude-code", model: "claude-sonnet-4", ts: day("2026-03-02"), inputTokens: 300, outputTokens: 30, costUsd: 3 }),
  ]);
  store.rebuildRollups();
  return { store, q, dir };
}

test("overview 汇总总量", () => {
  const { store, q, dir } = seeded();
  const o = q.overview({});
  assert.equal(o.requests, 3);
  assert.equal(o.input_tokens, 600);
  assert.equal(o.output_tokens, 60);
  assert.equal(o.tools, 2);
  assert.ok(Math.abs(o.cost_usd - 6) < 1e-6);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("overview 支持时间范围过滤", () => {
  const { store, q, dir } = seeded();
  const o = q.overview({ from: "2026-03-02", to: "2026-03-02" });
  assert.equal(o.requests, 2);
  assert.equal(o.input_tokens, 500);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("overview 支持工具过滤", () => {
  const { store, q, dir } = seeded();
  const o = q.overview({ tools: ["claude-code"] });
  assert.equal(o.requests, 1);
  assert.equal(o.tools, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("timeseries 按天升序", () => {
  const { store, q, dir } = seeded();
  const ts = q.timeseries({});
  assert.deepEqual(ts.map((r) => r.day), ["2026-03-01", "2026-03-02"]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("timeseries byTool 透视成 day -> tool", () => {
  const { store, q, dir } = seeded();
  const ts = q.timeseries({ byTool: true });
  assert.equal(ts.length, 2);
  assert.ok(ts[0].byTool.codex);
  assert.ok(ts[1].byTool["claude-code"]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("byModel 按 token 降序并带 tool_count", () => {
  const { store, q, dir } = seeded();
  const rows = q.byModel({});
  // gpt-5 合计 160+320=480 > claude-sonnet-4 的 330
  assert.equal(rows[0].model, "gpt-5");
  assert.equal(rows[0].total_tokens, 480);
  assert.equal(rows[0].tool_count, 1);
  assert.equal(rows[1].model, "claude-sonnet-4");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("byModel 尊重 limit", () => {
  const { store, q, dir } = seeded();
  assert.equal(q.byModel({ limit: 1 }).length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("byTool 对比各工具", () => {
  const { store, q, dir } = seeded();
  const rows = q.byTool({});
  assert.equal(rows.length, 2);
  // codex 160+320=480 > claude-code 330
  assert.equal(rows[0].tool, "codex");
  assert.equal(rows[0].total_tokens, 480);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("modelSeries 返回 天->指标 映射", () => {
  const { store, q, dir } = seeded();
  const ms = q.modelSeries({});
  const gpt5 = ms.find((m) => m.model === "gpt-5");
  // a1: input100+output10+cache50=160 ; a2: 200+20+100=320
  assert.equal(gpt5.days["2026-03-01"].total_tokens, 160);
  assert.equal(gpt5.days["2026-03-02"].total_tokens, 320);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hourly 按本地小时聚合", () => {
  const { store, q, dir } = seeded();
  const h = q.hourly({});
  assert.ok(h.length > 0);
  // 事件写入的是 12:00Z，落到哪个本地小时取决于机器时区
  const localHour = new Date(Date.parse("2026-03-01T12:00:00Z")).getHours();
  const row = h.find((r) => r.hour === localHour);
  assert.equal(row.requests, 3);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hourly 时间范围过滤生效", () => {
  const { store, q, dir } = seeded();
  const h = q.hourly({ from: "2026-03-02", to: "2026-03-02" });
  const total = h.reduce((a, r) => a + r.requests, 0);
  assert.equal(total, 2);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sessions 附带该会话的用量", () => {
  const { store, q, dir } = freshStore();
  store.insertEvents([
    mk({ id: "s1", sessionId: "sess-a", inputTokens: 10, outputTokens: 1, costUsd: 0.5 }),
    mk({ id: "s2", sessionId: "sess-b", inputTokens: 20, outputTokens: 2, costUsd: 0.6 }),
  ]);
  store.upsertSession({ sessionId: "sess-a", tool: "codex", startedAt: Date.parse("2026-03-01T10:00:00Z"), cwd: "/x" });
  store.upsertSession({ sessionId: "sess-b", tool: "codex", startedAt: Date.parse("2026-03-02T10:00:00Z") });
  const rows = q.sessions({});
  assert.equal(rows.length, 2);
  const a = rows.find((r) => r.session_id === "sess-a");
  assert.equal(a.requests, 1);
  assert.ok(Math.abs(a.cost_usd - 0.5) < 1e-6);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recentEvents 按时间倒序并可按模型过滤", () => {
  const { store, q, dir } = seeded();
  const evs = q.recentEvents({ limit: 2 });
  assert.equal(evs.length, 2);
  assert.ok(evs[0].ts >= evs[1].ts);
  const only = q.recentEvents({ model: "claude-sonnet-4" });
  assert.equal(only.length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("profile 计算活跃天数与总量", () => {
  const { store, q, dir } = seeded();
  const p = q.profile({});
  assert.equal(p.totalActiveDays, 2);
  assert.equal(p.totalRequests, 3);
  // 3-01: 160, 3-02: 320 + 330 = 650 -> 810 / 2 天
  assert.equal(p.totalTokens, 810);
  assert.equal(p.avgTokensPerDay, 405);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("profile 的 currentStreak 需要今天有数据", () => {
  const { store, q, dir } = freshStore();
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  store.insertEvents([mk({ id: "t1", ts: Date.now(), inputTokens: 10 })]);
  store.rebuildRollups();
  const p = q.profile({});
  assert.equal(p.currentStreak, 1);
  assert.ok(p.activeDays.some((d) => d.day === iso));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("profile 的 currentStreak 昨天起算（今天还没用）", () => {
  const { store, q, dir } = freshStore();
  const y = new Date(Date.now() - 86_400_000);
  store.insertEvents([mk({ id: "y1", ts: y.getTime(), inputTokens: 10 })]);
  store.rebuildRollups();
  assert.equal(q.profile({}).currentStreak, 1, "宽限一天");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("profile 的 longestStreak 计算最长连续", () => {
  const { store, q, dir } = freshStore();
  // 2026-03-01..03 连续，03-05 孤立
  for (const d of ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-05"]) {
    store.insertEvents([mk({ id: `s-${d}`, ts: Date.parse(`${d}T12:00:00Z`), inputTokens: 1 })]);
  }
  store.rebuildRollups();
  assert.equal(q.profile({}).longestStreak, 3);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("dataRange 空库返回 null", () => {
  const { store, dir } = freshStore();
  assert.deepEqual(store.dataRange(), { from: null, to: null, events: 0 });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- 速率统计

test("rate 空库返回 null overall", () => {
  const { store, q, dir } = freshStore();
  const r = q.rate({});
  assert.equal(r.overall, null);
  assert.deepEqual(r.byDay, []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rate 按分钟分桶算平均值", () => {
  const { store, q, dir } = freshStore();
  const at = (iso, tokens) => new UsageEvent({
    id: iso + tokens,
    tool: "codex",
    model: "gpt-5",
    ts: Date.parse(iso),
    inputTokens: tokens,
  });
  // 同一分钟两条：100 + 300 = 400
  store.insertEvents([at("2026-03-01T10:00:10Z", 100), at("2026-03-01T10:00:50Z", 300)]);
  // 另一分钟一条：200
  store.insertEvents([at("2026-03-01T10:01:10Z", 200)]);
  const r = q.rate({});
  assert.equal(r.overall.activeMinutes, 2);
  assert.equal(r.overall.totalTokens, 600);
  // (400 + 200) / 2 分钟
  assert.equal(r.overall.avgPerMinute, 300);
  assert.equal(r.overall.peakPerMinute, 400);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rate 的 byDay / byHour 正确聚合", () => {
  const { store, q, dir } = freshStore();
  const at = (iso, tokens, tool = "codex") =>
    new UsageEvent({ id: iso + tokens + tool, tool, model: "m", ts: Date.parse(iso), inputTokens: tokens });
  store.insertEvents([at("2026-03-01T10:00:10Z", 100), at("2026-03-01T10:01:10Z", 100)]);
  store.insertEvents([at("2026-03-02T10:00:10Z", 500, "dsh")]);
  const r = q.rate({});
  assert.equal(r.byDay.length, 2);
  const d1 = r.byDay.find((d) => d.day === "2026-03-01");
  assert.equal(d1.tokens, 200);
  assert.equal(d1.activeMinutes, 2);
  assert.equal(d1.perMinute, 100);
  const d2 = r.byDay.find((d) => d.day === "2026-03-02");
  assert.equal(d2.perMinute, 500);
  // 24 小时都要有值（缺省补 0）
  assert.equal(r.byHour.length, 24);
  // 三条事件都落在同一本地小时（相差 1 分钟，跨不了小时边界）
  const hour = new Date(Date.parse("2026-03-01T10:00:10Z")).getHours();
  const h = r.byHour[hour];
  assert.equal(h.tokens, 700);
  assert.equal(h.activeMinutes, 3);
  assert.equal(h.perMinute, Math.round(700 / 3));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rate 的 byTool 按工具分列并按速率降序", () => {
  const { store, q, dir } = freshStore();
  const at = (iso, tokens, tool) =>
    new UsageEvent({ id: iso + tokens + tool, tool, model: "m", ts: Date.parse(iso), inputTokens: tokens });
  store.insertEvents([at("2026-03-01T10:00:10Z", 100, "codex")]);
  store.insertEvents([at("2026-03-01T10:00:20Z", 900, "dsh")]);
  const r = q.rate({});
  assert.equal(r.byTool.length, 2);
  assert.equal(r.byTool[0].tool, "dsh", "速率高的排前面");
  assert.equal(r.byTool[0].perMinute, 900);
  assert.equal(r.byTool[1].perMinute, 100);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rate 的 recent 覆盖到最后一分钟且长度正确", () => {
  const { store, q, dir } = freshStore();
  const ts = Date.parse("2026-03-01T10:00:10Z");
  store.insertEvents([new UsageEvent({ id: "r1", tool: "codex", model: "m", ts, inputTokens: 100 })]);
  const r = q.rate({ recentMinutes: 30 });
  assert.equal(r.recent.length, 30);
  assert.equal(r.recent[r.recent.length - 1].tokens, 100, "最后一分钟是最新活跃分钟");
  assert.equal(r.recent.filter((x) => x.tokens > 0).length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rate 的 peakBreakdown 指出峰值分钟的来源工具", () => {
  const { store, q, dir } = freshStore();
  const t = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([
    new UsageEvent({ id: "p1", tool: "codex", model: "m", ts: t + 5000, inputTokens: 900 }),
    new UsageEvent({ id: "p2", tool: "dsh", model: "m", ts: t + 15000, inputTokens: 100 }),
  ]);
  const r = q.rate({});
  assert.equal(r.overall.peakPerMinute, 1000);
  assert.equal(r.overall.peakBreakdown.length, 2);
  assert.equal(r.overall.peakBreakdown[0].tool, "codex");
  assert.equal(r.overall.peakBreakdown[0].tokens, 900);
  assert.ok(r.overall.peakAt > 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rate 中位数与 P95 对长尾稳健", () => {
  const { store, q, dir } = freshStore();
  // 10 个普通分钟 + 1 个巨大峰值
  const base = Date.parse("2026-03-01T10:00:00Z");
  for (let i = 0; i < 10; i++) {
    store.insertEvents([
      new UsageEvent({ id: `n${i}`, tool: "codex", model: "m", ts: base + i * 60_000, inputTokens: 100 }),
    ]);
  }
  store.insertEvents([
    new UsageEvent({ id: "spike", tool: "codex", model: "m", ts: base + 20 * 60_000, inputTokens: 100_000 }),
  ]);
  const r = q.rate({});
  assert.equal(r.overall.peakPerMinute, 100_000);
  assert.equal(r.overall.medianPerMinute, 100, "中位数不被峰值带偏");
  assert.ok(r.overall.avgPerMinute > r.overall.medianPerMinute, "均值会被拉高");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rate 支持时间范围与工具过滤", () => {
  const { store, q, dir } = freshStore();
  store.insertEvents([
    new UsageEvent({ id: "a", tool: "codex", model: "m", ts: Date.parse("2026-03-01T10:00:10Z"), inputTokens: 100 }),
    new UsageEvent({ id: "b", tool: "dsh", model: "m", ts: Date.parse("2026-04-01T10:00:10Z"), inputTokens: 999 }),
  ]);
  const onlyCodex = q.rate({ tools: ["codex"] });
  assert.equal(onlyCodex.overall.totalTokens, 100);
  const march = q.rate({ from: "2026-03-01", to: "2026-03-31" });
  assert.equal(march.overall.totalTokens, 100);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scan_runs 记录完成状态与库内总量", () => {
  const { store, dir } = freshStore();
  store.insertEvents([mk({ id: "x1" }), mk({ id: "x2" })]);
  const id = store.startScan();
  store.finishScan(id, { filesSeen: 5, filesParsed: 5, eventsNew: 2 });
  const r = store.lastScan();
  assert.equal(r.status, "ok");
  assert.equal(r.events_new, 2);
  assert.equal(r.events_total, 2);
  assert.ok(r.finished_at > 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});