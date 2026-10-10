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
         FROM usage_events ${w.where}
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
