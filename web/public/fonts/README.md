# 自托管字体

本目录的字体会被 Vite 原样拷进 `dist/fonts/`，由页面通过 `@font-face` 本地加载。
**不请求任何外部 CDN** —— 这是本项目「零网络请求」承诺的一部分。

| 文件 | 字族 | 用途 | 许可 |
| --- | --- | --- | --- |
| `inter-latin.woff2` | Inter (variable) | 显示 / 正文（拉丁） | SIL OFL 1.1 |
| `geist-mono-latin.woff2` | Geist Mono (variable) | 微标签 / 数字 | SIL OFL 1.1 |

## 为什么是这两个

基准站点 heronaiapp.com 用的是一份授权字体 `BT Grotesk`（不可分发）搭配
`Geist Mono`。**Geist Mono 直接照用**（开源）。`BT Grotesk` 用 Inter 替代：
四选一（Inter / Inter Tight / Archivo / Schibsted Grotesk）同文案同字号对照后，
Inter 的字形与字宽最接近。详见根目录 `DESIGN.md`。

两者都是 **latin 子集**，只覆盖拉丁与数字。中文由 `--font-sans` 的
CJK 回退栈（PingFang SC / 微软雅黑）提供 —— 见 `DESIGN.md` 的 CJK 规则。

## 许可

- Inter — https://github.com/rsms/inter — SIL Open Font License 1.1
- Geist Mono — https://github.com/vercel/geist-font — SIL Open Font License 1.1

两者均允许自由使用、修改与再分发（含随应用打包）。
完整许可文本见 https://openfontlicense.org/ 。
