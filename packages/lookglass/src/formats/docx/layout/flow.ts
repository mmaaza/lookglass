import type { DisplayItem, ImageItem } from '../../../ooxml/display.js';
import type { Block, Drawing, Paragraph, SectionProps, Table } from '../model.js';
import { formatNumber } from '../numbering.js';
import {
  LineBreaker,
  buildAtoms,
  colorOf,
  fontShorthand,
  paintLine,
  type Atom,
  type FieldValues,
  type FontService,
  type Line,
  type LineContext,
} from './paragraph.js';
import { eighthPoint, emu, twip } from './units.js';

/**
 * Block flow: stacking paragraphs and tables into an area, and — for the
 * document body — breaking that flow across columns and pages.
 *
 * The same code lays out the body, headers and footers, and table cells;
 * only the body is *paged*. Page-breaking decisions follow Word's rules:
 * keep-with-next chains move together, keep-lines paragraphs are not split,
 * widow/orphan control never leaves a single line of a paragraph alone at
 * the top or bottom of a page, and a line that does not fit moves on.
 */

export interface Area {
  /** Page coordinates, px. */
  left: number;
  width: number;
  top: number;
  bottom: number;
}

export interface PageGeometry {
  width: number;
  height: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
}

export interface FlowEnv {
  fonts: FontService;
  defaultTabStop: number;
  fields?: FieldValues;
  measureField: LineContext['measureField'];
}

/** Receives events the body cares about; cells and headers ignore them. */
export interface FlowHooks {
  /** Called when content no longer fits; returns the next area (column or page). */
  nextArea?(reason: 'overflow' | 'page' | 'column'): { area: Area; items: DisplayItem[]; floats: DisplayItem[]; page: PageGeometry };
  onLine?(line: Line, pageTop: boolean): void;
  onBlockStart?(): void;
}

interface FloatBox {
  x: number;
  y: number;
  w: number;
  h: number;
  wrap: NonNullable<Drawing['anchor']>['wrap'];
}

const EPSILON = 0.5;

export class Flow {
  area: Area;
  items: DisplayItem[];
  floatItems: DisplayItem[];
  page: PageGeometry;
  y: number;
  private readonly env: FlowEnv;
  private readonly hooks: FlowHooks;
  private readonly paged: boolean;
  private floats: FloatBox[] = [];
  private readonly order = { value: 0 };
  /** Bottom of the previous paragraph's spacing, to apply contextual spacing and borders. */
  private previous?: Paragraph;

  constructor(env: FlowEnv, area: Area, page: PageGeometry, items: DisplayItem[], hooks: FlowHooks = {}, floatItems: DisplayItem[] = items) {
    this.env = env;
    this.area = area;
    this.page = page;
    this.items = items;
    this.floatItems = floatItems;
    this.hooks = hooks;
    this.paged = Boolean(hooks.nextArea);
    this.y = area.top;
  }

  get atAreaTop(): boolean {
    return this.y <= this.area.top + EPSILON;
  }

  /** Lay out blocks with no page breaks (cells, headers, footers). Returns the content bottom. */
  placeAll(blocks: Block[]): number {
    blocks.forEach((block, index) => {
      if (block.kind === 'p') this.placeParagraph(block, blocks[index + 1]);
      else this.placeTable(block);
    });
    return this.y;
  }

  breakTo(reason: 'page' | 'column' | 'overflow'): void {
    if (!this.hooks.nextArea) return;
    const next = this.hooks.nextArea(reason);
    this.area = next.area;
    this.items = next.items;
    this.floatItems = next.floats;
    this.page = next.page;
    this.y = next.area.top;
    this.floats = [];
    this.previous = undefined;
    this.lastAfter = 0;
    this.softTop = reason === 'overflow';
  }

  /**
   * The area was entered by text flowing on, not by a page or section break.
   * Word drops "space before" for the first paragraph in that case.
   */
  private softTop = false;

  /* ---------------------------------------------------------------- *
   * Paragraphs
   * ---------------------------------------------------------------- */

