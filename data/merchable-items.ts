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
import f2pMerchableItemsRaw from '../f2pMerchableItems.json';

// --- F2P mode ---------------------------------------------------------------
// When F2P mode is active (autoMode value 3), the runtime reads from
// f2pMerchableItems.json instead of merchableItems.json. The F2P pool
// uses a curated list of high-volume F2P items with a fixed 1gp margin.
// Runtime thresholds are relaxed so thin-margin items pass the buy scan.
let f2pMode = false;
let f2pCachedItems: MerchableItem[] | null = null;

/** Switch between P2P (default) and F2P item pools. Called from auto-loop.ts
 *  at the start of each tick based on bot.autoMode.value. When F2P mode is
 *  active, runtime thresholds are relaxed so 1gp-margin items pass the
 *  buy scan filters. */
export const setF2pMode = (enabled: boolean): void => {
    if (enabled === f2pMode) return;
    f2pMode = enabled;
    if (enabled) {
        RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM = 5000;
        RUNTIME_MAX_TURNOVER_MINUTES = 180;
        RUNTIME_MIN_ABSOLUTE_PROFIT_GP = 5000;
        // RUNTIME_MIN_EFFECTIVE_VOLUME unchanged — F2P items have huge volume.
    } else {
        RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM = 20000;
        RUNTIME_MAX_TURNOVER_MINUTES = 120;
        RUNTIME_MIN_ABSOLUTE_PROFIT_GP = 20000;
    }
};

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
    /** Competitive buffer added to the buy price for non-lowball items
     *  (5% of gross margin, floored — 0 for thin-margin or lowball items).
     *  Improves fill rates by buying slightly above the 5m average low. */
    competitiveBuffer: number;
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
const MARKET_SHARE_ASSUMPTION_PERCENTAGE = 50;
const TWO_HOUR_VOLUME_BUFFER_PERCENTAGE = 15;

/**
 * Minimum effective volume (units/hr) for an item to be selected for buying.
 * Effective volume = min(effective buy volume, effective sell volume) after
 * 50% market share, 15% buffer, and lowball penalty. Items below this floor
 * trade too infrequently to fill reliably — they sit at 0% progress for 30+
 * minutes and waste GE slots. Confirmed stallers filtered by this floor:
 * Dark bow (6/hr), Master wand (3/hr), Heavy ballista (6/hr), Dragon harpoon
 * (3/hr), Elder chaos hood (2/hr), Abyssal dagger p++ (7/hr).
 * Pool goes from ~185 to ~92 items — large enough for multi-account scaling.
 */
const RUNTIME_MIN_EFFECTIVE_VOLUME = 15;

/**
 * Computes the effective hourly volume for buying and selling an item,
 * applying the market share assumption, 2h volume buffer, and lowball
 * penalty. Returns the minimum of buy and sell effective volume — the
 * binding constraint on how fast the item can complete a full cycle.
 */
export const getEffectiveMinVolume = (item: MerchableItem): number => {
    const { effectivePurchaseVolume, effectiveSaleVolume } = getEffectiveVolumes(item);
    return Math.min(effectivePurchaseVolume, effectiveSaleVolume);
};

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
 *
 * The ETA uses a **non-linear model** with a base fill-time component:
 *   eta = BASE_FILL_TIME_MIN + (quantity / (volume / 60))
 *
 * The base component (5 min) represents the minimum time to get any fills at
 * all, independent of quantity. GE fills are queue-based and chunky — even a
 * small order has to wait for sellers to come along, and may be queued behind
 * other buyers at the same or higher price. A purely linear ETA
 * (qty / volume_per_hour) produces unrealistically short ETAs for small
 * quantities of high-volume items (e.g. 2k Soul runes → 1.2min), causing
 * premature stale aborts. The base component ensures every offer gets at least
 * 5 minutes of "time to first fill" before the quantity-proportional component
 * kicks in. For large quantities (e.g. 10k/10k limit), the base component is
 * negligible relative to the total.
 */
export const BASE_FILL_TIME_MIN = 5;

export const computeRuntimeEtas = (item: MerchableItem, quantity: number): {
    purchaseEtaMinutes: number;
    saleEtaMinutes: number;
    turnoverEtaMinutes: number;
} | null => {
    if (quantity <= 0) return null;
    const { effectivePurchaseVolume, effectiveSaleVolume } = getEffectiveVolumes(item);
    if (effectivePurchaseVolume <= 0 || effectiveSaleVolume <= 0) return null;
    const purchaseEtaMinutes = BASE_FILL_TIME_MIN + quantity / (effectivePurchaseVolume / 60);
    const saleEtaMinutes = BASE_FILL_TIME_MIN + quantity / (effectiveSaleVolume / 60);
    return {
        purchaseEtaMinutes,
        saleEtaMinutes,
        turnoverEtaMinutes: purchaseEtaMinutes + saleEtaMinutes,
    };
};

