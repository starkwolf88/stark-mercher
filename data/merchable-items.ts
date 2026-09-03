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
    /** Quantity to purchase per offer (calculated by determine-flips.mjs
     *  at the simulation cash stack — NOT the player's actual coins).
     *  The plugin recomputes the runtime quantity based on available coins. */
    quantityToPurchase: number;
    /** Cash allocation per slot (at the simulation cash stack). */
    cashAllocation: number;
    /** Estimated time to fill the buy offer, in minutes (at simulation qty). */
    purchaseEtaMinutes: number;
    /** Estimated time to fill the sell offer, in minutes (at simulation qty). */
    saleEtaMinutes: number;
    /** Total purchase cost (purchasePrice * quantityToPurchase, at simulation qty). */
    totalPurchasePrice: number;
    /** Total expected profit for the full offer (at simulation qty). */
    totalProfit: number;
    /** Sale tax amount per item. */
    saleTaxAmount: number;
    /** Sale buffer amount per item. */
    saleBufferAmount: number;
    /** Sale price excluding tax. */
    salePriceExcludingTax: number;
    /** Sale price excluding tax and buffer. */
    salePriceExcludingTaxAndBuffer: number;
    /** Flip score (cash-stack-independent — based on maxProfitPerSlotHour
     *  and ROI, not on allocation fraction). Higher = better. */
    flipScore: number;
    /** Return on investment percentage (profitMargin / purchasePrice * 100). */
    returnOnInvestmentPercentage: number;
    /** Actual profit per slot hour (at simulation qty — NOT runtime). */
    actualProfitPerSlotHour: number;
    /** Max profit per slot hour (theoretical — min(3h volume, limit) * profitMargin).
     *  Cash-stack-independent intrinsic quality metric. */
    maxProfitPerSlotHour: number;
    /** Turnover ETA in minutes (combined buy + sell, at simulation qty). */
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
    // --- Intrinsic volume fields (cash-stack-independent) ---
    /** 1-hour average hourly purchase volume. */
    oneHourPurchaseVolume: number;
    /** 1-hour average hourly sale volume. */
    oneHourSaleVolume: number;
    /** 2-hour average hourly purchase volume. */
    twoHourAverageHourlyPurchaseVolume: number;
    /** 2-hour average hourly sale volume. */
    twoHourAverageHourlySaleVolume: number;
    /** 3-hour average hourly purchase volume. */
    threeHourAverageHourlyPurchaseVolume: number;
    /** 3-hour average hourly sale volume. */
    threeHourAverageHourlySaleVolume: number;
    /** 3-hour average hourly volume (combined buy + sell). */
    threeHourAverageHourlyVolume: number;
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

// --- Runtime evaluation (cash-stack-aware) ----------------------------------

/**
 * Runtime constants — must match determine-flips.mjs.
 * These are the same values used by the simulation to compute ETAs and
 * profit/hr. The plugin uses them to recompute these metrics at runtime
 * based on the player's actual available coins.
 */
const MARKET_SHARE_ASSUMPTION_PERCENTAGE = 35;
const TWO_HOUR_VOLUME_BUFFER_PERCENTAGE = 15;

/**
 * Result of evaluating an item at runtime with a specific coin budget.
 * All values are computed based on the player's actual available coins,
 * NOT the simulation cash stack from determine-flips.mjs.
 */
export interface RuntimeEvaluation {
    /** The item being evaluated. */
    item: MerchableItem;
    /** Quantity the player can actually afford: min(floor(coins/price), limit). */
    runtimeQuantity: number;
    /** Total cost of the runtime quantity. */
    runtimeTotalCost: number;
    /** Runtime buy ETA in minutes (based on runtime quantity). */
    runtimePurchaseEtaMinutes: number;
    /** Runtime sell ETA in minutes (based on runtime quantity). */
    runtimeSaleEtaMinutes: number;
    /** Runtime turnover ETA in minutes (buy + sell). */
    runtimeTurnoverEtaMinutes: number;
    /** Runtime profit per slot per hour (based on runtime quantity and ETA). */
    runtimeProfitPerSlotHour: number;
    /** Runtime total profit (runtimeQuantity * profitMargin). */
    runtimeTotalProfit: number;
}

