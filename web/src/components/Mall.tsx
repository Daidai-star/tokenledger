import { useEffect, useMemo, useState } from "react";
import {
  BAND_HINTS,
  BAND_NAMES,
  cartSummary,
  computeMall,
  fmtCNY,
  fmtCNYVerbose,
  randomCart,
  type Band,
  type CartLine,
  type MallResult,
  type MallRow,
} from "../mall";
import { ItemIcon } from "./MallIcons";
import { downloadBlob, renderShareCard } from "../share";
import { fmtInt, tokens } from "../format";

/**
 * 「购买力」区：把累计 API 账单折算成实物。
 *
 * 纯本地计算，不联网、不上传——这个区的全部趣味来自表达方式，
 * 不依赖任何外部数据源，所以离线也能用。
 *
 * 版面从「信息 -> 情绪」排下来：
 *   标尺   你在 ¥88 ~ ¥5800 万 这个跨度上站在哪（对数轴，否则便宜的挤成一团）
 *   时间   每个编码小时烧掉多少、下一件还要写几天（把金额翻译成自己的时间）
 *   目标   下一个买得起的商品还差多少（留白的部分比已有的部分更粘人）
 *   小票   真拿这笔钱去买会买什么；给一个「乱花一通」按钮，随机再花一次
 *   图录   16 件商品，买得起的点亮，买不起的给出进度
 *
 * 商品图标是手绘 SVG 线稿（见 MallIcons.tsx），不是 emoji——
 * emoji 的形状由系统字体决定，跨平台不一致，也没法跟随主题。
 */

