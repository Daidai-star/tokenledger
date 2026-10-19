/**
 * 图纸框 —— 4 条发丝线框住视口 + 四角 + 定位十字。
 *
 * 复刻 heronaiapp.com 的 `.main-deco`：那里也是 4 条独立的线（不是 border），
 * 因为要能逐条「画出来」（transform 由 GSAP 驱动）。用 border 做不到动画。
 * 纯装饰，不可交互，全局只挂一次。
 */
export default function Deco() {
  return (
    <div className="sheet-frame" aria-hidden>
      <i className="sheet-line top" />
      <i className="sheet-line bottom" />
      <i className="sheet-line left" />
      <i className="sheet-line right" />
      <i className="sheet-corner tl" />
      <i className="sheet-corner tr" />
      <i className="sheet-corner bl" />
      <i className="sheet-corner br" />
    </div>
  );
}
