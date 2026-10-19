import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

/**
 * 动效基座。
 *
 * 复刻 heronaiapp.com 的动效栈（GSAP + ScrollTrigger + SplitText），
 * 但只注册真正用到的插件——每多一个插件就多一份首屏成本。
 *
 * 时间参数一律走 CSS 变量（--dur-* / --ease*），这里的 GSAP 缓动
 * 与 DESIGN.md 记的 cubic-bezier 一一对应：
 *   expo.out            ≈ cubic-bezier(.23,1,.32,1)
 *   power3.out          ≈ 通用减速
 *   expo.inOut          ≈ cubic-bezier(.5,.5,1,1)
 */

gsap.registerPlugin(ScrollTrigger, SplitText);

/** 用户是否要求减弱动效。所有动效入口都先问这一句。 */
export function prefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 是否粗指针（触屏）。自定义光标、平滑滚动在触屏上都不该启用。 */
export function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

export { gsap, ScrollTrigger, SplitText };
