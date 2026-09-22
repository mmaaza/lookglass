/**
 * The Word document model the layout engine works from.
 *
 * Lengths keep Word's units until layout: twips (1/20 pt) for paragraph and
 * page geometry, half-points for font sizes, EMUs (1/914,400 in) for
 * drawings. Properties are *resolved*: style inheritance, numbering, theme
 * fonts and colours have all been applied, so layout never looks anything
 * up.
 */

export interface RunProps {
  /** Font per script slot, theme references already resolved. */
  fonts: { ascii?: string; hAnsi?: string; eastAsia?: string; cs?: string; hint?: string };
  /** Half-points. */
  size: number;
  sizeCs?: number;
  bold: boolean;
  italic: boolean;
  boldCs?: boolean;
  italicCs?: boolean;
  caps: boolean;
  smallCaps: boolean;
  strike: boolean;
  dstrike: boolean;
  vanish: boolean;
  underline?: string;
  underlineColor?: string;
  /** Hex RRGGBB, or undefined for automatic. */
  color?: string;
  highlight?: string;
  shading?: string;
  vertAlign?: 'superscript' | 'subscript';
  /** Extra space after each character, twips. */
  spacing: number;
  /** Horizontal scale, percent. */
  scale: number;
  /** Raised (+) or lowered (-) baseline, half-points. */
  position: number;
  rtl: boolean;
}

export interface TabStop {
  /** Twips from the paragraph's left edge (not its indent). */
  pos: number;
  align: 'left' | 'center' | 'right' | 'decimal' | 'bar' | 'num';
  leader?: 'dot' | 'hyphen' | 'underscore' | 'heavy' | 'middleDot';
}

export interface BorderSpec {
  style: string;
  /** Eighths of a point. */
  size: number;
  /** Points. */
  space: number;
  color?: string;
}

export interface ParaProps {
  styleId?: string;
  align: 'left' | 'center' | 'right' | 'both' | 'distribute';
  /** Twips. */
  indentLeft: number;
  indentRight: number;
  /** Positive: first-line indent; negative: hanging indent. */
  firstLine: number;
  spaceBefore: number;
  spaceAfter: number;
  beforeAutospacing: boolean;
  afterAutospacing: boolean;
  /** Twips for exact/atLeast, 240ths of a line for auto. */
  line: number;
  lineRule: 'auto' | 'exact' | 'atLeast';
  contextualSpacing: boolean;
  keepNext: boolean;
  keepLines: boolean;
  pageBreakBefore: boolean;
  widowControl: boolean;
  outlineLevel?: number;
  tabs: TabStop[];
  shading?: string;
  borders?: { top?: BorderSpec; bottom?: BorderSpec; left?: BorderSpec; right?: BorderSpec; between?: BorderSpec };
  bidi: boolean;
  numbering?: { numId: string; level: number };
  suppressAutoHyphens: boolean;
}

export type Inline =
  | { kind: 'text'; text: string; props: RunProps; link?: string }
  | { kind: 'tab'; props: RunProps; link?: string }
  | { kind: 'ptab'; props: RunProps; align: 'left' | 'center' | 'right'; relativeTo: 'margin' | 'indent' }
  | { kind: 'break'; type: 'line' | 'page' | 'column'; props: RunProps }
  | { kind: 'image'; props: RunProps; drawing: Drawing; link?: string }
  | { kind: 'field'; field: 'PAGE' | 'NUMPAGES' | 'SECTIONPAGES'; format?: string; props: RunProps }
  | { kind: 'noteRef'; note: 'footnote' | 'endnote'; id: string; props: RunProps }
  /** Word wrote a page break here when it last laid out the file. Used for accuracy checks. */
  | { kind: 'renderedBreak' }
  | { kind: 'bookmark'; name: string };