  placeParagraph(paragraph: Paragraph, next: Block | undefined, keepChain?: Paragraph[]): void {
    if (this.pendingBreak) {
      // An empty paragraph that only carries the section break rides along with the page break.
      if (paragraph.section && isEmptyParagraph(paragraph)) return;
      this.resolvePendingBreak();
    }
    const props = paragraph.props;
    const atoms = buildAtoms(paragraph, this.env.fonts);
    const context = this.lineContext(paragraph, atoms);

    if (this.paged && props.pageBreakBefore && !this.atAreaTop) this.breakTo('page');

    const previous = this.previous;
    const sameStyleAsPrevious = previous && previous.props.styleId === props.styleId;
    let before = twip(props.beforeAutospacing ? 280 : props.spaceBefore);
    if (props.contextualSpacing && sameStyleAsPrevious) before = 0;
    // HTML-style automatic spacing collapses between neighbours, as margins do on the web.
    if (props.beforeAutospacing && previous?.props.afterAutospacing) before = 0;
    let after = twip(props.afterAutospacing ? 280 : props.spaceAfter);
    const nextParagraph = next?.kind === 'p' ? next : undefined;
    if (props.contextualSpacing && nextParagraph && nextParagraph.props.styleId === props.styleId) after = 0;

    // Dry run: line heights with the paragraph's own bounds, for page-break decisions.
    const dryLines = linesOf(new LineBreaker([...atoms], paragraph, context));
    const heights = dryLines.map((line) => line.height);
    const total = heights.reduce((sum, height) => sum + height, 0);

    if (this.paged && !this.atAreaTop) {
      const available = this.area.bottom - this.y;
      // Keep with next: this paragraph plus the start of the next block must share a page.
      if (props.keepNext && next) {
        const chain = before + total + after + this.leadHeight(next);
        const fresh = this.area.bottom - this.area.top;
        if (chain > available + EPSILON && chain <= fresh) this.breakTo('overflow');
      } else if (props.keepLines && before + total > available + EPSILON && total <= this.area.bottom - this.area.top) {
        this.breakTo('overflow');
      }
    }
    void keepChain;

    if (this.paged && this.softTop && this.atAreaTop) before = 0;
    // Space between two paragraphs is the larger of the first's "after" and
    // the second's "before", not their sum.
    if (previous && this.lastAfter > 0) before = Math.max(0, before - this.lastAfter);
    const top = this.y;
    this.y += before;
    const breaker = new LineBreaker(atoms, paragraph, context);
    let index = 0;
    let segmentTop = this.y;
    const segments: Array<{ top: number; bottom: number; items: DisplayItem[] }> = [];
    const flushSegment = () => {
      if (this.y > segmentTop) segments.push({ top: segmentTop, bottom: this.y, items: this.items });
    };

    // Lines allowed in the current area; decided each time the paragraph enters an area.
    let allowed: number | undefined;
    while (!breaker.done) {
      if (this.paged) {
        if (allowed === undefined) {
          const remaining = heights.length - index;
          let keep = countFitting(heights, index, this.area.bottom - this.y);
          if (keep < remaining) {
            if (props.widowControl && remaining > 1) {
              if (index === 0 && keep === 1) keep = 0; // orphan: a lone first line at the bottom
              else if (remaining - keep === 1 && keep >= 2) keep -= 1; // widow: a lone last line at the top
            }
            if (props.keepLines && index === 0) keep = 0;
          }
          if (keep === 0 && !this.atAreaTop) {
            flushSegment();
            this.breakTo('overflow');
            segmentTop = this.y;
            continue;
          }
          // An area that cannot hold even one line still takes one: content must go somewhere.
          allowed = keep === 0 ? 1 : keep >= remaining ? Number.POSITIVE_INFINITY : keep;
        }
        if (allowed <= 0) {
          flushSegment();
          this.breakTo('overflow');
          segmentTop = this.y;
          allowed = undefined;
          continue;
        }
      }

      const estimate = heights[index] ?? heights[heights.length - 1] ?? 0;
      // Wrap around floating pictures on this page.
      this.skipTopAndBottomFloats(estimate);
      const line = breaker.next(this.boundsFor(breaker, estimate));
      const lineTop = this.y;
      this.hooks.onLine?.(line, lineTop <= this.area.top + EPSILON);
      paintLine(line, { x: this.area.left, top: lineTop, align: props.align, fields: this.env.fields, context, order: this.order }, this.items, (atom, x, y) =>
        this.paintInlineImage(atom, x, y),
      );
      for (const drawing of line.floats) this.placeFloat(drawing, top, lineTop);
      this.y += line.height;
      this.softTop = false;
      index++;
      if (allowed !== undefined) allowed--;

      if (this.paged && (line.end === 'page' || line.end === 'column')) {
        if (breaker.done) {
          // A break that ends its paragraph takes effect when the next content
          // arrives. If that is a section break starting a new page anyway,
          // the two merge instead of leaving a blank page — as in Word.
          this.pendingBreak = line.end;
        } else {
          flushSegment();
          this.breakTo(line.end === 'column' ? 'column' : 'page');
          segmentTop = this.y;
          allowed = undefined;
        }
      }
    }
    flushSegment();
    this.paintParagraphDecorations(paragraph, segments, previous, nextParagraph);
    this.y += after;
    this.lastAfter = after;
    this.previous = paragraph;
  }

