/**
 * TokenLedger 统一用量事件模型。
 *
 * 所有 collector 负责把自己的原始日志归一化成 UsageEvent，
 * 上层（存储、聚合、可视化）只认这个结构。
 *
 * 字段缺失一律用 0 而不是 null，避免下游做 null 判断。
 */

/** 单次 LLM 请求的归一化事件 */
export class UsageEvent {
  constructor(init) {
    /** 稳定唯一键：用于幂等写入（同一请求重复扫描不重复计数） */
    this.id = init.id;
    /** 工具 id：codex / claude-code / opencode / dsh / ... */
    this.tool = init.tool;
    /** 事件时间（epoch ms，UTC） */
    this.ts = init.ts;
    /** 会话 id（同一轮对话） */
    this.sessionId = init.sessionId || null;
    /** 工作区 / 项目目录 */
    this.cwd = init.cwd || null;
    /** 模型展示名 */
    this.model = init.model || "unknown";
    /** 上游供应商（openai / anthropic / deepseek / ...），未知的留 null */
    this.provider = init.provider || null;
    /** 请求协议：responses / messages / chat-completions */
    this.protocol = init.protocol || null;

    // ---- token 维度 ----
    /** 输入 token 总数（含缓存部分，口径见 README） */
    this.inputTokens = num(init.inputTokens);
    /** 输出 token 总数 */
    this.outputTokens = num(init.outputTokens);
    /** 缓存命中（读取）token */
    this.cacheReadTokens = num(init.cacheReadTokens);
    /** 缓存写入 token */
    this.cacheWriteTokens = num(init.cacheWriteTokens);
    /** 推理 / thinking token（可能是 output 的子集） */
    this.reasoningTokens = num(init.reasoningTokens);

    // ---- 质量维度 ----
    this.status = init.status ?? 200;
    this.success = init.success === false ? 0 : 1;
    this.latencyMs = num(init.latencyMs);
    this.ttftMs = num(init.ttftMs);

    // ---- 成本维度（能拿到就填） ----
    this.costUsd = init.costUsd == null ? null : Number(init.costUsd);

    // ---- 展示维度 ----
    /** 客户端形态：cli / ide / desktop / web */
    this.surface = init.surface || null;
    this.originator = init.originator || null;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 计价结果
 */
export class PricedEvent {
  constructor(event, costUsd, priceSource) {
    this.event = event;
    this.costUsd = costUsd;
    this.priceSource = priceSource;
  }
}

/**
 * collector 契约。
 * 新增统计源只需实现这个接口并加入 registry，UI 与聚合层无需改动。
 */
export class Collector {
  constructor(spec) {
    /** 稳定 id，例如 "codex" */
    this.id = spec.id;
    /** 展示名 */
    this.name = spec.name;
    /** 官网/文档 */
    this.website = spec.website || null;
    /** 主题色，UI 用 */
    this.color = spec.color || "#7c9cff";
    /** 采集根目录（可多个） */
    this.roots = spec.roots || [];
    /** 该工具是否本地可检测存在 */
    this.detect = spec.detect || (() => true);
    /**
     * 执行增量采集。
     * @param {object} ctx  { home, cursorStore, pricing, since, onProgress }
     * @returns {Promise<{events: UsageEvent[], stats: object}>}
     */
    this.scan = spec.scan;
    /** 可选：取该工具的"档案"信息，用于 profile 展示 */
    this.profile = spec.profile || null;
  }
}