#!/usr/bin/env node
/**
 * 命令行入口：不开服务也能扫数据、导出 JSON。
 *
 *   node server/cli.js scan            # 扫描并写入 ~/.tokenledger/tokenledger.db
 *   node server/cli.js scan --tool codex
 *   node server/cli.js reset           # 清库重扫
 *   node server/cli.js stats           # 打印总览
 *   node server/cli.js export out.json # 导出 dashboard 数据
 */

import path from "node:path";
import os from "node:os";
import { Store } from "./store.js";
import { Scanner } from "./scanner.js";
import { Queries } from "./queries.js";
import fs from "node:fs";

const DATA_DIR = process.env.TOKENLEDGER_DATA || path.join(os.homedir(), ".tokenledger");
const DB_FILE = path.join(DATA_DIR, "tokenledger.db");

const [, , cmd = "scan", ...rest] = process.argv;
const args = rest.reduce((acc, cur, i) => {
  if (cur.startsWith("--")) acc[cur.slice(2)] = rest[i + 1]?.startsWith("--") ? true : rest[i + 1];
  return acc;
}, {});

const store = new Store(DB_FILE);
const scanner = new Scanner(store);
const queries = new Queries(store);

function bar(percent, stage) {
  const width = 28;
  const filled = Math.round((percent / 100) * width);
  process.stdout.write(
    `\r[${stage.padEnd(11)}] ${"█".repeat(filled)}${"░".repeat(width - filled)} ${String(Math.round(percent)).padStart(3)}%`,
  );
}

async function main() {
  switch (cmd) {
    case "scan": {
      const tools = args.tool ? String(args.tool).split(",") : undefined;
      const r = await scanner.run({
        tools,
        onProgress: (p) => {
          bar(p.percent, p.toolName || p.stage);
          if (p.stage === "done") process.stdout.write("\n");
        },
      });
      console.log(
        `\n扫描完成：文件 ${r.filesParsed}/${r.filesSeen}，新增事件 ${r.eventsNew}，库内共 ${store.dataRange().events} 条`,
      );
      printStats();
      break;
    }
    case "reset": {
      const r = await scanner.reset();
      console.log(`重扫完成，新增事件 ${r.eventsNew}`);
      printStats();
      break;
    }
    case "stats": {
      printStats();
      break;
    }
    case "export": {
      const out = args._?.[0] || "tokenledger-export.json";
      const payload = {
        generatedAt: new Date().toISOString(),
        dataRange: store.dataRange(),
        tools: scanner.tools(),
        overview: queries.overview({}),
        profile: queries.profile({}),
        timeseries: queries.timeseries({}),
        byModel: queries.byModel({ limit: 50 }),
        byTool: queries.byTool({}),
      };
      fs.writeFileSync(out, JSON.stringify(payload, null, 2));
      console.log(`已导出到 ${out}`);
      break;
    }
    default:
      console.log("用法: node server/cli.js <scan|reset|stats|export> [--tool a,b] [file]");
      process.exitCode = 1;
  }
  store.close();
}

function printStats() {
  const o = queries.overview({});
  console.log("\n── 总览 ──────────────────────────────");
  console.log(`时间范围     ${o.data_from || "—"} → ${o.data_to || "—"}`);
  console.log(`请求数       ${fmt(o.requests)}`);
  console.log(`总 token     ${fmt(o.total_tokens)}  (in ${fmt(o.input_tokens)} / out ${fmt(o.output_tokens)})`);
  console.log(`缓存读/写    ${fmt(o.cache_read_tokens)} / ${fmt(o.cache_write_tokens)}   命中率 ${o.cache_hit_rate}%`);
  console.log(`推理 token   ${fmt(o.reasoning_tokens)}`);
  console.log(`预估成本     $${Number(o.cost_usd || 0).toFixed(4)}  [定价源 ${scanner.pricing.source}]`);
  console.log(`活跃天数     ${o.active_days}   连续 ${queries.profile({}).currentStreak} 天`);
  console.log(`工具/模型    ${o.tools} / ${o.models}`);

  console.log("\n── 按工具 ────────────────────────────");
  for (const r of queries.byTool({})) {
    console.log(
      `${r.tool.padEnd(12)} ${fmt(r.requests).padStart(8)} req  ${fmt(r.total_tokens).padStart(14)} tok  $${Number(r.cost_usd).toFixed(3)}`,
    );
  }

  console.log("\n── 按模型 Top 10 ──────────────────────");
  for (const r of queries.byModel({ limit: 10 })) {
    console.log(
      `${r.model.padEnd(34)} ${fmt(r.total_tokens).padStart(14)} tok  ${String(r.requests).padStart(6)} req  $${Number(r.cost_usd).toFixed(3)}`,
    );
  }
}

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(v);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});