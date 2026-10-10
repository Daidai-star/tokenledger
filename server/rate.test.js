/**
 * Token 速率的秒级口径。
 *
 * 原来是分钟分桶，理由是「事件是一次请求完成的瞬时记录，分钟够细了」。
 * 但分钟桶把真正的尖峰抹平了——一次长上下文会话的尖峰落在哪一秒里
 * 根本看不出来，用户问「我最快的那一秒烧了多少」也答不上。
 *
 * 改成秒级后要保住三个东西：
 *  1. **单位换算不能错**。avgPerSecond = 总 token / 活跃秒数，
 *     不是除以 60。峰值同理。
 *  2. **中位数仍然用活跃秒**，不是全部秒。空秒会把分布压低。
 *  3. **按天/按小时的聚合仍然稳定**，否则「今天哪个小时最忙」
 *     会因为秒级噪声变得不可读。
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
    ts: T0,
    ...o,
  });
}

test("rate：按秒分桶，活跃秒数正确", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, inputTokens: 100 }),
    ev({ id: "b", ts: T0 + 1000, inputTokens: 100 }),
    ev({ id: "c", ts: T0 + 2000, inputTokens: 100 }),
  ]);
  const r = q.rate();
  assert.equal(r.summary.activeSeconds, 3, "3 个不同的秒");
  assert.equal(r.summary.totalTokens, 300);
  assert.equal(r.summary.avgPerSecond, 100, "总 token / 活跃秒 = 100，不是除以 60");
  assert.equal(r.summary.peakPerSecond, 100);
  close();
});

test("rate：同一秒内的多条请求合并成一个桶", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, inputTokens: 50 }),
    ev({ id: "b", ts: T0 + 100, inputTokens: 70 }),
  ]);
  const r = q.rate();
  assert.equal(r.summary.activeSeconds, 1, "相差 100ms 属于同一秒");
  assert.equal(r.summary.peakPerSecond, 120, "同一秒内合并为 120");
  close();
});

test("rate：中位数按活跃秒算，不被空秒拉低", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", ts: T0, inputTokens: 10 }),
    ev({ id: "b", ts: T0 + 1000, inputTokens: 20 }),
    ev({ id: "c", ts: T0 + 2000, inputTokens: 30 }),
    ev({ id: "d", ts: T0 + 3000, inputTokens: 1000 }),
  ]);
  const r = q.rate();
  assert.equal(r.overall.medianPerSecond, 30, "中位数取活跃秒里的中间值");
  assert.equal(r.overall.avgPerSecond, 265, "均值 1060/4 = 265，不是除以 60");
  close();
});

test("rate：峰值归属到具体的秒和工具", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", tool: "codex", ts: T0, inputTokens: 100 }),
    ev({ id: "b", tool: "claude-code", ts: T0 + 5000, inputTokens: 900 }),
    ev({ id: "c", tool: "dsh", ts: T0 + 5000, inputTokens: 100 }),
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
    store.insertEvents([ev({ id: `x${i}`, ts: T0 + i * 7000, inputTokens: 10 })]);
  }
  const r = q.rate();
  assert.equal(r.byDay.length, 1, "5 条都在同一天");
  assert.equal(r.byDay[0].tokens, 50);
  // byHour 是固定 24 格（0-23 时）的数组，不是过滤后的列表
  const activeHours = r.byHour.filter((h) => h.tokens > 0);
  assert.equal(activeHours.length, 1, "5 条都落在同一个小时格");
  assert.equal(activeHours[0].tokens, 50);
  close();
});

test("rate：空数据返回可展示的空态", () => {
  const { store, q, close } = fixture();
  const r = q.rate();
  assert.equal(r.overall, null);
  assert.equal(r.summary.activeSeconds, 0);
  assert.equal(r.summary.avgPerSecond, 0);
  close();
});
