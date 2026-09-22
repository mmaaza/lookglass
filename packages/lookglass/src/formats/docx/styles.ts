import { applyTintShade, themeColor, type Theme } from '../../ooxml/theme.js';
import { child, children, intAttr, onOff, val, type XmlElement } from '../../ooxml/xml.js';
import type { BorderSpec, ParaProps, RunProps, TabStop } from './model.js';

/**
 * Word style inheritance.
 *
 * Properties are applied in the order the spec (17.7.2) gives: document
 * defaults, table style, numbering, paragraph style (following `basedOn`),
 * character style, then direct formatting. Toggle properties (bold, italic,
 * caps...) are the exception: across style *levels* they flip rather than
 * override, so a bold character style inside a bold heading is not bold —
 * which is what Word shows.
 */

/** Direct or style-level run properties: everything optional. */
export interface RPr {
  fonts?: Partial<RunProps['fonts']>;
  themeFonts?: Partial<Record<'ascii' | 'hAnsi' | 'eastAsia' | 'cs', string>>;
  size?: number;
  sizeCs?: number;
  toggles?: Partial<Record<Toggle, boolean>>;
  underline?: string;
  underlineColor?: string;
  color?: string | 'auto';
  highlight?: string;
  shading?: string;
  vertAlign?: 'superscript' | 'subscript' | 'baseline';
  spacing?: number;
  scale?: number;
  position?: number;
  rtl?: boolean;
  styleId?: string;
}

export type Toggle = 'bold' | 'italic' | 'boldCs' | 'italicCs' | 'caps' | 'smallCaps' | 'strike' | 'dstrike' | 'vanish';
const TOGGLES: Array<[Toggle, string]> = [
  ['bold', 'w:b'],
  ['italic', 'w:i'],
  ['boldCs', 'w:bCs'],
  ['italicCs', 'w:iCs'],
  ['caps', 'w:caps'],
  ['smallCaps', 'w:smallCaps'],
  ['strike', 'w:strike'],
  ['dstrike', 'w:dstrike'],
  ['vanish', 'w:vanish'],
];

export interface PPr {
  styleId?: string;
  align?: ParaProps['align'];
  indentLeft?: number;
  indentRight?: number;
  firstLine?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  beforeAutospacing?: boolean;
  afterAutospacing?: boolean;
  line?: number;
  lineRule?: ParaProps['lineRule'];
  contextualSpacing?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  outlineLevel?: number;
  tabs?: Array<TabStop | { pos: number; clear: true }>;
  shading?: string;
  borders?: ParaProps['borders'];
  bidi?: boolean;
  numbering?: { numId?: string; level?: number };
  suppressAutoHyphens?: boolean;
}

const HIGHLIGHTS: Record<string, string> = {
  yellow: 'FFFF00',
  green: '00FF00',
  cyan: '00FFFF',
  magenta: 'FF00FF',
  blue: '0000FF',
  red: 'FF0000',
  darkBlue: '000080',
  darkCyan: '008080',
  darkGreen: '008000',
  darkMagenta: '800080',
  darkRed: '800000',
  darkYellow: '808000',
  darkGray: '808080',
  lightGray: 'C0C0C0',
  black: '000000',
  white: 'FFFFFF',
};