/**
 * Returns the effective purchase and sale volumes for an item, applying the
 * market share assumption (50%), 2h volume buffer (15%), and lowball penalty
 * (4.0x the lowball % on buy volume only). Used by computeRuntimeEtas and
 * getEffectiveMinVolume. Exported for diagnostics.
 */
export const getEffectiveVolumes = (item: MerchableItem): {
    effectivePurchaseVolume: number;
    effectiveSaleVolume: number;
} => {
    // Lowball reduces effective buy volume: 4.0x the lowball %.
    // Lowball offers buy below market and only capture the portion of trades
    // at or below the lowballed price. The 4.0x factor (increased from 2.0x)
    // accounts for the significantly slower fill rate of below-market offers.
    const lowballVolumeFactor = 1 - ((item.lowballPercent || 0) * 4.0 / 100);
    const effectivePurchaseVolume = Math.min(
        item.twoHourAverageHourlyPurchaseVolume * (1 - TWO_HOUR_VOLUME_BUFFER_PERCENTAGE / 100),
        item.oneHourPurchaseVolume,
    ) * (MARKET_SHARE_ASSUMPTION_PERCENTAGE / 100) * lowballVolumeFactor;
    const effectiveSaleVolume = Math.min(
        item.twoHourAverageHourlySaleVolume * (1 - TWO_HOUR_VOLUME_BUFFER_PERCENTAGE / 100),
        item.oneHourSaleVolume,
    ) * (MARKET_SHARE_ASSUMPTION_PERCENTAGE / 100);
    return { effectivePurchaseVolume, effectiveSaleVolume };
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

    // Volume floor: reject items with effective volume below the minimum.
    // These items trade too infrequently to fill reliably and waste GE slots
    // with 0% progress for 30+ minutes (e.g. Dark bow at 6/hr, Master wand
    // at 3/hr). The ETA cap alone doesn't catch them because small GE limits
    // keep the ETA under 120min despite terrible volume.
    if (getEffectiveMinVolume(item) < RUNTIME_MIN_EFFECTIVE_VOLUME) return null;

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

/**
 * Computes the runtime sell ETA for a specific quantity of an item.
 * Used by the sell scan to store an accurate sell ETA in the offer cache
 * based on the actual quantity being sold (not the simulation quantity).
 * Returns 0 if the item or volume data is unavailable.
 */
export const computeRuntimeSellEtaMinutes = (itemName: string, quantity: number): number => {
    if (quantity <= 0) return 0;
    const item = getMerchableItem(itemName);
    if (!item) return 0;
    const etas = computeRuntimeEtas(item, quantity);
    return etas?.saleEtaMinutes ?? 0;
};

/** Minimum profit per slot per hour for an item to be worth buying at runtime.
 *  Must match PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD in determine-flips.mjs.
 *  Relaxed to 5k in F2P mode (setF2pMode). */
export let RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM = 20000;
/** Maximum turnover ETA in minutes for an item to be worth buying at runtime.
 *  Tightened from 150 to 120 — items with 120-150min turnovers tie up capital
 *  for 2+ hours per cycle and compound poorly. Faster-cycling items at 15m
 *  produce more total profit even if per-cycle profit is lower.
 *  Relaxed to 180 in F2P mode (setF2pMode). */
export let RUNTIME_MAX_TURNOVER_MINUTES = 120;
/** Minimum absolute total profit (in gp) for a buy offer to be worth placing.
 *  Prevents wasting a GE slot and ~30s of click time on offers that earn less
 *  than this even if they fill perfectly. Short-ETA items with tiny quantities
 *  (e.g. 1106x Death rune @ 1gp profit = 1.1k total) can show high profit/hr
 *  but aren't worth the slot. Applied to ALL scan tiers, not just the partial
 *  fallback. Relaxed to 5k in F2P mode (setF2pMode). */
export let RUNTIME_MIN_ABSOLUTE_PROFIT_GP = 20000;
/** Minimum effective volume (units/hr) for an item to be selected for buying.
 *  Items below this floor trade too infrequently to fill reliably — they sit
 *  at 0% progress for 30+ minutes and waste GE slots. The ETA cap alone
 *  doesn't catch them because small GE limits keep the ETA under 120min
 *  despite terrible volume (e.g. Dark bow: 8 units at 6/hr = 80min ETA,
 *  passes the 120min cap but stalls in practice). */
export { RUNTIME_MIN_EFFECTIVE_VOLUME };

// --- Module-level cache ----------------------------------------------------
// The JSON is inlined at build time, so we just cast and cache it once.
let cachedItems: MerchableItem[] | null = null;

/** Returns all merchable items from the build-time-inlined JSON.
 *  When F2P mode is active, returns the F2P curated pool instead. */
const ensureLoaded = (): MerchableItem[] => {
    if (f2pMode) {
        if (f2pCachedItems) return f2pCachedItems;
        f2pCachedItems = f2pMerchableItemsRaw as unknown as MerchableItem[];
        return f2pCachedItems;
    }
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
//   1. Count safeguard: merchableItems.json must have >= 5 items. This only
//      guards against catastrophic pipeline failures (broken Wiki API
//      response or crashed determine-flips.mjs run producing 0-4 items).
//   2. Freshness safeguard: the newest dataFetchedAt across all items must
//      be within the last 10 minutes. determine-flips.mjs runs every 3 min,
//      so data older than 10 min means the script stopped running or the
//      Wiki API is down.
// Both checks run dynamically (not cached) so hot reloads pick up new JSON
// automatically — the bot resumes as soon as a rebuild brings valid data.

/** Minimum number of items required in merchableItems.json to merch safely.
 *  Set low (5) — this only guards against catastrophic pipeline failures
 *  (0-4 items from a broken Wiki API response or crashed determine-flips
 *  run). The freshness check (10 min) is the primary staleness guard. */
const MIN_MERCHABLE_ITEMS = 5;
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
    /** Runtime profit per slot per hour. Used for ranking — the bot picks
     *  the item with the highest absolute profit/hr first, then fills
     *  remaining slots with cheaper items using leftover coins. This
     *  maximises total profit across all slots. */
    runtimeProfitPerSlotHour: number;
    /** Runtime turnover ETA in minutes. */
    runtimeTurnoverEtaMinutes: number;
    /** Runtime buy ETA in minutes (based on the runtime quantity, not the
     *  simulation quantity). Stored in the offer cache so the stale checker
     *  and cache dump use the correct threshold for the actual offer size. */
    runtimePurchaseEtaMinutes: number;
    /** Runtime sell ETA in minutes (based on the runtime quantity). Stored
     *  in the offer cache for the stale checker and cache dump. */
    runtimeSaleEtaMinutes: number;
    /** Profit per coin per hour (runtimeProfitPerSlotHour / totalCost).
     *  Used as a floor filter to avoid wasting capital on items that earn
     *  very little per coin invested, even if their absolute profit/hr is
     *  high. Not used for ranking. */
    runtimeProfitPerCoinHour: number;
}

/**
 * Core scan logic shared by getFirstUnoccupiedMerchableItem and
 * getFirstPartialBuyItem. Iterates items in flipScore order, evaluates each
 * at runtime based on the player's actual coins, and returns the item with
 * the highest absolute runtimeProfitPerSlotHour that passes all filters.
 * A minimum profit-per-coin-hour floor (0.005) prevents wasting capital on
 * items that earn very little per coin invested.
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
    minAbsoluteProfitGp: number = 0,
    minBuyEtaMinutes?: number,
    maxBuyEtaMinutes?: number,
): BuyScanResult | null => {
    const items = ensureLoaded();
    let best: BuyScanResult | null = null;
    for (const item of items) {
        const lower = item.itemName.trim().toLowerCase();
        if (occupiedItemNames.has(lower)) continue;
        if (buyLimitedItemNames.has(lower)) continue;
        if (frozenItemNames.has(lower)) continue;
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
        // Filter (optional): runtime buy ETA must fall within [min, max].
        // Used by Slow Mode's preferred tier to target lowball items with
        // ~30-60 minute buy ETAs. Undefined bounds skip the filter.
        if (minBuyEtaMinutes !== undefined && evalResult.runtimePurchaseEtaMinutes < minBuyEtaMinutes) continue;
        if (maxBuyEtaMinutes !== undefined && evalResult.runtimePurchaseEtaMinutes > maxBuyEtaMinutes) continue;
        // Filter: absolute total profit must meet the floor. This prevents
        // placing a buy offer for a tiny quantity of a high-price item when
        // only a small cash remainder is available (e.g. 250k left → 5
        // snapdragon seeds → 1k profit — not worth the slot or the setup
        // time). Applied to ALL scan tiers (primary and partial fallback)
        // via RUNTIME_MIN_ABSOLUTE_PROFIT_GP (20k).
        if (minAbsoluteProfitGp > 0 && evalResult.runtimeTotalProfit < minAbsoluteProfitGp) continue;
        // Rank by absolute profit per slot per hour. This maximises total
        // profit across all slots — the bot picks the highest-earning item
        // first, then fills remaining slots with cheaper items using leftover
        // coins. A minimum profit-per-coin-hour floor prevents wasting capital
        // on items that earn very little per coin invested (e.g. an item that
        // uses 14m of 15m coins but only earns 20k/hr).
        const profitPerCoinHour = evalResult.runtimeTotalCost > 0
            ? evalResult.runtimeProfitPerSlotHour / evalResult.runtimeTotalCost
            : 0;
        // Floor: at least 0.005 profit-per-coin-hour (5k profit per 1m coins
        // per hour). Items below this floor waste too much capital relative
        // to their earning potential.
        if (profitPerCoinHour < 0.005) continue;
        if (!best || evalResult.runtimeProfitPerSlotHour > best.runtimeProfitPerSlotHour) {
            best = {
                item,
                quantity: evalResult.runtimeQuantity,
                totalCost: evalResult.runtimeTotalCost,
                runtimeProfitPerSlotHour: evalResult.runtimeProfitPerSlotHour,
                runtimeTurnoverEtaMinutes: evalResult.runtimeTurnoverEtaMinutes,
                runtimePurchaseEtaMinutes: evalResult.runtimePurchaseEtaMinutes,
                runtimeSaleEtaMinutes: evalResult.runtimeSaleEtaMinutes,
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
 * @param maxTurnoverMinutes - Max runtime turnover ETA (buy + sell) in minutes.
 * @param minBuyEtaMinutes - Optional lower bound on runtime buy ETA (minutes).
 *   Used by Slow Mode's preferred tier. Defaults to undefined (no lower bound).
 * @param maxBuyEtaMinutes - Optional upper bound on runtime buy ETA (minutes).
 *   Used by Slow Mode's preferred tier. Defaults to undefined (no upper bound).
 */
export const getFirstUnoccupiedMerchableItem = (
    occupiedItemNames: Set<string>,
    availableCoins: number = Infinity,
    buyLimitedItemNames: Set<string> = new Set(),
    isMembersWorld: boolean = true,
    frozenItemNames: Set<string> = new Set(),
    lowballTier: LowballTier = 'any',
    maxTurnoverMinutes: number = RUNTIME_MAX_TURNOVER_MINUTES,
    minBuyEtaMinutes?: number,
    maxBuyEtaMinutes?: number,
): BuyScanResult | null => {
    return scanItemsAtRuntime(
        occupiedItemNames,
        availableCoins,
        buyLimitedItemNames,
        isMembersWorld,
        frozenItemNames,
        lowballTier,
        RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM,
        maxTurnoverMinutes,
        RUNTIME_MIN_ABSOLUTE_PROFIT_GP,
        minBuyEtaMinutes,
        maxBuyEtaMinutes,
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
    /** Runtime buy ETA in minutes (based on the runtime quantity). */
    runtimePurchaseEtaMinutes?: number;
    /** Runtime sell ETA in minutes (based on the runtime quantity). */
    runtimeSaleEtaMinutes?: number;
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
 * @param minProfitGp - Minimum absolute total profit (in gp) for the buy
 *   offer. Prevents placing a buy offer for a tiny quantity of a high-price
 *   item when only a small cash remainder is available (e.g. 250k left → 5
 *   snapdragon seeds → 1k profit — not worth the slot or the setup time).
 *   Defaults to RUNTIME_MIN_ABSOLUTE_PROFIT_GP (20k).
 * @param lowballTier - Which lowball tier to scan. Defaults to `'any'`.
 * @param minBuyEtaMinutes - Optional lower bound on runtime buy ETA (minutes).
 *   Used by Slow Mode's preferred tier. Defaults to undefined (no lower bound).
 * @param maxBuyEtaMinutes - Optional upper bound on runtime buy ETA (minutes).
 *   Used by Slow Mode's preferred tier. Defaults to undefined (no upper bound).
 */
export const getFirstPartialBuyItem = (
    occupiedItemNames: Set<string>,
    availableCoins: number,
    buyLimitedItemNames: Set<string> = new Set(),
    isMembersWorld: boolean = true,
    frozenItemNames: Set<string> = new Set(),
    minProfitGp: number = RUNTIME_MIN_ABSOLUTE_PROFIT_GP,
    lowballTier: LowballTier = 'any',
    minBuyEtaMinutes?: number,
    maxBuyEtaMinutes?: number,
): PartialBuyResult | null => {
    // Use a lower profit/hr threshold for the fallback scan. The primary
    // scan uses 20000; here we use 5000 to catch items that are still
    // marginally profitable. The minProfitGp parameter is the absolute
    // profit floor — an offer that would earn less than this in total is
    // skipped (not worth the slot or setup time).
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
        minProfitGp, // absolute profit floor
        minBuyEtaMinutes,
        maxBuyEtaMinutes,
    );
    if (!result) return null;
    return {
        item: result.item,
        quantity: result.quantity,
        totalCost: result.totalCost,
        runtimePurchaseEtaMinutes: result.runtimePurchaseEtaMinutes,
        runtimeSaleEtaMinutes: result.runtimeSaleEtaMinutes,
    };
};
