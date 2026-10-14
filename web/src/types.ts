/** 与后端 API 对应的类型定义 */

export interface ToolMeta {
  id: string;
  name: string;
  website: string | null;
  color: string;
  roots: string[];
  installed: boolean;
}

export interface Overview {
  requests: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  failures: number;
  active_days: number;
  models: number;
  tools: number;
  avg_latency_ms: number;
  avg_ttft_ms: number;
  sessions: number;
  data_from: string | null;
  data_to: string | null;
  cache_hit_rate: number;
  error_rate: number;
}

export interface Profile {
  totalActiveDays: number;
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  currentStreak: number;
  longestStreak: number;
  avgTokensPerDay: number;
  avgRequestsPerDay: number;
  activeDays: { day: string; requests: number; tokens: number; cost: number }[];
}

export interface SeriesPoint {
  day: string;
  requests: number;
  total_tokens: number;
  /** 新鲜输入（库里的原始值，不含缓存读） */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  /**
   * 含缓存读的 input = 新鲜输入 + 缓存读。
   * 与 CC Switch / Codex 原始日志同口径——它们的 `input_tokens` 本就含 cached。
   * 展示时优先用这个，否则同一个页面会出现两种 input 口径。
   */
  input_incl_cache: number;
  cost_usd: number;
  failures: number;
}