  /** Space after the previous paragraph, when it directly precedes the next one. */
  private lastAfter = 0;

  private lineContext(paragraph: Paragraph, atoms: Atom[]): LineContext {
    const markFont = this.env.fonts.font(paragraph.markProps, 'ascii');
    void atoms;
    return {
      fonts: this.env.fonts,
      columnWidth: this.area.width,
      defaultTabStop: this.env.defaultTabStop,
      markFont,
      fields: this.env.fields,
      measureField: this.env.measureField,
    };
  }

  /** Height of the part of a block that must travel with a keep-with-next paragraph. */
  private leadHeight(block: Block): number {
    if (block.kind === 'tbl') return 20;
    const atoms = buildAtoms(block, this.env.fonts);
    const lines = linesOf(new LineBreaker(atoms, block, this.lineContext(block, atoms)));
    const firstLines = lines.slice(0, block.props.widowControl && lines.length > 1 ? 2 : 1);
    const lead = twip(block.props.spaceBefore) + firstLines.reduce((sum, line) => sum + line.height, 0);
    return block.props.keepNext ? lead + 0 : lead;
  }

  private boundsFor(breaker: LineBreaker, height: number): { left: number; right: number } {
    const bounds = breaker.defaultBounds();
    if (this.floats.length === 0) return bounds;
    let { left, right } = bounds;
    const top = this.y;
    const bottom = this.y + height;
    for (const float of this.floats) {
      if (float.wrap !== 'square' && float.wrap !== 'tight' && float.wrap !== 'through') continue;
      if (float.y >= bottom || float.y + float.h <= top) continue;
      const floatLeft = float.x - this.area.left;
      const floatRight = floatLeft + float.w;
      const leftRoom = floatLeft - left;
      const rightRoom = right - floatRight;
      if (rightRoom >= leftRoom) left = Math.max(left, floatRight);
      else right = Math.min(right, floatLeft);
    }
    return { left, right: Math.max(left, right) };
  }

  private skipTopAndBottomFloats(height: number): void {
    for (let guard = 0; guard < 8; guard++) {
      const blocking = this.floats.find(
        (float) => float.wrap === 'topAndBottom' && float.y < this.y + height && float.y + float.h > this.y,
      );
      if (!blocking) return;
      this.y = blocking.y + blocking.h;
    }
  }

  private placeFloat(drawing: Drawing, paragraphTop: number, lineTop: number): void {
    const anchor = drawing.anchor!;
    const width = emu(drawing.width);
    const height = emu(drawing.height);
    const page = this.page;
    const horizontalBox = (() => {
      switch (anchor.horizontal.relativeFrom) {
        case 'page':
          return { start: 0, size: page.width };
        case 'margin':
        case 'insideMargin':
        case 'outsideMargin':
          return { start: page.marginLeft, size: page.width - page.marginLeft - page.marginRight };
        case 'leftMargin':
          return { start: 0, size: page.marginLeft };
        case 'rightMargin':
          return { start: page.width - page.marginRight, size: page.marginRight };
        default:
          return { start: this.area.left, size: this.area.width };
      }
    })();
    const verticalBox = (() => {
      switch (anchor.vertical.relativeFrom) {
        case 'page':
          return { start: 0, size: page.height };
        case 'margin':
          return { start: page.marginTop, size: page.height - page.marginTop - page.marginBottom };
        case 'topMargin':
          return { start: 0, size: page.marginTop };
        case 'bottomMargin':
          return { start: page.height - page.marginBottom, size: page.marginBottom };
        case 'line':
          return { start: lineTop, size: 0 };
        default:
          return { start: paragraphTop, size: 0 };
      }
    })();
    const place = (box: { start: number; size: number }, align: string | undefined, offset: number | undefined, size: number) => {
      if (align === 'center') return box.start + (box.size - size) / 2;
      if (align === 'right' || align === 'bottom' || align === 'outside') return box.start + box.size - size;
      if (align === 'left' || align === 'top' || align === 'inside') return box.start;
      return box.start + emu(offset ?? 0);
    };
    const x = place(horizontalBox, anchor.horizontal.align, anchor.horizontal.offset, width);
    const y = place(verticalBox, anchor.vertical.align, anchor.vertical.offset, height);
    this.paintDrawing(drawing, x, y, width, height, this.floatItems, anchor.behindDoc);
    if (anchor.wrap !== 'none') {
      this.floats.push({
        x: x - emu(anchor.distance.l),
        y: y - emu(anchor.distance.t),
        w: width + emu(anchor.distance.l + anchor.distance.r),
        h: height + emu(anchor.distance.t + anchor.distance.b),
        wrap: anchor.wrap,
      });
    }
  }

