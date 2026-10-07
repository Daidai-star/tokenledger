/**
 * 采集器注册表。
 *
 * 新增一个统计源只需要：写一个实现 Collector 契约的文件，
 * 在这里 import 并加入 ALL。存储、聚合、API、前端都无需改动。
 */

import fs from "node:fs";
import { codex } from "./codex.js";
import { claudeCode } from "./claude-code.js";
import { opencode } from "./opencode.js";
import { dsh } from "./dsh.js";
import { gemini } from "./gemini.js";

export const ALL = [codex, claudeCode, opencode, dsh, gemini];

export function getCollector(id) {
  return ALL.find((c) => c.id === id) || null;
}

/** 当前机器上检测到哪些工具 */
export function detectInstalled() {
  return ALL.map((c) => {
    let installed = false;
    try {
      installed = c.detect() && c.roots.some((r) => fs.existsSync(r));
    } catch {
      installed = false;
    }
    return {
      id: c.id,
      name: c.name,
      website: c.website,
      color: c.color,
      roots: c.roots,
      installed,
    };
  });
}