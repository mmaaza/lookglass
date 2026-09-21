'use client';

import type { OutlineNode } from '../../types.js';

/**
 * Turns docx-preview's output into items a virtual list can mount one at a
 * time.
 *
 * docx-preview renders a whole document at once into a single container,
 * with one `<section>` per page. A large document is hundreds of thousands
 * of elements, and browsers slow down badly with that many in the live DOM.
 * Here the page sections are kept *detached* and only the visible ones are
 * moved into the document, so layout and style work covers what is on
 * screen.
 *
 * Detaching pages breaks two things that assumed a single live tree, and
 * both are repaired here:
 *
 *  - Word only records page breaks when Word itself saved the file. Files
 *    written by other tools render as one enormous "page", which would defeat
 *    virtualisation, so long pages are cut into chunks at block boundaries
 *    (and between table rows, never inside a row span).
 *  - List numbering is done with CSS counters, which count only elements in
 *    the live tree. Each item gets a `counter-reset` holding the values the
 *    counters would have reached at that point in the full document.
 */

export type ItemPart = 'whole' | 'first' | 'middle' | 'last';

export interface DocxItem {
  /** Detached page (or piece of a page), moved into the view when visible. */
  node: HTMLElement;
  part: ItemPart;
  /** At 100% zoom, in CSS pixels. `height` is an estimate until measured. */
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Page splitting
 * ------------------------------------------------------------------ */

/**
 * Pages heavier than this are split. Weight is roughly "lines of text", and
 * a page Word paginated stays well below it, so real pages are left intact.
 */
export const SPLIT_ABOVE = 160;
/** Target weight of one chunk: about a printed page of body text. */
export const CHUNK_TARGET = 48;
const CHARS_PER_UNIT = 350;
const MEDIA_UNITS = 8;
const DEFAULT_PAGE = { width: 816, height: 1056 };

export function buildItems(pages: HTMLElement[]): DocxItem[] {
  const items: DocxItem[] = [];
  for (const page of pages) {
    const width = cssLengthToPx(page.style.width) ?? DEFAULT_PAGE.width;
    const height = cssLengthToPx(page.style.minHeight) ?? DEFAULT_PAGE.height;
    for (const piece of splitPage(page)) {
      items.push({
        node: piece.node,
        part: piece.part,
        width,
        height: piece.part === 'whole' ? height : Math.max(160, Math.min(height * 1.5, piece.weight * 22)),
      });
    }
  }
  return items;
}

interface Unit {
  article: HTMLElement;
  weight: number;
  block?: Element;
  table?: HTMLTableElement;
  rows?: HTMLTableRowElement[];
}

export function splitPage(section: HTMLElement): Array<{ node: HTMLElement; part: ItemPart; weight: number }> {
  const children = Array.from(section.children) as HTMLElement[];
  const firstArticle = children.findIndex((child) => child.tagName === 'ARTICLE');
  if (firstArticle < 0) return [{ node: section, part: 'whole', weight: 0 }];
  let lastArticle = firstArticle;
  children.forEach((child, index) => {
    if (child.tagName === 'ARTICLE') lastArticle = index;
  });

  const units: Unit[] = [];
  let total = 0;
  for (const article of children.slice(firstArticle, lastArticle + 1)) {
    if (article.tagName !== 'ARTICLE') continue;
    for (const block of Array.from(article.children)) {
      if (block.tagName === 'TABLE') {
        const table = block as HTMLTableElement;
        const groups = rowGroups(table);
        const weight = groups.reduce((sum, group) => sum + group.weight, 0);
        if (weight > CHUNK_TARGET && groups.length > 1) {
          for (const group of groups) units.push({ article, table, rows: group.rows, weight: group.weight });
        } else {
          units.push({ article, block, weight });
        }
        total += weight;
      } else {
        const weight = weightOf(block);
        units.push({ article, block, weight });
        total += weight;
      }
    }
  }

  if (total <= SPLIT_ABOVE) return [{ node: section, part: 'whole', weight: total }];

  // Pack units into chunks of about CHUNK_TARGET.
  const chunks: Unit[][] = [[]];
  let weight = 0;
  for (const unit of units) {
    const current = chunks[chunks.length - 1]!;
    if (current.length > 0 && weight + unit.weight > CHUNK_TARGET) {
      chunks.push([unit]);
      weight = unit.weight;
    } else {
      current.push(unit);
      weight += unit.weight;
    }
  }

  const before = children.slice(0, firstArticle);
  const after = children.slice(lastArticle + 1);
  const last = chunks.length - 1;

  return chunks.map((chunk, index) => {
    const shell = section.cloneNode(false) as HTMLElement;
    // Only whole pages keep the paper height; pieces are as tall as their content.
    shell.style.minHeight = '';
    if (index > 0) shell.style.paddingTop = '0';
    if (index < last) shell.style.paddingBottom = '0';
    if (index === 0) shell.append(...before);

    let sourceArticle: HTMLElement | undefined;
    let article: HTMLElement | undefined;
    let sourceTable: HTMLTableElement | undefined;
    let tableShell: TableShell | undefined;
    for (const unit of chunk) {
      if (unit.article !== sourceArticle) {
        sourceArticle = unit.article;
        article = unit.article.cloneNode(false) as HTMLElement;
        shell.append(article);
        sourceTable = undefined;
      }
      if (unit.block) {
        article!.append(unit.block);
        sourceTable = undefined;
      } else if (unit.table && unit.rows) {
        if (unit.table !== sourceTable) {
          sourceTable = unit.table;
          tableShell = createTableShell(unit.table);
          article!.append(tableShell.table);
        }
        for (const row of unit.rows) tableShell!.append(row);
      }
    }

    if (index === last) shell.append(...after);
    const part: ItemPart = index === 0 ? 'first' : index === last ? 'last' : 'middle';
    return { node: shell, part, weight: chunk.reduce((sum, unit) => sum + unit.weight, 0) };
  });
}

function weightOf(element: Element): number {
  const text = element.textContent?.length ?? 0;
  const media = element.getElementsByTagName('img').length + element.getElementsByTagName('svg').length;
  return 1 + Math.floor(text / CHARS_PER_UNIT) + media * MEDIA_UNITS;
}

/**
 * Split a table's rows into groups that can be moved independently: a group
 * never ends inside a vertical merge, so a cell spanning rows stays whole.
 */
export function rowGroups(table: HTMLTableElement): Array<{ rows: HTMLTableRowElement[]; weight: number }> {
  const groups: Array<{ rows: HTMLTableRowElement[]; weight: number }> = [];
  const rows = Array.from(table.rows);
  let current: HTMLTableRowElement[] = [];
  let weight = 0;
  let reach = -1;
  rows.forEach((row, index) => {
    current.push(row);
    weight += weightOf(row);
    for (const cell of Array.from(row.cells)) reach = Math.max(reach, index + Math.max(1, cell.rowSpan) - 1);
    if (reach <= index) {
      groups.push({ rows: current, weight });
      current = [];
      weight = 0;
    }
  });
  if (current.length > 0) groups.push({ rows: current, weight });
  return groups;
}

interface TableShell {
  table: HTMLTableElement;
  append(row: HTMLTableRowElement): void;
}

function createTableShell(source: HTMLTableElement): TableShell {
  const table = source.cloneNode(false) as HTMLTableElement;
  for (const child of Array.from(source.children)) {
    // Column widths must repeat in every piece or the columns would re-flow.
    if (child.tagName === 'COLGROUP') table.append(child.cloneNode(true));
  }
  const sections = new Map<Element, Element>();
  return {
    table,
    append(row) {
      const parent = row.parentElement;
      if (!parent || parent === source) {
        table.append(row);
        return;
      }
      let target = sections.get(parent);
      if (!target) {
        target = parent.cloneNode(false) as Element;
        sections.set(parent, target);
        table.append(target);
      }
      target.append(row);
    },
  };
}

const LENGTH_UNITS: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

export function cssLengthToPx(value: string | undefined): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(value ?? '');
  if (!match) return undefined;
  const px = Number(match[1]) * LENGTH_UNITS[(match[2] ?? 'px').toLowerCase()]!;
  return px > 0 ? px : undefined;
}

