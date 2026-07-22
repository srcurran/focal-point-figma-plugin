// Focal Point — proof of concept
//
// Applies the CSS `background-size: cover` + `background-position` model to an
// image fill by setting scaleMode: "CROP" with a computed imageTransform.
// The focal point (0–1 in image space) is kept centered in the layer whenever
// possible, clamped so the crop never leaves the image bounds.
//
// The focal point is stored in pluginData on the node so it survives reloads
// and can be re-applied automatically when the node is resized.

const FOCAL_KEY = 'focalPoint';
const EPSILON = 1e-4;

interface FocalPoint {
  x: number; // 0–1, left → right
  y: number; // 0–1, top → bottom
}

let autoReapply = true;

figma.showUI(__html__, { width: 300, height: 320, themeColors: true });

// ---------------------------------------------------------------------------
// Core math
// ---------------------------------------------------------------------------

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// Returns the imageTransform for CROP mode: maps normalized layer coords to
// normalized image coords, selecting the "cover" sub-rectangle whose center is
// as close to the focal point as the image bounds allow.
function coverTransform(
  imgW: number,
  imgH: number,
  layerW: number,
  layerH: number,
  focal: FocalPoint
): Transform {
  const scale = Math.max(layerW / imgW, layerH / imgH);
  // Visible fraction of the image in each axis (one of these is 1).
  const vw = layerW / (imgW * scale);
  const vh = layerH / (imgH * scale);
  const ox = clamp(focal.x - vw / 2, 0, 1 - vw);
  const oy = clamp(focal.y - vh / 2, 0, 1 - vh);
  return [
    [vw, 0, ox],
    [0, vh, oy],
  ];
}

function transformsEqual(a: Transform, b: Transform): boolean {
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(a[r][c] - b[r][c]) > EPSILON) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

type FillableNode = SceneNode & MinimalFillsMixin & LayoutMixin;

function asFillableNode(node: BaseNode | null): FillableNode | null {
  if (!node || !('fills' in node) || !('resize' in node)) return null;
  return node as FillableNode;
}

function findImagePaint(
  node: FillableNode
): { index: number; paint: ImagePaint } | null {
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return null;
  for (let i = 0; i < fills.length; i++) {
    const paint = fills[i];
    if (paint.type === 'IMAGE' && paint.imageHash) {
      return { index: i, paint };
    }
  }
  return null;
}

const sizeCache = new Map<string, { width: number; height: number }>();

async function imageSize(
  hash: string
): Promise<{ width: number; height: number } | null> {
  const cached = sizeCache.get(hash);
  if (cached) return cached;
  const image = figma.getImageByHash(hash);
  if (!image) return null;
  const size = await image.getSizeAsync();
  sizeCache.set(hash, size);
  return size;
}

