/**
 * @vitest-environment jsdom
 *
 * jsdom for the same reason as the SVG sanitiser tests: these feed hostile
 * markup through the sanitiser, and happy-dom would execute it.
 */
import { describe, expect, it } from 'vitest';
import { classifyCfb, readDirectoryNames } from '../src/detect/cfb.js';
import {
  CHUNK_TARGET,
  applyNumberingCounters,
  buildItems,
  collectAnchors,
  collectOutline,
  cssLengthToPx,
  extractText,
  foldText,
  headingClasses,
  rangeFor,
  rowGroups,
  splitPage,
  type DocxItem,
} from '../src/renderers/docx/layout.js';
import { sanitizeDocxCss, sanitizeDocxTree, withFontFallback } from '../src/renderers/docx/sanitize.js';
import { readZipEntries } from '../src/renderers/docx/zip-entries.js';

const CLS = 'lgdocx1';

/** A page shaped like docx-preview's output. */
function page(opts: { paragraphs?: string[]; header?: string; footer?: string; width?: string; height?: string } = {}) {
  const section = document.createElement('section');
  section.className = CLS;
  section.style.width = opts.width ?? '612pt';
  section.style.minHeight = opts.height ?? '792pt';
  section.style.paddingTop = '72pt';
  section.style.paddingBottom = '72pt';
  if (opts.header !== undefined) {
    const header = document.createElement('header');
    header.innerHTML = `<p>${opts.header}</p>`;
    section.append(header);
  }
  const article = document.createElement('article');
  for (const text of opts.paragraphs ?? []) {
    const p = document.createElement('p');
    p.textContent = text;
    article.append(p);
  }
  section.append(article);
  if (opts.footer !== undefined) {
    const footer = document.createElement('footer');
    footer.innerHTML = `<p>${opts.footer}</p>`;
    section.append(footer);
  }
  return section;
}

const numbered = (count: number, prefix = 'Para') => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);

describe('page splitting', () => {
  it('leaves a page Word paginated intact', () => {
    const section = page({ paragraphs: numbered(40) });
    const pieces = splitPage(section);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.node).toBe(section);
    expect(pieces[0]!.part).toBe('whole');
  });

  it('cuts an unpaginated run into page-sized pieces without losing or reordering blocks', () => {
    const section = page({ paragraphs: numbered(1000), header: 'HEAD', footer: 'FOOT' });
    const pieces = splitPage(section);
    expect(pieces.length).toBeGreaterThan(1000 / CHUNK_TARGET - 2);
    expect(pieces.map((piece) => piece.part)).toEqual([
      'first',
      ...Array.from({ length: pieces.length - 2 }, () => 'middle'),
      'last',
    ]);

    const texts = pieces.flatMap((piece) => Array.from(piece.node.querySelectorAll('article > p'), (p) => p.textContent));
    expect(texts).toEqual(numbered(1000));

    // Header on the first piece only, footer on the last only.
    expect(pieces[0]!.node.querySelector('header')?.textContent).toBe('HEAD');
    expect(pieces.slice(1).some((piece) => piece.node.querySelector('header'))).toBe(false);
    expect(pieces[pieces.length - 1]!.node.querySelector('footer')?.textContent).toBe('FOOT');

    // Pieces keep the page's width and class, but not its height, and only
    // the outer edges keep the page margins.
    const [firstPiece, middlePiece] = pieces;
    expect(firstPiece!.node.className).toBe(CLS);
    expect(firstPiece!.node.style.width).toBe('612pt');
    expect(firstPiece!.node.style.minHeight).toBe('');
    expect(firstPiece!.node.style.paddingTop).toBe('72pt');
    expect(firstPiece!.node.style.paddingBottom).toBe('0px');
    expect(middlePiece!.node.style.paddingTop).toBe('0px');
  });

  it('splits long tables between rows, repeating the column widths, never inside a row span', () => {
    const section = page();
    const article = section.querySelector('article')!;
    const table = document.createElement('table');
    const colgroup = document.createElement('colgroup');
    colgroup.innerHTML = '<col style="width: 100pt"><col style="width: 200pt">';
    table.append(colgroup);
    for (let r = 0; r < 600; r++) {
      const row = document.createElement('tr');
      if (r % 100 === 50) {
        // A cell spanning this row and the next three.
        row.innerHTML = `<td rowspan="4">span ${r}</td><td>row ${r}</td>`;
      } else if (r % 100 > 50 && r % 100 <= 53) {
        row.innerHTML = `<td>row ${r}</td>`;
      } else {
        row.innerHTML = `<td>a ${r}</td><td>row ${r}</td>`;
      }
      table.append(row);
    }
    article.append(table);

    const groups = rowGroups(table);
    const spanGroup = groups.find((group) => group.rows[0]!.textContent!.startsWith('span 50'));
    expect(spanGroup?.rows).toHaveLength(4);

    const pieces = splitPage(section);
    expect(pieces.length).toBeGreaterThan(3);
    const tables = pieces.map((piece) => piece.node.querySelector('table')!);
    for (const piece of tables) {
      expect(piece.querySelector('colgroup')?.children).toHaveLength(2);
    }
    // Every row accounted for, in order.
    const rows = tables.flatMap((piece) => Array.from(piece.rows, (row) => row.lastElementChild!.textContent));
    expect(rows).toEqual(Array.from({ length: 600 }, (_, r) => `row ${r}`));
    // A span and the rows it covers are in the same piece.
    for (const piece of tables) {
      const spanning = Array.from(piece.querySelectorAll('td[rowspan]')) as HTMLTableCellElement[];
      for (const cell of spanning) {
        const row = cell.parentElement as HTMLTableRowElement;
        expect(piece.rows.length - row.sectionRowIndex).toBeGreaterThanOrEqual(cell.rowSpan);
      }
    }
  });

  it('estimates item sizes from the page box', () => {
    expect(cssLengthToPx('612pt')).toBe(816);
    expect(cssLengthToPx('8.5in')).toBe(816);
    expect(cssLengthToPx('21cm')).toBeCloseTo(793.7, 1);
    expect(cssLengthToPx('auto')).toBeUndefined();
    const [item] = buildItems([page({ paragraphs: ['x'] })]);
    expect(item).toMatchObject({ width: 816, height: 1056, part: 'whole' });
  });
});

