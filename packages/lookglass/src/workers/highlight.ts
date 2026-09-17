import type { HighlighterCore } from 'shiki/core';

/**
 * Syntax highlighting for the text worker.
 *
 * Two choices here are about the constraints rather than taste:
 *
 *  - The JavaScript regex engine, not Oniguruma. Oniguruma is a WASM binary
 *    that has to be fetched at runtime, which is one more asset to get wrong
 *    offline and one that strict CSPs block (`wasm-unsafe-eval`).
 *
 *  - Grammar state is carried between blocks. Text is tokenised in fixed-size
 *    blocks so memory stays flat, but a block comment or template string that
 *    opens in one block and closes in the next would be coloured as code if
 *    each block started fresh. Carrying state means blocks must be tokenised
 *    in order, so the worker remembers the state at each block boundary it has
 *    passed and only ever walks forward from the furthest one.
 *
 * Everything in this module is loaded with dynamic `import()`, so the
 * highlighter costs nothing until a source file is actually opened.
 */

/** Per-token wire format: [text, light colour, dark colour, font style bits]. */
export type WireToken = [content: string, light: string, dark: string, fontStyle: number];

/** Opaque grammar state; only ever handed back to the highlighter. */
type GrammarState = unknown;

const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  protobuf: () => import('shiki/langs/protobuf.mjs'),
  terraform: () => import('shiki/langs/terraform.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
};

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/** Lines longer than this are left uncoloured; minified code would stall the tokenizer. */
const MAX_TOKENIZED_LINE = 2000;

let core: Promise<HighlighterCore> | undefined;

function loadCore(): Promise<HighlighterCore> {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  // A failed load must be retryable rather than cached forever.
  core.catch(() => {
    core = undefined;
  });
  return core;
}

export function supportsLanguage(language: string): boolean {
  return Object.hasOwn(LANGUAGE_LOADERS, language);
}

/**
 * Load every grammar so they are cached for offline use. Called from
 * `warmCache()`; failures are reported per language, never thrown.
 */
export async function preloadAllLanguages(): Promise<{ loaded: string[]; failed: string[] }> {
  const highlighter = await loadCore();
  const loaded: string[] = [];
  const failed: string[] = [];
  for (const [language, loader] of Object.entries(LANGUAGE_LOADERS)) {
    try {
      await highlighter.loadLanguage((await loader()) as never);
      loaded.push(language);
    } catch {
      failed.push(language);
    }
  }
  return { loaded, failed };
}

export class BlockHighlighter {
  /** `states[b]` is the grammar state at the start of block `b`. */
  private readonly states: GrammarState[] = [undefined];
  /** Serialises tokenisation: blocks depend on the state of the one before. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly highlighter: HighlighterCore,
    private readonly language: string,
  ) {}

  static async create(language: string): Promise<BlockHighlighter> {
    const loader = LANGUAGE_LOADERS[language];
    if (!loader) throw new Error(`No grammar for ${language}.`);
    const highlighter = await loadCore();
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage((await loader()) as never);
    }
    return new BlockHighlighter(highlighter, language);
  }

  /**
   * Tokens for block `block`, whose text is supplied by `readBlock`.
   *
   * Blocks before it that have not been tokenised yet are walked first, but
   * only to advance the grammar state — their tokens are discarded, since the
   * UI already has or does not need them.
   */
  tokens(block: number, readBlock: (block: number) => Promise<string[]>, signal?: AbortSignal): Promise<WireToken[][]> {
    const run = this.queue.then(async () => {
      for (let earlier = this.states.length - 1; earlier < block; earlier++) {
        signal?.throwIfAborted();
        this.tokenize(await readBlock(earlier), earlier);
      }
      signal?.throwIfAborted();
      return this.tokenize(await readBlock(block), block);
    });
    // Keep the chain alive past a rejected (e.g. aborted) request.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private tokenize(lines: string[], block: number): WireToken[][] {
    const result = this.highlighter.codeToTokens(lines.join('\n'), {
      lang: this.language,
      themes: THEMES,
      defaultColor: false,
      grammarState: this.states[block] as never,
      tokenizeMaxLineLength: MAX_TOKENIZED_LINE,
    });

    if (this.states.length === block + 1) this.states.push(result.grammarState);

    const out = result.tokens.map((line) =>
      line.map(
        (token): WireToken => [
          token.content,
          token.htmlStyle?.['--shiki-light'] ?? '',
          token.htmlStyle?.['--shiki-dark'] ?? '',
          token.fontStyle ?? 0,
        ],
      ),
    );

    // The tokenizer drops a trailing empty line; pad so indices stay aligned
    // with the line store.
    while (out.length < lines.length) out.push([]);
    return out;
  }
}
