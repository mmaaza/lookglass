import type { DisplayItem, PageDisplay, PageText } from '../../../ooxml/display.js';
import type { FontResolver } from '../../../ooxml/fonts.js';
import type { TextMeasurer } from '../../../ooxml/text.js';
import type { Block, HeaderFooterRefs, RunProps, SectionProps, WordDocument } from '../model.js';
import { Flow, formatPageNumber, offsetItem, sectionGeometry, type Area, type FlowEnv, type PageGeometry } from './flow.js';
import { runFontSize, type Atom, type FieldValues, type FontService, type ResolvedRunFont, type Slot } from './paragraph.js';
import { twip } from './units.js';

/**
 * Page layout for a whole Word document.
 *
 * Runs in the worker, as a generator, so it can be driven in time slices:
 * pages become available as they are laid out, and the page count grows
 * until layout finishes. Headers and footers are laid out twice — once while
 * paginating, to know how much room they take, and again when a page is
 * displayed, with the final page count for "Page X of Y".
 */

interface SectionRange {
  props: SectionProps;
  blocks: Array<{ block: Block; index: number }>;
  headers: HeaderFooterRefs;
  footers: HeaderFooterRefs;
}

interface PageRecord {
  geometry: PageGeometry;
  section: number;
  /** Page number shown in fields, before formatting. */
  number: number;
  /** First page of its section. */
  sectionFirst: boolean;
  headerRef?: string;
  footerRef?: string;
  body: DisplayItem[];
  behind: DisplayItem[];
  front: DisplayItem[];
  bodyTop: number;
  /** Footnotes reserved at the bottom of this page. */
  notes: Array<{ items: DisplayItem[]; height: number }>;
  noteIds: Set<string>;
  notesHeight: number;
  bodyBottom: number;
}

export interface LayoutAccuracy {
  /** Page breaks Word recorded when it last saved the file. */
  wordBreaks: number;
  /** Of those, how many start a page here too. */
  matched: number;
}

export class DocxFontService implements FontService {
  readonly measurer: TextMeasurer;
  private readonly resolver: FontResolver;
  private readonly cache = new WeakMap<RunProps, Map<Slot, ResolvedRunFont>>();

  constructor(resolver: FontResolver, measurer: TextMeasurer) {
    this.resolver = resolver;
    this.measurer = measurer;
  }

  font(props: RunProps, slot: Slot): ResolvedRunFont {
    let bySlot = this.cache.get(props);
    if (!bySlot) {
      bySlot = new Map();
      this.cache.set(props, bySlot);
    }
    let resolved = bySlot.get(slot);
    if (!resolved) {
      const fonts = props.fonts;
      const family =
        slot === 'eastAsia'
          ? (fonts.eastAsia ?? fonts.hAnsi ?? fonts.ascii)
          : slot === 'cs'
            ? (fonts.cs ?? fonts.hAnsi ?? fonts.ascii)
            : slot === 'hAnsi'
              ? (fonts.hAnsi ?? fonts.ascii)
              : (fonts.ascii ?? fonts.hAnsi);
      const font = this.resolver.resolve(family);
      const bold = slot === 'cs' ? (props.boldCs ?? props.bold) : props.bold;
      const italic = slot === 'cs' ? (props.italicCs ?? props.italic) : props.italic;
      const spec = { family: font.css, size: runFontSize(props, slot), bold, italic };
      resolved = { spec, metrics: this.measurer.metrics(spec, font.metrics), box: this.measurer.box(spec) };
      bySlot.set(slot, resolved);
    }
    return resolved;
  }
}

/** Height of the rule above footnotes, and the space around it. */
const SEPARATOR_HEIGHT = 10;

export class DocxLayout {
  readonly pages: PageRecord[] = [];
  readonly accuracy: LayoutAccuracy = { wordBreaks: 0, matched: 0 };
  /** Top-level block index → page index where it starts. */
  readonly blockPages: number[] = [];
  /** Text at the top of each page, for comparing pagination with Word's. */
  readonly pageStarts: string[] = [];
  done = false;

