/**
 * 游标提交时机的回归测试。
 *
 * 背景：collector 会把整个工具的事件攒在内存里，等 scan() 返回后统一落库；
 * 而文件游标若逐个实时写入，进程中途被杀就会出现
 * 「游标已推进、事件还在内存里」的窗口——重启后这些文件被当成未变更跳过，
 * 数据永久丢失。修复方案是游标先攒着，事件落盘后才提交。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "./store.js";
import { Scanner } from "./scanner.js";
import { UsageEvent, Collector } from "./model.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-cur-"));
  const store = new Store(path.join(dir, "c.db"));
  return { store, dir };
}

/**
 * 模拟一个「扫 3 个文件、中途崩溃」的 collector：
 * 前 2 个文件 advance 了但事件没返回，第 3 个直接抛错
 */
function crashingCollector(id, files) {
  return new Collector({
    id,
    name: id,
    roots: [files],
    scan: async (ctx) => {
      const events = [];
      for (const f of files) {
        if (f.endsWith("3")) {
          // 崩溃点：前两个文件的游标已 advance，事件还在内存里
          throw new Error("进程被杀");
        }
        events.push(
          new UsageEvent({
            id: `ev-${path.basename(f)}`,
            tool: id,
            model: "m",
            ts: Date.now(),
            inputTokens: 100,
          }),
        );
        ctx.advance(id, f, { byteOffset: 1000, lineNo: 10, size: 1000, mtime: 1 });
      }
      return { events, stats: {} };
    },
  });
}

test("collector 抛错时游标不落盘（下次会重读，不丢数据）", async () => {
  const { store, dir } = tmpStore();
  const files = ["a1", "a2", "a3"].map((n) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, "x");
    return f;
  });
  const sc = new Scanner(store);
  const { ALL } = await import("./collectors/index.js");
  const c = crashingCollector("crash", files);
  ALL.push(c);
  try {
    await sc.run({ tools: ["crash"] });
  } finally {
    ALL.pop();
  }

  // 崩溃了：事件没落库，游标也必须没提交
  assert.equal(store.dataRange().events, 0, "崩溃的工具不应有事件落库");
  const cursors = store.prep("SELECT COUNT(*) AS c FROM file_cursors").get().c;
  assert.equal(cursors, 0, "崩溃的工具不应提交游标，否则下次会跳过这些文件");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("正常扫描：事件与游标一起提交", async () => {
  const { store, dir } = tmpStore();
  const files = ["b1", "b2"].map((n) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, "x");
    return f;
  });
  const sc = new Scanner(store);
  const { ALL } = await import("./collectors/index.js");
  const c = new Collector({
    id: "ok",
    name: "ok",
    roots: [files],
    scan: async (ctx) => {
      const events = [];
      for (const f of files) {
        events.push(
          new UsageEvent({
            id: `ev-${path.basename(f)}`,
            tool: "ok",
            model: "m",
            ts: Date.now(),
            inputTokens: 100,
          }),
        );
        ctx.advance("ok", f, { byteOffset: 1000, lineNo: 10, size: 1000, mtime: 1 });
      }
      return { events, stats: {} };
    },
  });
  ALL.push(c);
  try {
    const r = await sc.run({ tools: ["ok"] });
    assert.equal(r.eventsNew, 2);
  } finally {
    ALL.pop();
  }
  assert.equal(store.dataRange().events, 2);
  const cur = store.getCursor("ok", files[0]);
  assert.ok(cur, "游标应在事件落盘后提交");
  assert.equal(cur.byte_offset, 1000);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("关键场景：崩溃后重跑能把之前丢的事件补回来", async () => {
  const { store, dir } = tmpStore();
  const files = ["c1", "c2", "c3"].map((n) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, "x");
    return f;
  });
  const { ALL } = await import("./collectors/index.js");

  // 第一次：崩溃
  const bad = crashingCollector("resume", files);
  ALL.push(bad);
  let sc = new Scanner(store);
  try {
    await sc.run({ tools: ["resume"] });
  } finally {
    ALL.pop();
  }
  assert.equal(store.dataRange().events, 0);

  // 第二次：collector 修好了，同样从头扫
  const good = new Collector({
    id: "resume",
    name: "resume",
    roots: [files],
    scan: async (ctx) => {
      const events = [];
      for (const f of files) {
        events.push(
          new UsageEvent({
            id: `ev-${path.basename(f)}`,
            tool: "resume",
            model: "m",
            ts: Date.now(),
            inputTokens: 100,
          }),
        );
        ctx.advance("resume", f, { byteOffset: 1000, lineNo: 10, size: 1000, mtime: 1 });
      }
      return { events, stats: {} };
    },
  });
  ALL.push(good);
  sc = new Scanner(store);
  try {
    const r = await sc.run({ tools: ["resume"] });
    assert.equal(r.eventsNew, 3, "崩溃后重跑应补齐全部 3 个文件的事件");
  } finally {
    ALL.pop();
  }
  assert.equal(store.dataRange().events, 3);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("游标写入失败不影响事件落库", async () => {
  const { store, dir } = tmpStore();
  const files = ["d1"].map((n) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, "x");
    return f;
  });
  const sc = new Scanner(store);
  const { ALL } = await import("./collectors/index.js");
  const c = new Collector({
    id: "badcur",
    name: "badcur",
    roots: [files],
    scan: async (ctx) => {
      ctx.advance("badcur", files[0], { byteOffset: -1, lineNo: -1, size: -1, mtime: -1 });
      return {
        events: [
          new UsageEvent({ id: "z", tool: "badcur", model: "m", ts: Date.now(), inputTokens: 5 }),
        ],
        stats: {},
      };
    },
  });
  ALL.push(c);
  try {
    await sc.run({ tools: ["badcur"] });
  } finally {
    ALL.pop();
  }
  // 负值 offset 不会让事件丢失，只是下次可能重读
  assert.equal(store.dataRange().events, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});