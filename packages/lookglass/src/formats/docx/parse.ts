import type { OoxmlPackage, Relationship } from '../../ooxml/opc.js';
import { DEFAULT_THEME, parseTheme, type Theme } from '../../ooxml/theme.js';
import { attr, child, children, descendant, intAttr, onOff, textContent, val, type XmlElement } from '../../ooxml/xml.js';
import type {
  Block,
  BorderSpec,
  CellProps,
  Drawing,
  DrawingAnchor,
  HeaderFooterRefs,
  Inline,
  Paragraph,
  RunProps,
  SectionProps,
  Table,
  TableCell,
  TableRow,
  WordDocument,
} from './model.js';
import { Numbering, formatNumber } from './numbering.js';
import { StyleSheet, finalParaProps, mergePPr, mergeRPr, parseBorder, parsePPr, parseRPr, shadingFill, type PPr, type RPr } from './styles.js';

/**
 * Word document parser: package parts in, resolved model out.
 */

export interface ParseResult {
  document: WordDocument;
  styles: StyleSheet;
  /** Embedded fonts, still obfuscated, with their keys. */
  embeddedFonts: Array<{ family: string; bold: boolean; italic: boolean; part: string; key?: string }>;
  fontTable: Map<string, { family?: string; altName?: string }>;
}

const LINK_SCHEMES = /^(?:https?:|mailto:|tel:)/i;

export async function parseWordDocument(pkg: OoxmlPackage, signal?: AbortSignal): Promise<ParseResult> {
  const main = (await pkg.relatedPart('/', 'officeDocument', signal)) ?? '/word/document.xml';
  const rels = await pkg.rels(main, signal);
  const partOf = (type: string) => [...rels.values()].find((rel) => rel.type === type && !rel.external)?.target;

  const theme = parseTheme(await pkg.xmlIfPresent(partOf('theme'), signal)) ?? DEFAULT_THEME;
  const styles = new StyleSheet(await pkg.xmlIfPresent(partOf('styles'), signal), theme);
  const numbering = new Numbering(await pkg.xmlIfPresent(partOf('numbering'), signal), theme, (styleId) => {
    return styles.chain(styleId).pPr.numbering?.numId;
  });
  const settingsRoot = await pkg.xmlIfPresent(partOf('settings'), signal);
  const fontTableRoot = await pkg.xmlIfPresent(partOf('fontTable'), signal);
  const fontTablePart = partOf('fontTable');
  const fontRels = fontTablePart ? await pkg.rels(fontTablePart, signal) : new Map<string, Relationship>();

  const fontTable = new Map<string, { family?: string; altName?: string }>();
  const embeddedFonts: ParseResult['embeddedFonts'] = [];
  for (const font of children(fontTableRoot, 'w:font')) {
    const name = font.attrs['w:name'];
    if (!name) continue;
    fontTable.set(name.toLowerCase(), { family: val(font, 'w:family'), altName: val(font, 'w:altName') });
    for (const [tag, bold, italic] of [
      ['w:embedRegular', false, false],
      ['w:embedBold', true, false],
      ['w:embedItalic', false, true],
      ['w:embedBoldItalic', true, true],
    ] as const) {
      const embed = child(font, tag);
      const rel = embed ? fontRels.get(embed.attrs['r:id'] ?? '') : undefined;
      if (rel && !rel.external) embeddedFonts.push({ family: name, bold, italic, part: rel.target, key: embed!.attrs['w:fontKey'] });
    }
  }

  const settings = {
    defaultTabStop: intAttr(child(settingsRoot, 'w:defaultTabStop'), 'w:val') ?? 720,
    evenAndOddHeaders: onOff(settingsRoot, 'w:evenAndOddHeaders') ?? false,
    compatibilityMode:
      Number(
        children(child(settingsRoot, 'w:compat'), 'w:compatSetting').find((setting) => setting.attrs['w:name'] === 'compatibilityMode')
          ?.attrs['w:val'],
      ) || 12,
  };

  const unsupported: Record<string, number> = {};
  const noteFormat = (name: string) => ({
    format: val(child(settingsRoot, name), 'w:numFmt') ?? 'decimal',
    start: intAttr(child(child(settingsRoot, name), 'w:numStart'), 'w:val') ?? 1,
  });
  const context: ParseContext = {
    styles,
    numbering,
    theme,
    unsupported,
    rels,
    headings: [],
    bookmarks: new Map(),
    blockIndex: 0,
    noteRefs: [],
    notes: {
      footnote: { ...noteFormat('w:footnotePr'), next: noteFormat('w:footnotePr').start },
      endnote: { ...noteFormat('w:endnotePr'), next: noteFormat('w:endnotePr').start },
    },
  };

  const root = await pkg.xml(main, signal);
  const body = child(root, 'w:body');
  const blocks = parseBlocks(body, context, undefined, true);
  const finalSection = parseSection(child(body, 'w:sectPr'));

  // Headers and footers referenced by any section.
  const headers = new Map<string, Block[]>();
  const sections = [finalSection, ...blocks.flatMap((block) => (block.section ? [block.section] : []))];
  const wanted = new Set<string>();
  for (const section of sections) {
    for (const refs of [section.headers, section.footers]) for (const id of Object.values(refs)) if (id) wanted.add(id);
  }
  for (const id of wanted) {
    const rel = rels.get(id);
    if (!rel || rel.external || !pkg.has(rel.target)) continue;
    const partRels = await pkg.rels(rel.target, signal);
    const headerRoot = await pkg.xml(rel.target, signal);
    headers.set(id, parseBlocks(headerRoot, { ...context, rels: partRels, headings: [], bookmarks: new Map(), blockIndex: 0 }, undefined, false));
  }

  // Footnotes and endnotes. Parsed after the body, because their numbers come
  // from the order their references appear in it.
  const footnotes = new Map<string, Block[]>();
  const endnotes = new Map<string, Block[]>();
  let noteSeparator: Block[] | undefined;
  for (const [type, target] of [
    ['footnote', partOf('footnotes')],
    ['endnote', partOf('endnotes')],
  ] as const) {
    if (!target || !pkg.has(target)) continue;
    const partRels = await pkg.rels(target, signal);
    const noteRoot = await pkg.xml(target, signal);
    const into = type === 'footnote' ? footnotes : endnotes;
    for (const note of children(noteRoot, `w:${type}`)) {
      const id = note.attrs['w:id'];
      if (id === undefined) continue;
      const kind = note.attrs['w:type'];
      // Separators and continuation notices are not notes; the first separator
      // is the rule drawn above them.
      const noteContext = { ...context, rels: partRels, headings: [], bookmarks: new Map<string, number>(), blockIndex: 0 };
      if (kind === 'separator') noteSeparator ??= parseBlocks(note, noteContext, undefined, false);
      else if (!kind) into.set(id, parseBlocks(note, noteContext, undefined, false));
    }
  }

  const core = await pkg.xmlIfPresent((await pkg.relatedPart('/', 'core-properties', signal)) ?? '/docProps/core.xml', signal);

  return {
    document: {
      body: blocks,
      finalSection,
      headers,
      footnotes,
      endnotes,
      noteRefs: context.noteRefs,
      noteSeparator,
      settings,
      title: textContent(child(core, 'dc:title')).trim() || undefined,
      author: textContent(child(core, 'dc:creator')).trim() || undefined,
      headings: context.headings,
      bookmarks: context.bookmarks,
      unsupported,
    },
    styles,
    embeddedFonts,
    fontTable,
  };
}

