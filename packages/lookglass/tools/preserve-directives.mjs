import MagicString from 'magic-string';

/**
 * Keep `"use client"` / `"use server"` on the output files.
 *
 * `rollup-plugin-preserve-directives` reads directives from Rollup's own
 * parse of the module, which happens *after* `transform`. esbuild strips
 * unknown directives (and injects `"use strict"`) during that transform, so
 * by the time the stock plugin looks, there is nothing left to preserve —
 * the build succeeds and every client component silently becomes a server
 * component, failing at runtime on the first hook.
 *
 * This plugin captures the directive from the original source in a `pre`
 * transform, then re-attaches it per output chunk. With `preserveModules`
 * each chunk maps to one module, so the mapping is exact.
 */
export function preserveDirectives() {
  const directives = new Map();

  // Leading comments and blank lines may precede the directive; a license
  // header above `"use client"` is common and still valid.
  const LEADING = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*/;
  const DIRECTIVE = /^(['"])(use client|use server)\1\s*;?/;

  return {
    name: 'lookglass-preserve-directives',

    transform: {
      order: 'pre',
      handler(code, id) {
        const offset = LEADING.exec(code)?.[0].length ?? 0;
        const match = DIRECTIVE.exec(code.slice(offset));
        if (match) directives.set(id, match[2]);
        return null;
      },
    },

    renderChunk(code, chunk) {
      const id = chunk.facadeModuleId ?? Object.keys(chunk.modules)[0];
      const directive = id ? directives.get(id) : undefined;

      const magic = new MagicString(code);
      let changed = false;

      // `"use strict"` is meaningless in an ES module and would sit ahead of
      // the directive we are about to add, which nullifies it.
      const strict = /^["']use strict["'];?\s*\n?/.exec(code);
      if (strict) {
        magic.remove(0, strict[0].length);
        changed = true;
      }

      if (directive) {
        magic.prepend(`'${directive}';\n`);
        changed = true;
      }

      if (!changed) return null;
      return { code: magic.toString(), map: magic.generateMap({ hires: true }) };
    },

    buildEnd() {
      const count = directives.size;
      if (count === 0) {
        this.warn('No "use client" directives were found — check the transform ordering.');
      }
    },
  };
}

export default preserveDirectives;
