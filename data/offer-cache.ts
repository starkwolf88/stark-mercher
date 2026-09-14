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
import { getMerchableItem, computeRuntimeEtas, BASE_FILL_TIME_MIN, type MerchableItem } from './merchable-items.js';
import { getPriceHistoryEntry, isPriceHistoryFresh } from './price-history.js';
import { getGeTax, GE_TAX_EXEMPTION_THRESHOLD } from '../grand_exchange/constants.js';

/**
 * Returns the minimum sell price that yields at least 1gp net profit after
 * GE tax for a given buy price. For sell prices below the 50gp tax-exemption
 * threshold, no tax applies so the floor is simply buyPrice + 1.
 *
 * For taxed items: net = sell - floor(sell * 0.02) > buyPrice
 *   => sell * 0.98 > buyPrice (approximately, ignoring floor())
 *   => sell > buyPrice / 0.98
 *   => sell >= ceil(buyPrice / 0.98) + 1 (to ensure strictly > buyPrice net)
 *
 * Used as the revision floor at every stage (pre-abandon, abandon, and
 * final dump) so the bot never re-lists a sell offer at a price that
 * guarantees a loss after tax. Previously the abandon and final-dump
 * stages dropped below buyPrice to free stuck slots; this caused
 * confirmed losses (Redwood logs -10,272gp, Grimy ranarr weed
 * -64,264gp) where the dump price sold instantly below the buy price.
 * The floor is now uniformly taxBreakEvenFloor(buyPrice) — if the
 * market has moved below break-even, the item cycles at the floor
 * until it sells rather than being dumped at a guaranteed loss.
 */
export const taxBreakEvenFloor = (buyPrice: number): number => {
    // Below the exemption threshold, no tax — floor is simply buy + 1.
    if (buyPrice < GE_TAX_EXEMPTION_THRESHOLD) return buyPrice + 1;
    // ceil(buyPrice / 0.98) is the smallest sell price where
    // sell - floor(sell * 0.02) >= buyPrice. Add 1 for strictly > buyPrice.
    return Math.ceil(buyPrice / 0.98) + 1;
};

/** Maximum ETA (minutes) for reconstructed entries computed from priceHistory
 *  1h volume data. Low-volume items produce absurd ETAs (e.g. Goat horn at
 *  3442min / 57h) that would leave a slot occupied for days before any stale
 *  check fires. The cap gives low-volume reconstructed sells a reasonable
 *  stale window without affecting high-volume items. */
const RECONSTRUCTED_ETA_CAP_MIN = 120;

/** Value-aware sell ETA cap. Low-volume items produce absurd runtime sell ETAs
 *  (e.g. Goat horn: 763 qty at ~13 units/hr = 3442min / 57h). A flat cap still
 *  wastes slot time on low-profit items — waiting 120min for 500 Goat horns
 *  at 10k total profit ties up a slot that could earn 20k+/hr on a better item.
 *
 *  The cap scales with the item's total net profit so low-profit items get a
 *  shorter stale window (slot freed sooner) while high-profit items get the
 *  full 120min:
 *    cap = clamp(totalNetProfit * 60 / PROFIT_PER_HOUR_REFERENCE, MIN, MAX)
 *
 *  PROFIT_PER_HOUR_REFERENCE is the same 20k threshold the bot uses to select
 *  buy items (RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM) — if a sell earns less per
 *  hour than a new buy cycle would, the slot is underperforming and should be
 *  freed sooner.
 *
 *  Examples:
 *    5k profit  → 15min (floor) — slot worth far more than this item
 *    10k profit → 30min        — low-profit, free slot for better items
 *    20k profit → 60min        — moderate profit, moderate patience
 *    40k profit → 120min (cap) — high profit, full patience
 *
 *  The cap tightens automatically after revisions: re-listing at a lower sell
 *  price reduces totalNetProfit, so an item that started at 40k (120min cap)
 *  might be 25k (75min cap) at rev 4, causing earlier stale checks as the
 *  margin erodes. */
const RUNTIME_SELL_ETA_CAP_MIN_MIN = 15;
const RUNTIME_SELL_ETA_CAP_MAX_MIN = 120;
const RUNTIME_SELL_ETA_CAP_PROFIT_PER_HOUR_REFERENCE = 20000;

/** Computes the value-aware sell ETA cap for an item based on its total net
 *  profit. See RUNTIME_SELL_ETA_CAP_* constants above for the formula and
 *  rationale. Returns the capped ETA (never larger than the input). */
const computeValueAwareSellEtaCap = (
    runtimeSellEtaMinutes: number,
    sellPrice: number,
    buyPrice: number,
    quantity: number,
): number => {
    if (runtimeSellEtaMinutes <= RUNTIME_SELL_ETA_CAP_MIN_MIN) return runtimeSellEtaMinutes;
    const netSell = sellPrice - getGeTax(sellPrice);
    const totalNetProfit = Math.max(0, (netSell - buyPrice) * quantity);
    const cap = Math.max(
        RUNTIME_SELL_ETA_CAP_MIN_MIN,
        Math.min(RUNTIME_SELL_ETA_CAP_MAX_MIN, Math.round(totalNetProfit * 60 / RUNTIME_SELL_ETA_CAP_PROFIT_PER_HOUR_REFERENCE)),
    );
    return Math.min(runtimeSellEtaMinutes, cap);
};

