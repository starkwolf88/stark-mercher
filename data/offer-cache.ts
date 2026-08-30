// ============================================================================
// Offer cache — in-memory cache with price revision logic
// ============================================================================
// Wraps the persisted OfferCacheData with convenience functions for:
// - Recording buy/sell offers
// - Looking up cached sell prices
// - Revising sell prices when an offer doesn't sell
// - Removing entries when items are collected/sold
// - Fetching fallback prices from the OSRS Wiki API (stub)
//
// The cache is loaded from the hidden setting at startup and saved back
// after every mutation. The caller (auto-loop) is responsible for calling
// save() after batch operations.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import type { OfferCacheData, OfferCacheEntry } from '../general/state-persist.js';
import { loadOfferCache, saveOfferCache } from '../general/state-persist.js';
import { getMerchableItem, type MerchableItem } from './merchable-items.js';

// --- Price revision constants ----------------------------------------------
// The revision strategy reduces the sale price by a small amount each time
// an offer is re-listed after not selling. The reduction is:
//   1. 0.05% of the current sale price (the "percent reduction")
//   2. Capped at 5% of the gross profit (buyPrice vs current sale price)
//   3. Minimum 1 gp (so even very cheap items get a meaningful reduction)
//   4. Never goes below buyPrice + 1 (safety floor — never sell at a loss)
//
// Examples:
//   90 gp item, buy=85, sell=90, profit=5:
//     percentReduction = 0.045 → floors to 0, but min 1 gp
//     maxReduction = 5 * 0.05 = 0.25 → floors to 0
//     reduction = max(1, min(0, 0)) = 1 gp
//     new sell = 89 gp
//
//   5m item, buy=4.9m, sell=5m, profit=100k:
//     percentReduction = 2500 gp
//     maxReduction = 100000 * 0.05 = 5000 gp
//     reduction = min(2500, 5000) = 2500 gp
//     new sell = 4,997,500 gp
//
//   5m item, buy=4.99m, sell=5m, profit=10k:
//     percentReduction = 2500 gp
//     maxReduction = 10000 * 0.05 = 500 gp
//     reduction = min(2500, 500) = 500 gp
//     new sell = 4,999,500 gp

const PERCENT_REDUCTION_RATE = 0.0005;  // 0.05% of current sale price
const MAX_PROFIT_REDUCTION_RATE = 0.05; // 5% of gross profit
const MIN_REDUCTION_GP = 1;             // never reduce by 0
const PROFIT_THRESHOLD_FOR_REVISION = 5; // skip revision if profit < 5 gp

// --- Wiki API stub ---------------------------------------------------------
// When an item is no longer in merchableItems.json, we need to fetch the
// current 1-hour price from the OSRS Wiki API to determine the active
// sale price. The URL will be provided later — for now this is a stub
// that returns null (the caller will skip the sell offer if no price
// can be determined).

const WIKI_API_URL = ''; // TODO: user will provide the URL

/**
 * Fetches the 1-hour average price for an item from the OSRS Wiki API.
 * Returns the price, or null if the API is not configured or the fetch fails.
 *
 * TODO: Implement the actual fetch once the URL is provided.
 */
export const fetchWikiPrice = async (itemId: number): Promise<number | null> => {
    if (!WIKI_API_URL) {
        titan.logf('[Stark Mercher] Wiki API URL not configured — cannot fetch price for item %d', itemId);
        return null;
    }
    // TODO: Implement fetch logic:
    // 1. Fetch from WIKI_API_URL with the item ID
    // 2. Parse the response for the 1-hour average price
    // 3. Return the price or null on failure
    return null;
};

// --- Cache wrapper ---------------------------------------------------------

export class OfferCacheManager {
    private bot: StarkMercher;
    private accountName: string;
    private cache: OfferCacheData;
    private dirty = false;

    constructor(bot: StarkMercher, accountName: string) {
        this.bot = bot;
        this.accountName = accountName;
        this.cache = loadOfferCache(bot, accountName);
    }

    /**
     * Reloads the cache from the persisted state. Call this after a hot-reload
     * or account switch.
     */
    reload(accountName?: string): void {
        if (accountName) this.accountName = accountName;
        this.cache = loadOfferCache(this.bot, this.accountName);
        this.dirty = false;
    }

    /**
     * Saves the cache to the persisted state if there are unsaved changes.
     */
    save(): void {
        if (this.dirty) {
            saveOfferCache(this.bot, this.accountName, this.cache);
            this.dirty = false;
        }
    }

    /**
     * Forces a save regardless of the dirty flag.
     */
    forceSave(): void {
        saveOfferCache(this.bot, this.accountName, this.cache);
        this.dirty = false;
    }

    // --- Lookup ---

    /**
     * Returns the cache entry for an item, or null if not cached.
     * Case-insensitive name match.
     */
    get(itemName: string): OfferCacheEntry | null {
        const lower = itemName.trim().toLowerCase();
        for (const key in this.cache) {
            if (key.trim().toLowerCase() === lower) {
                return this.cache[key];
            }
        }
        return null;
    }

