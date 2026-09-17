/// <reference lib="webworker" />
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { toString as mdastToString } from 'mdast-util-to-string';
import { unified } from 'unified';
import type { Root, RootContent } from 'mdast';

import { exposeRpc, type RpcContext } from '../core/rpc.js';
import { ViewerError } from '../core/errors.js';
import { sourceFromDescriptor } from '../source/index.js';
import type { SourceDescriptor } from '../source/types.js';
import type { OutlineNode, SearchHit } from '../types.js';

/**
 * Markdown to sanitised HTML, one top-level block at a time.
 *
 * Blocks rather than one document string, because a 20 MB changelog rendered
 * as a single `innerHTML` assignment produces a DOM the browser cannot lay
 * out smoothly. Emitting per-block HTML lets the surface virtualise the
 * document the same way every other renderer here does.
 *
 * Raw HTML in the source is allowed through `rehype-raw` and then sanitised
 * against an allow-list. That ordering is deliberate: sanitising before
 * raw-parsing would let `<img src=x onerror=...>` through as text that the
 * browser later re-parses as markup.
 */

const MAX_MARKDOWN_BYTES = 32 * 1024 * 1024;

interface State {
  blocks: string[];
  /** Plain text per block, for search. */
  text: string[];
  outline: OutlineNode[];
}

let state: State | undefined;

/**
 * Allow-list extensions over rehype's default.
 *
 * `className` on code elements carries the language for highlighting, and
 * heading ids are what make the outline clickable. Everything else stays at
 * the library default, which already strips scripts, event handlers and
 * `javascript:` URLs.
 */
type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.['code'] ?? []), ['className', /^language-./]],
    span: [...(defaultSchema.attributes?.['span'] ?? []), ['className', /^hljs-./]],
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'id'],
  },
  // `input` is needed for GFM task lists, but only as a disabled checkbox.
  tagNames: [...(defaultSchema.tagNames ?? []), 'input'],
} as unknown as SanitizeSchema;

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema)
  .use(rehypeStringify);

export interface OpenMarkdownArgs {
  descriptor: SourceDescriptor;
}

export interface OpenMarkdownResult {
  blockCount: number;
  outline: OutlineNode[];
  byteLength: number;
  truncated: boolean;
}

const handlers = {
  async open(args: OpenMarkdownArgs, ctx: RpcContext): Promise<OpenMarkdownResult> {
    const source = sourceFromDescriptor(args.descriptor);
    const truncated = source.size > MAX_MARKDOWN_BYTES;

    ctx.progress({ phase: 'fetching', message: 'Reading document' });
    // Markdown has no random-access structure: link references and footnotes
    // can point anywhere, so the document has to be read whole. The cap is
    // what keeps that honest.
    const bytes = await source.slice(0, Math.min(source.size, MAX_MARKDOWN_BYTES), ctx.signal);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    ctx.progress({ phase: 'parsing', message: 'Parsing markdown' });
    let tree: Root;
    try {
      tree = processor.parse(text) as Root;
    } catch (err) {
      throw new ViewerError('corrupt', 'This markdown document could not be parsed.', { cause: err });
    }

    const blocks: string[] = [];
    const blockText: string[] = [];
    const outline: OutlineNode[] = [];
    const stack: OutlineNode[] = [];

    for (const [index, node] of (tree.children as RootContent[]).entries()) {
      ctx.signal.throwIfAborted();

      // Each block is rendered as its own tiny document. Running the full
      // pipeline per block keeps memory flat and means one malformed block
      // cannot take the rest of the document down.
      const fragment: Root = { type: 'root', children: [node] };
      const html = String(processor.stringify(processor.runSync(fragment, text) as never));
      blocks.push(html);
      blockText.push(mdastToString(node));

      if (node.type === 'heading') {
        const title = mdastToString(node);
        const entry: OutlineNode = { id: `block-${index}`, title, page: index + 1, children: [] };
        // Nest by heading depth so the outline mirrors the document.
        while (stack.length >= node.depth) stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) parent.children!.push(entry);
        else outline.push(entry);
        stack.push(entry);
      }

      if (index % 200 === 0) {
        ctx.progress({
          phase: 'rendering',
          ratio: index / Math.max(1, tree.children.length),
          message: `Rendering — ${index} of ${tree.children.length} blocks`,
        });
      }
    }

    state = { blocks, text: blockText, outline };
    source.dispose();

    return { blockCount: blocks.length, outline, byteLength: source.size, truncated };
  },

  getBlocks(args: { start: number; end: number }): string[] {
    const current = required();
    return current.blocks.slice(Math.max(0, args.start), Math.max(0, args.end));
  },

  outline(): OutlineNode[] {
    return required().outline;
  },

  search(args: { query: string; limit?: number }): { hits: SearchHit[]; truncated: boolean } {
    const current = required();
    const needle = args.query.toLowerCase();
    const limit = args.limit ?? 2000;
    if (!needle) return { hits: [], truncated: false };

    const hits: SearchHit[] = [];
    for (const [index, text] of current.text.entries()) {
      const haystack = text.toLowerCase();
      let at = haystack.indexOf(needle);
      while (at !== -1 && hits.length < limit) {
        hits.push({
          id: `${index}:${at}`,
          page: index + 1,
          excerpt: text.slice(Math.max(0, at - 40), at + needle.length + 40).replace(/\s+/g, ' '),
          excerptOffset: Math.min(40, at),
          excerptLength: args.query.length,
        });
        at = haystack.indexOf(needle, at + needle.length);
      }
      if (hits.length >= limit) break;
    }
    return { hits, truncated: hits.length >= limit };
  },

  close(): void {
    state = undefined;
  },
};

export type MarkdownWorkerHandlers = typeof handlers;

function required(): State {
  if (!state) throw new Error('Markdown document is not open.');
  return state;
}

exposeRpc(handlers as never);
