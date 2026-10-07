/**
 * 统一的成本估算层。
 *
 * 数据源优先级：
 *   1. 日志自带成本（如 OpenCode 的 cost 字段）——最准，直接采用
 *   2. 本地 model-pricing 表（~/.cc-switch/model-pricing.json，与 cc Switch 同源）
 *   3. 内置兜底价目表
 *
 * 定价单位：USD / 每百万 token。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 兜底价目表（USD / 1M tokens）：[input, output, cacheRead, cacheWrite] */
const FALLBACK_PRICING = {
  "gpt-5-codex": [1.25, 10, 0.125, 0],
  "gpt-5": [1.25, 10, 0.125, 0],
  "gpt-5-mini": [0.25, 2, 0.025, 0],
  "gpt-5-nano": [0.05, 0.4, 0.005, 0],
  "gpt-4.1": [2, 8, 0.5, 0],
  "gpt-4o": [2.5, 10, 1.25, 0],
  o3: [2, 8, 0.5, 0],
  "o4-mini": [1.1, 4.4, 0.275, 0],
  "claude-opus-4": [15, 75, 1.5, 18.75],
  "claude-sonnet-4": [3, 15, 0.3, 3.75],
  "claude-haiku-4": [0.8, 4, 0.08, 1],
  "deepseek-chat": [0.27, 1.1, 0.07, 0],
  "deepseek-reasoner": [0.55, 2.19, 0.14, 0],
  "gemini-2.5-pro": [1.25, 10, 0.31, 0],
  "gemini-2.5-flash": [0.3, 2.5, 0.075, 0],
};

/**
 * 家族兜底规则。
 *
 * 本机常见的模型名带内部代号（gpt-6-luna / claude-opus-5 / deepseek-v4.1-flash），
 * 这些是网关侧的自定义命名，没有公开价目。逐个列进FALLBACK_PRICING 会过时，
 * 所以按「家族」匹配到最接近的公开价目，并在 cost_source 里标为 family，
 * 让人知道这是估算而非准确报价。
 */
const FAMILY_RULES = [
  // OpenAI GPT：gpt-6 / gpt-5.6 等按旗舰档估
  [/^gpt-\d/, "gpt-5"],
  [/^o\d/, "o3"],
  // Anthropic：按 opus/sonnet/haiku 分档
  [/^claude-opus/, "claude-opus-4"],
  [/^claude-sonnet/, "claude-sonnet-4"],
  [/^claude-haiku/, "claude-haiku-4"],
  [/^claude-/, "claude-sonnet-4"],
  // DeepSeek：flash 走 chat 档，reasoner 走推理档
  [/^deepseek.*(reason|r1)/, "deepseek-reasoner"],
  [/^deepseek/, "deepseek-chat"],
  // Google
  [/^gemini.*flash/, "gemini-2.5-flash"],
  [/^gemini/, "gemini-2.5-pro"],
];

/** 把具体模型名归一到某个已知价目键 */
function normalizeKey(model) {
  if (!model) return null;
  const m = String(model).toLowerCase().replace(/^[\w.-]+\//, "");
  if (FALLBACK_PRICING[m]) return { key: m, via: "exact" };

  // 最长前缀匹配，避免 "claude-sonnet-4-5-20250929" 这类版本后缀失配
  let best = null;
  for (const key of Object.keys(FALLBACK_PRICING)) {
    if (m.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  if (best) return { key: best, via: "prefix" };

  // 家族兜底
  for (const [re, key] of FAMILY_RULES) {
    if (re.test(m) && FALLBACK_PRICING[key]) return { key, via: "family" };
  }
  return null;
}

export class PricingTable {
  constructor(entries = {}) {
    this.entries = entries;
    this.source = "fallback";
  }

  /** 从 cc-switch 的 model-pricing.json 加载（若存在） */
  static load() {
    const candidates = [
      path.join(os.homedir(), ".cc-switch", "model-pricing.json"),
      path.join(os.homedir(), ".tokenledger", "model-pricing.json"),
    ];
    for (const file of candidates) {
      try {
        if (!fs.existsSync(file)) continue;
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        const entries = {};
        // 兼容多种可能的结构：{model: {...}} 或 {models:[...]} 或数组
        const rows = Array.isArray(raw)
          ? raw
          : Array.isArray(raw.models)
            ? raw.models
            : Object.entries(raw).map(([id, v]) => ({ id, ...v }));
        for (const row of rows) {
          const id = row.id || row.model || row.name;
          if (!id) continue;
          entries[String(id).toLowerCase()] = {
            input: num(row.input ?? row.input_price ?? row.prompt),
            output: num(row.output ?? row.output_price ?? row.completion),
            cacheRead: num(row.cacheRead ?? row.cache_read ?? row.cacheReadPrice ?? row.cache_read_input),
            cacheWrite: num(
              row.cacheWrite ?? row.cache_write ?? row.cacheCreation ?? row.cache_creation,
            ),
          };
        }
        if (Object.keys(entries).length) {
          return new PricingTable(entries);
        }
      } catch {
        // 忽略损坏文件，退回内置表
      }
    }
    return new PricingTable();
  }

  lookup(model) {
    if (!model) return null;
    const key = String(model).toLowerCase().replace(/^[\w.-]+\//, "");
    if (this.entries[key]) return { key, source: "cc-switch", ...this.entries[key] };
    // 去掉版本后缀再试
    const stripped = key.replace(/[-.]?(\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/, "");
    if (this.entries[stripped]) return { key: stripped, source: "cc-switch", ...this.entries[stripped] };
    const fb = normalizeKey(key);
    if (fb) {
      const [input, output, cacheRead, cacheWrite] = FALLBACK_PRICING[fb.key];
      // family 是估算档，标注出来便于用户判断可信度
      return {
        key: fb.key,
        source: fb.via === "family" ? "builtin~est" : "builtin",
        input,
        output,
        cacheRead,
        cacheWrite,
      };
    }
    return null;
  }

  /**
   * 计算一次请求的成本（USD）。
   * @returns {{usd: number|null, source: string, matched: string|null}}
   */
  price(event) {
    // 优先采信日志自带的成本（OpenCode / dsh 会直接给）
    if (event.costUsd != null && Number.isFinite(event.costUsd)) {
      return { usd: event.costUsd, source: "reported", matched: event.model };
    }
    const p = this.lookup(event.model);
    if (!p) return { usd: null, source: "unknown", matched: null };

    const per = (t) => t / 1_000_000;
    let usd = 0;
    // 归一化后 event.inputTokens 已是「新鲜输入」，缓存部分由 cacheRead/cacheWrite 单独计价，
    // 不再从 input 里扣（否则会重复扣减）。
    const billableInput = Math.max(0, event.inputTokens - event.cacheWriteTokens);
    usd += per(billableInput) * p.input;
    usd += per(event.outputTokens) * p.output;
    usd += per(event.cacheReadTokens) * (p.cacheRead || p.input * 0.1);
    usd += per(event.cacheWriteTokens) * (p.cacheWrite || p.input * 1.25);
    return { usd: Number(usd.toFixed(8)), source: p.source, matched: p.key };
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}