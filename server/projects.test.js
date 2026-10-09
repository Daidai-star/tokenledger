/**
 * 项目账单与冷启动诊断的回归测试。
 *
 * 冷启动的口径踩过一个坑：最初用 MIN(ts) 做 JOIN 取「首次请求」，
 * 但并发请求会共享同一毫秒（实测平均 2.38 条，最多 225 条），
 * JOIN 把同一个会话重复计数了 2.4 倍（417 个会话被算成 991）。
 * 正确做法是 ROW_NUMBER 按 ts 排序取第一条 —— 这条口径写死在下面。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-proj-"));
  const store = new Store(path.join(dir, "t.db"));
  const q = new Queries(store);
  return { store, q, dir, close: () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  } };
}

/**
 * 构造测试事件。
 *
 * 注意：UsageEvent 不接受 `total`——total_tokens 是 Store 落库时
 * 按「新鲜输入 + 输出 + 缓存读 + 缓存写」算出来的派生列。
 * （第一版测试传了 total，结果全部被忽略，断言失败才发现。）
 */
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

test("projects 按 token 降序，聚合字段齐全", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a1", cwd: "/w/big", sessionId: "sa", inputTokens: 100, costUsd: 1 }),
    ev({ id: "a2", cwd: "/w/big", sessionId: "sa", inputTokens: 50, cacheReadTokens: 900, costUsd: 1 }),
    ev({ id: "b1", cwd: "/w/small", sessionId: "sb", inputTokens: 10, costUsd: 1 }),
  ]);
  const rows = q.projects();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cwd, "/w/big", "token 多的应排前面");
  assert.equal(rows[0].requests, 2);
  assert.equal(rows[0].total_tokens, 1050);
  assert.equal(rows[0].sessions, 1, "同一个 sessionId 在同项目下只算 1 个会话");
  // 缓存命中 = 900 / 1050
  assert.ok(Math.abs(rows[0].cache_hit_rate - 85.71) < 0.01);
  assert.equal(rows[1].cache_hit_rate, 0, "无缓存时命中率为 0 而不是 null");
  close();
});

test("projects 排除没有 cwd 的事件", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", cwd: "/w/x", inputTokens: 5 }),
    ev({ id: "b", cwd: null, inputTokens: 999 }),
    ev({ id: "c", cwd: "", inputTokens: 999 }),
  ]);
  const rows = q.projects();
  assert.equal(rows.length, 1, "null 与空串都应被排除");
  assert.equal(rows[0].total_tokens, 5);
  close();
});

test("projects 空库返回空数组而不是报错", () => {
  const { q, close } = fixture();
  assert.deepEqual(q.projects(), []);
  close();
});

test("projects 支持时间范围与工具过滤", () => {
  const { store, q, close } = fixture();
  // day 由 ts 派生，所以范围过滤要通过 ts 构造，不能直接传 day
  store.insertEvents([
    ev({ id: "a", cwd: "/w/feb", sessionId: "s1", inputTokens: 10, ts: Date.parse("2026-02-10T10:00:00Z") }),
    ev({ id: "b", cwd: "/w/mar", sessionId: "s2", inputTokens: 20, ts: Date.parse("2026-03-05T10:00:00Z") }),
    ev({ id: "c", cwd: "/w/other", sessionId: "s3", inputTokens: 30, tool: "dsh", ts: Date.parse("2026-03-05T10:00:00Z") }),
  ]);
  const march = q.projects({ from: "2026-03-01", to: "2026-03-31" });
  assert.equal(march.length, 2, "3 月有 codex 与 dsh 两个项目");
  assert.ok(!march.some((r) => r.cwd === "/w/feb"), "2 月的项目应被范围过滤掉");
  const codexOnly = q.projects({ tools: ["codex"] });
  assert.equal(codexOnly.length, 2);
  assert.ok(!codexOnly.some((r) => r.cwd === "/w/other"), "工具过滤应生效");
  close();
});

test("coldStart：首次请求按 rn=1 计，不被并发同刻请求放大", () => {
  const { store, q, close } = fixture();
  // 一个会话，3 条请求共享同一毫秒（模拟并发）
  const t = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([
    ev({ id: "s1-1", sessionId: "s1", ts: t, inputTokens: 100 }),
    ev({ id: "s1-2", sessionId: "s1", ts: t, inputTokens: 200 }),
    ev({ id: "s1-3", sessionId: "s1", ts: t, inputTokens: 300 }),
  ]);
  const r = q.coldStart();
  assert.equal(r.sessions, 1, "一个会话只能算一次，哪怕同刻有 3 条请求");
  // rn=1 应该只取其中一条，不是三条之和
  assert.equal(r.firstRequest.input_tokens, 100, "rn=1 取排序后的第一条（rowid 兜底定序）");
  close();
});

