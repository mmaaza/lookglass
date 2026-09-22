import type { FontMetrics } from '../../../ooxml/fonts.js';
import { breakPieces, type FontSpec, type LineMetrics, type TextMeasurer } from '../../../ooxml/text.js';
import type { DisplayItem, TextItem } from '../../../ooxml/display.js';
import type { Drawing, Inline, Paragraph, RunProps, TabStop } from '../model.js';
import { emu, halfPoint, twip } from './units.js';

/**
 * Paragraph layout: turning a paragraph's inline content into lines.
 *
 * Word breaks lines greedily (first fit), and so does this. What makes the
 * result match Word is less the algorithm than the inputs: the same fonts,
 * the same tab-stop rules, the same line-height formula and the same
 * treatment of trailing spaces, which hang past the right margin instead of
 * forcing a break.
 */

export type Slot = 'ascii' | 'hAnsi' | 'eastAsia' | 'cs';

export interface ResolvedRunFont {
  spec: FontSpec;
  /** Word's metrics: these set line heights. */
  metrics: LineMetrics;
  /** The browser's metrics for the rendered font: these place the painted text. */
  box: { ascent: number; descent: number };
}

export interface FontService {
  measurer: TextMeasurer;
  font(props: RunProps, slot: Slot): ResolvedRunFont;
}

/* ------------------------------------------------------------------ *
 * Atoms: the unit of line breaking
 * ------------------------------------------------------------------ */

export interface TextAtom {
  k: 'text';
  text: string;
  font: ResolvedRunFont;
  props: RunProps;
  width: number;
  /** Exact painted width; `width` may use Word's rounded advances instead. */
  raw: number;
  /** Width of trailing breakable spaces, which may hang past the margin. */
  trailing: number;
  /** Space characters, for justification. */
  spaces: number;
  /** A line may break after this atom. */
  breakAfter: boolean;
  /** Raise (+) or lower (-) the baseline, px. */
  shift: number;
  letterSpacing: number;
  link?: string;
}

export type Atom =
  | TextAtom
  | { k: 'tab'; props: RunProps; font: ResolvedRunFont; link?: string; label?: boolean }
  | { k: 'ptab'; props: RunProps; font: ResolvedRunFont; align: 'left' | 'center' | 'right'; relativeTo: 'margin' | 'indent' }
  | { k: 'break'; type: 'line' | 'page' | 'column'; font: ResolvedRunFont }
  | { k: 'image'; drawing: Drawing; width: number; height: number; props: RunProps; link?: string }
  | { k: 'float'; drawing: Drawing }
  | { k: 'field'; field: 'PAGE' | 'NUMPAGES' | 'SECTIONPAGES'; format?: string; props: RunProps; font: ResolvedRunFont }
  | { k: 'marker'; renderedBreak?: true; bookmark?: string };

/** Values that change per page: page numbers in headers, footers and body fields. */
export interface FieldValues {
  PAGE: string;
  NUMPAGES: string;
  SECTIONPAGES: string;
}

export function scriptSlot(code: number, props: RunProps): Slot {
  if (props.rtl || (code >= 0x0590 && code <= 0x08ff) || (code >= 0xfb1d && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff)) return 'cs';
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0xd840 && code <= 0xd87f)
  ) {
    return 'eastAsia';
  }
  if (props.fonts.hint === 'eastAsia' && code >= 0x2000 && code <= 0x2bff) return 'eastAsia';
  return code < 0x80 ? 'ascii' : 'hAnsi';
}

