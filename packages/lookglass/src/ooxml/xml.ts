/**
 * A small XML parser for OOXML parts, usable in workers (which have no
 * DOMParser).
 *
 * - **Canonical names.** Prefixes in a file are arbitrary: the same element
 *   can be `w:p` in one document and `ns0:p` in another, and Strict OOXML
 *   uses different namespace URIs for the same vocabulary. Every name is
 *   resolved to its namespace and renamed with a fixed prefix (`w:p`,
 *   `a:blip`, `r:id`), so the rest of the engine can match on plain strings.
 * - **No entity expansion.** A DTD is skipped unread. Only the five
 *   predefined entities and numeric references are decoded, so neither
 *   external entities nor exponential expansion are possible.
 * - **Markup compatibility.** `mc:AlternateContent` is resolved while
 *   parsing: the first `mc:Choice` whose required namespaces are all
 *   understood wins, otherwise `mc:Fallback`. Elements in namespaces listed in
 *   `mc:Ignorable` that we do not understand are dropped.
 */

export interface XmlElement {
  /** Canonical qualified name, e.g. `w:p`. */
  name: string;
  /** Attributes by canonical qualified name (`w:val`, `r:id`) or plain local name. */
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

/** Namespace URI to canonical prefix. Transitional and Strict URIs map to the same prefix. */
const NAMESPACES: Record<string, string> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': 'wp',
  'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing': 'wp',
  'http://schemas.openxmlformats.org/drawingml/2006/picture': 'pic',
  'http://purl.oclc.org/ooxml/drawingml/picture': 'pic',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://purl.oclc.org/ooxml/drawingml/chart': 'c',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'http://schemas.openxmlformats.org/presentationml/2006/main': 'p',
  'http://purl.oclc.org/ooxml/presentationml/main': 'p',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape': 'wps',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup': 'wpg',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas': 'wpc',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing': 'wp14',
  'http://schemas.microsoft.com/office/word/2010/wordml': 'w14',
  'http://schemas.microsoft.com/office/word/2012/wordml': 'w15',
  'http://schemas.microsoft.com/office/drawing/2010/main': 'a14',
  'http://schemas.microsoft.com/office/drawing/2016/SVG/main': 'asvg',
  'urn:schemas-microsoft-com:vml': 'v',
  'urn:schemas-microsoft-com:office:office': 'o',
  'urn:schemas-microsoft-com:office:word': 'w10',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'pr',
  'http://schemas.openxmlformats.org/package/2006/content-types': 'ct',
  'http://schemas.openxmlformats.org/package/2006/metadata/core-properties': 'cp',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://purl.org/dc/terms/': 'dcterms',
  'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties': 'ep',
  'http://www.w3.org/XML/1998/namespace': 'xml',
};

/** Prefixes whose markup the engine understands, for `mc:Choice Requires`. */
const UNDERSTOOD = new Set(['w', 'r', 'a', 'wp', 'pic', 'c', 'p', 'm', 'wps', 'wpg', 'wp14', 'w14', 'w15', 'a14', 'v', 'o', 'asvg']);

/** Elements whose whitespace-only text is content, not formatting. */
const TEXT_ELEMENTS = new Set(['w:t', 'w:delText', 'w:instrText', 'w:delInstrText', 'a:t', 'm:t', 'dc:title', 'dc:creator']);

export class XmlError extends Error {}

export function parseXml(text: string): XmlElement {
  const parser = new Parser(text);
  return parser.parseDocument();
}

type Scope = Map<string, string>;

