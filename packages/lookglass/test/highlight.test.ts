/**
 * @vitest-environment node
 *
 * The highlighter runs in a worker with no DOM, so it is tested with none.
 */
import { describe, expect, it } from 'vitest';
import { BlockHighlighter, supportsLanguage, type WireToken } from '../src/workers/highlight.js';

const GITHUB_LIGHT_COMMENT = '#6A737D';

/** Split source into fixed blocks, the way the text worker serves them. */
function blocks(source: string, size: number) {
  const lines = source.split('\n');
  return (block: number) => Promise.resolve(lines.slice(block * size, (block + 1) * size));
}

const text = (line: WireToken[] | undefined) => (line ?? []).map((token) => token[0]).join('');

describe('BlockHighlighter', () => {
  it('produces coloured tokens that reassemble to the original line', async () => {
    const highlighter = await BlockHighlighter.create('typescript');
    const [line] = await highlighter.tokens(0, blocks('const answer: number = 42;', 10));
    expect(text(line)).toBe('const answer: number = 42;');
    expect(line!.some(([, light, dark]) => light !== '' && dark !== '')).toBe(true);
  });

  it('carries a block comment across a block boundary', async () => {
    // Blocks of 2 lines: the comment opens in block 0 and closes in block 1.
    // Tokenised independently, block 1 would colour the comment as code.
    const source = ['const a = 1;', '/* a comment that', 'keeps going */ const b = 2;', 'const c = 3;'].join('\n');
    const highlighter = await BlockHighlighter.create('typescript');

    const block1 = await highlighter.tokens(1, blocks(source, 2));
    const firstToken = block1[0]![0]!;
    expect(firstToken[0]).toContain('keeps going');
    expect(firstToken[1].toUpperCase()).toBe(GITHUB_LIGHT_COMMENT);
  });

  it('gives the same result when blocks are requested out of order', async () => {
    const source = Array.from({ length: 12 }, (_, i) => (i === 3 ? '/* open' : i === 8 ? 'close */ x;' : `let v${i} = ${i};`)).join('\n');

    const inOrder = await BlockHighlighter.create('typescript');
    const expected: WireToken[][][] = [];
    for (let block = 0; block < 4; block++) expected.push(await inOrder.tokens(block, blocks(source, 3)));

    // Scrolling straight to the end, then back to the top.
    const jumping = await BlockHighlighter.create('typescript');
    const last = await jumping.tokens(3, blocks(source, 3));
    const middle = await jumping.tokens(2, blocks(source, 3));
    const first = await jumping.tokens(0, blocks(source, 3));

    expect(last).toEqual(expected[3]);
    expect(middle).toEqual(expected[2]);
    expect(first).toEqual(expected[0]);
  });

  it('keeps one token line per source line, including blank lines', async () => {
    const highlighter = await BlockHighlighter.create('python');
    const lines = await highlighter.tokens(0, blocks('x = 1\n\n\ny = 2\n', 10));
    expect(lines).toHaveLength(5);
    expect(text(lines[3])).toBe('y = 2');
  });

  it('recovers after an aborted request', async () => {
    const highlighter = await BlockHighlighter.create('typescript');
    const controller = new AbortController();
    controller.abort();
    await expect(highlighter.tokens(0, blocks('let a = 1;', 5), controller.signal)).rejects.toThrow();
    // The queue must not stay poisoned by the rejection.
    const [line] = await highlighter.tokens(0, blocks('let a = 1;', 5));
    expect(text(line)).toBe('let a = 1;');
  });

  it('reports which languages it can highlight', () => {
    expect(supportsLanguage('rust')).toBe(true);
    expect(supportsLanguage('brainfuck')).toBe(false);
  });

  it('rejects an unsupported language at creation', async () => {
    await expect(BlockHighlighter.create('brainfuck')).rejects.toThrow(/No grammar/);
  });
});
