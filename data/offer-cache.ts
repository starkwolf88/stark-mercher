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
//   1. 5% of the gross profit (sellPrice - buyPrice)
//   2. Minimum 1 gp (so even very thin-margin items get a nudge)
//   3. Never goes below buyPrice + 1 (safety floor — never sell at a loss)
//
// There is no profit threshold — even items with 1-2gp margins get revised
// (by the 1gp minimum) so they don't sit in a slot forever.
//
// Examples:
//   91 gp item, buy=87, sell=91, profit=4:
//     reduction = max(1, floor(4 * 0.05)) = max(1, 0) = 1 gp
//     new sell = 90 gp
//
//   1743 gp item, buy=1685, sell=1743, profit=58:
//     reduction = max(1, floor(58 * 0.05)) = max(1, 2) = 2 gp
//     new sell = 1741 gp
//
//   5m item, buy=4.9m, sell=5m, profit=100k:
//     reduction = max(1, floor(100000 * 0.05)) = 5000 gp
//     new sell = 4,995,000 gp

const PROFIT_REDUCTION_RATE = 0.05;     // 5% of gross profit
const MIN_REDUCTION_GP = 1;             // never reduce by 0

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
        // Preserve buy-limit tracking from the previous cycle so the bot
        // knows how much of the 4-hour buy limit has been consumed.
        const totalBought = existing?.totalBought;
        const firstBoughtAt = existing?.firstBoughtAt;
        const limitReachedAt = existing?.limitReachedAt;
        this.cache[key] = {
            mode: 'buy',
            buyPrice: item.purchasePrice,
            sellPrice: item.salePrice,
            originalSellPrice: item.salePrice,
            offerPlacedAt: Date.now(),
            revisedPrices,
            purchaseEtaMinutes: item.purchaseEtaMinutes,
            saleEtaMinutes: item.saleEtaMinutes,
            totalBought,
            firstBoughtAt,
            limitReachedAt,
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
     *   Also stored as `sellQuantity` for daily profit tracking.
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

        // Store the quantity being listed for daily profit tracking.
        // At re-list time, soldQty = sellQuantity - inventoryQuantity.
        // At completed-sell sweep, soldQty = sellQuantity (item gone entirely).
        if (quantity !== undefined) {
            const entry = this.get(key)!;
            entry.sellQuantity = quantity;
        }

        // Track cumulative bought quantity for the GE 4-hour buy limit.
        // The sell quantity = actual bought quantity. We add it to totalBought
        // and if it reaches the limit, we start the 4-hour cooldown timer.
        // Only count on the FIRST sell recording for a buy cycle — if
        // sellQuantity is already set, this is a re-list after abort/revision
        // and the quantity was already counted.
        if (quantity !== undefined && limit !== undefined && limit > 0) {
            const entry = this.get(key)!;
            const alreadyTracked = entry.sellQuantity !== undefined;
            if (!alreadyTracked) {
                const prevTotal = entry.totalBought ?? 0;
                const total = prevTotal + quantity;
                entry.totalBought = total;
                // The 4-hour window starts from the FIRST purchase. Only set
                // firstBoughtAt when transitioning from 0 to >0.
                if (prevTotal === 0) {
                    entry.firstBoughtAt = now;
                }
                if (total >= limit && entry.limitReachedAt === undefined) {
                    entry.limitReachedAt = now;
                    titan.logf('[Stark Mercher] Cache: %s buy limit reached (%d/%d) — 4h cooldown started',
                        key, total, limit);
                } else {
                    titan.logf('[Stark Mercher] Cache: %s bought qty tracked (%d/%d towards limit)',
                        key, total, limit);
                }
            }
        }

        this.dirty = true;
        titan.logf('[Stark Mercher] Cache: recorded sell offer for %s @ %dgp', key, sellPrice);
    }

    /**
     * Clears the sellQuantity field on an entry (after profit has been
     * recorded for the completed/aborted sell cycle). Prevents double-
     * counting on subsequent ticks.
     */
    clearSellQuantity(itemName: string): void {
        const entry = this.get(itemName);
        if (entry && entry.sellQuantity !== undefined) {
            entry.sellQuantity = undefined;
            this.dirty = true;
        }
    }

    /**
     * Clears sell-specific fields after a completed sell cycle, preserving
     * buy-limit tracking (totalBought, firstBoughtAt, limitReachedAt) so the
     * bot knows how much of the 4-hour buy limit has been consumed.
     * Resets mode to 'idle' and clears sellQuantity, partialSales, and
     * revisedPrices. Buy/sell price fields are left as-is (overwritten by the
     * next recordBuyOffer).
     */
    clearSellFields(itemName: string): void {
        const entry = this.get(itemName);
        if (!entry) return;
        entry.mode = 'idle';
        entry.sellQuantity = undefined;
        entry.partialSales = undefined;
        entry.revisedPrices = [];
        this.dirty = true;
    }

    // --- Partial sale tracking (for merch history) ---

    /**
     * Records a partial sale batch — a quantity sold at a specific price
     * before the offer was aborted/re-listed or completed. Appended to
     * entry.partialSales. Used to compute weighted average sell price
     * and total profit/loss when the merch cycle completes.
     */
    recordPartialSale(itemName: string, price: number, qty: number): void {
        if (qty <= 0) return;
        const entry = this.get(itemName);
        if (!entry) return;
        if (!entry.partialSales) entry.partialSales = [];
        entry.partialSales.push({ price, qty, timestamp: Date.now() });
        this.dirty = true;
    }

    /**
     * Returns the partial sales array for an item, or empty array if none.
     */
    getPartialSales(itemName: string): { price: number; qty: number; timestamp: number }[] {
        const entry = this.get(itemName);
        return entry?.partialSales ?? [];
    }

    /**
     * Clears partial sales for an item. Called after the merch cycle
     * completes and the summary has been recorded to merch history.
     */
    clearPartialSales(itemName: string): void {
        const entry = this.get(itemName);
        if (entry && entry.partialSales) {
            entry.partialSales = undefined;
            this.dirty = true;
        }
    }

    // --- Price revision ---

    /**
     * Computes a revised sell price for an item that hasn't sold.
     *
     * Strategy:
     *   1. reduction = 5% of gross profit, minimum 1 gp.
     *   2. newPrice = currentSellPrice - reduction, floored to buyPrice + 1.
     *
     * No profit threshold — even thin-margin items get a 1gp nudge so they
     * don't sit in a slot forever.
     *
     * Returns the new price, or null if the price is already at the floor
     * (buyPrice + 1) and can't be reduced further.
     */
    computeRevisedSellPrice(itemName: string): number | null {
        const entry = this.get(itemName);
        if (!entry) return null;

        const currentSell = entry.sellPrice;
        const buyPrice = entry.buyPrice;
        const grossProfit = currentSell - buyPrice;

        // 5% of gross profit, minimum 1 gp.
        const reduction = Math.max(MIN_REDUCTION_GP, Math.floor(grossProfit * PROFIT_REDUCTION_RATE));

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
     * Post-login cleanup sweep. Removes 'idle' entries whose buy-limit
     * window has expired (totalBought was reset to 0 by the lazy reset
     * in getRemainingBuyLimit/isBuyLimited, or the window is older than
     * 4 hours). Also removes 'idle' entries with no buy-limit data at
     * all (totalBought undefined or 0). Called on the first auto-loop
     * tick after logging back in from a break.
     *
     * Returns the number of entries removed.
     */
    cleanupExpiredIdleEntries(): number {
        const now = Date.now();
        let removed = 0;
        for (const key in this.cache) {
            const entry = this.cache[key];
            if (entry.mode !== 'idle') continue;
            const total = entry.totalBought ?? 0;
            if (total <= 0) {
                // No buy-limit data — safe to remove.
                delete this.cache[key];
                removed++;
                continue;
            }
            // Has buy-limit data — check if the window has expired.
            const windowStart = entry.firstBoughtAt ?? entry.limitReachedAt ?? entry.offerPlacedAt;
            if (now - windowStart >= OfferCacheManager.BUY_LIMIT_COOLDOWN_MS) {
                delete this.cache[key];
                removed++;
            }
        }
        if (removed > 0) {
            this.dirty = true;
            titan.logf('[Stark Mercher] Cache: post-login cleanup removed %d expired idle entr%s',
                removed, removed === 1 ? 'y' : 'ies');
        } else {
            titan.log('[Stark Mercher] Cache: post-login cleanup — no expired idle entries to remove');
        }
        return removed;
    }

    /**
     * Returns all cached item names.
     */
    getAllItemNames(): string[] {
        return Object.keys(this.cache);
    }

    /**
     * Fast-path check: returns true if any cache entry has mode='sell' with
     * sellQuantity > 0. Used by the auto-loop's completed-sell sweep to skip
     * the full iteration when no sell offers are being tracked, avoiding
     * per-tick inventory scans for every cache entry.
     */
    hasActiveSellEntries(): boolean {
        for (const key of Object.keys(this.cache)) {
            const entry = this.cache[key];
            if (entry.mode === 'sell' && entry.sellQuantity !== undefined && entry.sellQuantity > 0) {
                return true;
            }
        }
        return false;
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
        // The limit was reached — check if the 4-hour window has expired.
        // Use firstBoughtAt if available; fall back to limitReachedAt for
        // entries created before firstBoughtAt was tracked.
        const windowStart = entry.firstBoughtAt ?? entry.limitReachedAt;
        if (now - windowStart >= OfferCacheManager.BUY_LIMIT_COOLDOWN_MS) {
            entry.totalBought = 0;
            entry.limitReachedAt = undefined;
            entry.firstBoughtAt = undefined;
            this.dirty = true;
            titan.logf('[Stark Mercher] Cache: %s buy limit window expired — limit reset', itemName);
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
     * Returns the remaining buy quantity allowed for an item, given its GE
     * buy limit. The GE 4-hour window starts from the FIRST purchase of the
     * item, and resets completely after 4 hours regardless of how many were
     * bought. Within the window, remaining = limit - totalBought.
     */
    getRemainingBuyLimit(itemName: string, limit: number): number {
        const entry = this.get(itemName);
        if (!entry) return limit;
        const total = entry.totalBought ?? 0;
        if (total <= 0) return limit;
        const now = Date.now();
        // Use firstBoughtAt if available; fall back to limitReachedAt or
        // offerPlacedAt for entries created before firstBoughtAt was tracked.
        const windowStart = entry.firstBoughtAt ?? entry.limitReachedAt ?? entry.offerPlacedAt;
        if (now - windowStart >= OfferCacheManager.BUY_LIMIT_COOLDOWN_MS) {
            entry.totalBought = 0;
            entry.firstBoughtAt = undefined;
            entry.limitReachedAt = undefined;
            this.dirty = true;
            titan.logf('[Stark Mercher] Cache: %s buy limit window expired — limit reset', itemName);
            return limit;
        }
        return Math.max(0, limit - total);
    }

    /**
     * Returns a set of item names (lowercase) where the remaining buy limit
     * is below the given threshold percentage of the item's full limit.
     * Used to skip items that have been mostly bought in the current 4-hour
     * window but haven't triggered the full-limit cooldown yet.
     *
     * @param items - Array of { itemName, limit } to check.
     * @param thresholdPercent - Skip if remaining < this % of limit (e.g. 20).
     */
    getBuyLimitThresholdItemNames(
        items: { itemName: string; limit: number }[],
        thresholdPercent: number,
    ): Set<string> {
        const result = new Set<string>();
        for (const item of items) {
            const remaining = this.getRemainingBuyLimit(item.itemName, item.limit);
            const threshold = item.limit * (thresholdPercent / 100);
            if (remaining < threshold) {
                result.add(item.itemName.trim().toLowerCase());
            }
        }
        return result;
    }

    /**
     * Returns the raw cache data (for inspection/debugging).
     */
    getRaw(): OfferCacheData {
        return this.cache;
    }
}