  private paintInlineImage(atom: Extract<Atom, { k: 'image' }>, x: number, y: number): void {
    this.paintDrawing(atom.drawing, x, y, atom.width, atom.height, this.items, false);
  }

  private paintDrawing(drawing: Drawing, x: number, y: number, width: number, height: number, out: DisplayItem[], behind: boolean): void {
    if (drawing.part) {
      const item: ImageItem = { t: 'image', x, y, w: width, h: height, part: drawing.part, alt: drawing.alt, behind: behind || undefined };
      if (drawing.crop) item.crop = drawing.crop;
      if (drawing.rotation) item.rotation = drawing.rotation;
      out.push(item);
      return;
    }
    // Something we cannot draw yet keeps its space and says what it is.
    out.push({ t: 'rect', x, y, w: width, h: height, fill: '#F3F4F6' });
    out.push({ t: 'line', x1: x, y1: y, x2: x + width, y2: y, width: 1, color: '#D0D5DD' });
    out.push({ t: 'line', x1: x, y1: y + height, x2: x + width, y2: y + height, width: 1, color: '#D0D5DD' });
    out.push({ t: 'line', x1: x, y1: y, x2: x, y2: y + height, width: 1, color: '#D0D5DD' });
    out.push({ t: 'line', x1: x + width, y1: y, x2: x + width, y2: y + height, width: 1, color: '#D0D5DD' });
    if (width > 60 && height > 20) {
      out.push({
        t: 'text',
        x: x + 8,
        y: y + 18,
        text: drawing.placeholder ?? 'Object',
        font: '12px system-ui, sans-serif',
        ascent: 12,
        descent: 4,
        width: width - 16,
        color: '#667085',
        order: this.order.value++,
      });
    }
  }

  /** Paragraph shading and borders, merged with neighbours that have the same borders. */
  private paintParagraphDecorations(
    paragraph: Paragraph,
    segments: Array<{ top: number; bottom: number; items: DisplayItem[] }>,
    previous: Paragraph | undefined,
    next: Paragraph | undefined,
  ): void {
    const props = paragraph.props;
    if (!props.shading && !props.borders) return;
    const left = this.area.left + twip(props.indentLeft);
    const right = this.area.left + this.area.width - twip(props.indentRight);
    const sameBorders = (other: Paragraph | undefined) => other && JSON.stringify(other.props.borders) === JSON.stringify(props.borders);
    segments.forEach((segment, index) => {
      const decorations: DisplayItem[] = [];
      if (props.shading) decorations.push({ t: 'rect', x: left, y: segment.top, w: right - left, h: segment.bottom - segment.top, fill: `#${props.shading}` });
      const borders = props.borders;
      if (borders) {
        const edge = (spec: NonNullable<typeof borders.top> | undefined, x1: number, y1: number, x2: number, y2: number) => {
          if (!spec) return;
          decorations.push({ t: 'line', x1, y1, x2, y2, width: Math.max(0.75, eighthPoint(spec.size)), color: colorOf(spec.color), style: lineStyle(spec.style) });
        };
        if (index === 0 && !sameBorders(previous)) edge(borders.top, left, segment.top - 1, right, segment.top - 1);
        if (index === segments.length - 1 && !sameBorders(next)) edge(borders.bottom, left, segment.bottom + 1, right, segment.bottom + 1);
        edge(borders.left, left - 4, segment.top, left - 4, segment.bottom);
        edge(borders.right, right + 4, segment.top, right + 4, segment.bottom);
      }
      // Behind the text: decorations go first in paint order.
      segment.items.unshift(...decorations);
    });
  }