function readFocal(node: FillableNode): FocalPoint | null {
  const raw = node.getPluginData(FOCAL_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FocalPoint;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function applyFocal(
  node: FillableNode,
  focal: FocalPoint
): Promise<{ changed: boolean; error?: string }> {
  const found = findImagePaint(node);
  if (!found || !found.paint.imageHash) {
    return { changed: false, error: 'No image fill on this layer' };
  }
  const size = await imageSize(found.paint.imageHash);
  if (!size) {
    return { changed: false, error: 'Could not load image data' };
  }

  const transform = coverTransform(
    size.width,
    size.height,
    node.width,
    node.height,
    focal
  );

  const current = found.paint;
  if (
    current.scaleMode === 'CROP' &&
    current.imageTransform &&
    transformsEqual(current.imageTransform, transform)
  ) {
    return { changed: false };
  }

  const fills = (node.fills as readonly Paint[]).slice();
  const newPaint: ImagePaint = {
    type: 'IMAGE',
    imageHash: current.imageHash,
    scaleMode: 'CROP',
    imageTransform: transform,
    visible: current.visible,
    opacity: current.opacity,
    blendMode: current.blendMode,
    filters: current.filters,
  };
  fills[found.index] = newPaint;
  node.fills = fills;

  node.setPluginData(FOCAL_KEY, JSON.stringify(focal));
  node.setRelaunchData({ edit: `Focal point ${Math.round(focal.x * 100)}%, ${Math.round(focal.y * 100)}%` });
  return { changed: true };
}

// ---------------------------------------------------------------------------
// UI state sync
// ---------------------------------------------------------------------------

async function sendState(): Promise<void> {
  const node = asFillableNode(figma.currentPage.selection[0] ?? null);
  if (!node) {
    figma.ui.postMessage({
      type: 'state',
      hasImage: false,
      message:
        figma.currentPage.selection.length === 0
          ? 'Select a layer with an image fill'
          : 'Selected layer has no image fill',
    });
    return;
  }
  const found = findImagePaint(node);
  if (!found || !found.paint.imageHash) {
    figma.ui.postMessage({
      type: 'state',
      hasImage: false,
      message: 'Selected layer has no image fill',
    });
    return;
  }
  const focal = readFocal(node);
  figma.ui.postMessage({
    type: 'state',
    hasImage: true,
    imageHash: found.paint.imageHash,
    focal,
    autoReapply,
  });
}

figma.on('selectionchange', () => {
  void sendState();
});

// ---------------------------------------------------------------------------
// Enforcement — the "dynamic" part.
// Watches nodes that have a stored focal point and re-applies the cover crop
// whenever the node is resized OR its fill is changed (image swapped, scale
// mode switched away from CROP, crop dragged by hand). applyFocal skips the
// write when the transform already matches, so our own fills writes do not
// loop: they trigger one recompute that comes back equal and stops there.
// ---------------------------------------------------------------------------

figma.currentPage.on('nodechange', (event) => {
  if (!autoReapply) return;
  for (const change of event.nodeChanges) {
    if (change.type !== 'PROPERTY_CHANGE') continue;
    const resized =
      change.properties.includes('width') ||
      change.properties.includes('height');
    const fillsChanged = change.properties.includes('fills');
    if (!resized && !fillsChanged) continue;
    const node = asFillableNode(change.node.removed ? null : change.node);
    if (!node) continue;
    const focal = readFocal(node);
    if (!focal) continue;
    const start = Date.now();
    void applyFocal(node, focal).then((result) => {
      if (result.changed) {
        figma.ui.postMessage({
          type: 'perf',
          ms: Date.now() - start,
          source: resized ? 'resize' : 'fills',
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Messages from the UI
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: {
  type: string;
  x?: number;
  y?: number;
  enabled?: boolean;
  hash?: string;
  height?: number;
}) => {
  if (msg.type === 'apply') {
    const node = asFillableNode(figma.currentPage.selection[0] ?? null);
    if (!node) {
      figma.notify('Select a layer with an image fill');
      return;
    }
    const focal: FocalPoint = {
      x: clamp((msg.x ?? 50) / 100, 0, 1),
      y: clamp((msg.y ?? 50) / 100, 0, 1),
    };
    const start = Date.now();
    const result = await applyFocal(node, focal);
    if (result.error) {
      figma.notify(result.error);
    } else {
      figma.ui.postMessage({
        type: 'perf',
        ms: Date.now() - start,
        source: 'apply',
      });
    }
    void sendState();
  } else if (msg.type === 'auto') {
    autoReapply = msg.enabled ?? true;
  } else if (msg.type === 'get-image' && msg.hash) {
    // The UI requests image bytes once per hash and caches a downscaled
    // preview on its side; the plugin sandbox has no canvas, so scaling
    // happens in the iframe.
    const image = figma.getImageByHash(msg.hash);
    if (image) {
      const bytes = await image.getBytesAsync();
      figma.ui.postMessage({ type: 'image', hash: msg.hash, bytes });
    }
  } else if (msg.type === 'resize' && typeof msg.height === 'number') {
    figma.ui.resize(300, Math.round(clamp(msg.height, 140, 600)));
  } else if (msg.type === 'refresh') {
    void sendState();
  }
};

void sendState();
