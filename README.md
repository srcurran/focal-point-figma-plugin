# Focal Point (proof of concept)

Figma centers image fills by default. This plugin lets you pick a **focal point**
for an image fill so that part of the image stays in view no matter the frame's
aspect ratio — the equivalent of CSS `background-size: cover` +
`background-position`, done natively with Figma's `CROP` scale mode.

## How it works

- Reads the selected layer's image fill and the image's intrinsic size
  (`figma.getImageByHash(...).getSizeAsync()`).
- Computes the "cover" crop rectangle whose center sits as close to the focal
  point as the image bounds allow (clamped so the crop never runs off the
  image).
- Writes it back as `scaleMode: "CROP"` with the computed `imageTransform`
  matrix.
- Stores the focal point in `pluginData` on the node, and (while the plugin is
  open) listens for `nodechange` events so the crop is **enforced live**: it is
  re-applied when the frame is resized *and* when the fill itself changes —
  image swapped, scale mode switched back to Fill/Fit, or crop dragged by hand.

## Usage

1. In Figma desktop: **Plugins → Development → Import plugin from manifest…**
   and pick `manifest.json` (skip if already imported).
2. Select a layer with an image fill and run **Focal Point**. A low-res preview
   of the image loads in the panel.
3. Click (or drag) on the preview to place the focal point marker — the crop
   applies live as you drag. Numeric X/Y inputs (percent, from top-left) are
   kept in sync and still work with **Apply focal point** / Enter.
4. Resize the frame — with "Re-apply automatically on resize" checked, the crop
   follows the focal point. The panel shows per-operation timing in ms.

## Development

```
npm install
npm run build     # or: npm run watch
```

`code.ts` compiles to `code.js`, which the manifest points at. The UI is plain
HTML/JS in `ui.html` (no build step).

## Known limits of the POC

- Auto re-apply only runs while the plugin is open — Figma plugins cannot run
  in the background. The focal point is persisted on the node, so reopening
  the plugin (or the "Edit focal point" relaunch button) restores it.
- Only the first image fill on a layer is handled; image rotation is ignored.