interface Props {
  costUsd: number | null;
  /** 累计活跃编码小时，用来把账单换算成「每小时多少钱」 */
  activeHours: number;
  /** 日均成本（元），用来把差额换算成「还要写几天」 */
  dailyCost: number;
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

export function MallSection({ costUsd, activeHours, dailyCost, stats }: Props) {
  const m = useMemo(
    () => computeMall(costUsd, { activeHours, dailyCost }),
    [costUsd, activeHours, dailyCost],
  );
  const empty = !costUsd || m.budget <= 0;
  const [copied, setCopied] = useState(false);
  /** 非 null 表示当前小票是「乱花一通」的结果 */
  const [spree, setSpree] = useState<ReturnType<typeof randomCart> | null>(null);

  // 预算变了（切时间范围）就把随机小票清掉，否则会与实际预算对不上
  useEffect(() => setSpree(null), [m.budget]);

  async function share() {
    if (!m.best) return;
    const blob = await renderShareCard({
      costUsd,
      totalTokens: stats.totalTokens,
      requests: stats.requests,
      models: stats.models,
      activeDays: stats.activeDays,
      bestLabel: m.best.name,
      bestIcon: m.best.icon,
      budgetCNY: m.budget,
      budgetVerbose: fmtCNYVerbose(m.budget),
      span: stats.span,
      tools: stats.tools,
    });
    downloadBlob(blob, `tokenledger-${new Date().toISOString().slice(0, 10)}.png`);
  }

  /**
   * 配图发 X / 朋友圈时直接粘贴的文案。
   * 只说本机能验证的事实——累计账单折成实物、总量、不含项目路径，
   * 避免用户贴出去之后被追问「哪家公司哪个项目」。
   */
  function shareText(): string {
    if (!m.best) return "";
    const lines = [
      `我的 AI coding 账单折起来是 ${fmtCNY(m.budget)}，`,
      `刚好够买一台 ${m.best.name}。`,
      "",
      `${tokens(stats.totalTokens)} token · ${fmtInt(stats.requests)} 次请求 · ${stats.models} 个模型 · ${stats.activeDays} 天`,
      "",
      "用 TokenLedger 统计的——读本机日志，不联网、不上传：",
      "github.com/Daidai-star/tokenledger",
    ];
    return lines.join("\n");
  }

  async function copyText() {
    const t = shareText();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      // 非安全上下文（http 局域网调试）下 clipboard 不可用，退回选中提示
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
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
                <ItemIcon id={m.best.icon} size={20} />
                {m.best.name}
              </span>
            </div>
            <button className="btn mall-share" onClick={share} title="生成 PNG 保存到本地">
              分享这张账
            </button>
            <button
              className="btn mall-share"
              onClick={copyText}
              title="复制配文，发 X / 朋友圈时直接粘贴"
            >
              {copied ? "已复制" : "复制配文"}
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
          <Cart
            m={m}
            spree={spree}
            onReroll={() => setSpree(randomCart(m.rows, m.budget))}
            onReset={() => setSpree(null)}
          />
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

/**
 * 顶部大字：折算金额 + 中文读法 + 时间换算。
 *
 * 「每个编码小时」这个数其实是本区最有信息量的一项——它把一笔
 * 看着很大的总额，翻译成一个人人都能对标的单价。
 */
function MallHero({ m }: { m: MallResult }) {
  return (
    <div className="mall-hero">
      <div className="mall-hero-main">
        <div className="k">累计账单折合</div>
        <div className="v">{fmtCNY(m.budget)}</div>
        <div className="s">{fmtCNYVerbose(m.budget)}</div>
      </div>
      <div className="mall-hero-side">
        {m.perHour > 0 && (
          <div className="hero-perhour">
            <div className="k">每个编码小时</div>
            <div className="v small">{fmtCNY(m.perHour)}</div>
            <div className="s">累计 {fmtInt(m.activeHours)} 小时</div>
          </div>
        )}
        <div>
          <div className="k">解锁档位</div>
          <div className="v small">{m.tier >= 0 ? BAND_NAMES[m.tier] : "尚未解锁"}</div>
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
        <span>{fmtCNY(lo.price)}</span>
        <span className="mid">{fmtCNY(m.budget)}</span>
        <span>{fmtCNY(hi.price)}</span>
      </div>
    </div>
  );
}

/**
 * 下一个目标：留白比成就更有牵引力，所以给它一整条进度。
 *
 * 除了「还差多少钱」，再补一句「按你的日均成本还要写几天」——
 * 同样的差额，换成天数就有了具体的重量。
 */
function Goal({ m }: { m: MallResult }) {
  const s = m.savingTo;
  if (!s) return null;
  const t = s.item;
  const days = m.daysTo != null ? Math.ceil(m.daysTo) : null;
  return (
    <div className="mall-goal">
      <div className="goal-icon">
        <ItemIcon id={t.icon} size={40} />
      </div>
      <div className="goal-body">
        <div className="goal-title">
          再攒 <b>{fmtCNY(s.need)}</b> 就能拿下 {t.name}
        </div>
        <div className="goal-track">
          <div className="goal-fill" style={{ width: `${s.progress * 100}%` }} />
        </div>
        <div className="goal-sub">
          {t.hint}
          {days != null && (
            <>
              {" · "}按日均 {fmtCNY(m.dailyCost)} 算，<b>再写 {fmtInt(days)} 天</b>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface CartProps {
  m: MallResult;
  spree: ReturnType<typeof randomCart> | null;
  onReroll: () => void;
  onReset: () => void;
}

/**
 * 购物车：做成小票的样子，数字右对齐读起来更像账。
 *
 * 「乱花一通」是这一区唯一的交互点：把贪心最优解换成一次随机的挥霍。
 * 算计了 16 件商品的价格之后，人其实更想看看「不管了，随便买」是什么样。
 */
function Cart({ m, spree, onReroll, onReset }: CartProps) {
  const lines: CartLine[] = spree ? spree.cart : m.cart;
  const total = spree ? spree.total : m.cartTotal;
  const left = Math.max(0, m.budget - total);
  if (!lines.length) return null;

  return (
    <div className="mall-cart">
      <div className="cart-head">
        <h3>{spree ? "乱花一通之后" : "如果真拿这笔钱去买"}</h3>
        <div className="cart-head-right">
          <span className="cart-total">{fmtCNY(total)}</span>
          <button
            className="btn cart-dice"
            onClick={spree ? onReset : onReroll}
            title={spree ? "回到按价格贪心的最优解" : "重新随机分配这笔钱"}
          >
            {spree ? "回到最优解" : "乱花一通"}
          </button>
        </div>
      </div>
      <div className="cart-lines">
        {lines.map((c) => (
          <div className="cart-line" key={c.item.id}>
            <ItemIcon id={c.item.icon} size={18} className="cl-icon" />
            <span className="cl-name">{c.item.name}</span>
            <span className="cl-qty">×{c.count}</span>
            <span className="cl-sum">{fmtCNY(c.total)}</span>
          </div>
        ))}
      </div>
      <div className="cart-summary">
        {cartSummary(lines, 4)}
        {left > 0 && <span className="cart-left"> · 还剩 {fmtCNY(left)} 没花出去</span>}
      </div>
    </div>
  );
}

/** 商品阶梯：按档位分组，买得起的点亮，买不起的给出进度 */
function Ladder({ m }: { m: MallResult }) {
  const bands = [0, 1, 2, 3] as Band[];
  // 15 件商品全展开有 1000+ px，读者滚不到底就放弃了。
  // 默认只展开「当前预算所在档」和「下一档」——这两档才是他正在纠结的。
  // 更远的档位折叠成一行摘要，需要时点开。
  const [expanded, setExpanded] = useState<Set<Band>>(new Set());
  const currentBand: Band = m.best ? m.best.band : 0;
  const nearBands = useMemo<Set<Band>>(
    () => new Set<Band>([currentBand, Math.min(3, currentBand + 1) as Band]),
    [currentBand],
  );
  const isOpen = (b: Band) => nearBands.has(b) || expanded.has(b);
  const toggle = (b: Band) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });

  // 目录编号按价格升序，便宜的是 №01 —— 一件件看过去像翻图录
  const indexOf = new Map(m.rows.map((r, i) => [r.id, i + 1]));

  return (
    <div className="mall-ladder">
      {bands.map((b) => {
        const items = m.rows.filter((r) => r.band === b);
        if (!items.length) return null;
        const open = isOpen(b);
        return (
          <div className="mall-band" key={b}>
            <button
              className="band-head band-toggle"
              onClick={() => toggle(b)}
              aria-expanded={open}
            >
              <span className="band-name">{BAND_NAMES[b]}</span>
              <span className="band-hint">{BAND_HINTS[b]}</span>
              <span className="band-range">
                {fmtCNY(items[0].price)} – {fmtCNY(items[items.length - 1].price)}
              </span>
              <span className="band-caret" aria-hidden>
                {open ? "−" : "+"}
                <em>{items.length} 件</em>
              </span>
            </button>
            {open && (
              <div className="band-items">
                {items.map((r) => (
                  <Item key={r.id} r={r} m={m} index={indexOf.get(r.id) || 0} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 一件商品。
 *
 * 买得起：亮起来，给出「能买几件」。
 * 买不起：压淡，但给一条进度条而不是干巴巴的「差 ¥X」——
 * 看着条子已经走到 88%，比看到一个金额更让人想把它填满。
 */
function Item({ r, m, index }: { r: MallRow; m: MallResult; index: number }) {
  const reach = r.price > 0 ? Math.max(0, Math.min(1, m.budget / r.price)) : 0;
  const hours = m.perHour > 0 ? r.price / m.perHour : 0;

  return (
    <article className={`mall-item ${r.affordable ? "on" : "off"}`}>
      <div className="mi-top">
        <ItemIcon id={r.icon} size={30} className="mi-icon" />
        <span className="mi-no">№{String(index).padStart(2, "0")}</span>
      </div>
      <h4 className="mi-name">{r.name}</h4>
      <div className="mi-price">
        {fmtCNY(r.price)}
        {hours >= 1 && <span className="mi-hours">≈ {fmtInt(hours)} 小时</span>}
      </div>
      {r.affordable ? (
        <div className="mi-get">
          能买 <b>{r.count}</b> 件
        </div>
      ) : (
        <div className="mi-gap">
          <span className="mi-gap-bar">
            <i style={{ width: `${reach * 100}%` }} />
          </span>
          <span className="mi-gap-txt">还差 {fmtCNY(r.shortfall)}</span>
        </div>
      )}
      <div className="mi-hint">{r.hint}</div>
    </article>
  );
}