describe('list numbering across detached pages', () => {
  const levels = [
    { id: '1', level: 0, start: 1, levelText: '%1.' },
    { id: '1', level: 1, start: 1, levelText: '%1.%2.' },
    { id: '2', level: 0, start: 1, bullet: { src: 'x' } },
  ];

  function listItem(level: number) {
    const p = document.createElement('p');
    p.className = `${CLS}_listparagraph ${CLS}-num-1-${level}`;
    p.textContent = `item at ${level}`;
    return p;
  }

  function item(...paragraphs: HTMLElement[]): DocxItem {
    const node = page();
    node.querySelector('article')!.append(...paragraphs);
    return { node, part: 'whole', width: 816, height: 1056 };
  }

  it('starts each page with the counter values the full document would have reached', () => {
    const items = [
      item(listItem(0), listItem(0), listItem(1)),
      item(listItem(1), listItem(0)),
      item(listItem(1)),
    ];
    applyNumberingCounters(items, CLS, levels);
    const resets = items.map((entry) => entry.node.style.getPropertyValue('counter-reset'));
    // Item 1 starts fresh. Item 2 starts after 1., 2., 2.1. Item 3 starts
    // after 2.2. and 3. — which reset the sub-level.
    expect(resets[0]).toBe(`${CLS}-num-1-0 0 ${CLS}-num-1-1 0`);
    expect(resets[1]).toBe(`${CLS}-num-1-0 2 ${CLS}-num-1-1 1`);
    expect(resets[2]).toBe(`${CLS}-num-1-0 3 ${CLS}-num-1-1 0`);
  });

  it('leaves documents without numbered lists alone', () => {
    const items = [item(document.createElement('p'))];
    applyNumberingCounters(items, CLS, levels);
    expect(items[0]!.node.style.getPropertyValue('counter-reset')).toBe('');
  });
});

