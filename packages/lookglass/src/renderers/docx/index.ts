'use client';

import { parseAsync, renderDocument, type Options as DocxPreviewOptions } from 'docx-preview';
import { BaseController } from '../../core/controller.js';
import { ViewerError, abortError, isAbort } from '../../core/errors.js';
import type { OpenContext, OpenedDoc, RendererFactory } from '../../core/renderer.js';
import type { Capabilities, DocMeta, SearchHit } from '../../types.js';
import {
  applyNumberingCounters,
  buildItems,
  collectAnchors,
  collectOutline,
  extractText,
  foldText,
  headingClasses,
  type DocxItem,
  type HeadingStyle,
  type NumberingLevel,
} from './layout.js';
import { sanitizeDocxCss, sanitizeDocxTree, type SanitizeReport } from './sanitize.js';
import { createDocxSurface } from './surface.js';
import { readZipEntries } from './zip-entries.js';

const CAPABILITIES: Capabilities = {
  pages: true,
  search: true,
  zoom: true,
  rotate: false,
  textSelect: true,
  outline: true,
  thumbnails: false,
  sheets: false,
  // Pages are virtualised, so browser print would show only the few that
  // happen to be mounted.
  print: false,
};

export interface DocxRendererOptions {
  /** Whole-file ceiling. DOCX is a ZIP and cannot be range-read. Default 150 MB. */
  maxBytes?: number;
  /**
   * Ceiling on the inflated size of the package's XML parts, which are
   * parsed on the main thread. Default 128 MB, several thousand pages.
   */
  maxXmlBytes?: number;
  /** Render page headers and footers. Default true. */
  headersAndFooters?: boolean;
  /** Render footnotes and endnotes. Default true. */
  notes?: boolean;
  /** Show tracked insertions and deletions as marked-up changes. Default false. */
  trackedChanges?: boolean;
}

const DEFAULT_MAX_BYTES = 150 * 1024 * 1024;
const DEFAULT_MAX_XML_BYTES = 128 * 1024 * 1024;
/** Images and fonts are held as blobs; this bounds the whole inflated package. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const SEARCH_HIT_LIMIT = 5000;
const EXCERPT_CONTEXT = 40;

let documentCount = 0;

/**
 * Word documents, rendered with docx-preview.
 *
 * docx-preview needs the DOM (it parses XML with DOMParser and builds HTML),
 * so parsing and rendering run on the main thread; the size guards below
 * keep that bounded. Everything after rendering is designed for size: pages
 * are kept detached and mounted only while visible, and search runs over a
 * text index rather than the DOM.
 */
