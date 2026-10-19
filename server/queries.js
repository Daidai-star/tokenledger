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
                -- 含缓存的 input：= 新鲜输入 + 缓存读 + 缓存写。
                -- 与 CC Switch / Codex 原始日志同口径（它们的 input_tokens 本就含 cached）。
                -- 三项都要加：漏掉 cache_write 会让总量差 515,664（claude-code 等工具有写入）。
                -- 库里存的 input_tokens 是新鲜输入，单列出来是为了展示时能两个口径都给。
                SUM(input_tokens) + SUM(cache_read_tokens) + SUM(cache_write_tokens) AS input_incl_cache,
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
         FROM usage_events ${w.where}
         GROUP BY hour ORDER BY hour`,
      )
      .all(...w.params)
      .map((r) => ({ ...r, cost_usd: round(r.cost_usd) }));
  }

  /**
   * 按项目（cwd）分组的账单。
   *
   * cwd 从采集第一天就存在，但此前没有任何界面用它——而这恰恰是用户唯一
   * 真正关心的维度：「我的钱花在哪个项目上」。实测本机 47 个项目 / 84.5k 事件，
   * 其中最大一个占 4.9B（30,927 请求），不看到这个就完全没有 sense。
   *
   * 顺带给出每个项目的缓存命中率：同一台机器不同项目能差 6 个百分点，
   * 说明上下文复用策略不同，是可优化的信号。
   *
   * 隐私：cwd 里就是项目名，可能含客户名或内部代号。所以这个接口只在本机
   * 提供，绝不能出现在任何上传方案里。
   */
  projects(q = {}) {
    const w = this.#eventWhere(q);
    return this.store
      .prep(
        `SELECT cwd,
                COUNT(*) AS requests,
                SUM(total_tokens) AS total_tokens,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd,
                MIN(day) AS first_day,
                MAX(day) AS last_day,
                COUNT(DISTINCT session_id) AS sessions,
                COUNT(DISTINCT model) AS models
         FROM usage_events
         WHERE ${w.sql ? `(${w.sql}) AND` : ""} cwd IS NOT NULL AND cwd <> ''
         GROUP BY cwd
         ORDER BY SUM(total_tokens) DESC`,
      )
      .all(...w.params)
      .map((r) => ({
        cwd: r.cwd,
        requests: r.requests,
        total_tokens: r.total_tokens,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        cost_usd: round(r.cost_usd),
        first_day: r.first_day,
        last_day: r.last_day,
        sessions: r.sessions,
        models: r.models,
        cache_hit_rate: r.total_tokens ? round((r.cache_read_tokens / r.total_tokens) * 100, 2) : 0,
      }));
  }

  /**
   * 缓存冷启动诊断。
   *
   * 核心事实（实测 417 个 Codex 会话）：
   *   第 1 次请求  缓存命中 52.4%
   *   第 2 次请求  79.6%
   *   第 3 次请求  82.0%
   *   第 6 次请求  86.8%
   *
   * 也就是说每个新会话的第一枪要付一大笔「冷启动」代价，之后才逐步爬升。
   * 这里算的是**实际观测到的**浪费，不是假设：
   *
   *   coldInput = 每个会话首次请求的 input_tokens（这部分必然按 input 价计费）
   *   warmSaving = 如果这 5.55M 新鲜输入能以缓存价计费，本可省下的钱
   *
   * 口径说明：
   *  - 「首次」用 ROW_NUMBER 按 ts 排序取第一条，而不是 MIN(ts)——
   *    并发请求会共享同一毫秒（实测平均 2.38 条，最多 225 条），
   *    用 MIN(ts) 做 JOIN 会把同一个会话重复计数 2.4 倍。
   *  - 只统计 total_tokens > 0 的事件，心跳行不带用量。
   */
  coldStart(q = {}) {
    const w = this.#eventWhere(q);

    const rows = this.store
      .prep(
        `WITH ranked AS (
           SELECT session_id,
                  input_tokens, output_tokens, cache_read_tokens,
                  cache_write_tokens, total_tokens, cost_usd,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts, rowid) AS rn
           FROM usage_events
           WHERE ${w.sql ? `(${w.sql}) AND` : ""} session_id IS NOT NULL
             AND session_id <> '' AND total_tokens > 0
         )
         SELECT rn,
                COUNT(*) AS requests,
                SUM(input_tokens) AS input_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens,
                SUM(total_tokens) AS total_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd
         FROM ranked
         WHERE rn <= 6
         GROUP BY rn
         ORDER BY rn`,
      )
      .all(...w.params)
      .map((r) => ({
        rn: r.rn,
        requests: r.requests,
        input_tokens: r.input_tokens,
        cache_read_tokens: r.cache_read_tokens,
        total_tokens: r.total_tokens,
        cost_usd: round(r.cost_usd),
        cache_hit_rate: r.total_tokens ? round((r.cache_read_tokens / r.total_tokens) * 100, 2) : 0,
      }));

    const first = rows.find((r) => r.rn === 1) || null;
    const sessions = first ? first.requests : 0;
    const warm = rows.find((r) => r.rn === 2) || null;

    // 冷启动的「学费」：首请求里按 input 价计费、但本可以走缓存价的部分。
    // 用首请求的实际混合单价反推缓存价，比例 1/5.75（Claude 缓存读相对 input）。
    const CACHE_DISCOUNT = 5.75;
    let coldPremiumUsd = null;
    if (first && first.input_tokens > 0 && first.cost_usd > 0) {
      const perInputUsd = first.cost_usd / Math.max(1, first.input_tokens + first.cache_read_tokens);
      const asIfWarmUsd = (first.input_tokens * perInputUsd) / CACHE_DISCOUNT;
      coldPremiumUsd = round(Math.max(0, first.cost_usd - asIfWarmUsd));
    }

    return {
      sessions,
      firstRequest: first,
      secondRequest: warm,
      curve: rows,
      /** 首请求缓存命中率（冷启动有多贵） */
      coldHitRate: first ? first.cache_hit_rate : 0,
      /** 第 2 次请求的命中率（缓存爬升到哪） */
      warmHitRate: warm ? warm.cache_hit_rate : 0,
      /** 冷启动溢价：首请求本可省下的钱 */
      coldPremiumUsd,
      /** 每个会话的冷启动溢价均值 */
      coldPremiumPerSession: sessions && coldPremiumUsd !== null ? round(coldPremiumUsd / sessions) : null,
      discount: CACHE_DISCOUNT,
    };
  }

  /**
   * 浪费诊断：把冷启动从「统计」变成「可执行的建议」。
   *
   * coldStart 回答「缓存爬升有多快」，但没说「所以呢」。
   * 这里回答三个问题：
   *   1. 切碎了吗   —— 碎片化指数 = 会话数 / 唯一项目数
   *   2. 多花了多少 —— 每个项目的首轮学费合计
   *   3. 怎么改     —— advice 数组，给具体到能照着做的建议
   *
   * 口径决定（与 coldStart 严格一致，改一处必须改两处）：
   *  - 「首轮」用 ROW_NUMBER 而不是 MIN(ts)，原因见 coldStart 的注释：
   *    并发请求共享同一毫秒，用 MIN(ts) JOIN 会重复计数 2.4 倍。
   *  - 排除 total_tokens = 0 的心跳行，它们不带用量。
   *  - 排除 cwd 为空的事件——项目维度没有它们的位置。
   *  - 费用优先用日志自带的 cost_usd（reported），没有才按 token 估。
   *
   * 为什么用「会话数 / 项目数」衡量碎片化，而不是平均会话长度：
   * 平均长度对长尾会话过度敏感（一次 200 轮的长会话会把均值拉高，
   * 掩盖掉「同时开了 5 个短会话」这种真实的浪费）。
   */
  waste(q = {}) {
    const w = this.#eventWhere(q);

    // 每个会话的首轮（rn=1），带上项目归属
    const firsts = this.store
      .prep(
        `WITH ranked AS (
           SELECT cwd, session_id, input_tokens, cache_read_tokens,
                  total_tokens, cost_usd, cost_source,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts, rowid) AS rn
           FROM usage_events
           WHERE ${w.sql ? `(${w.sql}) AND` : ""} session_id IS NOT NULL
             AND session_id <> '' AND cwd IS NOT NULL AND cwd <> ''
             AND total_tokens > 0
         )
         SELECT cwd,
                session_id,
                input_tokens,
                cache_read_tokens,
                total_tokens,
                cost_usd,
                cost_source
         FROM ranked
         WHERE rn = 1`,
      )
      .all(...w.params);

    // 项目总量，用于算「首轮占项目成本多少」
    const totals = this.store
      .prep(
        `SELECT cwd,
                COUNT(DISTINCT session_id) AS sessions,
                SUM(total_tokens) AS total_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd
         FROM usage_events
         WHERE ${w.sql ? `(${w.sql}) AND` : ""} cwd IS NOT NULL AND cwd <> ''
         GROUP BY cwd`,
      )
      .all(...w.params);

    const byCwd = new Map(totals.map((t) => [t.cwd, t]));
    const perProject = new Map();

    for (const f of firsts) {
      let p = perProject.get(f.cwd);
      if (!p) {
        const t = byCwd.get(f.cwd);
        p = {
          cwd: f.cwd,
          sessions: t ? t.sessions : 0,
          total_tokens: t ? t.total_tokens : 0,
          total_cost_usd: round(t ? t.cost_usd : 0),
          first_input_tokens: 0,
          first_cost_usd: 0,
          hasReportedCost: false,
        };
        perProject.set(f.cwd, p);
      }
      p.first_input_tokens += f.input_tokens;
      p.first_cost_usd += f.cost_usd == null ? 0 : f.cost_usd;
      if (f.cost_source === "reported") p.hasReportedCost = true;
    }

    const CACHE_DISCOUNT = 5.75;

    const rows = [...perProject.values()]
      .map((p) => {
        // 首轮学费：这部分新鲜输入本可以按缓存价计费
        const wasteUsd = round(Math.max(0, p.first_cost_usd * (1 - 1 / CACHE_DISCOUNT)));
        return {
          cwd: p.cwd,
          sessions: p.sessions,
          total_tokens: p.total_tokens,
          cost_usd: p.total_cost_usd,
          first_input_tokens: p.first_input_tokens,
          first_cost_usd: round(p.first_cost_usd),
          /** 首轮学费占项目总成本的比例（%） */
          waste_share: p.total_cost_usd > 0
            ? round((wasteUsd / p.total_cost_usd) * 100, 1)
            : 0,
          waste_usd: wasteUsd,
          /** 该项目平均每个会话多少轮——碎片化的直观体现 */
          requests_per_session: p.sessions > 0
            ? round(p.total_tokens / p.sessions)
            : 0,
          cost_source_estimated: !p.hasReportedCost,
        };
      })
      // 按可省金额降序：最值得先改的排最前
      .sort((a, b) => b.waste_usd - a.waste_usd);

    const projects = rows.length;
    const sessions = rows.reduce((n, r) => n + r.sessions, 0);
    const fragmentation = projects > 0 ? round(sessions / projects, 2) : 0;
    const totalWasteUsd = round(rows.reduce((n, r) => n + r.waste_usd, 0));

    return {
      projects,
      sessions,
      /** 平均每个项目开了多少个会话。1 = 不碎，越大越碎 */
      fragmentation,
      total_waste_usd: totalWasteUsd,
      rows,
      discount: CACHE_DISCOUNT,
      verdict: verdictFor(fragmentation),
      advice: adviceFor({ fragmentation, rows, totalWasteUsd }),
    };
  }

  /**
   * 预算护栏：单会话成本分布 + 超线会话。
   *
   * 为什么要按分布而不是固定阈值：本机实测单会话成本中位数 $0.32、
   * 最高 $35.69，差 100 倍。写死 $10 的话，多数人永远收不到提醒；
   * 写死 $1 的话天天被打扰。所以提醒线跟着用户自己的历史走。
   *
   * 用 P90 而不是 P90+：防的是「少数会话吃掉大钱」这件事，
   * P90 正好把最贵的 10% 挑出来。再高就漏掉了。
   *
   * 下限 $5 的理由：轻度使用的用户 P90 可能只有 $1，
   * 按分布给出的线会让人天天收到提醒——那就成了噪音，不是护栏。
   *
   * 口径：排除 total_tokens = 0 的心跳，它们不该造出会话参与统计。
   */
  guard(q = {}) {
    const w = this.#eventWhere(q);
    const limit = Number(q.limit) || 200;

    const rows = this.store
      .prep(
        `SELECT session_id,
                MAX(tool) AS tool,
                MIN(ts) AS started_at,
                MAX(ts) AS ended_at,
                MAX(cwd) AS cwd,
                COUNT(*) AS requests,
                SUM(total_tokens) AS total_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd
         FROM usage_events
         WHERE ${w.sql ? `(${w.sql}) AND` : ""} session_id IS NOT NULL
           AND session_id <> '' AND total_tokens > 0
         GROUP BY session_id
         ORDER BY cost_usd DESC
         LIMIT ?`,
      )
      .all(...w.params, limit);

    const WARN_FLOOR = 5;
    const costs = rows.map((r) => r.cost_usd).sort((a, b) => a - b);

    const pct = (p) => {
      if (!costs.length) return 0;
      // 取上分位，用 ceil 保证索引在范围内
      const idx = Math.min(costs.length - 1, Math.ceil((p / 100) * costs.length) - 1);
      return costs[Math.max(0, idx)];
    };

    const p50 = pct(50);
    const p90 = pct(90);
    const max = costs.length ? costs[costs.length - 1] : 0;
    // 下限兜底：轻度用户按分布算出来的线太低，会变成噪音
    const warnUsd = Math.max(WARN_FLOOR, roundTo(p90, 2));

    const over = rows
      .filter((r) => r.cost_usd >= warnUsd)
      .map((r) => ({
        session_id: r.session_id,
        tool: r.tool,
        cwd: r.cwd,
        started_at: r.started_at,
        requests: r.requests,
        total_tokens: r.total_tokens,
        cost_usd: round(r.cost_usd),
      }));

    return {
      sessions: rows.length,
      /** 中位数单会话成本——多数会话的真实量级 */
      medianUsd: roundTo(p50, 2),
      /** 提醒线 = max($5 下限, P90) */
      warnUsd,
      p90Usd: roundTo(p90, 2),
      maxUsd: roundTo(max, 2),
      /** 最高单会话是中位数的多少倍——「切碎之外还有大钱」的直接信号 */
      spread: p50 > 0 ? roundTo(max / p50, 1) : 0,
      over,
      totalOverUsd: round(over.reduce((n, r) => n + r.cost_usd, 0)),
      warnFloor: WARN_FLOOR,
    };
  }

  /**
   * 订阅额度视角：按当前速度，额度够用吗。
   *
   * 调研里用户最困惑的就是「$321 是不是要收我钱」——
   * 厂商给的订阅额度和「API 等价成本」是两个东西。
   * 累计数字回答不了这个问题，它只告诉你已经花了多少。
   * 这里做的是**投影**：把已发生用量按当前速率外推到月末。
   *
   * 口径决定：
   *  - 按自然月统计，因为订阅额度是按月重置的。
   *  - 速率分母用「本月已过天数」而不是「全部活跃天数」——
   *    用户可能上个月才开始用，用全部活跃天数会把速率算低、投影偏保守。
   *  - 投影 = 日速率 × 当月总天数，不是「日均 × 已过天数」。
   *  - 月中调用时 complete = false，界面必须标出这是估算。
   */
  pace(q = {}) {
    const now = Number(q.now) || Date.now();
    const d = new Date(now);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth(); // 0-11
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const daysElapsed = d.getUTCDate();
    const monthStart = Date.UTC(year, month, 1);
    const nextMonth = Date.UTC(year, month + 1, 1);

    const rows = this.store
      .prep(
        `SELECT tool,
                COUNT(*) AS requests,
                SUM(total_tokens) AS total_tokens,
                SUM(COALESCE(cost_usd, 0)) AS cost_usd
         FROM usage_events
         WHERE ts >= ? AND ts < ?
         GROUP BY tool
         ORDER BY cost_usd DESC`,
      )
      .all(monthStart, nextMonth);

    const byTool = rows.map((r) => ({
      tool: r.tool,
      requests: r.requests,
      total_tokens: r.total_tokens,
      cost_usd: round(r.cost_usd),
      share: 0, // 下面按总额回填，避免二次查询
    }));

    const spentUsd = round(rows.reduce((n, r) => n + r.cost_usd, 0));
    for (const t of byTool) {
      t.share = spentUsd > 0 ? roundTo((t.cost_usd / spentUsd) * 100, 1) : 0;
    }

    const dailyUsd = daysElapsed > 0 ? roundTo(spentUsd / daysElapsed, 2) : 0;
    const projectedUsd = round(dailyUsd * daysInMonth);

    return {
      year,
      /** 1-12 */
      month: month + 1,
      monthLabel: `${year} 年 ${month + 1} 月`,
      spentUsd,
      dailyUsd,
      projectedUsd,
      daysElapsed,
      daysInMonth,
      /** 本月是否已走完——false 时 projectedUsd 是外推估算 */
      complete: daysElapsed >= daysInMonth,
      byTool,
      requests: rows.reduce((n, r) => n + r.requests, 0),
    };
  }

  /** 星期分布（0=周日） */
  weekday(q = {}) {
    const w = this.#eventWhere(q);
    return this.store
      .prep(
        `SELECT CAST(strftime('%w', ts/1000, 'unixepoch') AS INTEGER) AS dow,
                COUNT(*) AS requests, SUM(total_tokens) AS total_tokens
         FROM usage_events ${w.where}
         GROUP BY dow ORDER BY dow`,
      )
      .all(...w.params);
  }

  /**
   * Token 速率（吞吐）统计。
   *
   * ## 口径：主指标是**生成速度**，不是上下文吞吐
   *
   * 第一版这里用 `SUM(total_tokens)`，而 `total_tokens` 里 94.6% 是
   * `cache_read_tokens`——agent 每轮把整个上下文重发一遍。
   * 于是「每秒 token」测的是**上下文窗口有多大**，不是**干活强度**：
   * 本机中位数 147,899 tok/s，但那个数里真正新生成的只有 247 tok/s。
   *
   * 所以拆成两个口径：
   *   gen  — 输出 token，每秒。这是模型真实的生成速度，也是主指标。
   *   ctx  — 新鲜输入 + 缓存读 + 缓存写，每秒。这是上下文重读的吞吐，
   *          单独列出来并标注「不计入生成速度」，因为它的量级由上下文长度
   *          决定，跟编码速度无关。
   *
   * 按天/按小时/按工具一律用**输出 token/分钟**，和主指标同口径，
   * 避免出现「首屏 247 tok/s、日曲线 30 万 tok/min」的自相矛盾。
   *
   * ## 同刻去重
   *
   * 会话恢复时 Codex 会把积压的 `token_count` 一次性刷出，全部盖上恢复时刻的
   * 时间戳（实测某一秒挤进 2748 条、仅 363 个不同毫秒）。按 `(session_id, ts)`
   * 取首条，与 `coldStart` 已有的 `ROW_NUMBER()` 口径保持一致。
   * 全库 592 个毫秒受影响、合计占总量 5.65%，不去重会让峰值失真两个数量级。
   */
  rate(q = {}) {
    const w = this.#eventWhere(q);

    // 同时按「本地秒」分桶，并保留「本地分钟」键供按天/按小时聚合。
    // 秒级用来回答「我最快的那一秒烧了多少」——分钟桶会把尖峰抹平；
    // 分钟级保留给按天/按小时的聚合，否则那些视图会因为秒级噪声而抖动。
    // strftime 加 localtime 保证小时/日期跟用户时区一致。
    // 外层 CTE 先按 (session_id, ts) 去重，再分桶——否则恢复突发会把峰值
    // 顶到几亿 token/秒，那是日志补写不是吞吐。
    const buckets = this.store
      .prep(
        `WITH dedup AS (
           SELECT * FROM (
             SELECT ts, day, hour, tool,
                    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                    ROW_NUMBER() OVER (PARTITION BY session_id, ts ORDER BY ts) AS rn
             FROM usage_events ${w.where}
           ) WHERE rn = 1
         )
         SELECT
           CAST(strftime('%s', ts/1000, 'unixepoch', 'localtime') AS INTEGER) AS second,
           day, hour, tool,
           COUNT(*) AS requests,
           SUM(output_tokens) AS gen_tokens,
           SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS ctx_tokens,
           SUM(output_tokens + input_tokens + cache_read_tokens + cache_write_tokens) AS total_tokens
         FROM dedup
         GROUP BY second, tool`,
      )
      .all(...w.params);

    if (!buckets.length) {
      return {
        overall: null,
        context: null,
        byDay: [],
        byHour: [],
        byTool: [],
        recent: [],
        summary: {
          activeSeconds: 0,
          totalTokens: 0,
          genPerSecond: 0,
          peakGenPerSecond: 0,
          ctxPerSecond: 0,
        },
      };
    }

    // ---------- 汇总 ----------
    // 两套并行累加：gen = 生成速度（主指标），ctx = 上下文重读吞吐（次要指标）。
    // 两者量级差两个数量级，混在一起算就是算术没错但没有意义。
    let totalTokens = 0;
    let totalRequests = 0;
    const perSecond = new Map(); // second -> {gen, ctx}
    const perSecondTool = new Map(); // second -> Map(tool -> gen)
    const perDay = new Map(); // day -> {gen, ctx, minutes:Set, requests}
    const perHour = new Map(); // hour -> {gen, ctx, minutes:Set, requests}
    const perTool = new Map(); // tool -> {gen, ctx, minutes:Set, requests}

    for (const b of buckets) {
      const s = b.second;
      // 分钟键仅用于按天/按小时的活跃度统计（秒级太细，聚合会不稳）
      const m = Math.floor(s / 60);
      const gen = b.gen_tokens || 0;
      const ctx = b.ctx_tokens || 0;
      totalTokens += b.total_tokens;
      totalRequests += b.requests;

      const cur = perSecond.get(s) || { gen: 0, ctx: 0 };
      cur.gen += gen;
      cur.ctx += ctx;
      perSecond.set(s, cur);
      if (!perSecondTool.has(s)) perSecondTool.set(s, new Map());
      const mt = perSecondTool.get(s);
      mt.set(b.tool, (mt.get(b.tool) || 0) + gen);

      if (!perDay.has(b.day)) perDay.set(b.day, { gen: 0, ctx: 0, minutes: new Set(), requests: 0 });
      const d = perDay.get(b.day);
      d.gen += gen;
      d.ctx += ctx;
      d.requests += b.requests;
      d.minutes.add(m);

      if (!perHour.has(b.hour)) perHour.set(b.hour, { gen: 0, ctx: 0, minutes: new Set(), requests: 0 });
      const h = perHour.get(b.hour);
      h.gen += gen;
      h.ctx += ctx;
      h.requests += b.requests;
      h.minutes.add(m);

      if (!perTool.has(b.tool)) perTool.set(b.tool, { gen: 0, ctx: 0, minutes: new Set(), requests: 0 });
      const t = perTool.get(b.tool);
      t.gen += gen;
      t.ctx += ctx;
      t.requests += b.requests;
      t.minutes.add(m);
    }

    const activeSeconds = perSecond.size;

    /**
     * 把「second -> {gen, ctx}」压成一组分布统计。
     * 中位数与 P95 对长尾稳健，比均值更能代表「常态速率」；
     * 分母用活跃秒而非全部秒——空秒会把分布压低，那是噪声不是事实。
     */
    const stat = (pick) => {
      const entries = [...perSecond.entries()];
      const vals = entries.map(([, v]) => pick(v)).sort((a, b) => a - b);
      let peakSecond = null;
      let peakTokens = 0;
      for (const [s, v] of entries) {
        const t = pick(v);
        if (t > peakTokens) {
          peakTokens = t;
          peakSecond = s;
        }
      }
      return {
        avg: Math.round(vals.reduce((a, b) => a + b, 0) / (vals.length || 1)),
        median: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
        p95: vals.length ? vals[Math.floor(vals.length * 0.95)] : 0,
        peak: peakTokens,
        peakSecond,
      };
    };

    const genStat = stat((v) => v.gen);
    const ctxStat = stat((v) => v.ctx);

    // 峰值秒的工具构成，按生成量拆——回答「最快那一秒是谁在烧」
    const peakBreakdown =
      genStat.peakSecond != null
        ? [...(perSecondTool.get(genStat.peakSecond) || new Map())]
            .map(([tool, tokens]) => ({ tool, tokens }))
            .sort((a, b) => b.tokens - a.tokens)
        : [];

    // ---------- 每日速率（与主指标同口径：输出 token/分钟）----------
    const byDay = [...perDay.entries()]
      .map(([day, v]) => ({
        day,
        tokens: v.gen + v.ctx,
        genTokens: v.gen,
        ctxTokens: v.ctx,
        requests: v.requests,
        activeMinutes: v.minutes.size,
        genPerMinute: Math.round(v.gen / v.minutes.size),
        ctxPerMinute: Math.round(v.ctx / v.minutes.size),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));

    // ---------- 24 小时速率画像 ----------
    const byHour = Array.from({ length: 24 }, (_, h) => {
      const v = perHour.get(h);
      if (!v)
        return {
          hour: h,
          tokens: 0,
          genTokens: 0,
          ctxTokens: 0,
          requests: 0,
          activeMinutes: 0,
          genPerMinute: 0,
          ctxPerMinute: 0,
        };
      return {
        hour: h,
        tokens: v.gen + v.ctx,
        genTokens: v.gen,
        ctxTokens: v.ctx,
        requests: v.requests,
        activeMinutes: v.minutes.size,
        genPerMinute: Math.round(v.gen / v.minutes.size),
        ctxPerMinute: Math.round(v.ctx / v.minutes.size),
      };
    });

    // ---------- 各工具速率 ----------
    const byTool = [...perTool.entries()]
      .map(([tool, v]) => ({
        tool,
        tokens: v.gen + v.ctx,
        genTokens: v.gen,
        ctxTokens: v.ctx,
        requests: v.requests,
        activeMinutes: v.minutes.size,
        genPerMinute: Math.round(v.gen / v.minutes.size),
        ctxPerMinute: Math.round(v.ctx / v.minutes.size),
      }))
      .sort((a, b) => b.genPerMinute - a.genPerMinute);

    // ---------- 最近 N 秒滚动速率 ----------
    // 和主指标一致：只统计输出（生成速度），免得迷你图和上面的大数字口径打架
    const recentSeconds = Number(q.recentSeconds) || 60;
    const lastSecond = Math.max(...perSecond.keys());
    const recent = [];
    for (let s = lastSecond - recentSeconds + 1; s <= lastSecond; s++) {
      recent.push({ second: s, tokens: perSecond.get(s)?.gen || 0 });
    }

    // 全部活跃秒的生成量 / 上下文量合计，供首屏直接引用
    let totalGen = 0;
    let totalCtx = 0;
    for (const v of perSecond.values()) {
      totalGen += v.gen;
      totalCtx += v.ctx;
    }

    return {
      /** 主指标：生成速度（输出 token/秒） */
      overall: {
        activeSeconds,
        totalTokens,
        totalRequests,
        totalGen,
        totalCtx,
        avgPerSecond: genStat.avg,
        medianPerSecond: genStat.median,
        p95PerSecond: genStat.p95,
        peakPerSecond: genStat.peak,
        peakAt: genStat.peakSecond != null ? genStat.peakSecond * 1000 : null,
        peakBreakdown,
        activeHours: Math.round((activeSeconds / 3600) * 10) / 10,
      },
      /**
       * 次指标：上下文吞吐（新鲜输入 + 缓存读 + 缓存写，每秒）。
       * 量级由上下文长度决定，不是编码速度——界面上要和生成速度分开说。
       */
      context: {
        activeSeconds,
        avgPerSecond: ctxStat.avg,
        medianPerSecond: ctxStat.median,
        p95PerSecond: ctxStat.p95,
        peakPerSecond: ctxStat.peak,
      },
      byDay,
      byHour,
      byTool,
      recent,
      summary: {
        activeSeconds,
        totalTokens,
        genPerSecond: genStat.avg,
        peakGenPerSecond: genStat.peak,
        ctxPerSecond: ctxStat.avg,
      },
    };
  }

  /** 事件表专用的 where（day 列映射为时间戳比较） */
  /**
   * 事件表上的过滤条件。
   *
   * 返回的是**不含 WHERE** 的裸条件（`ts >= ? AND tool IN (?)`），
   * 供需要额外追加条件的查询拼装，例如
   *   `WHERE ${w.sql ? `(${w.sql}) AND` : ""} cwd IS NOT NULL`
   * ——没条件时展开成空串，不能留下裸 WHERE。
   */
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
    return { sql: clauses.join(" AND "), where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /** 最近会话 */
  sessions(q = {}) {
    const limit = Number(q.limit) || 20;
    const clauses = [];
    const params = [];
    // 之前这里**完全忽略 from/to**：选中「最近 7 天」时，这张表仍在列全历史会话。
    // 既是性能问题（见下），也是口径 bug。
    if (q.from) {
      clauses.push("date(s.started_at/1000, 'unixepoch') >= ?");
      params.push(q.from);
    }
    if (q.to) {
      clauses.push("date(s.started_at/1000, 'unixepoch') <= ?");
      params.push(q.to);
    }
    if (q.tools?.length) {
      clauses.push(`s.tool IN (${q.tools.map(() => "?").join(",")})`);
      params.push(...q.tools);
    }
    const w = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    // 原来是对每个会话各发一条 `SUM(...) WHERE session_id=? AND tool=?`。
    // 20 个会话 = 20 次全表扫描（session_id 当时无索引），实测 207ms。
    // 改成「一次 GROUP BY + LEFT JOIN」：单趟扫描，走 idx_events_session。
    const rows = this.store
      .prep(
        `SELECT s.session_id, s.tool, s.started_at, s.ended_at, s.cwd, s.title, s.model, s.messages,
                COALESCE(u.total_tokens, 0)   AS total_tokens,
                COALESCE(u.input_tokens, 0)   AS input_tokens,
                COALESCE(u.output_tokens, 0)  AS output_tokens,
                COALESCE(u.cost_usd, 0)       AS cost_usd,
                COALESCE(u.requests, 0)       AS requests
           FROM sessions s
           LEFT JOIN (
             SELECT session_id, tool,
                    SUM(total_tokens)  AS total_tokens,
                    SUM(input_tokens)  AS input_tokens,
                    SUM(output_tokens) AS output_tokens,
                    SUM(cost_usd)      AS cost_usd,
                    COUNT(*)           AS requests
               FROM usage_events
              GROUP BY session_id, tool
           ) u ON u.session_id = s.session_id AND u.tool = s.tool
           ${w}
          ORDER BY s.started_at DESC
          LIMIT ?`,
      )
      .all(...params, limit);

    return rows.map((r) => ({ ...r, cost_usd: round(r.cost_usd) }));
  }

  /**
   * 模型速度。
   *
   * 口径：**生成区间**。
   *   同会话内按 ts 排序，相邻两条事件的间隔 ≈ 那次请求的生成时长，
   *   于是 tok/s = Σ输出token ÷ Σ生成秒数。
   *
   * 为什么不用「除以活跃分钟」：
   *   一个「活跃分钟」会被记满 60 秒，哪怕这一分钟里实际只生成了 8 秒——
   *   分母被撑大约 7 倍，速度被系统性低估。按真实区间算才是每秒速度。
   *
   * 区间过滤（依据实测分布：92,353 个区间）：
   *   < 1s    剔除：同一批事件的抖动，不是一次生成
   *   ≥ 300s  剔除：用户走开 / 换了任务，不是生成时长（占 0.9%，
   *           但不剔除会把整体速度从 ~26 tok/s 拉低到 0.8 tok/s）
   *   保留区间覆盖 92.6% 的样本。
   *
   * 注意：区间里含工具调用与排队时间，所以结果偏**保守**（模型真实生成更快）。
   *
   * 输出：
   *   latestByTool —— 每个工具**最近一次会话**用的模型与速度（不随范围过滤，问的就是「最新」）
   *   byModel / byTool / byDay / byHour / overall —— 当前范围内各维度的速度，同一口径
   */
  speed(q = {}) {
    const GAP_MIN = 1000;
    const GAP_MAX = 300000;
    const valid = `gap >= ${GAP_MIN} AND gap < ${GAP_MAX} AND output_tokens > 0`;
    /** 输出 token / 生成秒数 */
    const spd = (genOut, genMs) => (genMs > 0 ? genOut / (genMs / 1000) : 0);

    // ---- 每个工具最近一次会话 ----
    //
    // 从**事件表**取，而不是从 `sessions` 表：opencode 采集器压根没写 `sessions`
    // （2,443 个事件、11 个会话 id 在事件表里，`sessions` 里一条都没有），
    // 用 `sessions` 当主表会让整个工具从面板里消失。
    //
    // 这里依赖 SQLite 的一个明确保证：只含一个 MAX() 聚合时，裸列取自取到最大值那一行。
    // 所以 `session_id` / `cwd` / `model` 就是「该工具最后一条事件」所属的会话与模型。
    const latest = this.store
      .prep(
        `SELECT tool, session_id, cwd, model, MAX(ts) AS last_ts
           FROM usage_events
          GROUP BY tool`,
      )
      .all();

    // `sessions` 只用来补标题和开始时间（它是可选的）
    const sessionMeta = new Map(
      this.store
        .prep(`SELECT tool, session_id, title, started_at FROM sessions`)
        .all()
        .map((s) => [`${s.session_id}::${s.tool}`, s]),
    );

    let latestByTool = [];
    if (latest.length) {
      const tuples = latest.map(() => "(?, ?)").join(", ");
      const params = [];
      for (const s of latest) params.push(s.session_id, s.tool);
      const stats = new Map(
        this.store
          .prep(
            `WITH o AS (
               SELECT session_id, tool, ts, total_tokens, cache_read_tokens, output_tokens, cost_usd,
                      ts - LAG(ts) OVER (PARTITION BY session_id, tool ORDER BY ts) AS gap
                 FROM usage_events
                WHERE (session_id, tool) IN (VALUES ${tuples})
             )
             SELECT session_id, tool,
                    COUNT(*)                             AS requests,
                    COALESCE(SUM(total_tokens), 0)       AS tokens,
                    COALESCE(SUM(cache_read_tokens), 0)  AS cache_read,
                    COALESCE(SUM(output_tokens), 0)      AS out_tokens,
                    COALESCE(SUM(cost_usd), 0)           AS cost_usd,
                    MAX(ts)                              AS last_ts,
                    COUNT(*) FILTER (WHERE ${valid})                        AS intervals,
                    COALESCE(SUM(gap) FILTER (WHERE ${valid}), 0)           AS gen_ms,
                    COALESCE(SUM(output_tokens) FILTER (WHERE ${valid}), 0) AS gen_out
               FROM o
              GROUP BY session_id, tool`,
          )
          .all(...params)
          .map((r) => [`${r.session_id}::${r.tool}`, r]),
      );

      latestByTool = latest
        .map((s) => {
          const st = stats.get(`${s.session_id}::${s.tool}`);
          if (!st) return null;
          const meta = sessionMeta.get(`${s.session_id}::${s.tool}`) || {};
          return {
            tool: s.tool,
            session_id: s.session_id,
            cwd: s.cwd,
            title: meta.title ?? null,
            model: s.model,
            started_at: meta.started_at ?? s.last_ts,
            last_ts: st.last_ts || s.last_ts,
            requests: st.requests || 0,
            tokens: st.tokens || 0,
            cache_read: st.cache_read || 0,
            out_tokens: st.out_tokens || 0,
            intervals: st.intervals || 0,
            gen_seconds: Math.round((st.gen_ms || 0) / 1000),
            tok_per_sec: spd(st.gen_out || 0, st.gen_ms || 0),
            out_per_req: st.requests ? (st.out_tokens || 0) / st.requests : 0,
            cost_usd: round(st.cost_usd || 0),
          };
        })
        .filter((r) => r && r.requests > 0)
        .sort((a, b) => b.last_ts - a.last_ts);
    }

    // ---- 排行 / 分布：一次窗口扫描，按 (日, 时, 工具, 模型) 分组，其余维度在 JS 里汇总 ----
    //
    // 为什么只扫一趟：这四个维度的组合其实很稀疏（全历史实测只有 1,122 行），
    // 而这一趟 228ms。分四次 GROUP BY 就是 ~900ms——所以分组一次，其余 rollup。
    //
    // 模型名按**裸名**分组（去掉 provider 前缀）：否则 `opencode-go/deepseek-v4.1-flash`
    // 和 `deepseek-v4.1-flash` 会各占一行，前端用 bareModel() 显示成同名，看着像重复两行。
    //
    // 窗口函数必须在**范围过滤之前**算：否则范围内第一条事件没有前一条，
    // 间隔是 NULL，会白丢一个样本。所以 CTE 全表算窗口，外层再按 day 过滤。
    const w = this.#where(q);
    const bare = "CASE WHEN instr(model, '/') > 0 THEN substr(model, instr(model, '/') + 1) ELSE model END";
    const rows = this.store
      .prep(
        `WITH o AS (
           SELECT session_id, tool, ts, day, hour, model, total_tokens, cache_read_tokens, output_tokens,
                  ts - LAG(ts) OVER (PARTITION BY session_id, tool ORDER BY ts) AS gap
             FROM usage_events
         )
         SELECT day, hour, tool, ${bare} AS model,
                COUNT(*)                            AS requests,
                COALESCE(SUM(total_tokens), 0)      AS tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
                COALESCE(SUM(output_tokens), 0)     AS out_tokens,
                COUNT(*) FILTER (WHERE ${valid})                        AS intervals,
                COALESCE(SUM(gap) FILTER (WHERE ${valid}), 0)           AS gen_ms,
                COALESCE(SUM(output_tokens) FILTER (WHERE ${valid}), 0) AS gen_out
           FROM o ${w.sql}
          GROUP BY day, hour, tool, model`,
      )
      .all(...w.params);

    /**
     * 把上面那张细表按任意维度汇总。
     * 与旧口径的关键差别就在 `gen_ms`：这里累加的是**真实生成毫秒**，
     * 而旧口径用「记满 60 秒的活跃分钟数」或「完成所在的秒数」当分母——
     * 前者把 8 秒的生成算成 60 秒（低估 7 倍），后者把整次响应当成 1 秒（高估约 10 倍）。
     */
    const rollup = (keyOf) => {
      const acc = new Map();
      for (const r of rows) {
        const k = keyOf(r);
        let v = acc.get(k);
        if (!v) {
          v = { requests: 0, tokens: 0, cache_read: 0, out_tokens: 0, intervals: 0, gen_ms: 0, gen_out: 0 };
          acc.set(k, v);
        }
        v.requests += r.requests;
        v.tokens += r.tokens;
        v.cache_read += r.cache_read;
        v.out_tokens += r.out_tokens;
        v.intervals += r.intervals;
        v.gen_ms += r.gen_ms;
        v.gen_out += r.gen_out;
      }
      return [...acc.entries()].map(([key, v]) => ({
        key,
        requests: v.requests,
        tokens: v.tokens,
        cache_read: v.cache_read,
        out_tokens: v.out_tokens,
        intervals: v.intervals,
        gen_seconds: Math.round(v.gen_ms / 1000),
        tok_per_sec: spd(v.gen_out, v.gen_ms),
        out_per_req: v.requests ? v.out_tokens / v.requests : 0,
      }));
    };

    const modelRows = rollup((r) => r.model).sort((a, b) => b.out_tokens - a.out_tokens);
    const byModel = modelRows.slice(0, 12).map(({ key, ...rest }) => ({ model: key, ...rest }));
    const byTool = rollup((r) => r.tool).sort((a, b) => b.out_tokens - a.out_tokens);
    const byDay = rollup((r) => r.day).sort((a, b) => (a.key < b.key ? -1 : 1));

    const byHourMap = new Map(rollup((r) => r.hour).map((r) => [r.key, r]));
    const byHour = Array.from({ length: 24 }, (_, h) =>
      byHourMap.get(h) || {
        key: h,
        requests: 0,
        tokens: 0,
        cache_read: 0,
        out_tokens: 0,
        intervals: 0,
        gen_seconds: 0,
        tok_per_sec: 0,
        out_per_req: 0,
      },
    );

    const tot = rows.reduce(
      (a, r) => ({
        requests: a.requests + r.requests,
        tokens: a.tokens + r.tokens,
        cache_read: a.cache_read + r.cache_read,
        out_tokens: a.out_tokens + r.out_tokens,
        intervals: a.intervals + r.intervals,
        gen_ms: a.gen_ms + r.gen_ms,
        gen_out: a.gen_out + r.gen_out,
      }),
      { requests: 0, tokens: 0, cache_read: 0, out_tokens: 0, intervals: 0, gen_ms: 0, gen_out: 0 },
    );

    return {
      latestByTool,
      byModel,
      byTool,
      byDay,
      byHour,
      overall: {
        models: modelRows.length,
        requests: tot.requests,
        tokens: tot.tokens,
        cache_read: tot.cache_read,
        out_tokens: tot.out_tokens,
        intervals: tot.intervals,
        gen_seconds: Math.round(tot.gen_ms / 1000),
        tok_per_sec: spd(tot.gen_out, tot.gen_ms),
        out_per_req: tot.requests ? tot.out_tokens / tot.requests : 0,
      },
    };
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

/** 指定小数位的四舍五入（给文案用，避免把 9.5333 直接印给人看） */
function roundTo(n, digits) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * cwd 只保留最后两段，和前端 `shortPath` 保持一致。
 * cwd 里就是项目名，可能含客户名或内部代号——
 * 拼进建议文本就等于把它带出了本机。
 */
function shortPath(p) {
  if (!p) return "—";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return "…/" + parts.slice(-2).join("/");
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

/**
 * 碎片化指数 → 结论等级。
 *
 * 阈值不是拍的：1.0–1.5 属于正常（同一项目偶尔重开会话很正常），
 * 2.0 以上说明习惯性重开，到 3.0 基本是「每次提问都新开会话」。
 */
function verdictFor(fragmentation) {
  if (!(fragmentation > 1)) return "ok";
  if (fragmentation < 1.5) return "ok";
  if (fragmentation < 2) return "mild";
  if (fragmentation < 3) return "moderate";
  return "severe";
}

/**
 * 把统计翻译成能照着做的建议。
 *
 * 每条建议必须说清做什么（action）、依据哪个数字（why）、
 * 预计省多少（save，可为 null 表示取决于用法）。
 * 不写「优化缓存」这种没法执行的话——用户要的是「把同一份上下文
 * 留在一个会话里继续用」这种具体到动作的句子。
 */
function adviceFor({ fragmentation, rows, totalWasteUsd }) {
  const out = [];
  const top = rows[0];

  if (fragmentation > 1.5) {
    out.push({
      kind: "fragmentation",
      severity: verdictFor(fragmentation),
      action: "把同一份上下文留在同一个会话里继续用，别每次提问都新开会话",
      why: `平均每个项目开了 ${roundTo(fragmentation, 1)} 个会话。每个新会话的第一枪没有缓存可读，只能按 input 全价计费——这是纯粹的学费。`,
      save: totalWasteUsd > 0 ? totalWasteUsd : null,
    });
  }

  if (top && top.waste_usd > 0) {
    out.push({
      kind: "project",
      severity: top.waste_share >= 5 ? "severe" : top.waste_share >= 2 ? "moderate" : "mild",
      // 只用最后两段，和前端 shortPath 一致——cwd 里就是项目名，
      // 可能是客户名或内部代号，绝不能整段出现在建议文本里。
      action: `优先改 ${shortPath(top.cwd)}：它占了最多学费`,
      why: `这个项目的首轮学费合计 $${roundTo(top.waste_usd, 2)}，是全部项目里最高的——它有 ${top.sessions} 个会话，每次开工都要重新喂一遍上下文。`,
      save: top.waste_usd,
    });
  }

  // 首轮占比很高说明上下文在反复重建，不只是会话数多
  const heavy = rows.find((r) => r.first_input_tokens > 0 && r.waste_share >= 20);
  if (heavy) {
    out.push({
      kind: "context",
      severity: "moderate",
      action: `看看 ${shortPath(heavy.cwd)} 每次开工在读什么：是不是每次都要重新读一遍大文件？`,
      why: `${shortPath(heavy.cwd)} 的首轮新鲜输入有 ${heavy.first_input_tokens.toLocaleString("en-US")} token，占该项目成本的 ${roundTo(heavy.waste_share, 1)}%——如果这些内容本来就在缓存里，本不该重复付费。`,
      save: heavy.waste_usd,
    });
  }

  if (out.length === 0) {
    out.push({
      kind: "ok",
      severity: "ok",
      action: "保持现在的习惯",
      why: "项目与会话基本一一对应，冷启动学费已经压到很低了。",
      save: 0,
    });
  }

  return out;
}
