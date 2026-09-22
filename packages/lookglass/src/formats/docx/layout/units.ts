/** Word units to CSS pixels (96 per inch). */

/** 1 twip = 1/20 pt = 1/1440 in. */
export const twip = (value: number): number => value / 15;
/** Font sizes are in half-points. */
export const halfPoint = (value: number): number => (value * 2) / 3;
/** 914,400 EMU per inch. */
export const emu = (value: number): number => value / 9525;
/** Border widths are in eighths of a point. */
export const eighthPoint = (value: number): number => value / 6;
export const point = (value: number): number => (value * 4) / 3;
