'use client';

import DOMPurify from 'dompurify';

/**
 * SVG sanitisation.
 *
 * SVG is markup, not an image format: it can carry `<script>`, event handler
 * attributes, `javascript:` URLs, `<foreignObject>` containing arbitrary
 * HTML, and `<use href="http://…">` that pulls in remote content. Rendering
 * an untrusted SVG inline without sanitising is a stored-XSS vector against
 * whatever app embeds the viewer.
 *
 * Two layers apply here:
 *
 *  1. DOMPurify with the SVG profile, which strips scripts, handlers and
 *     dangerous URL schemes.
 *  2. A hook that removes references to *remote* resources. This is not about
 *     XSS — it is about privacy and offline behaviour: a document should not
 *     silently phone home, and an offline viewer should not render
 *     differently depending on whether a third-party host is reachable.
 */

export interface SanitizeResult {
  html: string;
  /** Element and attribute names that were removed. */
  removed: string[];
  /** Remote references that were neutralised. */
  blockedRemote: number;
}

const REMOTE_URL = /^\s*(?:https?:|\/\/)/i;
const URL_ATTRIBUTES = ['href', 'xlink:href', 'src'];

export function sanitizeSvg(markup: string): SanitizeResult {
  const removed = new Set<string>();
  let blockedRemote = 0;

  const purify = DOMPurify as unknown as typeof DOMPurify & {
    addHook: (name: string, cb: (node: Element, data?: unknown) => void) => void;
    removeAllHooks: () => void;
  };

  purify.addHook('uponSanitizeElement', (node: Element, data?: unknown) => {
    const info = data as { tagName?: string; allowedTags?: Record<string, boolean> } | undefined;
    if (info?.tagName && info.allowedTags && !info.allowedTags[info.tagName]) removed.add(info.tagName);
  });

  purify.addHook('afterSanitizeAttributes', (node: Element) => {
    for (const attribute of URL_ATTRIBUTES) {
      const value = node.getAttribute(attribute);
      if (value && REMOTE_URL.test(value)) {
        node.removeAttribute(attribute);
        blockedRemote++;
      }
    }
    // Inline styles can pull remote resources through url(); rewrite rather
    // than drop, so legitimate fills and gradients survive.
    const style = node.getAttribute('style');
    if (style && /url\(\s*['"]?\s*(?:https?:|\/\/)/i.test(style)) {
      node.setAttribute('style', style.replace(/url\(\s*['"]?\s*(?:https?:|\/\/)[^)]*\)/gi, 'none'));
      blockedRemote++;
    }
  });

  const html = purify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // `foreignObject` embeds full HTML inside the image. Even sanitised it is
    // a large surface for very little benefit in a viewer.
    FORBID_TAGS: ['script', 'foreignObject', 'animate', 'set'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onbegin'],
    ADD_ATTR: ['viewBox', 'preserveAspectRatio'],
    KEEP_CONTENT: false,
  }) as unknown as string;

  purify.removeAllHooks();

  return { html, removed: [...removed], blockedRemote };
}

/** Read `width`/`height`/`viewBox` from sanitised markup. */
export function readSvgSize(html: string): { width: number; height: number } | undefined {
  const container = document.createElement('div');
  container.innerHTML = html;
  const svg = container.querySelector('svg');
  if (!svg) return undefined;

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2]! > 0 && parts[3]! > 0) {
      return { width: parts[2]!, height: parts[3]! };
    }
  }

  const width = Number.parseFloat(svg.getAttribute('width') ?? '');
  const height = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return { width, height };

  return undefined;
}