interface ParseContext {
  styles: StyleSheet;
  numbering: Numbering;
  theme: Theme;
  unsupported: Record<string, number>;
  rels: Map<string, Relationship>;
  headings: WordDocument['headings'];
  bookmarks: Map<string, number>;
  noteRefs: WordDocument['noteRefs'];
  /** Note numbering, counted in the order references appear. */
  notes: Record<'footnote' | 'endnote', { format: string; start: number; next: number }>;
  /** Index of the top-level body block being parsed. */
  blockIndex: number;
}

interface TableContext {
  pPr: PPr;
  rPr: RPr;
}

interface FieldFrame {
  instruction: string;
  phase: 'code' | 'result';
  dynamic?: 'PAGE' | 'NUMPAGES' | 'SECTIONPAGES';
  format?: string;
  link?: string;
  emitted?: boolean;
}

/** State that carries across runs and paragraphs: fields may span both. */
interface FlowState {
  fields: FieldFrame[];
}

function parseBlocks(container: XmlElement | undefined, context: ParseContext, table: TableContext | undefined, topLevel: boolean): Block[] {
  const blocks: Block[] = [];
  const flow: FlowState = { fields: [] };
  const visit = (element: XmlElement) => {
    switch (element.name) {
      case 'w:p': {
        const paragraph = parseParagraph(element, context, table, flow);
        if (topLevel) recordHeading(paragraph, element, context);
        blocks.push(paragraph);
        if (topLevel) context.blockIndex = blocks.length;
        break;
      }
      case 'w:tbl': {
        blocks.push(parseTable(element, context));
        if (topLevel) context.blockIndex = blocks.length;
        break;
      }
      case 'w:sdt':
        for (const node of children(child(element, 'w:sdtContent'))) visit(node);
        break;
      case 'w:customXml':
      case 'w:smartTag':
        for (const node of children(element)) visit(node);
        break;
      case 'w:bookmarkStart': {
        const name = element.attrs['w:name'];
        if (topLevel && name && !context.bookmarks.has(name)) context.bookmarks.set(name, blocks.length);
        break;
      }
      case 'w:altChunk':
        context.unsupported.altChunk = (context.unsupported.altChunk ?? 0) + 1;
        break;
      default:
        break;
    }
  };
  for (const node of children(container)) visit(node);
  return blocks;
}