// --- Price revision constants ----------------------------------------------
// The revision strategy reduces the sale price each time an offer is
// re-listed after not selling. The reduction escalates with the number of
// failed revisions so the bot finds the market price faster instead of
// slowly chasing a falling market with tiny cuts.
//
// Escalation schedule (by revision count, 0-indexed):
//   Revisions 0-1:  5% of gross profit (gentle — give the market time)
//   Revisions 2-3:  8% of gross profit (moderate — market is lower than expected)
//   Revisions 4-5: 12% of gross profit (aggressive — clearly overpriced)
//   Revision  6:   ABANDON — drop sell price directly to the tax-break-even floor
//   Revision  7:   12% of remaining margin at the lower floor
//   Revision  8:   FINAL DUMP — sell at the tax-break-even floor
//   Revision  9+:  CONTROLLED LOSS DUMP — price below the tax-break-even floor
//                  (3% of buyPrice per revision, min 5gp, capped at 80% of
//                  buyPrice) after a hold period to free stuck slots
//
// The minimum reduction is 1 gp so even thin-margin items get a nudge.
// The floor at rev 0-8 is the tax-break-even price
// (sell - 2% GE tax > buyPrice), so the bot never re-lists at a
// guaranteed loss after tax. At rev 9+ (controlled loss dump), the floor
// is lowered to 80% of buyPrice — a controlled loss is accepted to free
// the slot after the hold timer expires.
//
// Examples (1743 gp item, buy=1685, profit=58, tax-break-even floor=1723):
//   Rev 0: reduction = max(1, floor(58 * 0.10)) = 5 gp  → 1738
//   Rev 1: reduction = max(1, floor(53 * 0.10)) = 5 gp  → 1733
//   Rev 2: reduction = max(1, floor(48 * 0.12)) = 5 gp  → 1728
//   Rev 3: reduction = max(1, floor(43 * 0.12)) = 5 gp  → 1723 (clamped to floor 1723)
//   Rev 4: reduction = max(1, floor(38 * 0.15)) = 5 gp  → 1723 (clamped to floor)
//          → floor-hit marker (already at floor, no price change)
//   Rev 5: floor-hit marker
//   Rev 6: ABANDON → sell price drops directly to 1723 (already at floor)
//   Rev 7: floor-hit marker (already at floor, no price change)
//   Rev 8: FINAL DUMP → sell at 1723 (tax-break-even floor)

const REVISION_RATES = [0.10, 0.10, 0.12, 0.12, 0.15, 0.15]; // escalating % of gross profit
const THIN_MARGIN_REVISION_RATES = [0.10, 0.10, 0.12, 0.12, 0.15, 0.15]; // thin-margin: same rates (margin floors the reduction anyway)
const THIN_MARGIN_REVISION_THRESHOLD_GP = 10; // gross margin < this uses thin-margin rates
const MIN_REDUCTION_GP = 1;             // never reduce by 0
const ABANDON_REVISION_COUNT = 6;       // after this many 0%-progress revisions, drop directly to the floor
const FINAL_DUMP_REVISION_COUNT = 8;    // after this many revisions, sell at the floor (no further reduction possible)
// --- Controlled loss dump (Option 1 — controlled loss acceptance) ----------
// After the final dump (rev 8) at the tax break-even floor, if the offer is
// still stuck at 0% progress after a hold period, the bot accepts a controlled
// loss by pricing BELOW the tax break-even floor to free the slot. Each
// controlled loss revision reduces the sell price by 3% of buyPrice (min 5gp),
// capped at 80% of buyPrice. Up to 4 controlled loss revisions (rev 9-12) are
// applied at 30-minute intervals before the offer is left at the minimum.
const CONTROLLED_LOSS_REVISION_COUNT = 9;  // first revision below tax break-even floor
const CONTROLLED_LOSS_REDUCTION_RATE = 0.03; // 3% of buyPrice per revision
const CONTROLLED_LOSS_MIN_REDUCTION_GP = 5;  // minimum reduction amount
const CONTROLLED_LOSS_MIN_PRICE_RATIO = 0.80; // never price below 80% of buyPrice
const CONTROLLED_LOSS_MAX_REVISIONS = 4;     // max 4 controlled loss revisions (rev 9-12)
/** Margin-aware floor-hit abandon thresholds. When an item is already at
 *  the tax break-even floor and still not selling, cycling at the same
 *  price for the full 6-revision schedule wastes ~50+ minutes (e.g.
 *  Wrath rune: 3 × 17min cycles). Abandon early to free the slot sooner.
 *
 *  The threshold is margin-aware to avoid costly abandons on thin-margin
 *  bulk items (e.g. Revenant ether: 5gp margin, 25k units — abandoning
 *  cost -120,000gp when the item was selling slowly but profitably):
 *   - Thin margin (< THIN_MARGIN_GP_THRESHOLD gp): THIN_MARGIN_FLOOR_HIT_THRESHOLD
 *     (4 hits) — these items sell slowly but profitably; abandoning is very
 *     costly due to large quantity, so give them more cycles to clear.
 *   - Thick margin (>= THIN_MARGIN_GP_THRESHOLD gp): THICK_MARGIN_FLOOR_HIT_THRESHOLD
 *     (2 hits) — if stuck at the floor, the slot is worth more than waiting. */
const THIN_MARGIN_GP_THRESHOLD = 10;
const THIN_MARGIN_FLOOR_HIT_THRESHOLD = 4;
const THICK_MARGIN_FLOOR_HIT_THRESHOLD = 2;

/** Returns the margin-aware floor-hit abandon threshold for an entry.
 *  Uses the original gross margin (originalSellPrice - buyPrice) since
 *  revisions may have eroded the current sell price. */
