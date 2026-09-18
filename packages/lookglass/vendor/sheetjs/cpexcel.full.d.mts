/**
 * Hand-written declaration for cpexcel.full.mjs (the upstream cpexcel.d.ts
 * describes the CommonJS build). The module namespace is what SheetJS's
 * `set_cptable` expects: it reads both `cptable` and `utils` from it.
 */
export const version: string;
export const cptable: Record<string | number, unknown>;
export const utils: {
  decode(cp: number, data: unknown): string;
  encode(cp: number, data: string, type?: string): unknown;
  hascp(cp: number): boolean;
};