function recordHeading(paragraph: Paragraph, element: XmlElement, context: ParseContext): void {
  let level = paragraph.props.outlineLevel;
  if (level === undefined) {
    const match = /^heading\s*([1-9])$/i.exec(context.styles.nameOf(paragraph.props.styleId) ?? '');
    if (match) level = Number(match[1]) - 1;
  }
  if (level === undefined || level > 8) return;
  const text = paragraph.inlines
    .map((inline) => (inline.kind === 'text' ? inline.text : inline.kind === 'tab' ? ' ' : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) context.headings.push({ level, text: text.slice(0, 200), block: context.blockIndex });
  void element;
}

/* ------------------------------------------------------------------ *
 * Paragraphs and runs
 * ------------------------------------------------------------------ */

function parseParagraph(element: XmlElement, context: ParseContext, table: TableContext | undefined, flow: FlowState): Paragraph {
  const { styles } = context;
  const pPrElement = child(element, 'w:pPr');
  const direct = parsePPr(pPrElement, context.theme);

  // Numbering properties sit between the table style and the paragraph style.
  let merged = styles.paragraph(direct, table);
  const numPr = merged.numbering;
  let label: Paragraph['label'];
  let numberingRPr: RPr | undefined;
  if (numPr?.numId && numPr.numId !== '0') {
    const levelIndex = numPr.level ?? 0;
    const level = context.numbering.level(numPr.numId, levelIndex);
    if (level) {
      merged = styles.paragraph(direct, table, level.pPr);
      numberingRPr = level.rPr;
    }
  }
  const props = finalParaProps(merged);
  const paragraphStyle = props.styleId;
  const markRPr = parseRPr(child(pPrElement, 'w:rPr'), context.theme);
  const markProps = styles.run(markRPr, paragraphStyle, table);

  if (props.numbering) {
    const next = context.numbering.next(props.numbering.numId, props.numbering.level);
    if (next && next.text) {
      // The label takes the paragraph mark's formatting, then the level's own.
      const labelProps = styles.run(mergeRPr(markRPr, numberingRPr ?? {}), paragraphStyle, table);
      label = { text: next.text, props: labelProps, suffix: next.level.suffix, align: next.level.align };
    }
  }

  const inlines: Inline[] = [];
  const run = (props: RPr) => styles.run(props, paragraphStyle, table);
  parseInlineContent(element, inlines, context, run, flow, undefined);

  const paragraph: Paragraph = { kind: 'p', props, markProps, inlines, label };
  const sectPr = child(pPrElement, 'w:sectPr');
  if (sectPr) paragraph.section = parseSection(sectPr);
  return paragraph;
}

function parseInlineContent(
  container: XmlElement,
  out: Inline[],
  context: ParseContext,
  run: (props: RPr) => RunProps,
  flow: FlowState,
  link: string | undefined,
): void {
  for (const node of children(container)) {
    switch (node.name) {
      case 'w:r':
        parseRun(node, out, context, run, flow, link);
        break;
      case 'w:hyperlink': {
        const target = hyperlinkTarget(node, context);
        parseInlineContent(node, out, context, run, flow, target ?? link);
        break;
      }
      case 'w:fldSimple': {
        const instruction = node.attrs['w:instr'] ?? '';
        const frame = fieldFrame(instruction);
        if (frame.dynamic) {
          const firstRun = child(node, 'w:r');
          out.push({ kind: 'field', field: frame.dynamic, format: frame.format, props: run(parseRPr(child(firstRun, 'w:rPr'), context.theme)) });
        } else {
          parseInlineContent(node, out, context, run, flow, frame.link ?? link);
        }
        break;
      }
      case 'w:ins':
      case 'w:moveTo':
      case 'w:smartTag':
      case 'w:customXml':
      case 'w:dir':
      case 'w:bdo':
        parseInlineContent(node, out, context, run, flow, link);
        break;
      case 'w:sdt':
        parseInlineContent(child(node, 'w:sdtContent') ?? node, out, context, run, flow, link);
        break;
      case 'w:bookmarkStart': {
        const name = node.attrs['w:name'];
        if (name) {
          out.push({ kind: 'bookmark', name });
          if (!context.bookmarks.has(name)) context.bookmarks.set(name, context.blockIndex);
        }
        break;
      }
      case 'm:oMath':
      case 'm:oMathPara':
        // Equations are laid out as their text until the math engine lands.
        context.unsupported.equation = (context.unsupported.equation ?? 0) + 1;
        {
          const text = mathText(node);
          if (text) out.push({ kind: 'text', text, props: run({ toggles: { italic: true }, fonts: { ascii: 'Cambria Math', hAnsi: 'Cambria Math' } }) });
        }
        break;
      default:
        // w:del, w:moveFrom (deleted text), w:proofErr, w:permStart... carry nothing to show.
        break;
    }
  }
}

function hyperlinkTarget(node: XmlElement, context: ParseContext): string | undefined {
  const id = node.attrs['r:id'];
  const anchor = node.attrs['w:anchor'];
  if (id) {
    const rel = context.rels.get(id);
    if (rel?.external && LINK_SCHEMES.test(rel.target)) return rel.target + (anchor ? `#${anchor}` : '');
    if (rel?.external) return undefined;
  }
  return anchor ? `#${anchor}` : undefined;
}

function parseRun(node: XmlElement, out: Inline[], context: ParseContext, run: (props: RPr) => RunProps, flow: FlowState, link: string | undefined) {
  const rPr = parseRPr(child(node, 'w:rPr'), context.theme);
  // Word shows table-of-contents entries in the TOC styles' formatting, not
  // as blue underlined links, although their runs carry the Hyperlink style.
  if (rPr.styleId && flow.fields.some((field) => field.phase === 'result' && /^s*TOC/i.test(field.instruction))) {
    if (context.styles.nameOf(rPr.styleId)?.toLowerCase() === 'hyperlink') delete rPr.styleId;
  }
  let props: RunProps | undefined;
  const get = () => (props ??= run(rPr));
  for (const item of children(node)) {
    const frame = flow.fields[flow.fields.length - 1];
    switch (item.name) {
      case 'w:fldChar': {
        const type = item.attrs['w:fldCharType'];
        if (type === 'begin') flow.fields.push({ instruction: '', phase: 'code' });
        else if (type === 'separate' && frame) {
          const parsed = fieldFrame(frame.instruction);
          Object.assign(frame, parsed, { phase: 'result' });
          if (frame.dynamic && !frame.emitted) {
            frame.emitted = true;
            out.push({ kind: 'field', field: frame.dynamic, format: frame.format, props: get() });
          }
        } else if (type === 'end') {
          const ended = flow.fields.pop();
          if (ended && ended.phase === 'code') {
            // A field with no cached result: only dynamic fields can be shown.
            const parsed = fieldFrame(ended.instruction);
            if (parsed.dynamic) out.push({ kind: 'field', field: parsed.dynamic, format: parsed.format, props: get() });
          }
        }
        continue;
      }
      case 'w:instrText':
        if (flow.fields.length > 0) {
          const top = flow.fields[flow.fields.length - 1]!;
          if (top.phase === 'code') top.instruction += textContent(item);
        }
        continue;
      default:
        break;
    }
    // Field instructions are not shown, and neither is the stale cached
    // result of a field we compute ourselves (page numbers).
    if (flow.fields.some((field) => field.phase === 'code' || field.dynamic)) continue;
    if (get().vanish) continue;
    const effectiveLink = [...flow.fields].reverse().find((field) => field.link)?.link ?? link;

    switch (item.name) {
      case 'w:t':
        pushText(out, textContent(item), get(), effectiveLink);
        break;
      case 'w:tab':
        out.push({ kind: 'tab', props: get(), link: effectiveLink });
        break;
      case 'w:ptab': {
        const alignment = item.attrs['w:alignment'];
        out.push({
          kind: 'ptab',
          props: get(),
          align: alignment === 'center' ? 'center' : alignment === 'right' ? 'right' : 'left',
          relativeTo: item.attrs['w:relativeTo'] === 'indent' ? 'indent' : 'margin',
        });
        break;
      }
      case 'w:br': {
        const type = item.attrs['w:type'];
        out.push({ kind: 'break', type: type === 'page' ? 'page' : type === 'column' ? 'column' : 'line', props: get() });
        break;
      }
      case 'w:cr':
        out.push({ kind: 'break', type: 'line', props: get() });
        break;
      case 'w:noBreakHyphen':
        pushText(out, '‑', get(), effectiveLink);
        break;
      case 'w:softHyphen':
        pushText(out, '­', get(), effectiveLink);
        break;
      case 'w:sym': {
        const code = Number.parseInt(item.attrs['w:char'] ?? '', 16);
        const font = item.attrs['w:font'];
        if (Number.isFinite(code)) {
          // Symbol fonts use the F000 private range; the glyph is at the low byte too.
          const symbolProps = font ? run(mergeRPr(rPr, { fonts: { ascii: font, hAnsi: font, eastAsia: font, cs: font } })) : get();
          pushText(out, String.fromCodePoint(code), symbolProps, effectiveLink);
        }
        break;
      }
      case 'w:lastRenderedPageBreak':
        out.push({ kind: 'renderedBreak' });
        break;
      case 'w:footnoteReference':
      case 'w:endnoteReference': {
        // Notes are numbered in the order their references appear, which is
        // not always the order they are stored in.
        const note = item.name === 'w:footnoteReference' ? 'footnote' : 'endnote';
        const counter = context.notes[note];
        const custom = item.attrs['w:customMarkFollows'] === '1';
        const number = custom ? '' : formatNumber(counter.next++, counter.format);
        const noteId = item.attrs['w:id'] ?? '';
        context.noteRefs.push({ type: note, id: noteId, number });
        out.push({ kind: 'noteRef', note, id: noteId, number, props: get() });
        break;
      }
      case 'w:footnoteRef':
      case 'w:endnoteRef':
        out.push({ kind: 'noteNumber', props: get() });
        break;
      case 'w:drawing': {
        const drawing = parseDrawing(item, context);
        if (drawing) out.push({ kind: 'image', props: get(), drawing, link: effectiveLink });
        break;
      }
      case 'w:pict':
      case 'w:object': {
        const drawing = parseVmlPicture(item, context);
        if (drawing) out.push({ kind: 'image', props: get(), drawing, link: effectiveLink });
        break;
      }
      default:
        break;
    }
  }
}

function pushText(out: Inline[], text: string, props: RunProps, link: string | undefined): void {
  if (!text) return;
  const last = out[out.length - 1];
  // Adjacent runs with the same formatting are merged: Word splits runs for
  // revision tracking and spell-check, not for any visible reason.
  if (last && last.kind === 'text' && last.props === props && last.link === link) {
    last.text += text;
    return;
  }
  out.push({ kind: 'text', text, props, link });
}

function fieldFrame(instruction: string): Omit<FieldFrame, 'phase' | 'instruction'> {
  const trimmed = instruction.trim();
  const code = /^([A-Z]+)/i.exec(trimmed)?.[1]?.toUpperCase();
  const format = /\\\*\s*([A-Za-z]+)/.exec(trimmed)?.[1];
  if (code === 'PAGE' || code === 'NUMPAGES' || code === 'SECTIONPAGES') return { dynamic: code, format };
  if (code === 'HYPERLINK') {
    const anchor = /\\l\s+"([^"]+)"/.exec(trimmed)?.[1];
    const url = /^HYPERLINK\s+"([^"]+)"/i.exec(trimmed)?.[1];
    if (anchor) return { link: `#${anchor}` };
    if (url && LINK_SCHEMES.test(url)) return { link: url };
    return {};
  }
  if (code === 'PAGEREF' || code === 'REF') {
    const bookmark = /^(?:PAGEREF|REF)\s+([^\s\\]+)/i.exec(trimmed)?.[1];
    if (bookmark && /\\h/.test(trimmed)) return { link: `#${bookmark}` };
  }
  return {};
}

