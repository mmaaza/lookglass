/// <reference lib="webworker" />
import { exposeRpc, type RpcContext } from '../core/rpc.js';
import { sourceFromDescriptor } from '../source/index.js';
import type { SourceDescriptor } from '../source/types.js';
import type { SearchHit } from '../types.js';
import { ByteWindow, NodeKind, PREVIEW_CHARS, type TreeRow, type TreeStats } from './tree-model.js';
import { decodeXmlText, parseAttributes, truncateXml, xmlPreview } from './tree-reader.js';
import { TreeService, type RowFormatter } from './tree-service.js';
import { parseXml } from './xml-parse.js';

/**
 * XML document server.
 *
 * Shares the tree service with JSON, so expansion, search-and-reveal and
 * windowed row serving behave identically. The only XML-specific work here is
 * turning a node into a row: element name, lazily parsed attributes, and the
 * single-text-child collapse that keeps `<name>John</name>` on one line
 * instead of two.
 */

let service: TreeService | undefined;
let entitiesDeclared = false;

const INITIAL_DEPTH = 3;
const MAX_ATTR_BYTES = 2048;
const MAX_TEXT_BYTES = PREVIEW_CHARS * 4 + 16;

export interface OpenXmlArgs {
  descriptor: SourceDescriptor;
}

export interface OpenXmlResult extends TreeStats {
  visibleCount: number;
  encoding?: string;
  entitiesDeclared: boolean;
  mismatched: number;
}