/**
 * Computes the runtime ETA for buying a given quantity of an item.
 * Mirrors `computeEtasForQuantity` from determine-flips.mjs.
 */
const computeRuntimeEtas = (item: MerchableItem, quantity: number): {
    purchaseEtaMinutes: number;
    saleEtaMinutes: number;
    turnoverEtaMinutes: number;
} | null => {
    if (quantity <= 0) return null;
    // Lowball reduces effective buy volume: 2.0x the lowball %.
    // Increased from 1.5x to 2.0x — lowball offers buy below market and only
    // capture the portion of trades at or below the lowballed price. The 1.5x
    // factor was too optimistic, producing ETAs that were too short and causing
    // offers to sit at 0% progress well past their predicted ETA.
    const lowballVolumeFactor = 1 - ((item.lowballPercent || 0) * 2.0 / 100);
    const effectivePurchaseVolume = Math.min(
        item.twoHourAverageHourlyPurchaseVolume * (1 - TWO_HOUR_VOLUME_BUFFER_PERCENTAGE / 100),
        item.oneHourPurchaseVolume,
    ) * (MARKET_SHARE_ASSUMPTION_PERCENTAGE / 100) * lowballVolumeFactor;
    const effectiveSaleVolume = Math.min(
        item.twoHourAverageHourlySaleVolume * (1 - TWO_HOUR_VOLUME_BUFFER_PERCENTAGE / 100),
        item.oneHourSaleVolume,
    ) * (MARKET_SHARE_ASSUMPTION_PERCENTAGE / 100);
    if (effectivePurchaseVolume <= 0 || effectiveSaleVolume <= 0) return null;
    const purchaseEtaMinutes = quantity / (effectivePurchaseVolume / 60);
    const saleEtaMinutes = quantity / (effectiveSaleVolume / 60);
    return {
        purchaseEtaMinutes,
        saleEtaMinutes,
        turnoverEtaMinutes: purchaseEtaMinutes + saleEtaMinutes,
    };
};

/**
 * Evaluates an item at runtime based on the player's actual available coins.
 * Computes the runtime quantity, ETAs, and profit/hr — all based on what
 * the player can actually afford, NOT the simulation cash stack.
 *
 * Returns null if the item cannot be evaluated (e.g. can't afford even 1 unit,
 * or volume data is missing).
 *
 * @param item - The merchable item to evaluate.
 * @param availableCoins - The player's actual coin count.
 * @param maxTurnoverMinutes - Maximum acceptable turnover ETA. Items exceeding
 *   this are still evaluated (the caller decides whether to filter), but the
 *   runtime ETA is available for the caller to check. Default 150 (2.5h).
 */
export const evaluateItemAtRuntime = (
    item: MerchableItem,
    availableCoins: number,
): RuntimeEvaluation | null => {
    // Can't afford even 1 unit.
    if (item.purchasePrice > availableCoins) return null;

    // Runtime quantity: what the player can actually afford, capped at the
    // GE buy limit. This replaces the simulation's quantityToPurchase.
    const runtimeQuantity = Math.min(
        Math.floor(availableCoins / item.purchasePrice),
        item.limit,
    );
    if (runtimeQuantity <= 0) return null;

    const runtimeTotalCost = runtimeQuantity * item.purchasePrice;

    // Compute runtime ETAs based on the runtime quantity.
    const etas = computeRuntimeEtas(item, runtimeQuantity);
    if (!etas) return null;

    // Runtime profit per slot per hour.
    const runtimeProfitPerSlotHour = (runtimeQuantity * item.profitMargin) * (60 / etas.turnoverEtaMinutes);
    const runtimeTotalProfit = runtimeQuantity * item.profitMargin;

    return {
        item,
        runtimeQuantity,
        runtimeTotalCost,
        runtimePurchaseEtaMinutes: etas.purchaseEtaMinutes,
        runtimeSaleEtaMinutes: etas.saleEtaMinutes,
        runtimeTurnoverEtaMinutes: etas.turnoverEtaMinutes,
        runtimeProfitPerSlotHour,
        runtimeTotalProfit,
    };
};