function mathText(node: XmlElement): string {
  let out = '';
  const walk = (element: XmlElement) => {
    for (const item of element.children) {
      if (typeof item === 'string') continue;
      if (item.name === 'm:t') out += textContent(item);
      else walk(item);
    }
  };
  walk(node);
  return out;
}

/* ------------------------------------------------------------------ *
 * Drawings
 * ------------------------------------------------------------------ */

function parseDrawing(node: XmlElement, context: ParseContext): Drawing | undefined {
  const inline = child(node, 'wp:inline');
  const anchor = child(node, 'wp:anchor');
  const frame = inline ?? anchor;
  if (!frame) return undefined;
  const extent = child(frame, 'wp:extent');
  const width = intAttr(extent, 'cx') ?? 0;
  const height = intAttr(extent, 'cy') ?? 0;
  const docPr = child(frame, 'wp:docPr');
  const graphicData = child(child(frame, 'a:graphic'), 'a:graphicData');
  const drawing: Drawing = { width, height, alt: docPr?.attrs.descr || docPr?.attrs.title || undefined };

  const picture = child(graphicData, 'pic:pic');
  if (picture) {
    const blip = descendant(child(picture, 'pic:blipFill'), 'a:blip');
    // Prefer the SVG original Office stores alongside the PNG fallback.
    const svg = descendant(blip, 'asvg:svgBlip');
    const id = svg?.attrs['r:embed'] ?? blip?.attrs['r:embed'];
    const rel = id ? context.rels.get(id) : undefined;
    if (rel && !rel.external) drawing.part = rel.target;
    else drawing.placeholder = 'Linked image';
    const srcRect = child(child(picture, 'pic:blipFill'), 'a:srcRect');
    if (srcRect) {
      const crop = {
        l: (intAttr(srcRect, 'l') ?? 0) / 100_000,
        t: (intAttr(srcRect, 't') ?? 0) / 100_000,
        r: (intAttr(srcRect, 'r') ?? 0) / 100_000,
        b: (intAttr(srcRect, 'b') ?? 0) / 100_000,
      };
      if (crop.l || crop.t || crop.r || crop.b) drawing.crop = crop;
    }
    const xfrm = child(child(picture, 'pic:spPr'), 'a:xfrm');
    const rotation = intAttr(xfrm, 'rot');
    if (rotation) drawing.rotation = rotation / 60_000;
    if (attr(xfrm, 'flipH') === '1') drawing.flipH = true;
    if (attr(xfrm, 'flipV') === '1') drawing.flipV = true;
  } else {
    const uri = graphicData?.attrs.uri ?? '';
    const kind = /chart/.test(uri) ? 'Chart' : /diagram/.test(uri) ? 'SmartArt' : /wordprocessingShape|wordprocessingGroup|wordprocessingCanvas/.test(uri) ? 'Shape' : 'Object';
    drawing.placeholder = kind;
    context.unsupported[kind.toLowerCase()] = (context.unsupported[kind.toLowerCase()] ?? 0) + 1;
  }

  if (anchor) drawing.anchor = parseAnchor(anchor);
  return drawing;
}

