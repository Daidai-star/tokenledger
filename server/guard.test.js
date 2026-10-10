/**
 * 预算护栏：什么程度的单会话成本值得提醒。
 *
 * 实测本机单会话成本中位数 $0.32，但最高 $35.69——差 100 倍。
 * 这意味着固定阈值要么打扰大多数人，要么永远不响。
 * 所以护栏必须**跟着用户的实际分布走**，而不是拍一个数。
 *
 * 口径决定：
 *  - 用 P90 而不是 P50 做提醒线：多数会话很便宜，少数会话吃掉大钱，
 *    用户要防的是后者。
 *  - 阈值至少有一个下限（$5）：日活跃分布下 P90 可能只有 $1，
 *    那时按分布算出来的线会让人天天收到提醒。
 *  - 阈值和 P90 一起返回，界面必须照实显示「按你最近 N 个会话的分布」，
 *    不能让用户以为这是系统规定的数。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-guard-"));
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

/** 造一个会话：n 条请求，每条固定成本 */
function session(store, id, n, costEach, t0) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      ev({
        id: `${id}-${i}`,
        sessionId: id,
        ts: t0 + i * 1000,
        inputTokens: 100,
        costUsd: costEach,
      }),
    );
  }
  store.insertEvents(rows);
}

test("guard：提醒线按 P90 走，并给出至少 $5 的下限", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  // 19 个廉价会话 + 1 个昂贵会话，模拟本机 100 倍的分布
  for (let i = 0; i < 19; i++) session(store, `cheap${i}`, 2, 0.1, t + i * 10000);
  session(store, "rich", 20, 2.0, t + 190 * 10000);

  const r = q.guard();
  assert.ok(r.warnUsd >= 5, `提醒线不应低于 $5，实际 ${r.warnUsd}`);
  assert.ok(r.sessions > 0);
  assert.ok(r.warnUsd >= r.medianUsd, "提醒线必须高于中位数才有意义");
  close();
});

test("guard：分布很便宜时，阈值落到 $5 下限而不是 $1", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  for (let i = 0; i < 20; i++) session(store, `s${i}`, 1, 0.05, t + i * 10000);
  const r = q.guard();
  assert.equal(r.warnUsd, 5, "全是廉价会话时应回落到下限 $5");
  close();
});

test("guard：超出提醒线的会话被单独列出，降序排", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  for (let i = 0; i < 10; i++) session(store, `small${i}`, 1, 0.2, t + i * 10000);
  session(store, "huge", 30, 2.0, t + 200 * 10000);
  session(store, "big", 20, 2.0, t + 300 * 10000);
  const r = q.guard();
  assert.equal(r.over.length, 2, "只有两个会话超过 $5");
  assert.equal(r.over[0].cost_usd >= r.over[1].cost_usd, true, "降序排列");
  assert.ok(r.totalOverUsd > 0);
  close();
});

test("guard：无会话时不炸，给出可展示的空态", () => {
  const { store, q, close } = fixture();
  const r = q.guard();
  assert.equal(r.sessions, 0);
  assert.equal(r.over.length, 0);
  assert.equal(r.warnUsd, 5, "空态也给默认下限，前端不用特判");
  close();
});

test("guard：total_tokens=0 的心跳不计入会话成本", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([ev({ id: "hb", sessionId: "h", ts: t })]);
  store.insertEvents([ev({ id: "r1", sessionId: "h", ts: t + 100, inputTokens: 100, costUsd: 1 })]);
  const r = q.guard();
  // 心跳与真实请求同属 s1 会话，聚合后成本 $1——低于 $5 下限不入 over。
  // 关键断言是 sessions=1：心跳没有额外造出第二个「会话」。
  assert.equal(r.sessions, 1, "心跳不应造出一个额外的会话参与统计");
  assert.equal(r.over.length, 0, "$1 的会话低于下限，不该进超线列表");
  close();
});
