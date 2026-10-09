/**
 * build-sidecar 参数解析的回归测试。
 *
 * 背景：解析器最初只支持 `--key value`，CI 里写的 `--arch=x64` 被当成
 * 整个键名 `arch=x64`，于是 args.get("arch") 返回 undefined 并静默退回
 * 本机架构。后果是：在 Apple Silicon runner 上构建 Intel 包时，sidecar 里
 * 塞进了 arm64 的 node，装到 Intel 用户机器上直接崩溃。
 *
 * 这类「参数没生效但不报错」的 bug 只能靠测试兜住，所以把契约写死在这里。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("./build-sidecar.mjs", import.meta.url), "utf8");

/**
 * 抽出脚本里的解析器，避免真的去下载 Node 运行时。
 *
 * 解析器读的是 `process.argv`，所以调用时要临时替换它——顺便保证每个用例
 * 看到的 argv 是确定的，不受 `node --test` 自身参数影响。
 */
function loadParser() {
  const body = src.match(/const args = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
  assert.ok(body, "没找到参数解析器，脚本结构可能变了");
  // 剥掉 `const args = ` 前缀与结尾的 IIFE 调用，得到箭头函数本体
  const fnSrc = body[0].slice("const args = ".length).replace(/\(\)\s*;?\s*$/, "");
  return eval(fnSrc);
}

const parse = loadParser();
const realArgv = process.argv;

function argsOf(argv) {
  process.argv = ["node", "build-sidecar.mjs", ...argv];
  try {
    return parse();
  } finally {
    process.argv = realArgv;
  }
}

test("--arch=x64 能解析出 x64（CI 依赖这个形式）", () => {
  assert.equal(argsOf(["--arch=x64"]).get("arch"), "x64");
});

test("--platform=win32 能解析出 win32", () => {
  assert.equal(argsOf(["--platform=win32"]).get("platform"), "win32");
});

test("--key value 空格形式仍然可用", () => {
  const a = argsOf(["--platform", "darwin", "--arch", "x64"]);
  assert.equal(a.get("platform"), "darwin");
  assert.equal(a.get("arch"), "x64");
});

test("裸 flag 解析为 true", () => {
  assert.equal(argsOf(["--skip-node"]).get("skip-node"), true);
});

test("flag 后紧跟另一个 flag 不会被误吞", () => {
  const a = argsOf(["--skip-node", "--arch=x64"]);
  assert.equal(a.get("skip-node"), true);
  assert.equal(a.get("arch"), "x64", "前一个 flag 不能吃掉后面的参数");
});

test("值里含等号不截断", () => {
  assert.equal(argsOf(["--x=a=b"]).get("x"), "a=b");
});

test("空参数不抛错", () => {
  assert.equal(argsOf([]).size, 0);
});

test("多组参数共存", () => {
  const a = argsOf(["--platform=darwin", "--arch=arm64", "--skip-node"]);
  assert.equal(a.get("platform"), "darwin");
  assert.equal(a.get("arch"), "arm64");
  assert.equal(a.get("skip-node"), true);
});
