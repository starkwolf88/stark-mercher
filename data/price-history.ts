// ============================================================================
// Price history — fallback price lookup for orphaned inventory items
// ============================================================================
// The JSON is inlined at build time by esbuild (same pattern as
// merchable-items.ts). Written by determine-flips.mjs every run using the
// 1h average prices already fetched — no extra API calls.
//
// Usage:
//   import { getPriceHistoryEntry } from './data/price-history.js';
//   const entry = getPriceHistoryEntry('Steel cannonball');
//   if (entry) { sellPrice = entry.sell; buyPrice = entry.buy; }
//
// This is a FALLBACK only — the offer cache and merchableItems.json are the
// primary sources for sell prices. This is used when an item is in inventory
// but has no cache entry and no merchableItems.json entry (e.g. after a long
// script stop or a JSON refresh during sleep).
// ============================================================================

import priceHistoryRaw from '../priceHistory.json';

// --- Types -----------------------------------------------------------------

export interface PriceHistoryEntry {
    name: string;
    /** 1h average low price (buy price). */
    buy: number;
    /** 1h average high price (sell price). */
    sell: number;
    /** Epoch ms when the price data was fetched. */
    fetchedAt: number;
}

// The raw JSON is keyed by item ID (string). We build a name→entry lookup
// for case-insensitive name matching.
let cachedByName: Map<string, PriceHistoryEntry> | null = null;

const ensureLoaded = (): Map<string, PriceHistoryEntry> => {
    if (cachedByName) return cachedByName;
    const raw = priceHistoryRaw as unknown as Record<string, PriceHistoryEntry>;
    const map = new Map<string, PriceHistoryEntry>();
    for (const entry of Object.values(raw)) {
        if (entry.name && entry.sell > 0) {
            map.set(entry.name.trim().toLowerCase(), entry);
        }
    }
    cachedByName = map;
    return map;
};

// --- Public API ------------------------------------------------------------

/**
 * Returns the price history entry for the given item name (case-insensitive),
 * or null if not found. Used as a fallback sell-price source for items that
 * are in inventory but not in merchableItems.json or the offer cache.
 */
export const getPriceHistoryEntry = (itemName: string): PriceHistoryEntry | null => {
    const map = ensureLoaded();
    return map.get(itemName.trim().toLowerCase()) ?? null;
};
