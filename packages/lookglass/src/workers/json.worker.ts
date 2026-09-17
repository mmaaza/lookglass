/// <reference lib="webworker" />
import { exposeRpc, type RpcContext } from '../core/rpc.js';
import { sourceFromDescriptor } from '../source/index.js';
import type { SourceDescriptor } from '../source/types.js';
import type { SearchHit } from '../types.js';
import { parseJson } from './json-parse.js';
import { ByteWindow, NodeKind, type TreeRow, type TreeStats } from './tree-model.js';
import { collectRowText, jsonKey, jsonPreview, syntheticKey, unescapeJsonString } from './tree-reader.js';
import { TreeService, type RowFormatter } from './tree-service.js';

/**
 * JSON / JSON Lines document server.
 *
 * The worker owns the node table and the expansion state. Expanding an array
 * of a million elements changes one integer here; the UI only learns that the
 * scroll range got taller and asks for the rows it can see.
 */

let service: TreeService | undefined;

/** Containers up to this depth open on load: orientation without a wall. */
const INITIAL_DEPTH = 2;

export interface OpenJsonArgs {
  descriptor: SourceDescriptor;
  ndjson?: boolean;
}

export interface OpenJsonResult extends TreeStats {
  visibleCount: number;
}

const handlers = {
  async open(args: OpenJsonArgs, ctx: RpcContext): Promise<OpenJsonResult> {
    const source = sourceFromDescriptor(args.descriptor);

    ctx.progress({ phase: 'parsing', message: 'Scanning structure' });
    const { table } = await parseJson(source, {
      signal: ctx.signal,
      ndjson: args.ndjson,
      onProgress: (done, total, nodes) =>
        ctx.progress({
          phase: 'parsing',
          bytesDone: done,
          bytesTotal: total,
          ratio: total > 0 ? done / total : undefined,
          message: `Scanning — ${nodes.toLocaleString()} nodes`,
        }),
    });

    ctx.progress({ phase: 'indexing', message: 'Preparing view' });
    const window = await ByteWindow.create(source);

    const formatter: RowFormatter = {
      async buildRows(indices, signal) {
        const texts = await collectRowText(table, window, indices, signal);
        return texts.map((entry) => {
          const index = entry.index;
          return {
            index,
            depth: table.depths[index]!,
            key: jsonKey(table, index, entry.key),
            kind: table.kinds[index] as NodeKind,
            preview: jsonPreview(table, index, entry.raw, entry.clipped),
            childCount: table.childCounts[index]!,
            expanded: service!.expansion.isExpanded(index),
            path: '',
            clipped: entry.clipped,
          } satisfies TreeRow;
        });
      },

      async buildPath(index, signal) {
        const chain: number[] = [];
        for (let cursor = index; cursor > 0; cursor = table.parents[cursor]!) chain.push(cursor);
        const texts = await collectRowText(table, window, chain, signal);
        const keyByIndex = new Map(texts.map((entry) => [entry.index, entry.key]));

        const parts = chain.map((node) =>
          table.kinds[table.parents[node]!] === NodeKind.Array
            ? `[${syntheticKey(table, node)}]`
            : `.${unescapeJsonString(keyByIndex.get(node) ?? '')}`,
        );
        parts.reverse();
        return `$${parts.join('')}`;
      },
    };

    service = new TreeService(table, window, source, formatter, INITIAL_DEPTH);

    return {
      nodeCount: table.count,
      truncated: table.truncated,
      maxDepth: table.maxDepth,
      byteLength: source.size,
      visibleCount: service.visibleCount(),
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

  close(): void {
    service?.dispose();
    service = undefined;
  },
};

export type JsonWorkerHandlers = typeof handlers;

function required(): TreeService {
  if (!service) throw new Error('JSON document is not open.');
  return service;
}

exposeRpc(handlers as never);
