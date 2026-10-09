import { useEffect, useRef, useState } from "react";
import { tokens, fmtCost, fmtInt, fmtDate, modelColor, bareModel } from "../format";

/**
 * 自绘图表组件集（SVG + CSS）。
 * 视觉遵循 Anthropic 的克制风格：细发丝线、低饱和填充、无强边框。
 */

/** 挂载即入场 */
export function useInView<T extends HTMLElement>(_threshold = 0) {
  const ref = useRef<T | null>(null);
  const [inView] = useState(true);
  return { ref, inView };
}

// ---------------------------------------------------------------- 趋势面积图

/**
 * tooltip 用 translateX(-50%) 居中，靠近左右边缘时会有一半溢出面板。
 * 这里给出「安全半宽」，用于把水平位置夹回容器内。
 * 必须与 styles.css 里 .chart-tip 的 max-width 保持一致。
 */
const TIP_MAX_W = 240;
const TIP_HALF_W = TIP_MAX_W / 2;

export interface TrendSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

interface TrendProps {
  labels: string[];
  series: TrendSeries[];
  height?: number;
  yFormat?: (n: number) => string;
  xFormat?: (s: string) => string;
  onHover?: (index: number | null) => void;
}

/** 多序列堆叠面积趋势图 */
export function TrendChart({
  labels,
  series,
  height = 230,
  yFormat = tokens,
  xFormat = fmtDate,
  onHover,
}: TrendProps) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const W = 960;
  const H = height;
  const PAD = { t: 10, r: 6, b: 24, l: 48 };
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const n = labels.length;

  // 堆叠求和，得到每层上边界
  const cum: number[][] = [];
  const acc = new Array(n).fill(0);
  for (const s of series) {
    cum.push(s.values.map((v, i) => (acc[i] = acc[i] + v)));
  }
  const max = Math.max(1, ...acc);
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;

  const path = (layer: number[], base?: number[]) => {
    if (!n) return "";
    let d = "";
    for (let i = 0; i < n; i++) d += i === 0 ? `M${x(i)},${y(layer[i])}` : `L${x(i)},${y(layer[i])}`;
    if (base) {
      for (let i = n - 1; i >= 0; i--) d += `L${x(i)},${y(base[i])}`;
    } else {
      d += `L${x(n - 1)},${PAD.t + ih}L${x(0)},${PAD.t + ih}Z`;
    }
    return d;
  };

  const GRID = 4;
  const hi = hover != null && hover >= 0 && hover < n ? hover : null;
  const tickEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <div className="chart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="chart-svg">
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.3" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.03" />
            </linearGradient>
          ))}
        </defs>

        {Array.from({ length: GRID + 1 }, (_, i) => {
          const v = (max / GRID) * i;
          const yy = y(v);
          return (
            <g key={i}>
              <line x1={PAD.l} y1={yy} x2={W - PAD.r} y2={yy} className="grid-line" />
              <text x={PAD.l - 10} y={yy + 3.5} className="axis-text" textAnchor="end">
                {yFormat(v)}
              </text>
            </g>
          );
        })}

        {series.map((s, i) => (
          <path
            key={s.key}
            d={inView ? path(cum[i], i === 0 ? undefined : cum[i - 1]) : ""}
            fill={`url(#g-${s.key})`}
            stroke={s.color}
            strokeWidth={1.25}
            strokeLinejoin="round"
            className="trend-area"
          />
        ))}

        {labels.map((l, i) =>
          i % tickEvery === 0 || i === n - 1 ? (
            <text key={l} x={x(i)} y={H - 7} className="axis-text" textAnchor="middle">
              {xFormat(l)}
            </text>
          ) : null,
        )}

        {hi != null && (
          <g>
            <line x1={x(hi)} y1={PAD.t} x2={x(hi)} y2={PAD.t + ih} className="hover-line" />
            {series.map((s, i) => (
              <circle
                key={s.key}
                cx={x(hi)}
                cy={y(cum[i][hi])}
                r={2.6}
                fill={s.color}
                stroke={n > 0 ? "var(--paper)" : undefined}
                strokeWidth={1.2}
              />
            ))}
          </g>
        )}

        {Array.from({ length: n }, (_, i) => (
          <rect
            key={i}
            x={x(i) - iw / n / 2}
            y={PAD.t}
            width={iw / n}
            height={ih}
            fill="transparent"
            onMouseEnter={() => {
              setHover(i);
              onHover?.(i);
            }}
            onMouseLeave={() => {
              setHover(null);
              onHover?.(null);
            }}
          />
        ))}
      </svg>

      {hi != null && (
        <div
          className="chart-tip"
          style={{
            // 贴边时把气泡拉回容器内。夹取必须按**像素**而不是百分比：
            // 百分比留白在小容器上不够（12% of 600px 只有 72px，
            // 而气泡半宽可达 120px），仍会溢出面板。
            left: `clamp(${TIP_HALF_W}px, ${(x(hi) / W) * 100}%, calc(100% - ${TIP_HALF_W}px))`,
            top: -6,
          }}
        >
          <div className="tip-title">{labels[hi]}</div>
          {series.map((s) => (
            <div key={s.key} className="tip-row">
              <span className="dot" style={{ background: s.color }} />
              <span className="tip-label">{s.label}</span>
              <span className="tip-value">{yFormat(s.values[hi] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 排行

interface RankProps {
  rows: {
    key: string;
    label: string;
    sub?: string;
    value: number;
    color: string;
    extra?: string;
    extraTitle?: string;
  }[];
  format?: (n: number) => string;
  onSelect?: (key: string) => void;
  selected?: string | null;
}

/** 细线分隔的排行列表 */
export function RankBars({ rows, format = tokens, onSelect, selected }: RankProps) {
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="rank-list">
      {rows.map((r, i) => (
        <button
          key={r.key}
          className={`rank-row${selected === r.key ? " selected" : ""}`}
          onClick={() => onSelect?.(r.key)}
          style={{ animationDelay: `${i * 35}ms` }}
          title={r.label}
        >
          <span className="rank-name">{r.label}</span>
          <span className="rank-sub">{r.sub ?? ""}</span>
          <span className="rank-track">
            <span
              className="rank-fill"
              style={{
                width: `${(r.value / top) * 100}%`,
                background: r.color,
                animationDelay: `${i * 35 + 80}ms`,
              }}
            />
          </span>
          <span className="rank-value">{format(r.value)}</span>
          <span className="rank-extra">{r.extra ?? ""}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 环形图

interface DonutProps {
  slices: { key: string; label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}

export function DonutChart({
  slices,
  size = 176,
  thickness = 18,
  centerLabel,
  centerValue,
}: DonutProps) {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const R = size / 2 - thickness / 2 - 1;
  const C = 2 * Math.PI * R;

  let offset = 0;
  const arcs = slices.map((s) => {
    const frac = s.value / total;
    const arc = { ...s, frac, dash: frac * C, offset };
    offset += frac * C;
    return arc;
  });
  const active = arcs.find((a) => a.key === hover);

  return (
    <div className="donut-wrap" ref={ref}>
      <div className="donut" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--surface-sunk)" strokeWidth={thickness} />
          {inView &&
            arcs.map((a, i) => (
              <circle
                key={a.key}
                cx={size / 2}
                cy={size / 2}
                r={R}
                fill="none"
                stroke={a.color}
                strokeWidth={hover === a.key ? thickness + 4 : thickness}
                strokeDasharray={`${Math.max(0, a.dash - 1.5)} ${C - a.dash + 1.5}`}
                strokeDashoffset={-a.offset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                className="donut-arc"
                style={{ animationDelay: `${i * 80}ms`, opacity: hover && hover !== a.key ? 0.35 : 1 }}
                onMouseEnter={() => setHover(a.key)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
        </svg>
        <div className="donut-center">
          {active ? (
            <>
              <div className="donut-center-value" style={{ color: active.color }}>
                {tokens(active.value)}
              </div>
              <div className="donut-center-sub">{(active.frac * 100).toFixed(1)}%</div>
            </>
          ) : (
            <>
              <div className="donut-center-value">{centerValue}</div>
              <div className="donut-center-label">{centerLabel}</div>
            </>
          )}
        </div>
      </div>
      <div className="donut-legend">
        {arcs.map((a) => (
          <div
            key={a.key}
            className={`legend-item${hover === a.key ? " on" : ""}`}
            onMouseEnter={() => setHover(a.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="dot" style={{ background: a.color }} />
            <span className="legend-label">{a.label}</span>
            <span className="legend-value">{tokens(a.value)}</span>
            <span className="legend-pct">{(a.frac * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 24 小时柱状

export function HourBars({
  hours,
  valueKey = "requests",
  format = fmtInt,
  highlight = null,
}: {
  hours: { hour: number; requests?: number; total_tokens?: number; perMinute?: number }[];
  valueKey?: "requests" | "total_tokens" | "perMinute";
  format?: (n: number) => string;
  highlight?: ((h: number) => string | null) | null;
}) {
  const { ref } = useInView<HTMLDivElement>();
  const vals = hours.map((h) => (h[valueKey] as number) || 0);
  const max = Math.max(1, ...vals);

  return (
    <div className="bars-24" ref={ref}>
      {hours.map((h, i) => {
        const v = vals[i];
        const col = highlight ? highlight(h.hour) : null;
        return (
          <div key={h.hour} className="bar-col" title={`${h.hour}:00 · ${format(v)}`}>
            <div className="bar-wrap">
              <div
                className="bar"
                style={{
                  height: `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%`,
                  background: col || "var(--c-clay)",
                  opacity: v > 0 ? (h.hour >= 9 && h.hour <= 22 ? 0.9 : 0.42) : 0.15,
                  animation: `fade-in .5s var(--ease) ${i * 18}ms both`,
                }}
              />
            </div>
            {h.hour % 3 === 0 && <span className="bar-label">{h.hour}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- 活跃热力图

/** GitHub 风格年度热力图 —— Codex profile 的标志性视觉 */
export function ActivityHeatmap({ days }: { days: { day: string; tokens: number }[] }) {
  const { ref } = useInView<HTMLDivElement>();
  if (!days.length) return <div className="empty-hint">暂无数据</div>;

  const byDay = new Map(days.map((d) => [d.day, d.tokens]));
  const max = Math.max(1, ...days.map((d) => d.tokens));

  // 对齐到周一开头，整周填充
  const end = new Date(days[days.length - 1].day + "T00:00:00Z");
  end.setUTCHours(0, 0, 0, 0);
  const dow = (end.getUTCDay() + 6) % 7;
  const totalDays = Math.ceil((days.length + dow) / 7) * 7;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (totalDays - 1) + 1);

  const cells: { date: string; v: number }[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    cells.push({ date: key, v: byDay.get(key) || 0 });
  }
  const weeks = Math.ceil(totalDays / 7);

  const level = (v: number) => {
    if (v <= 0) return 0;
    const r = v / max;
    return r > 0.75 ? 4 : r > 0.45 ? 3 : r > 0.18 ? 2 : 1;
  };

  const monthMarks: { col: number; label: string }[] = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    const c = cells[w * 7];
    if (!c) continue;
    const d = new Date(c.date + "T00:00:00Z");
    const m = d.getUTCMonth();
    if (m !== lastMonth) {
      lastMonth = m;
      monthMarks.push({
        col: w,
        label: d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
      });
    }
  }

  return (
    <div className="heat" ref={ref}>
      <div className="heat-months">
        {monthMarks.map((m, i) => (
          <span key={i} style={{ left: `${(m.col / weeks) * 100}%` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div className="heat-grid">
        {cells.map((c, i) => (
          <div
            key={c.date}
            className={`heat-cell lv${level(c.v)}`}
            style={{ animationDelay: `${Math.min(i, 220) * 3}ms` }}
            title={`${c.date} · ${tokens(c.v)} tokens`}
          />
        ))}
      </div>
      <div className="heat-foot">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`heat-cell lv${l}`} />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 矩阵

export function ToolModelMatrix({
  rows,
  onSelect,
}: {
  rows: { tool: string; model: string; total_tokens: number; requests: number }[];
  onSelect?: (model: string) => void;
}) {
  if (!rows.length) return <div className="empty-hint">暂无数据</div>;
  const tools = [...new Set(rows.map((r) => r.tool))];
  const models = [...new Set(rows.map((r) => r.model))];
  const max = Math.max(1, ...rows.map((r) => r.total_tokens));
  const lookup = new Map(rows.map((r) => [`${r.tool}|${r.model}`, r]));

  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.model, (totals.get(r.model) || 0) + r.total_tokens);
  const cols = [...models].sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0)).slice(0, 10);

  return (
    <div className="matrix">
      <div className="matrix-head">
        <span />
        {cols.map((m) => (
          <span key={m} className="matrix-col-label" title={m}>
            {bareModel(m).slice(0, 13)}
          </span>
        ))}
      </div>
      {tools.map((t) => (
        <div key={t} className="matrix-row">
          <span className="matrix-row-label">{t}</span>
          {cols.map((m) => {
            const cell = lookup.get(`${t}|${m}`);
            const v = cell?.total_tokens || 0;
            const k = v / max;
            return (
              <button
                key={m}
                className={`matrix-cell ${v > 0 ? "filled" : "empty"}`}
                style={v > 0 ? { background: `color-mix(in srgb, var(--ink) ${8 + k * 62}%, transparent)` } : undefined}
                title={v > 0 ? `${t} × ${m}\n${tokens(v)} tokens · ${fmtInt(cell!.requests)} 次请求` : "无用量"}
                onClick={() => v > 0 && onSelect?.(m)}
              >
                {v > 0 && <span>{tokens(v)}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 构成条

export function CompositionBar({
  items,
}: {
  items: { label: string; value: number; color: string }[];
}) {
  const total = items.reduce((a, i) => a + i.value, 0);
  if (total <= 0) {
    return <div className="empty-hint">暂无数据</div>;
  }
  return (
    <div>
      <div className="bar-stack">
        {items.map((i, idx) => (
          <span
            key={i.label}
            className="seg"
            style={{
              width: `${(i.value / total) * 100}%`,
              background: i.color,
              animation: `fade-in .55s var(--ease) ${idx * 60}ms both`,
            }}
            title={`${i.label} ${fmtCost(i.value)}`}
          />
        ))}
      </div>
      <div className="chip-row">
        {items.map((i) => (
          <span key={i.label} className="chip">
            <span className="dot" style={{ background: i.color }} />
            {i.label}
            <b>{fmtCost(i.value)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 输入/输出/缓存/推理 的纵向构成 */
export function TokenBreakdown({
  input,
  output,
  cacheRead,
  cacheWrite,
  reasoning,
}: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}) {
  const items = [
    { key: "cache", label: "缓存命中", value: cacheRead, color: "var(--c-sage)" },
    { key: "input", label: "新鲜输入", value: Math.max(0, input - cacheRead), color: "var(--c-slate)" },
    { key: "output", label: "输出", value: output, color: "var(--c-clay)" },
    { key: "reasoning", label: "推理", value: reasoning, color: "var(--c-ochre)" },
    { key: "write", label: "缓存写入", value: cacheWrite, color: "var(--c-plum)" },
  ].filter((i) => i.value > 0);
  const total = items.reduce((a, i) => a + i.value, 0);
  if (!total) return <div className="empty-hint">暂无数据</div>;

  return (
    <div className="token-breakdown">
      <div className="tb-stack">
        {items.map((i, idx) => (
          <span
            key={i.key}
            className="seg"
            style={{
              height: `${(i.value / total) * 100}%`,
              background: i.color,
              animation: `fade-in .5s var(--ease) ${idx * 50}ms both`,
            }}
            title={`${i.label} ${tokens(i.value)}`}
          />
        ))}
      </div>
      <div className="tb-legend">
        {items.map((i, idx) => (
          <div key={i.key} className="tb-row" style={{ animationDelay: `${idx * 45}ms` }}>
            <span className="dot" style={{ background: i.color }} />
            <span className="legend-label">{i.label}</span>
            <span className="tb-value">{tokens(i.value)}</span>
            <span className="tb-pct">{((i.value / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 速率迷你图

/** 最近 N 分钟的滚动速率条形图 */
export function RateSpark({ recent }: { recent: { minute: number; tokens: number }[] }) {
  if (!recent.length) return <div className="empty-hint">暂无速率数据</div>;
  const max = Math.max(1, ...recent.map((r) => r.tokens));
  return (
    <div className="rate-spark">
      {recent.map((r) => (
        <i
          key={r.minute}
          style={{
            height: `${Math.max(r.tokens > 0 ? 4 : 1, (r.tokens / max) * 100)}%`,
            opacity: r.tokens > 0 ? 0.45 + (r.tokens / max) * 0.55 : 0.12,
          }}
          title={`${new Date(r.minute * 60 * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · ${tokens(r.tokens)}`}
        />
      ))}
    </div>
  );
}

export { modelColor };