/**
 * The display list: what the layout worker hands the main thread for one
 * page (or slide).
 *
 * Everything is already positioned, in CSS pixels at 100% zoom, so painting
 * is a single pass with no measurement and no layout decisions. The list is
 * plain data — structured-cloneable, and free of any markup or CSS from the
 * document — which is what makes it safe to paint: the painter builds
 * elements with `createElement` and assigns known properties, never parses
 * HTML, and never loads a URL it did not construct.
 */

export interface PageDisplay {
  width: number;
  height: number;
  items: DisplayItem[];
}

export type DisplayItem = TextItem | RectItem | LineItem | ImageItem | PathItem;

export interface TextItem {
  t: 'text';
  /** Left edge and baseline. */
  x: number;
  y: number;
  text: string;
  /** CSS `font` shorthand. */
  font: string;
  /**
   * Ascent and descent of the rendered font as the browser lays it out.
   * The painter makes the text's box exactly this tall, so its baseline
   * lands on `y` whatever font ends up being used.
   */
  ascent: number;
  descent: number;
  /** Offset of this text in the page's search text; body text only. */
  s?: number;
  color: string;
  /** Extra space per space character, for justified lines. */
  wordSpacing?: number;
  letterSpacing?: number;
  /** Horizontal scale (`w:w`), 1 = 100%. */
  scaleX?: number;
  underline?: 'single' | 'double' | 'dotted' | 'dashed' | 'wavy' | 'thick';
  underlineColor?: string;
  strike?: 'single' | 'double';
  /** Highlight or shading behind the text. */
  background?: string;
  /** Width the layout reserved, for backgrounds and hit boxes. */
  width: number;
  /** External URL (already allow-listed) or internal bookmark (`#name`). */
  link?: string;
  /** Text order index within the page, for search and selection. */
  order: number;
}

export interface RectItem {
  t: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

export interface LineItem {
  t: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  color: string;
  style?: 'solid' | 'dotted' | 'dashed' | 'double';
}

export interface ImageItem {
  t: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Package part holding the image; fetched from the worker on demand. */
  part: string;
  /** Crop as fractions of the source image (DrawingML `srcRect`). */
  crop?: { l: number; t: number; r: number; b: number };
  /** Degrees, clockwise. */
  rotation?: number;
  alt?: string;
  /** Drawn behind the text (`behindDoc`). */
  behind?: boolean;
}

export interface PathItem {
  t: 'path';
  /** SVG path data in page pixels. */
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

/** Search index entry for one page: its text, and each text item's start offset. */
export interface PageText {
  text: string;
  /** Parallel to the page's text items in `order`. */
  starts: number[];
}
