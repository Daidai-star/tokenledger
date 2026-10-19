/**
 * 工具条跑马灯 —— 复刻 heronaiapp.com 的 `.marquee-left`（30s linear infinite）。
 *
 * 内容复制一份，轨道整体位移 -50% 就能无缝循环——比「到边界就跳回」干净。
 * 纯装饰，`aria-hidden`；真实数据在下面的指标行里，不影响可访问性。
 */
export interface MarqueeItem {
  name: string;
  value: string;
  color: string;
  absent?: boolean;
}

export default function Marquee({ items }: { items: MarqueeItem[] }) {
  if (!items.length) return null;
  const doubled = [...items, ...items];
  return (
    <div className="marquee" aria-hidden>
      <div className="marquee-track">
        {doubled.map((it, i) => (
          <span key={`${it.name}-${i}`} className={`marquee-item${it.absent ? " absent" : ""}`}>
            <i className="marquee-dot" style={{ background: it.color }} />
            <b>{it.name}</b>
            <em>{it.value}</em>
            <span className="marquee-sep">·</span>
          </span>
        ))}
      </div>
    </div>
  );
}
