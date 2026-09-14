// ============================================================================
// State persistence — offer cache stored in a hidden plugin setting
// ============================================================================
// The Titan SDK has no file-system API, so we persist the offer cache in a
// hidden string setting (JSON-encoded). This survives hot reloads (plugin
// off/on within the same client session).
//
// The cache is keyed by in-game player name so each account has its own
// offer history. On login / plugin enable, loadOfferCache() reads the
// setting, parses the JSON, and returns the cache for the current
// account. saveOfferCache() stringifies and writes it back.
//
// Duplicate account-key migration: keys that differ only by invisible
// whitespace characters (e.g. non-breaking space U+00A0 vs regular space
// U+0020) are merged on load under a canonical key (roster match preferred,
// else first-seen raw key). For items present in multiple duplicate keys,
// the entry with the highest offerPlacedAt timestamp (most recent) wins.
// Write paths also use the existing canonical key to prevent re-creating
// duplicates.
//
// Usage:
//   import { loadOfferCache, saveOfferCache, type OfferCacheData } from '../general/state-persist.js';
//   const cache = loadOfferCache(playerName);  // OfferCacheData
//   cache['Air rune'] = { ... };
//   saveOfferCache(playerName, cache);
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { getRoster } from '../antiban/account-rotation.js';

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
    /** Estimated time to fill the buy offer, in minutes. Stores the runtime
     *  ETA (based on the actual affordable quantity at placement time), not
     *  the simulation ETA from merchableItems.json (which is based on a 50m
     *  cash stack). Falls back to the simulation ETA if no runtime value
     *  was provided at placement time. Used by the stale checker and cache
     *  dump. */
    purchaseEtaMinutes?: number;
    /** Estimated time to fill the sell offer, in minutes. Stores the runtime
     *  ETA (based on the actual quantity being sold), not the simulation
     *  ETA. Updated by recordSellOffer when a runtime sell ETA is provided.
     *  Used by the stale checker and cache dump. */
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
    /** Last observed buy progress (0-1) for the no-progress abort rule.
     *  Updated by the stale-check loop in auto-loop.ts each tick when the
     *  live slot progress differs from this stored value. */
    lastBuyProgress?: number;
    /** Timestamp (ms) when lastBuyProgress last changed. Used by the
     *  no-progress abort rule to detect partial-fill buys that have stalled
     *  (progress > 0 but hasn't increased for the ETA-scaled threshold). */
    lastBuyProgressAt?: number;
    /** Last observed sell progress (0-1) for the progress-since-revision
     *  extension in the sell stale checker. Updated by the stale-check loop
     *  each tick when the live slot progress differs from this stored value.
     *  Reset to 0 on revision/re-list/confirm so the window starts fresh
     *  with each new offer. */
    lastSellProgress?: number;
    /** Timestamp (ms) when lastSellProgress last changed. Used by the
     *  progress-since-revision extension to detect sells that are actively
     *  filling but haven't completed within the original ETA — these get
     *  extra time before being revised (up to 2x ETA). */
    lastSellProgressAt?: number;
    /** Number of consecutive floor-hit revisions (price couldn't be reduced
     *  further because it was already at the tax break-even floor). After
     *  FLOOR_HIT_ABANDON_THRESHOLD (2) consecutive floor-hits, the item
     *  abandons early instead of cycling for the full 6-revision schedule.
     *  Reset to 0 whenever a price revision actually changes the price. */
    floorHitCount?: number;
    /** True if this entry was created by reverse reconciliation (cache loss
     *  after client restart) rather than by a normal buy/sell offer placement.
     *  Used by the stale checker to immediately abort zero-profit or very
     *  low profit/hr reconstructed sells — these are pre-existing offers from
     *  a previous session whose prices may be stale or no longer profitable,
     *  and the slot is better used for a fresh merchable item. Cleared on
     *  re-list (recordSellOffer/confirmSellOffer) to prevent infinite abort
     *  cycles — see reconstructedBuyPrice for the surviving flag. */
    reconstructed?: boolean;
    /** True if the buy price on this entry came from priceHistory's 1h
     *  average (via reconstructEntry) rather than from a real buy offer.
     *  Unlike `reconstructed`, this flag is NOT cleared on re-list — it
     *  survives sell abort + re-list cycles so that the completed-sell
     *  sweep can skip recording phantom losses from uncertain buy prices.
     *  Cleared only when the bot places a new buy offer (recordBuyOffer)
     *  with a known price. */
    reconstructedBuyPrice?: boolean;
    /** Quantity the buy flow intends to type into the GE config screen.
     *  Set by recordBuyOffer() so a BuyOfferFlow can be reconstructed after
     *  a plugin reload mid-flow (stateless recovery). Cleared when the buy
     *  completes or is aborted. Optional for backward compat with existing
     *  persisted entries (undefined = recompute from merchableItems.json). */
    buyQuantity?: number;
}

// --- Load / Save -----------------------------------------------------------

/** Normalize an account name for duplicate-key detection.
 *  Replaces ALL whitespace characters (including invisible ones like
 *  non-breaking spaces U+00A0, zero-width spaces, ideographic spaces, etc.)
 *  with a regular space, collapses multiple spaces to one, trims, and
 *  lowercases. This catches "hc\u00A0fruitz" vs "hc fruitz" which look
 *  identical visually but are different JSON keys. */
