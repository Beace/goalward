# Pi Runtime 标识来源

核验与获取日期：2026-09-18。

- 官方来源：[Pi Press Kit](https://pi.dev/press-kit) 的 Badge（适用于 favicon 和紧凑标识）。
- 原始资源：[favicon.svg](https://pi.dev/favicon.svg)。
- 本地文件：`src/assets/runtimes/pi.svg`。
- SHA-256：`d266b2c1d2c7bf169ca30d438963b176fba16fea6263b9ac30c8302f34ad7ce7`。
- 保留官方 SVG 原始字节、方形比例和路径；没有重绘或裁切用户截图。
- 官方资源通过 `prefers-color-scheme: dark` 使用 `#f6f6f6`。应用根节点已有 `color-scheme: dark`，因此呈现与用户截图一致的白色标识、透明背景。
- 由共享 RuntimeLogo 组件用于 Pi 注册项，以及 adapter 为 pi 的自定义注册项；随应用本地打包，不依赖运行时网络加载。
- 品牌标识仅用于辨识 Pi Runtime，不表示官方合作或背书。
