/**
 * All gold amounts are integers in centigold (1 gold = 100 units).
 * This mirrors the contract, which stores gold as u128 with 2 decimals,
 * and keeps the simulation free of floating-point drift.
 */
export type Gold = number;

export const GOLD = 100;

/** 5.5 gold -> 550 */
export const g = (gold: number): Gold => Math.round(gold * GOLD);

/** 550 -> "5.5" */
export const fmt = (amount: Gold, digits = 1): string => (amount / GOLD).toFixed(digits);

/** basis-point multiply, rounded toward zero */
export const bps = (amount: Gold, basisPoints: number): Gold => Math.trunc((amount * basisPoints) / 10_000);

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
