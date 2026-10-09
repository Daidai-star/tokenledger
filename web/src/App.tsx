import { useEffect, useMemo, useRef, useState } from "react";
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
import { ColdStartSection, ProjectSection } from "./components/Insights";
import { MallSection } from "./components/Mall";
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
  if (!r.overall) return null;
  const o = r.overall;
  const toolName = (id: string) => data.tools.find((t) => t.id === id)?.name || id;
  const toolColor = (id: string) => data.tools.find((t) => t.id === id)?.color || "var(--ink-3)";
  const bestHour = r.byHour.reduce(
    (best, h) => (h.perMinute > (best?.perMinute ?? 0) ? h : best),
    null as typeof r.byHour[number] | null,
  );
  const bestDayData = r.byDay.reduce(
    (best, d) => (d.perMinute > (best?.perMinute ?? 0) ? d : best),
    null as typeof r.byDay[number] | null,
  );
  const bestDay = bestDayData?.day || "";

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>Token 速率</h2>
          <div className="sub">按分钟分桶计算的吞吐强度，反映「你真正在写代码时」的密度</div>
        </div>
      </div>

      <div className="rate-hero">
        <div className="rate-cell primary">
          <div className="k">活跃时段平均</div>
          <div className="v">
            {tokens(o.avgPerMinute)}
            <small>tok/min</small>
          </div>
          <div className="s">中位数 {tokens(o.medianPerMinute)}</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "60ms" }}>
          <div className="k">峰值速率</div>
          <div className="v">
            {tokens(o.peakPerMinute)}
            <small>tok/min</small>
          </div>
          <div className="s">
            {o.peakAt
              ? `${new Date(o.peakAt).toLocaleString("en-GB", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
              : "—"}
          </div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "120ms" }}>
          <div className="k">P95</div>
          <div className="v">
            {tokens(o.p95PerMinute)}
            <small>tok/min</small>
          </div>
          <div className="s">95% 的活跃分钟低于此值</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "180ms" }}>
          <div className="k">活跃时长</div>
          <div className="v">
            {fmtInt(o.activeHours)}
            <small>小时</small>
          </div>
          <div className="s">{fmtInt(o.activeMinutes)} 分钟有请求</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "240ms" }}>
          <div className="k">最近 60 分钟</div>
          <div style={{ marginTop: 8 }}>
            <RateSpark recent={r.recent} />
          </div>
          <div className="s">
            合计 {tokens(r.recent.reduce((a, x) => a + x.tokens, 0))}
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
                key: "rate",
                label: "tok/min",
                color: "var(--c-clay)",
                values: r.byDay.map((d) => d.perMinute),
              },
            ]}
            height={240}
          />
          <div className="peak-note" style={{ marginTop: 16 }}>
            日均峰值出现在 <b>{fmtDateFull(bestDay)}</b>，当日活跃{" "}
            <b>{fmtInt(bestDayData?.activeMinutes || 0)}</b> 分钟，
            平均 <b>{tokens(bestDayData?.perMinute || 0)}</b> tok/min。
          </div>
        </div>

        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>时段速率</h2>
            <span className="sub">活跃分钟内的 tok/min</span>
          </div>
          <HourBars hours={r.byHour} valueKey="perMinute" format={tokens} />
          <div style={{ marginTop: 22 }}>
            <RankBars
              rows={r.byTool.slice(0, 5).map((t) => ({
                key: t.tool,
                label: toolName(t.tool),
                sub: `${fmtInt(t.activeMinutes)}min`,
                value: t.perMinute,
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
          峰值分钟由{" "}
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

      <section className="stat-row">
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
      </section>

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

      <RateSection data={data} />

      <ProjectSection rows={data.projects} />

      <ColdStartSection data={data.coldStart} />

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

      <footer className="foot">
        <span>
          数据源：{data.tools.filter((t) => t.installed).map((t) => t.name).join(" · ")}
        </span>
        <span>{fmtInt(data.dataRange.events)} 条事件落库于 ~/.tokenledger/tokenledger.db</span>
      </footer>
    </div>
  );
}