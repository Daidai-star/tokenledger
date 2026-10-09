import { useMemo, useState } from "react";
import {
  BAND_HINTS,
  BAND_NAMES,
  computeMall,
  cartSummary,
  fmtCNY,
  fmtCNYVerbose,
  type Band,
  type MallResult,
  type MallRow,
} from "../mall";
import { downloadBlob, renderShareCard } from "../share";
import { fmtInt, tokens } from "../format";

/**
 * 「购买力」区：把累计 API 账单折算成实物。
 *
 * 纯本地计算，不联网、不上传——这个区的全部趣味来自表达方式，
 * 不依赖任何外部数据源，所以离线也能用。
 *
 * 三个层次，从信息到情绪：
 *   标尺   你在 ¥88 ~ ¥5800 万 这个跨度上站在哪（对数轴，否则便宜的挤成一团）
 *   目标   下一个买得起的商品还差多少（留白的部分比已有的部分更粘人）
 *   购物车  真拿这笔钱去买东西，你会买什么
 */

interface Props {
  costUsd: number | null;
  /** 分享卡片需要的原始统计量 */
  stats: ShareStats;
}

export interface ShareStats {
  totalTokens: number;
  requests: number;
  models: number;
  activeDays: number;
  span: string;
  tools: { name: string; tokens: number; color: string }[];
}

export function MallSection({ costUsd, stats }: Props) {
  const m = useMemo(() => computeMall(costUsd), [costUsd]);
  const empty = !costUsd || m.budget <= 0;

  async function share() {
    if (!m.best) return;
    const blob = await renderShareCard({
      costUsd,
      totalTokens: stats.totalTokens,
      requests: stats.requests,
      models: stats.models,
      activeDays: stats.activeDays,
      bestLabel: `${m.best.emoji} ${m.best.name}`,
      budgetCNY: m.budget,
      budgetVerbose: fmtCNYVerbose(m.budget),
      span: stats.span,
      tools: stats.tools,
    });
    downloadBlob(blob, `tokenledger-${new Date().toISOString().slice(0, 10)}.png`);
  }

  return (
    <section className="section mall">
      <div className="section-head">
        <div>
          <h2>购买力</h2>
          <div className="sub">把累计账单折成实物 · 全部在本机计算</div>
        </div>
        {m.best && (
          <div className="mall-head-right">
            <div className="mall-best">
              <span className="mall-best-k">已经能拿下</span>
              <span className="mall-best-v">
                {m.best.emoji} {m.best.name}
              </span>
            </div>
            <button className="btn mall-share" onClick={share} title="生成 PNG 保存到本地">
              分享这张账
            </button>
          </div>
        )}
      </div>

      {empty ? (
        <div className="mall-empty">
          还没有可折算的账单。等扫描到用量后，这里会显示你的累计消费力。
        </div>
      ) : (
        <>
          <MallHero m={m} />
          <Rail m={m} />
          {m.savingTo && <Goal m={m} />}
          <Cart m={m} />
          <Ladder m={m} />
          <p className="mall-foot">
            价格为 2026 年国内参考零售价，汇率按 1 USD = ¥{m.rate} 固定折算（非实时）。
            这是一个趣味估算，不代表任何报价，也不含订阅制费用。
          </p>
        </>
      )}
    </section>
  );
}

/** 顶部大字：折算金额 + 中文读法 + 跨了几个档 */
function MallHero({ m }: { m: MallResult }) {
  return (
    <div className="mall-hero">
      <div className="mall-hero-main">
        <div className="k">累计账单折合</div>
        <div className="v">{fmtCNY(m.budget)}</div>
        <div className="s">{fmtCNYVerbose(m.budget)}</div>
      </div>
      <div className="mall-hero-side">
        <div>
          <div className="k">解锁档位</div>
          <div className="v small">
            {m.tier >= 0 ? BAND_NAMES[m.tier] : "尚未解锁"}
          </div>
        </div>
        <div>
          <div className="k">可购品类</div>
          <div className="v small">{m.cart.length} 样</div>
        </div>
      </div>
    </div>
  );
}

/**
 * 对数标尺。价格跨 6 个数量级，线性轴上便宜的会全挤在最左边，
 * 所以位置一律用 mall.ts 算好的对数比例。
 */
