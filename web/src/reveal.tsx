import { useEffect, useRef, useState, type ElementType, type ReactNode } from "react";

/**
 * 滚动入场动效。
 *
 * ## 为什么要另起一套，而不是用现有的 CSS `animation`
 *
 * 现有区块的入场全是**挂载动画**：`animation: fade-up 300ms both` 在元素
 * 挂载那一刻就放完。而切栏渲染成 `null`（`App.tsx` 的 `Tab`），切到一栏时
 * 该栏所有区块**同时挂载**，于是全部动画在同一瞬间一起放完。
 *
 * 用户切栏后 300ms 内动画已经结束，再往下滚时所有元素都处于终态——
 * 所以「往下滚的时候元素动起来」这件事根本没发生。
 *
 * 这里是真正的**滚动触发**：进入视口才置 `data-in`，CSS 再从隐藏态过渡过来。
 * `Charts.tsx` 的 `useInView` 只驱动折线的 `stroke-dashoffset` 绘制，
 * 不驱动区块/卡片入场，两者互补。
 *
 * ## 三条安全约束
 *
 * 1. **不支持 IntersectionObserver 时直接放行**，内容永远可见——
 *    不能因为动画 API 缺失而让用户看不到数据。
 * 2. **prefers-reduced-motion: reduce 时不做位移**，只淡入。
 * 3. **只触发一次**，滚回去不重播，用户会烦。
 */

/** 模块级单例观察器。所有 Reveal 共用一个，避免上百个 observer 实例。 */
let observer: IntersectionObserver | null = null;
let reducedMotion = false;

function supportsObserver() {
  return typeof IntersectionObserver !== "undefined" && typeof window !== "undefined";
}

function getObserver(): IntersectionObserver | null {
  if (!supportsObserver()) return null;
  if (observer) return observer;
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        (e.target as HTMLElement).dataset.in = "1";
        observer?.unobserve(e.target); // 只触发一次
      }
    },
    {
      threshold: 0,
      // 上边给 120px、下边收 8%：元素刚露头就开始动，用户不用等到完全
      // 滚到位才看到动作，避免「滑过去了才发现有动画」的滞后感。
      rootMargin: "0px 0px -8% 0px",
    },
  );
  return observer;
}

interface RevealOptions {
  /** 入场延迟（毫秒），用于同一组元素依次出现 */
  delay?: number;
  /** 位移距离（px）。0 表示只淡入不位移 */
  distance?: number;
}

/**
 * 让一个元素在滚进视口时入场。
 *
 * 用法：`<Reveal as="div" className="panel">{children}</Reveal>`
 */
export function Reveal({
  as: As = "div",
  delay = 0,
  distance = 14,
  className,
  style,
  children,
}: {
  as?: ElementType;
  delay?: number;
  distance?: number;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = getObserver();
    // 环境不支持 → 直接放行，绝不能因为动画 API 缺失而丢内容
    if (!io) {
      setFallback(true);
      return;
    }
    io.observe(el);
    return () => io.unobserve(el);
  }, []);

  // 环境不支持时改用 data-in="1"，CSS 会跳过隐藏态
  const inAttr = fallback ? "1" : undefined;
  return (
    <As
      ref={ref}
      className={className}
      data-reveal=""
      data-in={inAttr}
      data-reduce={reducedMotion ? "1" : undefined}
      style={{ ...style, ["--reveal-delay" as string]: `${delay}ms`, ["--reveal-dist" as string]: `${distance}px` }}
    >
      {children}
    </As>
  );
}

/**
 * 容器级 stagger：容器滚进视口时，把直接子元素依次点亮。
 *
 * 比给每个子元素各挂一个 `<Reveal>` 省事得多，也避免几十个 observer 回调。
 * CSS 侧用 `--reveal-i` 控制每个子元素的延迟。
 *
 * 用法：`<RevealGroup className="stat-row">{cards}</RevealGroup>`
 */
export function RevealGroup({
  as: As = "div",
  step = 40,
  max = 8,
  distance = 12,
  className,
  style,
  children,
}: {
  as?: ElementType;
  /** 相邻子元素的延迟间隔（ms） */
  step?: number;
  /** 最多错开几个子元素，再多就一起出现，避免长列表尾巴等太久 */
  max?: number;
  distance?: number;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = getObserver();
    if (!io) {
      setFallback(true);
      return;
    }
    io.observe(el);
    return () => io.unobserve(el);
  }, []);

  return (
    <As
      ref={ref}
      className={className}
      data-reveal-group=""
      data-in={fallback ? "1" : undefined}
      data-reduce={reducedMotion ? "1" : undefined}
      style={
        {
          ...style,
          ["--reveal-step" as string]: `${step}ms`,
          ["--reveal-max" as string]: `${max}`,
          ["--reveal-dist" as string]: `${distance}px`,
        }
      }
    >
      {children}
    </As>
  );
}