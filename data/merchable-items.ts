// ============================================================================
// Merchable items — type definitions and reader for merchableItems.json
// ============================================================================
// The JSON is inlined at build time by esbuild (the Titan SDK has no runtime
// file-system API). When determine-flips.mjs updates merchableItems.json and
// the plugin is rebuilt + hot-reloaded by Titan, the new data is available
// in onEnable / on the next tick loop iteration.
//
// Usage:
//   import { getMerchableItems, getMerchableItem, isMerchable } from './data/merchable-items.js';
//   const items = getMerchableItems();   // MerchableItem[]
//   const item = getMerchableItem('Air rune');  // MerchableItem | null
// ============================================================================

// Import the JSON — esbuild bundles it natively when bundle: true is set.
// No tsconfig.json in this project, so we use a plain import which esbuild
// resolves at build time. The data is inlined into the plugin bundle.
import merchableItemsRaw from '../merchableItems.json';

// --- Types -----------------------------------------------------------------

export interface MerchableItem {
    itemId: number;
    itemName: string;
    /** Buy price per item (from determine-flips.mjs). */
    purchasePrice: number;
    /** Sale price per item (includes GE tax factored into profit). */
    salePrice: number;
    /** Raw sale price before tax/buffer adjustments. */
    rawSalePrice: number;
    /** Profit margin per item (salePrice - purchasePrice, after tax). */
    profitMargin: number;
    /** GE buy limit for this item. */
    limit: number;
    /** Whether this item is members-only (from OSRS Wiki mapping). */
    members: boolean;
    /** Quantity to purchase per offer (calculated by determine-flips.mjs). */
    quantityToPurchase: number;
    /** Cash allocation per slot. */
    cashAllocation: number;
    /** Estimated time to fill the buy offer, in minutes. */
    purchaseEtaMinutes: number;
    /** Estimated time to fill the sell offer, in minutes. */
    saleEtaMinutes: number;
    /** Total purchase cost (purchasePrice * quantityToPurchase). */
    totalPurchasePrice: number;
    /** Total expected profit for the full offer. */
    totalProfit: number;
    /** Sale tax amount per item. */
    saleTaxAmount: number;
    /** Sale buffer amount per item. */
    saleBufferAmount: number;
    /** Sale price excluding tax. */
    salePriceExcludingTax: number;
    /** Sale price excluding tax and buffer. */
    salePriceExcludingTaxAndBuffer: number;
    /** Flip score (higher = better). */
    flipScore: number;
    /** Return on investment percentage. */
    returnOnInvestmentPercentage: number;
    /** Actual profit per slot hour. */
    actualProfitPerSlotHour: number;
    /** Max profit per slot hour (theoretical). */
    maxProfitPerSlotHour: number;
    /** Turnover ETA in minutes (combined buy + sell). */
    turnoverEtaMinutes: number;
    /** Epoch ms when the price data was fetched from the wiki API.
     *  Used to detect stale offer data (e.g. game updating, API down). */
    dataFetchedAt: number;
    /** ISO string of when the price data was fetched (human-readable). */
    dataFetchedAtIso: string;
    /** Lowball percentage applied to the buy price (0 = no lowball, buy at market). */
    lowballPercent: number;
    /** Lowball amount in gp (the reduction from lowballBasePrice to purchasePrice). */
    lowballAmount: number;
    /** Pre-lowball buy price (the market price before the lowball was applied). */
    lowballBasePrice: number;
}

// --- Lowball helpers -------------------------------------------------------

/**
 * Lowball tier for buy-scan prioritisation.
 * - `'non-lowball'` — only items with `lowballPercent === 0` (instant-fill, buy at market).
 * - `'lowball'` — only items with `lowballPercent > 0` (buy below market, slower fills).
 * - `'any'` — all items in JSON order (no lowball filtering, backward-compatible default).
 */
export type LowballTier = 'non-lowball' | 'lowball' | 'any';

/**
 * Returns true if the item has a lowball applied (`lowballPercent > 0`).
 * Lowball items buy below market price and fill slower; non-lowball items
 * buy at market and fill immediately.
 */
export const isLowballItem = (item: MerchableItem): boolean =>
    item.lowballPercent > 0;

// --- Module-level cache ----------------------------------------------------
// The JSON is inlined at build time, so we just cast and cache it once.
let cachedItems: MerchableItem[] | null = null;

/** Returns all merchable items from the build-time-inlined JSON. */
const ensureLoaded = (): MerchableItem[] => {
    if (cachedItems) return cachedItems;
    // The raw import is an array of objects; cast to the typed interface.
    cachedItems = merchableItemsRaw as unknown as MerchableItem[];
    return cachedItems;
};

// --- Public API ------------------------------------------------------------

/**
 * Returns all merchable items from merchableItems.json.
 * The data is inlined at build time — call this after a rebuild to get
 * fresh data.
 */
export const getMerchableItems = (): MerchableItem[] => ensureLoaded();

/**
 * Returns the merchable item matching the given item name (case-insensitive),
 * or null if not found.
 */
export const getMerchableItem = (itemName: string): MerchableItem | null => {
    const items = ensureLoaded();
    const lower = itemName.trim().toLowerCase();
    return items.find(i => i.itemName.trim().toLowerCase() === lower) ?? null;
};

/**
 * Returns true if the item name exists in merchableItems.json.
 */
export const isMerchable = (itemName: string): boolean =>
    getMerchableItem(itemName) !== null;

/**
 * Returns the merchable item matching the given item ID, or null if not found.
 */
export const getMerchableItemById = (itemId: number): MerchableItem | null => {
    const items = ensureLoaded();
    return items.find(i => i.itemId === itemId) ?? null;
};

