import { useEffect, useRef } from "react";
import { gsap, isCoarsePointer, prefersReduced } from "../motion/gsap";

/**
 * 自定义光标 —— 复刻 heronaiapp.com 的 `.cursor`：一个 6px 的橘红圆点，
 * 用 quickTo 追着指针走，带一点延迟（lag）。
 *
 * 原生指针用 `html[data-cursor="custom"] { cursor: none }` 隐掉；
 * 悬停到可交互元素上时圆点放大。
 *
 * 触屏 / prefers-reduced-motion 下完全不启用，也不会隐藏原生指针。
 */
export default function Cursor() {
  const wrap = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = wrap.current;
    const d = dot.current;
    if (!el || !d) return;
    if (isCoarsePointer() || prefersReduced()) return;

    document.documentElement.dataset.cursor = "custom";

    const xTo = gsap.quickTo(el, "x", { duration: 0.38, ease: "power3" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.38, ease: "power3" });
    const move = (e: PointerEvent) => {
      xTo(e.clientX);
      yTo(e.clientY);
    };

    const over = (e: PointerEvent) => {
      const t = (e.target as HTMLElement)?.closest?.(
        "a, button, .btn, .segmented button, .filter-pill, .rank-row, input, select, [data-cursor-hot]",
      );
      gsap.to(d, { scale: t ? 3.4 : 1, duration: 0.32, ease: "expo.out" });
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerover", over, { passive: true });

    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerover", over);
      delete document.documentElement.dataset.cursor;
    };
  }, []);

  return (
    <div className="cursor" ref={wrap} aria-hidden>
      <span className="cursor-inner" ref={dot} />
    </div>
  );
}