class Parser {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): XmlElement {
    const root: XmlElement = { name: '#document', attrs: {}, children: [] };
    // Frames: element, its namespace scope, its raw prefixed name for matching the end tag,
    // and the ignorable prefixes in effect.
    const stack: Array<{ element: XmlElement; scope: Scope; raw: string; ignorable: Set<string>; drop: boolean }> = [
      { element: root, scope: new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]), raw: '', ignorable: new Set(), drop: false },
    ];
    const text = this.text;
    const length = text.length;
    if (text.charCodeAt(0) === 0xfeff) this.pos = 1;

    while (this.pos < length) {
      const lt = text.indexOf('<', this.pos);
      const top = stack[stack.length - 1]!;
      if (lt < 0) {
        this.addText(top.element, text.slice(this.pos), top.drop);
        break;
      }
      if (lt > this.pos) this.addText(top.element, text.slice(this.pos, lt), top.drop);
      this.pos = lt;

      const next = text.charCodeAt(lt + 1);
      if (next === 0x2f /* / */) {
        const end = text.indexOf('>', lt);
        if (end < 0) throw new XmlError('unterminated end tag');
        const raw = text.slice(lt + 2, end).trim();
        if (stack.length === 1 || raw !== top.raw) throw new XmlError(`mismatched end tag </${raw}>`);
        stack.pop();
        this.pos = end + 1;
        continue;
      }
      if (next === 0x3f /* ? */) {
        const end = text.indexOf('?>', lt);
        if (end < 0) throw new XmlError('unterminated processing instruction');
        this.pos = end + 2;
        continue;
      }
      if (next === 0x21 /* ! */) {
        if (text.startsWith('<!--', lt)) {
          const end = text.indexOf('-->', lt + 4);
          if (end < 0) throw new XmlError('unterminated comment');
          this.pos = end + 3;
        } else if (text.startsWith('<![CDATA[', lt)) {
          const end = text.indexOf(']]>', lt + 9);
          if (end < 0) throw new XmlError('unterminated CDATA section');
          if (!top.drop) top.element.children.push(text.slice(lt + 9, end));
          this.pos = end + 3;
        } else {
          // A DTD is skipped without being read: nothing it declares is used.
          this.pos = skipDeclaration(text, lt);
        }
        continue;
      }

      // Start tag.
      this.pos = lt + 1;
      const raw = this.readName();
      const rawAttrs: Array<[string, string]> = [];
      let selfClosing = false;
      for (;;) {
        this.skipSpace();
        const c = text.charCodeAt(this.pos);
        if (c === 0x3e /* > */) {
          this.pos++;
          break;
        }
        if (c === 0x2f /* / */ && text.charCodeAt(this.pos + 1) === 0x3e) {
          this.pos += 2;
          selfClosing = true;
          break;
        }
        if (Number.isNaN(c)) throw new XmlError(`unterminated start tag <${raw}>`);
        const name = this.readName();
        this.skipSpace();
        if (text.charCodeAt(this.pos) !== 0x3d /* = */) throw new XmlError(`attribute ${name} has no value`);
        this.pos++;
        this.skipSpace();
        const quote = text.charCodeAt(this.pos);
        if (quote !== 0x22 && quote !== 0x27) throw new XmlError(`attribute ${name} is not quoted`);
        const end = text.indexOf(quote === 0x22 ? '"' : "'", this.pos + 1);
        if (end < 0) throw new XmlError(`attribute ${name} is unterminated`);
        rawAttrs.push([name, decodeEntities(text.slice(this.pos + 1, end))]);
        this.pos = end + 1;
      }

      // Namespace scope for this element.
      let scope = top.scope;
      let ignorable = top.ignorable;
      for (const [name, value] of rawAttrs) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) {
          if (scope === top.scope) scope = new Map(top.scope);
          scope.set(name === 'xmlns' ? '' : name.slice(6), value);
        }
      }
      const element: XmlElement = { name: canonical(raw, scope, true), attrs: {}, children: [] };
      for (const [name, value] of rawAttrs) {
        if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
        const key = canonical(name, scope, false);
        if (key === 'mc:Ignorable') {
          ignorable = new Set(ignorable);
          for (const prefix of value.split(/\s+/)) {
            const uri = scope.get(prefix);
            if (!uri || !UNDERSTOOD.has(NAMESPACES[uri] ?? '')) ignorable.add(prefix);
          }
          continue;
        }
        element.attrs[key] = value;
      }

      const prefix = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : '';
      const drop = top.drop || (prefix !== '' && ignorable.has(prefix));
      if (!drop) top.element.children.push(element);
      if (!selfClosing) stack.push({ element, scope, raw, ignorable, drop });
    }

    if (stack.length > 1) throw new XmlError(`unclosed element <${stack[stack.length - 1]!.raw}>`);
    const documentElement = root.children.find((child): child is XmlElement => typeof child !== 'string');
    if (!documentElement) throw new XmlError('no root element');
    resolveAlternateContent(documentElement);
    return documentElement;
  }

  private addText(parent: XmlElement, raw: string, drop: boolean): void {
    if (drop) return;
    if (!TEXT_ELEMENTS.has(parent.name) && /^\s*$/.test(raw)) return;
    parent.children.push(decodeEntities(raw));
  }

  private readName(): string {
    const text = this.text;
    const start = this.pos;
    while (this.pos < text.length) {
      const c = text.charCodeAt(this.pos);
      // Name ends at whitespace, '/', '>', '=' or a quote.
      if (c <= 0x20 || c === 0x2f || c === 0x3e || c === 0x3d || c === 0x22 || c === 0x27) break;
      this.pos++;
    }
    if (this.pos === start) throw new XmlError('expected a name');
    return text.slice(start, this.pos);
  }

  private skipSpace(): void {
    const text = this.text;
    while (this.pos < text.length && text.charCodeAt(this.pos) <= 0x20) this.pos++;
  }
}