  private readonly doc: WordDocument;
  private readonly fonts: FontService;
  private readonly sections: SectionRange[];
  private flow!: Flow;
  private sectionIndex = 0;
  private column = 0;
  private pageNumber = 0;
  private pendingBlock = -1;
  private readonly noteLayouts = new Map<string, { items: DisplayItem[]; height: number }>();
  private readonly noteNumbers = new Map<string, string>();

  constructor(doc: WordDocument, fonts: FontService) {
    this.doc = doc;
    this.fonts = fonts;
    this.sections = splitSections(doc);
    for (const ref of doc.noteRefs) this.noteNumbers.set(`${ref.type}:${ref.id}`, ref.number);
  }

  /** Lay out the whole document, yielding after each top-level block. */
  *run(): Generator<number, void, void> {
    for (let s = 0; s < this.sections.length; s++) {
      const section = this.sections[s]!;
      this.startSection(s);
      for (let i = 0; i < section.blocks.length; i++) {
        const { block, index } = section.blocks[i]!;
        const next = section.blocks[i + 1]?.block ?? this.sections[s + 1]?.blocks[0]?.block;
        this.pendingBlock = index;
        if (block.kind === 'p') this.flow.placeParagraph(block, next);
        else {
          this.blockPages[index] = this.pages.length - 1;
          this.flow.placeTable(block);
        }
        if (this.blockPages[index] === undefined) this.blockPages[index] = this.pages.length - 1;
        yield this.pages.length;
      }
    }
    // Endnotes follow the body, numbered in the order they were referenced.
    for (const ref of this.doc.noteRefs) {
      if (ref.type !== 'endnote') continue;
      const blocks = this.doc.endnotes.get(ref.id);
      if (!blocks || blocks.length === 0) continue;
      this.flow.noteNumber = ref.number;
      blocks.forEach((block, index) => {
        if (block.kind === 'p') this.flow.placeParagraph(block, blocks[index + 1]);
        else this.flow.placeTable(block);
      });
      this.flow.noteNumber = undefined;
      yield this.pages.length;
    }
    this.finishPage();
    this.done = true;
  }

  /** Complete display list for a page, with headers and footers for the final page count. */
  display(index: number): PageDisplay {
    const page = this.pages[index]!;
    this.text(index);
    const header: DisplayItem[] = [];
    const footer: DisplayItem[] = [];
    const fields = this.fieldValues(index);
    if (page.headerRef) this.layoutHeaderFooter(page, page.headerRef, 'header', fields, header);
    if (page.footerRef) this.layoutHeaderFooter(page, page.footerRef, 'footer', fields, footer);
    return {
      width: page.geometry.width,
      height: page.geometry.height,
      items: [...page.behind, ...header, ...footer, ...page.body, ...page.front],
    };
  }

  /**
   * The page's search text: its body text items joined with spaces. Each
   * item's offset is recorded on the item (`s`), so a search hit can be
   * mapped back to the painted text.
   */
  text(index: number): PageText {
    const page = this.pages[index]!;
    let text = '';
    const starts: number[] = [];
    for (const item of page.body) {
      if (item.t !== 'text') continue;
      item.s = text.length;
      starts.push(text.length);
      text += item.text;
      text += ' ';
    }
    return { text, starts };
  }

  /** The page number (as displayed in fields) of the page holding a bookmark. */
  bookmarkPage(name: string): string | undefined {
    const block = this.doc.bookmarks.get(name);
    const index = block === undefined ? undefined : this.blockPages[block];
    if (index === undefined) return undefined;
    const page = this.pages[index]!;
    return formatPageNumber(page.number, this.sections[page.section]!.props.pageNumbers.format);
  }

  /* ---------------------------------------------------------------- */

