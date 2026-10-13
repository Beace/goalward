# Artifact preview

The artifact preview panel supports local HTML, Markdown, text, images, and PDFs. Selecting a task file or artifact reads its current content from disk; refresh reads it again. Local HTML uses a static preview. Open the file with a system app to use scripts and external resources.

The default local-file preview limit is **500 MB**. Files within the limit load immediately. Larger files first show their size and an **Open anyway** button; pressing it continues loading. This choice applies to the current file and resets when you select another file. Large files can still take time or require substantial memory, and continuing does not add support for an otherwise unsupported format.

PDFs render one page at a time, with previous-page, next-page, page-number, zoom, and fit-to-width controls. Enter a page number and press Enter to jump; use PageUp / PageDown when the PDF content area has focus. Local bytes are read as needed; switching files cancels the old document's loading and rendering. Copy copies the PDF's file path. System-open and Finder actions work as for other local files. Damaged, encrypted, or unreadable PDFs show a retryable error.

Enter a complete `http://` or `https://` URL in the preview panel, then press Enter or use the open button. Local paths, other schemes, and URLs containing login credentials are rejected. Web previews can be refreshed, copied, or opened in a system browser. A site's own embedding restrictions still apply; open sites that require sign-in or refuse embedding in a system browser.

Local reads remain restricted to the artifact's working directory after path canonicalization. **Open anyway** only bypasses the size gate; it preserves directory containment, file-type, and read-error checks. Web content runs in a restricted iframe without access to the app's local files or native commands.

## Verification

With a local Vite development server running, execute:

```bash
node scripts/artifact-preview-upgrade-smoke.mjs
```

The script mounts the real React preview components and PDF renderer in Chromium, supplies controlled Tauri IPC responses and real PDF bytes, and serves a controlled UTF-8 web page. It checks the size gate and override reset, PDF canvas rendering and page controls, URL validation and keyboard submission, retry and stale-read handling, narrow-panel controls, and normal/reduced motion at 1536 × 960 and 1280 × 720. Screenshots and the recorded results are written to `test-results/artifact-preview-upgrade/`.

The browser check verifies actual React UI and PDF parsing/rendering with simulated Tauri IPC. Rust tests cover native reads and path/size boundaries. These checks do not establish end-to-end behavior in a packaged macOS WebKit app. The browser preview does not read local files or start local runtimes directly.