function Rail({ m }: { m: MallResult }) {
  const pct = Math.max(0, Math.min(100, m.pos * 100));
  // 贴边时标签会有一半跑到容器外，改成靠边对齐
  const edge = pct < 6 ? " start" : pct > 94 ? " end" : "";
  const lo = m.rows[0];
  const hi = m.rows[m.rows.length - 1];

  return (
    <div className="mall-rail">
      <div className="rail-track">
        <div className="rail-fill" style={{ width: `${pct}%` }} />
        {m.rows.map((r) => (
          <div
            key={r.id}
            className={`rail-tick${r.affordable ? " on" : ""}`}
            style={{ left: `${r.pos * 100}%` }}
            title={`${r.name} · ${fmtCNY(r.price)}`}
          />
        ))}
        <div className={`rail-you${edge}`} style={{ left: `${pct}%` }}>
          <span>你在这里</span>
        </div>
      </div>
      <div className="rail-legend">
        <span>
          {lo.emoji} {fmtCNY(lo.price)}
        </span>
        <span className="mid">{fmtCNY(m.budget)}</span>
        <span>
          {fmtCNY(hi.price)} {hi.emoji}
        </span>
      </div>
    </div>
  );
}

/** 下一个目标：留白比成就更有牵引力，所以给它一整条进度 */
function Goal({ m }: { m: MallResult }) {
  const s = m.savingTo;
  if (!s) return null;
  const t = s.item;
  return (
    <div className="mall-goal">
      <div className="goal-emoji">{t.emoji}</div>
      <div className="goal-body">
        <div className="goal-title">
          再攒 <b>{fmtCNY(s.need)}</b> 就能拿下 {t.name}
        </div>
        <div className="goal-track">
          <div className="goal-fill" style={{ width: `${s.progress * 100}%` }} />
        </div>
        <div className="goal-sub">{t.hint}</div>
      </div>
    </div>
  );
}

/** 购物车：做成小票的样子，数字右对齐读起来更像账 */
function Cart({ m }: { m: MallResult }) {
  if (!m.cart.length) return null;
  return (
    <div className="mall-cart">
      <div className="cart-head">
        <h3>如果真拿这笔钱去买</h3>
        <span className="cart-total">{fmtCNY(m.cartTotal)}</span>
      </div>
      <div className="cart-lines">
        {m.cart.map((c) => (
          <div className="cart-line" key={c.item.id}>
            <span className="cl-emoji">{c.item.emoji}</span>
            <span className="cl-name">{c.item.name}</span>
            <span className="cl-qty">×{c.count}</span>
            <span className="cl-sum">{fmtCNY(c.total)}</span>
          </div>
        ))}
      </div>
      <div className="cart-summary">{cartSummary(m.cart, 4)}</div>
    </div>
  );
}

/** 商品阶梯：按档位分组，买得起的点亮，买不起的标出还差多少 */
function Ladder({ m }: { m: MallResult }) {
  const bands = [0, 1, 2, 3] as Band[];
  return (
    <div className="mall-ladder">
      {bands.map((b) => {
        const items = m.rows.filter((r) => r.band === b);
        if (!items.length) return null;
        return (
          <div className="mall-band" key={b}>
            <div className="band-head">
              <span className="band-name">{BAND_NAMES[b]}</span>
              <span className="band-hint">{BAND_HINTS[b]}</span>
              <span className="band-range">
                {fmtCNY(items[0].price)} – {fmtCNY(items[items.length - 1].price)}
              </span>
            </div>
            <div className="band-items">
              {items.map((r) => (
                <Item key={r.id} r={r} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Item({ r }: { r: MallRow }) {
  return (
    <div className={`mall-item${r.affordable ? " on" : " off"}`}>
      <div className="mi-emoji">{r.emoji}</div>
      <div className="mi-name">{r.name}</div>
      <div className="mi-price">{fmtCNY(r.price)}</div>
      <div className="mi-get">
        {r.affordable ? (
          <>
            能买 <b>{r.count}</b> 件
          </>
        ) : (
          <>差 {fmtCNY(r.shortfall)}</>
        )}
      </div>
      <div className="mi-hint">{r.hint}</div>
    </div>
  );
}