export const docxRenderer: RendererFactory = {
  id: 'lookglass/docx',
  kinds: ['docx'],

  async open(ctx: OpenContext): Promise<OpenedDoc> {
    const options = (ctx.options.rendererOptions?.['lookglass/docx'] ?? {}) as DocxRendererOptions;
    const { token, source } = ctx;

    ctx.onProgress({ phase: 'fetching', message: 'Reading document' });
    const bytes = await source.bytes({
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      signal: token.signal,
      onProgress: (done, total) =>
        ctx.onProgress({
          phase: 'fetching',
          bytesDone: done,
          bytesTotal: total,
          ratio: total > 0 ? done / total : undefined,
          message: 'Reading document',
        }),
    });
    token.throwIfAborted();
    checkPackage(bytes, options.maxXmlBytes ?? DEFAULT_MAX_XML_BYTES);

    const className = `lgdocx${++documentCount}`;
    const renderOptions: Partial<DocxPreviewOptions> = {
      className,
      // The wrapper is needed for its class: docx-preview scopes list
      // counters and bullet images to it. Its layout rules are overridden.
      inWrapper: true,
      breakPages: true,
      // Word records where it broke pages when it saved the file. Following
      // those markers is what makes pages match Word's.
      ignoreLastRenderedPageBreak: false,
      // Tab-stop layout measures live DOM, which these pages are not in.
      experimental: false,
      renderHeaders: options.headersAndFooters ?? true,
      renderFooters: options.headersAndFooters ?? true,
      renderFootnotes: options.notes ?? true,
      renderEndnotes: options.notes ?? true,
      renderChanges: options.trackedChanges ?? false,
      renderComments: false,
      // Embedded HTML chunks are rendered as iframes with no sandbox.
      renderAltChunks: false,
      useBase64URL: false,
      trimXmlDeclaration: true,
      debug: false,
    };

    ctx.onProgress({ phase: 'parsing', message: 'Reading Word document' });
    await nextTask();
    let wordDoc: WordDocumentModel;
    try {
      wordDoc = (await parseAsync(bytes, renderOptions)) as WordDocumentModel;
    } catch (err) {
      throw asDocxError(err);
    }
    token.throwIfAborted();

    ctx.onProgress({ phase: 'rendering', message: 'Laying out pages' });
    await nextTask();
    token.throwIfAborted();

    const blobUrls = new Set<string>();
    token.onDispose(() => {
      for (const url of blobUrls) URL.revokeObjectURL(url);
    });

    let nodes: Node[];
    try {
      nodes = await renderDocument(wordDoc, renderOptions);
    } catch (err) {
      throw asDocxError(err);
    }
    const styleText = nodes
      .filter((node) => node.nodeName === 'STYLE')
      .map((node) => node.textContent ?? '')
      .join('\n');
    const wrapper = nodes.find(
      (node): node is HTMLElement => node.nodeType === 1 && (node as Element).classList.contains(`${className}-wrapper`),
    );
    // Collected before anything can fail, so every object URL is revoked.
    for (const url of styleText.match(/blob:[^"')\s]+/g) ?? []) blobUrls.add(url);
    for (const element of Array.from(wrapper?.querySelectorAll('[src^="blob:"], [href^="blob:"]') ?? [])) {
      blobUrls.add(element.getAttribute('src') ?? element.getAttribute('href')!);
    }
    token.throwIfAborted();

    const pages = Array.from(wrapper?.children ?? []).filter((child): child is HTMLElement => child.tagName === 'SECTION');
    if (pages.length === 0) {
      throw new ViewerError('corrupt', 'This Word document has no readable content.', { retryable: false });
    }

    ctx.onProgress({ phase: 'indexing', message: `Preparing ${pages.length.toLocaleString()} pages` });
    await nextTask();
    token.throwIfAborted();

    const report: SanitizeReport = { blockedRemote: 0 };
    sanitizeDocxTree(pages, report);
    const css = sanitizeDocxCss(styleText, report);

    const items = buildItems(pages);
    applyNumberingCounters(items, className, (wordDoc.numberingPart?.domNumberings ?? []) as NumberingLevel[]);
    const outline = collectOutline(items, headingClasses((wordDoc.stylesPart?.styles ?? []) as HeadingStyle[], className));
    const anchors = collectAnchors(items);
    const estimated = items.some((item) => item.part !== 'whole');
    const props = wordDoc.corePropsPart?.props;

    const search = createSearch(items);
    const controller = new BaseController({
      pageCount: items.length,
      capabilities: CAPABILITIES,
      initialViewport: { fit: 'width' },
      runSearch: search,
    });

    const meta: DocMeta = {
      kind: 'docx',
      capabilities: CAPABILITIES,
      pageCount: items.length,
      pageLabel: 'page',
      title: props?.title?.trim() || source.name,
      author: props?.creator?.trim() || undefined,
      intrinsicSize: { width: items[0]!.width, height: items[0]!.height },
      extra: {
        pages: items.length,
        // "word" when the pages are the ones Word laid out; "estimated" when
        // the file carried no page breaks and long runs were cut into
        // page-sized pieces instead.
        pagination: estimated ? 'estimated' : 'word',
        bytes: bytes.byteLength,
        blockedRemote: report.blockedRemote,
      },
    };

    const Surface = createDocxSurface({ items, controller, className, css, anchors });

    return {
      meta,
      controller,
      Surface,
      outline: () => Promise.resolve(outline),
      dispose: () => {
        controller.dispose();
        for (const url of blobUrls) URL.revokeObjectURL(url);
        blobUrls.clear();
      },
    };
  },
};

export default docxRenderer;

/** The parts of docx-preview's (untyped) document model read here. */
interface WordDocumentModel {
  numberingPart?: { domNumberings?: unknown[] };
  stylesPart?: { styles?: unknown[] };
  corePropsPart?: { props?: { title?: string; creator?: string } };
}

function checkPackage(bytes: Uint8Array, maxXmlBytes: number): void {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    // Reached only when detection was overridden: an encrypted package or a
    // Word 97-2003 file named .docx.
    throw new ViewerError(
      'unsupported-format',
      'This is not a .docx package. It is either password protected or a Word 97-2003 document; open it in Word.',
      { retryable: false },
    );
  }
  const entries = readZipEntries(bytes);
  if (!entries) {
    throw new ViewerError('corrupt', 'This Word document is damaged: its ZIP directory could not be read.', {
      retryable: false,
    });
  }
  let xml = 0;
  let total = 0;
  for (const entry of entries) {
    total += entry.uncompressedSize;
    if (/\.(?:xml|rels)$/i.test(entry.name)) xml += entry.uncompressedSize;
  }
  if (xml > maxXmlBytes || total > MAX_UNPACKED_BYTES) {
    throw new ViewerError(
      'too-large',
      `This Word document expands to ${Math.round(xml / (1024 * 1024))} MB of text and markup, more than can be laid out in the browser. Open it in Word instead.`,
      { retryable: false, detail: { xmlBytes: xml, unpackedBytes: total, maxXmlBytes } },
    );
  }
}

function asDocxError(err: unknown): ViewerError {
  if (isAbort(err)) return ViewerError.from(err);
  if (err instanceof ViewerError) return err;
  return new ViewerError('corrupt', 'This Word document could not be read. It may be damaged or not a .docx file.', {
    cause: err,
    retryable: false,
  });
}

/** Let the browser paint progress between long synchronous steps. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Search over a plain-text index of every item.
 *
 * The index is built on the first search, not at open: most documents are
 * never searched, and building it touches every text node. Hit ids encode
 * `item:start:length` so the surface can find the range to highlight.
 */
function createSearch(items: DocxItem[]) {
  let texts: string[] | undefined;
  let folded: string[] | undefined;

  return async (query: string, emit: (hits: SearchHit[]) => void, signal: AbortSignal) => {
    if (!texts || !folded) {
      const built: string[] = [];
      for (let index = 0; index < items.length; index++) {
        if (index % 100 === 99) {
          await nextTask();
          if (signal.aborted) throw abortError();
        }
        built.push(extractText(items[index]!.node).text);
      }
      texts = built;
      folded = built.map(foldText);
    }

    const needle = foldText(query);
    let count = 0;
    for (let index = 0; index < folded.length; index++) {
      if (index % 200 === 199) {
        await nextTask();
        if (signal.aborted) throw abortError();
      }
      const haystack = folded[index]!;
      const original = texts[index]!;
      const batch: SearchHit[] = [];
      for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
        const from = Math.max(0, at - EXCERPT_CONTEXT);
        const to = Math.min(original.length, at + needle.length + EXCERPT_CONTEXT);
        batch.push({
          id: `${index}:${at}:${needle.length}`,
          page: index + 1,
          excerpt: original.slice(from, to).replace(/\s/g, ' '),
          excerptOffset: at - from,
          excerptLength: needle.length,
        });
        if (++count >= SEARCH_HIT_LIMIT) {
          emit(batch);
          return { truncated: true };
        }
      }
      if (batch.length > 0) emit(batch);
    }
    return { truncated: false };
  };
}
