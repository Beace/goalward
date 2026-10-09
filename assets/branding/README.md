# Goalward 桌面图标

## 内置 Runtime 标识

应用内通过 `src/components/RuntimeLogo.tsx` 统一加载 `src/assets/runtimes/` 的官方素材，随前端打包，运行时无需请求品牌网站。原始图形比例与颜色保持不变，DeepSeek 采用其官方深色变体。未知自定义 Runtime 使用中性终端图标；明确使用 Codex / Claude 适配器的自定义注册项沿用对应品牌。图标用于识别 Runtime，不表示已安装、已登录或可调用。

| Runtime | 素材与官方来源记录 |
| --- | --- |
| Codex | `codex.png`，官方 Codex 插件使用的 OpenAI Blossom；[来源](runtime-source-codex.md) |
| Claude Code | `claude.png`，Anthropic 官方 Claude Code 插件图标；[来源](runtime-source-claude-deepseek.md) |
| DeepSeek Harness | `deepseek.svg`，官方 Harness Web 应用的鲸鱼图标；[来源与上游许可](runtime-source-claude-deepseek.md) |
| Pi | `pi.svg`，Pi Press Kit 的紧凑标识；[来源](runtime-source-pi.md) |

列表、设置、首次检测、成员与聊天共用同一套素材。历史聊天和执行成员读取保存的 Runtime 快照，不随后续配置切换。来源及许可说明一并打包至 macOS 应用的 `Contents/Resources/runtime-branding/`。

## 设计

2026-10-09 为 Goalward 更新图标。向前的 G 形路径对应把模糊方向转成具体行动，再通过复盘持续前进。深炭灰底板、暖沙金和象牙白延续应用现有配色；采用圆角方形外轮廓。

- 正式母版：`goalward-icon.png`，1254 × 1254 PNG。
- 完整生成提示词：`icon-prompt.txt`。
- 生成方式：内置 image_gen 工具，使用 imagegen skill；未使用 CLI / API fallback。
- `src-tauri/icons/app.svg` 是早期占位源码，不用于当前打包；请勿以它重新生成图标。

## 重新生成打包资源

在仓库根目录执行。Tauri CLI 负责尺寸转换与平台封装。

```bash
npm run tauri -- icon assets/branding/goalward-icon.png --output src-tauri/target/goalward-brand-icons
cp src-tauri/target/goalward-brand-icons/32x32.png src-tauri/icons/
cp src-tauri/target/goalward-brand-icons/128x128.png src-tauri/icons/
cp src-tauri/target/goalward-brand-icons/128x128@2x.png src-tauri/icons/
cp src-tauri/target/goalward-brand-icons/icon.png src-tauri/icons/
cp src-tauri/target/goalward-brand-icons/icon.icns src-tauri/icons/
npm run mac:build
```

项目仅使用 macOS 所需资源；其他平台的自动生成文件留在被 Git 忽略的 target 目录。

## 检查

```bash
sips -g pixelWidth -g pixelHeight -g hasAlpha src-tauri/icons/32x32.png src-tauri/icons/128x128.png src-tauri/icons/128x128@2x.png
cmp src-tauri/icons/icon.icns "src-tauri/target/release/bundle/macos/Goalward.app/Contents/Resources/icon.icns"
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/Goalward.app"
```
