import { Children, isValidElement, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityHeatmap,
  CompositionBar,
  DonutChart,
  HourBars,
  RankBars,
  RateSpark,
  TokenBreakdown,
  ToolModelMatrix,
  TrendChart,
} from "./components/Charts";
import {
  ColdStartSection,
  GuardSection,
  InsightStrip,
  PaceSection,
  ProjectSection,
  WasteSection,
} from "./components/Insights";
import { MallSection } from "./components/Mall";
import { Reveal, RevealGroup } from "./reveal";
import { TABS, sectionsInTab } from "./sections";
import ScanFlow from "./components/ScanFlow";
import { fetchDashboard, triggerReset, triggerScan } from "./api";
import type { Dashboard, Range, ScanProgress, ToolMeta, ToolSeriesCell } from "./types";
import {
  bareModel,
  fmtAgo,
  fmtCost,
  fmtDateFull,
  fmtInt,
  fmtMs,
  fmtTime,
  modelColor,
  shortPath,
  tokens,
} from "./format";

/** 数字滚动动画 */
function useCountUp(value: number, ms = 650) {
  const [display, setDisplay] = useState(value);
  const from = useRef(value);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    const b = value;
    if (a === b) return;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      setDisplay(a + (b - a) * e);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else from.current = b;
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      from.current = value;
    };
  }, [value, ms]);
  return display;
}