/** Split text into runs of one font slot each. */
function splitBySlot(text: string, props: RunProps): Array<{ text: string; slot: Slot }> {
  const out: Array<{ text: string; slot: Slot }> = [];
  let current: Slot | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Spaces and punctuation stay with the surrounding script.
    const slot = code === 0x20 && current ? current : scriptSlot(code, props);
    if (slot !== current) {
      if (current !== undefined && i > start) out.push({ text: text.slice(start, i), slot: current });
      current = slot;
      start = i;
    }
  }
  if (current !== undefined && start < text.length) out.push({ text: text.slice(start), slot: current });
  // ASCII and high-ANSI usually share a font; merging keeps words whole.
  const merged: typeof out = [];
  for (const part of out) {
    const last = merged[merged.length - 1];
    if (last && last.slot !== part.slot && (last.slot === 'ascii' || last.slot === 'hAnsi') && (part.slot === 'ascii' || part.slot === 'hAnsi') && props.fonts.ascii === props.fonts.hAnsi) {
      last.text += part.text;
    } else {
      merged.push({ ...part });
    }
  }
  return merged;
}

export function displayText(text: string, props: RunProps): string {
  return props.caps || props.smallCaps ? text.toUpperCase() : text;
}

export function buildAtoms(paragraph: Paragraph, fonts: FontService): Atom[] {
  const atoms: Atom[] = [];
  const markSlot: Slot = 'ascii';
  if (paragraph.label) {
    const { text, props, suffix } = paragraph.label;
    pushText(atoms, text, props, fonts, undefined, false);
    if (suffix === 'tab') atoms.push({ k: 'tab', props, font: fonts.font(props, markSlot), label: true });
    else if (suffix === 'space') pushText(atoms, ' ', props, fonts, undefined, true);
  }
  for (const inline of paragraph.inlines) pushInline(atoms, inline, fonts);
  return atoms;
}

function pushInline(atoms: Atom[], inline: Inline, fonts: FontService): void {
  switch (inline.kind) {
    case 'text':
      pushText(atoms, inline.text, inline.props, fonts, inline.link, false);
      break;
    case 'tab':
      atoms.push({ k: 'tab', props: inline.props, font: fonts.font(inline.props, 'ascii'), link: inline.link });
      break;
    case 'ptab':
      atoms.push({ k: 'ptab', props: inline.props, font: fonts.font(inline.props, 'ascii'), align: inline.align, relativeTo: inline.relativeTo });
      break;
    case 'break':
      atoms.push({ k: 'break', type: inline.type, font: fonts.font(inline.props, 'ascii') });
      break;
    case 'image':
      if (inline.drawing.anchor) atoms.push({ k: 'float', drawing: inline.drawing });
      else atoms.push({ k: 'image', drawing: inline.drawing, width: emu(inline.drawing.width), height: emu(inline.drawing.height), props: inline.props, link: inline.link });
      break;
    case 'field':
      atoms.push({ k: 'field', field: inline.field, format: inline.format, props: inline.props, font: fonts.font(inline.props, 'ascii') });
      break;
    case 'noteRef':
      // Numbered in O2 with the notes themselves; a superscript mark keeps the place.
      pushText(atoms, '*', inline.props, fonts, undefined, false);
      break;
    case 'renderedBreak':
      atoms.push({ k: 'marker', renderedBreak: true });
      break;
    case 'bookmark':
      atoms.push({ k: 'marker', bookmark: inline.name });
      break;
  }
}

function pushText(atoms: Atom[], raw: string, props: RunProps, fonts: FontService, link: string | undefined, forceBreak: boolean): void {
  const text = displayText(raw, props);
  for (const part of splitBySlot(text, props)) {
    const font = fonts.font(props, part.slot);
    const pieces = breakPieces(part.text);
    const letterSpacing = twip(props.spacing);
    const shift = baselineShift(props, font.spec.size);
    pieces.forEach((piece, index) => {
      const isLast = index === pieces.length - 1;
      const width = measure(fonts, font.spec, piece.text, letterSpacing, props.scale);
      const raw = measure(fonts, font.spec, piece.text, letterSpacing, props.scale, true);
      const trailing = piece.trailingSpace > 0 ? measure(fonts, font.spec, piece.text.slice(piece.text.length - piece.trailingSpace), letterSpacing, props.scale) : 0;
      const breakAfter = forceBreak || !isLast || piece.trailingSpace > 0 || /[-‐–—​]$/.test(piece.text) || isIdeographEnd(piece.text);
      atoms.push({
        k: 'text',
        text: piece.text,
        font,
        props,
        width,
        raw,
        trailing,
        spaces: countSpaces(piece.text),
        breakAfter,
        shift,
        letterSpacing,
        link,
      });
    });
  }
}