function canonical(raw: string, scope: Scope, isElement: boolean): string {
  const colon = raw.indexOf(':');
  if (colon < 0) {
    // Unprefixed attributes are in no namespace; unprefixed elements take the default one.
    if (!isElement) return raw;
    const uri = scope.get('');
    const prefix = uri ? NAMESPACES[uri] : undefined;
    return prefix ? `${prefix}:${raw}` : raw;
  }
  const prefix = raw.slice(0, colon);
  const uri = scope.get(prefix);
  const known = uri ? NAMESPACES[uri] : undefined;
  return `${known ?? prefix}:${raw.slice(colon + 1)}`;
}

function skipDeclaration(text: string, start: number): number {
  // Handles an internal subset in brackets, which may itself contain '>'.
  let depth = 0;
  for (let i = start + 2; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5b) depth++;
    else if (c === 0x5d) depth--;
    else if (c === 0x3e && depth <= 0) return i + 1;
  }
  throw new XmlError('unterminated declaration');
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    }
    // Undeclared named entities are left as written, never expanded.
    return PREDEFINED[body] ?? match;
  });
}

/** Replace every `mc:AlternateContent` with the content of the branch we can render. */
function resolveAlternateContent(element: XmlElement): void {
  for (let i = 0; i < element.children.length; i++) {
    const child = element.children[i]!;
    if (typeof child === 'string') continue;
    if (child.name === 'mc:AlternateContent') {
      const branches = child.children.filter((node): node is XmlElement => typeof node !== 'string');
      const choice = branches.find(
        (branch) =>
          branch.name === 'mc:Choice' &&
          (branch.attrs.Requires ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .every((prefix) => UNDERSTOOD.has(prefix)),
      );
      const picked = choice ?? branches.find((branch) => branch.name === 'mc:Fallback');
      const replacement = picked ? picked.children : [];
      element.children.splice(i, 1, ...replacement);
      i--;
      continue;
    }
    resolveAlternateContent(child);
  }
}

/* ------------------------------------------------------------------ *
 * Query helpers. OOXML is navigated by known child names, so these are
 * deliberately tiny and allocation-free where it matters.
 * ------------------------------------------------------------------ */

export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!element) return undefined;
  for (const node of element.children) if (typeof node !== 'string' && node.name === name) return node;
  return undefined;
}

export function children(element: XmlElement | undefined, name?: string): XmlElement[] {
  if (!element) return [];
  const out: XmlElement[] = [];
  for (const node of element.children) if (typeof node !== 'string' && (name === undefined || node.name === name)) out.push(node);
  return out;
}

/** Depth-first search for the first descendant with this name. */
export function descendant(element: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!element) return undefined;
  for (const node of element.children) {
    if (typeof node === 'string') continue;
    if (node.name === name) return node;
    const found = descendant(node, name);
    if (found) return found;
  }
  return undefined;
}

export function textContent(element: XmlElement | undefined): string {
  if (!element) return '';
  let out = '';
  for (const node of element.children) out += typeof node === 'string' ? node : textContent(node);
  return out;
}

export function attr(element: XmlElement | undefined, name: string): string | undefined {
  return element?.attrs[name];
}

/** `w:val` of a child element, the most common OOXML property shape. */
export function val(element: XmlElement | undefined, name: string, key = 'w:val'): string | undefined {
  return child(element, name)?.attrs[key];
}

export function intAttr(element: XmlElement | undefined, name: string): number | undefined {
  const value = element?.attrs[name];
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * OOXML on/off values. An element present with no `w:val` means on; the
 * values `0`, `false` and `off` mean off.
 */
export function onOff(element: XmlElement | undefined, name: string): boolean | undefined {
  const found = child(element, name);
  if (!found) return undefined;
  const value = found.attrs['w:val'];
  return value === undefined || !(value === '0' || value === 'false' || value === 'off');
}
