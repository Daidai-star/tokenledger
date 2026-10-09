/**
 * util.js 的单元测试：文件遍历、增量 JSONL 读取、时间戳与哈希。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  walkFiles,
  readJsonlIncremental,
  readZstdJsonl,
  bytesFilter,
  toTs,
  hashId,
  surfaceOf,
  fileSize,
} from "./util.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tokenledger-test-"));
}

test("walkFiles 按后缀递归收集，跳过 .DS_Store", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(dir, "x.jsonl"), "{}");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
  fs.writeFileSync(path.join(dir, "a", "y.jsonl"), "{}");
  fs.writeFileSync(path.join(dir, "a", "b", "z.jsonl"), "{}");
  fs.writeFileSync(path.join(dir, "skip.txt"), "x");

  const files = walkFiles(dir, { exts: [".jsonl"] });
  const names = files.map((f) => path.basename(f)).sort();
  assert.deepEqual(names, ["x.jsonl", "y.jsonl", "z.jsonl"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("walkFiles 尊重 maxDepth 与 maxFiles", async () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, "1", "2", "3", "4"), { recursive: true });
  fs.writeFileSync(path.join(dir, "1", "2", "3", "4", "deep.jsonl"), "{}");
  fs.writeFileSync(path.join(dir, "top.jsonl"), "{}");

  assert.equal(walkFiles(dir, { exts: [".jsonl"], maxDepth: 2 }).length, 1);
  assert.equal(walkFiles(dir, { exts: [".jsonl"], maxFiles: 1 }).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("walkFiles 目录不存在时返回空数组", async () => {
  assert.deepEqual(walkFiles("/nope/not/here", { exts: [".jsonl"] }), []);
});

test("readJsonlIncremental 解析全部行并记录 offset", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.jsonl");
  const rows = [{ i: 1, v: "中文" }, { i: 2, v: "x" }, { i: 3, v: "y" }];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const got = [];
  const res = await readJsonlIncremental(file, null, (o) => got.push(o));
  assert.equal(got.length, 3);
  assert.deepEqual(got.map((g) => g.i), [1, 2, 3]);
  assert.equal(res.parsed, 3);
  assert.equal(res.byteOffset, fs.statSync(file).size);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental 增量：只读新增行", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.jsonl");
  fs.writeFileSync(file, JSON.stringify({ i: 1 }) + "\n" + JSON.stringify({ i: 2 }) + "\n");

  const first = [];
  const c1 = await readJsonlIncremental(file, null, (o) => first.push(o));
  assert.equal(first.length, 2);

  // 追加两行
  fs.appendFileSync(file, JSON.stringify({ i: 3 }) + "\n" + JSON.stringify({ i: 4 }) + "\n");
  const second = [];
  const c2 = await readJsonlIncremental(file, c1, (o) => second.push(o));
  assert.deepEqual(second.map((o) => o.i), [3, 4]);
  assert.equal(c2.reset, false);
  assert.equal(c2.byteOffset, fs.statSync(file).size);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental 文件未变化时不重复解析", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.jsonl");
  fs.writeFileSync(file, JSON.stringify({ i: 1 }) + "\n");

  const c1 = await readJsonlIncremental(file, null, () => {});
  const count = [];
  const c2 = await readJsonlIncremental(file, c1, () => count.push(1));
  assert.equal(count.length, 0);
  assert.equal(c2.parsed, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental 文件被截断时从头重读", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.jsonl");
  fs.writeFileSync(file, JSON.stringify({ i: 1 }) + "\n" + JSON.stringify({ i: 2 }) + "\n");
  const c1 = await readJsonlIncremental(file, null, () => {});

  // 截断并写入更短内容
  fs.writeFileSync(file, JSON.stringify({ i: 9 }) + "\n");
  const got = [];
  const c2 = await readJsonlIncremental(file, c1, (o) => got.push(o));
  assert.equal(c2.reset, true);
  assert.deepEqual(got.map((o) => o.i), [9]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental 处理末尾无换行的最后一行", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.jsonl");
  fs.writeFileSync(file, JSON.stringify({ i: 1 }) + "\n" + JSON.stringify({ i: 2 }));
  const got = [];
  const res = await readJsonlIncremental(file, null, (o) => got.push(o));
  assert.deepEqual(got.map((o) => o.i), [1, 2]);
  assert.equal(res.parsed, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental 大文件会让出事件循环", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "huge.jsonl");
  // 约 40MB，超过单次 YIELD_BYTES(8MB)，确保中途有多次让出
  const big = "x".repeat(4000);
  const lines = [];
  for (let i = 0; i < 10_000; i++) lines.push(JSON.stringify({ i, t: big }));
  fs.writeFileSync(file, lines.join("\n") + "\n");

  let sawTick = false;
  const tick = () => {
    sawTick = true;
  };
  const timer = setInterval(tick, 0);
  const count = [];
  await readJsonlIncremental(file, null, () => count.push(1));
  clearInterval(timer);
  assert.equal(count.length, 10_000);
  // 定时器能插进来 -> 说明读取过程确实让出了事件循环
  assert.ok(sawTick, "同步读取不应阻塞事件循环");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental 跳过坏行但不中断", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.jsonl");
  fs.writeFileSync(file, '{"i":1}\nnot-json\n{"i":2}\n');
  const got = [];
  await readJsonlIncremental(file, null, (o) => got.push(o));
  assert.deepEqual(got.map((o) => o.i), [1, 2]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental 正确处理跨块的多字节 UTF-8", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "big.jsonl");
  // 构造超过 1MB 读取块，且中文出现在块边界附近
  const filler = "填".repeat(200_000); // 600KB
  const lines = [
    JSON.stringify({ i: 0, t: filler }),
    JSON.stringify({ i: 1, t: "中文边界测试🎉" }),
    JSON.stringify({ i: 2, t: filler }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const got = [];
  await readJsonlIncremental(file, null, (o) => got.push(o));
  assert.equal(got.length, 3);
  assert.equal(got[1].t, "中文边界测试🎉");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental 增量读取时 UTF-8 跨块不损坏", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "big.jsonl");
  const filler = "填".repeat(300_000);
  fs.writeFileSync(file, JSON.stringify({ i: 0, t: filler }) + "\n");
  const c1 = await readJsonlIncremental(file, null, () => {});
  fs.appendFileSync(file, JSON.stringify({ i: 1, t: "后续中文🎉" }) + "\n");
  const got = [];
  await readJsonlIncremental(file, c1, (o) => got.push(o));
  assert.deepEqual(got.map((o) => o.t), ["后续中文🎉"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonlIncremental filter 命中才 parse", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "a.jsonl");
  fs.writeFileSync(
    file,
    [
      '{"type":"message","body":"很长的正文"}',
      '{"type":"token_count","info":{}}',
      '{"type":"message","body":"再来一段"}',
    ].join("\n") + "\n",
  );
  const got = [];
  await readJsonlIncremental(file, null, (o) => got.push(o.type), {
    filter: bytesFilter(['"token_count"']),
  });
  assert.deepEqual(got, ["token_count"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("bytesFilter 命中多个标记任一即可", async () => {
  const f = bytesFilter(["alpha", "beta"]);
  const check = (s) => f(Buffer.from(s), 0, Buffer.byteLength(s));
  assert.equal(check("has alpha here"), true);
  assert.equal(check("has beta here"), true);
  assert.equal(check("neither"), false);
});

test("bytesFilter 只扫描头部窗口", async () => {
  const f = bytesFilter(["MARK"], 16);
  const near = "MARK" + "x".repeat(5);
  assert.equal(f(Buffer.from(near), 0, near.length), true);
  const far = "x".repeat(100) + "MARK";
  assert.equal(f(Buffer.from(far), 0, far.length), false);
});

test("toTs 处理 ISO / 秒 / 毫秒", async () => {
  assert.equal(toTs("2026-01-01T00:00:00.000Z"), Date.parse("2026-01-01T00:00:00Z"));
  assert.equal(toTs(1767225600), 1767225600000); // 秒 -> 毫秒
  assert.equal(toTs(1767225600000), 1767225600000); // 已是毫秒
  assert.equal(toTs("1767225600000"), 1767225600000); // 数字字符串
  assert.equal(toTs(null), null);
  assert.equal(toTs("not a date"), null);
});

test("hashId 稳定且区分不同参数", async () => {
  assert.equal(hashId("a", "b", 1), hashId("a", "b", 1));
  assert.notEqual(hashId("a", "b", 1), hashId("a", "b", 2));
  // 拼接分隔符避免歧义：["ab","c"] vs ["a","bc"]
  assert.notEqual(hashId("ab", "c"), hashId("a", "bc"));
  assert.equal(hashId("a", null, "b"), hashId("a", "b"));
});

test("surfaceOf 识别客户端形态", async () => {
  assert.equal(surfaceOf("Codex Desktop", "vscode"), "desktop");
  assert.equal(surfaceOf(null, "vscode"), "ide");
  // source=exec 是 Codex 的非交互模式（如 codex exec），归为 exec
  assert.equal(surfaceOf("codex_cli_rs", "exec"), "exec");
  assert.equal(surfaceOf("codex_cli_rs", null), "cli");
  assert.equal(surfaceOf(null, null), null);
});

test("fileSize 人类可读", async () => {
  assert.equal(fileSize(512), "512B");
  assert.equal(fileSize(2048), "2.0KB");
  assert.equal(fileSize(1024 * 1024 * 3), "3.0MB");
});

// 顺带验证内置 zstd 单帧 API 可用（dsh 采集器的退化路径依赖它）
test("内置 zstd 单帧解压可用", async () => {
  const raw = Buffer.from('{"type":"session"}\n'.repeat(500), "utf8");
  const packed = zlib.zstdCompressSync(raw);
  const out = zlib.zstdDecompressSync(packed);
  assert.equal(out.toString("utf8").split("\n").filter(Boolean).length, 500);
});

// ------------------------------------------------------- zstd JSONL 读取

function zstFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-zst-"));
  const f = path.join(dir, "a.jsonl.zst");
  fs.writeFileSync(f, zlib.zstdCompressSync(Buffer.from(lines, "utf8")));
  return { f, dir };
}

test("readZstdJsonl 逐行还原压缩内容", async () => {
  const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i, kind: "x" })).join("\n");
  const { f, dir } = zstFile(lines);
  const got = [];
  const res = await readZstdJsonl(f, (o) => got.push(o.i));
  assert.equal(got.length, 2000);
  assert.equal(got[0], 0);
  assert.equal(got[1999], 1999);
  assert.equal(res.size, fs.statSync(f).size);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readZstdJsonl 行号连续，且能处理末尾无换行的最后一行", async () => {
  // 最后一行故意不带换行——zstd 流的尾块容易在这里丢内容
  const body = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i })).join("\n");
  const { f, dir } = zstFile(body + "\n" + JSON.stringify({ i: 50 }));
  const seen = [];
  const res = await readZstdJsonl(f, (o, lineNo) => seen.push([lineNo, o.i]));
  assert.equal(seen.length, 51);
  // 行号与 readJsonlIncremental 一致：1-based
  assert.equal(seen[0][0], 1);
  assert.equal(seen[50][0], 51, "行号应连续到最后一行");
  assert.equal(seen[50][1], 50, "末尾无换行的最后一行不能丢");
  assert.equal(res.lineNo, 51);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readZstdJsonl 跨解压块边界的行不被截断", async () => {
  // 每行 ~2KB，总量远超 1MB 的 chunkSize，强制行跨越多次块边界
  const rows = Array.from({ length: 1500 }, (_, i) =>
    JSON.stringify({ i, pad: "x".repeat(2000) }),
  ).join("\n");
  const { f, dir } = zstFile(rows);
  const got = [];
  await readZstdJsonl(f, (o) => {
    // 行若被截断，JSON.parse 会失败并被吞掉，这里长度对不上
    got.push(o.pad.length);
  });
  assert.equal(got.length, 1500);
  assert.ok(got.every((n) => n === 2000));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readZstdJsonl 支持字节级 filter 跳过无关行", async () => {
  const rows = [
    JSON.stringify({ type: "session_meta", cwd: "/x" }),
    JSON.stringify({ type: "message", body: "正文".repeat(500) }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
    "",
    "   ",
    JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
  ].join("\n");
  const { f, dir } = zstFile(rows);
  const filter = bytesFilter(['"token_count"', '"session_meta"']);
  const got = [];
  const res = await readZstdJsonl(f, (o) => got.push(o.type), { filter });
  assert.deepEqual(got, ["session_meta", "event_msg", "event_msg"]);
  // 空白行不计入 parsed
  assert.equal(res.parsed, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readZstdJsonl 对损坏文件抛错而不是静默返回空", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-zst-bad-"));
  const f = path.join(dir, "bad.jsonl.zst");
  fs.writeFileSync(f, Buffer.from("这不是 zstd 数据", "utf8"));
  await assert.rejects(() => readZstdJsonl(f, () => {}));
  fs.rmSync(dir, { recursive: true, force: true });
});