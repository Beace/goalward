# App background images

Choose a local image in **Settings → Appearance → Background image**. It covers the full application window behind the workbench, navigation, settings, goals, agents, setup, and Trace panels. The image stays centered and uses `cover`, so resizing can crop its edges.

**Background image opacity** controls only the picture: 0% hides it, 100% shows it fully. **Interface background opacity** controls the main panel colors: 100% uses solid panels, 0% reveals the image fully. The defaults are 100% for the image and 85% for panel colors. Text, buttons, form controls, menus, dialogs, and artifact content keep their own appearance. There is no whole-window opacity setting.

Changes apply immediately and save automatically. Image and opacity writes use the same field-specific appearance persistence as theme, font, and language changes; they preserve Runtime and other unsaved configuration drafts. A failed write restores only the fields still owned by that request and offers retry. Removing the image restores the ordinary opaque palette while retaining the opacity choices for the next image.

The macOS app imports a private image copy under `appearance/backgrounds/` in the existing app data directory. Moving or deleting the original does not break the imported image. Settings store only its name and managed path, and native reads reject paths outside managed storage. Browser previews store the image Blob in IndexedDB and save only its stable reference in workspace settings. Clearing browser site data removes these preview assets.

Images are limited to 32 MB. Imports inspect raster bytes and verify that the image can be displayed. Native macOS import supports the existing raster formats, including HEIC/TIFF conversion for preview. Browser format support depends on its decoder; an unsupported or damaged image shows an error and keeps the previous choice. Missing or unreadable stored images keep their reference with retry, replacement, and removal controls, and the interface falls back to solid colors until a usable image is ready. Prior assets are retained so a settings-save failure can restore an earlier reference.

The image is decorative and does not intercept pointer events or become an accessibility-tree item. Opacity sliders support keyboard navigation and follow pointer input directly, without a tween. Reduced transparency and increased contrast hide the image and use solid panels without changing saved settings. Reduced motion keeps static feedback. Shared motion follows the installed `apple-design` and `animate` skills.

Validation combines the appearance persistence and image lifecycle unit suites, native macOS import/read tests, the existing theme smoke, and `scripts/background-settings-smoke.mjs`. Browser evidence covers the React preview; native unit evidence covers actual file copy and macOS image decoding. A packaged Tauri/WebKit relaunch is a separate acceptance layer.