function floorHitAbandonThreshold(entry: OfferCacheEntry): number {
    const grossMargin = entry.originalSellPrice - entry.buyPrice;
    return grossMargin < THIN_MARGIN_GP_THRESHOLD
        ? THIN_MARGIN_FLOOR_HIT_THRESHOLD
        : THICK_MARGIN_FLOOR_HIT_THRESHOLD;
}

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

    /**
     * Marks the cache as dirty so the next save() will persist. Used when
     * a caller mutates an entry obtained via get() directly (e.g. updating
     * offerPlacedAt/sellConfirmed in reverse reconciliation).
     */
    markDirty(): void {
        this.dirty = true;
    }

    /**
     * Returns the account name this cache manager is bound to.
     */
    getAccountName(): string {
        return this.accountName;
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
     *
     * @param runtimePurchaseEtaMinutes - Runtime buy ETA based on the actual
     *   affordable quantity (not the simulation quantity). If provided, this
     *   is stored instead of the simulation ETA from merchableItems.json so
     *   the stale checker and cache dump reflect the actual offer size.
     * @param runtimeSaleEtaMinutes - Runtime sell ETA based on the actual
     *   quantity. Same purpose as above for the sell side.
     * @param runtimeQuantity - The actual quantity the buy flow is about to
     *   type into the GE config screen (after cash-stack and buy-limit
     *   adjustment). Persisted as `buyQuantity` so a BuyOfferFlow can be
     *   reconstructed after a plugin reload mid-flow. If omitted, falls back
     *   to `item.quantityToPurchase` (the simulation value).
     */
    recordBuyOffer(
        item: MerchableItem,
        runtimePurchaseEtaMinutes?: number,
        runtimeSaleEtaMinutes?: number,
        runtimeQuantity?: number,
    ): void {
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
            // Prefer runtime ETAs (based on actual affordable quantity) over
            // simulation ETAs (based on the 50m cash stack quantity). Runtime
            // ETAs are accurate for the actual offer size and produce correct
            // stale-check thresholds and cache dump display values.
            purchaseEtaMinutes: runtimePurchaseEtaMinutes ?? item.purchaseEtaMinutes,
            saleEtaMinutes: runtimeSaleEtaMinutes ?? item.saleEtaMinutes,
            totalBought,
            firstBoughtAt,
            limitReachedAt,
            // No-progress tracking: initialised to 0 progress at placement.
            // The stale-check loop updates these when live progress changes.
            lastBuyProgress: 0,
            lastBuyProgressAt: Date.now(),
            // Persist the actual quantity the buy flow is about to type, so
            // a BuyOfferFlow can be reconstructed after a reload mid-flow.
            buyQuantity: runtimeQuantity ?? item.quantityToPurchase,
            // The buy price is now known from the merchable item — clear any
            // reconstructed buy price flag from a previous reconstruction.
            reconstructedBuyPrice: false,
        };
        this.dirty = true;
        if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: recorded buy offer for %s (buy=%d, sell=%d)',
            key, item.purchasePrice, item.salePrice);
    }

    /**
     * Reconstructs a cache entry from a live GE slot after the cache was lost
     * (e.g. client restart that didn't persist the hidden setting). Uses
     * merchableItems.json for prices/ETAs, falling back to priceHistory.json
     * (1h average prices) when the item is no longer in the merchable list.
     *
     * The reconstructed entry uses Date.now() as offerPlacedAt since the
     * actual placement time is unknown. This gives the offer a fresh full ETA
     * window before staleness checks can abort it — the safest choice since
     * aborting an offer we know nothing about could discard partial fills.
     *
     * For sell offers, sellQuantity is set from the slot's item quantity so
     * the completed-sell sweep can record profit when the sell finishes.
     * sellConfirmed is set to true since the offer is already live on the GE.
     *
     * If slotPrice is provided (parsed from the GE slot's priceText widget),
     * it is used as the actual offer price instead of the merch/priceHistory
     * fallback. For sell offers, slotPrice becomes sellPrice; for buy offers,
     * slotPrice becomes buyPrice. This prevents false loss/profit recording
     * when the actual offer price differs from the 1h market average.
     *
     * Returns true if an entry was created, false if no price data was found
     * (the caller should leave the slot alone in that case).
     */
    reconstructEntry(
        itemName: string,
        slotType: 'buy' | 'sell',
        slotQuantity: number,
        slotPrice?: number,
    ): boolean {
        const key = itemName;
        if (this.get(key)) return false; // already has an entry

        const merch = getMerchableItem(itemName);
        let buyPrice: number;
        let sellPrice: number;
        let purchaseEtaMinutes: number;
        let saleEtaMinutes: number;

        if (merch) {
            buyPrice = merch.purchasePrice;
            sellPrice = merch.salePrice;
            // Recalculate ETAs from the actual offer quantity using the same
            // runtime ETA formula (50% market share, 15% 2h buffer, lowball
            // penalty, BASE_FILL_TIME_MIN) rather than using the simulation
            // ETAs from merchableItems.json (which are based on the 50m cash
            // stack allocation quantity, not the actual offer quantity).
            // Without this, a reconstructed buy offer for Ancient essence at
            // 124k units would inherit the 113min simulation ETA instead of
            // the correct ~42min runtime ETA, causing the stale checker to
            // wait ~54min longer than it should before aborting.
            const runtimeEtas = computeRuntimeEtas(merch, slotQuantity);
            if (runtimeEtas) {
                purchaseEtaMinutes = Math.min(runtimeEtas.purchaseEtaMinutes, RECONSTRUCTED_ETA_CAP_MIN);
                saleEtaMinutes = Math.min(runtimeEtas.saleEtaMinutes, RECONSTRUCTED_ETA_CAP_MIN);
            } else {
                purchaseEtaMinutes = merch.purchaseEtaMinutes;
                saleEtaMinutes = merch.saleEtaMinutes;
            }
        } else {
            const history = getPriceHistoryEntry(itemName);
            if (!history || history.sell <= 0) {
                return false; // no price data anywhere — can't reconstruct
            }
            // Freshness warning: if the priceHistory data is stale (>10 min),
            // the reconstructed price may be inaccurate. We still reconstruct
            // so the offer is managed (stale checks, profit tracking) rather
            // than sitting unmanaged forever — but log a warning so the user
            // knows the price may be wrong.
            if (!isPriceHistoryFresh(history)) {
                const ageMin = Math.round((Date.now() - history.fetchedAt) / 60000);
                if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: reconstructing %s from stale priceHistory (%d min old — sell=%d, buy=%d) — determine-flips.mjs may have stopped',
                    itemName, ageMin, history.sell, history.buy);
            }
            buyPrice = history.buy;
            sellPrice = history.sell;
            // Compute approximate ETAs from 1h volume data if available.
            // Uses the same non-linear ETA model as computeRuntimeEtas:
            //   eta = BASE_FILL_TIME_MIN + quantity / (effectiveVolume / 60)
            // with 50% market share and 15% 2h volume buffer. Without the
            // base-fill component, high-volume items with small quantities
            // (e.g. Blighted anglerfish at 3781 units, buyVolume 111867)
            // produce ETAs below BASE_FILL_TIME_MIN (4.1min) which is
            // mathematically impossible per the model. The base component
            // represents "time to first fill" — GE fills are queue-based
            // and chunky, so even a small order has to wait for sellers.
            // Capped at RECONSTRUCTED_ETA_CAP_MIN — low-volume items produce
            // absurd ETAs (e.g. Goat horn at 3442min / 57h) that would leave
            // a slot occupied for days before any stale check fires. The cap
            // gives low-volume reconstructed sells a reasonable stale window
            // without affecting high-volume items (whose ETAs are well below
            // the cap).
            const share = 0.50;
            const buffer = 1 - 0.15; // 15% 2h volume buffer
            const buyVolPerMin = (history.buyVolume ?? 0) * share * buffer / 60;
            const sellVolPerMin = (history.sellVolume ?? 0) * share * buffer / 60;
            purchaseEtaMinutes = buyVolPerMin > 0
                ? Math.min(BASE_FILL_TIME_MIN + slotQuantity / buyVolPerMin, RECONSTRUCTED_ETA_CAP_MIN)
                : 0;
            saleEtaMinutes = sellVolPerMin > 0
                ? Math.min(BASE_FILL_TIME_MIN + slotQuantity / sellVolPerMin, RECONSTRUCTED_ETA_CAP_MIN)
                : 0;
        }

        // Override with the actual offer price from the GE slot widget if
        // available. The slot's priceText shows the per-unit price the bot
        // typed when placing the offer — this is the real price, not a
        // market average. Using it prevents false loss/profit recording
        // (e.g. Twinflame staff sold at 8.7M but priceHistory 1h avg was
        // 8.6M, producing a false -105k loss after tax).
        const priceSource = slotPrice && slotPrice > 0
            ? 'GE slot priceText'
            : (merch ? 'merchableItems.json' : 'priceHistory.json (1h fallback)');
        if (slotPrice && slotPrice > 0) {
            if (slotType === 'sell') {
                sellPrice = slotPrice;
            } else {
                buyPrice = slotPrice;
            }
        }

        const now = Date.now();
        const entry: OfferCacheEntry = {
            mode: slotType,
            buyPrice,
            sellPrice,
            originalSellPrice: sellPrice,
            offerPlacedAt: now,
            revisedPrices: [sellPrice],
            purchaseEtaMinutes,
            saleEtaMinutes,
            sellConfirmed: true, // offer is already live on the GE
            reconstructed: true, // mark for zero/low-profit abort checks
            reconstructedBuyPrice: true, // buy price is uncertain (from priceHistory/merchableItems)
            // No-progress tracking: initialised to 0 — the stale-check loop
            // will set lastBuyProgress to the live value on the first tick,
            // and lastBuyProgressAt to now. This gives reconstructed buy
            // offers a fresh full no-progress window.
            lastBuyProgress: 0,
            lastBuyProgressAt: now,
        };

        if (slotType === 'sell') {
            entry.sellQuantity = slotQuantity;
            // Sell progress tracking: initialised to 0 — the stale-check loop
            // will set lastSellProgress to the live value on the first tick,
            // and lastSellProgressAt to now. This gives reconstructed sell
            // offers a fresh progress-since-revision window.
            entry.lastSellProgress = 0;
            entry.lastSellProgressAt = now;
        }

        this.cache[key] = entry;
        this.dirty = true;
        if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: reconstructed entry for %s (%s, buy=%d, sell=%d, qty=%d) from %s',
            key, slotType, buyPrice, sellPrice, slotQuantity, priceSource);
        return true;
    }

    /**
     * Fixes a mode mismatch between a live GE slot and the cache entry.
     * This happens when a plugin reload (e.g. npm run build) causes the
     * hidden setting to revert to a stale value — the in-memory
     * sell-mode update was lost, but the GE still has the live offer. Without correction, the stale checker uses wrong-mode data
     * (wrong sell price, wrong sell ETA, wrong elapsed time from the
     * original buy placement) and may prematurely abort the offer.
     *
     * Uses the GE slot's actual price (from priceText) and a fresh
     * placement timestamp. Preserves buy-limit tracking (totalBought,
     * firstBoughtAt, limitReachedAt) and buyPrice from the existing entry.
     * For sell offers, applies the value-aware sell ETA cap (same as
     * recordSellOffer) so low-profit items get an appropriate stale window.
     *
     * @param itemName - The item name (cache key)
     * @param slotType - The live GE slot type ('buy' or 'sell')
     * @param slotQuantity - The quantity from the GE slot
     * @param slotPrice - The per-unit price parsed from the GE slot's priceText
     * @returns true if the entry was corrected, false if no mismatch
     */
    fixModeMismatch(
        itemName: string,
        slotType: 'buy' | 'sell',
        slotQuantity: number,
        slotPrice?: number,
    ): boolean {
        const entry = this.get(itemName);
        if (!entry) return false;
        if (entry.mode === slotType) return false; // no mismatch

        const now = Date.now();
        if (slotType === 'sell') {
            // Cache says buy, GE says sell. The sell-mode data (actual sell
            // price, value-aware capped sell ETA, placement time) was lost
            // when the setting reverted. Restore sell mode using the
            // GE slot's actual price.
            entry.mode = 'sell';
            if (slotPrice !== undefined && slotPrice > 0) {
                entry.sellPrice = slotPrice;
            }
            entry.offerPlacedAt = now;
            entry.sellConfirmed = true; // offer is live on the GE
            entry.sellQuantity = slotQuantity;
            entry.lastSellProgress = 0;
            entry.lastSellProgressAt = now;
            // Append the sell price to revision history if not already present.
            const lastRev = entry.revisedPrices[entry.revisedPrices.length - 1];
            if (entry.revisedPrices.length === 0 || lastRev !== entry.sellPrice) {
                entry.revisedPrices.push(entry.sellPrice);
            }
            // Apply the value-aware sell ETA cap using the restored sell
            // price and quantity, same as recordSellOffer. The existing
            // saleEtaMinutes (from the reverted buy data) is the merchable
            // data's uncapped sell ETA — capping it prevents low-profit
            // items from occupying a slot for too long.
            if (entry.saleEtaMinutes !== undefined && entry.saleEtaMinutes > 0) {
                entry.saleEtaMinutes = computeValueAwareSellEtaCap(
                    entry.saleEtaMinutes,
                    entry.sellPrice,
                    entry.buyPrice,
                    slotQuantity,
                );
            }
            // Clear the reconstructed flag — this is a bot-placed offer
            // whose mode was corrected, not a pre-existing reconstructed one.
            entry.reconstructed = false;
            // Preserve buyPrice, totalBought, firstBoughtAt, limitReachedAt,
            // purchaseEtaMinutes — these are correct from the original buy.
        } else {
            // Cache says sell, GE says buy. A new buy was placed after the
            // sell completed, but the setting reverted to the stale
            // sell data. Restore buy mode using the GE slot's actual price.
            entry.mode = 'buy';
            if (slotPrice !== undefined && slotPrice > 0) {
                entry.buyPrice = slotPrice;
            }
            entry.offerPlacedAt = now;
            entry.lastBuyProgress = 0;
            entry.lastBuyProgressAt = now;
            // Clear sell-specific fields.
            entry.sellQuantity = undefined;
            entry.partialSales = undefined;
            entry.sellConfirmed = undefined;
            entry.lastSellProgress = undefined;
            entry.lastSellProgressAt = undefined;
            entry.reconstructed = false;
            // Preserve buy-limit tracking and ETAs.
        }
        this.dirty = true;
        if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: fixed mode mismatch for %s (%s -> %s, sell=%d, buy=%d, qty=%d)',
            itemName, entry.mode === 'sell' ? 'buy' : 'sell', entry.mode,
            entry.sellPrice, entry.buyPrice, slotQuantity);
        return true;
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
    recordSellOffer(
        itemName: string,
        sellPrice: number,
        buyPrice?: number,
        quantity?: number,
        limit?: number,
        runtimeSellEtaMinutes?: number,
    ): void {
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
            // Update the sell ETA to the runtime value if provided (based on
            // the actual quantity being sold, not the simulation quantity).
            // Apply the value-aware cap so low-profit items get a shorter
            // stale window (slot freed sooner for better items) instead of
            // occupying a slot for hours at a low profit rate.
            if (runtimeSellEtaMinutes !== undefined) {
                const effectiveBuy = buyPrice !== undefined ? buyPrice : existing.buyPrice;
                const effectiveQty = quantity !== undefined ? quantity : (existing.sellQuantity ?? 0);
                existing.saleEtaMinutes = effectiveQty > 0
                    ? computeValueAwareSellEtaCap(runtimeSellEtaMinutes, sellPrice, effectiveBuy, effectiveQty)
                    : runtimeSellEtaMinutes;
            }
            existing.sellConfirmed = false;
            // Clear the reconstructed flag — the bot is now placing its own
            // sell offer, so it is no longer a pre-existing reconstructed
            // offer from a cache loss. This prevents the reconstructed profit
            // guard from firing on every re-list and causing infinite abort
            // cycles (e.g. thin-margin items like Dragonstone).
            existing.reconstructed = false;
            // Reset sell progress tracking — the new offer starts at 0%
            // progress. This gives the progress-since-revision extension a
            // fresh window.
            existing.lastSellProgress = 0;
            existing.lastSellProgressAt = now;
        } else {
            this.cache[key] = {
                mode: 'sell',
                buyPrice: buyPrice ?? 0,
                sellPrice,
                originalSellPrice: sellPrice,
                offerPlacedAt: now,
                revisedPrices: [sellPrice],
                sellConfirmed: false,
                lastSellProgress: 0,
                lastSellProgressAt: now,
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
                    if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: %s buy limit reached (%d/%d) — 4h cooldown started',
                        key, total, limit);
                } else {
                    if (this.bot.logDebugValue) titan.logf('[Stark Mercher] Cache: %s bought qty tracked (%d/%d towards limit)',
                        key, total, limit);
                }
            }
        }

        this.dirty = true;
        if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: recorded sell offer for %s @ %dgp', key, sellPrice);
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
     * Marks the sell offer as confirmed on the GE. Called after the
     * SellOfferFlow completes successfully. Once confirmed, the re-list
     * logic will apply price revisions if the offer is later aborted and
     * re-listed. Before confirmation, a hot-reload causes the re-list
     * logic to skip the revision (the offer was never placed).
     *
     * Also resets offerPlacedAt to now — the offer only became live at the
     * moment the flow completed, not when recordSellOffer was called (which
     * is before the flow starts). Without this, stale checks measure elapsed
     * time from the flow start, not the actual placement, causing false
     * stale aborts shortly after a restart (e.g. Revenant ether was 10min
     * "old" immediately after a restart despite being placed ~1min earlier).
     */
    confirmSellOffer(itemName: string): void {
        const entry = this.get(itemName);
        if (entry && entry.mode === 'sell') {
            entry.sellConfirmed = true;
            entry.offerPlacedAt = Date.now();
            // A confirmed sell is a live, bot-placed offer — never a
            // reconstructed pre-existing one.
            entry.reconstructed = false;
            // Reset sell progress tracking — the offer just went live at 0%
            // progress. This gives the progress-since-revision extension a
            // fresh window measured from the actual placement time.
            entry.lastSellProgress = 0;
            entry.lastSellProgressAt = Date.now();
            this.dirty = true;
        }
    }

    /**
     * Returns true if the sell offer has been confirmed on the GE.
     * Backward compat: undefined (existing entries from before this field
     * was added) is treated as true.
     */
    isSellConfirmed(itemName: string): boolean {
        const entry = this.get(itemName);
        if (!entry) return true;
        return entry.sellConfirmed !== false;
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
        entry.sellConfirmed = undefined;
        entry.lastSellProgress = undefined;
        entry.lastSellProgressAt = undefined;
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
     * Returns the number of times the sell price has been revised (excluding
     * the original listing). This drives the escalation schedule.
     */
    getRevisionCount(itemName: string): number {
        const entry = this.get(itemName);
        if (!entry) return 0;
        return entry.revisedPrices.length > 0 ? entry.revisedPrices.length - 1 : 0;
    }

    /**
     * Returns true if the item has reached the final dump revision count
     * and should be sold at the tax-break-even floor to free the slot.
     */
    isFinalDump(itemName: string): boolean {
        return this.getRevisionCount(itemName) >= FINAL_DUMP_REVISION_COUNT;
    }

    /**
     * Returns true if the item's sell price is at or below the tax-break-even
     * floor AND the revision count has reached the final dump threshold.
     * This means the price has been driven to its lowest possible level —
     * no further revision can reduce it. The stale check should skip such
     * items so they continue filling at their own pace instead of being
     * aborted and re-listed at the same price in an infinite cycle.
     *
     * This can happen when an item's price was driven to the floor by
     * an earlier bug (e.g. the reconstructed zero-profit loop) without
     * going through the normal final-dump revision path. The revision
     * count may be far past FINAL_DUMP_REVISION_COUNT, but the price is
     * already at the floor so computeRevisedSellPrice returns null and
     * reviseSellPrice just pushes another floor-hit marker.
     */
    isAtDumpFloor(itemName: string): boolean {
        const entry = this.get(itemName);
        if (!entry) return false;
        if (!this.isFinalDump(itemName)) return false;
        const dumpFloor = taxBreakEvenFloor(entry.buyPrice);
        return entry.sellPrice <= dumpFloor;
    }

    /**
     * Returns true if the item is at the dump floor (rev >= 8, sell price
     * at or below the tax break-even floor) AND has been stuck at 0% progress
     * for at least holdMin minutes since the last re-list. Used by the stale
     * checker to determine whether the controlled loss dump hold timer has
     * expired and the offer should be aborted for re-pricing below the
     * tax break-even floor.
     */
    isDumpFloorStuck(itemName: string, holdMin: number): boolean {
        const entry = this.get(itemName);
        if (!entry) return false;
        if (!this.isAtDumpFloor(itemName)) return false;
        // Must have 0% progress (no items sold since last re-list)
        if ((entry.lastSellProgress ?? 0) > 0) return false;
        // Must have been at the dump floor for at least holdMin minutes
        const elapsedMin = (Date.now() - entry.offerPlacedAt) / 60000;
        return elapsedMin >= holdMin;
    }

    /**
     * Returns true if the item is at revision count >= 9 (controlled loss
     * territory) and the sell price can still be reduced further (above the
     * controlled loss minimum of 80% of buyPrice). When false, the offer is
     * at the absolute minimum and should be left to fill at its own pace.
     */
    canReduceControlledLoss(itemName: string): boolean {
        const entry = this.get(itemName);
        if (!entry) return false;
        const revCount = this.getRevisionCount(itemName);
        if (revCount < CONTROLLED_LOSS_REVISION_COUNT) return false;
        const minPrice = Math.max(1, Math.floor(entry.buyPrice * CONTROLLED_LOSS_MIN_PRICE_RATIO));
        return entry.sellPrice > minPrice;
    }

    /**
     * Computes a revised sell price for an item that hasn't sold.
     *
     * Escalating reduction strategy:
     *   Revisions 0-1: 10% of gross profit
     *   Revisions 2-3: 12% of gross profit
     *   Revisions 4-5: 15% of gross profit
     *   Revision  6:   Abandon — drop sell price directly to the tax-break-even floor
     *   Revision  7:   15% of remaining margin at the floor
     *   Revision  8:   Final dump — sell at the tax-break-even floor
     *   Revision  9+:  Controlled loss dump — price below the tax-break-even
     *                  floor (3% of buyPrice per revision, min 5gp, capped at
     *                  80% of buyPrice) to free stuck slots after a hold period
     *
     * The floor at every stage (rev 0-8) is the tax-break-even price
     * (sell - 2% GE tax > buyPrice), so the bot never re-lists at a
     * guaranteed loss after tax. If the market has moved below break-even,
     * the item cycles at the floor until it sells rather than being
     * dumped below buyPrice. At rev 9+ (controlled loss dump), the floor
     * is lowered to 80% of buyPrice — a controlled loss is accepted to
     * free the slot for productive trading after the hold timer expires.
     *
     * Returns the new price, or null if the price is already at the
     * applicable floor and can't be reduced further.
     */
    computeRevisedSellPrice(itemName: string): number | null {
        const entry = this.get(itemName);
        if (!entry) return null;

        const currentSell = entry.sellPrice;
        const buyPrice = entry.buyPrice;
        const grossProfit = currentSell - buyPrice;
        const revisionCount = entry.revisedPrices.length > 0 ? entry.revisedPrices.length - 1 : 0;

        // Controlled loss dump (rev 9+): after the hold timer at the dump
        // floor has expired, price BELOW the tax break-even floor to free
        // the slot. Each revision reduces by 3% of buyPrice (min 5gp),
        // capped at 80% of buyPrice. This accepts a controlled loss to
        // recover the slot for productive trading (Option 1).
        if (revisionCount >= CONTROLLED_LOSS_REVISION_COUNT) {
            const minPrice = Math.max(1, Math.floor(buyPrice * CONTROLLED_LOSS_MIN_PRICE_RATIO));
            if (currentSell <= minPrice) {
                if (this.bot.logDebugValue) titan.logf('[Stark Mercher] Cache: %s already at controlled loss minimum (%dgp <= %dgp) — cannot reduce further',
                    itemName, currentSell, minPrice);
                return null;
            }
            const reduction = Math.max(CONTROLLED_LOSS_MIN_REDUCTION_GP, Math.floor(buyPrice * CONTROLLED_LOSS_REDUCTION_RATE));
            const newPrice = Math.max(minPrice, currentSell - reduction);
            if (newPrice >= currentSell) {
                if (this.bot.logDebugValue) titan.logf('[Stark Mercher] Cache: %s already at controlled loss minimum (%dgp) — cannot reduce',
                    itemName, currentSell);
                return null;
            }
            if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: %s controlled loss dump — sell price %d -> %d gp (below tax break-even floor, buy %d) to free slot',
                itemName, currentSell, newPrice, buyPrice);
            return newPrice;
        }

        // Final dump: sell at the tax-break-even floor to free the slot.
        if (revisionCount >= FINAL_DUMP_REVISION_COUNT) {
            const dumpPrice = taxBreakEvenFloor(buyPrice);
            if (dumpPrice >= currentSell) {
                if (this.bot.logDebugValue) titan.logf('[Stark Mercher] Cache: %s already at or below dump price (%dgp <= %dgp) — cannot dump',
                    itemName, currentSell, dumpPrice);
                return null;
            }
            if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: %s final dump — sell at %dgp (tax-break-even floor for buy %d) to free slot',
                itemName, dumpPrice, buyPrice);
            return dumpPrice;
        }

        // Determine the reduction rate based on the escalation schedule.
        // Thin-margin items (< THIN_MARGIN_REVISION_THRESHOLD_GP gp gross
        // margin) use a more aggressive schedule so they reach a market-
        // clearing price faster instead of cycling at 1gp reductions.
        const originalGrossMargin = entry.originalSellPrice - buyPrice;
        const rates = originalGrossMargin < THIN_MARGIN_REVISION_THRESHOLD_GP
            ? THIN_MARGIN_REVISION_RATES
            : REVISION_RATES;
        const rateIndex = Math.min(revisionCount, rates.length - 1);
        const rate = rates[rateIndex];

        // The floor is the tax-break-even price at every stage (sell - 2% GE
        // tax > buyPrice), so the bot never re-lists at a guaranteed loss
        // after tax. If the market has moved below break-even, the item
        // cycles at the floor until it sells.
        const abandoned = revisionCount >= ABANDON_REVISION_COUNT;
        const floor = taxBreakEvenFloor(buyPrice);

        // First abandon revision — drop directly to the floor to free the
        // slot immediately. A percentage-based reduction would only chip
        // away at the price slowly (e.g. Rune platebody: 119gp reduction on
        // a 998gp margin leaves the price at 39449, still 879gp above the
        // 38568 floor), causing many cycles before the slot is freed.
        // Dropping directly to the floor matches the early-abandon path and
        // the log message's stated intent.
        if (abandoned && revisionCount === ABANDON_REVISION_COUNT) {
            if (floor >= currentSell) {
                if (this.bot.logDebugValue) titan.logf('[Stark Mercher] Cache: %s already at abandon floor (%dgp) — cannot revise',
                    itemName, currentSell);
                return null;
            }
            if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: %s abandoning — sell price %d -> %d gp (tax-break-even floor for buy %d) to free slot',
                itemName, currentSell, floor, buyPrice);
            return floor;
        }

        // Reduction is a percentage of gross profit, minimum 1 gp.
        const effectiveProfit = Math.abs(grossProfit);
        const reduction = Math.max(MIN_REDUCTION_GP, Math.floor(effectiveProfit * rate));

        const newPrice = Math.max(floor, currentSell - reduction);

        if (newPrice >= currentSell) {
            if (this.bot.logDebugValue) titan.logf('[Stark Mercher] Cache: %s already at %s floor (%dgp) — cannot revise',
                itemName, abandoned ? 'abandon' : 'price', currentSell);
            return null;
        }

        return newPrice;
    }

    /**
     * Revises the sell price for an item and records the new price in the
     * cache. Returns the new price, or the current price if the price is
     * already at the floor and can't be reduced further (floor-hit marker —
     * the revision count still advances so the abandon/final-dump thresholds
     * are reachable). Returns null only if the item has no cache entry.
     *
     * Floor-hit handling: when computeRevisedSellPrice returns null because
     * the price is already at the tax-break-even floor (or the dump price),
     * we push the current price to revisedPrices as a "floor-hit marker".
     * This advances the revision count (revisedPrices.length - 1) so that
     * floor-stuck items like Ancient essence (buy=18, sell=19, floor=19)
     * can eventually reach the abandon threshold (rev 6) and final dump
     * (rev 8) instead of looping forever at the same price with revision
     * count frozen at 0. The caller re-lists at the same price, but the
     * next call to computeRevisedSellPrice will see the advanced count.
     *
     * Early abandon for floor-stuck items: if the item has had enough
     * consecutive floor-hit revisions (margin-aware threshold — 4 for
     * thin-margin items < 10gp, 2 for thick-margin items) where the price
     * couldn't be reduced and the item still isn't selling, skip the
     * remaining normal revisions and abandon immediately — drop the sell
     * price to the tax-break-even floor to free the slot. This prevents
     * cycling at the same floor price for ~50+ minutes (e.g. Wrath rune:
     * 3 × 17min cycles at 342gp) when the item clearly isn't going to sell
     * at that price. Thin-margin bulk items get more cycles since
     * abandoning them is very costly (e.g. Revenant ether: 5gp margin ×
     * 25k units = -120,000gp loss on abandon). floorHitCount is reset to
     * 0 whenever a price revision actually changes the price (the item is
     * no longer stuck).
     */
    reviseSellPrice(itemName: string): number | null {
        const entry = this.get(itemName);
        if (!entry) return null;

        const newPrice = this.computeRevisedSellPrice(itemName);
        if (newPrice === null) {
            // Floor hit — the price can't be reduced further.
            // Track consecutive floor-hits for early abandon.
            entry.floorHitCount = (entry.floorHitCount ?? 0) + 1;
            const threshold = floorHitAbandonThreshold(entry);

            // Early abandon: after the margin-aware threshold consecutive
            // floor-hits, drop to the tax-break-even floor to free the
            // slot instead of cycling at the same price for the full
            // 6-revision schedule.
            if (entry.floorHitCount >= threshold) {
                const abandonFloor = taxBreakEvenFloor(entry.buyPrice);
                if (entry.sellPrice > abandonFloor) {
                    const oldPrice = entry.sellPrice;
                    entry.sellPrice = abandonFloor;
                    entry.offerPlacedAt = Date.now();
                    entry.revisedPrices.push(abandonFloor);
                    // Reset sell progress — the re-listed offer starts at 0%.
                    entry.lastSellProgress = 0;
                    entry.lastSellProgressAt = Date.now();
                    this.dirty = true;
                    if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: %s early abandon after %d floor-hits — sell price %d -> %d gp (tax-break-even floor for buy %d) to free slot',
                        itemName, entry.floorHitCount, oldPrice, abandonFloor, entry.buyPrice);
                    return abandonFloor;
                }
            }

            // Not at early-abandon threshold yet — push the current price
            // as a "floor-hit marker" and return it so the caller re-lists
            // at the same price with an advanced count.
            entry.revisedPrices.push(entry.sellPrice);
            entry.offerPlacedAt = Date.now();
            // Reset sell progress — the re-listed offer starts at 0%.
            entry.lastSellProgress = 0;
            entry.lastSellProgressAt = Date.now();
            this.dirty = true;
            const revCount = entry.revisedPrices.length - 1;
            if (this.bot.logDebugValue) titan.logf('[Stark Mercher] Cache: %s at price floor (%dgp) — revision count advanced to %d, floor-hit %d/%d (no price change)',
                itemName, entry.sellPrice, revCount, entry.floorHitCount, threshold);
            return entry.sellPrice;
        }

        // Price actually changed — reset the floor-hit counter since the
        // item is no longer stuck at the floor.
        entry.floorHitCount = 0;
        entry.sellPrice = newPrice;
        entry.offerPlacedAt = Date.now();
        // Reset sell progress — the re-listed offer starts at 0%.
        entry.lastSellProgress = 0;
        entry.lastSellProgressAt = Date.now();
        if (entry.revisedPrices.length === 0 || entry.revisedPrices[entry.revisedPrices.length - 1] !== newPrice) {
            entry.revisedPrices.push(newPrice);
        }
        this.dirty = true;
        if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: revised %s sell price %d -> %d gp',
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
            if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: removed %s', itemName);
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
            if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: post-login cleanup removed %d expired idle entr%s',
                removed, removed === 1 ? 'y' : 'ies');
        } else {
            if (this.bot.logDebugValue) titan.log('[Stark Mercher] Cache: post-login cleanup — no expired idle entries to remove');
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
            if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: %s buy limit window expired — limit reset', itemName);
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
            if (this.bot.logInfoValue) titan.logf('[Stark Mercher] Cache: %s buy limit window expired — limit reset', itemName);
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
