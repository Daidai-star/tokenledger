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
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
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

export interface RateOverall {
  activeMinutes: number;
  totalMinutes: number;
  totalTokens: number;
  totalRequests: number;
  avgPerMinute: number;
  medianPerMinute: number;
  p95PerMinute: number;
  peakPerMinute: number;
  peakAt: number | null;
  peakBreakdown: { tool: string; tokens: number }[];
  activeHours: number;
}

export interface RateData {
  overall: RateOverall | null;
  byDay: { day: string; tokens: number; requests: number; activeMinutes: number; perMinute: number }[];
  byHour: { hour: number; tokens: number; requests: number; activeMinutes: number; perMinute: number }[];
  byTool: { tool: string; tokens: number; requests: number; activeMinutes: number; perMinute: number }[];
  recent: { minute: number; tokens: number }[];
  summary: { activeMinutes: number; totalTokens: number; avgPerMinute: number; peakPerMinute: number };
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