import Lenis from "lenis";
import { gsap, ScrollTrigger, isCoarsePointer, prefersReduced } from "./gsap";

/**
 * 平滑滚动（复刻 heronaiapp.com 的 Lenis）。
 *
 * v1 用的是「自绘 lerp」方案，这里换成 Lenis，因为要和 GSAP 的时间轴
 * 对齐——两者共用一个 ticker，滚动驱动的时间轴才不会抖。
 *
 * 触屏与 prefers-reduced-motion 一律退回原生滚动：
 * 移动端的惯性本来就够用，平滑滚动只会让人觉得「黏」。
 */

let lenis: Lenis | null = null;

export function startSmoothScroll(): (() => void) | void {
  if (lenis) return;
  if (isCoarsePointer() || prefersReduced()) return;

  lenis = new Lenis({
    duration: 1.05,
    // easeOutCubic：与 DESIGN.md 的通用减速一致
    easing: (t: number) => 1 - Math.pow(1 - t, 3),
    smoothWheel: true,
    touchMultiplier: 1.6,
  });

  // 让 ScrollTrigger 跟着 Lenis 的滚动位置更新
  lenis.on("scroll", ScrollTrigger.update);

  const tick = (time: number) => lenis?.raf(time * 1000);
  gsap.ticker.add(tick);
  gsap.ticker.lagSmoothing(0);

  return () => {
    gsap.ticker.remove(tick);
    lenis?.destroy();
    lenis = null;
  };
}

/**
 * 程序化滚动。
 *
 * 有 Lenis 时必须走它自己——原生 `window.scrollTo` 会和 Lenis 抢滚动位置，
 * 表现为「滚过去又被弹回来」。切栏定位（App.tsx）用的就是这里。
 */
export function scrollWindowTo(top: number, smooth = true) {
  if (lenis) {
    lenis.scrollTo(top, { immediate: !smooth });
    return;
  }
  window.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

export function isSmoothScrolling() {
  return lenis !== null;
}