  /* ---------------------------------------------------------------- *
   * Tables
   * ---------------------------------------------------------------- */

  /** A page or column break waiting for the next content. */
  pendingBreak: 'page' | 'column' | undefined;

  resolvePendingBreak(): void {
    const pending = this.pendingBreak;
    this.pendingBreak = undefined;
    if (pending) this.breakTo(pending);
  }

  placeTable(table: Table): void {
    this.resolvePendingBreak();
    this.lastAfter = 0;
    const columns = table.grid.map(twip);
    const tableWidth = columns.reduce((sum, width) => sum + width, 0);
    let left = this.area.left + twip(table.indent);
    if (table.align === 'center') left = this.area.left + (this.area.width - tableWidth) / 2;
    else if (table.align === 'right') left = this.area.left + this.area.width - tableWidth;
    const offsets = [0];
    for (const width of columns) offsets.push(offsets[offsets.length - 1]! + width);

    // Rows are laid out ahead of placement so a row can move to the next page whole.
    interface CellLayout {
      col: number;
      span: number;
      items: DisplayItem[];
      contentHeight: number;
      props: Table['rows'][number]['cells'][number]['props'];
      rowSpan: number;
      marginTop: number;
    }
    const layoutRows: Array<{ cells: CellLayout[]; height: number; header: boolean }> = [];
    const mergeOrigins = new Map<number, CellLayout>();
    table.rows.forEach((row, rowIndex) => {
      const cells: CellLayout[] = [];
      let col = 0;
      for (const cell of row.cells) {
        const span = Math.max(1, cell.props.gridSpan);
        const margins = {
          top: twip(cell.props.margins.top ?? table.cellMargins.top),
          bottom: twip(cell.props.margins.bottom ?? table.cellMargins.bottom),
          left: twip(cell.props.margins.left ?? table.cellMargins.left),
          right: twip(cell.props.margins.right ?? table.cellMargins.right),
        };
        const cellWidth = (offsets[Math.min(col + span, offsets.length - 1)] ?? tableWidth) - (offsets[col] ?? 0);
        const items: DisplayItem[] = [];
        let contentHeight = 0;
        if (cell.props.vMerge !== 'continue') {
          const inner = new Flow(
            this.env,
            { left: margins.left, width: Math.max(1, cellWidth - margins.left - margins.right), top: margins.top, bottom: Number.POSITIVE_INFINITY },
            this.page,
            items,
          );
          contentHeight = inner.placeAll(cell.blocks) + margins.bottom;
        }
        const layout: CellLayout = { col, span, items, contentHeight, props: cell.props, rowSpan: 1, marginTop: margins.top };
        if (cell.props.vMerge === 'restart') mergeOrigins.set(col, layout);
        else if (cell.props.vMerge === 'continue') {
          const origin = mergeOrigins.get(col);
          if (origin) origin.rowSpan++;
        } else mergeOrigins.delete(col);
        cells.push(layout);
        col += span;
      }
      let height = 0;
      for (const cell of cells) if (cell.props.vMerge === undefined) height = Math.max(height, cell.contentHeight);
      if (row.height !== undefined) {
        const minimum = twip(row.height);
        height = row.heightRule === 'exact' ? minimum : Math.max(height, minimum);
      }
      if (height === 0) height = cells.reduce((max, cell) => Math.max(max, cell.contentHeight), 0) || 12;
      layoutRows.push({ cells, height, header: row.header });
      void rowIndex;
    });
    // A merged cell taller than the rows it spans stretches the last of them.
    layoutRows.forEach((row, rowIndex) => {
      for (const cell of row.cells) {
        if (cell.props.vMerge !== 'restart' || cell.rowSpan < 2) continue;
        const spanned = layoutRows.slice(rowIndex, rowIndex + cell.rowSpan);
        const available = spanned.reduce((sum, r) => sum + r.height, 0);
        if (cell.contentHeight > available) spanned[spanned.length - 1]!.height += cell.contentHeight - available;
      }
    });

    const headerRows: typeof layoutRows = [];
    for (const row of layoutRows) {
      if (!row.header) break;
      headerRows.push(row);
    }

    const drawRow = (row: (typeof layoutRows)[number], rowIndex: number, top: number) => {
      for (const cell of row.cells) {
        if (cell.props.vMerge === 'continue') continue;
        const x = left + (offsets[cell.col] ?? 0);
        const w = (offsets[Math.min(cell.col + cell.span, offsets.length - 1)] ?? tableWidth) - (offsets[cell.col] ?? 0);
        const spanRows = cell.props.vMerge === 'restart' ? layoutRows.slice(rowIndex, rowIndex + cell.rowSpan) : [row];
        const h = spanRows.reduce((sum, r) => sum + r.height, 0);
        if (cell.props.shading) this.items.push({ t: 'rect', x, y: top, w, h, fill: `#${cell.props.shading}` });
        const shift = cell.props.vAlign === 'center' ? (h - cell.contentHeight) / 2 : cell.props.vAlign === 'bottom' ? h - cell.contentHeight : 0;
        for (const item of cell.items) this.items.push(offsetItem(item, x, top + Math.max(0, shift)));
        const lastRow = rowIndex + spanRows.length >= layoutRows.length;
        const lastCol = cell.col + cell.span >= columns.length;
        const border = (own: typeof table.borders.top | undefined, fallback: typeof table.borders.top | undefined) => (own === undefined ? fallback : own);
        const edges: Array<[typeof table.borders.top | undefined, number, number, number, number]> = [
          [border(cell.props.borders.top, rowIndex === 0 ? table.borders.top : table.borders.insideH), x, top, x + w, top],
          [border(cell.props.borders.bottom, lastRow ? table.borders.bottom : table.borders.insideH), x, top + h, x + w, top + h],
          [border(cell.props.borders.left, cell.col === 0 ? table.borders.left : table.borders.insideV), x, top, x, top + h],
          [border(cell.props.borders.right, lastCol ? table.borders.right : table.borders.insideV), x + w, top, x + w, top + h],
        ];
        for (const [spec, x1, y1, x2, y2] of edges) {
          if (!spec) continue;
          this.items.push({ t: 'line', x1, y1, x2, y2, width: Math.max(0.75, eighthPoint(spec.size)), color: colorOf(spec.color), style: lineStyle(spec.style) });
        }
      }
    };

    const breakAndRepeatHeaders = (rowIndex: number) => {
      this.breakTo('overflow');
      // Header rows repeat at the top of each page the table continues on.
      if (rowIndex >= headerRows.length) {
        headerRows.forEach((header, headerIndex) => {
          drawRow(header, headerIndex, this.y);
          this.y += header.height;
        });
      }
    };

    layoutRows.forEach((initial, rowIndex) => {
      let row = initial;
      for (let guard = 0; guard < 500; guard++) {
        const room = this.area.bottom - this.y;
        if (!this.paged || row.height <= room + EPSILON) {
          drawRow(row, rowIndex, this.y);
          this.y += row.height;
          return;
        }
        // Rows may break across pages unless told not to, as in Word.
        const splittable = !table.rows[rowIndex]!.cantSplit && !row.header && row.cells.every((cell) => cell.props.vMerge === undefined);
        const split = splittable ? splitRow(row, room) : undefined;
        if (split) {
          drawRow(split.head, rowIndex, this.y);
          this.y += split.head.height;
          breakAndRepeatHeaders(rowIndex);
          row = split.tail;
          continue;
        }
        if (this.atAreaTop) {
          // Taller than a page and unsplittable: it overflows, as it would in Word.
          drawRow(row, rowIndex, this.y);
          this.y += row.height;
          return;
        }
        breakAndRepeatHeaders(rowIndex);
      }
    });
    this.previous = undefined;
    this.lastAfter = 0;
  }
}