function Metric({
  label,
  value,
  sub,
  delay = 0,
}: {
  label: string;
  value: string;
  sub?: string;
  delay?: number;
}) {
  return (
    <div className="stat" style={{ animationDelay: `${delay}ms` }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** Codex profile 风格的档案头 */
function ProfileHeader({ data }: { data: Dashboard }) {
  const { profile, overview } = data;
  const streak = useCountUp(profile.currentStreak);
  const hour = new Date().getHours();
  const greet = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  const byToolId = useMemo(
    () => new Map(data.byTool.map((r) => [r.tool, r])),
    [data.byTool],
  );
  const active = data.tools.filter((t) => byToolId.has(t.id));

  // 身份环：外环 = 当前连续 / 最长连续，内环 = 平均强度占比
  const C = 2 * Math.PI * 80;
  const longest = Math.max(1, profile.longestStreak);
  const outer = Math.min(1, profile.currentStreak / 30);
  const inner = Math.min(1, profile.avgRequestsPerDay / 60);

  return (
    <section className="profile">
      <div className="profile-mark">
        <svg viewBox="0 0 172 172">
          <circle cx="86" cy="86" r="80" className="ring-bg" />
          <circle
            cx="86"
            cy="86"
            r="80"
            className="ring-fg"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - outer)}
          />
          <circle
            cx="86"
            cy="86"
            r="68"
            className="ring-inner"
            strokeDasharray={2 * Math.PI * 68}
            strokeDashoffset={2 * Math.PI * 68 * (1 - inner)}
          />
        </svg>
        <div className="profile-mark-inner">
          <div className="profile-initial">{streak.toFixed(0)}</div>
          <div className="profile-initial-label">连续天数</div>
        </div>
      </div>

      <div className="profile-body">
        <div className="profile-eyebrow">{greet}</div>
        <h1 className="profile-title">本机 Coding 用量</h1>
        <p className="profile-lede">
          汇总 {active.length} 个 AI 编程工具在 {profile.totalActiveDays} 个活跃日里的模型调用——
          累计 {tokens(overview.total_tokens)} token，预估成本 {fmtCost(overview.cost_usd)}，
          涉及 {overview.models} 个模型。
        </p>

        <dl className="profile-facts">
          <div className="profile-fact">
            <dt>累计 Token</dt>
            <dd>{tokens(profile.totalTokens)}</dd>
          </div>
          <div className="profile-fact">
            <dt>请求</dt>
            <dd>{fmtInt(profile.totalRequests)}</dd>
          </div>
          <div className="profile-fact">
            <dt>会话</dt>
            <dd>{fmtInt(overview.sessions)}</dd>
          </div>
          <div className="profile-fact">
            <dt>最长连续</dt>
            <dd>
              {profile.longestStreak}
              <small>天 / 共 {longest}</small>
            </dd>
          </div>
        </dl>

        <div className="profile-tools">
          {active.map((t) => {
            const row = byToolId.get(t.id)!;
            return (
              <span key={t.id} className="profile-tool">
                <span className="dot" style={{ background: t.color }} />
                {t.name}
                <em>{tokens(row.total_tokens)}</em>
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Toolbar({
  range,
  setRange,
  tools,
  byTool,
}: {
  range: Range;
  setRange: (r: Range) => void;
  tools: ToolMeta[];
  byTool: { tool: string; total_tokens: number }[];
}) {
  const tokenByTool = useMemo(
    () => new Map(byTool.map((r) => [r.tool, r.total_tokens])),
    [byTool],
  );

  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const presets = [
    { label: "7 天", days: 7 },
    { label: "30 天", days: 30 },
    { label: "90 天", days: 90 },
    { label: "全部", days: 0 },
  ];

  const toggleTool = (id: string) => {
    const cur = range.tools || [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setRange({ ...range, tools: next.length === tools.length ? undefined : next });
  };

  return (
    <div className="toolbar">
      <div className="tb-group">
        <span className="tb-label">范围</span>
        <div className="segmented">
          {presets.map((p) => {
            const active = p.days === 0 ? !range.from : range.from === daysAgo(p.days);
            return (
              <button
                key={p.label}
                className={active ? "on" : ""}
                onClick={() => setRange({ ...range, from: p.days === 0 ? undefined : daysAgo(p.days) })}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="tb-group">
        <span className="tb-label">工具</span>
        {tools.map((t) => {
          const on = !range.tools?.length || range.tools.includes(t.id);
          const amt = tokenByTool.get(t.id);
          return (
            <button
              key={t.id}
              className={`filter-pill${on ? " on" : ""}`}
              onClick={() => toggleTool(t.id)}
              title={t.roots[0]}
            >
              <span className="dot" style={{ background: t.color, opacity: on ? 1 : 0.35 }} />
              {t.name}
              {amt != null && amt > 0 && <em>{tokens(amt)}</em>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Token 速率区块 */
function RateSection({ data }: { data: Dashboard }) {
  const r = data.rate;
  if (!r.overall || !r.context) return null;
  const o = r.overall;
  const c = r.context;
  const toolName = (id: string) => data.tools.find((t) => t.id === id)?.name || id;
  const toolColor = (id: string) => data.tools.find((t) => t.id === id)?.color || "var(--ink-3)";
  const bestHour = r.byHour.reduce(
    (best, h) => (h.genPerMinute > (best?.genPerMinute ?? 0) ? h : best),
    null as typeof r.byHour[number] | null,
  );
  const bestDayData = r.byDay.reduce(
    (best, d) => (d.genPerMinute > (best?.genPerMinute ?? 0) ? d : best),
    null as typeof r.byDay[number] | null,
  );
  const bestDay = bestDayData?.day || "";

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Token 速率</h2>
          <div className="sub">
            主指标是<b>生成速度</b>——模型每秒真正写出多少 token，而不是上下文吞吐
          </div>
        </div>
      </div>

      <div className="rate-hero">
        <div className="rate-cell primary">
          <div className="k">活跃秒平均</div>
          <div className="v">
            {tokens(o.avgPerSecond)}
            <small>tok/s</small>
          </div>
          <div className="s">中位数 {tokens(o.medianPerSecond)}</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "60ms" }}>
          <div className="k">峰值秒</div>
          <div className="v">
            {tokens(o.peakPerSecond)}
            <small>tok/s</small>
          </div>
          <div className="s">
            {o.peakAt
              ? `${new Date(o.peakAt).toLocaleString("en-GB", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}`
              : "—"}
          </div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "120ms" }}>
          <div className="k">P95</div>
          <div className="v">
            {tokens(o.p95PerSecond)}
            <small>tok/s</small>
          </div>
          <div className="s">95% 的活跃秒低于此值</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "180ms" }}>
          <div className="k">活跃时长</div>
          <div className="v">
            {fmtInt(o.activeHours)}
            <small>小时</small>
          </div>
          <div className="s">{fmtInt(o.activeSeconds)} 秒有请求</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "240ms" }}>
          <div className="k">最近 60 秒</div>
          <div style={{ marginTop: 8 }}>
            <RateSpark recent={r.recent} />
          </div>
          <div className="s">
            合计 {tokens(r.recent.reduce((a, x) => a + x.tokens, 0))}
          </div>
        </div>
      </div>

      <div className="caliber-note">
        <div className="caliber-main">
          <b>为什么不是「每秒总 token」？</b>
          <p>
            agent 每轮都要把整个上下文重发一遍，缓存重读占全库 token 的{" "}
            <b>94.6%</b>。把它算进速率，测到的其实是「你的上下文窗口有多大」，
            而不是编码速度——本机那会是中位数 147,899 tok/s。
            上面主指标只统计<b>输出 token</b>。
          </p>
        </div>
        <div className="caliber-side">
          <div className="k">上下文吞吐（次指标）</div>
          <div className="v">
            {tokens(c.medianPerSecond)}
            <small>tok/s 中位数</small>
          </div>
          <div className="s">
            平均 {tokens(c.avgPerSecond)} · 峰值 {tokens(c.peakPerSecond)}
          </div>
          <div className="s dim">
            新鲜输入 + 缓存读 + 缓存写。量级由上下文长度决定，<b>不计入生成速度</b>。
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>每日速率</h2>
            <span className="sub">
              {bestHour ? `高产时段 ${bestHour.hour}:00` : ""}
            </span>
          </div>
          <TrendChart
            labels={r.byDay.map((d) => d.day)}
            series={[
              {
                key: "gen",
                label: "生成速度 tok/min（输出 / 活跃分钟）",
                color: "var(--c-clay)",
                values: r.byDay.map((d) => d.genPerMinute),
              },
            ]}
            height={240}
          />
          <div className="peak-note" style={{ marginTop: 16 }}>
            日均峰值出现在 <b>{fmtDateFull(bestDay)}</b>，当日活跃{" "}
            <b>{fmtInt(bestDayData?.activeMinutes || 0)}</b> 分钟，
            活跃分钟内平均生成 <b>{tokens(bestDayData?.genPerMinute || 0)}</b> tok/min。
          </div>
        </div>

        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>时段速率</h2>
            <span className="sub">活跃分钟内的生成 tok/min</span>
          </div>
          <HourBars hours={r.byHour} valueKey="genPerMinute" format={tokens} />
          <div style={{ marginTop: 22 }}>
            <RankBars
              rows={r.byTool.slice(0, 5).map((t) => ({
                key: t.tool,
                label: toolName(t.tool),
                sub: `${fmtInt(t.activeMinutes)} 分钟`,
                value: t.genPerMinute,
                color: toolColor(t.tool),
                extra: `${fmtInt(t.requests)} 次`,
              }))}
              format={tokens}
            />
          </div>
        </div>
      </div>

      {o.peakBreakdown.length > 0 && (
        <div className="peak-note">
          峰值秒由{" "}
          {o.peakBreakdown.slice(0, 3).map((b, i) => (
            <span key={b.tool}>
              {i > 0 && "、"}
              <b>{toolName(b.tool)}</b>（{tokens(b.tokens)}）
            </span>
          ))}
          贡献，通常来自一次长上下文会话。
        </div>
      )}
    </section>
  );
}

/**
 * 分栏开关。渲染成 null 就是「不显示」——比用 CSS 隐藏好，因为
 * 隐藏的图表仍会跑 IntersectionObserver、仍在 layout 里占位，
 * 切栏时会出现空白跳动。
 *
 * 这里同时是**滚动入场动效的唯一接入点**：每个顶层区块包一层 `Reveal`，
 * 于是往下滚时区块会依次浮现。
 *
 * 之前没有这一步，是因为入场动画全写在 CSS 的 `animation: fade-up` 上，
 * 那是**挂载动画**——切栏时该栏所有区块同时挂载，动画在同一瞬间一起放完，
 * 用户再往下滚时全部已是终态，于是「滚动时元素动起来」根本没发生。
 * 详见 `reveal.tsx`。
 */
function Tab({ name, tab, children }: { name: string; tab: string; children: React.ReactNode }) {
  if (!sectionsInTab(tab).includes(name)) return null;
  return (
    <>
      {Children.map(children, (child, i) =>
        isValidElement(child) ? (
          <Reveal key={i} delay={i * 60} distance={18}>
            {child}
          </Reveal>
        ) : (
          child
        ),
      )}
    </>
  );
}

/** 分栏标签栏。粘在顶部，滚动时始终可达。 */
function TabBar({ tab, setTab }: { tab: string; setTab: (t: string) => void }) {
  return (
    <nav className="tabbar" aria-label="分栏导航">
      <div className="tabbar-inner">
        {TABS.map((t) => (
          <button
            key={t.name}
            className={`tabbar-btn ${tab === t.name ? "on" : ""}`}
            onClick={() => {
              setTab(t.name);
              // 切栏后滚回顶部：否则会停在上一个栏滚到一半的位置，
              // 看起来像「页面没反应」。平滑滚动尊重用户的动效偏好。
              const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
              window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
            }}
            aria-current={tab === t.name ? "page" : undefined}
          >
            <span className="tabbar-name">{t.name}</span>
            <span className="tabbar-hint">{t.hint}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

export default function App() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [range, setRange] = useState<Range>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress>({
    running: false,
    stage: "idle",
    percent: 0,
  });
  const [metric, setMetric] = useState<"total_tokens" | "requests" | "cost_usd">("total_tokens");
  // 分栏：当前看哪一栏。诊断默认放最前——它给的是行动建议，用户最该先看。
  const [tab, setTab] = useState("诊断");
  const [focusModel, setFocusModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDashboard(range)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e.message || e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [range]);

  // SSE 订阅扫描进度；扫描结束后自动刷新
  useEffect(() => {
    const es = new EventSource("/api/scan/stream");
    let wasRunning = false;
    es.addEventListener("progress", (e) => {
      const p: ScanProgress = JSON.parse((e as MessageEvent).data);
      setProgress(p);
      if (wasRunning && !p.running) {
        fetchDashboard(range).then(setData).catch(() => {});
      }
      wasRunning = p.running;
    });
    return () => es.close();
  }, [range]);

  const trend = useMemo(() => {
    if (!data) return { labels: [] as string[], series: [] };
    const labels = data.timeseries.map((p) => p.day);
    const pick = (o: { total_tokens?: number; requests?: number; cost_usd?: number }) =>
      metric === "cost_usd"
        ? o.cost_usd || 0
        : metric === "requests"
          ? o.requests || 0
          : o.total_tokens || 0;

    if (focusModel) {
      const ms = data.modelSeries.find((m) => m.model === focusModel);
      return {
        labels,
        series: [
          {
            key: focusModel,
            label: bareModel(focusModel),
            color: modelColor(focusModel),
            values: labels.map((d) => pick(ms?.days[d] || {})),
          },
        ],
      };
    }

    const toolColor = new Map(data.tools.map((t) => [t.id, t.color]));
    const toolName = new Map(data.tools.map((t) => [t.id, t.name]));
    const dayMap = new Map<string, Record<string, ToolSeriesCell>>();
    const toolSet = new Set<string>();
    for (const row of data.timeseriesByTool) {
      dayMap.set(row.day, row.byTool);
      for (const t of Object.keys(row.byTool)) toolSet.add(t);
    }
    const series = [...toolSet]
      .map((tool) => ({
        key: tool,
        label: toolName.get(tool) || tool,
        color: toolColor.get(tool) || "var(--ink-3)",
        values: labels.map((day) => pick(dayMap.get(day)?.[tool] ?? {})),
      }))
      .filter((s) => s.values.some((v) => v > 0));
    return { labels, series };
  }, [data, metric, focusModel]);

  if (error) {
    return (
      <div className="fatal">
        <h1>无法连接 TokenLedger 服务</h1>
        <p>{error}</p>
        <p className="hint">
          请先运行 <code>npm start</code>（或 <code>node server/index.js</code>）
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="boot">
        <div className="boot-logo">TL</div>
        <div className="boot-bar">
          <span />
        </div>
        <p>{loading ? "正在加载用量数据" : "无数据"}</p>
      </div>
    );
  }

  const o = data.overview;
  const metricFmt = metric === "cost_usd" ? fmtCost : metric === "requests" ? fmtInt : tokens;
  const toolName = (id: string) => data.tools.find((t) => t.id === id)?.name || id;
  const toolColor = (id: string) => data.tools.find((t) => t.id === id)?.color || "var(--ink-3)";

  const donutSlices = data.byTool.slice(0, 6).map((r) => ({
    key: r.tool,
    label: toolName(r.tool),
    value: r.total_tokens,
    color: toolColor(r.tool),
  }));
  const modelRows = data.byModel.slice(0, 14).map((r) => ({
    key: r.model,
    label: bareModel(r.model),
    value: r.total_tokens,
    color: modelColor(r.model),
    extra: r.cost_usd > 0 ? fmtCost(r.cost_usd) : "—",
    sub: r.tool_count > 1 ? `${r.tool_count} 工具` : "",
  }));
  const costItems = data.byModel
    .filter((m) => m.cost_usd > 0)
    .slice(0, 6)
    .map((m) => ({ label: bareModel(m.model), value: m.cost_usd, color: modelColor(m.model) }));

  return (
    <div className="app">
      <div className="bg-grid" aria-hidden />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">TL</span>
          <div>
            <strong>TokenLedger</strong>
            <small>本机 Coding AI 用量统计</small>
          </div>
        </div>
        <div className="topbar-meta">
          {data.lastScan && (
            <span className="meta-chip">
              上次扫描 <b>{fmtAgo(data.lastScan.finished_at)}</b>
            </span>
          )}
          <span className="meta-chip">
            定价源 <b>{data.pricingSource}</b>
          </span>
          <span className="meta-chip">
            <b>
              {o.data_from} → {o.data_to}
            </b>
          </span>
        </div>
      </header>

      <ProfileHeader data={data} />

      <Toolbar range={range} setRange={setRange} tools={data.tools} byTool={data.byTool} />

      <TabBar tab={tab} setTab={setTab} />

      <RevealGroup as="section" className="stat-row" step={45} distance={10}>
        <Metric label="总 Token" value={tokens(o.total_tokens)} sub={`输出 ${tokens(o.output_tokens)}`} />
        <Metric label="请求" value={fmtInt(o.requests)} sub={`${fmtInt(o.sessions)} 会话`} delay={60} />
        <Metric label="预估成本" value={fmtCost(o.cost_usd)} sub={`${fmtCost(o.requests ? o.cost_usd / o.requests : 0)}/请求`} delay={120} />
        <Metric label="缓存命中" value={`${o.cache_hit_rate}%`} sub={`${tokens(o.cache_read_tokens)} 读取`} delay={180} />
        <Metric label="推理 Token" value={tokens(o.reasoning_tokens)} sub={`输出占比 ${o.output_tokens ? ((o.reasoning_tokens / o.output_tokens) * 100).toFixed(0) : 0}%`} delay={240} />
        <Metric
          label="平均延迟"
          value={o.avg_latency_ms ? fmtMs(o.avg_latency_ms) : "—"}
          sub={o.failures ? `${fmtInt(o.failures)} 次失败` : "工具未记录"}
          delay={300}
        />
      </RevealGroup>

      <InsightStrip
        waste={data.waste}
        guard={data.guard}
        pace={data.pace}
        costUsd={o.cost_usd}
      />

      <Tab name="用量趋势" tab={tab}>
  <section className="section">
          <div className="section-head">
            <div>
              <h2>用量趋势</h2>
              <div className="sub">
                {trend.labels.length} 天 · 峰值 {metricFmt(Math.max(0, ...trend.series.flatMap((s) => s.values)))}
              </div>
            </div>
            <div className="actions">
              <div className="segmented">
                {(
                  [
                    ["total_tokens", "Token"],
                    ["requests", "请求"],
                    ["cost_usd", "成本"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {focusModel && (
                <button className="btn" onClick={() => setFocusModel(null)}>
                  退出 {bareModel(focusModel)} 聚焦
                </button>
              )}
            </div>
          </div>
          <TrendChart labels={trend.labels} series={trend.series} height={250} yFormat={metricFmt} />
          <div className="legend-strip">
            {trend.series.map((s) => (
              <span key={s.key} className="item">
                <span className="dot" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        </section>
      </Tab>

      <Tab name="Token 速率" tab={tab}>
        <RateSection data={data} />
      </Tab>

      <Tab name="项目账单" tab={tab}>
        <ProjectSection rows={data.projects} />
      </Tab>

      <Tab name="缓存冷启动" tab={tab}>
        <ColdStartSection data={data.coldStart} />
      </Tab>

      <Tab name="浪费诊断" tab={tab}>
        <WasteSection data={data.waste} />
      </Tab>

      <Tab name="预算护栏" tab={tab}>
        <GuardSection data={data.guard} />
      </Tab>

      <Tab name="额度够用吗" tab={tab}>
        <PaceSection data={data.pace} />
      </Tab>

      <Tab name="购买力" tab={tab}>
        <MallSection
          costUsd={o.cost_usd}
          stats={{
            totalTokens: o.total_tokens,
            requests: o.requests,
            models: data.byModel.length,
            activeDays: data.profile.activeDays.length,
            span:
              data.profile.activeDays.length > 0
                ? `${data.profile.activeDays[0].day} → ${data.profile.activeDays[data.profile.activeDays.length - 1].day}`
                : "",
            tools: data.byTool.map((t) => ({
              name: toolName(t.tool),
              tokens: t.total_tokens,
              color: toolColor(t.tool),
            })),
          }}
        />
      </Tab>

      <Tab name="构成" tab={tab}>
  <section className="section">
          <div className="section-head">
            <h2>构成</h2>
          </div>
          <div className="grid-2">
            <div className="panel">
              <div className="section-head" style={{ marginBottom: 18 }}>
                <h2 style={{ fontSize: 16 }}>工具占比</h2>
              </div>
              <DonutChart
                slices={donutSlices}
                centerLabel="总 Token"
                centerValue={tokens(o.total_tokens)}
              />
            </div>
            <div className="panel">
              <div className="section-head" style={{ marginBottom: 18 }}>
                <h2 style={{ fontSize: 16 }}>Token 构成</h2>
              </div>
              <TokenBreakdown
                input={o.input_tokens}
                output={o.output_tokens}
                cacheRead={o.cache_read_tokens}
                cacheWrite={o.cache_write_tokens}
                reasoning={o.reasoning_tokens}
              />
            </div>
          </div>
        </section>
      </Tab>

      <Tab name="模型排行" tab={tab}>
  <section className="section">
          <div className="section-head">
            <div>
              <h2>模型排行</h2>
              <div className="sub">点击任意模型，上方趋势图会下钻到它</div>
            </div>
          </div>
          <div className="panel">
            <RankBars
              rows={modelRows}
              onSelect={(m) => setFocusModel(focusModel === m ? null : m)}
              selected={focusModel}
            />
          </div>
        </section>
      </Tab>

      <Tab name="活跃热力图" tab={tab}>
  <section className="section">
          <div className="grid-2">
            <div className="panel">
              <div className="section-head" style={{ marginBottom: 16 }}>
                <div>
                  <h2 style={{ fontSize: 16 }}>活跃热力图</h2>
                  <div className="sub">Codex profile 风格</div>
                </div>
              </div>
              <ActivityHeatmap
                days={data.profile.activeDays.map((d) => ({ day: d.day, tokens: d.tokens }))}
              />
            </div>

            <div className="panel">
              <div className="section-head" style={{ marginBottom: 16 }}>
                <div>
                  <h2 style={{ fontSize: 16 }}>时段活跃</h2>
                  <div className="sub">本地时间 · 请求数</div>
                </div>
              </div>
              <HourBars hours={data.hourly} />
            </div>
          </div>
        </section>
      </Tab>

      <Tab name="工具 × 模型" tab={tab}>
  <section className="section">
          <div className="section-head">
            <div>
              <h2>工具 × 模型</h2>
              <div className="sub">点击格子聚焦该模型</div>
            </div>
          </div>
          <ToolModelMatrix
            rows={data.matrix.map((r) => ({
              tool: r.tool,
              model: r.model,
              total_tokens: r.total_tokens,
              requests: r.requests,
            }))}
            onSelect={(m) => setFocusModel(focusModel === m ? null : m)}
          />
        </section>
      </Tab>

      <Tab name="成本构成" tab={tab}>
  <section className="section">
          <div className="grid-2">
            <div className="panel">
              <div className="section-head" style={{ marginBottom: 18 }}>
                <h2 style={{ fontSize: 16 }}>成本构成</h2>
              </div>
              <CompositionBar items={costItems} />
            </div>

            <div className="panel">
              <div className="section-head" style={{ marginBottom: 18 }}>
                <h2 style={{ fontSize: 16 }}>工具明细</h2>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>工具</th>
                    <th>请求</th>
                    <th>Token</th>
                    <th>模型</th>
                    <th>成本</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byTool.map((r) => (
                    <tr key={r.tool}>
                      <td>
                        <span
                          className="dot"
                          style={{ background: toolColor(r.tool), marginRight: 7 }}
                        />
                        {toolName(r.tool)}
                      </td>
                      <td>{fmtInt(r.requests)}</td>
                      <td>{tokens(r.total_tokens)}</td>
                      <td>{r.model_count}</td>
                      <td>{r.cost_usd > 0 ? fmtCost(r.cost_usd) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </Tab>

      <Tab name="最近会话" tab={tab}>
  <section className="section">
          <div className="section-head">
            <h2>最近会话</h2>
          </div>
          <div className="panel">
            {data.sessions.length === 0 && <div className="empty-hint">暂无会话</div>}
            <div className="sessions">
              {data.sessions.map((s) => (
                <article key={`${s.tool}-${s.session_id}`} className="session">
                  <span
                    className="session-tool"
                    style={{ background: toolColor(s.tool) }}
                  />
                  <div className="session-main">
                    <div className="session-title">{s.title || shortPath(s.cwd)}</div>
                    <div className="session-meta">
                      {toolName(s.tool)} · {bareModel(s.model || "—")} ·{" "}
                      {fmtInt(s.requests)} 次请求 · {shortPath(s.cwd)} · {fmtAgo(s.started_at)}
                    </div>
                  </div>
                  <div className="session-nums">
                    <b>{tokens(s.total_tokens)}</b>
                    <span>{s.cost_usd > 0 ? fmtCost(s.cost_usd) : "—"}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      </Tab>

      <Tab name="最近请求" tab={tab}>
  <section className="section">
          <div className="section-head">
            <div>
              <h2>最近请求</h2>
              <div className="sub">按时间倒序的实时事件流</div>
            </div>
          </div>
          <div className="panel">
            <div className="events">
              {data.recentEvents.map((e) => (
                <div key={e.event_id} className={`event${e.success ? "" : " failed"}`}>
                  <span className="event-time">{fmtTime(e.ts)}</span>
                  <span className="event-tool">{toolName(e.tool)}</span>
                  <span className="event-model">{bareModel(e.model)}</span>
                  <span className="event-path">{shortPath(e.cwd)}</span>
                  <span className="event-tokens">{tokens(e.total_tokens)}</span>
                  <span className="event-cost">
                    {e.cost_usd != null ? fmtCost(e.cost_usd) : "—"}
                    {e.cost_source && <em>{e.cost_source}</em>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </Tab>

      <Tab name="采集流程" tab={tab}>
  <section className="section">
          <div className="section-head">
            <h2>
              采集流程 <span className="live-dot" />
            </h2>
          </div>
          <ScanFlow
            progress={progress}
            tools={data.tools}
            onScan={() => triggerScan()}
            onReset={() => triggerReset()}
          />
        </section>
      </Tab>

      <footer className="foot">
        <span>
          数据源：{data.tools.filter((t) => t.installed).map((t) => t.name).join(" · ")}
        </span>
        <span>{fmtInt(data.dataRange.events)} 条事件落库于 ~/.tokenledger/tokenledger.db</span>
      </footer>
    </div>
  );
}