  private startSection(s: number): void {
    this.sectionIndex = s;
    const section = this.sections[s]!.props;
    if (section.pageNumbers.start !== undefined) this.pageNumber = section.pageNumbers.start - 1;
    if (s === 0) {
      this.newPage(true);
      return;
    }
    const previous = this.pages[this.pages.length - 1]!;
    const geometry = sectionGeometry(section);
    const sameSize = Math.abs(geometry.width - previous.geometry.width) < 1 && Math.abs(geometry.height - previous.geometry.height) < 1;
    // A page break still waiting for content is absorbed by a section that starts a page.
    const pendingBreak = this.flow.pendingBreak;
    this.flow.pendingBreak = undefined;
    switch (section.type) {
      case 'continuous':
        if (pendingBreak) {
          this.newPage(true);
          return;
        }
        if (sameSize) {
          // New column settings start below what is already on the page.
          this.column = 0;
          const area = this.columnArea(this.flow.y, previous.bodyBottom);
          this.flow.area = area;
          return;
        }
        this.newPage(true);
        return;
      case 'nextColumn':
        this.advanceColumnOrPage();
        return;
      case 'evenPage':
      case 'oddPage': {
        this.newPage(true);
        const wantOdd = section.type === 'oddPage';
        if ((this.pageNumber % 2 === 1) !== wantOdd) this.newPage(false);
        return;
      }
      default:
        this.newPage(true);
    }
  }

  private advanceColumnOrPage(): void {
    const section = this.sections[this.sectionIndex]!.props;
    if (this.column + 1 < section.columns.count) {
      this.column++;
      const page = this.pages[this.pages.length - 1]!;
      this.flow.area = this.columnArea(page.bodyTop, page.bodyBottom);
      this.flow.y = this.flow.area.top;
    } else {
      this.newPage(false);
    }
  }

  private newPage(sectionStart: boolean): void {
    this.finishPage();
    const s = this.sectionIndex;
    const range = this.sections[s]!;
    const section = range.props;
    const geometry = sectionGeometry(section);
    this.pageNumber++;
    const sectionFirst = sectionStart || !this.pages.some((page) => page.section === s);
    const kind = section.titlePage && sectionFirst ? 'first' : this.doc.settings.evenAndOddHeaders && this.pageNumber % 2 === 0 ? 'even' : 'default';
    const page: PageRecord = {
      geometry,
      section: s,
      number: this.pageNumber,
      sectionFirst,
      headerRef: range.headers[kind],
      footerRef: range.footers[kind],
      body: [],
      behind: [],
      front: [],
      notes: [],
      noteIds: new Set(),
      notesHeight: 0,
      bodyTop: geometry.marginTop,
      bodyBottom: geometry.height - geometry.marginBottom,
    };
    this.pages.push(page);

    // Headers and footers push the body when they are taller than the margin.
    const fields = this.fieldValues(this.pages.length - 1, true);
    if (page.headerRef && section.margins.top >= 0) {
      const bottom = this.layoutHeaderFooter(page, page.headerRef, 'header', fields, []);
      page.bodyTop = Math.max(page.bodyTop, bottom);
    }
    if (page.footerRef && section.margins.bottom >= 0) {
      const top = this.layoutHeaderFooter(page, page.footerRef, 'footer', fields, []);
      page.bodyBottom = Math.min(page.bodyBottom, top);
    }

    this.column = 0;
    const area = this.columnArea(page.bodyTop, page.bodyBottom);
    if (!this.flow) {
      this.flow = new Flow(this.env(), area, geometry, page.body, {
        nextArea: (reason) => {
          if (reason === 'page') this.newPage(false);
          else this.advanceColumnOrPage();
          const current = this.pages[this.pages.length - 1]!;
          return { area: this.flow.area, items: current.body, floats: current.front, page: current.geometry };
        },
        onLine: (line, pageTop) => {
          if (pageTop && this.pageStarts.length < this.pages.length) {
            this.pageStarts[this.pages.length - 1] = line.placed.map((placed) => (placed.atom.k === 'text' ? placed.atom.text : ' ')).join('').trim().slice(0, 50);
          }
          if (line.renderedBreak) {
            this.accuracy.wordBreaks++;
            if (pageTop) this.accuracy.matched++;
          }
          if (line.first && this.pendingBlock >= 0) {
            this.blockPages[this.pendingBlock] = this.pages.length - 1;
            this.pendingBlock = -1;
          }
        },
        notes: {
          measure: (refs) => {
            const current = this.pages[this.pages.length - 1]!;
            let height = current.notes.length === 0 ? SEPARATOR_HEIGHT : 0;
            for (const ref of refs) {
              if (ref.type !== 'footnote' || current.noteIds.has(ref.id)) continue;
              height += this.noteLayout(ref.type, ref.id).height;
            }
            return height;
          },
          commit: (refs) => {
            const current = this.pages[this.pages.length - 1]!;
            let reserved = 0;
            for (const ref of refs) {
              if (ref.type !== 'footnote' || current.noteIds.has(ref.id)) continue;
              if (current.notes.length === 0) reserved += SEPARATOR_HEIGHT;
              const note = this.noteLayout(ref.type, ref.id);
              current.noteIds.add(ref.id);
              current.notes.push(note);
              reserved += note.height;
            }
            if (reserved > 0) {
              current.notesHeight += reserved;
              // The body ends above the notes from here on.
              this.flow.area = { ...this.flow.area, bottom: this.flow.area.bottom - reserved };
            }
          },
        },
      }, page.front);
    } else {
      this.flow.area = area;
      this.flow.items = page.body;
      this.flow.floatItems = page.front;
      this.flow.page = geometry;
      this.flow.y = area.top;
    }
  }

