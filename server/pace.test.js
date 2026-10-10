/**
 * 订阅额度视角：按当前速度，额度够用吗。
 *
 * 这是调研里用户最困惑的地方：厂商给的 $X 订阅额度和「API 等价成本」
 * 是两个东西。用户真正想问的是「按我这个用法，$200 的额度够不够」。
 * 只给一个累计估价回答不了——累计数字永远只告诉你已经花了多少。
 *
 * 核心是**投影**：把已发生用量按当前速率外推到周期末。
 *
 * 口径决定：
 *  - 按自然月统计（订阅额度按月重置）。
 *  - 速率用「本月已过天数」而不是「全部活跃天数」——用户可能上个月才
 *    开始用，用全部活跃天数会把速率算低、投影算保守。
 *  - 投影按「日速率 × 当月总天数」，不按「日均 × 已过天数」。
 *  - 月份还没过完时，投影值是估算，必须标出来。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-pace-"));
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

function ev(o) {
  return new UsageEvent({
    tool: "codex",
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ts: Date.parse("2026-03-01T10:00:00Z"),
    ...o,
  });
}

const MAR = Date.parse("2026-03-15T10:00:00Z");
const daysInMarch = 31;

test("pace：日均按当月已过天数算，投影到月末", () => {
  const { store, q, close } = fixture();
  // 3 月 1-15 日，每天 $10，共 $150
  for (let d = 1; d <= 15; d++) {
    store.insertEvents([
      ev({
        id: `d${d}`,
        ts: Date.parse(`2026-03-${String(d).padStart(2, "0")}T10:00:00Z`),
        inputTokens: 100,
        costUsd: 10,
      }),
    ]);
  }
  const r = q.pace({ now: MAR });
  assert.equal(r.spentUsd, 150, "本月已花 $150");
  assert.equal(r.daysElapsed, 15);
  assert.equal(r.daysInMonth, daysInMarch);
  assert.ok(Math.abs(r.dailyUsd - 10) < 0.01, `日均应为 $10，实际 ${r.dailyUsd}`);
  assert.ok(Math.abs(r.projectedUsd - 310) < 1, `投影应为 $310，实际 ${r.projectedUsd}`);
  close();
});

test("pace：跨月时只统计当月，不把上月算进来", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "f1", ts: Date.parse("2026-02-10T10:00:00Z"), inputTokens: 100, costUsd: 100 }),
  ]);
  store.insertEvents([
    ev({ id: "m1", ts: Date.parse("2026-03-10T10:00:00Z"), inputTokens: 100, costUsd: 30 }),
  ]);
  const r = q.pace({ now: MAR });
  assert.equal(r.spentUsd, 30, "只算 3 月，不含 2 月的 $100");
  close();
});

test("pace：当月还没过完时标记为估算", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "d1", ts: Date.parse("2026-03-05T10:00:00Z"), inputTokens: 100, costUsd: 5 }),
  ]);
  const mid = q.pace({ now: MAR });
  assert.equal(mid.complete, false, "月中不是完整月");
  const end = q.pace({ now: Date.parse("2026-03-31T23:00:00Z") });
  assert.equal(end.complete, true, "月末视为完整月");
  close();
});

test("pace：无数据时给出可展示的空态而非崩溃", () => {
  const { store, q, close } = fixture();
  const r = q.pace({ now: MAR });
  assert.equal(r.spentUsd, 0);
  assert.equal(r.projectedUsd, 0);
  assert.equal(r.complete, false);
  close();
});

test("pace：按工具拆分当月成本，便于对照订阅来源", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", tool: "codex", ts: Date.parse("2026-03-05T10:00:00Z"), inputTokens: 100, costUsd: 10 }),
  ]);
  store.insertEvents([
    ev({ id: "b", tool: "claude-code", ts: Date.parse("2026-03-06T10:00:00Z"), inputTokens: 100, costUsd: 20 }),
  ]);
  const r = q.pace({ now: MAR });
  const codex = r.byTool.find((t) => t.tool === "codex");
  const claude = r.byTool.find((t) => t.tool === "claude-code");
  assert.equal(codex.cost_usd, 10);
  assert.equal(claude.cost_usd, 20);
  assert.equal(r.byTool.reduce((n, t) => n + t.cost_usd, 0), 30, "拆分之和应等于总额");
  close();
});
