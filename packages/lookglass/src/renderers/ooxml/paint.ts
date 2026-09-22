'use client';

import type { DisplayItem, ImageItem, PageDisplay, TextItem } from '../../ooxml/display.js';

/**
 * Paints a display list into DOM.
 *
 * Every element is created with `createElement` and given known properties;
 * nothing is parsed as HTML and no URL is loaded except blob URLs made from
 * the document's own image parts. Text stays real text, so it can be
 * selected, copied and found by the browser's accessibility tree.
 *
 * Layers, bottom to top: shapes (fills and rules), pictures, text. Within a
 * layer, list order is paint order.
 */

export interface ImageSource {
  /** Blob URL for an image part; resolves when the bytes have arrived. */
  url(part: string): Promise<string | undefined>;
}

const SVG = 'http://www.w3.org/2000/svg';

export function paintPage(page: PageDisplay, root: HTMLElement, images: ImageSource): void {
  const document = root.ownerDocument;
  root.replaceChildren();
  root.style.width = `${page.width}px`;
  root.style.height = `${page.height}px`;

  const shapes = document.createElementNS(SVG, 'svg');
  shapes.setAttribute('width', String(page.width));
  shapes.setAttribute('height', String(page.height));
  shapes.setAttribute('aria-hidden', 'true');
  shapes.setAttribute('class', 'lg-shapes');
  const pictures = document.createElement('div');
  pictures.className = 'lg-pictures';
  const text = document.createElement('div');
  text.className = 'lg-text';

  const behind: ImageItem[] = [];
  for (const item of page.items) {
    switch (item.t) {
      case 'rect':
        shapes.append(rect(item));
        break;
      case 'line':
        for (const line of lines(item)) shapes.append(line);
        break;
      case 'path': {
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', item.d);
        path.setAttribute('fill', item.fill ?? 'none');
        if (item.stroke) {
          path.setAttribute('stroke', item.stroke);
          path.setAttribute('stroke-width', String(item.strokeWidth ?? 1));
        }
        shapes.append(path);
        break;
      }
      case 'image':
        if (item.behind) behind.push(item);
        else pictures.append(picture(item, images));
        break;
      case 'text':
        text.append(textElement(item));
        break;
    }
  }
  for (const item of behind) pictures.prepend(picture(item, images));
  root.append(shapes, pictures, text);

  function rect(item: Extract<DisplayItem, { t: 'rect' }>): SVGElement {
    const element = document.createElementNS(SVG, 'rect');
    element.setAttribute('x', String(item.x));
    element.setAttribute('y', String(item.y));
    element.setAttribute('width', String(Math.max(0, item.w)));
    element.setAttribute('height', String(Math.max(0, item.h)));
    element.setAttribute('fill', item.fill);
    return element;
  }

  function lines(item: Extract<DisplayItem, { t: 'line' }>): SVGElement[] {
    const make = (dx: number, dy: number, width: number) => {
      const element = document.createElementNS(SVG, 'line');
      element.setAttribute('x1', String(item.x1 + dx));
      element.setAttribute('y1', String(item.y1 + dy));
      element.setAttribute('x2', String(item.x2 + dx));
      element.setAttribute('y2', String(item.y2 + dy));
      element.setAttribute('stroke', item.color);
      element.setAttribute('stroke-width', String(width));
      if (item.style === 'dotted') element.setAttribute('stroke-dasharray', `${width} ${width * 2}`);
      if (item.style === 'dashed') element.setAttribute('stroke-dasharray', `${width * 4} ${width * 2}`);
      return element;
    };
    if (item.style !== 'double') return [make(0, 0, item.width)];
    // Two thin rules either side of the line's centre.
    const vertical = Math.abs(item.x1 - item.x2) < Math.abs(item.y1 - item.y2);
    const gap = Math.max(1, item.width);
    return [make(vertical ? -gap : 0, vertical ? 0 : -gap, Math.max(0.5, item.width / 3)), make(vertical ? gap : 0, vertical ? 0 : gap, Math.max(0.5, item.width / 3))];
  }

  function picture(item: ImageItem, source: ImageSource): HTMLElement {
    const frame = document.createElement('div');
    frame.className = 'lg-picture';
    Object.assign(frame.style, { left: `${item.x}px`, top: `${item.y}px`, width: `${item.w}px`, height: `${item.h}px` });
    if (item.rotation) frame.style.transform = `rotate(${item.rotation}deg)`;
    const img = document.createElement('img');
    img.alt = item.alt ?? '';
    img.decoding = 'async';
    img.draggable = false;
    const crop = item.crop;
    if (crop) {
      // Scale the whole image so the visible part fills the frame.
      const scaleX = 1 / Math.max(0.01, 1 - crop.l - crop.r);
      const scaleY = 1 / Math.max(0.01, 1 - crop.t - crop.b);
      Object.assign(img.style, {
        width: `${item.w * scaleX}px`,
        height: `${item.h * scaleY}px`,
        left: `${-crop.l * item.w * scaleX}px`,
        top: `${-crop.t * item.h * scaleY}px`,
      });
    }
    void source.url(item.part).then((url) => {
      if (url) img.src = url;
      else frame.classList.add('lg-picture-missing');
    });
    frame.append(img);
    return frame;
  }
}

