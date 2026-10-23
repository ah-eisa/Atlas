/**
 * The colour of each kind of asset, used wherever holdings are keyed by
 * kind: the allocation donut, the mark beside a ticker, the weight bars.
 *
 * Colour follows the entity, never its rank, so a stock is blue whether
 * stocks are the largest bucket or the smallest. Slots index the validated
 * categorical palette (`--viz-cat-1` ... `--viz-cat-6` in tokens.css).
 */

const SLOT: Record<string, number> = {
  Stock: 1,
  ETF: 2,
  Bond: 3,
  Fund: 4,
  Commodity: 5,
  Crypto: 6,
}

/** 1-based categorical slot for an asset class, or null for anything else. */
export function assetClassSlot(assetClass: string | null | undefined): number | null {
  if (!assetClass) return null
  return SLOT[assetClass] ?? null
}

/** A CSS colour for an asset class; unknown kinds use the neutral ink. */
export function assetClassColor(assetClass: string | null | undefined): string {
  const slot = assetClassSlot(assetClass)
  return slot ? `var(--viz-cat-${slot})` : 'var(--text-tertiary)'
}
