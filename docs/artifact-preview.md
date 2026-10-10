# Artifact preview / 产物预览

## 中文

产物预览面板支持本地 HTML、Markdown、文本、图片和 PDF。点击任务中的文件或产物后，面板读取磁盘上的当前内容；刷新会重新读取文件。HTML 使用静态预览，脚本与外部资源应通过系统打开查看。

本地文件的默认预览上限为 **500 MB**。未超过上限的文件直接加载；超过上限时，面板先显示实际大小和提示，点击 **仍要打开** 后继续加载。继续加载的选择只对当前文件生效，切换文件后恢复默认大小检查。大文件仍可能需要较长时间或较多内存，继续加载不改变格式是否可预览。

PDF 在面板内按页渲染，支持上一页、下一页、页码输入、放大、缩小和适应宽度。输入页码后按 Enter 跳转；聚焦 PDF 内容区时可用 PageUp / PageDown 翻页。PDF 字节按需从本地读取，切换文件会取消旧文档的加载和渲染。PDF 的复制操作复制文件路径，系统打开和在 Finder 中显示沿用其他本地文件的操作。损坏、加密或无法解析的 PDF 会显示可重试的错误。

预览面板也支持输入网页 URL。输入完整的 `http://` 或 `https://` 地址后，按 Enter 或点击打开按钮进入预览；不接受文件路径、其他协议或包含登录凭证的 URL。网页可以刷新、复制链接或通过系统浏览器打开。页面内嵌受网站自身的限制影响，需要登录或拒绝内嵌的网站可通过系统浏览器查看。

本地文件读取只允许访问该产物工作目录内的文件，路径规范化后仍检查目录边界；“仍要打开”只解除大小提示，不解除路径边界、文件类型和读取错误检查。网页在受限制的 iframe 中展示，不获得应用的本地文件或原生命令能力。

## English

The artifact preview panel supports local HTML, Markdown, text, images, and PDFs. Selecting a task file or artifact reads its current content from disk; refresh reads it again. Local HTML uses a static preview. Open the file with a system app to use scripts and external resources.

The default local-file preview limit is **500 MB**. Files within the limit load immediately. Larger files first show their size and an **Open anyway** button; pressing it continues loading. This choice applies to the current file and resets when you select another file. Large files can still take time or require substantial memory, and continuing does not add support for an otherwise unsupported format.

PDFs render one page at a time, with previous-page, next-page, page-number, zoom, and fit-to-width controls. Enter a page number and press Enter to jump; use PageUp / PageDown when the PDF content area has focus. Local bytes are read as needed; switching files cancels the old document's loading and rendering. Copy copies the PDF's file path. System-open and Finder actions work as for other local files. Damaged, encrypted, or unreadable PDFs show a retryable error.

Enter a complete `http://` or `https://` URL in the preview panel, then press Enter or use the open button. Local paths, other schemes, and URLs containing login credentials are rejected. Web previews can be refreshed, copied, or opened in a system browser. A site's own embedding restrictions still apply; open sites that require sign-in or refuse embedding in a system browser.

Local reads remain restricted to the artifact's working directory after path canonicalization. **Open anyway** only bypasses the size gate; it preserves directory containment, file-type, and read-error checks. Web content runs in a restricted iframe without access to the app's local files or native commands.

## Verification / 验证

With a local Vite development server running, execute:

```bash
node scripts/artifact-preview-upgrade-smoke.mjs
```

The script mounts the real React preview components and PDF renderer in Chromium, supplies controlled Tauri IPC responses and real PDF bytes, and serves a controlled UTF-8 web page. It checks the size gate and override reset, PDF canvas rendering and page controls, URL validation and keyboard submission, retry and stale-read handling, narrow-panel controls, and normal/reduced motion at 1536 × 960 and 1280 × 720. Screenshots and the recorded results are written to `test-results/artifact-preview-upgrade/`.

该脚本验证实际 React 界面与 PDF 解析/渲染，文件读取使用模拟 Tauri IPC；Rust 单测覆盖原生读取和路径/大小边界。这些结果不能代替已打包 macOS WebKit 应用中的真实文件与网页验收。浏览器预览也不会直接读取本机文件或启动本机 Runtime。

The browser check verifies actual React UI and PDF parsing/rendering with simulated Tauri IPC. Rust tests cover native reads and path/size boundaries. These checks do not establish end-to-end behavior in a packaged macOS WebKit app. The browser preview does not read local files or start local runtimes directly.