describe('text index', () => {
  it('joins runs within a paragraph, separates paragraphs, and skips headers and footers', () => {
    const section = page({ header: 'Running head', footer: 'Page 1' });
    const article = section.querySelector('article')!;
    article.innerHTML = '<p><span>Hel</span><span>lo</span> world</p><p>Second</p><table><tr><td>A</td><td>B</td></tr></table>';
    const map = extractText(section);
    expect(map.text).toBe('Hello world\nSecond\nA\nB');

    // A match spanning two runs maps back to a range across both spans.
    const range = rangeFor(map, 0, 5)!;
    expect(range.toString()).toBe('Hello');
    expect(range.startContainer.textContent).toBe('Hel');
    expect(range.endContainer.textContent).toBe('lo');
    expect(rangeFor(map, 12, 18)!.toString()).toBe('Second');
  });

  it('folds case without changing length', () => {
    const text = 'İstanbul ÉCOLE Straße';
    const folded = foldText(text);
    expect(folded).toHaveLength(text.length);
    expect(folded).toContain('école straße');
  });
});

describe('outline and anchors', () => {
  it('builds a nested outline from heading styles and outline levels', () => {
    const styles = [
      { id: 'Heading1', name: 'heading 1', target: 'p' },
      { id: 'Heading2', name: 'heading 2', target: 'p' },
      { id: 'Chapter', name: 'Chapter', target: 'p', paragraphProps: { outlineLevel: 0 } },
      { id: 'Title', name: 'Title', target: 'p' },
      { id: 'Strong', name: 'Strong', target: 'span', paragraphProps: { outlineLevel: 0 } },
    ];
    const headings = headingClasses(styles, CLS);
    expect(headings.get(`${CLS}_heading1`)).toBe(0);
    expect(headings.get(`${CLS}_heading2`)).toBe(1);
    expect(headings.get(`${CLS}_chapter`)).toBe(0);
    expect(headings.has(`${CLS}_title`)).toBe(false);
    expect(headings.has(`${CLS}_strong`)).toBe(false);

    const make = (html: string): DocxItem => {
      const node = page();
      node.querySelector('article')!.innerHTML = html;
      return { node, part: 'whole', width: 816, height: 1056 };
    };
    const items = [
      make(`<p class="${CLS}_heading1">Intro</p><p class="${CLS}_heading2">Scope</p>`),
      make(`<p class="${CLS}_heading2">Terms <span id="_Toc1"></span></p><p class="${CLS}_chapter">Part two</p>`),
    ];
    const outline = collectOutline(items, headings);
    expect(outline.map((node) => node.title)).toEqual(['Intro', 'Part two']);
    expect(outline[0]!.children?.map((node) => [node.title, node.page])).toEqual([
      ['Scope', 1],
      ['Terms', 2],
    ]);
    expect(outline[1]!.page).toBe(2);
    expect(collectAnchors(items).get('_Toc1')).toBe(1);
  });
});