export interface ToolSeriesCell {
  requests: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface SeriesByToolPoint {
  day: string;
  /** 当天各工具的指标：tool -> 指标 */
  byTool: Record<string, ToolSeriesCell>;
}

export interface ModelSeries {
  model: string;
  days: Record<string, { total_tokens: number; requests: number; cost_usd: number }>;
  total_tokens: number;
  requests: number;
  cost_usd: number;
}

export interface ModelRow {
  model: string;
  provider: string;
  requests: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  failures: number;
  tool_count: number;
}

export interface ToolRow {
  tool: string;
  requests: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  cost_usd: number;
  failures: number;
  model_count: number;
  active_days: number;
}

export interface MatrixRow {
  tool: string;
  model: string;
  total_tokens: number;
  requests: number;
  cost_usd: number;
}

export interface HourRow {
  hour: number;
  requests: number;
  total_tokens: number;
  cost_usd: number;
  perMinute?: number;
}

export interface SessionRow {
  session_id: string;
  tool: string;
  started_at: number;
  ended_at: number | null;
  cwd: string | null;
  title: string | null;
  model: string | null;
  messages: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  requests: number;
}

export interface EventRow {
  event_id: string;
  tool: string;
  ts: number;
  model: string;
  provider: string | null;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
  cost_source: string | null;
  latency_ms: number;
  success: number;
  status: number | null;
  cwd: string | null;
}

/**
 * 生成速度（**主指标**）：输出 token / 活跃秒。
 *
 * 为什么不用 total_tokens：它的 94.6% 是缓存重读——agent 每轮把整个上下文
 * 重发一遍，算进去就变成「每秒十几万 token」，那测的是上下文窗口有多大，
 * 不是编码速度。本机中位数 247 tok/s，才是真实的生成吞吐。
 */
export interface RateOverall {
  /** 活跃秒数——速率按秒分桶 */
  activeSeconds: number;
  totalTokens: number;
  totalRequests: number;
  /** 去重后的输出 token 合计 */
  totalGen: number;
  /** 去重后的上下文 token 合计（新鲜输入 + 缓存读 + 缓存写） */
  totalCtx: number;
  avgPerSecond: number;
  medianPerSecond: number;
  p95PerSecond: number;
  peakPerSecond: number;
  peakAt: number | null;
  peakBreakdown: { tool: string; tokens: number }[];
  activeHours: number;
}

/**
 * 上下文吞吐（**次指标**）：新鲜输入 + 缓存读 + 缓存写，每秒。
 * 量级由上下文长度决定，界面上必须和生成速度分开标注。
 */
export interface RateContext {
  activeSeconds: number;
  avgPerSecond: number;
  medianPerSecond: number;
  p95PerSecond: number;
  peakPerSecond: number;
}

/** 按天/按小时/按工具的速率行。两个口径都给出，避免和首屏打架。 */
export interface RateBucket {
  tokens: number;
  genTokens: number;
  ctxTokens: number;
  requests: number;
  activeMinutes: number;
  /** 生成速度：输出 token / 活跃分钟。与首屏主指标同口径。 */
  genPerMinute: number;
  /** 上下文吞吐：上下文 token / 活跃分钟。 */
  ctxPerMinute: number;
}

export interface RateData {
  overall: RateOverall | null;
  context: RateContext | null;
  byDay: (RateBucket & { day: string })[];
  byHour: (RateBucket & { hour: number })[];
  byTool: (RateBucket & { tool: string })[];
  recent: { second: number; tokens: number }[];
  summary: {
    activeSeconds: number;
    totalTokens: number;
    genPerSecond: number;
    peakGenPerSecond: number;
    ctxPerSecond: number;
  };
}

/** 按 cwd 聚合的项目账单 */
export interface ProjectRow {
  cwd: string;
  requests: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  first_day: string;
  last_day: string;
  sessions: number;
  models: number;
  cache_hit_rate: number;
}

/** 会话内第 N 次请求的聚合点 */
export interface ColdStartCurvePoint {
  rn: number;
  requests: number;
  input_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  cache_hit_rate: number;
}

export interface ColdStartData {
  sessions: number;
  firstRequest: ColdStartCurvePoint | null;
  secondRequest: ColdStartCurvePoint | null;
  curve: ColdStartCurvePoint[];
  /** 首请求缓存命中率 */
  coldHitRate: number;
  /** 第 2 次请求的命中率 */
  warmHitRate: number;
  /** 冷启动溢价总额，无样本时为 null */
  coldPremiumUsd: number | null;
  coldPremiumPerSession: number | null;
  /** 缓存读相对 input 的折扣倍数 */
  discount: number;
}

/** 浪费诊断里单个项目的首轮学费 */
export interface WasteRow {
  cwd: string;
  sessions: number;
  total_tokens: number;
  cost_usd: number;
  first_input_tokens: number;
  first_cost_usd: number;
  /** 首轮学费占该项目成本的比例（%） */
  waste_share: number;
  /** 本可省下的钱（反推值，非账单） */
  waste_usd: number;
  requests_per_session: number;
  /** 该项目成本是否来自估算而非日志自带 */
  cost_source_estimated: boolean;
}

export interface WasteAdvice {
  kind: "fragmentation" | "project" | "context" | "ok";
  severity: "ok" | "mild" | "moderate" | "severe";
  /** 具体到能照着做的动作 */
  action: string;
  /** 依据哪个数字 */
  why: string;
  /** 预计省多少，无样本时为 null */
  save: number | null;
}

export interface WasteData {
  projects: number;
  sessions: number;
  /** 平均每个项目开了多少个会话。1 = 不碎，越大越碎 */
  fragmentation: number;
  total_waste_usd: number;
  rows: WasteRow[];
  discount: number;
  verdict: "ok" | "mild" | "moderate" | "severe";
  advice: WasteAdvice[];
}

/** 超出提醒线的单个会话 */
export interface GuardOverSession {
  session_id: string;
  tool: string;
  cwd: string | null;
  started_at: number;
  requests: number;
  total_tokens: number;
  cost_usd: number;
}

export interface GuardData {
  sessions: number;
  /** 中位数单会话成本——多数会话的真实量级 */
  medianUsd: number;
  /** 提醒线 = max($5 下限, P90)，跟着用户自己的历史走 */
  warnUsd: number;
  p90Usd: number;
  maxUsd: number;
  /** 最高单会话是中位数的多少倍 */
  spread: number;
  over: GuardOverSession[];
  totalOverUsd: number;
  warnFloor: number;
}

export interface PaceToolRow {
  tool: string;
  requests: number;
  total_tokens: number;
  cost_usd: number;
  /** 占当月成本的百分比 */
  share: number;
}

export interface PaceData {
  year: number;
  month: number;
  monthLabel: string;
  /** 当月截至今天已花 */
  spentUsd: number;
  /** 日均速率 */
  dailyUsd: number;
  /** 按当前速率投影到月末 */
  projectedUsd: number;
  daysElapsed: number;
  daysInMonth: number;
  /** 本月是否走完；false 时 projectedUsd 是外推估算 */
  complete: boolean;
  byTool: PaceToolRow[];
  requests: number;
}

export interface ScanRun {
  id: number;
  started_at: number;
  finished_at: number | null;
  status: string;
  files_seen: number;
  files_parsed: number;
  events_new: number;
  events_total: number;
  error: string | null;
}

export interface ScanProgress {
  running: boolean;
  stage: string;
  percent: number;
  tool?: string | null;
  toolName?: string | null;
  filesSeen?: number;
  filesParsed?: number;
  events?: number;
  toolProgress?: number;
  error?: string;
  pricingSource?: string;
}

export interface Dashboard {
  range: { from: string | null; to: string | null; tools: string[] | null };
  dataRange: { from: string | null; to: string | null; events: number };
  tools: ToolMeta[];
  overview: Overview;
  profile: Profile;
  timeseries: SeriesPoint[];
  timeseriesByTool: SeriesByToolPoint[];
  modelSeries: ModelSeries[];
  byModel: ModelRow[];
  byTool: ToolRow[];
  matrix: MatrixRow[];
  hourly: HourRow[];
  weekday: { dow: number; requests: number; total_tokens: number }[];
  rate: RateData;
  projects: ProjectRow[];
  coldStart: ColdStartData;
  waste: WasteData;
  guard: GuardData;
  pace: PaceData;
  sessions: SessionRow[];
  recentEvents: EventRow[];
  lastScan: ScanRun | null;
  pricingSource: string;
}

export interface Range {
  from?: string;
  to?: string;
  tools?: string[];
}