export interface Drawing {
  /** Image part, when the drawing is a picture. */
  part?: string;
  /** EMU. */
  width: number;
  height: number;
  crop?: { l: number; t: number; r: number; b: number };
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  alt?: string;
  /** Something we cannot draw yet (chart, SmartArt, shape): a labelled box keeps its space. */
  placeholder?: string;
  anchor?: DrawingAnchor;
}

export interface DrawingAnchor {
  behindDoc: boolean;
  horizontal: { relativeFrom: string; offset?: number; align?: string };
  vertical: { relativeFrom: string; offset?: number; align?: string };
  wrap: 'none' | 'square' | 'tight' | 'through' | 'topAndBottom';
  wrapSide: 'bothSides' | 'left' | 'right' | 'largest';
  /** EMU distances kept clear around the drawing. */
  distance: { t: number; b: number; l: number; r: number };
}

export interface Paragraph {
  kind: 'p';
  props: ParaProps;
  /** Formatting of the paragraph mark: sets the height of an empty paragraph. */
  markProps: RunProps;
  inlines: Inline[];
  /** Set on the last paragraph of a section. */
  section?: SectionProps;
  /** Numbering label for this paragraph, already formatted. */
  label?: { text: string; props: RunProps; suffix: 'tab' | 'space' | 'nothing'; align: 'left' | 'center' | 'right' };
}

export interface CellProps {
  gridSpan: number;
  vMerge?: 'restart' | 'continue';
  /** Twips. */
  width?: number;
  shading?: string;
  borders: Partial<Record<'top' | 'bottom' | 'left' | 'right', BorderSpec | null>>;
  margins: Partial<Record<'top' | 'bottom' | 'left' | 'right', number>>;
  vAlign: 'top' | 'center' | 'bottom';
}

export interface TableCell {
  props: CellProps;
  blocks: Block[];
}

export interface TableRow {
  /** Twips; with `exact` the row is exactly this tall, else at least. */
  height?: number;
  heightRule: 'auto' | 'atLeast' | 'exact';
  cantSplit: boolean;
  header: boolean;
  cells: TableCell[];
}

export interface Table {
  kind: 'tbl';
  /** Column widths in twips, from `w:tblGrid`. */
  grid: number[];
  rows: TableRow[];
  align: 'left' | 'center' | 'right';
  /** Twips, from the text margin. */
  indent: number;
  borders: Partial<Record<'top' | 'bottom' | 'left' | 'right' | 'insideH' | 'insideV', BorderSpec | null>>;
  cellMargins: Record<'top' | 'bottom' | 'left' | 'right', number>;
  /** Total width in twips when fixed. */
  width?: number;
  /** `w:tblLayout w:type="fixed"`: columns are exactly the grid. */
  fixedLayout: boolean;
  section?: SectionProps;
}

export type Block = Paragraph | Table;

export interface HeaderFooterRefs {
  default?: string;
  first?: string;
  even?: string;
}

export interface SectionProps {
  /** Twips. */
  pageWidth: number;
  pageHeight: number;
  margins: { top: number; right: number; bottom: number; left: number; header: number; footer: number; gutter: number };
  columns: { count: number; space: number; widths?: Array<{ width: number; space: number }>; separator: boolean };
  type: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn';
  titlePage: boolean;
  headers: HeaderFooterRefs;
  footers: HeaderFooterRefs;
  pageNumbers: { format: string; start?: number };
  vAlign: 'top' | 'center' | 'both' | 'bottom';
}

export interface WordDocument {
  body: Block[];
  /** Final section properties (the body's own `w:sectPr`). */
  finalSection: SectionProps;
  headers: Map<string, Block[]>;
  settings: { defaultTabStop: number; evenAndOddHeaders: boolean; compatibilityMode: number };
  title?: string;
  author?: string;
  /** Headings for the outline. */
  headings: Array<{ level: number; text: string; block: number }>;
  /** Bookmark name to top-level block index. */
  bookmarks: Map<string, number>;
  /** Things not yet drawn, counted for the details panel. */
  unsupported: Record<string, number>;
}
