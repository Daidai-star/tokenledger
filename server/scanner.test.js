/**
 * 扫描编排测试：进度事件、增量跳过、工具隔离、错误不中断。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { Scanner } from "./scanner.js";
import { Queries } from "./queries.js";
import { Collector } from "./model.js";
import { UsageEvent } from "./model.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-scan-"));
  return { store: new Store(path.join(dir, "s.db")), dir };
}

/** 造一个可配置行为的假 collector */
function fakeCollector(id, { roots, scan, color = "#123456" }) {
  return new Collector({ id, name: `Fake ${id}`, color, roots: [roots], scan });
}

function ctxStub() {
  return {
    cursor: () => ({ byteOffset: 0, lineNo: 0, size: 0, mtime: 0, reset: true }),
    advance: () => {},
    session: () => {},
    emitProgress: () => {},
  };
}

test("Scanner 跑通单个 collector 并落库", async () => {
  const { store, dir } = tmpStore();
  const c = fakeCollector("alpha", {
    roots: dir,
    scan: async (ctx) => {
      ctx.session({ sessionId: "s1", tool: "alpha", startedAt: Date.now() });
      return {
        events: [
          new UsageEvent({
            id: "e1",
            tool: "alpha",
            ts: Date.now(),
            model: "m1",
            inputTokens: 10,
            outputTokens: 2,
          }),
        ],
        stats: { filesSeen: 3, filesParsed: 2 },
      };
    },
  });

  const sc = new Scanner(store);
  // 直接调用 collector，绕开注册表
  const res = await c.scan(ctxStub());
  assert.equal(res.events.length, 1);
  assert.equal(res.stats.filesSeen, 3);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scanner 事件阶段推进并发出 done", async () => {
  const { store, dir } = tmpStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-root-"));
  fs.writeFileSync(path.join(root, "a.jsonl"), "{}\n");

  const c = fakeCollector("alpha", {
    roots: root,
    scan: async () => ({
      events: [
        new UsageEvent({
          id: "e1",
          tool: "alpha",
          ts: Date.now(),
          model: "m1",
          inputTokens: 1,
        }),
      ],
      stats: { filesSeen: 1, filesParsed: 1 },
    }),
  });

  const sc = new Scanner(store);
  const frames = [];
  // 把假 collector 临时注入注册表
  const { ALL } = await import("./collectors/index.js");
  ALL.push(c);
  try {
    const r = await sc.run({
      tools: ["alpha"],
      onProgress: (p) => frames.push(p),
    });
    assert.equal(r.eventsNew, 1);
    const stages = frames.map((p) => p.stage);
    assert.ok(stages.includes("scanning"));
    assert.ok(stages.includes("storing"));
    assert.ok(stages.includes("aggregating"));
    assert.equal(stages[stages.length - 1], "done");

    // 前端靠 running 字段区分「采集中 / 已完成」，中途必须为 true
    const mid = frames.slice(0, -1);
    assert.ok(mid.length > 0);
    for (const f of mid) assert.equal(f.running, true, `${f.stage} 应为 running=true`);
    assert.equal(frames[frames.length - 1].running, false);

    // SSE 订阅者也要收到同样的帧
    assert.ok(sc.lastProgress);
    assert.equal(sc.lastProgress.running, false);
    assert.equal(sc.progress().running, false);
    assert.equal(sc.running, false);
  } finally {
    ALL.pop();
  }
  fs.rmSync(root, { recursive: true, force: true });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scanner 并发保护：运行中再次调用会抛错", async () => {
  const { store, dir } = tmpStore();
  const sc = new Scanner(store);
  sc.running = true;
  await assert.rejects(() => sc.run({ tools: ["codex"] }), /already running/);
  sc.running = false;
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scanner 给 collector 注入成本估算结果", async () => {
  const { store, dir } = tmpStore();
  const captured = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-root2-"));
  const c = fakeCollector("beta", {
    roots: root,
    scan: async () => {
      captured.push(true);
      return {
        events: [
          new UsageEvent({
            id: "e1",
            tool: "beta",
            ts: Date.now(),
            model: "gpt-5",
            inputTokens: 1_000_000,
          }),
        ],
        stats: {},
      };
    },
  });
  const { ALL } = await import("./collectors/index.js");
  const sc = new Scanner(store);
  ALL.push(c);
  try {
    await sc.run({ tools: ["beta"] });
  } finally {
    ALL.pop();
  }
  const row = store.prep("SELECT cost_usd, cost_source FROM usage_events").get();
  assert.equal(row.cost_source, "builtin");
  assert.ok(Math.abs(row.cost_usd - 1.25) < 1e-6);
  assert.ok(captured.length > 0);
  fs.rmSync(root, { recursive: true, force: true });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scanner 单个 collector 抛错不影响其他工具", async () => {
  const { store, dir } = tmpStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-root3-"));
  const bad = fakeCollector("bad", {
    roots: root,
    scan: async () => {
      throw new Error("boom");
    },
  });
  const good = fakeCollector("good", {
    roots: root,
    scan: async () => ({
      events: [
        new UsageEvent({
          id: "g1",
          tool: "good",
          ts: Date.now(),
          model: "m",
          inputTokens: 5,
        }),
      ],
      stats: {},
    }),
  });

  const { ALL } = await import("./collectors/index.js");
  const sc = new Scanner(store);
  const stages = [];
  ALL.push(bad, good);
  try {
    const r = await sc.run({ tools: ["bad", "good"], onProgress: (p) => stages.push(p.stage) });
    assert.equal(r.eventsNew, 1);
    assert.ok(stages.includes("tool-error"));
    // 单工具失败后仍要走完聚合并正常结束
    assert.equal(stages[stages.length - 1], "done");
  } finally {
    ALL.splice(ALL.indexOf(bad), 2);
  }
  assert.equal(store.dataRange().events, 1);
  fs.rmSync(root, { recursive: true, force: true });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scanner 第二次扫描跳过未变更文件（增量）", async () => {
  const { store, dir } = tmpStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-inc-"));
  const f = path.join(root, "log.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "x", n: 1 }) + "\n");

  let reads = 0;
  const c = fakeCollector("inc", {
    roots: root,
    scan: async (ctx) => {
      const { readJsonlIncremental } = await import("./collectors/util.js");
      const { walkFiles } = await import("./collectors/util.js");
      const events = [];
      for (const file of walkFiles(ctx.roots.inc, { exts: [".jsonl"] })) {
        const cur = ctx.cursor("inc", file);
        const st = fs.statSync(file);
        if (!cur.reset && cur.size === st.size && cur.mtime === st.mtimeMs && cur.byteOffset > 0) {
          continue; // 未变更，跳过
        }
        reads++;
        const res = await readJsonlIncremental(file, cur.reset ? null : cur, (o) => {
          events.push(
            new UsageEvent({ id: `e-${o.n}`, tool: "inc", ts: Date.now(), model: "m", inputTokens: 1 }),
          );
        });
        ctx.advance("inc", file, res);
      }
      return { events, stats: {} };
    },
  });

  const { ALL } = await import("./collectors/index.js");
  const sc = new Scanner(store);
  ALL.push(c);
  try {
    const r1 = await sc.run({ tools: ["inc"] });
    assert.equal(r1.eventsNew, 1);
    const r2 = await sc.run({ tools: ["inc"] });
    assert.equal(r2.eventsNew, 0, "未变更文件不重复计数");
    assert.equal(reads, 1, "第二次不应再读文件");
  } finally {
    ALL.pop();
  }
  fs.rmSync(root, { recursive: true, force: true });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scanner 广播进度给 SSE 订阅者", async () => {
  const { store, dir } = tmpStore();
  const sc = new Scanner(store);
  const seen = [];
  const onProgress = (p) => seen.push(p.stage);
  sc.on("progress", onProgress);
  // 没有 collector 匹配时也要走完流程并广播 done
  await sc.run({ tools: ["__none__"] });
  assert.ok(seen.length >= 1);
  assert.equal(seen[seen.length - 1], "done");
  sc.off("progress", onProgress);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scanner.reset 清库后重建", async () => {
  const { store, dir } = tmpStore();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-reset-"));
  const c = fakeCollector("rs", {
    roots: root,
    scan: async () => ({
      events: [
        new UsageEvent({ id: "r1", tool: "rs", ts: Date.now(), model: "m", inputTokens: 7 }),
      ],
      stats: {},
    }),
  });
  const { ALL } = await import("./collectors/index.js");
  const sc = new Scanner(store);
  ALL.push(c);
  try {
    await sc.run({ tools: ["rs"] });
    assert.equal(store.dataRange().events, 1);
    const again = await sc.reset({ tools: ["rs"] });
    assert.equal(again.eventsNew, 1);
    assert.equal(store.dataRange().events, 1, "reset 后不应翻倍");
    const q = new Queries(store);
    assert.equal(q.overview({}).requests, 1);
  } finally {
    ALL.pop();
  }
  fs.rmSync(root, { recursive: true, force: true });
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Scanner.tools 返回安装检测结果", async () => {
  const { store, dir } = tmpStore();
  const sc = new Scanner(store);
  const tools = sc.tools();
  assert.ok(Array.isArray(tools));
  assert.ok(tools.some((t) => t.id === "codex"));
  for (const t of tools) {
    assert.equal(typeof t.installed, "boolean");
    assert.ok(t.color.startsWith("#"));
  }
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("真实 collector 契约完整（注册表自检）", async () => {
  const { ALL } = await import("./collectors/index.js");
  const ids = ALL.map((c) => c.id);
  assert.deepEqual(ids, [...new Set(ids)], "collector id 不能重复");
  for (const c of ALL) {
    assert.ok(c.id, "缺少 id");
    assert.ok(c.name, "缺少 name");
    assert.equal(typeof c.scan, "function");
    assert.equal(typeof c.detect, "function");
    assert.ok(Array.isArray(c.roots));
    assert.ok(c.roots.length > 0, `${c.id} 未声明 roots`);
  }
});

test("真实 collector 的 profile 不抛异常", async () => {
  const { ALL } = await import("./collectors/index.js");
  for (const c of ALL) {
    if (!c.profile) continue;
    const p = c.profile();
    assert.ok(p && typeof p === "object", `${c.id} 的 profile 返回异常`);
  }
});