export function parseRPr(element: XmlElement | undefined, theme: Theme): RPr {
  const out: RPr = {};
  if (!element) return out;
  const fonts = child(element, 'w:rFonts');
  if (fonts) {
    const named: Partial<RunProps['fonts']> = {};
    const themed: RPr['themeFonts'] = {};
    for (const slot of ['ascii', 'hAnsi', 'eastAsia', 'cs'] as const) {
      const name = fonts.attrs[`w:${slot}`];
      if (name) named[slot] = name;
      const themeRef = fonts.attrs[`w:${slot}Theme`];
      if (themeRef) themed[slot] = themeRef;
    }
    if (fonts.attrs['w:hint']) named.hint = fonts.attrs['w:hint'];
    out.fonts = named;
    if (Object.keys(themed).length > 0) out.themeFonts = themed;
  }
  const size = intAttr(child(element, 'w:sz'), 'w:val');
  if (size !== undefined) out.size = size;
  const sizeCs = intAttr(child(element, 'w:szCs'), 'w:val');
  if (sizeCs !== undefined) out.sizeCs = sizeCs;
  for (const [key, name] of TOGGLES) {
    const value = onOff(element, name);
    if (value !== undefined) (out.toggles ??= {})[key] = value;
  }
  const underline = child(element, 'w:u');
  if (underline) {
    out.underline = underline.attrs['w:val'] ?? 'single';
    const color = underline.attrs['w:color'];
    if (color && color !== 'auto') out.underlineColor = color;
  }
  const color = child(element, 'w:color');
  if (color) {
    const named = color.attrs['w:themeColor'];
    const base = named ? themeColor(theme, named) : undefined;
    if (base) out.color = applyTintShade(base, color.attrs['w:themeTint'], color.attrs['w:themeShade']);
    else if (color.attrs['w:val']) out.color = color.attrs['w:val'] === 'auto' ? 'auto' : color.attrs['w:val'];
  }
  const highlight = val(element, 'w:highlight');
  if (highlight && highlight !== 'none' && HIGHLIGHTS[highlight]) out.highlight = HIGHLIGHTS[highlight];
  const shading = shadingFill(child(element, 'w:shd'), theme);
  if (shading) out.shading = shading;
  const vertAlign = val(element, 'w:vertAlign');
  if (vertAlign === 'superscript' || vertAlign === 'subscript' || vertAlign === 'baseline') out.vertAlign = vertAlign;
  const spacing = intAttr(child(element, 'w:spacing'), 'w:val');
  if (spacing !== undefined) out.spacing = spacing;
  const scale = intAttr(child(element, 'w:w'), 'w:val');
  if (scale !== undefined) out.scale = scale;
  const position = intAttr(child(element, 'w:position'), 'w:val');
  if (position !== undefined) out.position = position;
  const rtl = onOff(element, 'w:rtl');
  if (rtl !== undefined) out.rtl = rtl;
  const style = val(element, 'w:rStyle');
  if (style) out.styleId = style;
  return out;
}

export function shadingFill(element: XmlElement | undefined, theme: Theme): string | undefined {
  if (!element) return undefined;
  const fill = element.attrs['w:fill'];
  const themed = element.attrs['w:themeFill'];
  if (themed) {
    const base = themeColor(theme, themed);
    if (base) return applyTintShade(base, element.attrs['w:themeFillTint'], element.attrs['w:themeFillShade']);
  }
  if (fill && fill !== 'auto' && /^[0-9a-f]{6}$/i.test(fill)) return fill.toUpperCase();
  // A solid pattern paints the pattern colour instead.
  const pattern = element.attrs['w:val'];
  const color = element.attrs['w:color'];
  if (pattern === 'solid' && color && color !== 'auto') return color.toUpperCase();
  return undefined;
}

export function parseBorder(element: XmlElement | undefined, theme: Theme): BorderSpec | null | undefined {
  if (!element) return undefined;
  const style = element.attrs['w:val'] ?? 'single';
  if (style === 'nil' || style === 'none') return null;
  let color = element.attrs['w:color'];
  const themed = element.attrs['w:themeColor'];
  if (themed) {
    const base = themeColor(theme, themed);
    if (base) color = applyTintShade(base, element.attrs['w:themeTint'], element.attrs['w:themeShade']);
  }
  return {
    style,
    size: intAttr(element, 'w:sz') ?? 4,
    space: intAttr(element, 'w:space') ?? 0,
    color: color && color !== 'auto' ? color : undefined,
  };
}

