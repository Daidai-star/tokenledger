/**
 * 聚合查询层：把 daily_rollups / usage_events 变成前端要的形状。
 *
 * 统一约定：
 *  - 所有接口都接受 from / to（YYYY-MM-DD），缺省为全量
 *  - tools 可选过滤（逗号分隔）
 *  - 缺失的天补 0（前端画图需要连续序列）
 */

export class Queries {
  constructor(store) {
    this.store = store;
  }

  #where({ from, to, tools }) {
    const clauses = [];
    const params = [];
    if (from) {
      clauses.push("day >= ?");
      params.push(from);
    }
    if (to) {
      clauses.push("day <= ?");
      params.push(to);
    }
    if (tools?.length) {
      clauses.push(`tool IN (${tools.map(() => "?").join(",")})`);
      params.push(...tools);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /** 总览指标 */
  overview(q = {}) {
    const w = this.#where(q);
    const { from, to, tools } = q;
    const row = this.store
      .prep(
        `SELECT
           COALESCE(SUM(requests), 0) AS requests,
           COALESCE(SUM(total_tokens),0) AS total_tokens,
           COALESCE(SUM(input_tokens),0) AS input_tokens,
           COALESCE(SUM(output_tokens),0) AS output_tokens,
           COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,
           COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
           COALESCE(SUM(cost_usd),0) AS cost_usd,
           COALESCE(SUM(failures),0) AS failures,
           COUNT(DISTINCT day) AS active_days,
           COUNT(DISTINCT model) AS models,
           COUNT(DISTINCT tool) AS tools
         FROM daily_rollups ${w.sql}`,
      )
      .get(...w.params);

    // 平均延迟：来自事件表（有真实 latency）
    const lat = this.store
      .prep(
        `SELECT COUNT(*) AS n, COALESCE(AVG(latency_ms),0) AS avg, COALESCE(AVG(ttft_ms),0) AS ttft
         FROM usage_events ${w.sql}`,
      )
      .get(...w.params);

    // 会话数：sessions 表按启动时间过滤
    const sClauses = [];
    const sParams = [];
    if (from) {
      sClauses.push("date(started_at/1000, 'unixepoch') >= ?");
      sParams.push(from);
    }
    if (to) {
      sClauses.push("date(started_at/1000, 'unixepoch') <= ?");
      sParams.push(to);
    }
    if (tools?.length) {
      sClauses.push(`tool IN (${tools.map(() => "?").join(",")})`);
      sParams.push(...tools);
    }
    const sessions = this.store
      .prep(
        `SELECT COUNT(*) AS c FROM sessions ${sClauses.length ? `WHERE ${sClauses.join(" AND ")}` : ""}`,
      )
      .get(...sParams);

    const range = this.store.dataRange();
    return {
      ...row,
      avg_latency_ms: Math.round(lat.avg || 0),
      avg_ttft_ms: Math.round(lat.ttft || 0),
      sessions: sessions?.c || 0,
      data_from: range.from,
      data_to: range.to,
      // 缓存命中率：命中 token 占输入的比例。
      // 不同工具口径不同（Codex 的 cached 是 input 的子集，OpenCode/DSH 的 cache.read 是并集），
      // 所以分母取两者之和，避免出现 >100% 的荒谬数字。
      cache_hit_rate: row.input_tokens + row.cache_read_tokens
        ? Number(
            ((row.cache_read_tokens / (row.input_tokens + row.cache_read_tokens)) * 100).toFixed(2),
          )
        : 0,
      error_rate: row.requests ? Number(((row.failures / row.requests) * 100).toFixed(2)) : 0,
    };
  }

  /** 时间序列（按天，可选按工具拆分） */
  timeseries(q = {}) {
    const w = this.#where(q);
    const groupByTool = q.byTool === true || q.byTool === "true";
    const rows = this.store
      .prep(
        `SELECT day, ${groupByTool ? "tool," : ""}
                SUM(requests) AS requests,
                SUM(total_tokens) AS total_tokens,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cost_usd) AS cost_usd,
                SUM(failures) AS failures
         FROM daily_rollups ${w.sql}
         GROUP BY day ${groupByTool ? ", tool" : ""}
         ORDER BY day ASC`,
      )
      .all(...w.params);

    if (!groupByTool) {
      return rows.map((r) => ({ ...r, cost_usd: round(r.cost_usd) }));
    }
    // 透视成 [{day, byTool:{codex:{...}}}]
    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, byTool: {} });
      byDay.get(r.day).byTool[r.tool] = {
        requests: r.requests,
        total_tokens: r.total_tokens,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cost_usd: round(r.cost_usd),
      };
    }
    return [...byDay.values()];
  }

  /** 按模型排行 */
  byModel(q = {}) {
    const w = this.#where(q);
    const limit = Number(q.limit) || 20;
    return this.store
      .prep(
        `SELECT model,
                COALESCE(MAX(provider),'') AS provider,
                SUM(requests) AS requests,
                SUM(total_tokens) AS total_tokens,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(cost_usd) AS cost_usd,
                SUM(failures) AS failures,
                COUNT(DISTINCT tool) AS tool_count
         FROM daily_rollups ${w.sql}
         GROUP BY model
         ORDER BY total_tokens DESC
         LIMIT ?`,
      )
      .all(...w.params, limit)
      .map((r) => ({ ...r, cost_usd: round(r.cost_usd) }));
  }

  /** 按模型的时间序列（模型下钻用） */
  modelSeries(q = {}) {
    const w = this.#where(q);
    const rows = this.store
      .prep(
        `SELECT day, model, SUM(total_tokens) AS total_tokens,
                SUM(requests) AS requests, SUM(cost_usd) AS cost_usd
         FROM daily_rollups ${w.sql}
         GROUP BY day, model
         ORDER BY day ASC`,
      )
      .all(...w.params);
    const byModel = new Map();
    for (const r of rows) {
      if (!byModel.has(r.model))
        byModel.set(r.model, {
          model: r.model,
          days: new Map(),
          total_tokens: 0,
          requests: 0,
          cost_usd: 0,
        });
      const m = byModel.get(r.model);
      m.days.set(r.day, {
        total_tokens: r.total_tokens,
        requests: r.requests,
        cost_usd: round(r.cost_usd),
      });
      m.total_tokens += r.total_tokens;
      m.requests += r.requests;
      m.cost_usd += r.cost_usd;
    }
    // Map 不能直接 JSON 序列化，days 摊平成普通对象
    return [...byModel.values()].map((m) => ({
      model: m.model,
      days: Object.fromEntries(m.days),
      total_tokens: m.total_tokens,
      requests: m.requests,
      cost_usd: round(m.cost_usd),
    }));
  }

  /** 按工具对比 */
  byTool(q = {}) {
    const w = this.#where(q);
    return this.store
      .prep(
        `SELECT tool,
                SUM(requests) AS requests,
                SUM(total_tokens) AS total_tokens,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(cost_usd) AS cost_usd,
                SUM(failures) AS failures,
                COUNT(DISTINCT model) AS model_count,
                COUNT(DISTINCT day) AS active_days
         FROM daily_rollups ${w.sql}
         GROUP BY tool
         ORDER BY total_tokens DESC`,
      )
      .all(...w.params)
      .map((r) => ({ ...r, cost_usd: round(r.cost_usd) }));
  }

  /** 按工具 × 模型矩阵（热力图用） */
  toolModelMatrix(q = {}) {
    const w = this.#where(q);
    const rows = this.store
      .prep(
        `SELECT tool, model, SUM(total_tokens) AS total_tokens, SUM(requests) AS requests, SUM(cost_usd) AS cost_usd
         FROM daily_rollups ${w.sql}
         GROUP BY tool, model
         ORDER BY total_tokens DESC`,
      )
      .all(...w.params);
    return rows.map((r) => ({ ...r, cost_usd: round(r.cost_usd) }));
  }

  /** 24 小时活跃分布 */
  hourly(q = {}) {
    const w = this.#eventWhere(q);
    return this.store
      .prep(
        `SELECT hour, COUNT(*) AS requests, SUM(total_tokens) AS total_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd
         FROM usage_events ${w.sql}
         GROUP BY hour ORDER BY hour`,
      )
      .all(...w.params)
      .map((r) => ({ ...r, cost_usd: round(r.cost_usd) }));
  }

  /** 星期分布（0=周日） */
  weekday(q = {}) {
    const w = this.#eventWhere(q);
    return this.store
      .prep(
        `SELECT CAST(strftime('%w', ts/1000, 'unixepoch') AS INTEGER) AS dow,
                COUNT(*) AS requests, SUM(total_tokens) AS total_tokens
         FROM usage_events ${w.sql}
         GROUP BY dow ORDER BY dow`,
      )
      .all(...w.params);
  }

  /**
   * Token 速率（吞吐）统计。
   *
   * 事件是「一次请求完成」的瞬时记录，所以速率要按分钟分桶来算才有意义：
   *   每分钟 token 数 = 该分钟内所有请求的 token 之和
   *
   * 提供三层：
   *   overall  — 全局速率画像（活跃分钟内均值、峰值、中位数）
   *   byDay    — 每日速率曲线
   *   byHour   — 24 小时速率画像（找高产时段）
   *   byTool   — 各工具速率对比
   *   recent   — 最近 N 分钟的滚动速率（实时感）
   */
  rate(q = {}) {
    const w = this.#eventWhere(q);

    // 按「本地时间分钟」分桶。strftime 加 localtime 保证小时/日期跟用户时区一致。
    const buckets = this.store
      .prep(
        `SELECT
           CAST(strftime('%s', ts/1000, 'unixepoch', 'localtime') / 60 AS INTEGER) AS minute,
           day, hour, tool,
           COUNT(*) AS requests,
           SUM(total_tokens) AS tokens,
           SUM(output_tokens) AS output_tokens
         FROM usage_events ${w.sql}
         GROUP BY minute, tool`,
      )
      .all(...w.params);

    if (!buckets.length) {
      return {
        overall: null,
        byDay: [],
        byHour: [],
        byTool: [],
        recent: [],
        summary: { activeMinutes: 0, totalTokens: 0, avgPerMinute: 0, peakPerMinute: 0 },
      };
    }

    // ---------- 汇总 ----------
    let totalTokens = 0;
    let totalRequests = 0;
    const perMinute = new Map(); // minute -> tokens
    const perMinuteTool = new Map(); // minute -> Map(tool -> tokens)
    const perDay = new Map(); // day -> {tokens, minutes:Set}
    const perHour = new Map(); // hour -> {tokens, minutes:Set}
    const perTool = new Map(); // tool -> {tokens, minutes:Set}

    for (const b of buckets) {
      const m = b.minute;
      totalTokens += b.tokens;
      totalRequests += b.requests;

      perMinute.set(m, (perMinute.get(m) || 0) + b.tokens);
      if (!perMinuteTool.has(m)) perMinuteTool.set(m, new Map());
      const mt = perMinuteTool.get(m);
      mt.set(b.tool, (mt.get(b.tool) || 0) + b.tokens);

      if (!perDay.has(b.day)) perDay.set(b.day, { tokens: 0, minutes: new Set(), requests: 0 });
      const d = perDay.get(b.day);
      d.tokens += b.tokens;
      d.requests += b.requests;
      d.minutes.add(m);

      if (!perHour.has(b.hour)) perHour.set(b.hour, { tokens: 0, minutes: new Set(), requests: 0 });
      const h = perHour.get(b.hour);
      h.tokens += b.tokens;
      h.requests += b.requests;
      h.minutes.add(m);

      if (!perTool.has(b.tool)) perTool.set(b.tool, { tokens: 0, minutes: new Set(), requests: 0 });
      const t = perTool.get(b.tool);
      t.tokens += b.tokens;
      t.requests += b.requests;
      t.minutes.add(m);
    }

    const activeMinutes = perMinute.size;
    const avgPerMinute = totalTokens / activeMinutes;

    // 峰值：找出 token 最多的那一分钟，并给出当时的工具构成
    let peakMinute = null;
    let peakTokens = 0;
    for (const [m, tokens] of perMinute) {
      if (tokens > peakTokens) {
        peakTokens = tokens;
        peakMinute = m;
      }
    }
    const peakBreakdown = peakMinute
      ? [...(perMinuteTool.get(peakMinute) || new Map())]
          .map(([tool, tokens]) => ({ tool, tokens }))
          .sort((a, b) => b.tokens - a.tokens)
      : [];

    // 中位数：对长尾更稳健，比均值更能代表「常态速率」
    const sorted = [...perMinute.values()].sort((a, b) => a - b);
    const medianPerMinute = sorted.length
      ? sorted[Math.floor(sorted.length / 2)]
      : 0;
    const p95PerMinute = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;

    // ---------- 每日速率 ----------
    const byDay = [...perDay.entries()]
      .map(([day, v]) => ({
        day,
        tokens: v.tokens,
        requests: v.requests,
        activeMinutes: v.minutes.size,
        perMinute: Math.round(v.tokens / v.minutes.size),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));

    // ---------- 24 小时速率画像 ----------
    const byHour = Array.from({ length: 24 }, (_, h) => {
      const v = perHour.get(h);
      if (!v) return { hour: h, tokens: 0, requests: 0, activeMinutes: 0, perMinute: 0 };
      return {
        hour: h,
        tokens: v.tokens,
        requests: v.requests,
        activeMinutes: v.minutes.size,
        perMinute: Math.round(v.tokens / v.minutes.size),
      };
    });

    // ---------- 各工具速率 ----------
    const byTool = [...perTool.entries()]
      .map(([tool, v]) => ({
        tool,
        tokens: v.tokens,
        requests: v.requests,
        activeMinutes: v.minutes.size,
        perMinute: Math.round(v.tokens / v.minutes.size),
      }))
      .sort((a, b) => b.perMinute - a.perMinute);

    // ---------- 最近 N 分钟滚动速率 ----------
    const recentMinutes = Number(q.recentMinutes) || 60;
    const lastMinute = Math.max(...perMinute.keys());
    const recent = [];
    for (let m = lastMinute - recentMinutes + 1; m <= lastMinute; m++) {
      recent.push({ minute: m, tokens: perMinute.get(m) || 0 });
    }

    return {
      overall: {
        activeMinutes,
        totalMinutes: activeMinutes,
        totalTokens,
        totalRequests,
        avgPerMinute: Math.round(avgPerMinute),
        medianPerMinute: Math.round(medianPerMinute),
        p95PerMinute: Math.round(p95PerMinute),
        peakPerMinute: peakTokens,
        peakAt: peakMinute != null ? peakMinute * 60 * 1000 : null,
        peakBreakdown,
        activeHours: Math.round((activeMinutes / 60) * 10) / 10,
      },
      byDay,
      byHour,
      byTool,
      recent,
      summary: {
        activeMinutes,
        totalTokens,
        avgPerMinute: Math.round(avgPerMinute),
        peakPerMinute: peakTokens,
      },
    };
  }

  /** 事件表专用的 where（day 列映射为时间戳比较） */
  #eventWhere({ from, to, tools }) {
    const clauses = [];
    const params = [];
    if (from) {
      clauses.push("ts >= ?");
      params.push(Date.parse(`${from}T00:00:00Z`));
    }
    if (to) {
      clauses.push("ts < ?");
      params.push(Date.parse(`${to}T00:00:00Z`) + 86_400_000);
    }
    if (tools?.length) {
      clauses.push(`tool IN (${tools.map(() => "?").join(",")})`);
      params.push(...tools);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /** 最近会话 */
  sessions(q = {}) {
    const limit = Number(q.limit) || 20;
    const clauses = [];
    const params = [];
    if (q.tools?.length) {
      clauses.push(`tool IN (${q.tools.map(() => "?").join(",")})`);
      params.push(...q.tools);
    }
    const w = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sessions = this.store
      .prep(
        `SELECT session_id, tool, started_at, ended_at, cwd, title, model, messages
         FROM sessions ${w} ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...params, limit);

    if (!sessions.length) return [];
    // 批量补每个会话的用量
    const out = [];
    for (const s of sessions) {
      const u = this.store
        .prep(
          `SELECT COALESCE(SUM(total_tokens),0) AS total_tokens,
                  COALESCE(SUM(input_tokens),0) AS input_tokens,
                  COALESCE(SUM(output_tokens),0) AS output_tokens,
                  COALESCE(SUM(cost_usd),0) AS cost_usd,
                  COUNT(*) AS requests
           FROM usage_events WHERE session_id = ? AND tool = ?`,
        )
        .get(s.session_id, s.tool);
      out.push({ ...s, ...u, cost_usd: round(u.cost_usd) });
    }
    return out;
  }

  /** 最近事件流 */
  recentEvents(q = {}) {
    const limit = Math.min(Number(q.limit) || 60, 500);
    const clauses = [];
    const params = [];
    if (q.tools?.length) {
      clauses.push(`tool IN (${q.tools.map(() => "?").join(",")})`);
      params.push(...q.tools);
    }
    if (q.model) {
      clauses.push("model = ?");
      params.push(q.model);
    }
    const w = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.store
      .prep(
        `SELECT event_id, tool, ts, model, provider, total_tokens, input_tokens, output_tokens,
                cache_read_tokens, cost_usd, cost_source, latency_ms, success, status, cwd
         FROM usage_events ${w} ORDER BY ts DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((r) => ({ ...r, cost_usd: r.cost_usd == null ? null : round(r.cost_usd) }));
  }

  /** Codex 风格档案：连续使用天数、当前 streak、每日强度 */
  profile(q = {}) {
    const w = this.#where(q);
    const days = this.store
      .prep(
        `SELECT day, SUM(requests) AS requests, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
         FROM daily_rollups ${w.sql} GROUP BY day ORDER BY day`,
      )
      .all(...w.params);

    const activeSet = new Set(days.map((d) => d.day));
    const totals = days.reduce(
      (a, d) => ({
        requests: a.requests + d.requests,
        tokens: a.tokens + d.tokens,
        cost: a.cost + d.cost,
      }),
      { requests: 0, tokens: 0, cost: 0 },
    );

    return {
      totalActiveDays: activeSet.size,
      totalRequests: totals.requests,
      totalTokens: totals.tokens,
      totalCost: round(totals.cost),
      currentStreak: currentStreak(activeSet),
      longestStreak: longestStreak(activeSet),
      avgTokensPerDay: activeSet.size ? Math.round(totals.tokens / activeSet.size) : 0,
      avgRequestsPerDay: activeSet.size ? Number((totals.requests / activeSet.size).toFixed(1)) : 0,
      activeDays: days.map((d) => ({ ...d, cost: round(d.cost) })),
    };
  }
}

function round(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10000) / 10000;
}

function toDayStr(d) {
  return d.toISOString().slice(0, 10);
}

function currentStreak(activeSet) {
  let n = 0;
  // 从今天（或昨天，宽限一天）往前数
  let cursor = new Date();
  if (!activeSet.has(toDayStr(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!activeSet.has(toDayStr(cursor))) return 0;
  }
  while (activeSet.has(toDayStr(cursor))) {
    n++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return n;
}

function longestStreak(activeSet) {
  const sorted = [...activeSet].sort();
  let best = 0;
  let cur = 0;
  let prev = null;
  for (const day of sorted) {
    if (prev) {
      const diff = (new Date(day) - new Date(prev)) / 86400000;
      cur = diff === 1 ? cur + 1 : 1;
    } else {
      cur = 1;
    }
    best = Math.max(best, cur);
    prev = day;
  }
  return best;
}