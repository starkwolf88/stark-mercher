// ============================================================================
// Price history — fallback price lookup for orphaned inventory items
// ============================================================================
// The JSON is inlined at build time by esbuild (same pattern as
// merchable-items.ts). Written by determine-flips.mjs every run using the
// 1h average prices already fetched — no extra API calls. Contains EVERY
// item from the Wiki 1h API response (not just merchable items), so items
// that dropped out of merchableItems.json still have price data here.
//
// Usage:
//   import { getPriceHistoryEntry, isPriceHistoryFresh } from './data/price-history.js';
//   const entry = getPriceHistoryEntry('Steel cannonball');
//   if (entry && isPriceHistoryFresh(entry)) { sellPrice = entry.sell; }
//
// This is a FALLBACK only — the offer cache and merchableItems.json are the
// primary sources for sell prices. This is used when an item is in inventory
// but has no cache entry and no merchableItems.json entry (e.g. after a long
// script stop or a JSON refresh during sleep). The freshness check prevents
// selling at stale prices if determine-flips.mjs has stopped running.
// ============================================================================

import priceHistoryRaw from '../priceHistory.json';

// --- Types -----------------------------------------------------------------

export interface PriceHistoryEntry {
    name: string;
    /** 1h average low price (buy price). */
    buy: number;
    /** 1h average high price (sell price). */
    sell: number;
    /** 1h total low price volume (buy volume). Used by reconstructEntry to
     *  compute approximate buy ETAs for priceHistory-only items. */
    buyVolume?: number;
    /** 1h total high price volume (sell volume). Used by reconstructEntry to
     *  compute approximate sell ETAs for priceHistory-only items. */
    sellVolume?: number;
    /** Epoch ms when the price data was fetched. */
    fetchedAt: number;
}

// --- Freshness -------------------------------------------------------------

/** Maximum age of price history data (in ms) before it's considered stale.
 *  Matches the merchableItems.json freshness TTL (10 minutes). If
 *  determine-flips.mjs hasn't run in the last 10 minutes, the price data
 *  is considered stale and the sell scan skips the item rather than
 *  risking a sale at an outdated price. */
const MAX_PRICE_HISTORY_AGE_MS = 10 * 60 * 1000; // 10 minutes

/** Returns true if the price history entry's data is fresh (within the
 *  10-minute TTL). Used by the sell scan and reconstructEntry to guard
 *  against selling at stale prices after determine-flips.mjs stops running. */
export const isPriceHistoryFresh = (entry: PriceHistoryEntry): boolean => {
    return entry.fetchedAt > 0 && (Date.now() - entry.fetchedAt) <= MAX_PRICE_HISTORY_AGE_MS;
};

// --- Loading ---------------------------------------------------------------

// The raw JSON is keyed by item ID (string). We build two lookups: a
// name→entry map for case-insensitive name matching, and an id→entry map
// for resolving truncated GE slot names (e.g. "Antidote++..." → itemId 5952
// → "Antidote++(4)"). The id map is built in the same pass — no extra cost.
let cachedByName: Map<string, PriceHistoryEntry> | null = null;
let cachedById: Map<number, PriceHistoryEntry> | null = null;

const ensureLoaded = (): Map<string, PriceHistoryEntry> => {
    if (cachedByName) return cachedByName;
    const raw = priceHistoryRaw as unknown as Record<string, PriceHistoryEntry>;
    const byName = new Map<string, PriceHistoryEntry>();
    const byId = new Map<number, PriceHistoryEntry>();
    for (const [idStr, entry] of Object.entries(raw)) {
        if (!entry.name || entry.sell <= 0) continue;
        byName.set(entry.name.trim().toLowerCase(), entry);
        const id = parseInt(idStr, 10);
        if (Number.isFinite(id) && id > 0) byId.set(id, entry);
    }
    cachedByName = byName;
    cachedById = byId;
    return byName;
};

// --- Public API ------------------------------------------------------------

/**
 * Returns the price history entry for the given item name (case-insensitive),
 * or null if not found. Used as a fallback sell-price source for items that
 * are in inventory but not in merchableItems.json or the offer cache.
 * Callers should check isPriceHistoryFresh(entry) before using the price.
 */
export const getPriceHistoryEntry = (itemName: string): PriceHistoryEntry | null => {
    const map = ensureLoaded();
    return map.get(itemName.trim().toLowerCase()) ?? null;
};

/**
 * Returns the price history entry for the given OSRS item ID, or null if not
 * found. Used by `resolveTruncatedItemName` in widgets.ts to resolve GE slot
 * names that the widget truncates with "..." (e.g. "Antidote++..." → itemId
 * 5952 → "Antidote++(4)"). The GE slot widget exposes the itemId (child 18)
 * even when the name text (child 19) is truncated, so the full name can be
 * recovered without any extra native SDK calls.
 */
export const getPriceHistoryEntryById = (itemId: number): PriceHistoryEntry | null => {
    ensureLoaded(); // populates cachedById
    return cachedById?.get(itemId) ?? null;
};
