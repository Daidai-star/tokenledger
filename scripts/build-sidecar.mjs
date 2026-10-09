#!/usr/bin/env node
/**
 * 桌面端 sidecar 打包。
 *
 * 产出 desktop/src-tauri/resources/sidecar/：
 *   server.mjs   —— esbuild 把 server/ 打成单文件（消掉相对 import）
 *   ui/          —— vite 构建产物
 *   runtime/     —— 目标平台的 node 二进制
 *   rt/          —— 运行时标记文件（记录这是哪个平台/架构的 node）
 *
 * 为什么不打包成单文件可执行（Node SEA）：
 * SEA 依赖 postject 注入 blob，多一个第三方构建依赖且注入失败难排查；
 * 直接分发 node 二进制 + 脚本更简单可靠，体积差别在压缩后可以忽略。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "desktop", "src-tauri", "resources", "sidecar");
// vite 的 outDir 配的是 ../dist（仓库根），见 vite.config.ts
const UI_SRC = path.join(ROOT, "dist");

/**
 * `--key value | --key=value | --flag`
 *
 * 注意必须支持 `=` 形式：CI 里写的是 `--platform=darwin --arch=x64`。
 * 之前只处理空格分隔，`--arch=x64` 会被当成整个键名 `arch=x64`，
 * 于是 args.get("arch") 返回 undefined，静默退回本机 arch——
 * 结果在 Apple Silicon 上构建 Intel 包时，sidecar 里塞进了 arm64 的 node，
 * 装到用户机器上直接崩溃。CI 的 rt.json 校验就是防这个。
 */
const args = (() => {
  const m = new Map();
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const body = a[i].slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      m.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = a[i + 1];
    if (next === undefined || next.startsWith("--")) m.set(body, true);
    else {
      m.set(body, next);
      i++;
    }
  }
  return m;
})();

/** node 官方发行包命名：node-v<version>-<platform>-<arch>.tar.gz */
function nodeArchive(version, platform, arch) {
  // darwin 的 arm64 包叫 darwin-arm64，win 的 zip 里 node.exe 在根目录
  const os_ = platform === "win32" ? "win" : platform;
  return `node-v${version}-${os_}-${arch}.tar.gz`;
}

function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) return dest;
  console.log(`  下载 ${url}`);
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", dest, url], { stdio: ["ignore", "ignore", "inherit"] });
  return dest;
}

async function main() {
  const skipNode = args.get("skip-node") === true;
  const platform = args.get("platform") || process.platform;
  const arch = args.get("arch") || process.arch;

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // ---- 1. 前端产物 ----
  if (!fs.existsSync(path.join(UI_SRC, "index.html"))) {
    console.error(`找不到前端构建产物 ${UI_SRC}，请先 npm run build`);
    process.exit(1);
  }
  fs.cpSync(UI_SRC, path.join(OUT, "ui"), { recursive: true });
  console.log(`✓ ui/ (${countFiles(path.join(OUT, "ui"))} 个文件)`);

  // ---- 2. 后端打成单文件 ----
  const esbuild = path.join(ROOT, "node_modules", ".bin", "esbuild");
  if (!fs.existsSync(esbuild)) {
    console.error("缺少 esbuild，请先 npm install");
    process.exit(1);
  }
  execFileSync(
    esbuild,
    [
      path.join(ROOT, "server", "index.js"),
      "--bundle",
      "--platform=node",
      "--target=node22",
      "--format=esm",
      "--outfile=" + path.join(OUT, "server.mjs"),
      // 内置模块保持外部引用，别让 esbuild 去 polyfill
      "--external:node:*",
      "--banner:js=import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const kb = Math.round(fs.statSync(path.join(OUT, "server.mjs")).size / 1024);
  console.log(`✓ server.mjs (${kb} KB)`);

  // ---- 3. Node 运行时 ----
  if (skipNode) {
    console.log("- 跳过 node 运行时（用系统已装的 node，开发时用）");
    return;
  }
  const version = process.versions.node;
  const isWin = platform === "win32";
  const ext = isWin ? "zip" : "tar.gz";
  const file = nodeArchive(version, platform, arch).replace(/\.tar\.gz$/, `.${ext}`);
  const url = `https://nodejs.org/dist/v${version}/${file}`;
  const tmp = path.join(os.tmpdir(), `tokenledger-node-${version}-${platform}-${arch}.${ext}`);
  download(url, tmp);

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "tl-node-"));
  try {
    if (isWin) {
      execFileSync("unzip", ["-q", "-o", tmp, "-d", stage], { stdio: "ignore" });
      const inner = fs
        .readdirSync(stage)
        .find((d) => fs.statSync(path.join(stage, d)).isDirectory());
      fs.copyFileSync(path.join(stage, inner, "node.exe"), path.join(OUT, "runtime", "node.exe"));
    } else {
      execFileSync("tar", ["-xzf", tmp, "-C", stage], { stdio: "ignore" });
      const inner = fs
        .readdirSync(stage)
        .find((d) => fs.statSync(path.join(stage, d)).isDirectory());
      fs.mkdirSync(path.join(OUT, "runtime"), { recursive: true });
      fs.copyFileSync(path.join(stage, inner, "bin", "node"), path.join(OUT, "runtime", "node"));
      fs.chmodSync(path.join(OUT, "runtime", "node"), 0o755);
    }
    const mb = (fs.statSync(path.join(OUT, "runtime", isWin ? "node.exe" : "node")).size / 1048576).toFixed(0);
    console.log(`✓ runtime/node${isWin ? ".exe" : ""} (Node ${version}, ${mb} MB)`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  // ---- 4. 运行时标记：Rust 侧靠它判断该执行哪个文件名 ----
  fs.writeFileSync(
    path.join(OUT, "rt.json"),
    JSON.stringify({ node: process.versions.node, platform, arch, binary: isWin ? "node.exe" : "node" }, null, 2),
  );
  console.log("✓ rt.json");
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});