const handlers = {
  async open(args: OpenXmlArgs, ctx: RpcContext): Promise<OpenXmlResult> {
    const source = sourceFromDescriptor(args.descriptor);

    ctx.progress({ phase: 'parsing', message: 'Scanning structure' });
    const parsed = await parseXml(source, {
      signal: ctx.signal,
      onProgress: (done, total, nodes) =>
        ctx.progress({
          phase: 'parsing',
          bytesDone: done,
          bytesTotal: total,
          ratio: total > 0 ? done / total : undefined,
          message: `Scanning — ${nodes.toLocaleString()} nodes`,
        }),
    });
    const { table } = parsed;
    entitiesDeclared = parsed.entitiesDeclared;

    ctx.progress({ phase: 'indexing', message: 'Preparing view' });
    const window = await ByteWindow.create(source);

    /** Element whose only child is text renders inline on the element's row. */
    const inlineTextChild = (index: number): number => {
      if (table.kinds[index] !== NodeKind.Element) return -1;
      if (table.childCounts[index] !== 1) return -1;
      const child = table.firstChild[index]!;
      return table.kinds[child] === NodeKind.Text ? child : -1;
    };

    const formatter: RowFormatter = {
      async buildRows(indices, signal) {
        const ranges: { start: number; end: number }[] = [];
        const plan = indices.map((index) => {
          const kind = table.kinds[index] as NodeKind;

          let nameRange = -1;
          if (kind === NodeKind.Element) {
            nameRange = ranges.length;
            ranges.push({ start: table.keyStart[index]!, end: table.keyEnd[index]! });
          }

          let attrRange = -1;
          const attrStart = table.auxStart[index]!;
          const attrEnd = table.auxEnd[index]!;
          if (kind === NodeKind.Element && attrEnd > attrStart) {
            attrRange = ranges.length;
            ranges.push({ start: attrStart, end: Math.min(attrEnd, attrStart + MAX_ATTR_BYTES) });
          }

          // Leaf text, or the inline text child of an element.
          const textNode = kind === NodeKind.Element ? inlineTextChild(index) : index;
          let textRange = -1;
          let clipped = false;
          if (textNode !== -1 && table.kinds[textNode] !== NodeKind.Element) {
            const start = table.valueStart[textNode]!;
            const end = table.valueEnd[textNode]!;
            const clampedEnd = Math.min(end, start + MAX_TEXT_BYTES);
            clipped = clampedEnd < end;
            textRange = ranges.length;
            ranges.push({ start, end: clampedEnd });
          }

          return { index, kind, nameRange, attrRange, textRange, clipped, inlined: textNode !== index };
        });

        const texts = await window.read(ranges, signal);

        return plan.map((entry) => {
          const raw = entry.textRange >= 0 ? (texts[entry.textRange] ?? '') : '';
          const inlineText = entry.inlined && raw.trim() !== '' ? truncateXml(decodeXmlText(raw)) : '';

          return {
            index: entry.index,
            depth: table.depths[entry.index]!,
            key: entry.nameRange >= 0 ? (texts[entry.nameRange] ?? '') : labelFor(entry.kind),
            kind: entry.kind,
            preview: inlineText || xmlPreview(table, entry.index, raw, entry.clipped),
            // An element collapsed into its text child has nothing left to
            // expand, so it must not show a twisty.
            childCount: entry.inlined && inlineText ? 0 : table.childCounts[entry.index]!,
            expanded: service!.expansion.isExpanded(entry.index),
            path: '',
            attributes: entry.attrRange >= 0 ? parseAttributes(texts[entry.attrRange] ?? '') : undefined,
            clipped: entry.clipped,
          } satisfies TreeRow;
        });
      },

      async buildPath(index, signal) {
        const chain: number[] = [];
        // Stops at node 0, the synthetic document root, which has no name.
        for (let cursor = index; cursor > 0; cursor = table.parents[cursor]!) chain.push(cursor);

        const ranges = chain.map((node) => ({ start: table.keyStart[node]!, end: table.keyEnd[node]! }));
        const names = await window.read(ranges, signal);

        const parts = chain.map((node, i) => {
          const name = names[i] || labelFor(table.kinds[node] as NodeKind);
          // XPath-style positional predicate, but only when it disambiguates.
          const position = siblingPosition(node);
          return position > 0 ? `/${name}[${position}]` : `/${name}`;
        });
        parts.reverse();
        return parts.join('');
      },
    };

    /** 1-based position among same-named siblings; 0 when unique. */
    const siblingPosition = (node: number): number => {
      const parent = table.parents[node]!;
      if (parent < 0) return 0;
      let seen = 0;
      let position = 0;
      for (let child = table.firstChild[parent]!; child !== -1; child = table.nextSibling[child]!) {
        if (table.kinds[child] !== table.kinds[node]) continue;
        if (sameName(child, node)) {
          seen++;
          if (child === node) position = seen;
        }
      }
      return seen > 1 ? position : 0;
    };

    const sameName = (a: number, b: number): boolean =>
      table.keyEnd[a]! - table.keyStart[a]! === table.keyEnd[b]! - table.keyStart[b]! &&
      (window.isResident
        ? window.readSync(table.keyStart[a]!, table.keyEnd[a]!) ===
          window.readSync(table.keyStart[b]!, table.keyEnd[b]!)
        : true);

    service = new TreeService(table, window, source, formatter, INITIAL_DEPTH, true);

    return {
      nodeCount: table.count,
      truncated: table.truncated,
      maxDepth: table.maxDepth,
      byteLength: source.size,
      visibleCount: service.visibleCount(),
      encoding: parsed.encoding,
      entitiesDeclared: parsed.entitiesDeclared,
      mismatched: parsed.mismatched,
    };
  },

  getRows(args: { start: number; end: number }, ctx: RpcContext): Promise<TreeRow[]> {
    return required().getRows(args.start, args.end, ctx.signal);
  },

  toggle(args: { index: number }) {
    return required().toggle(args.index);
  },

  expandAll() {
    return required().expandAll();
  },

  collapseAll() {
    return required().collapseAll();
  },

  visibleCount(): number {
    return required().visibleCount();
  },

  path(args: { index: number }, ctx: RpcContext): Promise<string> {
    return required().path(args.index, ctx.signal);
  },

  search(args: { query: string; limit?: number }, ctx: RpcContext): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    return required().search(args.query, ctx, args.limit);
  },

  hasDeclaredEntities(): boolean {
    return entitiesDeclared;
  },

  close(): void {
    service?.dispose();
    service = undefined;
  },
};

export type XmlWorkerHandlers = typeof handlers;

function required(): TreeService {
  if (!service) throw new Error('XML document is not open.');
  return service;
}

function labelFor(kind: NodeKind): string {
  switch (kind) {
    case NodeKind.Comment:
      return '#comment';
    case NodeKind.CData:
      return '#cdata';
    case NodeKind.Text:
      return '#text';
    case NodeKind.Instruction:
      return '#instruction';
    case NodeKind.Doctype:
      return '#doctype';
    default:
      return '';
  }
}

exposeRpc(handlers as never);
