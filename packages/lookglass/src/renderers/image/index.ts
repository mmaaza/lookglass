'use client';

import { BaseController } from '../../core/controller.js';
import { ViewerError } from '../../core/errors.js';
import { bitmapBytes } from '../../core/memory.js';
import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import type { Capabilities, DegradationNotice, DocMeta } from '../../types.js';
import { createImageSurface } from './surface.js';

const CAPABILITIES: Capabilities = {
  pages: false,
  search: false,
  zoom: true,
  rotate: true,
  textSelect: false,
  outline: false,
  thumbnails: false,
  sheets: false,
  print: true,
};

/**
 * Safe canvas area across browsers.
 *
 * Chrome allows a much larger backing store, but Safari refuses to allocate
 * past roughly 16.7 M pixels and — critically — fails by returning a blank
 * canvas rather than throwing. Decoding down to this ceiling is the only way
 * to make very large images render predictably everywhere.
 */
const MAX_CANVAS_PIXELS = 16_777_216;

/** Decoding needs the compressed bytes resident, so this is a real ceiling. */
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;

export const imageRenderer: RendererFactory = {
  id: 'lookglass/image',
  kinds: ['image'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    ctx.onProgress({ phase: 'fetching', message: 'Reading image' });

    const blob = await readImageBlob(ctx);
    ctx.token.throwIfAborted();

    // Animated GIFs must stay in an <img>: ImageBitmap decodes a single frame
    // and would silently freeze the animation.
    const animated = ctx.format.mime === 'image/gif';

    ctx.onProgress({ phase: 'rendering', message: 'Decoding' });

    let width = 0;
    let height = 0;
    let degraded: DegradationNotice | undefined;
    let objectUrl: string | undefined;

    if (animated) {
      objectUrl = URL.createObjectURL(blob);
      const size = await probeImageSize(objectUrl);
      width = size.width;
      height = size.height;
    } else {
      const probe = await decodeBitmap(blob);
      width = probe.width;
      height = probe.height;
      const pixels = width * height;

      if (pixels > MAX_CANVAS_PIXELS) {
        // Re-decode at a size the canvas can actually hold. The first decode is
        // released immediately so the two never coexist in memory.
        probe.close();
        const scale = Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const targetWidth = Math.max(1, Math.floor(width * scale));
        const targetHeight = Math.max(1, Math.floor(height * scale));
        const scaled = await decodeBitmap(blob, { resizeWidth: targetWidth, resizeHeight: targetHeight });
        storeBitmap(ctx, scaled);
        degraded = {
          reason: 'size',
          message: `Image downscaled to ${targetWidth} × ${targetHeight} to fit browser canvas limits.`,
          detail: { originalWidth: width, originalHeight: height, shownWidth: targetWidth, shownHeight: targetHeight },
        };
      } else {
        storeBitmap(ctx, probe);
      }
    }

    ctx.token.throwIfAborted();
    ctx.token.onDispose(() => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });

    const controller = new BaseController({
      pageCount: 1,
      capabilities: CAPABILITIES,
      initialViewport: { fit: 'page', zoom: 1 },
    });

    const meta: DocMeta = {
      kind: 'image',
      capabilities: CAPABILITIES,
      pageCount: 1,
      title: ctx.source.name,
      intrinsicSize: { width, height },
      degraded,
      extra: {
        width,
        height,
        type: ctx.format.mime,
        bytes: ctx.source.size,
      },
    };

    const Surface = createImageSurface({
      controller,
      memory: ctx.memory,
      intrinsic: { width, height },
      objectUrl,
      animated,
    });

    return {
      meta,
      controller,
      Surface,
      dispose: () => {
        controller.dispose();
        // The bitmap's `close()` runs through the memory manager's disposer,
        // which is the only place GPU/CPU image memory is actually released.
        ctx.memory.delete('bitmap');
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      },
    };
  },
};

function storeBitmap(ctx: OpenContext, bitmap: ImageBitmap): void {
  const bytes = bitmapBytes(bitmap);
  const stored = ctx.memory.set('bitmap', bitmap, bytes, (value) => value.close());
  if (!stored) {
    bitmap.close();
    throw new ViewerError(
      'out-of-memory',
      `This image needs ${Math.round(bytes / 1024 / 1024)} MB of decoded memory, more than the viewer budget allows.`,
      { detail: { bytes }, retryable: false },
    );
  }
  // Pinned: it is the entire document, so evicting it would blank the view.
  ctx.memory.pin('bitmap');
}

async function readImageBlob(ctx: OpenContext): Promise<Blob> {
  if (ctx.source.size > MAX_IMAGE_BYTES) {
    throw new ViewerError(
      'too-large',
      `${ctx.source.name} is too large to decode in the browser.`,
      { detail: { size: ctx.source.size, max: MAX_IMAGE_BYTES }, retryable: false },
    );
  }
  // Local files already are blobs; this is a reference, not a copy.
  return ctx.source.blob();
}

async function decodeBitmap(blob: Blob, opts?: ImageBitmapOptions): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, {
      // Honour EXIF rotation; without this, phone photos display sideways.
      imageOrientation: 'from-image',
      premultiplyAlpha: 'default',
      ...opts,
    });
  } catch (err) {
    throw new ViewerError('corrupt', 'This image could not be decoded. It may be corrupt or use an unsupported codec.', {
      cause: err,
      retryable: false,
    });
  }
}

function probeImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new ViewerError('corrupt', 'This image could not be decoded.'));
    image.src = url;
  });
}

export default imageRenderer;