export function parsePPr(element: XmlElement | undefined, theme: Theme): PPr {
  const out: PPr = {};
  if (!element) return out;
  const style = val(element, 'w:pStyle');
  if (style) out.styleId = style;
  const jc = val(element, 'w:jc');
  if (jc) out.align = mapAlign(jc);
  const ind = child(element, 'w:ind');
  if (ind) {
    const left = intAttr(ind, 'w:left') ?? intAttr(ind, 'w:start');
    const right = intAttr(ind, 'w:right') ?? intAttr(ind, 'w:end');
    if (left !== undefined) out.indentLeft = left;
    if (right !== undefined) out.indentRight = right;
    const hanging = intAttr(ind, 'w:hanging');
    const firstLine = intAttr(ind, 'w:firstLine');
    if (hanging !== undefined) out.firstLine = -hanging;
    else if (firstLine !== undefined) out.firstLine = firstLine;
  }
  const spacing = child(element, 'w:spacing');
  if (spacing) {
    const before = intAttr(spacing, 'w:before');
    const after = intAttr(spacing, 'w:after');
    const line = intAttr(spacing, 'w:line');
    if (before !== undefined) out.spaceBefore = before;
    if (after !== undefined) out.spaceAfter = after;
    // "Lines" units (hundredths of a line) override twips when present.
    const beforeLines = intAttr(spacing, 'w:beforeLines');
    const afterLines = intAttr(spacing, 'w:afterLines');
    if (beforeLines !== undefined) out.spaceBefore = Math.round((beforeLines / 100) * 240);
    if (afterLines !== undefined) out.spaceAfter = Math.round((afterLines / 100) * 240);
    if (line !== undefined) out.line = line;
    const rule = spacing.attrs['w:lineRule'];
    if (rule === 'auto' || rule === 'exact' || rule === 'atLeast') out.lineRule = rule;
    else if (line !== undefined && !rule) out.lineRule = 'auto';
    const beforeAuto = spacing.attrs['w:beforeAutospacing'];
    const afterAuto = spacing.attrs['w:afterAutospacing'];
    if (beforeAuto !== undefined) out.beforeAutospacing = beforeAuto === '1' || beforeAuto === 'true' || beforeAuto === 'on';
    if (afterAuto !== undefined) out.afterAutospacing = afterAuto === '1' || afterAuto === 'true' || afterAuto === 'on';
  }
  const flags: Array<[keyof PPr, string]> = [
    ['contextualSpacing', 'w:contextualSpacing'],
    ['keepNext', 'w:keepNext'],
    ['keepLines', 'w:keepLines'],
    ['pageBreakBefore', 'w:pageBreakBefore'],
    ['widowControl', 'w:widowControl'],
    ['bidi', 'w:bidi'],
    ['suppressAutoHyphens', 'w:suppressAutoHyphens'],
  ];
  for (const [key, name] of flags) {
    const value = onOff(element, name);
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  const outline = intAttr(child(element, 'w:outlineLvl'), 'w:val');
  if (outline !== undefined && outline >= 0 && outline <= 8) out.outlineLevel = outline;
  const tabs = child(element, 'w:tabs');
  if (tabs) {
    out.tabs = [];
    for (const tab of children(tabs, 'w:tab')) {
      const pos = intAttr(tab, 'w:pos');
      const kind = tab.attrs['w:val'];
      if (pos === undefined || !kind) continue;
      if (kind === 'clear') out.tabs.push({ pos, clear: true });
      else {
        const leader = tab.attrs['w:leader'];
        out.tabs.push({
          pos,
          align: kind === 'start' ? 'left' : kind === 'end' ? 'right' : (kind as TabStop['align']),
          leader: leader && leader !== 'none' ? (leader as TabStop['leader']) : undefined,
        });
      }
    }
  }
  const shading = shadingFill(child(element, 'w:shd'), theme);
  if (shading) out.shading = shading;
  const borders = child(element, 'w:pBdr');
  if (borders) {
    out.borders = {};
    for (const side of ['top', 'bottom', 'left', 'right', 'between'] as const) {
      const border = parseBorder(child(borders, `w:${side}`), theme);
      if (border) out.borders[side] = border;
    }
  }
  const numPr = child(element, 'w:numPr');
  if (numPr) {
    const numId = val(numPr, 'w:numId');
    const level = intAttr(child(numPr, 'w:ilvl'), 'w:val');
    out.numbering = { numId, level };
  }
  return out;
}

function mapAlign(jc: string): ParaProps['align'] {
  switch (jc) {
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'both':
    case 'justify':
    case 'lowKashida':
    case 'mediumKashida':
    case 'highKashida':
      return 'both';
    case 'distribute':
    case 'thaiDistribute':
      return 'distribute';
    default:
      return 'left';
  }
}

export function mergePPr(base: PPr, over: PPr): PPr {
  const out: PPr = { ...base, ...stripUndefined(over) };
  if (base.tabs || over.tabs) out.tabs = [...(base.tabs ?? []), ...(over.tabs ?? [])];
  if (base.borders || over.borders) out.borders = { ...base.borders, ...over.borders };
  if (base.numbering || over.numbering) out.numbering = { ...base.numbering, ...stripUndefined(over.numbering ?? {}) };
  return out;
}

export function mergeRPr(base: RPr, over: RPr): RPr {
  const out: RPr = { ...base, ...stripUndefined(over) };
  if (base.fonts || over.fonts) out.fonts = { ...base.fonts, ...over.fonts };
  if (base.themeFonts || over.themeFonts) {
    // An explicit font name at a higher level replaces a theme font at a lower one.
    const themed = { ...base.themeFonts };
    for (const slot of Object.keys(over.fonts ?? {}) as Array<keyof NonNullable<RPr['themeFonts']>>) delete themed[slot];
    out.themeFonts = { ...themed, ...over.themeFonts };
  }
  if (base.toggles || over.toggles) out.toggles = { ...base.toggles, ...over.toggles };
  return out;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  return out;
}

/* ------------------------------------------------------------------ *
 * The style sheet
 * ------------------------------------------------------------------ */

interface StyleDef {
  id: string;
  type: string;
  name?: string;
  basedOn?: string;
  pPr: PPr;
  rPr: RPr;
  tblPr?: XmlElement;
  tcPr?: XmlElement;
}

export class StyleSheet {
  readonly theme: Theme;
  private readonly defaults: { pPr: PPr; rPr: RPr };
  private readonly styles = new Map<string, StyleDef>();
  private readonly defaultIds: Partial<Record<string, string>> = {};
  private readonly chainCache = new Map<string, { pPr: PPr; rPr: RPr }>();
  private readonly interned = new Map<string, RunProps>();

  constructor(root: XmlElement | undefined, theme: Theme) {
    this.theme = theme;
    const docDefaults = child(root, 'w:docDefaults');
    this.defaults = {
      pPr: parsePPr(child(child(docDefaults, 'w:pPrDefault'), 'w:pPr'), theme),
      rPr: parseRPr(child(child(docDefaults, 'w:rPrDefault'), 'w:rPr'), theme),
    };
    for (const style of children(root, 'w:style')) {
      const id = style.attrs['w:styleId'];
      if (!id) continue;
      const type = style.attrs['w:type'] ?? 'paragraph';
      this.styles.set(id, {
        id,
        type,
        name: val(style, 'w:name'),
        basedOn: val(style, 'w:basedOn'),
        pPr: parsePPr(child(style, 'w:pPr'), theme),
        rPr: parseRPr(child(style, 'w:rPr'), theme),
        tblPr: child(style, 'w:tblPr'),
        tcPr: child(style, 'w:tcPr'),
      });
      const isDefault = style.attrs['w:default'];
      if (isDefault === '1' || isDefault === 'true') this.defaultIds[type] = id;
    }
  }

  defaultStyle(type: 'paragraph' | 'character' | 'table'): string | undefined {
    return this.defaultIds[type];
  }

  style(id: string | undefined): StyleDef | undefined {
    return id ? this.styles.get(id) : undefined;
  }

  /** Style id by display name, e.g. "heading 1" — for outline detection. */
  nameOf(id: string | undefined): string | undefined {
    return this.style(id)?.name;
  }

  /** Merged properties of a style and everything it is based on. */
  chain(id: string | undefined): { pPr: PPr; rPr: RPr } {
    if (!id) return { pPr: {}, rPr: {} };
    const cached = this.chainCache.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    const order: StyleDef[] = [];
    for (let current = this.styles.get(id); current && !seen.has(current.id); current = current.basedOn ? this.styles.get(current.basedOn) : undefined) {
      seen.add(current.id);
      order.unshift(current);
    }
    let pPr: PPr = {};
    let rPr: RPr = {};
    for (const style of order) {
      pPr = mergePPr(pPr, style.pPr);
      rPr = mergeRPr(rPr, style.rPr);
    }
    const result = { pPr, rPr };
    this.chainCache.set(id, result);
    return result;
  }

  paragraphStyleId(direct: PPr): string | undefined {
    return direct.styleId && this.styles.has(direct.styleId) ? direct.styleId : this.defaultIds.paragraph;
  }

  /** Paragraph properties before numbering is applied. */
  paragraph(direct: PPr, table?: { pPr: PPr }, numbering?: PPr): PPr {
    const styleId = this.paragraphStyleId(direct);
    let merged = mergePPr(this.defaults.pPr, table?.pPr ?? {});
    if (numbering) merged = mergePPr(merged, numbering);
    merged = mergePPr(merged, this.chain(styleId).pPr);
    merged = mergePPr(merged, direct);
    merged.styleId = styleId;
    return merged;
  }

  /**
   * Final run properties, interned: runs with identical formatting share one
   * object, which keeps a large document's model small.
   */
  run(direct: RPr, paragraphStyleId: string | undefined, table?: { rPr: RPr }, extra?: RPr): RunProps {
    const characterStyleId = direct.styleId ?? this.defaultIds.character;
    const levels = [table?.rPr, this.chain(paragraphStyleId).rPr, extra, this.chain(characterStyleId).rPr].filter(
      (level): level is RPr => level !== undefined,
    );
    let merged = this.defaults.rPr;
    for (const level of levels) merged = mergeRPr(merged, level);
    merged = mergeRPr(merged, { ...direct, toggles: undefined });

    const toggles: Partial<Record<Toggle, boolean>> = {};
    for (const [key] of TOGGLES) {
      let value = this.defaults.rPr.toggles?.[key] ?? false;
      let styleSet = false;
      for (const level of levels) {
        const levelValue = level.toggles?.[key];
        if (levelValue === undefined) continue;
        // The first style level to set a toggle sets it; later levels flip it.
        value = styleSet ? value !== levelValue : levelValue;
        styleSet = true;
      }
      const directValue = direct.toggles?.[key];
      toggles[key] = directValue ?? value;
    }

    const theme = this.theme;
    const fonts: RunProps['fonts'] = { ...merged.fonts };
    for (const [slot, ref] of Object.entries(merged.themeFonts ?? {}) as Array<[keyof RunProps['fonts'], string]>) {
      const scheme = ref.startsWith('major') ? theme.majorFont : theme.minorFont;
      const name = /EastAsia$/.test(ref) ? scheme.eastAsia : /Bidi$/.test(ref) ? scheme.cs : scheme.latin;
      if (name) fonts[slot] = name;
    }

    const props: RunProps = {
      fonts,
      size: merged.size ?? 20,
      sizeCs: merged.sizeCs,
      bold: toggles.bold ?? false,
      italic: toggles.italic ?? false,
      boldCs: toggles.boldCs,
      italicCs: toggles.italicCs,
      caps: toggles.caps ?? false,
      smallCaps: toggles.smallCaps ?? false,
      strike: toggles.strike ?? false,
      dstrike: toggles.dstrike ?? false,
      vanish: toggles.vanish ?? false,
      underline: merged.underline && merged.underline !== 'none' ? merged.underline : undefined,
      underlineColor: merged.underlineColor,
      color: merged.color === 'auto' ? undefined : merged.color,
      highlight: merged.highlight,
      shading: merged.shading,
      vertAlign: merged.vertAlign === 'baseline' ? undefined : merged.vertAlign,
      spacing: merged.spacing ?? 0,
      scale: merged.scale ?? 100,
      position: merged.position ?? 0,
      rtl: merged.rtl ?? false,
    };
    const key = JSON.stringify(props);
    let shared = this.interned.get(key);
    if (!shared) {
      shared = props;
      this.interned.set(key, shared);
    }
    return shared;
  }

  /** Table style chain: its table-level paragraph and run properties. */
  table(id: string | undefined): { pPr: PPr; rPr: RPr; tblPr?: XmlElement; tcPr?: XmlElement } | undefined {
    const styleId = id ?? this.defaultIds.table;
    if (!styleId || !this.styles.has(styleId)) return undefined;
    const chain = this.chain(styleId);
    // Table properties: the nearest style in the chain that has them.
    let tblPr: XmlElement | undefined;
    let tcPr: XmlElement | undefined;
    const seen = new Set<string>();
    for (let current = this.styles.get(styleId); current && !seen.has(current.id); current = current.basedOn ? this.styles.get(current.basedOn) : undefined) {
      seen.add(current.id);
      tblPr ??= current.tblPr;
      tcPr ??= current.tcPr;
    }
    return { ...chain, tblPr, tcPr };
  }
}

/** Fill in every paragraph property from a merged partial. */
export function finalParaProps(merged: PPr): ParaProps {
  const tabs = new Map<number, TabStop>();
  for (const tab of merged.tabs ?? []) {
    if ('clear' in tab) tabs.delete(tab.pos);
    else tabs.set(tab.pos, tab);
  }
  return {
    styleId: merged.styleId,
    align: merged.align ?? 'left',
    indentLeft: merged.indentLeft ?? 0,
    indentRight: merged.indentRight ?? 0,
    firstLine: merged.firstLine ?? 0,
    spaceBefore: merged.spaceBefore ?? 0,
    spaceAfter: merged.spaceAfter ?? 0,
    beforeAutospacing: merged.beforeAutospacing ?? false,
    afterAutospacing: merged.afterAutospacing ?? false,
    line: merged.line ?? 240,
    lineRule: merged.lineRule ?? 'auto',
    contextualSpacing: merged.contextualSpacing ?? false,
    keepNext: merged.keepNext ?? false,
    keepLines: merged.keepLines ?? false,
    pageBreakBefore: merged.pageBreakBefore ?? false,
    // Word turns widow control on unless a document turns it off.
    widowControl: merged.widowControl ?? true,
    outlineLevel: merged.outlineLevel,
    tabs: [...tabs.values()].sort((a, b) => a.pos - b.pos),
    shading: merged.shading,
    borders: merged.borders,
    bidi: merged.bidi ?? false,
    numbering:
      merged.numbering?.numId && merged.numbering.numId !== '0'
        ? { numId: merged.numbering.numId, level: merged.numbering.level ?? 0 }
        : undefined,
    suppressAutoHyphens: merged.suppressAutoHyphens ?? false,
  };
}