interface SplittableRow {
  cells: Array<{ items: DisplayItem[]; contentHeight: number; marginTop: number; props: { vMerge?: string } }>;
  height: number;
  header: boolean;
}

/**
 * Split a row at `room` pixels: content that ends above the cut stays, the
 * rest moves to a copy of the row that continues on the next page. Lines
 * are never cut in half. Returns undefined when nothing would fit above the
 * cut, or everything would.
 */
function splitRow<T extends SplittableRow>(row: T, room: number): { head: T; tail: T } | undefined {
  let anyHead = false;
  let anyTail = false;
  const heads: T['cells'] = [];
  const tails: T['cells'] = [];
  for (const cell of row.cells) {
    const head: DisplayItem[] = [];
    const tail: DisplayItem[] = [];
    for (const item of cell.items) (itemBottom(item) <= room + EPSILON ? head : tail).push(item);
    if (head.some((item) => item.t === 'text' || item.t === 'image')) anyHead = true;
    if (tail.length > 0) anyTail = true;
    const tailTop = tail.length > 0 ? Math.min(...tail.map(itemTop)) : cell.marginTop;
    const shift = Math.max(0, tailTop - cell.marginTop);
    heads.push({ ...cell, items: head, contentHeight: room });
    tails.push({ ...cell, items: tail.map((item) => offsetItem(item, 0, -shift)), contentHeight: Math.max(0, cell.contentHeight - shift) });
  }
  if (!anyHead || !anyTail) return undefined;
  const tailHeight = Math.max(12, ...tails.map((cell) => cell.contentHeight));
  return { head: { ...row, cells: heads, height: room }, tail: { ...row, cells: tails, height: tailHeight } };
}