    /**
     * Returns true if the item has a cache entry.
     */
    has(itemName: string): boolean {
        return this.get(itemName) !== null;
    }

    /**
     * Returns the current sell price for an item:
     * 1. If cached, returns the cached sellPrice (last revised price).
     * 2. If not cached but in merchableItems.json, returns the sale price.
     * 3. If not in either, returns null (caller should fetch from Wiki API).
     */
    getSellPrice(itemName: string): number | null {
        const entry = this.get(itemName);
        if (entry) return entry.sellPrice;
        const merch = getMerchableItem(itemName);
        if (merch) return merch.salePrice;
        return null;
    }

    /**
     * Returns the buy price for an item from the cache, or from
     * merchableItems.json, or null.
     */
    getBuyPrice(itemName: string): number | null {
        const entry = this.get(itemName);
        if (entry) return entry.buyPrice;
        const merch = getMerchableItem(itemName);
        if (merch) return merch.purchasePrice;
        return null;
    }

    // --- Recording ---

    /**
     * Records a buy offer being placed. Stores the buy price, expected sell
     * price, and timestamp. If the item already has a cache entry, updates it.
     */
    recordBuyOffer(item: MerchableItem): void {
        const key = item.itemName;
        const existing = this.get(key);
        const revisedPrices = existing?.revisedPrices ?? [];
        this.cache[key] = {
            mode: 'buy',
            buyPrice: item.purchasePrice,
            sellPrice: item.salePrice,
            originalSellPrice: item.salePrice,
            offerPlacedAt: Date.now(),
            revisedPrices,
        };
        this.dirty = true;
        titan.logf('[Stark Mercher] Cache: recorded buy offer for %s (buy=%d, sell=%d)',
            key, item.purchasePrice, item.salePrice);
    }

    /**
     * Records a sell offer being placed. Stores the sell price and timestamp.
     * If the item already has a cache entry (from a prior buy), updates the
     * sell price and appends to revisedPrices.
     *
     * Also tracks the cumulative bought quantity for the GE 4-hour buy limit.
     * The sell quantity represents the actual number of items bought (a buy
     * offer may partially fill, so quantityToPurchase may not equal actual).
     * When totalBought reaches the item's limit, limitReachedAt is set to now,
     * starting the 4-hour cooldown.
     *
     * @param quantity - The actual quantity being sold (= actual bought qty).
     * @param limit - The GE buy limit for this item (from merchableItems.json).
     *   If not provided, buy-limit tracking is skipped for this call.
     */
    recordSellOffer(itemName: string, sellPrice: number, buyPrice?: number, quantity?: number, limit?: number): void {
        const key = itemName;
        const existing = this.get(key);
        const now = Date.now();
        if (existing) {
            // Update the sell price and timestamp.
            existing.mode = 'sell';
            existing.sellPrice = sellPrice;
            existing.offerPlacedAt = now;
            // Append the new price to the revision history.
            if (existing.revisedPrices.length === 0 || existing.revisedPrices[existing.revisedPrices.length - 1] !== sellPrice) {
                existing.revisedPrices.push(sellPrice);
            }
            if (buyPrice !== undefined) existing.buyPrice = buyPrice;
        } else {
            this.cache[key] = {
                mode: 'sell',
                buyPrice: buyPrice ?? 0,
                sellPrice,
                originalSellPrice: sellPrice,
                offerPlacedAt: now,
                revisedPrices: [sellPrice],
            };
        }

        // Track cumulative bought quantity for the GE 4-hour buy limit.
        // The sell quantity = actual bought quantity. We add it to totalBought
        // and if it reaches the limit, we start the 4-hour cooldown timer.
        if (quantity !== undefined && limit !== undefined && limit > 0) {
            const entry = this.get(key)!;
            const total = (entry.totalBought ?? 0) + quantity;
            entry.totalBought = total;
            if (total >= limit && entry.limitReachedAt === undefined) {
                entry.limitReachedAt = now;
                titan.logf('[Stark Mercher] Cache: %s buy limit reached (%d/%d) — 4h cooldown started',
                    key, total, limit);
            } else {
                titan.logf('[Stark Mercher] Cache: %s bought qty tracked (%d/%d towards limit)',
                    key, total, limit);
            }
        }

        this.dirty = true;
        titan.logf('[Stark Mercher] Cache: recorded sell offer for %s @ %dgp', key, sellPrice);
    }

    // --- Price revision ---

