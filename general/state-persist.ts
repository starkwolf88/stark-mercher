// ============================================================================
// State persistence — offer cache stored in a hidden plugin setting
// ============================================================================
// The Titan SDK has no file-system API, so we persist the offer cache in a
// hidden string setting (JSON-encoded). This survives hot reloads (plugin
// off/on within the same client session) but NOT client restarts — Titan's
// host app does not persist hidden settings to plugin_settings.json, and
// plugin-side .value writes are not marked dirty for disk persistence.
// On client restart, the cache is empty and must be reconstructed from live
// GE state (reverse reconciliation in auto-loop.ts Step 2b — TODO).
//
// The cache is keyed by in-game player name so each account has its own
// offer history. On login / plugin enable, loadOfferCache() reads the
// hidden setting, parses the JSON, and returns the cache for the current
// account. saveOfferCache() stringifies and writes it back.
//
// Usage:
//   import { loadOfferCache, saveOfferCache, type OfferCacheData } from '../general/state-persist.js';
//   const cache = loadOfferCache(playerName);  // OfferCacheData
//   cache['Air rune'] = { ... };
//   saveOfferCache(playerName, cache);
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';

// --- Types -----------------------------------------------------------------

// The full persisted state — a map from account name to that account's cache.
export interface PersistedState {
    [accountName: string]: OfferCacheData;
}

// Per-account offer cache. Keyed by item name (case-insensitive lookup
// is handled by the caller).
export interface OfferCacheData {
    [itemName: string]: OfferCacheEntry;
}

export interface OfferCacheEntry {
    /** 'buy', 'sell', or 'idle' — the mode of the offer this entry tracks.
     *  'idle' means the sell completed and the entry is kept only for
     *  buy-limit tracking (totalBought/firstBoughtAt/limitReachedAt). */
    mode: 'buy' | 'sell' | 'idle';
    /** Buy price per item (from merchableItems.json). */
    buyPrice: number;
    /** Current target sell price per item. */
    sellPrice: number;
    /** Original sell price from merchableItems.json (first listing). */
    originalSellPrice: number;
    /** Timestamp (ms) when the offer was placed or last revised. */
    offerPlacedAt: number;
    /** History of sell prices used (first = original, last = current). */
    revisedPrices: number[];
    /** Cumulative quantity bought within the current 4-hour limit window.
     *  Reset to 0 when the 4-hour timer expires (lazily, on next check). */
    totalBought?: number;
    /** Timestamp (ms) when totalBought reached the item's buy limit.
     *  The 4-hour cooldown starts from this moment. Reset (to undefined)
     *  when the timer expires. */
    limitReachedAt?: number;
    /** Quantity currently listed in an active sell offer. Set when a sell
     *  offer is placed, cleared when the sell cycle completes (100% sold
     *  or fully aborted + collected). Used to compute actual sold quantity
     *  for daily profit tracking:
     *    soldQty = sellQuantity - inventoryQuantity (at re-list time)
     *    soldQty = sellQuantity (at completed-sell sweep, when item is
     *              no longer in any GE slot or inventory). */
    sellQuantity?: number;
    /** Partial sales tracked across price revisions for merch history.
     *  Each entry records a batch sold at a specific price before the
     *  offer was aborted/re-listed or completed. Cleared when the sell
     *  cycle completes and the summary is recorded to merch history. */
    partialSales?: { price: number; qty: number; timestamp: number }[];
    /** Estimated time to fill the buy offer, in minutes. Cached from
     *  merchableItems.json at buy time so staleness checks still work
     *  if the item is later removed from the merchable list. */
    purchaseEtaMinutes?: number;
    /** Estimated time to fill the sell offer, in minutes. Cached from
     *  merchableItems.json at buy time so staleness checks still work
     *  if the item is later removed from the merchable list. */
    saleEtaMinutes?: number;
    /** Timestamp (ms) of the FIRST purchase in the current 4-hour buy
     *  limit window. The GE resets the buy limit 4 hours after the first
     *  item is bought, regardless of how many were purchased. Set when
     *  totalBought transitions from 0 to >0; cleared when the window
     *  expires and totalBought resets. */
    firstBoughtAt?: number;
    /** Whether the sell offer was actually confirmed on the GE. Set to
     *  false by recordSellOffer() when the sell flow starts, then set to
     *  true when the SellOfferFlow completes successfully. If a hot-reload
     *  interrupts the sell flow, sellConfirmed remains false and the re-list
     *  logic skips the price revision (the offer was never placed, so it
     *  never "failed to sell"). Backward compat: undefined (existing entries)
     *  is treated as true. */
    sellConfirmed?: boolean;
}

// --- Load / Save -----------------------------------------------------------

/**
 * Loads the full persisted state from the hidden setting.
 * Returns an empty object if the setting is empty or unparseable.
 */
export const loadPersistedState = (bot: StarkMercher): PersistedState => {
    const raw = bot.offerCacheSetting.value;
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed as PersistedState;
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse offer cache: %s', String(e));
    }
    return {};
};

/**
 * Saves the full persisted state to the hidden setting.
 */
export const savePersistedState = (bot: StarkMercher, state: PersistedState): void => {
    try {
        bot.offerCacheSetting.value = JSON.stringify(state);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save offer cache: %s', String(e));
    }
};

/**
 * Loads the offer cache for a specific account.
 * Returns an empty object if the account has no cached data.
 */
export const loadOfferCache = (bot: StarkMercher, accountName: string): OfferCacheData => {
    const state = loadPersistedState(bot);
    return state[accountName] ?? {};
};

/**
 * Saves the offer cache for a specific account.
 * Merges into the full persisted state and writes back.
 */
export const saveOfferCache = (bot: StarkMercher, accountName: string, cache: OfferCacheData): void => {
    const state = loadPersistedState(bot);
    state[accountName] = cache;
    savePersistedState(bot, state);
};

/**
 * Clears the offer cache for a specific account (e.g. on full reset).
 */
export const clearOfferCache = (bot: StarkMercher, accountName: string): void => {
    const state = loadPersistedState(bot);
    delete state[accountName];
    savePersistedState(bot, state);
};

/**
 * Returns a map from lowercased item name to the number of OTHER accounts
 * (excluding `excludeAccount`) that currently have an active buy offer for
 * that item (mode === 'buy'). Used by the buy scan to avoid multiple
 * accounts buying the same item and competing on price.
 */
export const getCrossAccountBuyingItemCount = (bot: StarkMercher, excludeAccount: string): Map<string, number> => {
    const state = loadPersistedState(bot);
    const counts = new Map<string, number>();
    for (const [accountName, cache] of Object.entries(state)) {
        if (accountName === excludeAccount) continue;
        if (!cache || typeof cache !== 'object') continue;
        for (const [itemName, entry] of Object.entries(cache)) {
            if (entry && entry.mode === 'buy') {
                const lower = itemName.trim().toLowerCase();
                counts.set(lower, (counts.get(lower) ?? 0) + 1);
            }
        }
    }
    return counts;
};
