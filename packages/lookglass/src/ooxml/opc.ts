import { ViewerError } from '../core/errors.js';
import type { Source } from '../source/types.js';
import { XmlError, children, parseXml, type XmlElement } from './xml.js';
import { ZipArchive, normaliseName } from './zip.js';

/**
 * Open Packaging Conventions: the layer shared by every OOXML format.
 *
 * A package is a ZIP of *parts* (`/word/document.xml`) linked by
 * *relationships* (`/word/_rels/document.xml.rels`). Everything that
 * references another part — an image, a header, a slide layout — does so
 * through a relationship id, never a path, so resolving those is the one job
 * every format needs.
 */

export interface Relationship {
  id: string;
  /** Last segment of the relationship type URI: `image`, `header`, `slideLayout`. */
  type: string;
  /** Absolute part name for internal targets; the raw URL for external ones. */
  target: string;
  external: boolean;
}

export interface PartLimits {
  /** Largest single XML part that will be parsed. */
  maxXmlBytes: number;
}

const DEFAULT_LIMITS: PartLimits = { maxXmlBytes: 128 * 1024 * 1024 };

export class OoxmlPackage {
  readonly zip: ZipArchive;
  private readonly limits: PartLimits;
  private readonly relsCache = new Map<string, Promise<Map<string, Relationship>>>();
  private contentTypes?: { defaults: Map<string, string>; overrides: Map<string, string> };

  private constructor(zip: ZipArchive, limits: PartLimits) {
    this.zip = zip;
    this.limits = limits;
  }

  static async open(source: Source, opts: { signal?: AbortSignal; limits?: Partial<PartLimits> } = {}): Promise<OoxmlPackage> {
    const zip = await ZipArchive.open(source, opts.signal);
    const pkg = new OoxmlPackage(zip, { ...DEFAULT_LIMITS, ...opts.limits });
    if (!zip.has('[Content_Types].xml')) {
      throw new ViewerError('corrupt', 'This is a ZIP file, but not an Office document: it has no content types part.', {
        retryable: false,
      });
    }
    return pkg;
  }

  has(part: string): boolean {
    return this.zip.has(stripSlash(part));
  }

  /** Total inflated size of the package's XML parts, from the directory alone. */
  xmlBytes(): number {
    let total = 0;
    for (const entry of this.zip.entries.values()) {
      if (/\.(?:xml|rels)$/i.test(entry.name)) total += entry.uncompressedSize;
    }
    return total;
  }

  async bytes(part: string, signal?: AbortSignal, maxBytes?: number): Promise<Uint8Array> {
    return this.zip.read(stripSlash(part), { signal, maxBytes });
  }

  async xml(part: string, signal?: AbortSignal): Promise<XmlElement> {
    const text = await this.zip.text(stripSlash(part), { signal, maxBytes: this.limits.maxXmlBytes });
    try {
      return parseXml(text);
    } catch (err) {
      if (err instanceof XmlError) {
        throw new ViewerError('corrupt', `This document is damaged: ${part} is not well-formed XML (${err.message}).`, {
          cause: err,
          retryable: false,
        });
      }
      throw err;
    }
  }

  async xmlIfPresent(part: string | undefined, signal?: AbortSignal): Promise<XmlElement | undefined> {
    if (!part || !this.has(part)) return undefined;
    return this.xml(part, signal);
  }

  async contentType(part: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.contentTypes) {
      const root = await this.xml('/[Content_Types].xml', signal);
      const defaults = new Map<string, string>();
      const overrides = new Map<string, string>();
      for (const entry of children(root, 'ct:Default')) {
        if (entry.attrs.Extension && entry.attrs.ContentType) {
          defaults.set(entry.attrs.Extension.toLowerCase(), entry.attrs.ContentType);
        }
      }
      for (const entry of children(root, 'ct:Override')) {
        if (entry.attrs.PartName && entry.attrs.ContentType) {
          overrides.set(normaliseName(entry.attrs.PartName), entry.attrs.ContentType);
        }
      }
      this.contentTypes = { defaults, overrides };
    }
    const override = this.contentTypes.overrides.get(normaliseName(part));
    if (override) return override;
    const ext = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
    return this.contentTypes.defaults.get(ext);
  }

  /** Relationships of a part (`/` for the package itself). */
  rels(part: string, signal?: AbortSignal): Promise<Map<string, Relationship>> {
    const key = normaliseName(part);
    let pending = this.relsCache.get(key);
    if (!pending) {
      pending = this.loadRels(part, signal);
      this.relsCache.set(key, pending);
    }
    return pending;
  }

  /** The target of the first relationship of a type, e.g. the main document part. */
  async relatedPart(part: string, type: string, signal?: AbortSignal): Promise<string | undefined> {
    for (const rel of (await this.rels(part, signal)).values()) {
      if (rel.type === type && !rel.external) return rel.target;
    }
    return undefined;
  }

  private async loadRels(part: string, signal?: AbortSignal): Promise<Map<string, Relationship>> {
    const relsPart = relsPartFor(part);
    const result = new Map<string, Relationship>();
    if (!this.has(relsPart)) return result;
    const root = await this.xml(relsPart, signal);
    const base = part === '/' ? '/' : part.slice(0, part.lastIndexOf('/') + 1);
    for (const rel of children(root, 'pr:Relationship')) {
      const id = rel.attrs.Id;
      const target = rel.attrs.Target;
      if (!id || target === undefined) continue;
      const external = rel.attrs.TargetMode === 'External';
      const typeUri = rel.attrs.Type ?? '';
      result.set(id, {
        id,
        type: typeUri.slice(typeUri.lastIndexOf('/') + 1),
        target: external ? target : resolvePartName(base, target),
        external,
      });
    }
    return result;
  }
}

export function relsPartFor(part: string): string {
  if (part === '/' || part === '') return '/_rels/.rels';
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** Resolve a relationship target against the folder of its source part. */
export function resolvePartName(baseFolder: string, target: string): string {
  const raw = target.startsWith('/') ? target : baseFolder + target;
  const segments: string[] = [];
  for (const segment of safeDecode(raw).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function stripSlash(part: string): string {
  return part.replace(/^\/+/, '');
}