function measure(fonts: FontService, spec: FontSpec, text: string, letterSpacing: number, scale: number, exact = false): number {
  // Soft hyphens are invisible unless a line breaks at them.
  const visible = text.includes('­') ? text.replace(/­/g, '') : text;
  const width = (exact ? fonts.measurer.rawWidth(spec, visible) : fonts.measurer.width(spec, visible)) + letterSpacing * visible.length;
  return scale !== 100 ? (width * scale) / 100 : width;
}

function countSpaces(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x20) count++;
  return count;
}

function isIdeographEnd(text: string): boolean {
  const code = text.charCodeAt(text.length - 1);
  return (code >= 0x3040 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af);
}

/** Superscript and subscript: smaller type, moved off the baseline, as Word does. */
export function runFontSize(props: RunProps, slot: Slot): number {
  const halfPoints = slot === 'cs' ? (props.sizeCs ?? props.size) : props.size;
  let size = halfPoint(halfPoints);
  if (props.vertAlign) size *= 2 / 3;
  if (props.smallCaps) size *= 0.8;
  return size;
}

function baselineShift(props: RunProps, size: number): number {
  let shift = halfPoint(props.position);
  if (props.vertAlign === 'superscript') shift += size * 0.5;
  else if (props.vertAlign === 'subscript') shift -= size * 0.2;
  return shift;
}

/* ------------------------------------------------------------------ *
 * Line breaking
 * ------------------------------------------------------------------ */

export interface PlacedAtom {
  atom: Atom;
  x: number;
  width: number;
  /** For tabs: leader to draw across the tab's width. */
  leader?: TabStop['leader'];
}

export interface Line {
  placed: PlacedAtom[];
  /** Left edge of the line's box relative to the paragraph's left edge, and its available width. */
  left: number;
  available: number;
  /** Content width, not counting trailing spaces. */
  width: number;
  ascent: number;
  descent: number;
  gap: number;
  /** Line height after line-spacing rules. */
  height: number;
  /** Baseline, measured down from the line's top. */
  baseline: number;
  end?: 'line' | 'page' | 'column';
  last: boolean;
  /** First line of the paragraph. */
  first: boolean;
  renderedBreak: boolean;
  bookmarks: string[];
  floats: Drawing[];
}

export interface LineContext {
  fonts: FontService;
  /** Width of the column the paragraph sits in, px. */
  columnWidth: number;
  defaultTabStop: number;
  /** Mark metrics, for empty lines. */
  markFont: ResolvedRunFont;
  fields?: FieldValues;
  measureField(atom: Extract<Atom, { k: 'field' }>, values: FieldValues | undefined): { text: string; width: number };
}

/**
 * Breaks atoms into lines. `bounds` may narrow a line (text wrapping around
 * a floating picture); by default each line spans the paragraph's indents.
 */
export class LineBreaker {
  private index = 0;
  private lineCount = 0;
  private readonly atoms: Atom[];
  private readonly paragraph: Paragraph;
  private readonly context: LineContext;

  constructor(atoms: Atom[], paragraph: Paragraph, context: LineContext) {
    this.atoms = atoms;
    this.paragraph = paragraph;
    this.context = context;
  }

  get done(): boolean {
    return this.index >= this.atoms.length && this.lineCount > 0;
  }

  /** Default left and right edges of the next line, px from the column's left. */
  defaultBounds(): { left: number; right: number } {
    const props = this.paragraph.props;
    const first = this.lineCount === 0;
    const left = twip(props.indentLeft) + (first ? twip(props.firstLine) : 0);
    return { left, right: this.context.columnWidth - twip(props.indentRight) };
  }

