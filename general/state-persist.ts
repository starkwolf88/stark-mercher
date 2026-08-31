// ============================================================================
// State persistence — offer cache stored in a hidden plugin setting
// ============================================================================
// The Titan SDK has no file-system API, so we persist the offer cache in a
// hidden string setting (JSON-encoded). This survives client restarts and
// plugin reloads. The pattern mirrors the mixology bot's humanizationState.
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
    /** 'buy' or 'sell' — the mode of the offer this entry tracks. */
    mode: 'buy' | 'sell';
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