/** Minimum profit per slot per hour for an item to be worth buying at runtime.
 *  Must match PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD in determine-flips.mjs. */
export const RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM = 20000;
/** Maximum turnover ETA in minutes for an item to be worth buying at runtime.
 *  Tightened from 150 to 120 — items with 120-150min turnovers tie up capital
 *  for 2+ hours per cycle and compound poorly. Faster-cycling items at 15m
 *  produce more total profit even if per-cycle profit is lower. */
export const RUNTIME_MAX_TURNOVER_MINUTES = 120;

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

// --- Data validity safeguards -----------------------------------------------
// Two safeguards prevent the bot from merching with bad data:
//   1. Count safeguard: merchableItems.json must have >= 30 items. A sudden
//      drop below 30 indicates the Wiki API returned bad data or
//      determine-flips.mjs failed mid-run.
//   2. Freshness safeguard: the newest dataFetchedAt across all items must
//      be within the last 10 minutes. determine-flips.mjs runs every 3 min,
//      so data older than 10 min means the script stopped running or the
//      Wiki API is down.
// Both checks run dynamically (not cached) so hot reloads pick up new JSON
// automatically — the bot resumes as soon as a rebuild brings valid data.

/** Minimum number of items required in merchableItems.json to merch safely. */
const MIN_MERCHABLE_ITEMS = 30;
/** Maximum age of merchable data (in ms) before it's considered stale. */
const MAX_DATA_AGE_MS = 10 * 60 * 1000; // 10 minutes

export interface MerchableDataValidity {
    valid: boolean;
    reason: string;
}

/**
 * Check if the merchable items data is valid for merching.
 * Returns { valid: true, reason: '' } if both the count and freshness
 * safeguards pass, otherwise { valid: false, reason: '<error message>' }.
 *
 * Called dynamically (not cached) so hot reloads pick up new JSON.
 */
export const isMerchableDataValid = (): MerchableDataValidity => {
    const items = ensureLoaded();
    const count = items.length;
    if (count < MIN_MERCHABLE_ITEMS) {
        return {
            valid: false,
            reason: `only ${count} items in merchableItems.json (need >= ${MIN_MERCHABLE_ITEMS})`,
        };
    }
    // Check freshness — use the newest dataFetchedAt across all items.
    let newestDataFetchedAt = 0;
    for (const item of items) {
        if (item.dataFetchedAt > newestDataFetchedAt) {
            newestDataFetchedAt = item.dataFetchedAt;
        }
    }
    if (newestDataFetchedAt > 0) {
        const ageMs = Date.now() - newestDataFetchedAt;
        if (ageMs > MAX_DATA_AGE_MS) {
            const ageMin = Math.round(ageMs / 60000);
            return {
                valid: false,
                reason: `data is ${ageMin} min old (stale > ${MAX_DATA_AGE_MS / 60000} min)`,
            };
        }
    }
    return { valid: true, reason: '' };
};

/**
 * Result of a buy-scan lookup. Includes the runtime evaluation so the caller
 * knows the actual quantity to buy, total cost, and runtime profit/hr.
 */
export interface BuyScanResult {
    item: MerchableItem;
    /** Quantity to buy at runtime (based on available coins, capped at limit). */
    quantity: number;
    /** Total cost of the runtime quantity. */
    totalCost: number;
    /** Runtime profit per slot per hour. */
    runtimeProfitPerSlotHour: number;
    /** Runtime turnover ETA in minutes. */
    runtimeTurnoverEtaMinutes: number;
    /** Profit per coin per hour (runtimeProfitPerSlotHour / totalCost).
     *  Used for ranking — favours items that use coins efficiently across
     *  multiple slots rather than one expensive item consuming the whole
     *  cash stack. */
    runtimeProfitPerCoinHour: number;
}