  /** Lay out a note's text once, at the column width; cached by id. */
  private noteLayout(type: 'footnote' | 'endnote', id: string): { items: DisplayItem[]; height: number } {
    const key = `${type}:${id}`;
    const cached = this.noteLayouts.get(key);
    if (cached) return cached;
    const blocks = (type === 'footnote' ? this.doc.footnotes : this.doc.endnotes).get(id) ?? [];
    const items: DisplayItem[] = [];
    const page = this.pages[this.pages.length - 1]!;
    const flow = new Flow(this.env(), { left: 0, width: this.flow.area.width, top: 0, bottom: Number.POSITIVE_INFINITY }, page.geometry, items);
    flow.noteNumber = this.noteNumbers.get(key);
    const height = flow.placeAll(blocks);
    const layout = { items, height };
    this.noteLayouts.set(key, layout);
    return layout;
  }

  /** Footnotes sit at the bottom of their page, under a short rule. */
  private paintNotes(page: PageRecord): void {
    if (page.notes.length === 0) return;
    let y = page.bodyBottom - page.notesHeight;
    page.body.push({
      t: 'line',
      x1: page.geometry.marginLeft,
      y1: y + SEPARATOR_HEIGHT / 2,
      x2: page.geometry.marginLeft + 144,
      y2: y + SEPARATOR_HEIGHT / 2,
      width: 0.75,
      color: '#000000',
    });
    y += SEPARATOR_HEIGHT;
    for (const note of page.notes) {
      for (const item of note.items) page.body.push(offsetItem(item, page.geometry.marginLeft, y));
      y += note.height;
    }
  }

  private finishPage(): void {
    const page = this.pages[this.pages.length - 1];
    if (!page || !this.flow) return;
    this.paintNotes(page);
    const section = this.sections[page.section]!.props;
    if (section.vAlign === 'center' || section.vAlign === 'bottom') {
      const contentBottom = this.flow.y;
      const slack = page.bodyBottom - contentBottom;
      if (slack > 0) {
        const shift = section.vAlign === 'center' ? slack / 2 : slack;
        page.body = page.body.map((item) => offsetItem(item, 0, shift));
        if (this.flow.items !== page.body) this.flow.items = page.body;
      }
    }
  }