function textElement(item: TextItem): HTMLElement {
  const element = document.createElement(item.link ? 'a' : 'span');
  element.textContent = item.text;
  const height = item.ascent + item.descent;
  const style = element.style;
  style.left = `${item.x}px`;
  // A box exactly as tall as the font puts the baseline at its ascent.
  style.top = `${item.y - item.ascent}px`;
  style.height = `${height}px`;
  style.lineHeight = `${height}px`;
  style.font = item.font;
  style.color = item.color;
  if (item.wordSpacing) style.wordSpacing = `${item.wordSpacing}px`;
  if (item.letterSpacing) style.letterSpacing = `${item.letterSpacing}px`;
  if (item.scaleX && item.scaleX !== 1) {
    style.transform = `scaleX(${item.scaleX})`;
    style.transformOrigin = 'left';
  }
  if (item.background) style.backgroundColor = item.background;
  const decorations: string[] = [];
  if (item.underline) decorations.push('underline');
  if (item.strike) decorations.push('line-through');
  if (decorations.length > 0) {
    style.textDecorationLine = decorations.join(' ');
    if (item.underline === 'double' || item.strike === 'double') style.textDecorationStyle = 'double';
    else if (item.underline === 'dotted' || item.underline === 'dashed' || item.underline === 'wavy') style.textDecorationStyle = item.underline;
    if (item.underline === 'thick') style.textDecorationThickness = '2px';
    if (item.underlineColor) style.textDecorationColor = item.underlineColor;
    style.textUnderlineOffset = '0.12em';
  }
  if (item.link) {
    // Links were allow-listed in the worker: http(s), mailto, tel, or #bookmark.
    const anchor = element as HTMLAnchorElement;
    anchor.setAttribute('href', item.link);
    if (/^https?:/i.test(item.link)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
  }
  if (item.s !== undefined) element.dataset.s = String(item.s);
  return element;
}

/** Styles for painted pages; injected into the surface's shadow root. */
export const PAINT_CSS = `
.lg-painted { position: relative; background: #fff; color-scheme: light; overflow: hidden; }
.lg-painted .lg-shapes { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.lg-painted .lg-pictures, .lg-painted .lg-text { position: absolute; inset: 0; }
.lg-painted .lg-picture { position: absolute; overflow: hidden; }
.lg-painted .lg-picture img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; max-width: none; }
.lg-painted .lg-picture-missing { background: #f3f4f6; outline: 1px solid #d0d5dd; }
.lg-painted .lg-text > * { position: absolute; white-space: pre; margin: 0; padding: 0; border: 0; text-decoration-skip-ink: auto; }
.lg-painted .lg-text > a { cursor: pointer; }
.lg-painted .lg-text ::selection { background: rgb(0 120 215 / 0.35); }
`;
