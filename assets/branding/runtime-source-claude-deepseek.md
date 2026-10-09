# Claude Code / DeepSeek Harness 标识来源

核验与获取日期：2026-09-15。以下素材仅用于 Goalward 内识别对应 runtime，图形名称及商标仍属于其各自权利人。

## Claude Code

- 本地文件：`src/assets/runtimes/claude.png`。
- 产品页面：[Claude Code](https://claude.com/product/claude-code)。该页面的 VS Code 入口指向 Anthropic 官方插件。
- 发布页面：[Claude Code for VS Code — Anthropic](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)。
- 直接资源：[官方插件图标，版本 2.1.272](https://anthropic.gallerycdn.vsassets.io/extensions/anthropic/claude-code/2.1.272/1789433014665/Microsoft.VisualStudio.Services.Icons.Default)。
- 格式 / 尺寸：PNG，266 × 266，10,358 字节。
- SHA-256：`7241633e5a39b44a947c7b9a821637f30d6e86716e7a8c847136d91f9c3f6ba1`。
- 选择理由：使用 Claude Code 官方发布物自己的应用标识，陶土色圆底和象牙白星芒在本项目深色表面上可辨认。保留下载文件原始字节、颜色和透明边缘，没有重绘、变色或采用第三方版本。

## DeepSeek Harness

- 本地文件：`src/assets/runtimes/deepseek.svg`。
- 产品页面：[DeepSeek Harness](https://deepseek.com/harness/)。
- 官方上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
- 精确来源：[apps/web/public/favicon.svg](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/apps/web/public/favicon.svg)。
- 原始资源：[固定提交的 SVG](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/apps/web/public/favicon.svg)。
- 格式 / 尺寸：SVG，50 × 50 viewBox，3,561 字节。
- SHA-256：`caf3c1a17235c60faaa0efdb052753f65dc2c1108c5907cc8d5562d4bf926a4f`。
- 选择理由：官方 Harness Web 应用本身使用 DeepSeek 鲸鱼；同时核对了 `packages/client/ui-primitives/src/FishLogo.tsx`，没有使用同名第三方项目的马头鲸等图形。
- 处理：原始 favicon 的 `prefers-color-scheme: dark` 规则明确使用白色 `#fff`。本地文件固定选用该官方暗色变体，以适应始终为深色的工作台；`d` 路径逐字保留，未改形。移除不再需要的媒体规则、id、xlink 命名空间，仅保留 SVG / path 图形和静态属性。
- 安全检查：XML 可解析；仅包含 SVG、path；无 script、foreignObject、外链、事件处理属性、动画或跟踪请求。
- 品牌说明：[上游品牌材料使用规范](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/BRAND_GUIDELINES.md)。图标用于 runtime 列表中的对应产品识别，不能暗示 Goalward 是 DeepSeek 官方产品或受到其背书。

### DeepSeek Harness 上游许可

来源：[LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/LICENSE)。保留上游许可文本：

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
