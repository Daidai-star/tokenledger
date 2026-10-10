import { RankBars, TrendChart } from "./Charts";
import { fmtCost, fmtInt, shortPath, tokens } from "../format";
import type { ColdStartData, GuardData, ProjectRow, WasteData } from "../types";

/**
 * 项目账单：钱花在哪个项目上。
 *
 * cwd 从采集第一天就落库了，但此前没有任何界面用它——而这恰恰是唯一真正
 * 让人有 sense 的维度：全局总量只告诉你花了多少，按项目拆开才告诉你花在哪。
 *
 * 隐私：cwd 里就是项目名，可能含客户名或内部代号。所以这一块只在本机渲染，
 * 用 `shortPath` 只留最后两段，并且永远不进任何上传/分享路径。
 */
export function ProjectSection({ rows }: { rows: ProjectRow[] }) {
  if (!rows.length) {
    return (
      <section className="section">
        <div className="section-head">
          <h2>项目账单</h2>
        </div>
        <div className="panel">
          <div className="empty-hint">没有带工作目录的用量记录</div>
        </div>
      </section>
    );
  }

  const top = rows[0];
  const total = rows.reduce((a, r) => a + r.total_tokens, 0);
  const topShare = total > 0 ? (top.total_tokens / total) * 100 : 0;
  const hits = rows.filter((r) => r.total_tokens > 0).map((r) => r.cache_hit_rate);
  const worst = rows.reduce((a, b) => (b.cache_hit_rate < a.cache_hit_rate ? b : a), rows[0]);

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>项目账单</h2>
          <div className="sub">
            {fmtInt(rows.length)} 个项目 · 路径只在本机显示，且只展示最后两段
          </div>
        </div>
      </div>

      <div className="rate-hero">
        <div className="rate-cell primary">
          <div className="k">最大项目占比</div>
          <div className="v">
            {topShare.toFixed(1)}
            <small>%</small>
          </div>
          <div className="s">{shortPath(top.cwd)}</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "60ms" }}>
          <div className="k">最大项目 Token</div>
          <div className="v">{tokens(top.total_tokens)}</div>
          <div className="s">
            {fmtInt(top.requests)} 次请求 · {fmtInt(top.sessions)} 会话
          </div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "120ms" }}>
          <div className="k">缓存命中最高</div>
          <div className="v">
            {Math.max(...hits).toFixed(1)}
            <small>%</small>
          </div>
          <div className="s">上下文复用得最好</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "180ms" }}>
          <div className="k">缓存命中最低</div>
          <div className="v">
            {worst.cache_hit_rate.toFixed(1)}
            <small>%</small>
          </div>
          <div className="s">{shortPath(worst.cwd)}</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "240ms" }}>
          <div className="k">项目成本合计</div>
          <div className="v">{fmtCost(rows.reduce((a, r) => a + r.cost_usd, 0))}</div>
          <div className="s">按已落库事件估算</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>Token 分布</h2>
            <span className="sub">前 10 个项目</span>
          </div>
          <RankBars
            rows={rows.slice(0, 10).map((r) => ({
              key: r.cwd,
              label: shortPath(r.cwd),
              sub: `${fmtInt(r.requests)} 次`,
              value: r.total_tokens,
              color: "var(--c-clay)",
              extra: r.cost_usd > 0 ? fmtCost(r.cost_usd) : "—",
            }))}
          />
        </div>

        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>明细</h2>
            <span className="sub">缓存命中率差异 = 上下文复用策略的差异</span>
          </div>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>请求</th>
                  <th>Token</th>
                  <th>命中</th>
                  <th>成本</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 12).map((r) => (
                  <tr key={r.cwd}>
                    <td>
                      <span className="proj-path" title={r.cwd}>
                        {shortPath(r.cwd)}
                      </span>
                    </td>
                    <td>{fmtInt(r.requests)}</td>
                    <td>{tokens(r.total_tokens)}</td>
                    <td>{r.cache_hit_rate.toFixed(1)}%</td>
                    <td>{r.cost_usd > 0 ? fmtCost(r.cost_usd) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 12 && (
            <div className="peak-note">另有 {fmtInt(rows.length - 12)} 个项目未列出。</div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * 预算护栏：单会话成本的分布，以及超出提醒线的那些会话。
 *
 * 为什么要做这个：本机实测 200 个会话，单会话成本中位数 $1.72、
 * 最高 $180.12——差 105 倍。多数人看到「平均 $X」毫无感觉，
 * 因为真正吃钱的永远是那几个例外。护栏把这些例外单独拎出来。
 *
 * 提醒线不是拍出来的，是跟着用户自己的历史走的：
 * max($5 下限, P90)。写死一个数要么永远不响，要么天天打扰。
 *
 * 隐私：cwd 只留最后两段，同 ProjectSection。
 */
export function GuardSection({ data }: { data: GuardData }) {
  if (!data.sessions) {
    return (
      <section className="section">
        <div className="section-head">
          <h2>预算护栏</h2>
          <span className="sub">单会话成本的分布</span>
        </div>
        <div className="panel">
          <div className="empty-hint">还没有带成本的会话记录</div>
        </div>
      </section>
    );
  }

  const overByProject = new Map<string, number>();
  for (const o of data.over) {
    if (!o.cwd) continue;
    const k = shortPath(o.cwd);
    overByProject.set(k, (overByProject.get(k) || 0) + o.cost_usd);
  }
  const topProjects = [...overByProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  // 对数刻度：分布差 100 倍，线性刻度下小会话会挤成一条线看不见。
  // 分母用各自的组内最大值——项目汇总会超过单会话最高值，
  // 混用同一个分母会让条形溢出面板（第一版就踩了这个）。
  const logScale = (v: number, max: number) =>
    max > 0 ? Math.max(1.5, (Math.log10(Math.max(0.01, v)) / Math.log10(Math.max(1, max))) * 100) : 0;
  const sessionMax = Math.max(data.maxUsd, data.warnUsd, data.medianUsd, 1);
  const projMax = Math.max(...topProjects.map(([, c]) => c), 1);

  return (
    <section className="section guard">
      <div className="section-head">
        <div>
          <h2>预算护栏</h2>
          <div className="sub">
            提醒线按你最近 {fmtInt(data.sessions)} 个会话的分布算，不是固定值
          </div>
        </div>
      </div>

      <div className="stat-row guard-stats">
        <div className="stat">
          <div className="k">提醒线</div>
          <div className="v">{fmtCost(data.warnUsd)}</div>
          <div className="s">
            单会话超过 {fmtCost(data.warnUsd)} 就该看一眼
            {data.warnUsd === data.warnFloor && "（你的会话都很便宜，用的是下限）"}
          </div>
        </div>
        <div className="stat">
          <div className="k">典型会话</div>
          <div className="v">{fmtCost(data.medianUsd)}</div>
          <div className="s">中位数——多数会话的真实量级</div>
        </div>
        <div className="stat">
          <div className="k">最贵一单</div>
          <div className="v guard-max">{fmtCost(data.maxUsd)}</div>
          <div className="s">是中位数的 {fmtInt(Math.round(data.spread))} 倍</div>
        </div>
        <div className="stat">
          <div className="k">超线会话</div>
          <div className="v">
            {fmtInt(data.over.length)}
            <span className="unit">个</span>
          </div>
          <div className="s">合计 {fmtCost(data.totalOverUsd)}</div>
        </div>
      </div>

      <div className="panel">
        <div className="section-head" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16 }}>成本分布</h2>
          <span className="sub">对数刻度——线性刻度下这些会话会挤成一条线</span>
        </div>

        <div className="guard-scale">
          <div className="guard-scale-row">
            <span className="guard-scale-k">中位数</span>
            <div className="guard-bar guard-bar-median" style={{ width: `${logScale(data.medianUsd, sessionMax)}%` }} />
            <span className="guard-scale-v">{fmtCost(data.medianUsd)}</span>
          </div>
          <div className="guard-scale-row">
            <span className="guard-scale-k">提醒线</span>
            <div className="guard-bar guard-bar-warn" style={{ width: `${logScale(data.warnUsd, sessionMax)}%` }} />
            <span className="guard-scale-v">{fmtCost(data.warnUsd)}</span>
          </div>
          <div className="guard-scale-row">
            <span className="guard-scale-k">最贵</span>
            <div className="guard-bar guard-bar-max" style={{ width: `${logScale(data.maxUsd, sessionMax)}%` }} />
            <span className="guard-scale-v">{fmtCost(data.maxUsd)}</span>
          </div>
        </div>

        {topProjects.length > 0 && (
          <>
            <div className="section-head guard-sub" style={{ margin: "26px 0 14px" }}>
              <h2 style={{ fontSize: 16 }}>超线会话花在哪</h2>
              <span className="sub">按项目汇总</span>
            </div>
            <div className="guard-projects">
              {topProjects.map(([name, cost], i) => (
                <div key={name} className="guard-project" title={name}>
                  <span className="guard-project-k">{name}</span>
                  <div className="guard-track">
                    <div className="guard-bar guard-bar-proj" style={{ width: `${logScale(cost, projMax)}%` }} />
                  </div>
                  <span className="guard-project-v">{fmtCost(cost)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="peak-note">
          这里算的是 API 等价成本，不是厂商账单。订阅用户请以「额度够不够用」为准。
          提醒线是统计参考，不是系统限制——我们不会中断你的任何会话。
        </div>
      </div>

      {data.over.length > 0 && (
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>超线会话</h2>
            <span className="sub">最贵的 {Math.min(12, data.over.length)} 个</span>
          </div>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>请求</th>
                  <th>Token</th>
                  <th>成本</th>
                  <th>倍数</th>
                </tr>
              </thead>
              <tbody>
                {data.over.slice(0, 12).map((o) => (
                  <tr key={o.session_id}>
                    <td>
                      <span className="proj-path" title={o.cwd || o.session_id}>
                        {o.cwd ? shortPath(o.cwd) : o.session_id.slice(0, 16)}
                      </span>
                    </td>
                    <td>{fmtInt(o.requests)}</td>
                    <td>{tokens(o.total_tokens)}</td>
                    <td>{fmtCost(o.cost_usd)}</td>
                    <td>
                      {data.medianUsd > 0
                        ? `${Math.round(o.cost_usd / data.medianUsd)}×`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.over.length > 12 && (
            <div className="peak-note">另有 {fmtInt(data.over.length - 12)} 个超线会话未列出。</div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 浪费诊断：把「缓存爬升多快」变成「你多花了多少、怎么改」。
 *
 * 前两块区块是描述——项目账单告诉你钱在哪，冷启动告诉你命中率怎么爬。
 * 但用户真正要的是下一步动作。codeburn 那套 `optimize` 的价值就在这里：
 * 不给「命中率 52%」，给「这个项目每次开工都重新喂上下文，每月多烧 $3」。
 *
 * 这里的每个建议都带三件事：做什么（action）、依据哪个数字（why）、
 * 能省多少（save）。没有依据的数字不写进建议——那是猜。
 *
 * 隐私：同 ProjectSection，cwd 只显示最后两段，不进分享路径。
 */
export function WasteSection({ data }: { data: WasteData }) {
  if (!data.projects) {
    return (
      <section className="section">
        <div className="section-head">
          <h2>浪费诊断</h2>
          <span className="sub">会话切碎是缓存账单的主要来源</span>
        </div>
        <div className="panel">
          <div className="empty-hint">没有带工作目录的用量记录，无法判断会话碎片</div>
        </div>
      </section>
    );
  }

  const sevLabel: Record<WasteData["verdict"], string> = {
    ok: "良好",
    mild: "轻微",
    moderate: "中度",
    severe: "明显",
  };

  return (
    <section className="section waste">
      <div className="section-head">
        <div>
          <h2>浪费诊断</h2>
          <div className="sub">
            会话切碎是缓存账单的主要来源 · 按缓存读 1/{data.discount} 折扣反推
          </div>
        </div>
      </div>

      <div className="stat-row waste-stats">
        <div className="stat">
          <div className="k">碎片化指数</div>
          <div className={`v waste-verdict waste-${data.verdict}`}>
            {data.fragmentation.toFixed(1)}
            <span className="unit">×</span>
          </div>
          <div className="s">
            平均每个项目 {data.fragmentation.toFixed(1)} 个会话 · 共 {fmtInt(data.sessions)} 个 · {sevLabel[data.verdict]}
          </div>
        </div>
        <div className="stat">
          <div className="k">首轮学费合计</div>
          <div className="v">{fmtCost(data.total_waste_usd)}</div>
          <div className="s">每次新会话第一枪本可省下的钱（估算）</div>
        </div>
        <div className="stat">
          <div className="k">最该改的项目</div>
          <div className="v waste-path" title={data.rows[0]?.cwd}>
            {shortPath(data.rows[0]?.cwd ?? null)}
          </div>
          <div className="s">首轮学费 {fmtCost(data.rows[0]?.waste_usd ?? 0)}</div>
        </div>
      </div>

      <div className="panel">
        <div className="section-head" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16 }}>建议</h2>
          <span className="sub">按预计可省金额排序</span>
        </div>

        <div className="waste-advice">
          {data.advice.map((a, i) => (
            <div key={i} className={`waste-advice-row waste-${a.severity}`}>
              <div className="waste-advice-sev" aria-hidden />
              <div className="waste-advice-body">
                <div className="waste-advice-action">{a.action}</div>
                <div className="waste-advice-why">{a.why}</div>
              </div>
              {a.save !== null && a.save > 0 && (
                <div className="waste-advice-save">
                  <span className="k">可省</span>
                  <span className="v">{fmtCost(a.save)}</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="peak-note">
          估算口径：首轮的新鲜输入按 1/{data.discount} 缓存价反推，
          并非厂商账单。订阅用户请以「额度是否够用」为准——
          这里算的是 API 等价成本。
        </div>
      </div>

      {data.rows.length > 0 && (
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16 }}>按项目</h2>
            <span className="sub">首轮学费 = 每次开工重新喂上下文的代价</span>
          </div>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>会话</th>
                  <th>首轮输入</th>
                  <th>学费</th>
                  <th>占成本</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 12).map((r) => (
                  <tr key={r.cwd}>
                    <td>
                      <span className="proj-path" title={r.cwd}>
                        {shortPath(r.cwd)}
                      </span>
                    </td>
                    <td>{fmtInt(r.sessions)}</td>
                    <td>{tokens(r.first_input_tokens)}</td>
                    <td>{r.waste_usd > 0 ? fmtCost(r.waste_usd) : "—"}</td>
                    <td>{r.waste_share > 0 ? `${r.waste_share.toFixed(1)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.rows.length > 12 && (
            <div className="peak-note">另有 {fmtInt(data.rows.length - 12)} 个项目未列出。</div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 缓存冷启动诊断。
 *
 * 每个新会话的第一枪必然没有缓存可读，之后才逐步爬升。这是结构性的，不是配置问题，
 * 所以这里不做「优化建议」，只把爬升曲线摆出来，让冷启动的量级可见。
 */
export function ColdStartSection({ data }: { data: ColdStartData }) {
  const { curve, sessions } = data;
  if (!sessions || !curve.length) {
    return (
      <section className="section">
        <div className="section-head">
          <h2>缓存冷启动</h2>
        </div>
        <div className="panel">
          <div className="empty-hint">没有可分析的会话</div>
        </div>
      </section>
    );
  }

  const gain = data.warmHitRate - data.coldHitRate;
  const labels = curve.map((c) => `第 ${c.rn} 次`);
  const peak = curve[curve.length - 1];

  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2>缓存冷启动</h2>
          <div className="sub">
            按会话内请求序号统计的缓存命中率 —— {fmtInt(sessions)} 个会话
          </div>
        </div>
      </div>

      <div className="rate-hero">
        <div className="rate-cell primary">
          <div className="k">首请求命中</div>
          <div className="v">
            {data.coldHitRate.toFixed(1)}
            <small>%</small>
          </div>
          <div className="s">每个会话的第一枪，没有缓存可读</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "60ms" }}>
          <div className="k">第二次命中</div>
          <div className="v">
            {data.warmHitRate.toFixed(1)}
            <small>%</small>
          </div>
          <div className="s">
            一次就补上 <b>{gain.toFixed(1)}</b> 个百分点
          </div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "120ms" }}>
          <div className="k">曲线终点</div>
          <div className="v">
            {peak.cache_hit_rate.toFixed(1)}
            <small>%</small>
          </div>
          <div className="s">第 {peak.rn} 次请求时</div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "180ms" }}>
          <div className="k">冷启动溢价</div>
          <div className="v">
            {data.coldPremiumUsd == null ? "—" : fmtCost(data.coldPremiumUsd)}
          </div>
          <div className="s">
            按缓存读 1/{data.discount} 折扣反推
            {data.coldPremiumPerSession != null && ` · 每会话 ${fmtCost(data.coldPremiumPerSession)}`}
          </div>
        </div>
        <div className="rate-cell" style={{ animationDelay: "240ms" }}>
          <div className="k">首请求新鲜输入</div>
          <div className="v">
            {data.firstRequest ? tokens(data.firstRequest.input_tokens) : "—"}
          </div>
          <div className="s">这部分必然按 input 价计费</div>
        </div>
      </div>

      <div className="panel">
        <div className="section-head" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16 }}>命中率爬升曲线</h2>
          <span className="sub">横轴为会话内的第几次请求</span>
        </div>
        <TrendChart
          labels={labels}
          xFormat={(s) => s}
          yFormat={(n) => `${Math.round(n)}%`}
          series={[
            {
              key: "hit",
              label: "缓存命中率",
              color: "var(--c-sage)",
              values: curve.map((c) => c.cache_hit_rate),
            },
          ]}
          height={220}
        />
        <div className="peak-note">
          从第 1 次的 <b>{data.coldHitRate.toFixed(1)}%</b> 爬到第 2 次的{" "}
          <b>{data.warmHitRate.toFixed(1)}%</b>。也就是说，把同一份上下文留在同一个会话里继续用，
          比每次开新会话重新喂一遍要划算得多 —— 会话切碎是缓存账单的主要来源。
        </div>
      </div>
    </section>
  );
}
