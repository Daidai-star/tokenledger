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
import { estimateDailyCost } from "./mall";
import { Reveal } from "./reveal";
import { TABS, sectionsInTab } from "./sections";
import ScanFlow from "./components/ScanFlow";
import Boot from "./components/Boot";
import Cursor from "./components/Cursor";
import Deco from "./components/Deco";
import Marquee from "./components/Marquee";
import { scrollWindowTo, startSmoothScroll } from "./motion/smoothScroll";
import { mountSiteMotion } from "./motion/effects";
import { fetchDashboard, triggerReset, triggerScan } from "./api";
import type { Dashboard, Range, ScanProgress, ToolMeta, ToolSeriesCell } from "./types";
import {
  bareModel,
  fmtAgo,
  fmtCost,
  fmtDateFull,
  fmtInt,
  fmtSpan,
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

/**
 * 账本抬头（图纸标题栏）。
 *
 * 原来是 Codex profile 式的「身份环 + 问候语 + 导语 + 四个事实 + 工具条」，
 * 约 900px 高，且每一栏都重复出现——它回答的是「你是谁」，不是「账目如何」。
 * 现在收成一块标题栏：一行标题 + 六格指标，指标与滚动无关、永远可读。
 * 连续天数从「大圆环」降级成一格数字：它是个数据，不是图腾。
 */
function LedgerHeader({ data }: { data: Dashboard }) {
  const { profile, overview } = data;
  const streak = useCountUp(profile.currentStreak);
  const active = data.tools.filter((t) => data.byTool.some((r) => r.tool === t.id));

  const cells: { k: string; v: string; s: string }[] = [
    {
      k: "累计 Token",
      v: tokens(overview.total_tokens),
      s: `输出 ${tokens(overview.output_tokens)} · 推理 ${tokens(overview.reasoning_tokens)}`,
    },
    { k: "请求", v: fmtInt(overview.requests), s: `${fmtInt(overview.sessions)} 会话` },
    {
      k: "预估成本",
      v: fmtCost(overview.cost_usd),
      s: `${fmtCost(overview.requests ? overview.cost_usd / overview.requests : 0)}/请求`,
    },
    {
      k: "缓存命中",
      v: `${overview.cache_hit_rate}%`,
      s: `${tokens(overview.cache_read_tokens)} 读取`,
    },
    { k: "连续天数", v: String(Math.round(streak)), s: `最长 ${profile.longestStreak} 天` },
    { k: "活跃日", v: fmtInt(profile.totalActiveDays), s: `${overview.models} 个模型` },
  ];

  return (
    <section className="ledger-head">
      <div className="ledger-title">
        <div className="eyebrow">本机 CODING AI · 用量账本</div>
        <h1 className="ledger-h1">用量总账</h1>
        <p className="ledger-lede">
          汇总 {active.length} 个工具在 {profile.totalActiveDays} 个活跃日里的模型调用，
          覆盖 {overview.models} 个模型。
        </p>
      </div>

      <dl className="ledger-cells">
        {cells.map((c, i) => (
          <div className="ledger-cell" key={c.k} style={{ animationDelay: `${i * 45}ms` }}>
            <dt className="eyebrow">{c.k}</dt>
            <dd className="ledger-v">{c.v}</dd>
            <dd className="ledger-s">{c.s}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * 右侧边栏（图纸的「边栏」）。
 *
 * 原站右缘有一条窄栏放印章与竖排文字。这里把「账本状态 / 工具占比 / 操作」
 * 三件事收进去，让它们**常驻**——之前散在顶栏、档案头、采集流程里，
 * 每次想知道「上次什么时候扫的」都要滚到某一栏。
 */
function Rail({
  data,
  progress,
  onScan,
  onReset,
}: {
  data: Dashboard;
  progress: ScanProgress;
  onScan: () => void;
  onReset: () => void;
}) {
  const { overview } = data;
  const max = Math.max(1, ...data.byTool.map((r) => r.total_tokens));
  const installed = data.tools.filter((t) => t.installed);

  return (
    <aside className="rail">
      <div className="rail-block">
        <div className="eyebrow rail-h">账本状态</div>
        <dl className="rail-kv">
          <dt>数据范围</dt>
          <dd>
            {overview.data_from} → {overview.data_to}
          </dd>
          <dt>上次扫描</dt>
          <dd>{data.lastScan ? fmtAgo(data.lastScan.finished_at) : "—"}</dd>
          <dt>落库事件</dt>
          <dd>{fmtInt(data.dataRange.events)}</dd>
          <dt>定价源</dt>
          <dd>{data.pricingSource}</dd>
        </dl>
      </div>

      <div className="rail-block">
        <div className="eyebrow rail-h">工具占比</div>
        <div className="rail-tools">
          {data.byTool.map((r) => {
            const t = data.tools.find((x) => x.id === r.tool);
            return (
              <div className="rail-tool" key={r.tool}>
                <div className="rail-tool-top">
                  <span className="rail-tool-name">
                    <i className="rail-dot" style={{ background: t?.color || "var(--ink-3)" }} />
                    {t?.name || r.tool}
                  </span>
                  <span className="rail-tool-val">{tokens(r.total_tokens)}</span>
                </div>
                <div className="rail-bar">
                  <span
                    style={{
                      width: `${(r.total_tokens / max) * 100}%`,
                      background: t?.color || "var(--ink-3)",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rail-block rail-actions">
        <div className="eyebrow rail-h">
          操作 {progress.running && <span className="live-dot" />}
        </div>
        <button className="btn primary rail-btn" onClick={onScan} disabled={progress.running}>
          {progress.running ? `采集中 ${Math.round(progress.percent)}%` : "重新扫描"}
        </button>
        <button className="btn rail-btn" onClick={onReset} disabled={progress.running}>
          清库重扫
        </button>
        <p className="rail-note">
          {progress.running
            ? `${fmtInt(progress.filesParsed || 0)} / ${fmtInt(progress.filesSeen || 0)} 文件`
            : `${installed.length} / ${data.tools.length} 个工具已装`}
        </p>
      </div>
    </aside>
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

  /**
   * 本地日期。**不能用 `toISOString()`** —— 那是 UTC，东八区晚上 8 点后
   * 会算成「明天」，于是「今天」这一天永远查不到数据。
   */
  const ymd = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const daysBefore = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return ymd(d);
  };
  const today = ymd(new Date());
  const [customOpen, setCustomOpen] = useState(false);

  // days = 窗口长度（含今天）。0 = 全部历史。
  const presets = [
    { label: "今天", days: 1 },
    { label: "7 天", days: 7 },
    { label: "30 天", days: 30 },
    { label: "90 天", days: 90 },
    { label: "全部", days: 0 },
  ];

  const fromOf = (days: number) => (days <= 1 ? today : daysBefore(days - 1));
  const isPresetActive = (days: number) =>
    days === 0
      ? !range.from && !range.to
      : range.from === fromOf(days) && range.to === today;
  const isCustomActive = !!range.from && !presets.some((p) => isPresetActive(p.days));

  const applyPreset = (days: number) =>
    setRange({
      tools: range.tools,
      from: days === 0 ? undefined : fromOf(days),
      to: days === 0 ? undefined : today,
    });

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
          {presets.map((p) => (
            <button
              key={p.label}
              className={isPresetActive(p.days) ? "on" : ""}
              onClick={() => applyPreset(p.days)}
            >
              {p.label}
            </button>
          ))}
          <button
            className={isCustomActive || customOpen ? "on" : ""}
            onClick={() => setCustomOpen((v) => !v)}
          >
            自定义
          </button>
        </div>
        {(customOpen || isCustomActive) && (
          <span className="range-custom">
            <input
              type="date"
              value={range.from || ""}
              max={range.to || today}
              onChange={(e) => setRange({ ...range, from: e.target.value || undefined })}
            />
            <span className="range-dash">→</span>
            <input
              type="date"
              value={range.to || ""}
              min={range.from || undefined}
              onChange={(e) => setRange({ ...range, to: e.target.value || undefined })}
            />
            {isCustomActive && (
              <button className="range-clear" onClick={() => { setRange({ tools: range.tools }); setCustomOpen(false); }}>
                清除
              </button>
            )}
          </span>
        )}
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

/**
 * 模型速度。
 *
 * 上半：**每个工具最近一次会话**用的模型与速度（这是最常问的问题：
 *       「我现在这个工具跑的是什么模型、多快」）。
 * 下半：当前时间范围内各模型的输出速度排行。
 *
 * 口径要写清楚：日志里没有逐请求耗时，所以这里量的是**吞吐**
 * （output tokens / 活跃分钟），不是首 token 延迟。界面上直接标明，
 * 免得被当成延迟读。
 */
function SpeedSection({ data }: { data: Dashboard }) {
  const sp = data.speed;
  const toolName = (id: string) => data.tools.find((t) => t.id === id)?.name || id;
  const toolColor = (id: string) => data.tools.find((t) => t.id === id)?.color || "var(--ink-3)";

  if (!sp) return null;
  const maxSpd = Math.max(1, ...sp.byModel.map((m) => m.tok_per_sec));
  const o = sp.overall;

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>模型速度</h2>
          <div className="sub">
            输出 token ÷ <b>生成区间</b> —— 同会话里相邻两次请求的间隔，就是后一次的生成时长。
            日志没有逐请求耗时，所以这是<b>估算</b>；且区间里含工具调用时间，结果偏保守。
          </div>
        </div>
        <div className="speed-overall">
          全站 <b>{o.tok_per_sec.toFixed(1)}</b>
          <small>tok/s</small> · 每请求 <b>{fmtInt(o.out_per_req)}</b>
          <small>tok</small>
        </div>
      </div>

      {/* 每个工具最近一次会话 */}
      <div className="speed-latest">
        {sp.latestByTool.map((s) => (
          <article className="speed-card" key={s.tool}>
            <header className="speed-card-head">
              <span className="dot" style={{ background: toolColor(s.tool) }} />
              <span className="speed-tool">{toolName(s.tool)}</span>
              <span className="speed-ago">{fmtAgo(s.last_ts)}</span>
            </header>
            <div className="speed-model">{bareModel(s.model || "—")}</div>
            <div className="speed-path" title={s.cwd || ""}>
              {shortPath(s.cwd || "")}
            </div>
            <div className="speed-headline">
              {s.tok_per_sec.toFixed(1)}
              <small>tok/s</small>
              <span className="speed-headline-note">生成期间输出速率</span>
            </div>
            <dl className="speed-metrics">
              <div>
                <dt>生成区间</dt>
                <dd>
                  {fmtInt(s.intervals)}
                  <small>个</small>
                </dd>
              </div>
              <div>
                <dt>生成时长</dt>
                <dd>{fmtSpan(s.gen_seconds)}</dd>
              </div>
              <div>
                <dt>每请求</dt>
                <dd>
                  {fmtInt(s.out_per_req)}
                  <small>tok</small>
                </dd>
              </div>
              <div>
                <dt>输出 token</dt>
                <dd>{tokens(s.out_tokens)}</dd>
              </div>
            </dl>
            <div className="speed-foot">
              {fmtInt(s.requests)} 次请求 · 总量 {tokens(s.tokens)}
              {s.cache_read > 0 && <> · 缓存 {tokens(s.cache_read)}</>}
            </div>
          </article>
        ))}
        {!sp.latestByTool.length && <div className="empty-hint">还没有会话记录</div>}
      </div>

      {/* 模型速度排行 */}
      <div className="section-head" style={{ marginTop: 32 }}>
        <div>
          <h2 style={{ fontSize: 16 }}>按模型</h2>
        </div>
        <span className="sub">当前时间范围内，按输出 token 排序</span>
      </div>
      <div className="speed-rows">
        {sp.byModel.map((m) => (
          <div className="speed-row" key={m.model}>
            <span className="speed-row-name" title={m.model}>
              {bareModel(m.model)}
            </span>
            <span className="speed-row-track">
              <i style={{ width: `${(m.tok_per_sec / maxSpd) * 100}%` }} />
            </span>
            <span className="speed-row-val">
              {m.tok_per_sec.toFixed(1)}
              <small>tok/s</small>
            </span>
            <span className="speed-row-sub">
              {fmtInt(m.requests)} 次 · 区间 {fmtInt(m.intervals)} · 每请求 {fmtInt(m.out_per_req)} tok
            </span>
          </div>
        ))}
        {!sp.byModel.length && <div className="empty-hint">当前范围内没有数据</div>}
      </div>
    </section>
  );
}

/**
 * 用量与成本区块。
 *
 * 之前这里是「Token 速率」，主指标是 tok/s。用户看完 CC Switch 的统计后
 * 指出这个视角不对——秒级瞬时速率对「这个月花了多少」这个问题没有帮助，
 * 而且会因为缓存重读占 94.6% 而严重失真。
 *
 * 改成和 CC Switch 一致的**天级用量 / 成本**视角：
 * 主指标是本月累计 token 与成本，配每日曲线和上月对比。
 * 生成速度保留为注脚（它回答的是另一个问题：写代码时有多快）。
 */
function RateSection({ data }: { data: Dashboard }) {
  const r = data.rate;
  const o = r.overall;
  const c = r.context;
  const sp = data.speed;
  const toolName = (id: string) => data.tools.find((t) => t.id === id)?.name || id;
  const toolColor = (id: string) => data.tools.find((t) => t.id === id)?.color || "var(--ink-3)";
  const bestHour = (sp?.byHour ?? []).reduce(
    (best, h) => (h.tok_per_sec > (best?.tok_per_sec ?? 0) ? h : best),
    null as (typeof sp.byHour)[number] | null,
  );

  // ---------- 天级用量 / 成本 ----------
  const days = data.timeseries;
  if (!days.length || !o) return null;

  const monthOf = (day: string) => day.slice(0, 7);
  const curMonth = monthOf(days[days.length - 1].day);
  const months = [...new Set(days.map((p) => monthOf(p.day)))];
  const prevMonth = months.length > 1 ? months[months.length - 2] : null;

  const sum = (list: typeof days) => list.reduce(
    (a, p) => ({
      tokens: a.tokens + p.total_tokens,
      cost: a.cost + p.cost_usd,
      requests: a.requests + p.requests,
      input: a.input + p.input_incl_cache,
      output: a.output + p.output_tokens,
      cacheRead: a.cacheRead + p.cache_read_tokens,
    }),
    { tokens: 0, cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0 },
  );

  const curDays = days.filter((p) => monthOf(p.day) === curMonth);
  const prevDays = prevMonth ? days.filter((p) => monthOf(p.day) === prevMonth) : [];
  const cur = sum(curDays);
  const prev = prevDays.length ? sum(prevDays) : null;

  // 上月同期对比要按天数归一，否则「上月 28 天 vs 本月 3 天」没有可比性
  const dayRatio = prev && prevDays.length ? curDays.length / prevDays.length : 0;
  const paceToPrev = (v: number, pv: number) => (prev && dayRatio > 0 ? (v / (pv * dayRatio) - 1) * 100 : null);

  const bestDayData = curDays.reduce(
    (best, d) => (d.total_tokens > (best?.total_tokens ?? 0) ? d : best),
    null as (typeof days)[number] | null,
  );
  const bestDay = bestDayData?.day || "";
  const hitPct = cur.input ? ((cur.cacheRead / cur.input) * 100).toFixed(1) : "0";

  const costTrend = paceToPrev(cur.cost, prev?.cost ?? 0);
  const tokTrend = paceToPrev(cur.tokens, prev?.tokens ?? 0);

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>用量与成本</h2>
          <div className="sub">
            按天统计。token 为<b>含缓存读</b>口径，与 Codex 原始日志、CC Switch 一致
          </div>
        </div>
      </div>

      <div className="rate-hero">
        <div className="rate-cell primary">
          <div className="k">本月 token</div>
          <div className="v">
            {tokens(cur.tokens)}
            <small>含缓存读</small>
          </div>
          {/* 两行而不是一行：单行塞「输入 + 命中率 + 输出」会在窄格子里
              把「· 输出 5.14M」挤到第二行，整行 hero 高度就不齐了。 */}
          <div className="s">输入 {tokens(cur.input)} · 输出 {tokens(cur.output)}</div>
          <div className="s dim">{hitPct}% 命中缓存</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "60ms" }}>
          <div className="k">本月成本</div>
          <div className="v">
            {fmtCost(cur.cost)}
            <small>API 等价</small>
          </div>
          <div className="s">
            {costTrend != null ? (
              <>
                同期对比上月 <b className={costTrend > 0 ? "up" : "down"}>
                  {costTrend > 0 ? "+" : ""}
                  {costTrend.toFixed(0)}%
                </b>
              </>
            ) : (
              "没有上月数据可对比"
            )}
          </div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "120ms" }}>
          <div className="k">本月请求</div>
          <div className="v">
            {fmtInt(cur.requests)}
            <small>次</small>
          </div>
          <div className="s">
            日均 {fmtInt(cur.requests / Math.max(1, curDays.length))} 次
          </div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "180ms" }}>
          <div className="k">日均 token</div>
          <div className="v">
            {tokens(cur.tokens / Math.max(1, curDays.length))}
            <small>/天</small>
          </div>
          <div className="s">
            {tokTrend != null ? (
              <>
                同期 <b className={tokTrend > 0 ? "up" : "down"}>
                  {tokTrend > 0 ? "+" : ""}
                  {tokTrend.toFixed(0)}%
                </b>
              </>
            ) : (
              `${curMonth.replace("-", " 年 ")} 月`
            )}
          </div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "240ms" }}>
          <div className="k">单日最高</div>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: "var(--fs-title)", marginTop: 5, letterSpacing: "-0.02em" }}>
            {fmtDateFull(bestDay)}
          </div>
          <div className="s">
            {tokens(bestDayData?.total_tokens || 0)} · {fmtCost(bestDayData?.cost_usd || 0)}
          </div>
        </div>
      </div>

      <div className="caliber-note">
        <div className="caliber-main">
          <b>为什么 token 里 94% 是缓存读？</b>
          <p>
            agent 每轮都要把整个上下文重发一遍。缓存命中的部分计价打很低的折扣，
            所以<b>token 总量大不等于花钱多</b>——花钱看的是下面的成本图。
            本月输入里 {hitPct}% 命中缓存，实际计费按未命中的部分 + 输出。
          </p>
        </div>
        <div className="caliber-side">
          <div className="k">生成速度</div>
          <div className="v">
            {sp.overall.tok_per_sec.toFixed(1)}
            <small>tok/s</small>
          </div>
          <div className="s">
            按<b>生成区间</b>估算：同会话相邻两次请求的间隔，就是后一次的生成时长。
            每请求平均写出 {fmtInt(sp.overall.out_per_req)} 个输出 token。
          </div>
          <div className="s dim">
            日志把整次响应的 token 记在<b>完成的那一刻</b>，所以「按秒分桶」会把速度高估约 10 倍；
            这里改用真实区间，且只统计输出、不含缓存重读。
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: "var(--fs-title)" }}>每日用量</h2>
            <span className="sub">
              {bestHour ? `高产时段 ${bestHour.key}:00` : ""}
            </span>
          </div>
          <TrendChart
            labels={days.map((d) => d.day)}
            series={[
              {
                key: "total",
                label: "总 token（含缓存读）",
                color: "var(--c-clay)",
                values: days.map((d) => d.total_tokens),
              },
              {
                key: "input",
                label: "输入（含缓存读）",
                color: "var(--c-slate)",
                values: days.map((d) => d.input_incl_cache),
              },
              {
                key: "output",
                label: "输出",
                color: "var(--c-sage)",
                values: days.map((d) => d.output_tokens),
              },
            ]}
            height={240}
          />
          <div className="peak-note" style={{ marginTop: 16 }}>
            单日最高出现在 <b>{fmtDateFull(bestDay)}</b>，
            当日 <b>{tokens(bestDayData?.total_tokens || 0)}</b> token、
            <b>{fmtInt(bestDayData?.requests || 0)}</b> 次请求。
          </div>
        </div>

        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: "var(--fs-title)" }}>每日成本</h2>
            <span className="sub">API 等价成本，不是厂商账单</span>
          </div>
          <TrendChart
            labels={days.map((d) => d.day)}
            series={[
              {
                key: "cost",
                label: "成本 / 天",
                color: "var(--c-ochre)",
                values: days.map((d) => d.cost_usd),
              },
            ]}
            height={240}
            yFormat={fmtCost}
          />
          <div className="peak-note" style={{ marginTop: 16 }}>
            本月 <b>{fmtCost(cur.cost)}</b>
            {prev && (
              <>
                ，上月同期 <b>{fmtCost(prev.cost * dayRatio)}</b>（按 {curDays.length} 天折算）
              </>
            )}
            。
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: "var(--fs-title)" }}>各工具用量</h2>
            <span className="sub">按输入（含缓存读）排序</span>
          </div>
          <RankBars
            rows={(() => {
              // timeseriesByTool 是 {day, byTool:{toolId: cell}} 的形状，
              // 先按工具把每天累加出来，再排序取前 5。
              const acc = new Map<string, { tokens: number; requests: number; cost: number }>();
              for (const p of data.timeseriesByTool) {
                for (const [id, cell] of Object.entries(p.byTool || {})) {
                  const a = acc.get(id) || { tokens: 0, requests: 0, cost: 0 };
                  a.tokens += cell.total_tokens || 0;
                  a.requests += cell.requests || 0;
                  a.cost += cell.cost_usd || 0;
                  acc.set(id, a);
                }
              }
              return [...acc.entries()]
                .sort((a, b) => b[1].tokens - a[1].tokens)
                .slice(0, 5)
                .map(([id, a]) => ({
                  key: id,
                  label: toolName(id),
                  sub: fmtCost(a.cost),
                  value: a.tokens,
                  color: toolColor(id),
                  extra: `${fmtInt(a.requests)} 次`,
                }));
            })()}
            format={tokens}
          />
        </div>

        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: "var(--fs-title)" }}>时段分布</h2>
            <span className="sub">各时段的生成速度（tok/s · 生成区间口径）</span>
          </div>
          <HourBars
            hours={sp.byHour.map((h) => ({ hour: Number(h.key), tok_per_sec: h.tok_per_sec }))}
            valueKey="tok_per_sec"
            format={(n) => `${n.toFixed(1)} tok/s`}
          />
        </div>
      </div>

      {o.peakBreakdown.length > 0 && (
        <div className="peak-note">
          单秒完成量峰值（{tokens(o.peakPerSecond)} token）由{" "}
          {o.peakBreakdown.slice(0, 3).map((b, i) => (
            <span key={b.tool}>
              {i > 0 && "、"}
              <b>{toolName(b.tool)}</b>（{tokens(b.tokens)}）
            </span>
          ))}
          贡献。这<b>不是速率</b>——一次响应的全部输出会在它完成的那一秒整笔入账。
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
            onClick={() => setTab(t.name)}
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
  // 开机屏（规格表）是否还在。Boot 自己播完揭开动效后回调置 false。
  // `?noboot` 直接跳过——截图与 CI 冒烟用，也方便老用户刷页时不看动画。
  const [booting, setBooting] = useState(
    () => typeof window !== "undefined" && !new URLSearchParams(window.location.search).has("noboot"),
  );
  const appRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  // 平滑滚动：全局起一次，卸载时拆掉（Lenis + GSAP 共用一个 ticker）
  useEffect(() => startSmoothScroll(), []);

  // 页面级动效：标题逐行揭示 / 图纸框画线 / 采集流程固定滚动。
  // 依赖 data 与 tab——切栏会重建 DOM，必须重新装配（gsap.context 一次性 revert）。
  useEffect(() => {
    const scope = appRef.current;
    if (!scope || !data) return;
    const topbar = scope.querySelector<HTMLElement>(".topbar");
    return mountSiteMotion(scope, topbar);
  }, [data, tab]);

  /**
   * 切栏后定位到该栏的**第一个区块**，而不是页面顶部。
   *
   * 原来在 onClick 里直接 `scrollTo({ top: 0 })`，理由写的是「否则会停在上一个栏
   * 滚到一半的位置，看起来像页面没反应」。但账本抬头 + 工具栏 + 标签栏是**所有栏共享**的
   * （渲染在 `<Tab>` 之外），高度可观——滚到 0 之后看到的仍是这段共享头部，
   * 真正的栏内容还在首屏之外，用户必须再往下翻一次。
   *
   * 放在 useEffect 里而不是 onClick，是因为要等新栏内容挂载完才量得到位置。
   * 用 rAF 再等一帧，确保 DOM 已更新。
   */
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return; // 首次加载不要动滚动位置
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /**
     * 滚到「本栏内容的起点」。
     *
     * 之前滚的是 `document.querySelector("[data-reveal]")`——那是**第一个区块**，
     * 而区块高度依赖内容（图表 SVG 按容器宽算高），切栏时页面总高度会大幅变化，
     * 「量一次、滚一次」于是经常落空，表现就是点了栏没反应 / 跳不到位。
     * 改成滚一个**高度稳定**的锚点（紧贴标签栏下方），目标位置不随内容变。
     *
     * 另外把粘性顶栏的高度也算进偏移——顶栏和标签栏是叠着粘的，
     * 只减标签栏高度会差约 60px，落点会被顶栏盖住一截。
     */
    const target = () => {
      const anchor = document.querySelector(".tab-anchor");
      if (!anchor) return 0;
      const barH = document.querySelector(".tabbar")?.getBoundingClientRect().height ?? 0;
      const topH = document.querySelector(".topbar")?.getBoundingClientRect().height ?? 0;
      return Math.max(0, anchor.getBoundingClientRect().top + window.scrollY - (barH + topH + 16));
    };

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      scrollWindowTo(target(), !reduce);
      // 布局稳定后再校正一次：SVG 图表的高度要等一帧才准
      raf2 = requestAnimationFrame(() => scrollWindowTo(target(), false));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [tab]);
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
    const sumOf = (vs: number[]) => vs.reduce((a, b) => a + b, 0);

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
      .filter((s) => s.values.some((v) => v > 0))
      // 小的排上面（渲染顺序 = 堆叠顺序，最后一个画在最上层）。
      //
      // 本机 codex 占 93.1%、claude-code 只有 0.1%，差 1234 倍。按工具名字或
      // 数据库顺序排的话，claude-code 会永远压在最底层，被 codex 完全盖住——
      // 图例里四色俱全，图上只有一条线，95% 的画布只讲了一个故事。
      // 小的放顶部才能至少露出颜色边缘。
      .sort((a, b) => sumOf(a.values) - sumOf(b.values));
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
      <>
        <Deco />
        <Cursor />
        {booting && (
          <Boot
            progress={progress}
            ready={!loading}
            tools={[]}
            events={0}
            onDone={() => setBooting(false)}
          />
        )}
        <div className="app" ref={appRef}>
          <div className="app-empty">{loading ? "正在加载用量数据…" : "无数据"}</div>
        </div>
      </>
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

  const marqueeItems = data.tools.map((t) => {
    const row = data.byTool.find((r) => r.tool === t.id);
    return {
      name: t.name,
      value: row ? tokens(row.total_tokens) : "—",
      color: t.color,
      absent: !t.installed,
    };
  });

  const toolColors = Object.fromEntries(data.tools.map((t) => [t.id, t.color]));

  return (
    <>
      <Deco />
      <Cursor />
      {booting && (
        <Boot
          progress={progress}
          ready={!loading}
          tools={data.tools}
          events={data.dataRange.events}
          onDone={() => setBooting(false)}
        />
      )}
      <div className={`app${loading ? " is-refreshing" : ""}`} ref={appRef}>
      {loading && <div className="refresh-bar" aria-hidden />}
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

      <Marquee items={marqueeItems} />

      <div className="sheet-body">
        <div className="sheet-main">
      <LedgerHeader data={data} />

      <Toolbar range={range} setRange={setRange} tools={data.tools} byTool={data.byTool} />

      <TabBar tab={tab} setTab={setTab} />

      {/* 切栏滚动的锚点：高度稳定，不随各栏内容高度变化 */}
      <div className="tab-anchor" aria-hidden />

      <InsightStrip
        waste={data.waste}
        guard={data.guard}
        pace={data.pace}
        costUsd={o.cost_usd}
      />

      <Tab name="用量与成本" tab={tab}>
        <RateSection data={data} />
      </Tab>

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

      <Tab name="模型速度" tab={tab}>
        <SpeedSection data={data} />
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
        <PaceSection data={data.pace} colors={toolColors} />
      </Tab>

      <Tab name="购买力" tab={tab}>
        <MallSection
          costUsd={o.cost_usd}
          /*
           * 编码时长 = 各天「活跃分钟」之和 / 60（367 小时），
           * **不是** `rate.overall.activeHours`——后者是「有请求完成的秒数 / 3600」
           * （约 24 小时），拿它当分母会算出 ¥848/小时这种离谱数字。
           */
          activeHours={data.rate.byDay.reduce((a, d) => a + d.activeMinutes, 0) / 60}
          dailyCost={estimateDailyCost(
            data.timeseries,
            o.cost_usd,
            data.profile.activeDays.length,
          )}
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
                <h2 style={{ fontSize: "var(--fs-title)" }}>工具占比</h2>
              </div>
              <DonutChart
                slices={donutSlices}
                centerLabel="总 Token"
                centerValue={tokens(o.total_tokens)}
              />
            </div>
            <div className="panel">
              <div className="section-head" style={{ marginBottom: 18 }}>
                <h2 style={{ fontSize: "var(--fs-title)" }}>Token 构成</h2>
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
                  <h2 style={{ fontSize: "var(--fs-title)" }}>活跃热力图</h2>
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
                  <h2 style={{ fontSize: "var(--fs-title)" }}>时段活跃</h2>
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
                <h2 style={{ fontSize: "var(--fs-title)" }}>成本构成</h2>
              </div>
              <CompositionBar items={costItems} />
            </div>

            <div className="panel">
              <div className="section-head" style={{ marginBottom: 18 }}>
                <h2 style={{ fontSize: "var(--fs-title)" }}>工具明细</h2>
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
          <div className="pin-section">
            <div className="pin-inner">
              <ScanFlow progress={progress} tools={data.tools} />
            </div>
          </div>
        </section>
      </Tab>

      <footer className="foot">
        <span>
          数据源：{data.tools.filter((t) => t.installed).map((t) => t.name).join(" · ")}
        </span>
        <span>{fmtInt(data.dataRange.events)} 条事件落库于 ~/.tokenledger/tokenledger.db</span>
      </footer>
          </div>
          <Rail
            data={data}
            progress={progress}
            onScan={() => triggerScan()}
            onReset={() => triggerReset()}
          />
        </div>
      </div>
    </>
  );
}