/**
 * Core scan logic shared by getFirstUnoccupiedMerchableItem and
 * getFirstPartialBuyItem. Iterates items in flipScore order, evaluates each
 * at runtime based on the player's actual coins, and returns the item with
 * the highest runtimeProfitPerSlotHour that passes all filters.
 *
 * This replaces the old approach of checking `totalPurchasePrice > availableCoins`
 * (which used the simulation quantity from a 50m cash stack). Now every item
 * is evaluated based on what the player can actually afford right now.
 */
const scanItemsAtRuntime = (
    occupiedItemNames: Set<string>,
    availableCoins: number,
    buyLimitedItemNames: Set<string>,
    isMembersWorld: boolean,
    frozenItemNames: Set<string>,
    lowballTier: LowballTier,
    minProfitPerSlotHour: number,
    maxTurnoverMinutes: number,
    crossAccountSkipNames: Set<string> = new Set(),
): BuyScanResult | null => {
    const items = ensureLoaded();
    let best: BuyScanResult | null = null;
    for (const item of items) {
        const lower = item.itemName.trim().toLowerCase();
        if (occupiedItemNames.has(lower)) continue;
        if (buyLimitedItemNames.has(lower)) continue;
        if (frozenItemNames.has(lower)) continue;
        if (crossAccountSkipNames.has(lower)) continue;
        if (!isMembersWorld && item.members) continue;
        if (lowballTier === 'non-lowball' && isLowballItem(item)) continue;
        if (lowballTier === 'lowball' && !isLowballItem(item)) continue;
        // Evaluate at runtime based on actual coins.
        const evalResult = evaluateItemAtRuntime(item, availableCoins);
        if (!evalResult) continue; // can't afford or no volume data
        // Filter: runtime profit/hr must meet threshold.
        if (evalResult.runtimeProfitPerSlotHour < minProfitPerSlotHour) continue;
        // Filter: runtime turnover must be within limit.
        if (evalResult.runtimeTurnoverEtaMinutes > maxTurnoverMinutes) continue;
        // Rank by profit-per-coin-per-hour (bang for buck). This favours
        // items that use coins efficiently, so that 3x 5m items (50k/hr each
        // = 150k/hr total) are preferred over 1x 14m item (100k/hr) when the
        // player has 15m and multiple empty slots. The absolute profit/hr
        // filter (>= 20k) ensures we don't pick low-quality cheap items.
        const profitPerCoinHour = evalResult.runtimeTotalCost > 0
            ? evalResult.runtimeProfitPerSlotHour / evalResult.runtimeTotalCost
            : 0;
        if (!best || profitPerCoinHour > best.runtimeProfitPerCoinHour) {
            best = {
                item,
                quantity: evalResult.runtimeQuantity,
                totalCost: evalResult.runtimeTotalCost,
                runtimeProfitPerSlotHour: evalResult.runtimeProfitPerSlotHour,
                runtimeTurnoverEtaMinutes: evalResult.runtimeTurnoverEtaMinutes,
                runtimeProfitPerCoinHour: profitPerCoinHour,
            };
        }
    }
    return best;
};