  private columnArea(top: number, bottom: number): Area {
    const section = this.sections[this.sectionIndex]!.props;
    const geometry = sectionGeometry(section);
    const textWidth = geometry.width - geometry.marginLeft - geometry.marginRight;
    const { count, space, widths } = section.columns;
    let left = geometry.marginLeft;
    let width = textWidth;
    if (count > 1) {
      if (widths && widths.length >= count) {
        for (let i = 0; i < this.column; i++) left += twip(widths[i]!.width + widths[i]!.space);
        width = twip(widths[this.column]!.width);
      } else {
        width = (textWidth - twip(space) * (count - 1)) / count;
        left += this.column * (width + twip(space));
      }
    }
    return { left, width, top, bottom };
  }

  private env(fields?: FieldValues): FlowEnv {
    return {
      fonts: this.fonts,
      defaultTabStop: this.doc.settings.defaultTabStop,
      fields,
      measureField: (atom: Extract<Atom, { k: 'field' }>, values: FieldValues | undefined) => {
        const text = values ? values[atom.field] : atom.field === 'PAGE' ? '1' : '99';
        return { text, width: this.fonts.measurer.width(this.fonts.font(atom.props, 'ascii').spec, text) };
      },
    };
  }

  private fieldValues(index: number, provisional = false): FieldValues {
    const page = this.pages[index]!;
    const section = this.sections[page.section]!.props;
    const sectionPages = this.pages.filter((other) => other.section === page.section).length;
    return {
      PAGE: formatPageNumber(page.number, section.pageNumbers.format),
      // While paginating the total is not known; a two-digit stand-in is close enough for heights.
      NUMPAGES: provisional && !this.done ? '99' : String(this.pages.length),
      SECTIONPAGES: String(sectionPages),
    };
  }

  /** Lays out a header or footer; returns its bottom (header) or top (footer) edge. */
  private layoutHeaderFooter(page: PageRecord, ref: string, kind: 'header' | 'footer', fields: FieldValues, out: DisplayItem[]): number {
    const blocks = this.doc.headers.get(ref);
    if (!blocks || blocks.length === 0) return kind === 'header' ? 0 : page.geometry.height;
    const section = this.sections[page.section]!.props;
    const geometry = page.geometry;
    const width = geometry.width - geometry.marginLeft - geometry.marginRight;
    const items: DisplayItem[] = [];
    const flow = new Flow(this.env(fields), { left: geometry.marginLeft, width, top: 0, bottom: Number.POSITIVE_INFINITY }, geometry, items);
    const height = flow.placeAll(blocks);
    const top = kind === 'header' ? twip(section.margins.header) : geometry.height - twip(section.margins.footer) - height;
    for (const item of items) out.push(offsetItem(item, 0, top));
    return kind === 'header' ? top + height : top;
  }
}

/** Group top-level blocks into sections, resolving inherited header and footer references. */
function splitSections(doc: WordDocument): SectionRange[] {
  const ranges: SectionRange[] = [];
  let current: Array<{ block: Block; index: number }> = [];
  doc.body.forEach((block, index) => {
    current.push({ block, index });
    if (block.section) {
      ranges.push({ props: block.section, blocks: current, headers: {}, footers: {} });
      current = [];
    }
  });
  ranges.push({ props: doc.finalSection, blocks: current, headers: {}, footers: {} });
  let headers: HeaderFooterRefs = {};
  let footers: HeaderFooterRefs = {};
  for (const range of ranges) {
    // A section without its own header of a kind inherits the previous section's.
    headers = { ...headers, ...range.props.headers };
    footers = { ...footers, ...range.props.footers };
    range.headers = headers;
    range.footers = footers;
  }
  return ranges.filter((range, index) => range.blocks.length > 0 || index === ranges.length - 1);
}