test("coldStart：缓存命中率随会话内请求序号爬升", () => {
  const { store, q, close } = fixture();
  const base = Date.parse("2026-03-01T10:00:00Z");
  // 三个会话，每个 3 次请求，缓存逐步爬升
  for (let s = 0; s < 3; s++) {
    store.insertEvents([
      ev({ id: `s${s}-1`, sessionId: `s${s}`, ts: base, inputTokens: 900 }),
      ev({ id: `s${s}-2`, sessionId: `s${s}`, ts: base + 1000, inputTokens: 200, cacheReadTokens: 800 }),
      ev({ id: `s${s}-3`, sessionId: `s${s}`, ts: base + 2000, inputTokens: 100, cacheReadTokens: 900 }),
    ]);
  }
  const r = q.coldStart();
  const byRn = Object.fromEntries(r.curve.map((c) => [c.rn, c]));
  assert.equal(byRn[1].requests, 3);
  // 首请求 900 新鲜 / 0 缓存 -> 命中 0%（不是 10%，那条写错了基数）
  assert.equal(byRn[1].cache_hit_rate, 0, "首请求完全没有缓存命中");
  assert.equal(byRn[2].cache_hit_rate, 80);
  assert.equal(byRn[3].cache_hit_rate, 90);
  assert.ok(r.coldHitRate < r.warmHitRate, "冷 < 热");
  close();
});

test("coldStart：忽略 total_tokens=0 的心跳行", () => {
  const { store, q, close } = fixture();
  const base = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([
    // 心跳：所有 token 字段为 0，派生出的 total_tokens 也是 0
    ev({ id: "hb", sessionId: "s1", ts: base }),
    ev({ id: "real", sessionId: "s1", ts: base + 100, inputTokens: 700 }),
  ]);
  const r = q.coldStart();
  assert.equal(r.sessions, 1);
  assert.equal(r.firstRequest.input_tokens, 700, "心跳行不应被当成首次请求");
  close();
});

test("coldStart：无 session_id 的事件不参与", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "x", sessionId: null, inputTokens: 100 }),
  ]);
  const r = q.coldStart();
  assert.equal(r.sessions, 0);
  assert.equal(r.firstRequest, null);
  assert.equal(r.coldPremiumUsd, null, "没有样本就不该编造溢价");
  close();
});

test("coldStart：空库返回结构完整的零值", () => {
  const { q, close } = fixture();
  const r = q.coldStart();
  assert.equal(r.sessions, 0);
  assert.equal(r.coldHitRate, 0);
  assert.deepEqual(r.curve, []);
  close();
});

test("coldStart：冷启动溢价恒为非负", () => {
  const { store, q, close } = fixture();
  const base = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([
    ev({ id: "a", sessionId: "s1", ts: base, inputTokens: 900, costUsd: 3 }),
  ]);
  const r = q.coldStart();
  assert.ok(r.coldPremiumUsd !== null);
  assert.ok(r.coldPremiumUsd >= 0, "溢价不能是负数");
  assert.ok(r.coldPremiumPerSession > 0);
  close();
});

test("所有接受过滤的查询在「无过滤 / 带过滤」下都生成合法 SQL", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", cwd: "/w/x", sessionId: "s1", inputTokens: 100, cacheReadTokens: 900 }),
    ev({ id: "b", cwd: "/w/y", sessionId: "s2", tool: "dsh", inputTokens: 50 }),
  ]);

  // 回归测试：#eventWhere 改成「裸条件 + where 两种形态」之后，
  // hourly / weekday / rate 三处如果忘了把插值改成 w.where，
  // 条件就会裸奔 -> SQL 语法错误。这里逐个跑两种形态来兜住。
  const calls = [
    ["projects", () => q.projects()],
    ["projects+range", () => q.projects({ from: "2026-01-01", to: "2026-12-31" })],
    ["projects+tools", () => q.projects({ tools: ["codex"] })],
    ["coldStart", () => q.coldStart()],
    ["coldStart+range", () => q.coldStart({ from: "2026-01-01", to: "2026-12-31" })],
    ["coldStart+tools", () => q.coldStart({ tools: ["dsh"] })],
    ["hourly", () => q.hourly()],
    ["hourly+range", () => q.hourly({ from: "2026-01-01", to: "2026-12-31" })],
    ["weekday", () => q.weekday()],
    ["weekday+tools", () => q.weekday({ tools: ["codex"] })],
    ["rate", () => q.rate()],
    ["rate+range", () => q.rate({ from: "2026-01-01", to: "2026-12-31" })],
    ["rate+both", () => q.rate({ from: "2026-01-01", to: "2026-12-31", tools: ["codex", "dsh"] })],
  ];
  for (const [name, fn] of calls) {
    assert.doesNotThrow(fn, `${name} 应该生成合法 SQL`);
  }
  // 带范围时结果应与不带一致（数据全在范围内）
  assert.equal(q.projects().length, q.projects({ from: "2026-01-01", to: "2026-12-31" }).length);
  close();
});

test("coldStart 支持工具过滤", () => {
  const { store, q, close } = fixture();
  store.insertEvents([
    ev({ id: "a", sessionId: "s1", tool: "codex", inputTokens: 100 }),
    ev({ id: "b", sessionId: "s2", tool: "dsh", inputTokens: 100 }),
  ]);
  assert.equal(q.coldStart({ tools: ["dsh"] }).sessions, 1);
  close();
});
