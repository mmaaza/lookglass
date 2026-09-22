/// <reference lib="webworker" />
import { ViewerError } from '../core/errors.js';
import { exposeRpc, type RpcContext } from '../core/rpc.js';
import type { PageDisplay, PageText } from '../ooxml/display.js';
import { FontResolver, createInstalledProbe, deobfuscateFont, parseFontMetrics } from '../ooxml/fonts.js';
import { OoxmlPackage } from '../ooxml/opc.js';
import { TextMeasurer } from '../ooxml/text.js';
import { DocxFontService, DocxLayout, type LayoutAccuracy } from '../formats/docx/layout/engine.js';
import type { WordDocument } from '../formats/docx/model.js';
import { parseWordDocument } from '../formats/docx/parse.js';
import { sourceFromDescriptor } from '../source/index.js';
import type { SourceDescriptor } from '../source/types.js';
import type { OutlineNode, SearchHit } from '../types.js';

/**
 * The Word layout worker.
 *
 * Parsing, font measurement and page layout all happen here: the main
 * thread only paints finished display lists. Layout runs in time slices so
 * pages can be requested (and shown) while later pages are still being laid
 * out, and so cancellation and page requests are answered promptly.
 */

const SLICE_MS = 24;
const SEARCH_HIT_LIMIT = 5000;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

interface State {
  pkg: OoxmlPackage;
  doc: WordDocument;
  layout: DocxLayout;
  waiters: Array<{ page: number; resolve: () => void; reject: (err: unknown) => void }>;
  failure?: unknown;
  texts: Map<number, PageText>;
}

let state: State | undefined;

export interface OpenDocxArgs {
  descriptor: SourceDescriptor;
  maxXmlBytes?: number;
}

export interface FontFaceData {
  family: string;
  weight: 'normal' | 'bold';
  style: 'normal' | 'italic';
  data: ArrayBuffer;
}

export interface OpenDocxResult {
  title?: string;
  author?: string;
  firstPage: { width: number; height: number };
  outline: OutlineNode[];
  fonts: FontFaceData[];
  substitutedFonts: string[];
  unsupported: Record<string, number>;
}