/**
 * Returns the first merchable item that is not currently being bought or sold
 * in any GE slot AND whose totalPurchasePrice we can afford with the available
 * coins AND is not currently buy-limited (within the GE 4-hour cooldown) AND
 * is not currently frozen (recently aborted buy offer).
 * Used by the buying flow to pick the next item to buy.
 *
 * **Lowball tiering**: The `lowballTier` parameter controls whether the scan
 * considers only non-lowball items (instant-fill, buy at market), only lowball
 * items (buy below market, slower fills), or all items. The auto-loop calls
 * this function in tier order — non-lowball first, then lowball — so that
 * instant-fill items fill GE slots before slower lowball items are attempted.
 * Lowball items have less reliable ETA/profit-per-hour estimates because the
 * fill rate depends on the price distribution below the lowballed price.
 *
 * @param occupiedItemNames - Set of item names (lowercase) currently in GE slots.
 * @param availableCoins - Total coins in inventory (item ID 995). Items whose
 *   totalPurchasePrice exceeds this are skipped. Pass Infinity to skip the
 *   affordability check.
 * @param buyLimitedItemNames - Set of item names (lowercase) that are currently
 *   buy-limited (within the 4-hour GE cooldown). These are skipped. Optional.
 * @param isMembersWorld - If false, members-only items are skipped. Defaults to
 *   true so P2P worlds consider every item.
 * @param frozenItemNames - Set of item names (lowercase) that are temporarily
 *   frozen from buying (recently aborted buy offer). These are skipped. Optional.
 * @param lowballTier - Which lowball tier to scan: `'non-lowball'` (only
 *   instant-fill items), `'lowball'` (only lowballed items), or `'any'` (all
 *   items in JSON order). Defaults to `'any'` for backward compatibility.
 */
export const getFirstUnoccupiedMerchableItem = (
    occupiedItemNames: Set<string>,
    availableCoins: number = Infinity,
    buyLimitedItemNames: Set<string> = new Set(),
    isMembersWorld: boolean = true,
    frozenItemNames: Set<string> = new Set(),
    lowballTier: LowballTier = 'any',
): MerchableItem | null => {
    const items = ensureLoaded();
    for (const item of items) {
        const lower = item.itemName.trim().toLowerCase();
        if (occupiedItemNames.has(lower)) continue;
        if (buyLimitedItemNames.has(lower)) continue;
        if (frozenItemNames.has(lower)) continue;
        if (item.totalPurchasePrice > availableCoins) continue;
        if (!isMembersWorld && item.members) continue;
        if (lowballTier === 'non-lowball' && isLowballItem(item)) continue;
        if (lowballTier === 'lowball' && !isLowballItem(item)) continue;
        return item;
    }
    return null;
};

/**
 * Result of a partial-quantity buy lookup. The item is affordable at a
 * reduced quantity (fewer units than quantityToPurchase) because the
 * full totalPurchasePrice exceeds availableCoins but at least 1 unit
 * can be bought. The reduced quantity is clamped to the GE buy limit.
 */
export interface PartialBuyResult {
    item: MerchableItem;
    /** Reduced quantity to buy (<= item.quantityToPurchase, <= item.limit). */
    quantity: number;
    /** Total cost of the reduced quantity (quantity * purchasePrice). */
    totalCost: number;
}

/**
 * Fallback lookup for partial-quantity buying. When no item can be afforded
 * at its full quantityToPurchase, this scans for items where at least 1 unit
 * is affordable AND the expected profit from the reduced quantity meets a
 * minimum threshold. This keeps GE slots productive instead of sitting idle
 * when most of the cash stack is tied up in other offers.
 *
 * The reduced quantity is: min(floor(availableCoins / purchasePrice), limit).
 * Profit check: reducedQty * profitMargin >= minProfitGp.
 *
 * **Lowball tiering**: Same `lowballTier` parameter as
 * `getFirstUnoccupiedMerchableItem`. The auto-loop calls this in tier order
 * (non-lowball first, then lowball) for consistency with the primary buy scan.
 *
 * @param minProfitGp - Minimum total profit (reducedQty * profitMargin) for
 *   the partial buy to be worthwhile. Default 15000.
 * @param lowballTier - Which lowball tier to scan. Defaults to `'any'`.
 */
export const getFirstPartialBuyItem = (
    occupiedItemNames: Set<string>,
    availableCoins: number,
    buyLimitedItemNames: Set<string> = new Set(),
    isMembersWorld: boolean = true,
    frozenItemNames: Set<string> = new Set(),
    minProfitGp: number = 15000,
    lowballTier: LowballTier = 'any',
): PartialBuyResult | null => {
    const items = ensureLoaded();
    for (const item of items) {
        const lower = item.itemName.trim().toLowerCase();
        if (occupiedItemNames.has(lower)) continue;
        if (buyLimitedItemNames.has(lower)) continue;
        if (frozenItemNames.has(lower)) continue;
        if (!isMembersWorld && item.members) continue;
        if (lowballTier === 'non-lowball' && isLowballItem(item)) continue;
        if (lowballTier === 'lowball' && !isLowballItem(item)) continue;
        // Can't afford even 1 unit — skip.
        if (item.purchasePrice > availableCoins) continue;
        // Full quantity is affordable — getFirstUnoccupiedMerchableItem
        // would have returned it already, but check anyway.
        if (item.totalPurchasePrice <= availableCoins) continue;
        // Compute reduced quantity.
        const reducedQty = Math.min(
            Math.floor(availableCoins / item.purchasePrice),
            item.limit,
        );
        if (reducedQty <= 0) continue;
        // Profit threshold check.
        const reducedProfit = reducedQty * item.profitMargin;
        if (reducedProfit < minProfitGp) continue;
        return {
            item,
            quantity: reducedQty,
            totalCost: reducedQty * item.purchasePrice,
        };
    }
    return null;
};
