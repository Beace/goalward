# Pi Runtime identity source

Verified and retrieved on 2026-09-18.

- Official source: the Badge in the [Pi Press Kit](https://pi.dev/press-kit), intended for favicons and compact identities.
- Original asset: [favicon.svg](https://pi.dev/favicon.svg).
- Local file: `src/assets/runtimes/pi.svg`.
- SHA-256: `d266b2c1d2c7bf169ca30d438963b176fba16fea6263b9ac30c8302f34ad7ce7`.
- Preserve the official SVG's original bytes, square aspect ratio, and paths; no redrawing or cropping of the user's screenshot was performed.
- The official asset uses `#f6f6f6` through `prefers-color-scheme: dark`. The app root already has `color-scheme: dark`, producing a white mark with a transparent background consistent with the user's screenshot.
- The shared RuntimeLogo component uses it for Pi registrations and custom registrations whose adapter is pi. It is bundled locally and does not require runtime network loading.
- The brand mark identifies the Pi Runtime and does not imply official partnership or endorsement.