const handlers = {
  async open(args: OpenDocxArgs, ctx: RpcContext): Promise<OpenDocxResult> {
    const source = sourceFromDescriptor(args.descriptor);
    ctx.progress({ phase: 'parsing', message: 'Reading document' });
    const maxXmlBytes = args.maxXmlBytes ?? 128 * 1024 * 1024;
    const pkg = await OoxmlPackage.open(source, { signal: ctx.signal, limits: { maxXmlBytes } });
    if (pkg.xmlBytes() > maxXmlBytes * 2) {
      throw new ViewerError('too-large', 'This Word document has more text and markup than can be laid out in the browser.', {
        retryable: false,
        detail: { xmlBytes: pkg.xmlBytes() },
      });
    }
    const parsed = await parseWordDocument(pkg, ctx.signal);

    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    if (!context) throw new ViewerError('internal', 'Text measurement is not available in this browser.');
    const resolver = new FontResolver({ isInstalled: createInstalledProbe(context), fontTable: parsed.fontTable });

    // Embedded fonts: loaded here for measurement and returned for painting.
    const fonts: FontFaceData[] = [];
    for (const font of parsed.embeddedFonts) {
      try {
        const raw = await pkg.bytes(font.part, ctx.signal, 32 * 1024 * 1024);
        const bytes = font.key ? deobfuscateFont(raw, font.key) : raw;
        const face = new FontFace(font.family, bytes as Uint8Array<ArrayBuffer>, { weight: font.bold ? 'bold' : 'normal', style: font.italic ? 'italic' : 'normal' });
        await face.load();
        (self as unknown as { fonts: FontFaceSet }).fonts.add(face);
        resolver.addFace(font.family, parseFontMetrics(bytes));
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        fonts.push({ family: font.family, weight: font.bold ? 'bold' : 'normal', style: font.italic ? 'italic' : 'normal', data });
      } catch (err) {
        console.warn('[lookglass] embedded font could not be loaded', font.family, err);
      }
    }
    for (const font of fonts) ctx.transfer(font.data);

    const measurer = new TextMeasurer(context, { roundAdvances: true });
    const layout = new DocxLayout(parsed.document, new DocxFontService(resolver, measurer));
    state = { pkg, doc: parsed.document, layout, waiters: [], texts: new Map() };

    const firstSection = parsed.document.body.find((block) => block.section)?.section ?? parsed.document.finalSection;
    const usedFamilies = new Set<string>();
    const collect = (props: { fonts: Record<string, string | undefined> }) => {
      for (const [slot, name] of Object.entries(props.fonts)) if (slot !== 'hint' && name) usedFamilies.add(name);
    };
    for (const block of parsed.document.body.slice(0, 2000)) if (block.kind === 'p') for (const inline of block.inlines) if ('props' in inline) collect(inline.props);

    return {
      title: parsed.document.title,
      author: parsed.document.author,
      firstPage: { width: firstSection.pageWidth / 15, height: firstSection.pageHeight / 15 },
      outline: [],
      fonts,
      substitutedFonts: [...usedFamilies].filter((family) => resolver.resolve(family).substituted),
      unsupported: parsed.document.unsupported,
    };
  },

  /**
   * Lay out every page. Resolves when layout finishes; progress events carry
   * the page count as it grows, so the viewer can show pages meanwhile.
   */
  async layout(_args: undefined, ctx: RpcContext): Promise<{ pages: number; accuracy: LayoutAccuracy; outline: OutlineNode[] }> {
    const current = requireState();
    const generator = current.layout.run();
    let reported = 0;
    try {
      for (;;) {
        const sliceEnd = performance.now() + SLICE_MS;
        let finished = false;
        while (performance.now() < sliceEnd) {
          if (generator.next().done) {
            finished = true;
            break;
          }
        }
        const pages = current.layout.pages.length;
        if (pages !== reported) {
          reported = pages;
          ctx.progress({ phase: 'rendering', items: pages, message: `Laid out ${pages.toLocaleString()} pages` });
        }
        releaseWaiters(current, finished);
        if (finished) break;
        // Yield so page requests and cancellation are handled between slices.
        await new Promise((resolve) => setTimeout(resolve, 0));
        ctx.signal.throwIfAborted();
      }
    } catch (err) {
      current.failure = err;
      for (const waiter of current.waiters.splice(0)) waiter.reject(err);
      throw err;
    }
    return { pages: current.layout.pages.length, accuracy: current.layout.accuracy, outline: buildOutline(current) };
  },

  /** A page's display list. Waits for layout to reach it. */
  async page(args: { index: number }): Promise<PageDisplay> {
    const current = requireState();
    await pageReady(current, args.index);
    return current.layout.display(args.index);
  },

  /** An image or other part, for painting. */
  async part(args: { name: string }, ctx: RpcContext): Promise<{ bytes: ArrayBuffer; type: string }> {
    const current = requireState();
    const bytes = await current.pkg.bytes(args.name, ctx.signal, MAX_IMAGE_BYTES);
    const type = (await current.pkg.contentType(args.name, ctx.signal)) ?? guessType(args.name);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    ctx.transfer(buffer);
    return { bytes: buffer, type };
  },

  async search(args: { query: string }, ctx: RpcContext): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    const current = requireState();
    const needle = args.query.toLowerCase();
    const hits: SearchHit[] = [];
    await pageReady(current, Number.POSITIVE_INFINITY);
    for (let index = 0; index < current.layout.pages.length; index++) {
      if (index % 50 === 49) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        ctx.signal.throwIfAborted();
      }
      let text = current.texts.get(index);
      if (!text) {
        text = current.layout.text(index);
        current.texts.set(index, text);
      }
      const haystack = text.text.toLowerCase();
      for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
        const from = Math.max(0, at - 40);
        hits.push({
          id: `${index}:${at}:${needle.length}`,
          page: index + 1,
          excerpt: text.text.slice(from, at + needle.length + 40),
          excerptOffset: at - from,
          excerptLength: needle.length,
        });
        if (hits.length >= SEARCH_HIT_LIMIT) return { hits, truncated: true };
      }
    }
    return { hits, truncated: false };
  },

  /** Page (1-based) holding a bookmark, for internal links. */
  async bookmark(args: { name: string }): Promise<number | undefined> {
    const current = requireState();
    const block = current.doc.bookmarks.get(args.name);
    if (block === undefined) return undefined;
    await pageReady(current, Number.POSITIVE_INFINITY);
    const page = current.layout.blockPages[block];
    return page === undefined ? undefined : page + 1;
  },

  /** Pagination diagnostics: our page starts next to the breaks Word recorded. */
  async diagnostics(): Promise<{ ours: string[]; word: string[]; toc: Array<{ title: string; word: string; ours?: string }> }> {
    const current = requireState();
    await pageReady(current, Number.POSITIVE_INFINITY);
    const word: string[] = [];
    current.doc.body.forEach((block) => {
      if (block.kind !== 'p') return;
      const index = block.inlines.findIndex((inline) => inline.kind === 'renderedBreak');
      if (index < 0) return;
      word.push(
        block.inlines
          .slice(index)
          .map((inline) => (inline.kind === 'text' ? inline.text : inline.kind === 'tab' ? ' ' : ''))
          .join('')
          .trim()
          .slice(0, 50),
      );
    });
    // Table-of-contents entries carry the page numbers Word computed: ground truth for pagination.
    const toc: Array<{ title: string; word: string; ours?: string }> = [];
    for (const block of current.doc.body) {
      if (block.kind !== 'p') continue;
      const link = block.inlines.find((inline) => inline.kind === 'text' && inline.link?.startsWith('#_Toc'));
      if (!link || link.kind !== 'text') continue;
      const texts = block.inlines.filter((inline) => inline.kind === 'text').map((inline) => (inline.kind === 'text' ? inline.text : ''));
      const number = texts[texts.length - 1]!.trim();
      const title = texts.slice(0, -1).join('').trim();
      const page = current.layout.bookmarkPage(link.link!.slice(1));
      toc.push({ title: title.slice(0, 60), word: number, ours: page });
    }
    return { ours: [...current.layout.pageStarts], word, toc };
  },

  close(): void {
    state = undefined;
  },
};