describe('sanitising rendered pages', () => {
  it('neutralises script links, remote images and embedded frames', () => {
    const section = page();
    section.querySelector('article')!.innerHTML = `
      <p><a href="javascript:alert(1)">bad</a><a href="">empty</a><a href="https://example.com/x">ok</a><a href="#_Toc1">toc</a></p>
      <p><img src="https://tracker.example/p.png"><img src="blob:http://localhost/abc"><img src="x" onerror="alert(1)"></p>
      <iframe srcdoc="<script>alert(1)</script>"></iframe>
      <p style="background-image: url(http://evil.example/bg.png); font-family: Calibri">styled</p>`;
    const report = { blockedRemote: 0 };
    sanitizeDocxTree([section], report);

    const links = Array.from(section.querySelectorAll('a'));
    expect(links[0]!.hasAttribute('href')).toBe(false);
    expect(links[1]!.hasAttribute('href')).toBe(false);
    expect(links[2]!.getAttribute('target')).toBe('_blank');
    expect(links[2]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[3]!.getAttribute('href')).toBe('#_Toc1');

    const images = Array.from(section.querySelectorAll('img'));
    expect(images[0]!.hasAttribute('src')).toBe(false);
    expect(images[1]!.getAttribute('src')).toBe('blob:http://localhost/abc');
    expect(images[2]!.hasAttribute('onerror')).toBe(false);
    expect(section.querySelector('iframe')).toBeNull();

    const styled = Array.from(section.querySelectorAll('p')).find((p) => p.textContent === 'styled')!;
    expect(styled.getAttribute('style') ?? '').not.toContain('evil');
    expect(report.blockedRemote).toBeGreaterThanOrEqual(2);
  });

  it('rebuilds the stylesheet from parsed rules, dropping remote loads and host selectors', () => {
    const report = { blockedRemote: 0 };
    const css = sanitizeDocxCss(
      [
        '@import url(http://evil.example/x.css);',
        `.${CLS} p { font-family: Calibri; color: red; }`,
        `.${CLS} span { background: url(http://evil.example/bg.png); }`,
        ':host { position: fixed; inset: 0; }',
        `.${CLS}-wrapper { --${CLS}-bullet: url("blob:http://localhost/b1"); }`,
      ].join('\n'),
      report,
      // jsdom leaves CSS unparsed in inert documents; browsers parse it.
      document,
    );
    expect(css).not.toMatch(/evil|@import|:host/);
    expect(css).toContain('color: red');
    expect(css).toContain('blob:http://localhost/b1');
    expect(css).toMatch(/Calibri, Carlito/);
    expect(report.blockedRemote).toBeGreaterThanOrEqual(2);
  });

  it('adds generic fallbacks to Office fonts', () => {
    expect(withFontFallback('Calibri')).toBe('Calibri, Carlito, "Segoe UI", Arial, sans-serif');
    expect(withFontFallback("'Times New Roman'")).toContain('serif');
    expect(withFontFallback('Georgia, serif')).toBe('Georgia, serif');
    expect(withFontFallback('Wingdings')).toBe('Wingdings');
    expect(withFontFallback('Some Brand Font')).toBe('Some Brand Font, sans-serif');
  });
});

/* ------------------------------------------------------------------ *
 * Package guards
 * ------------------------------------------------------------------ */

/** A stored (uncompressed) ZIP with the given entries, CRCs left at zero. */
function zip(entries: Array<{ name: string; size: number; declared?: number }>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.length + entry.size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, entry.size, true);
    lv.setUint32(22, entry.size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, entry.size, true);
    cv.setUint32(24, entry.declared ?? entry.size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directorySize + 22);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

describe('zip directory', () => {
  it('reads entry names and declared sizes without inflating', () => {
    const entries = readZipEntries(zip([
      { name: '[Content_Types].xml', size: 10 },
      { name: 'word/document.xml', size: 20, declared: 3_000_000_000 },
    ]));
    expect(entries?.map((entry) => entry.name)).toEqual(['[Content_Types].xml', 'word/document.xml']);
    expect(entries?.[1]?.uncompressedSize).toBe(3_000_000_000);
  });

  it('returns undefined for bytes that are not a ZIP', () => {
    expect(readZipEntries(new Uint8Array(100))).toBeUndefined();
  });
});

/** A version 3 compound file whose first directory sector names these streams. */
function cfb(names: string[]): Uint8Array {
  const bytes = new Uint8Array(512 * 3);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(0x1e, 9, true);
  view.setUint32(0x30, 0, true);
  ['Root Entry', ...names].forEach((name, index) => {
    const base = 512 + index * 128;
    for (let i = 0; i < name.length; i++) view.setUint16(base + i * 2, name.charCodeAt(i), true);
    view.setUint16(base + 0x40, (name.length + 1) * 2, true);
    bytes[base + 0x42] = index === 0 ? 5 : 2;
  });
  return bytes;
}

describe('compound file detection', () => {
  it('reads stream names from the directory', () => {
    const names = readDirectoryNames(cfb(['EncryptionInfo', 'EncryptedPackage']).subarray(512, 1024));
    expect(names).toEqual(['Root Entry', 'EncryptionInfo', 'EncryptedPackage']);
    expect(classifyCfb(names)).toBe('encrypted');
    expect(classifyCfb(['Root Entry', 'WordDocument', '1Table'])).toBe('doc');
    expect(classifyCfb(['Root Entry', 'Workbook'])).toBe('xls');
    expect(classifyCfb(['Root Entry', 'PowerPoint Document'])).toBe('ppt');
  });
});