function parseAnchor(anchor: XmlElement): DrawingAnchor {
  const positionH = child(anchor, 'wp:positionH');
  const positionV = child(anchor, 'wp:positionV');
  const offset = (position: XmlElement | undefined) => {
    const value = textContent(child(position, 'wp:posOffset')).trim();
    return value ? Number(value) : undefined;
  };
  const wrapElement = ['wp:wrapNone', 'wp:wrapSquare', 'wp:wrapTight', 'wp:wrapThrough', 'wp:wrapTopAndBottom'].find((name) => child(anchor, name));
  const wrap = (wrapElement?.slice(7) ?? 'None').replace(/^./, (c) => c.toLowerCase()) as DrawingAnchor['wrap'];
  const wrapNode = wrapElement ? child(anchor, wrapElement) : undefined;
  const side = wrapNode?.attrs.wrapText;
  return {
    behindDoc: anchor.attrs.behindDoc === '1',
    horizontal: {
      relativeFrom: positionH?.attrs.relativeFrom ?? 'column',
      offset: offset(positionH),
      align: textContent(child(positionH, 'wp:align')).trim() || undefined,
    },
    vertical: {
      relativeFrom: positionV?.attrs.relativeFrom ?? 'paragraph',
      offset: offset(positionV),
      align: textContent(child(positionV, 'wp:align')).trim() || undefined,
    },
    wrap,
    wrapSide: side === 'left' || side === 'right' || side === 'largest' ? side : 'bothSides',
    distance: {
      t: intAttr(anchor, 'distT') ?? 0,
      b: intAttr(anchor, 'distB') ?? 0,
      l: intAttr(anchor, 'distL') ?? 0,
      r: intAttr(anchor, 'distR') ?? 0,
    },
  };
}