export type DocxWorkerHandlers = typeof handlers;

function requireState(): State {
  if (!state) throw new ViewerError('internal', 'The document is not open.');
  return state;
}

function pageReady(current: State, index: number): Promise<void> {
  if (current.failure) return Promise.reject(current.failure);
  if (current.layout.done || index < current.layout.pages.length - 1) return Promise.resolve();
  return new Promise((resolve, reject) => current.waiters.push({ page: index, resolve, reject }));
}

function releaseWaiters(current: State, finished: boolean): void {
  // A page is final once a later page exists (or layout has finished).
  const complete = finished ? Number.POSITIVE_INFINITY : current.layout.pages.length - 1;
  current.waiters = current.waiters.filter((waiter) => {
    if (waiter.page < complete || finished) {
      waiter.resolve();
      return false;
    }
    return true;
  });
}

function buildOutline(current: State): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: Array<{ level: number; node: OutlineNode }> = [];
  current.doc.headings.forEach((heading, index) => {
    const page = current.layout.blockPages[heading.block];
    const node: OutlineNode = { id: `h${index}`, title: heading.text, page: page === undefined ? undefined : page + 1 };
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
    stack.push({ level: heading.level, node });
  });
  return roots;
}

function guessType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }[ext] ??
    'application/octet-stream'
  );
}

exposeRpc(handlers);