  next(bounds = this.defaultBounds()): Line {
    const props = this.paragraph.props;
    const first = this.lineCount === 0;
    const line: Line = {
      placed: [],
      left: bounds.left,
      available: Math.max(0, bounds.right - bounds.left),
      width: 0,
      ascent: 0,
      descent: 0,
      gap: 0,
      height: 0,
      baseline: 0,
      last: false,
      first,
      renderedBreak: false,
      bookmarks: [],
      floats: [],
    };
    // Positions are relative to the column's left edge while building; tab stops are measured from there.
    let x = bounds.left;
    const right = bounds.right;
    let pending: { placed: PlacedAtom; stop: TabStop; start: number } | undefined;
    let pendingWidth = 0;

    const closePending = () => {
      if (!pending) return;
      const { placed, stop, start } = pending;
      let target = start;
      if (stop.align === 'right') target = twip(stop.pos) - pendingWidth;
      else if (stop.align === 'center') target = twip(stop.pos) - pendingWidth / 2;
      else if (stop.align === 'decimal') target = twip(stop.pos) - decimalOffset(line.placed, placed);
      target = Math.max(start, target);
      const delta = target - start;
      placed.width = delta;
      for (let i = line.placed.indexOf(placed) + 1; i < line.placed.length; i++) line.placed[i]!.x += delta;
      x += delta;
      pending = undefined;
      pendingWidth = 0;
    };

    while (this.index < this.atoms.length) {
      const atom = this.atoms[this.index]!;

      if (atom.k === 'marker') {
        if (atom.renderedBreak) line.renderedBreak = true;
        if (atom.bookmark) line.bookmarks.push(atom.bookmark);
        this.index++;
        continue;
      }
      if (atom.k === 'float') {
        line.floats.push(atom.drawing);
        this.index++;
        continue;
      }
      if (atom.k === 'break') {
        this.index++;
        line.end = atom.type;
        includeMetrics(line, atom.font.metrics, 0);
        break;
      }

      if (atom.k === 'tab' || atom.k === 'ptab') {
        closePending();
        const stop = atom.k === 'ptab' ? ptabStop(atom, this.context.columnWidth, props) : this.findStop(x);
        const placed: PlacedAtom = { atom, x, width: 0, leader: stop?.leader };
        if (!stop || (stop.align === 'left' && twip(stop.pos) > right + 0.5 && line.placed.length > 0)) {
          // No stop left on this line: the tab moves to the next line, as in Word.
          if (line.placed.length > 0) break;
        }
        this.index++;
        line.placed.push(placed);
        includeMetrics(line, atom.font.metrics, 0);
        if (!stop || stop.align === 'left' || stop.align === 'bar' || stop.align === 'num') {
          const target = stop ? Math.max(x, twip(stop.pos)) : x + twip(this.context.defaultTabStop);
          placed.width = target - x;
          x = target;
        } else {
          pending = { placed, stop, start: x };
        }
        continue;
      }

      // A unit: atoms up to and including the next break opportunity.
      const unit: Atom[] = [];
      let unitWidth = 0;
      let trailing = 0;
      for (let j = this.index; j < this.atoms.length; j++) {
        const candidate = this.atoms[j]!;
        if (candidate.k === 'tab' || candidate.k === 'ptab' || candidate.k === 'break') break;
        if (candidate.k === 'marker' || candidate.k === 'float') {
          unit.push(candidate);
          continue;
        }
        unit.push(candidate);
        const width = this.atomWidth(candidate);
        unitWidth += width;
        if (candidate.k === 'text') {
          trailing = candidate.trailing;
          if (candidate.breakAfter) break;
        } else {
          trailing = 0;
          break;
        }
      }
      const contentEnd = (pending ? Math.max(pending.start + pendingWidth + unitWidth, twip(pending.stop.pos)) : x + unitWidth) - trailing;
      const fits = contentEnd <= right + 0.01;
      if (!fits && line.placed.length > 0) break;
      if (!fits && line.placed.length === 0) {
        // A single word wider than the line is broken between characters.
        const split = this.splitOversized(unit, right - x);
        if (split) {
          this.placeUnit(line, split, x);
          x += split.reduce((sum, atom) => sum + this.atomWidth(atom), 0);
          break;
        }
      }
      for (const atom of unit) {
        if (atom.k === 'marker') {
          if (atom.renderedBreak) line.renderedBreak = true;
          if (atom.bookmark) line.bookmarks.push(atom.bookmark);
          continue;
        }
        if (atom.k === 'float') {
          line.floats.push(atom.drawing);
          continue;
        }
        const width = this.atomWidth(atom);
        line.placed.push({ atom, x, width });
        includeAtomMetrics(line, atom);
        x += width;
        if (pending) pendingWidth += width;
      }
      this.index += unit.length;
    }

    closePending();
    this.lineCount++;
    line.last = this.index >= this.atoms.length && !line.end;
    if (line.end === 'page' || line.end === 'column') line.last = this.index >= this.atoms.length;

    // Width of content, not counting spaces left hanging at the end.
    let contentRight = bounds.left;
    for (let i = line.placed.length - 1; i >= 0; i--) {
      const placed = line.placed[i]!;
      const hanging = placed.atom.k === 'text' ? placed.atom.trailing : 0;
      contentRight = Math.max(contentRight, placed.x + placed.width - hanging);
      if (placed.atom.k !== 'text' || placed.width - hanging > 0) break;
    }
    line.width = contentRight - bounds.left;
    for (const placed of line.placed) placed.x -= bounds.left;

    if (line.ascent === 0 && line.descent === 0) includeMetrics(line, this.context.markFont.metrics, 0);
    // The text's own line height, without pictures: "multiple" spacing adds leading in proportion to this.
    let fontHeight = 0;
    for (const placed of line.placed) {
      const atom = placed.atom;
      if (atom.k === 'text' || atom.k === 'field' || atom.k === 'tab' || atom.k === 'ptab') {
        const metrics = atom.font.metrics;
        fontHeight = Math.max(fontHeight, metrics.ascent + metrics.descent + metrics.lineGap);
      }
    }
    if (fontHeight === 0) {
      const mark = this.context.markFont.metrics;
      fontHeight = mark.ascent + mark.descent + mark.lineGap;
      // A line holding only a picture still has the paragraph mark's descent below it.
      if (line.placed.some((placed) => placed.atom.k === 'image')) {
        line.descent = Math.max(line.descent, mark.descent);
        line.gap = Math.max(line.gap, mark.lineGap);
      }
    }
    applyLineSpacing(line, props.line, props.lineRule, fontHeight);
    return line;
  }

