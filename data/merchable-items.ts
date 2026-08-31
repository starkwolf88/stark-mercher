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
}

// --- Module-level cache ----------------------------------------------------
// The JSON is inlined at build time, so we just cast and cache it once.
let cachedItems: MerchableItem[] | null = null;

/** Maximum age in ms before item data is considered stale (10 minutes). */
const STALE_DATA_MAX_AGE_MS = 10 * 60 * 1000;

/** Returns true if the item's data is still fresh (within 10 minutes). */
const isItemFresh = (item: MerchableItem): boolean => {
    if (!item.dataFetchedAt) return false; // no timestamp = stale
    return (Date.now() - item.dataFetchedAt) < STALE_DATA_MAX_AGE_MS;
};

/** Returns all items, filtering out stale ones (data older than 10 minutes). */
const ensureLoaded = (): MerchableItem[] => {
    if (cachedItems) return cachedItems;
    // The raw import is an array of objects; cast to the typed interface.
    const raw = merchableItemsRaw as unknown as MerchableItem[];
    // Filter out stale items — data older than 10 minutes is not trusted.
    cachedItems = raw.filter(isItemFresh);
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
 * coins AND is not currently buy-limited (within the GE 4-hour cooldown).
 * Used by the buying flow to pick the next item to buy.
 *
 * @param occupiedItemNames - Set of item names (lowercase) currently in GE slots.
 * @param availableCoins - Total coins in inventory (item ID 995). Items whose
 *   totalPurchasePrice exceeds this are skipped. Pass Infinity to skip the
 *   affordability check.
 * @param buyLimitedItemNames - Set of item names (lowercase) that are currently
 *   buy-limited (within the 4-hour GE cooldown). These are skipped. Optional.
 * @param isMembersWorld - If false, members-only items are skipped. Defaults to
 *   true so P2P worlds consider every item.
 */
export const getFirstUnoccupiedMerchableItem = (
    occupiedItemNames: Set<string>,
    availableCoins: number = Infinity,
    buyLimitedItemNames: Set<string> = new Set(),
    isMembersWorld: boolean = true,
): MerchableItem | null => {
    const items = ensureLoaded();
    for (const item of items) {
        const lower = item.itemName.trim().toLowerCase();
        if (occupiedItemNames.has(lower)) continue;
        if (buyLimitedItemNames.has(lower)) continue;
        if (item.totalPurchasePrice > availableCoins) continue;
        if (!isMembersWorld && item.members) continue;
        return item;
    }
    return null;
};
