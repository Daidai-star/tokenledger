/**
 * 浪费诊断（会话碎片化）的回归测试。
 *
 * 这个功能回答的不是「你花了多少」，而是「你多花了多少、为什么、怎么改」。
 * 所以口径必须站得住，否则给出的建议是错的。三个关键决定：
 *
 * 1. **会话级聚合，不做跨会话配对。** 一个会话 = 一段连续工作。
 *    碎片化的代价是「每段工作的第一枪要付冷启动学费」，所以按会话算。
 * 2. **碎片化指数用「会话数 / 唯一项目数」的商衡量**——它就是平均每个项目
 *    开了多少个会话。1.0 表示一个项目一个会话（理想），4.0 表示切碎了。
 *    不用「平均会话长度」是因为它对长尾会话过度敏感。
 * 3. **可省金额是反推值**，和冷启动溢价同一个口径（缓存读按 input 的
 *    1/5.75 计价），并在返回值里标出 discount，UI 必须照实标注。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-waste-"));
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

test("waste：碎片化指数 = 会话数 / 唯一项目数", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  // 一个项目，开 3 个会话 —— 应该被判为碎片化（3.0）
  for (let s = 0; s < 3; s++) {
    store.insertEvents([
      ev({ id: `p1-s${s}-1`, sessionId: `p1-s${s}`, cwd: "/w/alpha", ts: t + s * 100000, inputTokens: 500 }),
    ]);
  }
  const r = q.waste();
  assert.equal(r.projects, 1, "唯一项目数是 1，不是 3");
  assert.equal(r.sessions, 3, "会话数是 3");
  assert.equal(r.fragmentation, 3, "碎片化指数 = 3 会话 / 1 项目");
  close();
});

test("waste：同一项目内会话按 token 降序，字段齐全", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  // alpha 开 2 个会话（浪费大），beta 开 1 个（浪费小）
  store.insertEvents([
    ev({ id: "a1", sessionId: "a1", cwd: "/w/alpha", ts: t, inputTokens: 900, cacheReadTokens: 100, costUsd: 0.9 }),
    ev({ id: "a2", sessionId: "a2", cwd: "/w/alpha", ts: t + 1000, inputTokens: 800, cacheReadTokens: 200, costUsd: 0.8 }),
    ev({ id: "b1", sessionId: "b1", cwd: "/w/beta", ts: t + 2000, inputTokens: 100, cacheReadTokens: 900, costUsd: 0.1 }),
  ]);
  const r = q.waste();
  assert.equal(r.rows.length, 2);
  const alpha = r.rows.find((x) => x.cwd === "/w/alpha");
  assert.ok(alpha, "alpha 应在结果里");
  assert.equal(alpha.sessions, 2);
  assert.equal(alpha.waste_usd > r.rows.find((x) => x.cwd === "/w/beta").waste_usd, true,
    "首轮占比高的项目浪费更多，alpha 应排在 beta 前面");
  close();
});

test("waste：可省金额不超首轮实际成本，且冷启动溢价按同一折扣口径", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([
    ev({ id: "s-1", sessionId: "s1", cwd: "/w/alpha", ts: t, inputTokens: 1000, costUsd: 1.0 }),
  ]);
  const r = q.waste();
  const row = r.rows[0];
  assert.ok(row.waste_usd <= row.first_cost_usd + 1e-9,
    "可省金额不可能超过首轮实际花费");
  assert.equal(r.discount, 5.75, "折扣口径要与 coldStart 一致");
  // 首轮 1000 新鲜输入 @ $1，若全部按缓存价只需 1/5.75
  assert.ok(Math.abs(row.waste_usd - (1 - 1 / 5.75)) < 0.01, `实际 ${row.waste_usd}`);
  close();
});

test("waste：没有 cwd 的事件不进入项目维度", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([
    ev({ id: "ncwd", sessionId: "s1", ts: t, inputTokens: 500 }), // cwd 为空
  ]);
  const r = q.waste();
  assert.equal(r.rows.length, 0, "项目维度必须排除无 cwd 的事件");
  close();
});

test("waste：total_tokens=0 的心跳行不计入首轮", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([
    ev({ id: "hb", sessionId: "s1", cwd: "/w/alpha", ts: t }), // 心跳
    ev({ id: "real", sessionId: "s1", cwd: "/w/alpha", ts: t + 100, inputTokens: 800, costUsd: 0.8 }),
  ]);
  const r = q.waste();
  assert.equal(r.rows[0].first_input_tokens, 800, "心跳行不应被当成首轮");
  close();
});

test("waste：碎片化指数为 1 时不报警（一个项目一个会话）", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  store.insertEvents([
    ev({ id: "a1", sessionId: "a1", cwd: "/w/alpha", ts: t, inputTokens: 100 }),
    ev({ id: "b1", sessionId: "b1", cwd: "/w/beta", ts: t, inputTokens: 100 }),
  ]);
  const r = q.waste();
  assert.equal(r.fragmentation, 1);
  assert.equal(r.verdict, "ok", "碎片化指数 1 不该给出警告");
  close();
});

test("waste：碎片化指数高时给出可执行建议", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  for (let s = 0; s < 5; s++) {
    store.insertEvents([
      ev({ id: `a${s}`, sessionId: `a${s}`, cwd: "/w/alpha", ts: t + s * 1000, inputTokens: 900, costUsd: 0.9 }),
    ]);
  }
  const r = q.waste();
  assert.equal(r.fragmentation, 5);
  assert.notEqual(r.verdict, "ok");
  assert.ok(r.advice && r.advice.length > 0, "必须给出可执行建议");
  assert.ok(typeof r.advice[0].action === "string" && r.advice[0].action.length > 10,
    "建议要具体到能照着做");
  close();
});

test("waste：建议文本里的路径只留最后两段，不泄漏完整 cwd", () => {
  const { store, q, close } = fixture();
  const t = Date.parse("2026-03-01T10:00:00Z");
  for (let s = 0; s < 4; s++) {
    store.insertEvents([
      ev({
        id: `c${s}`,
        sessionId: `c${s}`,
        // cwd 里带客户名与用户名——这是最敏感的那种形态
        cwd: "/Users/someone/work/AcmeCorp/secret-project",
        ts: t + s * 1000,
        inputTokens: 900,
        costUsd: 0.9,
      }),
    ]);
  }
  const r = q.waste();
  const adviceText = JSON.stringify(r.advice);
  assert.ok(!adviceText.includes("/Users/someone"), "建议里绝不能出现完整绝对路径");
  // 保留最后两段是既有约定（与前端 shortPath 一致）：用户要靠这两段
  // 认出是哪个项目，砍到只剩一段就失去意义。真正要防的是**完整路径**
  // 泄漏——尤其是前缀里的用户名和上层目录，它们不属于项目标识本身。
  assert.ok(adviceText.includes("…/AcmeCorp/secret-project"), "应保留最后两段供用户辨认");
  assert.ok(!adviceText.includes("/work/"), "上层目录不应出现");
  close();
});