const normalizeAccountKey = (name: string): string => {
    if (!name) return '';
    return name
        .replace(/[\s\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]+/g, ' ')
        .trim()
        .toLowerCase();
};

/**
 * Merges duplicate account keys that are equivalent under whitespace + casing
 * normalization (e.g. "hc\u00A0fruitz" and "hc fruitz"). For each normalized
 * name with multiple raw keys, the per-item caches are merged: for items
 * present in multiple keys, the entry with the highest offerPlacedAt (most
 * recent) wins. The merged result is stored under a single canonical key
 * (roster match preferred, else first-seen raw key) and written back only
 * if a merge occurred. Idempotent.
 */
const migrateDuplicateKeys = (
    bot: StarkMercher,
    state: PersistedState,
): PersistedState => {
    const rawKeys = Object.keys(state);
    if (rawKeys.length < 2) return state;

    const groups = new Map<string, string[]>();
    for (const key of rawKeys) {
        const norm = normalizeAccountKey(key);
        if (!norm) continue;
        const arr = groups.get(norm);
        if (arr) arr.push(key);
        else groups.set(norm, [key]);
    }

    let needsMerge = false;
    for (const arr of groups.values()) {
        if (arr.length > 1) { needsMerge = true; break; }
    }
    if (!needsMerge) return state;

    const roster = getRoster(bot);
    const rosterByNorm = new Map<string, string>();
    for (const name of roster) {
        const norm = normalizeAccountKey(name);
        if (norm && !rosterByNorm.has(norm)) rosterByNorm.set(norm, name);
    }

    const merged: PersistedState = {};
    for (const [norm, keys] of groups) {
        if (keys.length === 1) {
            merged[keys[0]] = state[keys[0]];
            continue;
        }
        const canonical = rosterByNorm.get(norm) ?? keys[0];
        // Merge per-item caches: for each item, keep the entry with the
        // highest offerPlacedAt (most recently placed/updated offer).
        const itemMap = new Map<string, { entry: OfferCacheEntry; placedAt: number }>();
        for (const key of keys) {
            const cache = state[key];
            if (!cache) continue;
            for (const [itemName, entry] of Object.entries(cache)) {
                if (!entry) continue;
                const placedAt = entry.offerPlacedAt ?? 0;
                const existing = itemMap.get(itemName);
                if (!existing || placedAt > existing.placedAt) {
                    itemMap.set(itemName, { entry, placedAt });
                }
            }
        }
        const mergedCache: OfferCacheData = {};
        for (const [itemName, { entry }] of itemMap) {
            mergedCache[itemName] = entry;
        }
        merged[canonical] = mergedCache;

        titan.logf(
            '[Stark Mercher] Offer cache: merged %d duplicate account keys into "%s" (%d items).',
            keys.length, canonical, Object.keys(mergedCache).length,
        );
    }

    savePersistedState(bot, merged);
    return merged;
};

/**
 * Loads the full persisted state from the setting.
 * Returns an empty object if the setting is empty or unparseable.
 * Runs duplicate account-key migration on load.
 */
export const loadPersistedState = (bot: StarkMercher): PersistedState => {
    const raw = bot.offerCacheSetting.value;
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            const state = parsed as PersistedState;
            return migrateDuplicateKeys(bot, state);
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse offer cache: %s', String(e));
    }
    return {};
};

/**
 * Saves the full persisted state to the setting.
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
 * Falls back to a normalized key match if the exact key isn't found —
 * defensive measure for casing/whitespace differences between the game's
 * localPlayer.name and the roster entry.
 */
export const loadOfferCache = (bot: StarkMercher, accountName: string): OfferCacheData => {
    const state = loadPersistedState(bot);
    if (state[accountName]) return state[accountName];
    // Normalized fallback (handles invisible whitespace differences).
    const norm = normalizeAccountKey(accountName);
    if (!norm) return {};
    for (const [key, cache] of Object.entries(state)) {
        if (normalizeAccountKey(key) === norm) return cache;
    }
    return {};
};

/**
 * Saves the offer cache for a specific account.
 * Merges into the full persisted state and writes back.
 * Uses the existing key if one matches under normalization, to avoid
 * re-creating duplicate keys with different invisible whitespace.
 */
export const saveOfferCache = (bot: StarkMercher, accountName: string, cache: OfferCacheData): void => {
    const state = loadPersistedState(bot);
    let key = accountName;
    if (!state[key]) {
        const norm = normalizeAccountKey(accountName);
        if (norm) {
            for (const existingKey of Object.keys(state)) {
                if (normalizeAccountKey(existingKey) === norm) { key = existingKey; break; }
            }
        }
    }
    state[key] = cache;
    savePersistedState(bot, state);
};

/**
 * Clears the offer cache for a specific account (e.g. on full reset).
 * Also removes any keys that match under normalization.
 */
export const clearOfferCache = (bot: StarkMercher, accountName: string): void => {
    const state = loadPersistedState(bot);
    const norm = normalizeAccountKey(accountName);
    for (const key of Object.keys(state)) {
        if (key === accountName || normalizeAccountKey(key) === norm) {
            delete state[key];
        }
    }
    savePersistedState(bot, state);
};
