import { child, children, type XmlElement } from './xml.js';

/**
 * DrawingML themes: the colour and font schemes that documents refer to by
 * name (`accent1`, `minorHAnsi`) instead of by value.
 */

export interface Theme {
  colors: Record<string, string>;
  majorFont: ThemeFonts;
  minorFont: ThemeFonts;
}

export interface ThemeFonts {
  latin?: string;
  eastAsia?: string;
  cs?: string;
}

/** Office's default theme, used when a document has none. */
export const DEFAULT_THEME: Theme = {
  colors: {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '44546A',
    lt2: 'E7E6E6',
    accent1: '4472C4',
    accent2: 'ED7D31',
    accent3: 'A5A5A5',
    accent4: 'FFC000',
    accent5: '5B9BD5',
    accent6: '70AD47',
    hlink: '0563C1',
    folHlink: '954F72',
  },
  majorFont: { latin: 'Calibri Light' },
  minorFont: { latin: 'Calibri' },
};

export function parseTheme(root: XmlElement | undefined): Theme {
  if (!root) return DEFAULT_THEME;
  const elements = child(root, 'a:themeElements');
  const colors: Record<string, string> = { ...DEFAULT_THEME.colors };
  for (const entry of children(child(elements, 'a:clrScheme'))) {
    const name = entry.name.slice(2);
    const value = child(entry, 'a:srgbClr')?.attrs.val ?? child(entry, 'a:sysClr')?.attrs.lastClr;
    if (value && /^[0-9a-f]{6}$/i.test(value)) colors[name] = value.toUpperCase();
  }
  const fontScheme = child(elements, 'a:fontScheme');
  const fonts = (node: XmlElement | undefined): ThemeFonts => ({
    latin: nonEmpty(child(node, 'a:latin')?.attrs.typeface),
    eastAsia: nonEmpty(child(node, 'a:ea')?.attrs.typeface),
    cs: nonEmpty(child(node, 'a:cs')?.attrs.typeface),
  });
  const major = fonts(child(fontScheme, 'a:majorFont'));
  const minor = fonts(child(fontScheme, 'a:minorFont'));
  return {
    colors,
    majorFont: { ...DEFAULT_THEME.majorFont, ...stripUndefined(major) },
    minorFont: { ...DEFAULT_THEME.minorFont, ...stripUndefined(minor) },
  };
}

/** WordprocessingML theme colour names map onto the DrawingML scheme. */
const WORD_THEME_COLORS: Record<string, string> = {
  dark1: 'dk1',
  light1: 'lt1',
  dark2: 'dk2',
  light2: 'lt2',
  text1: 'dk1',
  background1: 'lt1',
  text2: 'dk2',
  background2: 'lt2',
  hyperlink: 'hlink',
  followedHyperlink: 'folHlink',
};

export function themeColor(theme: Theme, name: string): string | undefined {
  return theme.colors[WORD_THEME_COLORS[name] ?? name];
}

/* ------------------------------------------------------------------ *
 * Colour transforms
 * ------------------------------------------------------------------ */

/** Word's `themeTint`/`themeShade` (hex byte, 0-FF). */
export function applyTintShade(hex: string, tint?: string, shade?: string): string {
  let [r, g, b] = rgb(hex);
  if (tint) {
    const t = Number.parseInt(tint, 16) / 255;
    [r, g, b] = [r, g, b].map((c) => c * t + 255 * (1 - t)) as [number, number, number];
  }
  if (shade) {
    const s = Number.parseInt(shade, 16) / 255;
    [r, g, b] = [r, g, b].map((c) => c * s) as [number, number, number];
  }
  return toHex(r, g, b);
}

/**
 * DrawingML colour modifiers (`a:lumMod`, `a:lumOff`, `a:tint`, `a:shade`,
 * `a:alpha`, ...), applied in document order as PowerPoint does.
 * Returns the colour and its opacity.
 */
export function applyColorModifiers(hex: string, modifiers: XmlElement[]): { color: string; alpha: number } {
  let [h, s, l] = rgbToHsl(...rgb(hex));
  let alpha = 1;
  let [r, g, b] = rgb(hex);
  const syncHsl = () => ([h, s, l] = rgbToHsl(r, g, b));
  const syncRgb = () => ([r, g, b] = hslToRgb(h, s, l));
  for (const modifier of modifiers) {
    const value = Number(modifier.attrs.val ?? '0') / 100_000;
    switch (modifier.name) {
      case 'a:lumMod':
        l = clamp01(l * value);
        syncRgb();
        break;
      case 'a:lumOff':
        l = clamp01(l + value);
        syncRgb();
        break;
      case 'a:satMod':
        s = clamp01(s * value);
        syncRgb();
        break;
      case 'a:tint':
        // DrawingML tint moves towards white in linear light.
        [r, g, b] = [r, g, b].map((c) => fromLinear(toLinear(c) * value + (1 - value))) as [number, number, number];
        syncHsl();
        break;
      case 'a:shade':
        [r, g, b] = [r, g, b].map((c) => fromLinear(toLinear(c) * value)) as [number, number, number];
        syncHsl();
        break;
      case 'a:alpha':
        alpha = clamp01(value);
        break;
      case 'a:inv':
        [r, g, b] = [255 - r, 255 - g, 255 - b];
        syncHsl();
        break;
      case 'a:gray': {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        [r, g, b] = [y, y, y];
        syncHsl();
        break;
      }
      default:
        break;
    }
  }
  return { color: toHex(r, g, b), alpha };
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(0, 6), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(r: number, g: number, b: number): string {
  return [r, g, b]
    .map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function fromLinear(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return c * 255;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
