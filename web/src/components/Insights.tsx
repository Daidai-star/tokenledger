import { RankBars, TrendChart } from "./Charts";
import { fmtCost, fmtInt, shortPath, tokens } from "../format";
import type { ColdStartData, ProjectRow } from "../types";

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
          {rows.length > 12 && (
            <div className="peak-note">另有 {fmtInt(rows.length - 12)} 个项目未列出。</div>
          )}
        </div>
      </div>
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