    /**
     * Computes a revised sell price for an item that hasn't sold.
     *
     * Strategy:
     *   1. If gross profit < 5 gp, skip revision (too thin to cut).
     *   2. reduction = 0.05% of current sell price, capped at 5% of gross profit, min 1 gp.
     *   3. newPrice = currentSellPrice - reduction, floored to buyPrice + 1.
     *
     * Returns the new price, or null if no revision is possible (profit too
     * thin or price already at floor).
     */
    computeRevisedSellPrice(itemName: string): number | null {
        const entry = this.get(itemName);
        if (!entry) return null;

        const currentSell = entry.sellPrice;
        const buyPrice = entry.buyPrice;
        const grossProfit = currentSell - buyPrice;

        // If profit is too thin, don't revise — the item should be aborted
        // instead of continually undercutting into a loss.
        if (grossProfit < PROFIT_THRESHOLD_FOR_REVISION) {
            titan.logf('[Stark Mercher] Cache: %s profit too thin (%dgp) — skipping price revision',
                itemName, grossProfit);
            return null;
        }

        // 0.05% of current sale price.
        const percentReduction = Math.floor(currentSell * PERCENT_REDUCTION_RATE);

        // 5% of gross profit.
        const maxReduction = Math.floor(grossProfit * MAX_PROFIT_REDUCTION_RATE);

        // The actual reduction is the smaller of the two, but at least 1 gp.
        const reduction = Math.max(MIN_REDUCTION_GP, Math.min(percentReduction, maxReduction));

        // Never go below buyPrice + 1 (never sell at a loss).
        const floor = buyPrice + 1;
        const newPrice = Math.max(floor, currentSell - reduction);

        if (newPrice >= currentSell) {
            // Already at the floor — can't reduce further.
            titan.logf('[Stark Mercher] Cache: %s already at price floor (%dgp) — cannot revise',
                itemName, currentSell);
            return null;
        }

        return newPrice;
    }

    /**
     * Revises the sell price for an item and records the new price in the
     * cache. Returns the new price, or null if no revision was made.
     */
    reviseSellPrice(itemName: string): number | null {
        const newPrice = this.computeRevisedSellPrice(itemName);
        if (newPrice === null) return null;

        const entry = this.get(itemName);
        if (!entry) return null;

        entry.sellPrice = newPrice;
        entry.offerPlacedAt = Date.now();
        if (entry.revisedPrices.length === 0 || entry.revisedPrices[entry.revisedPrices.length - 1] !== newPrice) {
            entry.revisedPrices.push(newPrice);
        }
        this.dirty = true;
        titan.logf('[Stark Mercher] Cache: revised %s sell price %d -> %d gp',
            itemName, entry.revisedPrices[entry.revisedPrices.length - 2] ?? entry.originalSellPrice, newPrice);
        return newPrice;
    }

    // --- Removal ---

    /**
     * Removes an item from the cache. Called when a sell offer completes
     * (item is collected and no longer in any slot or inventory).
     */
    remove(itemName: string): void {
        const lower = itemName.trim().toLowerCase();
        let removed = false;
        for (const key in this.cache) {
            if (key.trim().toLowerCase() === lower) {
                delete this.cache[key];
                removed = true;
                break;
            }
        }
        if (removed) {
            this.dirty = true;
            titan.logf('[Stark Mercher] Cache: removed %s', itemName);
        }
    }

    /**
     * Returns all cached item names.
     */
    getAllItemNames(): string[] {
        return Object.keys(this.cache);
    }

    // --- GE 4-hour buy limit tracking ---

    /** 4 hours in milliseconds. */
    static readonly BUY_LIMIT_COOLDOWN_MS = 4 * 60 * 60 * 1000;

    /**
     * Returns true if the item is currently buy-limited (within the 4-hour
     * cooldown window). Lazily resets the limit if the cooldown has expired.
     *
     * An item is buy-limited if:
     *   1. It has a cache entry with limitReachedAt set.
     *   2. limitReachedAt + 4 hours > now.
     *
     * If the cooldown has expired, totalBought and limitReachedAt are cleared
     * (the limit has reset) and false is returned.
     */
    isBuyLimited(itemName: string): boolean {
        const entry = this.get(itemName);
        if (!entry || entry.limitReachedAt === undefined) return false;
        const now = Date.now();
        if (now - entry.limitReachedAt >= OfferCacheManager.BUY_LIMIT_COOLDOWN_MS) {
            // Cooldown expired — reset the limit tracking.
            entry.totalBought = 0;
            entry.limitReachedAt = undefined;
            this.dirty = true;
            titan.logf('[Stark Mercher] Cache: %s buy limit cooldown expired — limit reset', itemName);
            return false;
        }
        return true;
    }

    /**
     * Returns a set of item names (lowercase) that are currently buy-limited.
     * Used by the buying flow to skip items that can't be purchased yet.
     * Lazily resets expired limits.
     */
    getBuyLimitedItemNames(): Set<string> {
        const limited = new Set<string>();
        for (const key in this.cache) {
            if (this.isBuyLimited(key)) {
                limited.add(key.trim().toLowerCase());
            }
        }
        return limited;
    }

    /**
     * Returns the raw cache data (for inspection/debugging).
     */
    getRaw(): OfferCacheData {
        return this.cache;
    }
}
