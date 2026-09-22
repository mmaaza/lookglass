import type { Theme } from '../../ooxml/theme.js';
import { child, children, intAttr, onOff, val, type XmlElement } from '../../ooxml/xml.js';
import { parsePPr, parseRPr, type PPr, type RPr } from './styles.js';

/**
 * Word list numbering.
 *
 * `w:num` instances point at `w:abstractNum` definitions. Counters belong to
 * the abstract definition, so two lists using the same definition continue
 * each other — which is what Word does, and why "Restart numbering" in Word
 * creates a new `w:num` carrying a `w:startOverride`.
 */

export interface Level {
  start: number;
  format: string;
  text: string;
  align: 'left' | 'center' | 'right';
  suffix: 'tab' | 'space' | 'nothing';
  /** Restart after this level (1-based) or above is used; 0 = never. */
  restart?: number;
  legal: boolean;
  pPr: PPr;
  rPr: RPr;
}

interface AbstractNum {
  id: string;
  levels: Map<number, Level>;
  styleLink?: string;
  numStyleLink?: string;
}

interface NumInstance {
  abstractId: string;
  overrides: Map<number, { start?: number; level?: Level }>;
}

export class Numbering {
  private readonly abstracts = new Map<string, AbstractNum>();
  private readonly nums = new Map<string, NumInstance>();
  private readonly counters = new Map<string, number[]>();
  private readonly startedOverrides = new Set<string>();
  /** Numbering style id → the num it wraps, for `w:numStyleLink`. */
  private readonly styleNums = new Map<string, string>();

  constructor(root: XmlElement | undefined, theme: Theme, styleNumId: (styleId: string) => string | undefined) {
    for (const abstract of children(root, 'w:abstractNum')) {
      const id = abstract.attrs['w:abstractNumId'];
      if (id === undefined) continue;
      const levels = new Map<number, Level>();
      for (const lvl of children(abstract, 'w:lvl')) {
        const index = intAttr(lvl, 'w:ilvl');
        if (index !== undefined) levels.set(index, parseLevel(lvl, theme));
      }
      this.abstracts.set(id, {
        id,
        levels,
        styleLink: val(abstract, 'w:styleLink'),
        numStyleLink: val(abstract, 'w:numStyleLink'),
      });
    }
    for (const num of children(root, 'w:num')) {
      const id = num.attrs['w:numId'];
      const abstractId = val(num, 'w:abstractNumId');
      if (id === undefined || abstractId === undefined) continue;
      const overrides = new Map<number, { start?: number; level?: Level }>();
      for (const override of children(num, 'w:lvlOverride')) {
        const index = intAttr(override, 'w:ilvl');
        if (index === undefined) continue;
        const lvl = child(override, 'w:lvl');
        overrides.set(index, {
          start: intAttr(child(override, 'w:startOverride'), 'w:val'),
          level: lvl ? parseLevel(lvl, theme) : undefined,
        });
      }
      this.nums.set(id, { abstractId, overrides });
    }
    for (const abstract of this.abstracts.values()) {
      if (abstract.styleLink) {
        const numId = styleNumId(abstract.styleLink);
        if (numId) this.styleNums.set(abstract.styleLink, numId);
      }
    }
  }

  /** Level definition for a paragraph, following numbering-style links. */
  level(numId: string, index: number): Level | undefined {
    const resolved = this.resolve(numId);
    if (!resolved) return undefined;
    return resolved.num.overrides.get(index)?.level ?? resolved.abstract.levels.get(index);
  }

  /**
   * Advance the counters for a numbered paragraph and return its label, e.g.
   * "2.1." or "•". Call in document order, once per paragraph.
   */
  next(numId: string, index: number): { text: string; level: Level } | undefined {
    const resolved = this.resolve(numId);
    if (!resolved) return undefined;
    const { num, abstract } = resolved;
    const level = this.level(numId, index);
    if (!level) return undefined;

    let counters = this.counters.get(abstract.id);
    if (!counters) {
      counters = Array.from({ length: 9 }, () => Number.NaN);
      this.counters.set(abstract.id, counters);
    }
    // A start override applies the first time this num instance is used.
    const overrideKey = `${numId}:${index}`;
    const override = num.overrides.get(index);
    if (override?.start !== undefined && !this.startedOverrides.has(overrideKey)) {
      this.startedOverrides.add(overrideKey);
      counters[index] = override.start - 1;
      for (let deeper = index + 1; deeper < 9; deeper++) counters[deeper] = Number.NaN;
    }

    counters[index] = Number.isNaN(counters[index]!) ? level.start : counters[index]! + 1;
    // Deeper levels restart when a shallower one is used (unless told otherwise).
    for (let deeper = index + 1; deeper < 9; deeper++) {
      const deeperLevel = this.level(numId, deeper);
      const restartAfter = deeperLevel?.restart;
      if (restartAfter === 0) continue;
      if (restartAfter === undefined || index + 1 <= restartAfter) counters[deeper] = Number.NaN;
    }

    const text = level.text.replace(/%([1-9])/g, (_, digit: string) => {
      const target = Number(digit) - 1;
      const targetLevel = this.level(numId, target);
      const value = Number.isNaN(counters![target]!) ? (targetLevel?.start ?? 1) : counters![target]!;
      const format = level.legal && target < index ? 'decimal' : (targetLevel?.format ?? 'decimal');
      return formatNumber(value, format);
    });
    return { text: level.format === 'none' ? '' : text, level };
  }