/**
 * Returns the best merchable item to buy based on the player's actual available
 * coins. Evaluates each item at runtime — computing the quantity the player can
 * afford, the runtime ETA, and the runtime profit per slot per hour — and
 * returns the item with the highest runtime profit/hr that passes all filters.
 *
 * **Cash-stack-aware**: Unlike the old approach which checked
 * `totalPurchasePrice > availableCoins` (using the simulation quantity from a
 * 50m cash stack), this function computes the runtime quantity as
 * `min(floor(coins / purchasePrice), limit)` and evaluates profitability based
 * on that quantity. An item that needs 7m at 50m allocation but only 2m at the
 * player's actual coins is evaluated at the 2m level.
 *
 * **Lowball tiering**: The `lowballTier` parameter controls whether the scan
 * considers only non-lowball items (instant-fill, buy at market), only lowball
 * items (buy below market, slower fills), or all items. The auto-loop calls
 * this function in tier order — non-lowball first, then lowball.
 *
 * @param occupiedItemNames - Set of item names (lowercase) currently in GE slots.
 * @param availableCoins - Total coins in inventory (item ID 995).
 * @param buyLimitedItemNames - Set of item names (lowercase) that are currently
 *   buy-limited (within the 4-hour GE cooldown). These are skipped.
 * @param isMembersWorld - If false, members-only items are skipped.
 * @param frozenItemNames - Set of item names (lowercase) that are temporarily
 *   frozen from buying (recently aborted buy offer). These are skipped.
 * @param lowballTier - Which lowball tier to scan. Defaults to `'any'`.
 */
export const getFirstUnoccupiedMerchableItem = (
    occupiedItemNames: Set<string>,
    availableCoins: number = Infinity,
    buyLimitedItemNames: Set<string> = new Set(),
    isMembersWorld: boolean = true,
    frozenItemNames: Set<string> = new Set(),
    lowballTier: LowballTier = 'any',
    crossAccountSkipNames: Set<string> = new Set(),
): BuyScanResult | null => {
    return scanItemsAtRuntime(
        occupiedItemNames,
        availableCoins,
        buyLimitedItemNames,
        isMembersWorld,
        frozenItemNames,
        lowballTier,
        RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM,
        RUNTIME_MAX_TURNOVER_MINUTES,
        crossAccountSkipNames,
    );
};

/**
 * Result of a partial-quantity buy lookup. Now identical to BuyScanResult
 * since the primary scan already handles partial quantities. Kept for
 * backward compatibility with callers that reference this type.
 */
export interface PartialBuyResult {
    item: MerchableItem;
    /** Quantity to buy (based on available coins, capped at limit). */
    quantity: number;
    /** Total cost of the quantity (quantity * purchasePrice). */
    totalCost: number;
}

/**
 * Fallback lookup for when the primary buy scan finds nothing meeting the
 * standard profit/hr threshold. Uses a lower profit/hr threshold to find
 * items that are still worth buying but less profitable.
 *
 * **Cash-stack-aware**: Like `getFirstUnoccupiedMerchableItem`, this evaluates
 * each item at runtime based on the player's actual coins. The runtime
 * quantity is `min(floor(coins / purchasePrice), limit)`.
 *
 * **Lowball tiering**: Same `lowballTier` parameter as
 * `getFirstUnoccupiedMerchableItem`. The auto-loop calls this in tier order
 * (non-lowball first, then lowball) for consistency with the primary buy scan.
 *
 * @param minProfitGp - Unused in the runtime evaluation (kept for backward
 *   compatibility). The runtime profit/hr threshold is used instead.
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
    crossAccountSkipNames: Set<string> = new Set(),
): PartialBuyResult | null => {
    // Use a lower profit/hr threshold for the fallback scan. The primary
    // scan uses 20000; here we use 5000 to catch items that are still
    // marginally profitable. The minProfitGp parameter is kept for backward
    // compatibility but the runtime profit/hr is the real filter.
    // We also allow a longer turnover (up to 4 hours) since this is a fallback.
    const result = scanItemsAtRuntime(
        occupiedItemNames,
        availableCoins,
        buyLimitedItemNames,
        isMembersWorld,
        frozenItemNames,
        lowballTier,
        5000, // lower profit/hr threshold for fallback
        240,  // 4 hours max turnover for fallback
        crossAccountSkipNames,
    );
    if (!result) return null;
    return {
        item: result.item,
        quantity: result.quantity,
        totalCost: result.totalCost,
    };
};