/* ------------------------------------------------------------------ *
 * List numbering
 * ------------------------------------------------------------------ */

/** One level of a Word list, as docx-preview's numbering part describes it. */
export interface NumberingLevel {
  id: string;
  level: number;
  start: number;
  levelText?: string;
  bullet?: unknown;
}

/**
 * Give every item the counter values it starts with.
 *
 * This replays the rules docx-preview writes into its numbering stylesheet:
 * a paragraph of level L increments that level's counter, and resets the
 * counter of level L+1 to its start value. Counters untouched by any
 * paragraph are left to the stylesheet's own reset.
 */
export function applyNumberingCounters(items: DocxItem[], className: string, levels: NumberingLevel[]): void {
  const rules = new Map<string, { increment?: string; set: Array<[string, number]> }>();
  const initial = new Map<string, number>();
  const rule = (name: string) => {
    let entry = rules.get(name);
    if (!entry) {
      entry = { set: [] };
      rules.set(name, entry);
    }
    return entry;
  };

  for (const level of levels) {
    if (level.bullet || !level.levelText) continue;
    const counter = `${className}-num-${level.id}-${level.level}`;
    // Names come from the document; anything that is not a plain identifier
    // produced a rule the browser dropped, so there is nothing to replay.
    if (!/^[\w-]+$/.test(counter)) continue;
    const start = Number.isFinite(level.start) ? level.start : 1;
    initial.set(counter, start - 1);
    rule(counter).increment = counter;
    if (level.level > 0) rule(`${className}-num-${level.id}-${level.level - 1}`).set.push([counter, start - 1]);
  }
  if (rules.size === 0) return;

  const events: Array<Array<{ increment?: string; set: Array<[string, number]> }>> = [];
  const touched = new Set<string>();
  for (const item of items) {
    const list: Array<{ increment?: string; set: Array<[string, number]> }> = [];
    for (const paragraph of Array.from(item.node.getElementsByTagName('p'))) {
      for (const name of Array.from(paragraph.classList)) {
        const entry = rules.get(name);
        if (!entry) continue;
        list.push(entry);
        if (entry.increment) touched.add(entry.increment);
        for (const [counter] of entry.set) touched.add(counter);
      }
    }
    events.push(list);
  }
  if (touched.size === 0) return;

  const values = new Map<string, number>();
  for (const counter of touched) values.set(counter, initial.get(counter) ?? 0);
  items.forEach((item, index) => {
    // Every touched counter is reset on every item, so an item's increments
    // can never leak into another mounted item through a shared instance.
    item.node.style.setProperty(
      'counter-reset',
      Array.from(values, ([counter, value]) => `${counter} ${value}`).join(' '),
    );
    for (const entry of events[index]!) {
      for (const [counter, value] of entry.set) values.set(counter, value);
      if (entry.increment) values.set(entry.increment, (values.get(entry.increment) ?? 0) + 1);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Text, search and outline
 * ------------------------------------------------------------------ */

export interface TextMap {
  text: string;
  nodes: Text[];
  starts: number[];
}

const BLOCK_TAGS = new Set(['P', 'TD', 'TH', 'TR', 'TABLE', 'LI', 'OL', 'UL', 'ARTICLE', 'SECTION', 'DIV', 'BR']);
const SKIP_TAGS = new Set(['HEADER', 'FOOTER', 'STYLE', 'SCRIPT']);

/**
 * The searchable text of an item, and where each character lives.
 *
 * Block boundaries become newlines so a match can never join the end of one
 * paragraph to the start of the next. Running headers and footers are left
 * out, as Word's own search does, or every page would match their text.
 */
export function extractText(root: Element): TextMap {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.nodeType === 3) {
      const data = (node as Text).data;
      if (data.length === 0) continue;
      nodes.push(node as Text);
      starts.push(text.length);
      text += data;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (SKIP_TAGS.has(element.tagName)) continue;
    if (BLOCK_TAGS.has(element.tagName) && text.length > 0 && !text.endsWith('\n')) text += '\n';
    for (let child = element.lastChild; child; child = child.previousSibling) stack.push(child);
  }
  return { text, nodes, starts };
}

/**
 * Lower-case without changing length, so offsets in the folded text are
 * offsets in the original. Non-breaking spaces fold to spaces: Word uses
 * them freely and nobody types them into a search box.
 */
export function foldText(value: string): string {
  let folded = value.toLowerCase();
  if (folded.length !== value.length) {
    folded = '';
    for (const char of value) {
      const lower = char.toLowerCase();
      folded += lower.length === char.length ? lower : char;
    }
  }
  return folded.replace(/ /g, ' ');
}

/** DOM range covering `[start, end)` of a text map. */
export function rangeFor(map: TextMap, start: number, end: number): Range | undefined {
  const from = locate(map, start, false);
  const to = locate(map, end, true);
  if (!from || !to) return undefined;
  const range = from.node.ownerDocument.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function locate(map: TextMap, offset: number, isEnd: boolean): { node: Text; offset: number } | undefined {
  const { starts, nodes } = map;
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found < 0) return undefined;
  let node = nodes[found]!;
  let local = offset - starts[found]!;
  // An end offset exactly at a node's start belongs to the previous node.
  if (isEnd && local === 0 && found > 0) {
    node = nodes[found - 1]!;
    local = node.data.length;
  }
  return { node, offset: Math.min(local, node.data.length) };
}

export interface HeadingStyle {
  id: string;
  name?: string;
  target?: string;
  cssName?: string;
  paragraphProps?: { outlineLevel?: number };
}

/** Class name of each paragraph style that is a heading, with its level. */
export function headingClasses(styles: HeadingStyle[], className: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const style of styles) {
    if (!style.id || (style.target && style.target !== 'p')) continue;
    let level = style.paragraphProps?.outlineLevel;
    if (level === undefined || level < 0 || level > 8) {
      const match = /^heading\s*([1-9])$/i.exec(style.name ?? '');
      level = match ? Number(match[1]) - 1 : undefined;
    }
    if (level === undefined) continue;
    result.set(style.cssName ?? `${className}_${escapeClassName(style.id)}`, level);
  }
  return result;
}

/** docx-preview's own class-name escaping, so computed names match its output. */
export function escapeClassName(name: string): string {
  return name.replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase();
}

const MAX_OUTLINE_ENTRIES = 10_000;

export function collectOutline(items: DocxItem[], headings: Map<string, number>): OutlineNode[] {
  if (headings.size === 0) return [];
  const roots: OutlineNode[] = [];
  const stack: Array<{ level: number; node: OutlineNode }> = [];
  let count = 0;
  items.forEach((item, index) => {
    if (count >= MAX_OUTLINE_ENTRIES) return;
    for (const paragraph of Array.from(item.node.getElementsByTagName('p'))) {
      let level: number | undefined;
      for (const name of Array.from(paragraph.classList)) {
        level = headings.get(name);
        if (level !== undefined) break;
      }
      if (level === undefined || paragraph.closest('header, footer')) continue;
      const title = (paragraph.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!title) continue;
      const node: OutlineNode = { id: `h${count}`, title, page: index + 1 };
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      const parent = stack[stack.length - 1]?.node;
      if (parent) (parent.children ??= []).push(node);
      else roots.push(node);
      stack.push({ level, node });
      if (++count >= MAX_OUTLINE_ENTRIES) return;
    }
  });
  return roots;
}

/** Item index of every element id, for internal links and bookmarks. */
export function collectAnchors(items: DocxItem[]): Map<string, number> {
  const anchors = new Map<string, number>();
  items.forEach((item, index) => {
    for (const element of Array.from(item.node.querySelectorAll('[id]'))) {
      if (!anchors.has(element.id)) anchors.set(element.id, index);
    }
  });
  return anchors;
}
