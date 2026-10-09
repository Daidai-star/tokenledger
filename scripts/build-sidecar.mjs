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

/**
 * 下载 Node 发行包。
 *
 * 用 Node 内置 fetch 而不是 curl：curl 在 macOS/Linux 上都有，
 * Windows 10 1803+ 也自带，但版本与可用性依赖镜像环境；
 * fetch 走的是 Node 自己的网络栈，三个平台行为一致。
 * 顺带在本地也不会因为缺 curl 而失败。
 */
async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) return dest;
  console.log(`  下载 ${url}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    } catch (err) {
      if (attempt === 3) {
        console.error(`下载失败（重试 3 次仍不成功）：${url}`);
        throw err;
      }
      console.warn(`  第 ${attempt} 次失败：${err.message}，重试…`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return dest;
}

/**
 * 解压到 stage。
 *
 * Windows 分支必须用 PowerShell 的 Expand-Archive：`unzip` 在 Windows 上
 * 并不存在（curl 和 tar 有，unzip 没有），写成 execFileSync("unzip", ...)
 * 会在 Windows 构建时 ENOENT —— 本地是 macOS 测不出来，只有 CI 能发现。
 */
function extract(archive, stage, isWin) {
  if (isWin) {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${stage}' -Force`,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    return;
  }
  // .tar.gz 用 tar；若是 .zip 也交给 tar（bsdtar 支持）
  execFileSync("tar", ["-xf", archive, "-C", stage], { stdio: ["ignore", "ignore", "inherit"] });
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
  // 用 esbuild 的 JS API，而不是 execFileSync 调 node_modules/.bin/esbuild：
  // .bin 下那个文件在 Windows 上是 shell 脚本，真正可执行的是 esbuild.cmd，
  // spawnSync 直接找无扩展名的那个会 ENOENT。JS API 由 esbuild 自己解析
  // 平台对应的二进制，跨平台无差异。
  const esbuildPath = path.join(ROOT, "server", "index.js");
  const outFile = path.join(OUT, "server.mjs");
  try {
    const esbuild = await import("esbuild");
    await esbuild.build({
      entryPoints: [esbuildPath],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      outfile: outFile,
      // 内置模块保持外部引用，别让 esbuild 去 polyfill
      external: ["node:*"],
      banner: {
        js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
      },
      logLevel: "warning",
    });
  } catch (err) {
    console.error("esbuild 打包失败：", err?.message || err);
    process.exit(1);
  }
  const kb = Math.round(fs.statSync(outFile).size / 1024);
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
  await download(url, tmp);

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "tl-node-"));
  try {
    extract(tmp, stage, isWin);
    if (isWin) {
      const inner = fs
        .readdirSync(stage)
        .find((d) => fs.statSync(path.join(stage, d)).isDirectory());
      fs.copyFileSync(path.join(stage, inner, "node.exe"), path.join(OUT, "runtime", "node.exe"));
    } else {
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