  private atomWidth(atom: Atom): number {
    switch (atom.k) {
      case 'text':
        return atom.width;
      case 'image':
        return atom.width;
      case 'field':
        return this.context.measureField(atom, this.context.fields).width;
      default:
        return 0;
    }
  }

  private placeUnit(line: Line, unit: Atom[], start: number): void {
    let x = start;
    for (const atom of unit) {
      const width = this.atomWidth(atom);
      line.placed.push({ atom, x, width });
      includeAtomMetrics(line, atom);
      x += width;
    }
  }

  /** Split the first text atom of a unit so its head fits `room`. */
  private splitOversized(unit: Atom[], room: number): Atom[] | undefined {
    const first = unit[0];
    if (!first || first.k !== 'text' || first.text.length < 2) return undefined;
    let chars = 1;
    const measurer = (text: string) => measure(this.context.fonts, first.font.spec, text, first.letterSpacing, first.props.scale);
    while (chars < first.text.length && measurer(first.text.slice(0, chars + 1)) <= room) chars++;
    const exact = (text: string) => measure(this.context.fonts, first.font.spec, text, first.letterSpacing, first.props.scale, true);
    const head: TextAtom = { ...first, text: first.text.slice(0, chars), width: measurer(first.text.slice(0, chars)), raw: exact(first.text.slice(0, chars)), trailing: 0, breakAfter: true, spaces: 0 };
    const tail: TextAtom = { ...first, text: first.text.slice(chars), width: measurer(first.text.slice(chars)), raw: exact(first.text.slice(chars)) };
    this.atoms.splice(this.index, 1, head, tail);
    this.index += 1;
    return [head];
  }

