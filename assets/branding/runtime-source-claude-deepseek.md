# Claude Code / DeepSeek Harness identity sources

Verified and retrieved on 2026-09-15. These assets only identify the corresponding runtimes in Goalward. The graphic names and trademarks remain the property of their respective rights holders.

## Claude Code

- Local file: `src/assets/runtimes/claude.png`.
- Product page: [Claude Code](https://claude.com/product/claude-code). Its VS Code link points to the official Anthropic extension.
- Publication page: [Claude Code for VS Code — Anthropic](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code).
- Direct asset: [official extension icon, version 2.1.272](https://anthropic.gallerycdn.vsassets.io/extensions/anthropic/claude-code/2.1.272/1789433014665/Microsoft.VisualStudio.Services.Icons.Default).
- Format / dimensions: PNG, 266 × 266, 10,358 bytes.
- SHA-256: `7241633e5a39b44a947c7b9a821637f30d6e86716e7a8c847136d91f9c3f6ba1`.
- Selection rationale: use the application identity from Claude Code's official release. Its terracotta circle and ivory starburst are recognizable on this project's dark surfaces. The downloaded bytes, colors, and transparent edges are preserved; no redrawing, recoloring, or third-party version was used.

## DeepSeek Harness

- Local file: `src/assets/runtimes/deepseek.svg`.
- Product page: [DeepSeek Harness](https://deepseek.com/harness/).
- Official upstream: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- Exact source: [apps/web/public/favicon.svg](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/apps/web/public/favicon.svg).
- Original asset: [SVG at the pinned commit](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/apps/web/public/favicon.svg).
- Format / dimensions: SVG, 50 × 50 viewBox, 3,561 bytes.
- SHA-256: `caf3c1a17235c60faaa0efdb052753f65dc2c1108c5907cc8d5562d4bf926a4f`.
- Selection rationale: the official Harness Web application uses the DeepSeek whale. `packages/client/ui-primitives/src/FishLogo.tsx` was also checked; no graphics from similarly named third-party projects, such as a horse-headed whale, were used.
- Processing: the original favicon's `prefers-color-scheme: dark` rule explicitly uses white `#fff`. The local file selects that official dark variant to suit the workbench's consistently dark surface. The `d` paths are preserved verbatim without shape changes. Unneeded media rules, IDs, and the xlink namespace were removed, retaining only SVG / path graphics and static attributes.
- Safety check: the XML is parseable and contains only SVG and path elements, with no script, foreignObject, external links, event-handler attributes, animation, or tracking requests.
- Brand note: [upstream brand-material guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/BRAND_GUIDELINES.md). The icon identifies the corresponding product in the runtime list and must not imply that Goalward is an official DeepSeek product or is endorsed by DeepSeek.

### DeepSeek Harness upstream license

Source: [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/LICENSE). The upstream license text is preserved below:

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
