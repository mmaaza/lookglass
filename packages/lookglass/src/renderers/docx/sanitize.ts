'use client';

import DOMPurify from 'dompurify';

/**
 * Sanitising docx-preview output.
 *
 * docx-preview builds DOM with `createElement`, never by parsing HTML, so it
 * cannot be tricked into creating arbitrary markup. What it does copy
 * verbatim from the document:
 *
 *  - hyperlink targets, which can be `javascript:` URLs;
 *  - style names, font names, list formats and colours, which are pasted
 *    unescaped into the stylesheet it generates. A crafted font name can
 *    close the rule and add its own, which can load remote resources or
 *    restyle the host page.
 *
 * Markup goes through DOMPurify. The stylesheet is parsed by the browser's
 * own CSS parser, in an inert document so nothing loads, and re-serialised
 * from the parsed rules: whatever the input, the output is only well-formed
 * rules, checked declaration by declaration. It is then applied inside a
 * shadow root, so even a well-formed rule cannot reach the host page.
 *
 * Remote references are removed as well as script ones. A document should
 * not phone home when it is opened, and an offline viewer should not render
 * differently depending on whether a third-party host answers.
 */

export interface SanitizeReport {
  /** Remote images, styles and fonts that were removed. */
  blockedRemote: number;
}

/** Link targets a reader may follow, and the local URLs images use. */
const ALLOWED_URI = /^(?:(?:https?|mailto|tel):|#|blob:|data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml)[;,])/i;
const LOCAL_RESOURCE = /^(?:blob:|data:|#)/i;
const REMOTE_URL = /^\s*(?:https?:|\/\/|ftp:)/i;
const RESOURCE_FUNCTION = /(?:url|image-set|image|element|cross-fade|src)\s*\(/i;

export function sanitizeDocxTree(roots: Element[], report: SanitizeReport): void {
  const view = roots[0]?.ownerDocument.defaultView;
  if (!view) return;
  // A private instance: hooks on the shared default would leak into the SVG
  // renderer's sanitiser and vice versa.
  const purify = DOMPurify(view);
  purify.addHook('afterSanitizeAttributes', (node) => {
    const element = node as Element;
    if (element.tagName === 'A' || element.tagName === 'a') {
      const href = element.getAttribute('href');
      // docx-preview writes `href=""` for links it could not resolve, which
      // would reload the host page when clicked.
      if (!href || href === '#') element.removeAttribute('href');
      else if (/^https?:/i.test(href)) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
    for (const attribute of ['src', 'href', 'xlink:href']) {
      if (attribute === 'href' && (element.tagName === 'A' || element.tagName === 'a')) continue;
      const value = element.getAttribute(attribute);
      if (value && REMOTE_URL.test(value)) {
        element.removeAttribute(attribute);
        report.blockedRemote++;
      }
    }
    const style = (element as HTMLElement).style as CSSStyleDeclaration | undefined;
    if (style && style.length > 0) report.blockedRemote += cleanDeclarations(style);
  });

  for (const root of roots) {
    purify.sanitize(root, {
      IN_PLACE: true,
      ALLOWED_URI_REGEXP: ALLOWED_URI,
      // docx-preview emits none of these for body content; anything that
      // looks like one did not come from a Word document.
      FORBID_TAGS: ['style', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'foreignObject', 'animate', 'set', 'use'],
      ADD_ATTR: ['target'],
    });
  }
  purify.removeAllHooks();
}

/**
 * Parse and rebuild a stylesheet, keeping only safe declarations. Returns
 * the rebuilt CSS text.
 */
export function sanitizeDocxCss(cssText: string, report: SanitizeReport, parseIn?: Document): string {
  // An inert document: no browsing context, so parsing a rule never fetches
  // what it references. `parseIn` exists for test environments whose inert
  // documents do not parse CSS.
  const scratch = parseIn ?? document.implementation.createHTMLDocument('');
  const element = scratch.createElement('style');
  element.textContent = cssText;
  scratch.head.append(element);
  let sheet = element.sheet as CSSStyleSheet | null;
  if (!sheet && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    // Constructed sheets never load anything either: replaceSync ignores @import.
    sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
  }
  // No CSS parser at all: fail closed. The document renders unstyled rather
  // than with an unchecked stylesheet.
  if (!sheet) {
    element.remove();
    return '';
  }
  const parsed = sheet;
  cleanRules(parsed.cssRules, (index) => parsed.deleteRule(index), report);
  const result = Array.from(parsed.cssRules, (rule) => rule.cssText).join('\n');
  element.remove();
  return result;
}

function cleanRules(rules: CSSRuleList, remove: (index: number) => void, report: SanitizeReport): void {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index]!;
    // @import, @namespace and friends: never produced by docx-preview.
    if (rule.constructor.name === 'CSSImportRule' || rule.type === 3 || rule.type === 10) {
      remove(index);
      report.blockedRemote++;
      continue;
    }
    const selector = (rule as CSSStyleRule).selectorText;
    // The shadow root's host and anything outside it are off limits.
    if (selector !== undefined && /:host|::?slotted|::part|:root/i.test(selector)) {
      remove(index);
      continue;
    }
    const style = (rule as CSSStyleRule).style as CSSStyleDeclaration | undefined;
    if (style) report.blockedRemote += cleanDeclarations(style);
    const nested = (rule as CSSGroupingRule).cssRules as CSSRuleList | undefined;
    if (nested && typeof (rule as CSSGroupingRule).deleteRule === 'function') {
      cleanRules(nested, (i) => (rule as CSSGroupingRule).deleteRule(i), report);
    }
  }
}

/** Remove unsafe declarations in place; returns how many were remote loads. */
function cleanDeclarations(style: CSSStyleDeclaration): number {
  let blocked = 0;
  const names: string[] = [];
  for (let i = 0; i < style.length; i++) names.push(style[i]!);
  for (const name of names) {
    const value = style.getPropertyValue(name);
    if (!value) continue;
    // Escapes outside strings are how a function name hides from a pattern
    // match (`u\72l(`). Parsed values never contain them; values the browser
    // kept unparsed (custom properties, anything using var()) may.
    if (/\\/.test(stripStrings(value)) && /\(/.test(value)) {
      style.removeProperty(name);
      continue;
    }
    if (RESOURCE_FUNCTION.test(value) && !onlyLocalResources(value)) {
      style.removeProperty(name);
      blocked++;
      continue;
    }
    if (name === 'font-family' || /^--docx-.*-font$/i.test(name)) {
      const fallback = withFontFallback(value);
      if (fallback !== value) style.setProperty(name, fallback, style.getPropertyPriority(name));
    }
  }
  return blocked;
}

function stripStrings(value: string): string {
  return value.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
}

function onlyLocalResources(value: string): boolean {
  // Functions that take a bare string as an image URL. docx-preview never
  // writes them, so they are refused outright rather than parsed.
  if (/(?:image-set|image|element|cross-fade|src)\s*\(/i.test(value.replace(/url\s*\(/gi, ''))) return false;
  const targets = Array.from(
    value.matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)/gi),
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  return targets.length > 0 && targets.every((target) => LOCAL_RESOURCE.test(target.trim()));
}

/**
 * Metric-compatible and look-alike substitutes for the fonts Office uses.
 *
 * Word documents name fonts that exist only on Windows. Without a fallback
 * the browser drops to its default serif, which changes line breaks and makes
 * every page look wrong. The first substitute listed for each has the same
 * metrics where one exists (Carlito for Calibri, Caladea for Cambria, the
 * Liberation family for Arial, Times New Roman and Courier New), so text
 * wraps where Word wraps it when those fonts are installed.
 */
const FONT_FALLBACKS: Record<string, string> = {
  calibri: 'Carlito, "Segoe UI", Arial, sans-serif',
  'calibri light': 'Carlito, "Segoe UI Light", Arial, sans-serif',
  cambria: 'Caladea, Georgia, serif',
  'cambria math': 'Caladea, "STIX Two Math", serif',
  aptos: '"Segoe UI", Carlito, Arial, sans-serif',
  arial: '"Liberation Sans", Arimo, Helvetica, sans-serif',
  helvetica: 'Arial, "Liberation Sans", sans-serif',
  'times new roman': '"Liberation Serif", Tinos, Times, serif',
  times: '"Times New Roman", "Liberation Serif", serif',
  'courier new': '"Liberation Mono", Cousine, Courier, monospace',
  consolas: 'Menlo, Monaco, "Liberation Mono", monospace',
  georgia: 'Gelasio, serif',
  garamond: '"EB Garamond", Georgia, serif',
  'book antiqua': 'Palatino, "Palatino Linotype", serif',
  'palatino linotype': 'Palatino, "Book Antiqua", serif',
  'segoe ui': 'system-ui, sans-serif',
  verdana: 'DejaVu Sans, sans-serif',
  tahoma: 'Verdana, sans-serif',
  'trebuchet ms': 'sans-serif',
  'century gothic': 'Futura, sans-serif',
  'comic sans ms': 'cursive',
};

const GENERIC_FAMILY = /(?:^|,)\s*(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|math|emoji|ui-[a-z-]+)\s*(?:,|$)/i;

export function withFontFallback(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || GENERIC_FAMILY.test(trimmed) || /var\(/i.test(trimmed)) return value;
  const first = trimmed.split(',')[0]!.trim().replace(/^["']|["']$/g, '').toLowerCase();
  // Symbol fonts map code points to pictures; a text fallback would show
  // the wrong characters, which is worse than showing boxes.
  if (first === 'symbol' || first.startsWith('wingdings') || first.startsWith('webdings')) return value;
  return `${trimmed}, ${FONT_FALLBACKS[first] ?? 'sans-serif'}`;
}