/** Legacy VML pictures (`w:pict`, `w:object`): the image data and its CSS size. */
function parseVmlPicture(node: XmlElement, context: ParseContext): Drawing | undefined {
  const shape = descendant(node, 'v:shape') ?? descendant(node, 'v:rect');
  const imageData = descendant(node, 'v:imagedata');
  if (!shape) return undefined;
  const style = shape.attrs.style ?? '';
  const length = (name: string) => {
    const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)(pt|in|cm|mm|px)?`, 'i').exec(style);
    if (!match) return 0;
    const value = Number(match[1]);
    const unit = (match[2] ?? 'px').toLowerCase();
    const pt = unit === 'pt' ? value : unit === 'in' ? value * 72 : unit === 'cm' ? (value * 72) / 2.54 : unit === 'mm' ? (value * 72) / 25.4 : value * 0.75;
    return Math.round(pt * 12_700);
  };
  const width = length('width');
  const height = length('height');
  if (!width || !height) return undefined;
  const id = imageData?.attrs['r:id'];
  const rel = id ? context.rels.get(id) : undefined;
  if (rel && !rel.external) return { width, height, part: rel.target };
  context.unsupported.vml = (context.unsupported.vml ?? 0) + 1;
  return { width, height, placeholder: descendant(node, 'v:textbox') ? 'Text box' : 'Shape' };
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

function parseTable(node: XmlElement, context: ParseContext): Table {
  const { theme } = context;
  const tblPr = child(node, 'w:tblPr');
  const styleId = val(tblPr, 'w:tblStyle');
  const style = context.styles.table(styleId);
  const tableContext: TableContext = { pPr: style?.pPr ?? {}, rPr: style?.rPr ?? {} };

  const grid = children(child(node, 'w:tblGrid'), 'w:gridCol').map((col) => intAttr(col, 'w:w') ?? 0);
  const borders: Table['borders'] = {};
  for (const source of [child(style?.tblPr, 'w:tblBorders'), child(tblPr, 'w:tblBorders')]) {
    for (const side of ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'] as const) {
      const alias = side === 'left' ? 'start' : side === 'right' ? 'end' : undefined;
      const border = parseBorder(child(source, `w:${side}`) ?? (alias ? child(source, `w:${alias}`) : undefined), theme);
      if (border !== undefined) borders[side] = border;
    }
  }
  const cellMargins = { top: 0, bottom: 0, left: 108, right: 108 };
  for (const source of [child(style?.tblPr, 'w:tblCellMar'), child(tblPr, 'w:tblCellMar')]) {
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const alias = side === 'left' ? 'start' : side === 'right' ? 'end' : undefined;
      const value = intAttr(child(source, `w:${side}`) ?? (alias ? child(source, `w:${alias}`) : undefined), 'w:w');
      if (value !== undefined) cellMargins[side] = value;
    }
  }
  const jc = val(tblPr, 'w:jc') ?? val(style?.tblPr, 'w:jc');
  const widthElement = child(tblPr, 'w:tblW');
  const widthType = widthElement?.attrs['w:type'];
  const width = widthType === 'dxa' ? intAttr(widthElement, 'w:w') : undefined;

  const rows: TableRow[] = [];
  for (const rowElement of children(node, 'w:tr').concat(...children(node, 'w:sdt').map((sdt) => children(child(sdt, 'w:sdtContent'), 'w:tr')))) {
    const trPr = child(rowElement, 'w:trPr');
    const heightElement = child(trPr, 'w:trHeight');
    const rule = heightElement?.attrs['w:hRule'];
    const cells: TableCell[] = [];
    const cellElements = children(rowElement).flatMap((item) =>
      item.name === 'w:tc' ? [item] : item.name === 'w:sdt' || item.name === 'w:customXml' ? children(child(item, 'w:sdtContent') ?? item, 'w:tc') : [],
    );
    // Cells skipped at the start of a row (w:gridBefore) are modelled as empty, borderless cells.
    const gridBefore = intAttr(child(trPr, 'w:gridBefore'), 'w:val') ?? 0;
    if (gridBefore > 0) cells.push({ props: { gridSpan: gridBefore, borders: { top: null, bottom: null, left: null, right: null }, margins: {}, vAlign: 'top' }, blocks: [] });
    for (const cellElement of cellElements) {
      const tcPr = child(cellElement, 'w:tcPr');
      const cellBorders: CellProps['borders'] = {};
      const tcBorders = child(tcPr, 'w:tcBorders');
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const alias = side === 'left' ? 'start' : side === 'right' ? 'end' : undefined;
        const border = parseBorder(child(tcBorders, `w:${side}`) ?? (alias ? child(tcBorders, `w:${alias}`) : undefined), theme);
        if (border !== undefined) cellBorders[side] = border;
      }
      const margins: CellProps['margins'] = {};
      const tcMar = child(tcPr, 'w:tcMar');
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const alias = side === 'left' ? 'start' : side === 'right' ? 'end' : undefined;
        const value = intAttr(child(tcMar, `w:${side}`) ?? (alias ? child(tcMar, `w:${alias}`) : undefined), 'w:w');
        if (value !== undefined) margins[side] = value;
      }
      const vMergeElement = child(tcPr, 'w:vMerge');
      const vAlign = val(tcPr, 'w:vAlign');
      const cellWidth = child(tcPr, 'w:tcW');
      cells.push({
        props: {
          gridSpan: intAttr(child(tcPr, 'w:gridSpan'), 'w:val') ?? 1,
          vMerge: vMergeElement ? (vMergeElement.attrs['w:val'] === 'restart' ? 'restart' : 'continue') : undefined,
          width: cellWidth?.attrs['w:type'] === 'dxa' ? intAttr(cellWidth, 'w:w') : undefined,
          shading: shadingFill(child(tcPr, 'w:shd'), theme),
          borders: cellBorders,
          margins,
          vAlign: vAlign === 'center' ? 'center' : vAlign === 'bottom' ? 'bottom' : 'top',
        },
        blocks: parseBlocks(cellElement, context, tableContext, false),
      });
    }
    rows.push({
      height: intAttr(heightElement, 'w:val'),
      heightRule: rule === 'exact' ? 'exact' : heightElement ? 'atLeast' : 'auto',
      cantSplit: onOff(trPr, 'w:cantSplit') ?? false,
      header: onOff(trPr, 'w:tblHeader') ?? false,
      cells,
    });
  }

  const indent = intAttr(child(tblPr, 'w:tblInd'), 'w:w') ?? intAttr(child(style?.tblPr, 'w:tblInd'), 'w:w') ?? 0;
  const fixedLayout = (child(tblPr, 'w:tblLayout') ?? child(style?.tblPr, 'w:tblLayout'))?.attrs['w:type'] === 'fixed';
  const baseGrid = grid.length > 0 ? grid : inferGrid(rows);
  return {
    kind: 'tbl',
    grid: fixedLayout ? baseGrid : preferredGrid(baseGrid, rows),
    fixedLayout,
    rows,
    align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left',
    indent,
    borders,
    cellMargins,
    width,
  };
}

/**
 * Column widths for an auto-fit table.
 *
 * `w:tblGrid` is only what the last application to lay the table out
 * computed, and files written by other tools often leave it stale. Word
 * re-derives auto-fit columns from the cells' preferred widths (`w:tcW`),
 * so when cells state widths for every column, those win.
 */
function preferredGrid(grid: number[], rows: TableRow[]): number[] {
  const widths: Array<number | undefined> = new Array(grid.length).fill(undefined);
  for (const row of rows) {
    let col = 0;
    for (const cell of row.cells) {
      const span = Math.max(1, cell.props.gridSpan);
      if (span === 1 && col < widths.length && widths[col] === undefined && cell.props.width && cell.props.width > 0) {
        widths[col] = cell.props.width;
      }
      col += span;
    }
    if (widths.every((width) => width !== undefined)) break;
  }
  if (widths.some((width) => width === undefined)) return grid;
  return widths as number[];
}

function inferGrid(rows: TableRow[]): number[] {
  const columns = Math.max(1, ...rows.map((row) => row.cells.reduce((sum, cell) => sum + cell.props.gridSpan, 0)));
  return Array.from({ length: columns }, () => Math.round(9000 / columns));
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

export function parseSection(node: XmlElement | undefined): SectionProps {
  const pgSz = child(node, 'w:pgSz');
  const pgMar = child(node, 'w:pgMar');
  const cols = child(node, 'w:cols');
  const refs = (name: string): HeaderFooterRefs => {
    const out: HeaderFooterRefs = {};
    for (const ref of children(node, name)) {
      const type = ref.attrs['w:type'] ?? 'default';
      const id = ref.attrs['r:id'];
      if (id && (type === 'default' || type === 'first' || type === 'even')) out[type] = id;
    }
    return out;
  };
  const type = val(node, 'w:type');
  const numberType = child(node, 'w:pgNumType');
  const columnWidths = children(cols, 'w:col').map((col) => ({ width: intAttr(col, 'w:w') ?? 0, space: intAttr(col, 'w:space') ?? 0 }));
  const equalWidth = cols?.attrs['w:equalWidth'];
  const vAlign = val(node, 'w:vAlign');
  return {
    pageWidth: intAttr(pgSz, 'w:w') ?? 12240,
    pageHeight: intAttr(pgSz, 'w:h') ?? 15840,
    margins: {
      top: intAttr(pgMar, 'w:top') ?? 1440,
      right: intAttr(pgMar, 'w:right') ?? 1440,
      bottom: intAttr(pgMar, 'w:bottom') ?? 1440,
      left: intAttr(pgMar, 'w:left') ?? 1440,
      header: intAttr(pgMar, 'w:header') ?? 720,
      footer: intAttr(pgMar, 'w:footer') ?? 720,
      gutter: intAttr(pgMar, 'w:gutter') ?? 0,
    },
    columns: {
      count: Math.max(1, intAttr(cols, 'w:num') ?? (columnWidths.length || 1)),
      space: intAttr(cols, 'w:space') ?? 720,
      widths: equalWidth === '0' || equalWidth === 'false' ? columnWidths : undefined,
      separator: cols?.attrs['w:sep'] === '1' || cols?.attrs['w:sep'] === 'true',
    },
    type: type === 'continuous' || type === 'evenPage' || type === 'oddPage' || type === 'nextColumn' ? type : 'nextPage',
    titlePage: onOff(node, 'w:titlePg') ?? false,
    headers: refs('w:headerReference'),
    footers: refs('w:footerReference'),
    pageNumbers: { format: numberType?.attrs['w:fmt'] ?? 'decimal', start: intAttr(numberType, 'w:start') },
    vAlign: vAlign === 'center' || vAlign === 'both' || vAlign === 'bottom' ? vAlign : 'top',
  };
}

export type { BorderSpec };