  private findStop(x: number): TabStop | undefined {
    const props = this.paragraph.props;
    const epsilon = 0.5;
    const custom = props.tabs.filter((tab) => tab.align !== 'bar');
    const candidates: TabStop[] = custom.filter((tab) => twip(tab.pos) > x + epsilon);
    // A hanging indent is an implicit stop, which is how list labels line up.
    const hangingStop = twip(props.indentLeft);
    if (props.firstLine < 0 && x + epsilon < hangingStop) candidates.push({ pos: props.indentLeft, align: 'left' });
    candidates.sort((a, b) => a.pos - b.pos);
    if (candidates.length > 0) return candidates[0];
    // Default stops, at fixed intervals from the margin, after the last custom stop.
    const interval = Math.max(1, this.context.defaultTabStop);
    const lastCustom = custom.length > 0 ? Math.max(...custom.map((tab) => tab.pos)) : 0;
    const from = Math.max(x * 15, lastCustom);
    const pos = (Math.floor((from + epsilon * 15) / interval) + 1) * interval;
    return { pos, align: 'left' };
  }
}

function ptabStop(atom: Extract<Atom, { k: 'ptab' }>, columnWidth: number, props: Paragraph['props']): TabStop {
  const left = atom.relativeTo === 'indent' ? twip(props.indentLeft) : 0;
  const right = atom.relativeTo === 'indent' ? columnWidth - twip(props.indentRight) : columnWidth;
  const pos = atom.align === 'left' ? left : atom.align === 'center' ? (left + right) / 2 : right;
  return { pos: pos * 15, align: atom.align };
}

function decimalOffset(placed: PlacedAtom[], tab: PlacedAtom): number {
  let width = 0;
  for (let i = placed.indexOf(tab) + 1; i < placed.length; i++) {
    const item = placed[i]!;
    if (item.atom.k === 'text') {
      const dot = item.atom.text.search(/[.,]/);
      if (dot >= 0) return width + (item.width * dot) / Math.max(1, item.atom.text.length);
    }
    width += item.width;
  }
  return width;
}

function includeMetrics(line: Line, metrics: LineMetrics, shift: number): void {
  line.ascent = Math.max(line.ascent, metrics.ascent + Math.max(0, shift));
  line.descent = Math.max(line.descent, metrics.descent - Math.min(0, shift));
  line.gap = Math.max(line.gap, metrics.lineGap);
}

function includeAtomMetrics(line: Line, atom: Atom): void {
  if (atom.k === 'text') includeMetrics(line, atom.font.metrics, atom.shift);
  else if (atom.k === 'image') line.ascent = Math.max(line.ascent, atom.height);
  else if (atom.k === 'field') includeMetrics(line, atom.font.metrics, 0);
}

/**
 * Word's line height: the tallest font's ascent + descent + line gap,
 * scaled for "multiple" spacing, replaced for "exact", floored for
 * "at least". Extra space goes above the text.
 */
export function applyLineSpacing(line: Line, value: number, rule: 'auto' | 'exact' | 'atLeast', fontHeight = line.ascent + line.descent + line.gap): void {
  const natural = line.ascent + line.descent + line.gap;
  let height = natural;
  // Multiple spacing adds (multiple - 1) text lines of leading. For text this
  // is natural × multiple; a line holding a tall picture gets the same
  // leading as a text line, not a multiple of the picture's height.
  if (rule === 'auto') height = natural + fontHeight * (value / 240 - 1);
  else if (rule === 'exact') height = twip(value);
  else height = Math.max(natural, twip(value));
  line.height = height;
  // Text sits at the bottom of the line box, the extra leading above it.
  line.baseline = height - line.descent;
}

