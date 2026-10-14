/**
 * Token 速率的秒级口径 + 生成速度 / 上下文吞吐的拆分。
 *
 * ## 为什么要拆
 *
 * 第一版用 `SUM(total_tokens)` 算速率，而 `total_tokens` 里 94.6% 是
 * `cache_read_tokens`——agent 每轮把整个上下文重发一遍。于是「每秒 token」
 * 测的是上下文窗口有多大，不是干活强度：本机中位数 147,899 tok/s，
 * 但真正新生成的只有 247 tok/s。
 *
 * 现在主指标是**输出 token/秒（生成速度）**，上下文吞吐降为次指标 `context`。
 * 两条约束要保住：
 *  1. **主指标绝不含缓存读**。否则用户又会看到「每秒十几万」。
 *  2. **按天/按小时/按工具用 `genPerMinute`**，和主指标同口径，
 *     否则会出现「首屏 247 tok/s、日曲线 30 万 tok/min」的自相矛盾。
 *
 * ## 为什么要按 (session_id, ts) 去重
 *
 * 会话恢复时 Codex 会把积压的 `token_count` 一次性刷出，全部盖上恢复时刻的
 * 时间戳。实测某一秒挤进 2,748 条、仅 363 个不同毫秒，峰值因此虚高到
 * 4.9 亿 tok/s——那是日志补写，不是吞吐。
 *
 * 单位换算、中位数分母、聚合稳定性这三条老约束继续有效。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { Queries } from "./queries.js";
import { UsageEvent } from "./model.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-rate-"));
  const store = new Store(path.join(dir, "t.db"));
  const q = new Queries(store);
  return {
    store,
    q,
    close: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const T0 = Date.parse("2026-03-01T10:00:00Z");

function ev(o) {
  return new UsageEvent({
    tool: "codex",
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessionId: "s1",
    ts: T0,
    ...o,
  });
}

// ---------------------------------------------------------------- 口径拆分

test("rate：主指标只算输出，缓存读不进生成速度", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, inputTokens: 100_000, outputTokens: 10, cacheReadTokens: 400_000 }),
  ]);
  const r = q.rate();
  assert.equal(r.overall.medianPerSecond, 10, "生成速度 = 输出 10，不能被 50 万 token 撑大");
  assert.equal(r.overall.avgPerSecond, 10);
  assert.equal(r.context.medianPerSecond, 500_000, "上下文吞吐 = 新鲜输入 + 缓存读 + 缓存写");
  close();
});

test("rate：上下文吞吐包含新鲜输入与缓存写，不只是缓存读", () => {
  const { store, q, close } = fixture();
  store.insertEvents([ev({ id: "a", ts: T0, inputTokens: 7, outputTokens: 3, cacheReadTokens: 90, cacheWriteTokens: 5 })]);
  const r = q.rate();
  assert.equal(r.overall.medianPerSecond, 3, "主指标只认输出");
  assert.equal(r.context.medianPerSecond, 102, "7 + 90 + 5");
  close();
});

test("rate：按天聚合用生成速度口径，不和首屏打架", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, inputTokens: 500, outputTokens: 20, cacheReadTokens: 9_000 }),
  ]);
  const r = q.rate();
  assert.equal(r.byDay[0].genPerMinute, 20, "日曲线用输出/活跃分钟，和首屏同口径");
  assert.equal(r.byDay[0].ctxPerMinute, 9_500, "上下文吞吐单列");
  assert.equal(r.byDay[0].tokens, 9_520, "tokens 是两者之和，给「总量」用途");
  close();
});

// ---------------------------------------------------------------- 同刻去重

test("rate：同一 session 同一毫秒的多条只算首条", () => {
  const { store, q, close } = fixture();
  // 恢复突发：同一毫秒挤进 3 条，模拟补写积压的 token_count
  store.insertEvents([
    ev({ id: "a", sessionId: "s1", ts: T0, outputTokens: 100 }),
    ev({ id: "b", sessionId: "s1", ts: T0, outputTokens: 100 }),
    ev({ id: "c", sessionId: "s1", ts: T0, outputTokens: 100 }),
  ]);
  const r = q.rate();
  assert.equal(r.overall.peakPerSecond, 100, "同刻补写只留首条，峰值不该被乘以 3");
  assert.equal(r.overall.totalRequests, 1);
  close();
});

test("rate：不同 session 的同刻事件仍然全部计入", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", sessionId: "s1", ts: T0, outputTokens: 100 }),
    ev({ id: "b", sessionId: "s2", ts: T0, outputTokens: 60 }),
  ]);
  const r = q.rate();
  assert.equal(r.overall.peakPerSecond, 160, "不同会话是真并发，不能误删");
  close();
});

test("rate：去重后按天合计与全局生成量一致", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, outputTokens: 30 }),
    ev({ id: "dup", ts: T0, outputTokens: 30 }),
    ev({ id: "c", ts: T0 + 60_000, outputTokens: 70 }),
  ]);
  const r = q.rate();
  const sumDay = r.byDay.reduce((a, d) => a + d.genTokens, 0);
  assert.equal(sumDay, 100, "30 + 70，被去重的那条不重复计入");
  assert.equal(r.overall.totalGen, sumDay);
  close();
});

// ---------------------------------------------------------------- 秒级口径

test("rate：按秒分桶，活跃秒数正确", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, outputTokens: 100 }),
    ev({ id: "b", ts: T0 + 1000, outputTokens: 100 }),
    ev({ id: "c", ts: T0 + 2000, outputTokens: 100 }),
  ]);
  const r = q.rate();
  assert.equal(r.summary.activeSeconds, 3, "3 个不同的秒");
  assert.equal(r.summary.totalTokens, 300);
  assert.equal(r.summary.genPerSecond, 100, "生成总量 / 活跃秒 = 100，不是除以 60");
  assert.equal(r.summary.peakGenPerSecond, 100);
  close();
});

test("rate：同一秒内的多条请求合并成一个桶", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, sessionId: "s1", outputTokens: 50 }),
    ev({ id: "b", ts: T0 + 100, sessionId: "s2", outputTokens: 70 }),
  ]);
  const r = q.rate();
  assert.equal(r.summary.activeSeconds, 1, "相差 100ms 属于同一秒");
  assert.equal(r.summary.peakGenPerSecond, 120, "同一秒内合并为 120");
  close();
});

test("rate：中位数按活跃秒算，不被空秒拉低", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, outputTokens: 10 }),
    ev({ id: "b", ts: T0 + 1000, outputTokens: 20 }),
    ev({ id: "c", ts: T0 + 2000, outputTokens: 30 }),
    ev({ id: "d", ts: T0 + 3000, outputTokens: 1000 }),
  ]);
  const r = q.rate();
  assert.equal(r.overall.medianPerSecond, 30, "中位数取活跃秒里的中间值");
  assert.equal(r.overall.avgPerSecond, 265, "均值 1060/4 = 265，不是除以 60");
  close();
});

test("rate：峰值归属到具体的秒和工具", () => {
  const { store, q, close } = fixture();
  // 一个会话只属于一个工具，所以跨工具的同秒事件必然是不同 session，
  // 不能被 (session_id, ts) 去重吃掉
  store.insertEvents([
    ev({ id: "a", tool: "codex", sessionId: "s-codex", ts: T0, outputTokens: 100 }),
    ev({ id: "b", tool: "claude-code", sessionId: "s-cc", ts: T0 + 5000, outputTokens: 900 }),
    ev({ id: "c", tool: "dsh", sessionId: "s-dsh", ts: T0 + 5000, outputTokens: 100 }),
  ]);
  const r = q.rate();
  assert.ok(r.overall, "应有峰值归属");
  assert.equal(r.overall.peakPerSecond, 1000, "同一秒内两个工具合并成 1000");
  const tools = r.overall.peakBreakdown.map((x) => x.tool);
  assert.ok(tools.includes("claude-code") && tools.includes("dsh"), "峰值秒要列出工具构成");
  close();
});

test("rate：按天/按小时聚合仍然稳定", () => {
  const { store, q, close } = fixture();
  for (let i = 0; i < 5; i++) {
    store.insertEvents([ev({ id: `x${i}`, sessionId: `s${i}`, ts: T0 + i * 7000, outputTokens: 10 })]);
  }
  const r = q.rate();
  assert.equal(r.byDay.length, 1, "5 条都在同一天");
  assert.equal(r.byDay[0].genTokens, 50);
  // byHour 是固定 24 格（0-23 时）的数组，不是过滤后的列表
  const activeHours = r.byHour.filter((h) => h.tokens > 0);
  assert.equal(activeHours.length, 1, "5 条都落在同一个小时格");
  assert.equal(activeHours[0].genTokens, 50);
  close();
});

test("rate：按工具排序按生成速度，而不是上下文吞吐", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", tool: "codex", sessionId: "s-codex", ts: T0, outputTokens: 10, cacheReadTokens: 900_000 }),
    ev({ id: "b", tool: "dsh", sessionId: "s-dsh", ts: T0 + 1000, outputTokens: 80, cacheReadTokens: 100 }),
  ]);
  const r = q.rate();
  assert.equal(r.byTool[0].tool, "dsh", "codex 上下文大得多，但生成速度低，排序要按生成速度");
  close();
});

// ---------------------------------------------------------------- 空态

test("rate：空数据返回可展示的空态", () => {
  const { store, q, close } = fixture();
  const r = q.rate();
  assert.equal(r.overall, null);
  assert.equal(r.context, null);
  assert.equal(r.summary.activeSeconds, 0);
  assert.equal(r.summary.genPerSecond, 0);
  close();
});