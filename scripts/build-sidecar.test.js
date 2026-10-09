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
import os from "node:os";
import path from "node:path";

/**
 * 行尾必须先归一化：Windows runner 上 actions/checkout 会把 LF 转成 CRLF，
 * 直接按 `\n` 匹配正则会全部落空（v0.1.0 的 Windows 构建就是这么挂的）。
 */
function readScript() {
  return fs
    .readFileSync(new URL("./build-sidecar.mjs", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n");
}
const src = readScript();
/** 同一份源码但用 CRLF 行尾，用来验证上面的归一化确实必要且有效 */
const srcCRLF = readScript().replace(/\n/g, "\r\n");

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

// ------------------------------------------- 在解压目录里定位 node 可执行文件

/**
 * 这段逻辑出过两次事故，都只在 Windows 上暴露：
 *  1. 假设「版本目录 / node.exe」是固定结构 → Expand-Archive 落盘对不上就 ENOENT
 *  2. 改成递归查找后，用 basename 匹配存在性、却按相对路径 join
 *     → macOS 的 bin/node 永远找不到
 *
 * 下面用**真实的官方归档目录结构**造样本（不下载，避免测试依赖网络）：
 *  - Windows: node-v24.21.0-win-x64/node.exe（扁平）
 *  - Unix:    node-v24.13.1-darwin-arm64/bin/node（多一层 bin）
 * 另外塞几个干扰项（node_modules、嵌套同名文件）确保优先级正确。
 */
function loadFinder(source = src) {
  // 归一化必须在 loader 内部做，放调用方会被 CRLF 源码绕过去
  const norm = source.replace(/\r\n/g, "\n");
  const m = norm.match(
    /function findNodeBinary[\s\S]*?\n {2}return hits\.length \? hits\[0\]\.abs : null;\n\}/,
  );
  assert.ok(m, "没找到 findNodeBinary，脚本结构可能变了");
  return eval(`(${m[0]})`);
}
const findNodeBinary = loadFinder();
const norm = (p) => (p ? p.split(path.sep).join("/") : p);

function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-tree-"));
  for (const [rel, size] of Object.entries(spec)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size, 1));
  }
  return root;
}

const WIN_TREE = {
  "node-v24.21.0-win-x64/node.exe": 93580104,
  "node-v24.21.0-win-x64/README.md": 100,
  "node-v24.21.0-win-x64/node_modules/corepack/package.json": 50,
  "node-v24.21.0-win-x64/npm.cmd": 700,
};

const UNIX_TREE = {
  "node-v24.13.1-darwin-arm64/bin/node": 116000000,
  "node-v24.13.1-darwin-arm64/README.md": 100,
  "node-v24.13.1-darwin-arm64/lib/node_modules/npm/bin/node-cli.js": 50,
};

test("Windows 归档结构：找到版本目录下的 node.exe", () => {
  const dir = makeTree(WIN_TREE);
  const hit = norm(findNodeBinary(dir, true));
  assert.match(hit, /node-v[\d.]+-win-x64\/node\.exe$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Unix 归档结构：找到 bin/node，而不是版本目录下的别的文件", () => {
  const dir = makeTree(UNIX_TREE);
  const hit = norm(findNodeBinary(dir, false));
  assert.ok(hit.endsWith("/bin/node"), `应命中 bin/node，实际 ${hit}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("不会误取 node_modules 里的文件", () => {
  const dir = makeTree({
    "node-v1-linux-x64/node_modules/npm/bin/node": 50,
    "node-v1-linux-x64/README.md": 10,
  });
  // 只有 node_modules 里有同名文件时不应命中
  assert.equal(findNodeBinary(dir, false), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("平台不匹配时返回 null（不会把 macOS 的 node 打进 Windows 包）", () => {
  const win = makeTree(WIN_TREE);
  const unix = makeTree(UNIX_TREE);
  assert.equal(findNodeBinary(unix, true), null, "Unix 树里没有 node.exe");
  assert.equal(findNodeBinary(win, false), null, "Windows 树里没有裸 node");
  fs.rmSync(win, { recursive: true, force: true });
  fs.rmSync(unix, { recursive: true, force: true });
});

test("目录不存在时返回 null 而不是抛错", () => {
  assert.equal(findNodeBinary("/nonexistent/tl/xyz", false), null);
  assert.equal(findNodeBinary("/nonexistent/tl/xyz", true), null);
});

test("源码是 CRLF 行尾时也能正常解析（Windows runner 会转换行尾）", () => {
  // loader 内部若不做归一化，正则里的 \n 在 \r\n 里就匹配不上
  const find = loadFinder(srcCRLF);
  const dir = makeTree(WIN_TREE);
  const hit = norm(find(dir, true));
  assert.match(hit, /win-x64\/node\.exe$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("参数解析同样不受行尾影响", () => {
  const norm = srcCRLF.replace(/\r\n/g, "\n");
  const m = norm.match(/const args = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
  assert.ok(m, "CRLF 源码里找不到参数解析器");
  const fnSrc = m[0].slice("const args = ".length).replace(/\(\)\s*;?\s*$/, "");
  const parse = eval(fnSrc);
  const saved = process.argv;
  process.argv = ["node", "build-sidecar.mjs", "--arch=x64"];
  try {
    assert.equal(parse().get("arch"), "x64");
  } finally {
    process.argv = saved;
  }
});