  private resolve(numId: string): { num: NumInstance; abstract: AbstractNum } | undefined {
    let num = this.nums.get(numId);
    let abstract = num ? this.abstracts.get(num.abstractId) : undefined;
    // A definition that only points at a numbering style takes that style's list.
    for (let hops = 0; abstract?.numStyleLink && hops < 4; hops++) {
      const linkedNum = this.styleNums.get(abstract.numStyleLink);
      const linked = linkedNum ? this.nums.get(linkedNum) : undefined;
      if (!linked) break;
      abstract = this.abstracts.get(linked.abstractId);
      num = { abstractId: linked.abstractId, overrides: num?.overrides ?? new Map() };
    }
    return num && abstract ? { num, abstract } : undefined;
  }
}

function parseLevel(lvl: XmlElement, theme: Theme): Level {
  const suffix = val(lvl, 'w:suff');
  const jc = val(lvl, 'w:lvlJc');
  const restart = intAttr(child(lvl, 'w:lvlRestart'), 'w:val');
  return {
    start: intAttr(child(lvl, 'w:start'), 'w:val') ?? 1,
    format: val(lvl, 'w:numFmt') ?? 'decimal',
    text: val(lvl, 'w:lvlText') ?? '',
    align: jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left',
    suffix: suffix === 'space' ? 'space' : suffix === 'nothing' ? 'nothing' : 'tab',
    restart,
    legal: onOff(lvl, 'w:isLgl') ?? false,
    pPr: parsePPr(child(lvl, 'w:pPr'), theme),
    rPr: parseRPr(child(lvl, 'w:rPr'), theme),
  };
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function formatNumber(value: number, format: string): string {
  switch (format) {
    case 'decimal':
      return String(value);
    case 'decimalZero':
      return value < 10 ? `0${value}` : String(value);
    case 'upperRoman':
      return roman(value);
    case 'lowerRoman':
      return roman(value).toLowerCase();
    case 'upperLetter':
      return letters(value);
    case 'lowerLetter':
      return letters(value).toLowerCase();
    case 'ordinal':
      return `${value}${ordinalSuffix(value)}`;
    case 'cardinalText':
      return capitalise(words(value));
    case 'ordinalText':
      return capitalise(ordinalWords(value));
    case 'decimalEnclosedCircle':
      return value >= 1 && value <= 20 ? String.fromCodePoint(0x2460 + value - 1) : String(value);
    case 'decimalEnclosedParen':
      return `(${value})`;
    case 'decimalFullWidth':
      return String(value).replace(/\d/g, (d) => String.fromCodePoint(0xff10 + Number(d)));
    case 'none':
      return '';
    // Bullets keep their literal level text; the counter is not shown.
    case 'bullet':
      return '';
    default:
      return String(value);
  }
}

function roman(value: number): string {
  if (value <= 0 || value >= 4000) return String(value);
  const table: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  let rest = value;
  for (const [amount, symbol] of table) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

/** Word's letter numbering repeats the letter: A..Z, AA..ZZ, AAA... */
function letters(value: number): string {
  if (value <= 0) return String(value);
  const letter = String.fromCharCode(65 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

function ordinalSuffix(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][value % 10] ?? 'th';
}

function words(value: number): string {
  if (value < 20) return value === 0 ? 'zero' : ONES[value]!;
  if (value < 100) return TENS[Math.floor(value / 10)]! + (value % 10 ? `-${ONES[value % 10]}` : '');
  if (value < 1000) return `${ONES[Math.floor(value / 100)]} hundred${value % 100 ? ` ${words(value % 100)}` : ''}`;
  return String(value);
}

function ordinalWords(value: number): string {
  const cardinal = words(value);
  const irregular: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
  const match = /([a-z]+)$/.exec(cardinal);
  if (!match) return cardinal;
  const last = match[1]!;
  const replaced = irregular[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return cardinal.slice(0, -last.length) + replaced;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
