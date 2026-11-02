import { sha256hex } from './openMeteo.ts';

/**
 * World money from NEAR Intents. Village gold is pegged, in the story, to real gold: the
 * merchant Bruno converts world prices (which follow the weather) into village gold at the
 * price of tokenized gold (XAUT) quoted by the NEAR Intents 1Click API. When real gold gets
 * dearer, world goods get cheaper in village gold, and the other way round.
 *
 * Read-only: one public GET of the token list. No swap, no deposit, no keys; game gold never
 * leaves the game. The factor is clamped to 0.9-1.1 by the engine.
 */
export const INTENTS_TOKENS_URL = 'https://1click.chaindefuser.com/v0/tokens';
export const INTENTS_SOURCE = 'NEAR Intents 1Click /v0/tokens';
/** XAUT price (USD) at which world prices are unchanged */
export const XAUT_BASE_USD = 3800;

export interface IntentsReading {
  factor: number;
  quote: string;
  source: string;
  at: string;
  xautUsd: number;
  nearUsd?: number;
  /** SHA-256 of the full API payload, posted on chain with the world data */
  sha256: string;
}

interface TokenRow {
  assetId?: string;
  symbol?: string;
  price?: number;
  priceUpdatedAt?: string;
  contractAddress?: string | null;
}

export function readingFromTokens(payload: string): IntentsReading {
  const rows = JSON.parse(payload) as TokenRow[];
  if (!Array.isArray(rows)) throw new Error('unexpected token list');
  const xaut = rows.find((r) => r.symbol?.toUpperCase() === 'XAUT' && typeof r.price === 'number' && r.price > 0);
  if (!xaut) throw new Error('no XAUT price in the token list');
  const near = rows.find((r) => r.assetId === 'nep141:wrap.near');
  const factor = XAUT_BASE_USD / xaut.price!;
  return {
    factor,
    xautUsd: xaut.price!,
    nearUsd: near?.price,
    quote: `tokenized gold XAUT ${xaut.price!.toFixed(2)} USD`,
    source: INTENTS_SOURCE,
    at: xaut.priceUpdatedAt ?? new Date().toISOString(),
    sha256: sha256hex(payload),
  };
}

export async function fetchIntentsReading(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<IntentsReading> {
  const r = await fetchImpl(INTENTS_TOKENS_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return readingFromTokens(await r.text());
}