function itemTop(item: DisplayItem): number {
  switch (item.t) {
    case 'text':
      return item.y - item.ascent;
    case 'line':
      return Math.min(item.y1, item.y2);
    case 'path':
      return 0;
    default:
      return item.y;
  }
}

function itemBottom(item: DisplayItem): number {
  switch (item.t) {
    case 'text':
      return item.y + item.descent;
    case 'line':
      return Math.max(item.y1, item.y2);
    case 'path':
      return 0;
    case 'rect':
    case 'image':
      return item.y + item.h;
  }
}

function isEmptyParagraph(paragraph: Paragraph): boolean {
  return !paragraph.label && paragraph.inlines.every((inline) => inline.kind === 'bookmark' || inline.kind === 'renderedBreak');
}

function linesOf(breaker: LineBreaker): Line[] {
  const lines: Line[] = [];
  for (let guard = 0; !breaker.done && guard < 100_000; guard++) lines.push(breaker.next());
  return lines;
}

function countFitting(heights: number[], from: number, room: number): number {
  let used = 0;
  let count = 0;
  for (let i = from; i < heights.length; i++) {
    used += heights[i]!;
    if (used > room + EPSILON) break;
    count++;
  }
  return count;
}

function lineStyle(style: string): 'solid' | 'dotted' | 'dashed' | 'double' {
  if (/dot/i.test(style)) return 'dotted';
  if (/dash/i.test(style)) return 'dashed';
  if (/double|triple|thinThick|thickThin/i.test(style)) return 'double';
  return 'solid';
}

export function offsetItem(item: DisplayItem, dx: number, dy: number): DisplayItem {
  switch (item.t) {
    case 'line':
      return { ...item, x1: item.x1 + dx, x2: item.x2 + dx, y1: item.y1 + dy, y2: item.y2 + dy };
    case 'path':
      return item;
    default:
      return { ...item, x: item.x + dx, y: item.y + dy };
  }
}

/* ------------------------------------------------------------------ *
 * Page numbers
 * ------------------------------------------------------------------ */

const FIELD_FORMATS: Record<string, string> = {
  roman: 'lowerRoman',
  Roman: 'upperRoman',
  ROMAN: 'upperRoman',
  alphabetic: 'lowerLetter',
  ALPHABETIC: 'upperLetter',
  Arabic: 'decimal',
  arabic: 'decimal',
  Ordinal: 'ordinal',
  CardText: 'cardinalText',
  OrdText: 'ordinalText',
};

export function formatPageNumber(value: number, sectionFormat: string, fieldFormat?: string): string {
  const format = (fieldFormat && FIELD_FORMATS[fieldFormat]) || sectionFormat || 'decimal';
  return formatNumber(value, format === 'numberInDash' ? 'decimal' : format);
}

export function sectionGeometry(section: SectionProps): PageGeometry {
  return {
    width: twip(section.pageWidth),
    height: twip(section.pageHeight),
    marginLeft: twip(section.margins.left + section.margins.gutter),
    marginRight: twip(section.margins.right),
    marginTop: twip(Math.abs(section.margins.top)),
    marginBottom: twip(Math.abs(section.margins.bottom)),
  };
}

export { fontShorthand };