/* ------------------------------------------------------------------ *
 * Painting a line
 * ------------------------------------------------------------------ */

export interface LinePaint {
  /** Page coordinates of the line box's top-left (column left + line left). */
  x: number;
  top: number;
  align: Paragraph['props']['align'];
  fields?: FieldValues;
  context: LineContext;
  order: { value: number };
}

const UNDERLINES: Record<string, TextItem['underline']> = {
  single: 'single',
  words: 'single',
  double: 'double',
  thick: 'thick',
  dotted: 'dotted',
  dottedHeavy: 'dotted',
  dash: 'dashed',
  dashedHeavy: 'dashed',
  dashLong: 'dashed',
  dashLongHeavy: 'dashed',
  dotDash: 'dashed',
  dotDotDash: 'dashed',
  wave: 'wavy',
  wavyHeavy: 'wavy',
  wavyDouble: 'wavy',
};

const LEADERS: Record<string, string> = { dot: '.', hyphen: '-', underscore: '_', heavy: '_', middleDot: '·' };

export function paintLine(line: Line, paint: LinePaint, out: DisplayItem[], images: (atom: Extract<Atom, { k: 'image' }>, x: number, y: number) => void): void {
  let offset = 0;
  let wordSpacing = 0;
  const slack = line.available - line.width;
  if (paint.align === 'center') offset = slack / 2;
  else if (paint.align === 'right') offset = slack;
  else if ((paint.align === 'both' && !line.last) || paint.align === 'distribute') {
    // Justify after the last tab only, as Word does.
    let lastTab = -1;
    line.placed.forEach((placed, index) => {
      if (placed.atom.k === 'tab' || placed.atom.k === 'ptab') lastTab = index;
    });
    let spaces = 0;
    let lastTextIndex = -1;
    line.placed.forEach((placed, index) => {
      if (placed.atom.k === 'text') lastTextIndex = index;
    });
    line.placed.forEach((placed, index) => {
      if (index <= lastTab || placed.atom.k !== 'text') return;
      spaces += placed.atom.spaces;
      // Trailing spaces at the line end do not stretch.
      if (index === lastTextIndex) spaces -= countTrailingSpaces(placed.atom.text);
    });
    if (spaces > 0 && slack > 0 && line.end !== 'page' && line.end !== 'column') wordSpacing = slack / spaces;
    // Shift atoms after the last tab as the spaces before them widen.
    let extra = 0;
    line.placed.forEach((placed, index) => {
      placed.x += extra;
      if (index > lastTab && placed.atom.k === 'text' && wordSpacing) {
        const own = index === lastTextIndex ? placed.atom.spaces - countTrailingSpaces(placed.atom.text) : placed.atom.spaces;
        placed.width += own * wordSpacing;
        extra += own * wordSpacing;
      }
    });
  }

  const baseline = paint.top + line.baseline;
  let current: TextItem | undefined;
  // Layout widths (Word's) and painted widths (the font's) of the current item.
  let layoutWidth = 0;
  let paintedWidth = 0;
  const flush = () => {
    if (current) {
      // Spread the difference over the characters, so the painted text
      // occupies exactly the width layout gave it.
      const chars = current.text.length;
      const correction = chars > 0 ? (layoutWidth - paintedWidth) / chars : 0;
      if (Math.abs(correction) > 0.001) current.letterSpacing = (current.letterSpacing ?? 0) + correction;
      out.push(current);
    }
    current = undefined;
  };

  for (const placed of line.placed) {
    const x = paint.x + line.left + offset + placed.x;
    const atom = placed.atom;
    if (atom.k === 'text') {
      const props = atom.props;
      const text = atom.text.replace(/­/g, '');
      const style = textStyle(props, atom, wordSpacing);
      if (current && sameStyle(current, style, atom) && Math.abs(current.x + current.width - x) < 0.5) {
        current.text += text;
        current.width += placed.width;
        layoutWidth += atom.width;
        paintedWidth += atom.raw;
        continue;
      }
      flush();
      layoutWidth = atom.width;
      paintedWidth = atom.raw;
      current = {
        t: 'text',
        x,
        y: baseline - atom.shift,
        text,
        font: fontShorthand(atom.font.spec),
        ascent: atom.font.box.ascent,
        descent: atom.font.box.descent,
        width: placed.width,
        order: paint.order.value++,
        ...style,
      };
      continue;
    }
    flush();
    if ((atom.k === 'tab' || atom.k === 'ptab') && placed.leader && placed.width > 0) {
      const char = LEADERS[placed.leader] ?? '.';
      const charWidth = Math.max(1, paint.context.fonts.measurer.width(atom.font.spec, char));
      const exactWidth = paint.context.fonts.measurer.rawWidth(atom.font.spec, char);
      const count = Math.floor(placed.width / charWidth) - 1;
      if (count > 0) {
        out.push({
          letterSpacing: charWidth - exactWidth || undefined,
          t: 'text',
          x: x + placed.width - count * charWidth,
          y: baseline,
          text: char.repeat(count),
          font: fontShorthand(atom.font.spec),
          ascent: atom.font.box.ascent,
          descent: atom.font.box.descent,
          width: count * charWidth,
          color: colorOf(atom.props.color),
          order: paint.order.value++,
        });
      }
    } else if (atom.k === 'image') {
      images(atom, x, baseline - atom.height);
    } else if (atom.k === 'field') {
      const { text, width } = paint.context.measureField(atom, paint.fields);
      out.push({
        t: 'text',
        x,
        y: baseline,
        text,
        font: fontShorthand(atom.font.spec),
        ascent: atom.font.box.ascent,
        descent: atom.font.box.descent,
        width,
        color: colorOf(atom.props.color),
        order: paint.order.value++,
        ...decorations(atom.props),
      });
    }
  }
  flush();
}

