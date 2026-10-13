# Goalward desktop icon

## Built-in Runtime identities

The application loads official assets from `src/assets/runtimes/` through the shared `src/components/RuntimeLogo.tsx` component. Assets are bundled with the frontend, so runtime display does not request brand websites. Original proportions and colors are preserved; DeepSeek uses its official dark variant. Unknown custom Runtimes use a neutral terminal icon. Custom registrations that explicitly use the Codex / Claude adapters use the corresponding brand. These icons identify Runtimes and do not indicate installation, authentication, or availability.

| Runtime | Asset and official source record |
| --- | --- |
| Codex | `codex.png`, the OpenAI Blossom used by the official Codex extension; [source](runtime-source-codex.md) |
| Claude Code | `claude.png`, the official Anthropic Claude Code extension icon; [source](runtime-source-claude-deepseek.md) |
| DeepSeek Harness | `deepseek.svg`, the whale icon used by the official Harness Web application; [source and upstream license](runtime-source-claude-deepseek.md) |
| Pi | `pi.svg`, the compact identity from the Pi Press Kit; [source](runtime-source-pi.md) |

Lists, settings, initial detection, members, and chat use the same assets. Historical chats and execution members read their saved Runtime snapshots and do not change with subsequent configuration updates. Source and license records are bundled into the macOS application's `Contents/Resources/runtime-branding/` directory.

## Design

The Goalward icon was updated on 2026-10-09. Its forward-moving G-shaped path represents turning a vague direction into concrete action and continuing through reflection. The dark charcoal base, warm sand gold, and ivory white extend the application's existing palette within a rounded-square outline.

- Production master: `goalward-icon.png`, a 1254 × 1254 PNG.
- Complete generation prompt: `icon-prompt.txt`.
- Generation method: the built-in image_gen tool with the imagegen skill; no CLI / API fallback was used.
- `src-tauri/icons/app.svg` is an early placeholder source and is not used for current packaging. Do not regenerate icons from it.

## Regenerate packaged assets

Run these commands from the repository root. The Tauri CLI handles resizing and platform packaging.

```bash
npm run tauri -- icon assets/branding/goalward-icon.png --output src-tauri/target/goalward-brand-icons
cp src-tauri/target/goalward-brand-icons/32x32.png src-tauri/icons/
cp src-tauri/target/goalward-brand-icons/128x128.png src-tauri/icons/
cp src-tauri/target/goalward-brand-icons/128x128@2x.png src-tauri/icons/
cp src-tauri/target/goalward-brand-icons/icon.png src-tauri/icons/
cp src-tauri/target/goalward-brand-icons/icon.icns src-tauri/icons/
npm run mac:build
```

The project uses only the assets required for macOS. Generated files for other platforms remain in the Git-ignored target directory.

## Checks

```bash
sips -g pixelWidth -g pixelHeight -g hasAlpha src-tauri/icons/32x32.png src-tauri/icons/128x128.png src-tauri/icons/128x128@2x.png
cmp src-tauri/icons/icon.icns "src-tauri/target/release/bundle/macos/Goalward.app/Contents/Resources/icon.icns"
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/Goalward.app"
```