function countTrailingSpaces(text: string): number {
  let count = 0;
  for (let i = text.length - 1; i >= 0 && text.charCodeAt(i) === 0x20; i--) count++;
  return count;
}

function textStyle(props: RunProps, atom: TextAtom, wordSpacing: number): Omit<TextItem, 't' | 'x' | 'y' | 'text' | 'font' | 'ascent' | 'descent' | 'width' | 'order'> {
  return {
    color: colorOf(props.color),
    ...decorations(props),
    background: props.highlight ? `#${props.highlight}` : props.shading ? `#${props.shading}` : undefined,
    wordSpacing: wordSpacing || undefined,
    letterSpacing: atom.letterSpacing || undefined,
    scaleX: props.scale !== 100 ? props.scale / 100 : undefined,
    link: atom.link,
  };
}

function decorations(props: RunProps): Pick<TextItem, 'underline' | 'underlineColor' | 'strike'> {
  return {
    underline: props.underline ? (UNDERLINES[props.underline] ?? 'single') : undefined,
    underlineColor: props.underlineColor ? `#${props.underlineColor}` : undefined,
    strike: props.dstrike ? 'double' : props.strike ? 'single' : undefined,
  };
}

function sameStyle(item: TextItem, style: ReturnType<typeof textStyle>, atom: TextAtom): boolean {
  return (
    item.font === fontShorthand(atom.font.spec) &&
    item.color === style.color &&
    item.underline === style.underline &&
    item.underlineColor === style.underlineColor &&
    item.strike === style.strike &&
    item.background === style.background &&
    item.wordSpacing === style.wordSpacing &&
    item.letterSpacing === style.letterSpacing &&
    item.scaleX === style.scaleX &&
    item.link === style.link
  );
}

export function colorOf(hex: string | undefined): string {
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : '#000000';
}

export function fontShorthand(spec: FontSpec): string {
  return `${spec.italic ? 'italic ' : ''}${spec.bold ? 'bold ' : ''}${Math.round(spec.size * 100) / 100}px ${spec.family}`;
}

/** Word metrics for a run, used when the font service has them. */
export type { FontMetrics };
