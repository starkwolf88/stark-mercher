// ============================================================================
// Auto-merch loop — the main automation state machine
// ============================================================================
// This is the production loop that runs when "Normal" or "Slow" mode is enabled.
// It replaces the idle behavior while preserving the test buttons for
// debugging.
//
// Loop order (each tick):
//   1. If GE not open → walk to GE / open GE / idle
//   2. Get all slot states
//   3. If any slot has a completed/aborted offer:
//      a. Remove sold items from cache
//      b. Click collect, delay, return (re-loop next tick)
//   4. Stale offers flow (abort offers that have exceeded ETA thresholds)
//   5. Selling flow (list inventory items for sale in empty slots)
//   6. Buying flow (place buy offers for merchable items in empty slots)
//
// Only one action is dispatched per tick. The loop uses the existing
// BuyOfferFlow, SellOfferFlow, and AbortOfferFlow state machines for
// multi-tick operations. When a flow is active, the loop defers to it
// until it completes (done/failed), then returns to the top of the loop.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { setAction, canPerformAction } from '../general/timing.js';
import { formatQty, formatGpShort } from '../general/helpers.js';
import { createDelay, getActiveDelayProfile, setDelayProfileForAccount, getLastDelayLayers } from '../antiban/humanised-delay.js';
import { setClickJitterProfile, generateClickJitterProfile, setClickJitterDebugLog, sendKeyWithJitter } from '../antiban/click-jitter.js';
import { setTypingMistakeProfileForAccount, setTypingMistakeDebugLog } from '../input/typing-mistakes.js';
import { BuyOfferFlow, SellOfferFlow, AbortOfferFlow } from './index.js';
import {
    isGeOpen,
    isOfferConfigOpen,
    isSearchPromptShown,
    isPricePromptShown,
    auditGeState,
    getOfferSlotState,
    offerSlotCount,
    findEmptyOfferSlot,
    isMembersWorld,
    invalidateGeWidgetCache,
    invalidateBooleanStateCache,
    type OfferSlotState,
} from './widgets.js';
import { clickCollectToInventory, setClickWidgetDebugLog } from './actions.js';
import { getNetSellPrice, getGeTax } from './constants.js';
import { openGe, nearGrandExchange, walkToGe } from './clerk.js';
import { getMerchableItems, getMerchableItem, getFirstUnoccupiedMerchableItem, getFirstPartialBuyItem, isLowballItem, evaluateItemAtRuntime, computeRuntimeSellEtaMinutes, getEffectiveMinVolume, isMerchableDataValid, setF2pMode, RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM, RUNTIME_MAX_TURNOVER_MINUTES, RUNTIME_MIN_ABSOLUTE_PROFIT_GP, RUNTIME_MIN_EFFECTIVE_VOLUME, type MerchableItem, type PartialBuyResult, type BuyScanResult, type LowballTier } from '../data/merchable-items.js';
import { getMinutesUntilNightlySleep } from '../antiban/session.js';
import { isRotationDueForLoggedIn } from '../antiban/account-rotation.js';
import { getPriceHistoryEntry, isPriceHistoryFresh } from '../data/price-history.js';
import { OfferCacheManager, taxBreakEvenFloor } from '../data/offer-cache.js';
import { addDailyProfit } from '../data/daily-profit.js';
import { recordMerchCycle, getMerchHistory, type MerchHistoryEntry } from '../data/merch-history.js';
import { recordAbort, getAbortHistory, type AbortCategory } from '../data/abort-history.js';
import { updateProfitDisplay } from '../general/dump.js';
import { startChocolateDust, chocolateDustTick, hasIdleActivityItems as hasChocolateDustItems, CHOCOLATE_DUST_EXCLUDED_SELL_IDS, CHOCOLATE_DUST_INGREDIENT_NAMES, CHOCOLATE_DUST_RESULT_PRODUCT_NAMES } from '../idle-activity/chocolate-dust.js';
import { startGoatHorn, goatHornTick, hasGoatHornItems, GOAT_HORN_EXCLUDED_SELL_IDS, GOAT_HORN_INGREDIENT_NAMES, GOAT_HORN_RESULT_PRODUCT_NAMES } from '../idle-activity/goat-horn.js';
import { startUltraCompost, ultraCompostTick, hasUltraCompostItems, ULTRA_COMPOST_EXCLUDED_SELL_IDS, ULTRA_COMPOST_INGREDIENT_NAMES, ULTRA_COMPOST_RESULT_PRODUCT_NAMES } from '../idle-activity/ultra-compost.js';
import { hasAnyActivityItems, ANY_EXCLUDED_SELL_IDS, ANY_INGREDIENT_NAMES, ANY_RESULT_PRODUCT_NAMES, startScanning, anyActivityTick } from '../idle-activity/any-activity.js';
import { expandWithNotedIds } from '../idle-activity/idle-deposit.js';

// --- Idle activity dispatch -------------------------------------------------
// Dispatches to the correct idle activity based on the selected setting.
// 0 = None, 1 = Chocolate Dust, 2 = Ultra Compost, 3 = Goat Horn Dust,
// 4 = Any (search bank for ingredients, randomly pick an activity).
const IDLE_ACTIVITY_NONE = 0;
const IDLE_ACTIVITY_CHOCOLATE_DUST = 1;
const IDLE_ACTIVITY_ULTRA_COMPOST = 2;
const IDLE_ACTIVITY_GOAT_HORN = 3;
const IDLE_ACTIVITY_ANY = 4;

/** Returns true if the inventory contains items from the selected idle
 *  activity. Used as a safety check before GE operations to prevent
 *  selling/collecting with idle items in the inventory. Dispatches to the
 *  activity-specific check based on the selected idle activity. */
const hasIdleActivityItems = (bot: StarkMercher): boolean => {
    const activity = bot.idleActivityValue;
    if (activity === IDLE_ACTIVITY_CHOCOLATE_DUST) return hasChocolateDustItems();
    if (activity === IDLE_ACTIVITY_ULTRA_COMPOST) return hasUltraCompostItems();
    if (activity === IDLE_ACTIVITY_GOAT_HORN) return hasGoatHornItems();
    if (activity === IDLE_ACTIVITY_ANY) return hasAnyActivityItems();
    // "None" — still detect any-activity items so the GE guards (collect,
    // sell, buy, stale) block flows while idle items are in the inventory.
    // The cleanup-for-GE trigger below banks them before GE logic resumes.
    // Without this, the bot would collect/sell/buy with idle items still
    // occupying inventory slots.
    return hasAnyActivityItems();
};

/** Returns the set of item IDs that must never be sold on the GE for the
 *  selected idle activity. The sell scan filters these out so idle activity
 *  ingredients (e.g. volcanic ash, knife, chocolate bars) are never listed
 *  for sale, even when they're kept in the inventory across cycles.
 *
 *  The returned set includes each item's NOTED variant — ingredients
 *  collected from manual GE buy offers arrive noted with a different item
 *  ID, and an unnoted-only filter would let the sell scan list them (this
 *  was observed with noted supercompost being sold). The expanded set is
 *  cached per base set so the one-time ItemDef lookups don't repeat. */
let excludedSellExpandedBase: ReadonlySet<number> | null = null;
let excludedSellExpanded: ReadonlySet<number> = new Set();
const getIdleActivityExcludedSellIds = (bot: StarkMercher): ReadonlySet<number> => {
    const activity = bot.idleActivityValue;
    let base: ReadonlySet<number>;
    if (activity === IDLE_ACTIVITY_CHOCOLATE_DUST) base = CHOCOLATE_DUST_EXCLUDED_SELL_IDS;
    else if (activity === IDLE_ACTIVITY_ULTRA_COMPOST) base = ULTRA_COMPOST_EXCLUDED_SELL_IDS;
    else if (activity === IDLE_ACTIVITY_GOAT_HORN) base = GOAT_HORN_EXCLUDED_SELL_IDS;
    else if (activity === IDLE_ACTIVITY_ANY) base = ANY_EXCLUDED_SELL_IDS;
    else return EMPTY_SET; // None — hasAnyActivityItems guards block GE flows while idle items are in inventory
    if (excludedSellExpandedBase !== base) {
        excludedSellExpandedBase = base;
        excludedSellExpanded = expandWithNotedIds(base);
    }
    return excludedSellExpanded;
};
const EMPTY_SET: ReadonlySet<number> = new Set();
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

/** Returns the set of lowercased ingredient names for the selected idle
 *  activity. When an idle activity is selected, buy offers for these items
 *  are never aborted as stale — the user is manually buying them for the
 *  activity. The slots are already occupied by active buys, so the buy
 *  scan won't try to use them for new merch offers. */
const getIdleActivityIngredientNames = (bot: StarkMercher): ReadonlySet<string> => {
    const activity = bot.idleActivityValue;
    if (activity === IDLE_ACTIVITY_CHOCOLATE_DUST) return CHOCOLATE_DUST_INGREDIENT_NAMES;
    if (activity === IDLE_ACTIVITY_ULTRA_COMPOST) return ULTRA_COMPOST_INGREDIENT_NAMES;
    if (activity === IDLE_ACTIVITY_GOAT_HORN) return GOAT_HORN_INGREDIENT_NAMES;
    if (activity === IDLE_ACTIVITY_ANY) return ANY_INGREDIENT_NAMES;
    return EMPTY_STRING_SET;
};

/** Returns the set of lowercased result product names for the selected idle
 *  activity. When an idle activity is selected, sell offers for these items
 *  are never aborted as stale — the user is manually selling the activity's
 *  output (e.g. goat horn dust, ultracompost, chocolate dust). */
const getIdleActivityResultProductNames = (bot: StarkMercher): ReadonlySet<string> => {
    const activity = bot.idleActivityValue;
    if (activity === IDLE_ACTIVITY_CHOCOLATE_DUST) return CHOCOLATE_DUST_RESULT_PRODUCT_NAMES;
    if (activity === IDLE_ACTIVITY_ULTRA_COMPOST) return ULTRA_COMPOST_RESULT_PRODUCT_NAMES;
    if (activity === IDLE_ACTIVITY_GOAT_HORN) return GOAT_HORN_RESULT_PRODUCT_NAMES;
    if (activity === IDLE_ACTIVITY_ANY) return ANY_RESULT_PRODUCT_NAMES;
    return EMPTY_STRING_SET;
};

// --- Cross-tick inventory cache ---------------------------------------------
// titan.utils.inventory.getAll() creates ~28 native item handles per call.
// The previous per-tick cache rebuilt the snapshot every tick, creating
// ~28 handles/tick. Over 4-8 hours this contributed to native handle table
// exhaustion (FPS gradually drops to 0). The cache now persists across
// ticks for up to INV_CACHE_TTL_TICKS (5 minutes) as a safety net.
// Callers MUST call invalidateInvCache() after any action that changes the
// inventory (collect, sell offer placed, buy offer placed). The flow
// handler in autoLoopTick invalidates after each flow completes.
//
// Tick counter resets (disconnect/hop) are handled by the tick < baseTick
// check, which clears the cache immediately.
const INV_CACHE_TTL_TICKS = 500; // 500 ticks ≈ 5 minutes
let invCacheBaseTick = -1;
let invSnapshot: Map<string, titan.Item> | null = null;

/** Invalidates the cross-tick inventory cache. Must be called after any
 *  action that changes the inventory (collect, sell offer placed, buy
 *  offer placed, abort with partial fill collected). */
export const invalidateInvCache = (): void => {
    invSnapshot = null;
    invCacheBaseTick = -1;
};

/** Returns the cached inventory snapshot, rebuilding it from getAll() if
 *  the cache is expired or invalidated. Accumulates quantities across
 *  inventory slots with the same item name (noted + unnoted stacks).
 *
 *  Exported so other modules (e.g. chocolate-dust.ts) can reuse the same
 *  cross-tick snapshot instead of calling `titan.utils.inventory.getAll()`
 *  directly, which would create ~28 native Item handles per call and
 *  exhaust the native handle table over hours of idle monitoring. */
export const getInvSnapshot = (): Map<string, titan.Item> => {
    const tick = titan.state.client.tick;
    if (invSnapshot && invCacheBaseTick >= 0 && tick >= invCacheBaseTick && tick - invCacheBaseTick < INV_CACHE_TTL_TICKS) {
        return invSnapshot;
    }
    invSnapshot = new Map();
    invCacheBaseTick = tick;
    // Accumulate quantities across all inventory slots with the same
    // item name. OSRS inventory can hold the same item in multiple
    // slots — notably noted stacks (e.g. 6 noted Warrior rings) and
    // unnoted singles (e.g. 1 unnoted in slot 2, 1 unnoted in slot 3).
    // The GE sell offer screen automatically combines noted + unnoted
    // when you set the quantity, so we just need the total quantity
    // to be correct. We store a synthetic Item with the combined
    // quantity and the first matching slot's index (used for the
    // inventory widget click in the sell flow).
    const qtyMap = new Map<string, number>();
    const firstSlot = new Map<string, titan.Item>();
    for (const item of titan.utils.inventory.getAll()) {
        qtyMap.set(item.name, (qtyMap.get(item.name) ?? 0) + item.quantity);
        if (!firstSlot.has(item.name)) firstSlot.set(item.name, item);
    }
    for (const [name, qty] of qtyMap) {
        const base = firstSlot.get(name)!;
        invSnapshot.set(name, { ...base, quantity: qty });
    }
    return invSnapshot;
};

// --- Stale offer thresholds ------------------------------------------------
// Sell: dynamic % of ETA passed with <25% sold → abort (scaled by profit margin)
// Buy (0 bought): min(125% of ETA, absolute cap) passed with 0 bought → abort
// Buy (multi-qty): 90% of ETA passed with <50% bought → abort
// If the item is no longer in merchableItems.json, abort immediately
// (the price target is stale).
//
// The buy thresholds are generous because the merchable item pool can be
// small (20-30 items at low-activity times). Aborting too early wastes
// partial fills and triggers buy freezes that shrink the pool further.
// Giving buys extra time beyond ETA avoids aborting offers that are still
// slowly filling, especially when volume estimates are uncertain.
//
// However, an absolute cap on 0-progress offers prevents long-ETA items
// (e.g. Demonic skin contract with 84-min buy ETA) from sitting idle for
// 105+ minutes (125% of 84) before being aborted. The cap is tighter for
// non-lowball items (which should fill quickly at market price) and more
// generous for lowball items (which are expected to take longer).
//
// The sell ETA abort ratio scales with profit margin so that thin-margin
// items get more time to sell (a 1gp cut on a 2gp margin is 50% of profit),
// while high-margin items are revised sooner (a 5k cut on 100k is only 5%).
// Formula: clamp(0.95 - log10(profit) * 0.075, 0.35, 0.95)

const SELL_PROGRESS_ABORT_THRESHOLD = 0.25; // <25% sold
const SELL_ETA_ABORT_RATIO_STALLED = 1.0; // 100% of sell ETA (stalled near completion)
const SELL_PROGRESS_STALLED_THRESHOLD = 0.50; // >=50% sold but not completing
// Absolute cap for 0-progress sell offers — regardless of ETA, abort if
// nothing has sold after this many minutes. Prevents high-value sells
// (e.g. Ornate maul handle, Amulet of avarice) with long or missing ETAs
// from tying up a GE slot for 1-2 hours at 0% progress. Also catches the
// ETA=0 case (cached/reconstructed entries with no sale ETA data) which
// the ETA-based checks skip entirely.
// The cap scales with ETA so long-ETA sells (e.g. Dragon boots with
// 114min ETA) aren't aborted at 20min (18% of ETA) — that causes rapid
// cycling of slow-selling items. The cap is clamped to [20, 60] minutes:
//   cap = clamp(eta * 0.5, 20, 60)
// Fast items (≤40min ETA) get the 20min floor (unchanged). Slow items
// get up to 60min before the 0-progress cap triggers.
const SELL_ZERO_PROGRESS_ABSOLUTE_ABORT_MIN = 20;  // floor (fast items)
const SELL_ZERO_PROGRESS_ABSOLUTE_ABORT_MAX = 60;  // cap (slow items)
const SELL_ZERO_PROGRESS_ETA_RATIO = 0.5;          // 50% of ETA

// Absolute stall threshold for partial-progress sells with no ETA data.
// When a sell offer has made some progress (>=1%) but has ETA=0 (cached or
// reconstructed entries with no sale ETA), the ETA-based stale checks are
// skipped entirely. Without this check, such offers can sit indefinitely
// at a partial progress level — e.g. Contract of Glyphic Attenuation stuck
// at 69.5% for 60+ minutes, tying up capital and a GE slot. This threshold
// uses the time since the last progress update (lastSellProgressAt, tracked
// by the stale-check loop) to detect true stagnation. If no progress
// tracking exists, falls back to total elapsed time.
const SELL_PARTIAL_PROGRESS_NO_ETA_STALL_MIN = 45;

// --- Controlled loss dump hold timers (Option 1 — controlled loss acceptance) ---
// After a sell offer reaches the dump floor (rev 8, tax break-even), it is
// held for DUMP_FLOOR_HOLD_MIN minutes at 0% progress before the controlled
// loss dump kicks in (rev 9+, pricing below tax break-even). Subsequent
// controlled loss re-reductions use a shorter hold (30 min) since the loss
// has already been accepted and the goal is to free the slot quickly.
const DUMP_FLOOR_HOLD_MIN = 90;
const DUMP_FLOOR_CONTROLLED_LOSS_HOLD_MIN = 30;

/** Computes the ETA-scaled 0-progress sell abort cap. Fast items (≤40min
 *  ETA) get the 20min floor. Slow items get up to 60min. */
const computeSellZeroProgressCap = (eta: number): number => {
    return Math.min(
        SELL_ZERO_PROGRESS_ABSOLUTE_ABORT_MAX,
        Math.max(SELL_ZERO_PROGRESS_ABSOLUTE_ABORT_MIN, eta * SELL_ZERO_PROGRESS_ETA_RATIO),
    );
};
// Minimum sell ETA in minutes used by the stale checker. Runtime sell ETAs
// for high-volume items (e.g. Ancient essence at 0.8min for 4518 units) are
// mathematically correct but don't account for the price being too high —
// the item simply isn't selling at the listed price, and aborting after <1min
// creates a rapid abort/re-list cycle that wastes GE slots and time. This
// floor gives thin-margin sell offers enough time to find buyers. The actual
// ETA is still used for the cache dump/diagnostics; only the stale-check
// threshold is floored.
const SELL_ETA_FLOOR_MIN = 5;

// Minimum buy ETA in minutes used by the stale checker. Runtime buy ETAs for
// high-volume items with small quantities (e.g. 2k Soul runes at ~3min) are
// mathematically correct for volume but don't account for GE queue dynamics —
// the offer may be queued behind other buyers at the same or higher price, and
// fills come in chunks, not linearly. This floor ensures buy offers get enough
// time to find sellers before being aborted as stale. The actual ETA is still
// used for the cache dump/diagnostics; only the stale-check threshold is floored.
const BUY_ETA_FLOOR_MIN = 10;

// --- Progress-since-revision extension -------------------------------------
// When a sell offer is actively filling (progress has increased recently)
// but hasn't completed within the original ETA, the stale checker extends
// the stale window instead of prematurely revising the price. This prevents
// aborting offers that are selling at a reasonable rate but slower than the
// ETA predicted (e.g. Diamond dragon bolts at 67% sold when the ETA predicted
// 100% — the item was actively selling, not stuck).
//
// The extension applies only to the ETA-based checks ("ETA exceeded" and
// "stalled near completion"). It does NOT affect:
//   - The 0-progress absolute cap (fires at 0% progress, before the extension)
//   - The reconstructed zero-profit guard (fires regardless of progress)
//   - The reconstructed low-profit guard (already has a 0% progress check)
//   - The dump-floor guard (returns null before any progress checks)
//
// Conditions for the extension:
//   1. Progress has increased since the last revision (lastSellProgress > 0)
//   2. The most recent progress increase was within the last half-ETA window
//      (if progress stalled > half-ETA ago, the item is no longer actively
//      selling and the extension doesn't apply)
//   3. Total elapsed time is less than 2x ETA (hard cap to prevent infinitely
//      extending truly slow items)
const SELL_PROGRESS_RECENT_ETA_RATIO = 0.5; // half the ETA window
const SELL_PROGRESS_EXTENSION_CAP_RATIO = 2.0; // 2x ETA hard cap

/** Returns true if the sell offer has made progress recently enough to
 *  warrant extending the stale window. This prevents aborting offers that
 *  are actively selling but haven't completed within the original ETA.
 *  - entry: The cache entry for the sell offer.
 *  - etaMinutes: The floored sell ETA in minutes.
 *  - nowMs: Current timestamp (passed in to avoid repeated Date.now() calls). */
const hasRecentSellProgress = (
    entry: { lastSellProgress?: number; lastSellProgressAt?: number },
    etaMinutes: number,
    nowMs: number,
): boolean => {
    if (entry.lastSellProgressAt === undefined || entry.lastSellProgress === undefined) return false;
    if (entry.lastSellProgress <= 0) return false; // no progress observed
    const msSinceProgress = nowMs - entry.lastSellProgressAt;
    const recentThresholdMs = etaMinutes * SELL_PROGRESS_RECENT_ETA_RATIO * 60000;
    return msSinceProgress <= recentThresholdMs;
};

/** Minimum profit per slot per hour for reconstructed sell offers. Reconstructed
 *  sells are pre-existing offers from a previous session whose profitability may
 *  have degraded. If a reconstructed sell earns less than this per hour (based on
 *  the sell ETA and quantity), it is aborted immediately to free the slot for a
 *  fresh merchable item. Lower than the 20k buy-scan threshold because we already
 *  own the item — the goal is just to avoid wasting a slot on near-zero profit. */
const RECONSTRUCTED_SELL_PROFIT_PER_SLOT_HOUR_MIN = 5000;
/** Grace period (minutes) before the reconstructed low-profit/hr guard
 *  fires. Gives thin-margin reconstructed sells a chance to start filling
 *  before being aborted. The zero-profit guard has no grace period —
 *  guaranteed losses are aborted immediately. */
const RECONSTRUCTED_SELL_GRACE_PERIOD_MIN = 5;

/**
 * Computes the dynamic sell ETA abort ratio based on the profit margin.
 * Thin-margin items get up to 95% of ETA; high-margin items as low as 75%.
 *
 * The minimum was raised from 35% to 75% because high-value items (e.g.
 * Berserker ring at 4.2m, ~10 sales/hour) have high Poisson noise — at
 * 35-58% of ETA, P(0 sales) exceeds 50%, causing premature aborts before
 * the item has a realistic chance to sell. At 75%, P(0 sales) ≈ 47%,
 * giving the market more time to clear before revising.
 */
const computeSellEtaAbortRatio = (profit: number): number => {
    if (profit <= 0) return 0.95;
    const ratio = 0.95 - Math.log10(profit) * 0.075;
    return Math.max(0.75, Math.min(0.95, ratio));
};
const BUY_ETA_ABORT_RATIO_ZERO = 1.25;   // 125% of buy ETA (0 bought)
const BUY_ETA_ABORT_RATIO_MULTI = 0.90;  // 90% of buy ETA (<50% bought)
const BUY_PROGRESS_ABORT_THRESHOLD = 0.50; // <50% bought
const BUY_ETA_ABORT_RATIO_STALLED = 1.0; // 100% of buy ETA (stalled near completion)
const BUY_PROGRESS_STALLED_THRESHOLD = 0.50; // >=50% bought but not completing

// --- Profit/hr-based abort scaling for buy offers ---------------------------
// Buy aborts are "giving up" — unlike sells, there's no revision system to
// find the right price. The only reason to abort a buy is if the slot could
// earn more profit/hr with a different item. High profit/hr items get more
// patience because:
//   1. The opportunity cost of freeing the slot is higher (especially when
//      the item pool is exhausted — there's nothing better to swap to)
//   2. High-value items have chunkier fill patterns (Poisson noise — at
//      50% of ETA, P(0 fills) can exceed 50% for low-volume items)
//   3. Aborting and re-selecting has overhead: freeze time (5-15min) +
//      flow placement time (~30s) + new item's fill time
//
// The scale factor is log-scaled from the runtime minimum profit/hr
// (RUNTIME_MIN_PROFIT_PER_SLOT_HOUR = 20k) up to a cap. At 20k the factor
// is 1.0 (current behavior unchanged). At 50k it's ~1.5x, at 100k ~1.75x,
// at 250k+ ~2.1x, capped at 2.5x.
//
// The floor (min) of the absolute cap scales by the full factor. The
// ceiling (max) scales by a reduced factor (capped at 1.5x) so high-profit
// items don't tie up a slot for 2+ hours — at some point even a 243k
// profit/hr item isn't worth waiting 150min for.
//
// Thin-margin items (profitMargin <= 3gp) are excluded from profit scaling
// — they already get 125% of ETA via the thin-margin exception, and their
// profit/hr is inherently low.
const BUY_PROFIT_SCALE_MIN_PROFIT_PER_HOUR = 20000;
const BUY_PROFIT_SCALE_MAX_FACTOR = 2.5;
const BUY_PROFIT_SCALE_CEILING_MAX_FACTOR = 1.5;

/** Computes the profit/hr-based scale factor for buy abort thresholds.
 *  Returns 1.0 at or below the runtime minimum profit/hr, log-scaled up
 *  to BUY_PROFIT_SCALE_MAX_FACTOR. */
const computeBuyProfitScaleFactor = (profitPerSlotHour: number): number => {
    if (profitPerSlotHour <= BUY_PROFIT_SCALE_MIN_PROFIT_PER_HOUR) return 1.0;
    const log = Math.log10(profitPerSlotHour / BUY_PROFIT_SCALE_MIN_PROFIT_PER_HOUR);
    return Math.min(BUY_PROFIT_SCALE_MAX_FACTOR, 1.0 + log * 0.75);
};

/** Computes the effective ceiling scale factor (capped lower than the floor
 *  scale factor) so high-profit items don't tie up slots for hours. */
const computeBuyProfitCeilingScaleFactor = (profitPerSlotHour: number): number => {
    return Math.min(BUY_PROFIT_SCALE_CEILING_MAX_FACTOR, computeBuyProfitScaleFactor(profitPerSlotHour));
};
// Absolute cap for 0-progress buy offers — regardless of ETA, abort if
// nothing has been bought after this many minutes. Prevents long-ETA
// items from tying up a GE slot for 1-2 hours with zero fills.
// Non-lowball items buy at market price and should start filling quickly;
// lowball items buy below market and are expected to take longer.
//
// The cap is ETA-scaled (matching the sell-side pattern) so that long-ETA
// items get more patience before being aborted. High-volume lumpy-fill items
// (e.g. Ancient essence: 18gp buy, 19gp sell, 64min ETA) often sit at 0%
// then fill all at once — a flat 15min cap aborts them too early, shrinking
// the buy pool and triggering unnecessary freezes. Fast items (≤30min ETA
// non-lowball, ≤60min ETA lowball) keep the floor cap (unchanged behavior).
//   non-lowball cap = clamp(eta * 0.5, 15, 60)
//   lowball cap      = clamp(eta * 0.5, 30, 90)
const BUY_ZERO_PROGRESS_ABSOLUTE_ABORT_MIN = 15;          // floor (fast non-lowball)
const BUY_ZERO_PROGRESS_ABSOLUTE_ABORT_MAX = 60;          // cap (slow non-lowball)
const BUY_ZERO_PROGRESS_ABSOLUTE_ABORT_MIN_LOWBALL = 30;  // floor (fast lowball)
const BUY_ZERO_PROGRESS_ABSOLUTE_ABORT_MAX_LOWBALL = 90;  // cap (slow lowball)
const BUY_ZERO_PROGRESS_ETA_RATIO = 0.5;                  // 50% of ETA
// Thin-margin items (profitMargin <= 3gp) are bulk-fill minimal-margin items
// (e.g. Ancient essence: 18gp buy, 19gp sell, 1gp margin). These items often
// sit at 0% then fill all at once, and the opportunity cost of a stuck slot
// is low (1-3gp/item). For these, the absolute cap is set to 125% of ETA
// (matching BUY_ETA_ABORT_RATIO_ZERO) so the ETA threshold is the effective
// check, not the absolute cap. This prevents aborting at 50% of ETA (~30min
// for a 60min ETA item) when the user is happy to wait the full 125%.
const BUY_ZERO_PROGRESS_THIN_MARGIN_THRESHOLD = 3;        // profitMargin <= 3gp

// --- Pre-sleep lowball priority --------------------------------------------
// During the final 30 minutes before nightly sleep, the buy scan reverses its
// tier order to prefer lowball items (buy below market, slower fills, higher
// margins) over non-lowball items (instant-fill, buy at market). Offers
// placed shortly before sleep will remain unattended for ~4h, making slower
// lowball offers more suitable — they have more time to fill and earn higher
// margins. The lowball turnover cap is relaxed from 120min to 240min during
// this window to allow slower lowball items that would normally be filtered.
const PRE_SLEEP_PRIORITY_MINUTES = 30;
const PRE_SLEEP_LOWBALL_MAX_TURNOVER_MINUTES = 240;

// --- Slow Mode preferred tier ----------------------------------------------
// When the user selects Mode = Slow, the buy scan prepends a preferred tier
// that targets lowball items with a runtime buy ETA in the 30-60 minute range.
// These slower, higher-margin fills suit the ~30-minute account login cadence
// (accounts are effectively logged in approximately every 30 minutes, so a
// 30-60min buy ETA aligns with the next login window). The preferred tier uses
// the same relaxed 240min turnover cap as pre-sleep mode. If no item qualifies,
// the scan falls through to the normal tier order unchanged — fast non-lowball
// flips remain eligible. Slow Mode does NOT alter login/logout/break/rotation/
// hop timing; it only changes buy-offer item selection.
// Pre-sleep lowball priority takes precedence over Slow Mode (pre-sleep is the
// stronger condition and already does lowball-first with the 240min cap), so
// the slow preferred tier is skipped while pre-sleep is active.
const SLOW_PREFERRED_MIN_BUY_ETA_MINUTES = 30;
const SLOW_PREFERRED_MAX_BUY_ETA_MINUTES = 60;

/** Computes the ETA-scaled 0-progress buy abort cap. Fast items get the
 *  floor cap; slow items get up to the max cap. Non-lowball items get a
 *  tighter range than lowball items since they buy at market price and
 *  should fill faster.
 *
 *  For thin-margin items (profitMargin <= BUY_ZERO_PROGRESS_THIN_MARGIN_THRESHOLD),
 *  the cap is set to 125% of ETA (BUY_ETA_ABORT_RATIO_ZERO) so the ETA
 *  threshold is the effective check. This gives bulk-fill minimal-margin
 *  items (e.g. Ancient essence) the full 125% ETA window to fill before
 *  being aborted, then the normal buy-freeze applies.
 *
 *  profitScaleFactor (floor) and profitCeilingScaleFactor (ceiling) scale
 *  the min/max bounds for high profit/hr items — see the profit scaling
 *  constants above. Thin-margin items are not affected (they return before
 *  the scaled bounds). */
const computeBuyZeroProgressCap = (
    eta: number,
    isLowball: boolean,
    profitMargin?: number,
    profitScaleFactor: number = 1.0,
    profitCeilingScaleFactor: number = 1.0,
): number => {
    // Thin-margin items: use 125% of ETA as the cap (no floor/ceiling clamp).
    // This makes the ETA threshold the effective check, not the absolute cap.
    if (profitMargin !== undefined && profitMargin <= BUY_ZERO_PROGRESS_THIN_MARGIN_THRESHOLD) {
        return eta * BUY_ETA_ABORT_RATIO_ZERO;
    }
    const min = (isLowball ? BUY_ZERO_PROGRESS_ABSOLUTE_ABORT_MIN_LOWBALL : BUY_ZERO_PROGRESS_ABSOLUTE_ABORT_MIN) * profitScaleFactor;
    const max = (isLowball ? BUY_ZERO_PROGRESS_ABSOLUTE_ABORT_MAX_LOWBALL : BUY_ZERO_PROGRESS_ABSOLUTE_ABORT_MAX) * profitCeilingScaleFactor;
    return Math.min(max, Math.max(min, eta * BUY_ZERO_PROGRESS_ETA_RATIO));
};
// No-progress abort for partial-fill buys: if a buy offer has progress > 0
// but < 100% and the progress hasn't increased for this many minutes, abort
// it so the partial inventory can be sold and the slot freed. The threshold
// scales with the buy ETA — fast items get a strict floor, slow high-ticket
// items (e.g. 2 items with 1hr ETA) get more patience since long gaps
// between fills are normal for them.
//   threshold = clamp(eta * 0.25, BUY_NO_PROGRESS_MIN, BUY_NO_PROGRESS_MAX)
const BUY_NO_PROGRESS_RATIO = 0.25;    // 25% of buy ETA
const BUY_NO_PROGRESS_MIN = 10;        // 10 min floor (fast items)
const BUY_NO_PROGRESS_MAX = 30;        // 30 min cap (slow items)

// --- Fast-sell thresholds --------------------------------------------------
// When we have a small quantity of low-value items (e.g. 10 chaos runes from
// a partial buy that got aborted), occupying a GE slot for them isn't worth
// it. Fast-sell at 50% of the sell price for a guaranteed quick sale to free
// the slot for a new profitable cycle. Only applies when ALL conditions are
// met:
//   1. Quantity is small (< FAST_SELL_QTY_THRESHOLD) — a few items isn't
//      worth a slot regardless of per-item value.
//   2. Total sell value is low (< FAST_SELL_VALUE_CAP) — even a small
//      quantity of high-value items (e.g. 1 warrior ring at 58k) should sell
//      at normal price to avoid real GP loss.
//   3. Halved price must still be above the buy price (never fast-sell at a
//      loss). If halving would go below buy+1, skip fast-sell and sell at
//      the normal price.
const FAST_SELL_QTY_THRESHOLD = 50;
const FAST_SELL_VALUE_CAP = 10_000;      // 10k GP total sell value
const FAST_SELL_PRICE_MULTIPLIER = 0.5;  // 50% of sell price

// --- Minimum buy offer value -----------------------------------------------
// Don't place buy offers with a total value below this threshold. When the
// cash stack is low (e.g. 6k coins after filling other slots), the bot would
// otherwise place tiny offers like 35 Death runes for 6.5k GP — wasting a GE
// slot on an offer that earns almost nothing. Instead, skip the buy and let
// the normal "nothing to do" fallthrough handle it (short break / logout /
// account rotation). Once sells complete and coins recover, profitable offers
// resume.
const MIN_BUY_OFFER_VALUE = 100_000;     // 100k GP minimum total buy value

/** Per-slot budget soft cap. The buy scan divides the available coins by the
 *  number of empty GE slots to get a base per-slot budget. An item may take
 *  up to MAX_SLOT_BUDGET_MULTIPLIER × the base budget — this lets a highly
 *  profitable item use "a bit more" than its fair share while still leaving
 *  coins for other slots. With 6 empty slots and 15m coins: base = 2.5m,
 *  cap = 6.25m → a 14.8m item is skipped in favour of filling multiple
 *  slots. With 1-2 empty slots: base = 7.5m, cap = 15m → the expensive item
 *  can use the full stack since there's nothing else to fill.
 *
 *  F2P mode uses 1.5×: with only 3 GE slots, a 2.5× cap lets
 *  the first slot consume 83% of the cash stack, starving the 2nd/3rd slots.
 *  1.5× still gives a highly profitable item a bit more than its fair share
 *  while leaving enough for the remaining slots. With 5m / 3 empty slots:
 *  base = 1.66m, cap = 2.5m → slot 1 takes 2.5m, leaving 2.5m for slots 2-3. */
const MAX_SLOT_BUDGET_MULTIPLIER = 2.5;
const F2P_SLOT_BUDGET_MULTIPLIER = 1.5;

/** F2P mode minimum slot occupation (minutes) before any ETA-based buy
 *  abort fires. F2P accounts have only 3 GE slots and use lowball-style
 *  pricing (1gp margin), so offers need more time to fill. The 45-min
 *  minimum gives low-balled offers a fair chance before being aborted.
 *
 *  Exception: if a higher-ranked F2P item is available (not in any slot,
 *  not frozen, not buy-limited), the bot may swap out early — the slot is
 *  more productive with the better item. This mirrors the existing frozen
 *  swap-out path but triggers on ETA-reached + better-item-available
 *  instead of frozen + better-item-available. */
const F2P_MIN_SLOT_OCCUPATION_MIN = 45;

/** Throttle for idle-path diagnostic logs (GE slots summary, stale check,
 *  sell/buy scan, ETA). When the bot is continuously idle, these logs repeat
 *  every tick (~600ms) producing hundreds of redundant lines. This constant
 *  limits them to every ~5 seconds (8 ticks at 600ms/tick). Action-triggering
 *  logs (aborting, selling, buying, collecting) always log regardless. */
const IDLE_DIAG_INTERVAL_TICKS = 8;

// --- Buy freeze-out --------------------------------------------------------
// When a buy offer is aborted (stale — not buying at the offered price), we
// temporarily freeze that item so we don't immediately re-list it at the
// same price. The freeze is short (5 minutes) because the merchable item
// pool can be small at low-activity times — a long freeze would shrink the
// available items too much and leave GE slots idle.
const BUY_FREEZE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// --- Consecutive failure tracking -------------------------------------------
// Major "stuck" states (GE won't open, sub-screen won't close, collect button
// not clickable) terminate the bot after this many consecutive failures.
// Recoverable failures (price mismatch, quantity validation, search not found)
// do NOT use this system — they press Esc and retry the loop.
const MAX_CONSECUTIVE_FAILURES = 3;

/** Minimum real-time cooldown between GE-open click dispatches. The SDK can
 *  fire a burst of ticks immediately after login (the tick counter advances
 *  several ticks in milliseconds), causing the tick-based action delay to
 *  elapse instantly and the loop to re-enter and dispatch a second GE-open
 *  click before the first one has taken effect. This wall-clock cooldown
 *  prevents that — see `lastGeOpenDispatchMs` on `AutoLoopState`. */
const GE_OPEN_WALL_CLOCK_COOLDOWN_MS = 3000;

/** Minimum real-time cooldown between collect-to-inventory click dispatches.
 *  Same rationale as GE_OPEN_WALL_CLOCK_COOLDOWN_MS — tick bursts after login
 *  can cause the tick-based delay to elapse instantly, leading to a duplicate
 *  collect click that the game responds to with "You have nothing to collect."
 *  and a Cancel opcode. */
const COLLECT_WALL_CLOCK_COOLDOWN_MS = 3000;

/** Increments the failure counter for a given key. Returns the new count. */
const recordFailure = (loop: AutoLoopState, key: string): number => {
    loop.failureCounters[key] = (loop.failureCounters[key] ?? 0) + 1;
    return loop.failureCounters[key];
};

/** Resets the failure counter for a given key to 0 (call on success). */
const resetFailure = (loop: AutoLoopState, key: string): void => {
    loop.failureCounters[key] = 0;
};

/** Terminates the bot with an error message when a failure counter hits the
 *  limit. Returns true if the bot was terminated (caller should return). */
const checkFailureTerminate = (bot: StarkMercher, loop: AutoLoopState, key: string, label: string): boolean => {
    const count = loop.failureCounters[key] ?? 0;
    if (count >= MAX_CONSECUTIVE_FAILURES) {
        bot.terminated = true;
        bot.terminationReason = `${label} failed ${count}x consecutively — terminating to prevent stuck state`;
        titan.logf('[Stark Mercher] ERROR: %s', bot.terminationReason);
        return true;
    }
    return false;
};

// --- Buy-freeze persistence -------------------------------------------------
// The buy-freeze map is persisted in a hidden JSON setting as a flat global
// map of lowercase item name -> freeze-until timestamp (ms). Freezes are
// global (not account-keyed) because they represent a market/item-level
// signal — an item that isn't buying at the offered price on one account
// is unlikely to buy at that price on another account either. With
// multi-account rotation, an account-keyed freeze would let account B
// immediately re-buy an item that account A just aborted as stale.
//
// Legacy format migration: the previous format was
//   { accountName: { itemName: untilMs } }
// On load, if the parsed object's values are objects (nested format), we
// flatten all accounts into a single map, keeping the latest (max)
// expiration per item, and re-save in the flat format. This is a one-way
// migration — once flattened, the setting is always saved flat.

/** Loads the global buy-freeze map from the hidden setting.
 *  Migrates the legacy nested (account-keyed) format to flat on first load.
 *  Drops expired entries during load so the in-memory map starts clean. */
const loadBuyFreeze = (bot: StarkMercher): Map<string, number> => {
    const raw = bot.buyFreezeSetting.value;
    if (!raw || raw === '{}') return new Map();
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return new Map();
        const now = Date.now();
        const result = new Map<string, number>();
        // Detect legacy nested format: { account: { item: until } }.
        // In the flat format, all values are numbers. In the nested format,
        // values are objects.
        const values = Object.values(parsed);
        const isNested = values.length > 0 && values.every(v => v !== null && typeof v === 'object');
        if (isNested) {
            // Flatten all accounts, keeping the latest expiration per item.
            for (const accountMap of values as Record<string, number>[]) {
                if (!accountMap || typeof accountMap !== 'object') continue;
                for (const [name, until] of Object.entries(accountMap)) {
                    if (typeof until !== 'number') continue;
                    if (now >= until) continue; // drop expired
                    const existing = result.get(name);
                    if (!existing || until > existing) result.set(name, until);
                }
            }
            // Re-save in the flat format so we don't migrate again.
            const obj: Record<string, number> = {};
            for (const [name, until] of result) obj[name] = until;
            bot.buyFreezeSetting.value = JSON.stringify(obj);
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Migrated buy-freeze setting to global format (%d active entries).', result.size);
            return result;
        }
        // Flat format: { item: until }.
        for (const [name, until] of Object.entries(parsed)) {
            if (typeof until === 'number' && now < until) {
                result.set(name, until);
            }
        }
        return result;
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse buy-freeze state: %s', String(e));
        return new Map();
    }
};

/** Saves the global buy-freeze map to the hidden setting.
 *  Overwrites the full persisted state (the map is global, no merge needed).
 *  Skips expired entries so the setting doesn't bloat. */
const saveBuyFreeze = (bot: StarkMercher, freezeMap: Map<string, number>): void => {
    try {
        const now = Date.now();
        const obj: Record<string, number> = {};
        for (const [name, until] of freezeMap) {
            if (now < until) obj[name] = until;
        }
        bot.buyFreezeSetting.value = JSON.stringify(obj);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save buy-freeze state: %s', String(e));
    }
};

// --- Item abort count tracking (progressive freeze + hard skip) ------------
// Tracks how many times each item has had a buy or sell offer aborted
// recently. Items that repeatedly fail to fill (buy) or fail to sell (sell,
// <25% progress) get progressively longer buy freezes and are eventually
// hard-skipped entirely — the market price estimate is systematically wrong
// for them, and re-listing at the same price just wastes another GE slot
// cycle.
//
// Buy aborts and sell aborts feed into the SAME protection mechanism via the
// effective count (buy count + sell count). This directly addresses the loss
// pattern where items go through 4-9 sell revision cycles, occupy a slot for
// 2-3 hours, and cycle at the tax-break-even floor (the previous abandon floor
// of buyPrice-2 / final-dump floor of buyPrice-5 caused guaranteed losses after
// GE tax; these have been raised to the tax-break-even floor).
//
// Count format: { "itemname": { count: N, lastAbortAt: ms, sellCount: N, lastSellAbortAt: ms } }
// Buy count decays after ITEM_ABORT_COUNT_RESET_MS (1 hour) of no buy aborts.
// Sell count decays after SELL_ABORT_COUNT_RESET_MS (2 hours) of no sell aborts.
// An entry is only deleted when BOTH counts have expired.
// Progressive freeze: BUY_FREEZE_DURATION_MS * min(effectiveCount, 6) → 5, 10, 15, 20, 25, 30 min
// Hard skip: items with effectiveCount >= ITEM_ABORT_HARD_SKIP_THRESHOLD (3) are skipped entirely.
// The freeze does NOT prevent the current sell re-list cycle — it only
// prevents future buys. occupiedNames prevents re-buying while the item is
// being sold.

interface ItemAbortCountEntry {
    count: number;
    lastAbortAt: number;
    /** Number of 0-progress sell aborts for this item. Feeds into the
     *  effective count (buy + sell) for progressive freeze and hard-skip. */
    sellCount?: number;
    /** Timestamp (ms) of the last sell abort. */
    lastSellAbortAt?: number;
}

const ITEM_ABORT_COUNT_RESET_MS = 60 * 60 * 1000; // 1 hour since last buy abort
const ITEM_ABORT_HARD_SKIP_THRESHOLD = 3; // skip entirely after 3 effective aborts (buy + sell)

const SELL_ABORT_COUNT_RESET_MS = 2 * 60 * 60 * 1000; // 2 hours since last sell abort

// --- Buy repricing for high-profit stalled buys ----------------------------
// When a high-profit buy offer stalls (0-progress or partial-fill stale),
// instead of aborting + freezing the item, the bot aborts and immediately
// re-places the buy at a slightly higher price. This rescues buys that are
// just slightly underpriced — especially high-value items like Awakener's
// orb where a small bump can make the difference between filling and not.
//
// Gating (all must be true):
//   - profit/hr > BUY_REPRICE_MIN_PROFIT_PER_HOUR (100k) — only high-profit items
//   - gross margin >= BUY_REPRICE_MIN_MARGIN_GP (10gp) — thin margins can't absorb a bump
//   - reprice count < BUY_REPRICE_MAX_COUNT (2) — don't keep bumping forever
//   - post-bump profit/hr >= BUY_REPRICE_POST_BUMP_MIN_PROFIT_PER_HOUR (50k)
//
// Bump formula: max(1, min(floor(buyPrice * 0.005), floor(grossMargin * 0.10)))
//   - 0.5% of buy price (e.g. 275k item → 1375gp bump, capped at 10% of margin)
//   - 10% of gross margin (e.g. 5000gp margin → 500gp bump)
//   - The smaller of the two dominates, keeping the bump proportional to margin
//
// After repricing, the item is NOT frozen — the bot immediately re-buys at
// the higher price. If the repriced buy also stalls, a second reprice may
// occur (up to BUY_REPRICE_MAX_COUNT). After that, the normal freeze applies.
const BUY_REPRICE_MAX_COUNT = 2;
const BUY_REPRICE_MIN_PROFIT_PER_HOUR = 100000;
const BUY_REPRICE_MIN_MARGIN_GP = 10;
const BUY_REPRICE_POST_BUMP_MIN_PROFIT_PER_HOUR = 50000;
const BUY_REPRICE_BUY_PRICE_RATIO = 0.005;  // 0.5% of buy price
const BUY_REPRICE_MARGIN_RATIO = 0.10;      // 10% of gross margin

// --- Historical protections (loss-history cooldown + abort-history seeding) --
// When the bot starts up or switches accounts, it scans persisted history to
// apply forward-looking protections that catch items with a track record of
// losses or repeated sell aborts — even if those occurred before the current
// session. This prevents re-buying items like Amethyst dart or Dragonstone
// bolts (e) that have confirmed losses or repeated sell failures in the
// recent past.
//
// 1. Loss-history cooldown: scans merch history `losses` for entries within
//    LOSS_HISTORY_LOOKBACK_MS. For each item with a recent loss, applies a
//    buy freeze until (latestLossTime + LOSS_COOLDOWN_FREEZE_MS). Multiple
//    recent losses for the same item extend the freeze by taking the latest
//    loss timestamp. Uses the existing buyFreezeUntil infrastructure.
//
// 2. Abort-history seeding: scans abort history for sell aborts within
//    HISTORICAL_SELL_ABORT_SEED_LOOKBACK_MS. Seeds the live sell-abort count
//    and lastSellAbortAt so the existing progressive freeze and hard-skip
//    logic recognizes repeated historical sell failures immediately. The
//    seeded count participates in normal decay (2h window). Idempotent:
//    only seeds if the historical count exceeds the current live count.
const LOSS_HISTORY_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours
const LOSS_COOLDOWN_FREEZE_MS = 2 * 60 * 60 * 1000; // 2 hours per recent loss
const HISTORICAL_SELL_ABORT_SEED_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Loads the global item abort count map from the hidden setting.
 *  Drops entries when BOTH buy and sell counts have expired past their
 *  respective reset windows. Individual expired counters are zeroed but
 *  the entry is kept if the other counter is still active. */
const loadItemAbortCounts = (bot: StarkMercher): Map<string, ItemAbortCountEntry> => {
    const raw = bot.itemAbortCountSetting.value;
    if (!raw || raw === '{}') return new Map();
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return new Map();
        const now = Date.now();
        const result = new Map<string, ItemAbortCountEntry>();
        let changed = false;
        for (const [name, entry] of Object.entries(parsed)) {
            const e = entry as ItemAbortCountEntry;
            if (!e || typeof e.count !== 'number' || typeof e.lastAbortAt !== 'number') continue;
            const buyExpired = now - e.lastAbortAt >= ITEM_ABORT_COUNT_RESET_MS;
            const sellExpired = !e.lastSellAbortAt || now - e.lastSellAbortAt >= SELL_ABORT_COUNT_RESET_MS;
            if (buyExpired && sellExpired) {
                changed = true; // drop entirely
                continue;
            }
            // If buy count expired but sell count is still active, zero the
            // buy count but keep the entry for sell tracking.
            if (buyExpired && (e.count > 0 || e.lastAbortAt !== 0)) {
                e.count = 0;
                e.lastAbortAt = 0;
                changed = true;
            }
            // If sell count expired but buy count is still active, zero the
            // sell count but keep the entry for buy tracking.
            if (sellExpired && (e.sellCount ?? 0) > 0) {
                e.sellCount = 0;
                e.lastSellAbortAt = undefined;
                changed = true;
            }
            result.set(name, e);
        }
        if (changed) {
            const obj: Record<string, ItemAbortCountEntry> = {};
            for (const [name, e] of result) obj[name] = e;
            bot.itemAbortCountSetting.value = JSON.stringify(obj);
        }
        return result;
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse item abort counts: %s', String(e));
        return new Map();
    }
};

/** Saves the global item abort count map to the hidden setting. */
const saveItemAbortCounts = (bot: StarkMercher, counts: Map<string, ItemAbortCountEntry>): void => {
    try {
        const obj: Record<string, ItemAbortCountEntry> = {};
        for (const [name, e] of counts) obj[name] = e;
        bot.itemAbortCountSetting.value = JSON.stringify(obj);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save item abort counts: %s', String(e));
    }
};

/** Increments the abort count for an item and returns the new count.
 *  Called when a buy offer is aborted for ETA reasons. */
const incrementItemAbortCount = (bot: StarkMercher, counts: Map<string, ItemAbortCountEntry>, itemName: string): number => {
    const key = itemName.trim().toLowerCase();
    const existing = counts.get(key);
    const now = Date.now();
    const newCount = (existing?.count ?? 0) + 1;
    counts.set(key, { count: newCount, lastAbortAt: now });
    saveItemAbortCounts(bot, counts);
    return newCount;
};

/** Returns the effective abort count for an item — the sum of buy and sell
 *  abort counts. Both feed into the same progressive freeze and hard-skip
 *  mechanism: an item that repeatedly fails to buy OR sell at the projected
 *  price has a systematically wrong price estimate and should be protected
 *  against. */
const computeEffectiveAbortCount = (entry: ItemAbortCountEntry | undefined): number => {
    if (!entry) return 0;
    return entry.count + (entry.sellCount ?? 0);
};

/** Computes the progressive freeze duration based on the item's effective
 *  abort count (buy + sell). First abort = 5 min, second = 10 min, etc.,
 *  capped at 30 min. */
const computeProgressiveFreezeMs = (counts: Map<string, ItemAbortCountEntry>, itemName: string): number => {
    const key = itemName.trim().toLowerCase();
    const entry = counts.get(key);
    const effectiveCount = computeEffectiveAbortCount(entry);
    const multiplier = Math.min(Math.max(effectiveCount, 1), 6);
    return BUY_FREEZE_DURATION_MS * multiplier;
};

/** Increments the sell abort count for an item and returns the new sell count.
 *  Called when a sell offer is aborted with <25% progress. The sell count
 *  feeds into the same progressive buy freeze and hard-skip mechanism as buy
 *  aborts (via the effective count = buy + sell). This prevents re-buying
 *  items that consistently fail to sell at the projected price — the sell
 *  price estimate is systematically wrong for them, just as a buy price
 *  estimate can be wrong for buy aborts. */
const incrementItemSellAbortCount = (bot: StarkMercher, counts: Map<string, ItemAbortCountEntry>, itemName: string): number => {
    const key = itemName.trim().toLowerCase();
    const existing = counts.get(key);
    const now = Date.now();
    const newSellCount = (existing?.sellCount ?? 0) + 1;
    counts.set(key, {
        count: existing?.count ?? 0,
        lastAbortAt: existing?.lastAbortAt ?? 0,
        sellCount: newSellCount,
        lastSellAbortAt: now,
    });
    saveItemAbortCounts(bot, counts);
    return newSellCount;
};

// Sell-side freeze + hard-skip: sell aborts (sell offers aborted with <25%
// progress) feed into the SAME progressive buy freeze and hard-skip mechanism
// as buy aborts, via the effective count (buy count + sell count). When a sell
// offer is aborted as stale with <25% progress, the sell-abort count is
// incremented on abort COMPLETION (deferred from detection time to avoid
// inflation from interrupted abort flows), and a progressive buy freeze is
// applied. Items with an effective count >= ITEM_ABORT_HARD_SKIP_THRESHOLD
// (3) are hard-skipped entirely. This prevents re-buying items that
// consistently fail to sell at the projected price (e.g. Raw manta ray,
// Dragon dart — items that went through 4-9 sell revision cycles and occupied
// slots for hours without selling).
//
// The sell-side freeze does NOT prevent the current sell re-list cycle — the
// sell scan doesn't check buyFreezeUntil. The item is still re-listed at a
// revised (lower) price via reviseSellPrice (revisions 0-5 reduce the price,
// revision 6 abandons to the tax-break-even floor, revision 8 final-dumps at
// the tax-break-even floor). The freeze only prevents FUTURE buys of the item
// once the current sell cycle completes. occupiedNames prevents re-buying
// while the item is being sold.
//
// The previous sell-side freeze (30 min × sell count, up to 24h) was removed
// because it overcorrected — it shrank the buy pool for hours after a sell
// completed. The current approach is gentler: the progressive freeze caps at
// 30 min (6+ effective count), and the count decays after 2h (sell) / 1h
// (buy) of no aborts, so the protection is temporary rather than permanent.

// --- Frozen fallback helpers ----------------------------------------------
// When all non-frozen merchable items are exhausted and the bot would
// otherwise leave a GE slot empty, we fall back to a frozen item. Among
// frozen items, we prefer the one whose freeze expires soonest — it was
// frozen the longest ago, so market conditions have had the most time to
// change since the abort, making it the most likely to actually fill now.

/** Returns the frozen merchable item with the soonest-expiring freeze that
 *  passes all the standard buy-scan checks (not occupied, affordable, not
 *  buy-limited, members-appropriate) evaluated at runtime based on actual
 *  coins. Returns null if no frozen item is eligible. The `lowballTier`
 *  parameter scopes the scan to non-lowball or lowball items only (or both
 *  with `'any'`). */
const getFrozenFallbackItem = (
    buyFreezeUntil: Map<string, number>,
    occupiedNames: Set<string>,
    coinCount: number,
    buyLimitedNames: Set<string>,
    membersWorld: boolean,
    lowballTier: LowballTier = 'any',
    maxTurnoverMinutes: number = RUNTIME_MAX_TURNOVER_MINUTES,
    minBuyEtaMinutes?: number,
    maxBuyEtaMinutes?: number,
): BuyScanResult | null => {
    // Sort frozen item names by ascending freeze expiry (soonest first).
    const sorted = [...buyFreezeUntil.entries()]
        .sort((a, b) => a[1] - b[1]);
    let best: BuyScanResult | null = null;
    for (const [name] of sorted) {
        const item = getMerchableItem(name);
        if (!item) continue;
        const lower = item.itemName.trim().toLowerCase();
        if (occupiedNames.has(lower)) continue;
        if (buyLimitedNames.has(lower)) continue;
        if (!membersWorld && item.members) continue;
        if (lowballTier === 'non-lowball' && isLowballItem(item)) continue;
        if (lowballTier === 'lowball' && !isLowballItem(item)) continue;
        // Evaluate at runtime based on actual coins.
        const evalResult = evaluateItemAtRuntime(item, coinCount);
        if (!evalResult) continue;
        if (evalResult.runtimeProfitPerSlotHour < RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM) continue;
        if (evalResult.runtimeTurnoverEtaMinutes > maxTurnoverMinutes) continue;
        // Optional buy-ETA range filter (Slow Mode preferred tier).
        if (minBuyEtaMinutes !== undefined && evalResult.runtimePurchaseEtaMinutes < minBuyEtaMinutes) continue;
        if (maxBuyEtaMinutes !== undefined && evalResult.runtimePurchaseEtaMinutes > maxBuyEtaMinutes) continue;
        // Absolute profit floor — same rationale as the primary scan.
        // Prevents wasting a slot on a frozen item that would earn less
        // than 20k even if it fills perfectly.
        if (evalResult.runtimeTotalProfit < RUNTIME_MIN_ABSOLUTE_PROFIT_GP) continue;
        // Among frozen items, prefer the soonest-expiring freeze (first in
        // sorted order) rather than the highest profit/hr — the freeze
        // timing is the more important factor for frozen fallbacks.
        if (!best) {
            const profitPerCoinHour = evalResult.runtimeTotalCost > 0
                ? evalResult.runtimeProfitPerSlotHour / evalResult.runtimeTotalCost
                : 0;
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

/** Same as getFrozenFallbackItem but with a lower profit/hr threshold for
 *  fallback partial-quantity buys. Uses runtime evaluation based on actual
 *  coins. Returns the frozen item with the soonest-expiring freeze that
 *  qualifies, or null. The `lowballTier` parameter scopes the scan. */
const getFrozenFallbackPartial = (
    buyFreezeUntil: Map<string, number>,
    occupiedNames: Set<string>,
    coinCount: number,
    buyLimitedNames: Set<string>,
    membersWorld: boolean,
    minProfitGp: number = RUNTIME_MIN_ABSOLUTE_PROFIT_GP,
    lowballTier: LowballTier = 'any',
    minBuyEtaMinutes?: number,
    maxBuyEtaMinutes?: number,
): PartialBuyResult | null => {
    const sorted = [...buyFreezeUntil.entries()]
        .sort((a, b) => a[1] - b[1]);
    for (const [name] of sorted) {
        const item = getMerchableItem(name);
        if (!item) continue;
        const lower = item.itemName.trim().toLowerCase();
        if (occupiedNames.has(lower)) continue;
        if (buyLimitedNames.has(lower)) continue;
        if (!membersWorld && item.members) continue;
        if (lowballTier === 'non-lowball' && isLowballItem(item)) continue;
        if (lowballTier === 'lowball' && !isLowballItem(item)) continue;
        // Evaluate at runtime with lower thresholds for fallback.
        const evalResult = evaluateItemAtRuntime(item, coinCount);
        if (!evalResult) continue;
        if (evalResult.runtimeProfitPerSlotHour < 5000) continue;
        if (evalResult.runtimeTurnoverEtaMinutes > 240) continue;
        // Optional buy-ETA range filter (Slow Mode preferred tier).
        if (minBuyEtaMinutes !== undefined && evalResult.runtimePurchaseEtaMinutes < minBuyEtaMinutes) continue;
        if (maxBuyEtaMinutes !== undefined && evalResult.runtimePurchaseEtaMinutes > maxBuyEtaMinutes) continue;
        // Absolute profit floor — same rationale as getFirstPartialBuyItem.
        if (evalResult.runtimeTotalProfit < minProfitGp) continue;
        return {
            item,
            quantity: evalResult.runtimeQuantity,
            totalCost: evalResult.runtimeTotalCost,
            runtimePurchaseEtaMinutes: evalResult.runtimePurchaseEtaMinutes,
            runtimeSaleEtaMinutes: evalResult.runtimeSaleEtaMinutes,
        };
    }
    return null;
};

// --- Auto loop state machine ----------------------------------------------

export type AutoLoopPhase =
    | 'idle'
    | 'opening_ge'       // walking to GE / interacting with clerk/booth
    | 'collecting'        // collect button visible, clicking collect
    | 'aborting'          // aborting a stale offer
    | 'selling'           // placing a sell offer
    | 'buying'            // placing a buy offer
    | 'waiting';          // all slots occupied, waiting for progress

/** Idle activity state machine phases. */
export type IdleActivityPhase =
    | 'none'              // idle activity not active
    | 'scanning'          // "Any" mode: opening bank to check ingredients
    | 'banking'           // opening bank, depositing/withdrawing items
    | 'converting'        // using knife on chocolate bar, waiting for make-all
    | 'cleanup'           // banking idle items before resuming GE mode
    | 'depleted';         // bank out of items — resume normal logout behavior

export interface AutoLoopState {
    phase: AutoLoopPhase;
    /** Active flow (buy/sell/abort) — when set, the loop defers to it. */
    activeBuyFlow: BuyOfferFlow | null;
    activeSellFlow: SellOfferFlow | null;
    activeAbortFlow: AbortOfferFlow | null;
    /** The slot index being operated on (for abort/collect verification). */
    targetSlotIndex: number;
    /** Timestamp when we last dispatched an action (for humanised spacing). */
    lastActionMs: number;
    /** Whether we've initialised the delay/jitter profiles for this session. */
    profilesInitialised: boolean;
    /** The offer cache manager. */
    cache: OfferCacheManager | null;
    /** Track which items we've already tried to sell this loop iteration
     *  to avoid re-trying the same item every tick. */
    sellAttemptedItems: Set<string>;
    /** Track which items we've already tried to buy this loop iteration. */
    buyAttemptedItems: Set<string>;
    /** Items temporarily frozen from buying after a buy offer was aborted
     *  (stale — not buying at the offered price). Maps lowercase item name
     *  to the timestamp (ms) when the freeze expires. Persisted in the
     *  hidden `buyFreezeSetting` so it survives hot reloads and client
     *  restarts. Restored in `resetAutoLoop()` on script start. */
    buyFreezeUntil: Map<string, number>;
    /** In-memory source labels for buy freezes (diagnostic only, not
     *  persisted). Maps lowercase item name to a short string identifying
     *  the freeze source: 'buy-abort', 'sell-abort', 'loss-cooldown', or
     *  'abort-seed'. Used by dumpBuyFreezes to distinguish freeze types.
     *  Cleared on resetAutoLoop; repopulated as freezes are applied. */
    buyFreezeSources: Map<string, string>;
    /** Set of account names (normalized: trimmed + lowercased) for which
     *  historical protections (loss-history cooldown + abort-history
     *  seeding) have been applied this session. Prevents re-applying on
     *  every tick. Cleared in resetAutoLoop so protections re-apply after
     *  a reload (idempotent via count reconciliation). */
    historicalProtectionsApplied: Set<string>;
    /** Tracks how many times each item has had a buy offer aborted for ETA
     *  reasons recently. Used for progressive freeze durations and hard-skipping
     *  items that consistently don't fill. Persisted in the hidden
     *  `itemAbortCountSetting` so it survives hot reloads and client restarts.
     *  Restored in `resetAutoLoop()` on script start. Global (not account-keyed). */
    itemAbortCounts: Map<string, ItemAbortCountEntry>;
    /** Whether the cache has been reconciled against live GE state since
     *  the last script start. Runs once after the GE is first opened with
     *  readable slots. Removes orphaned cache entries (items not in any
     *  GE slot or inventory — e.g. completed merches whose cache entry
     *  wasn't removed before the script restarted). */
    cacheReconciled: boolean;
    /** Whether missing cache entries have been reconstructed from live GE
     *  slots since the last script start. Runs once after the GE is first
     *  opened with readable slots, immediately after cache reconciliation.
     *  Reconstructs entries for active offers that survived a client restart
     *  but lost their cache (hidden setting not persisted). Uses
     *  merchableItems.json / priceHistory.json for prices and ETAs. */
    cacheReconstructed: boolean;
    /** Set to true on script start and when the bot logs back in after a
     *  break. Triggers a cache cleanup sweep on the next auto-loop tick
     *  (removes 'idle' entries with expired buy-limit windows, and expired
     *  buy-freeze entries). Cleared after the sweep runs. */
    needsPostLoginCleanup: boolean;
    /** Info about the slot being aborted, set when an abort flow is
     *  initiated. Used on abort completion to decide whether to clean
     *  the cache entry (buy offers with 0% progress have nothing to
     *  collect, so the cache entry is removed) and to record an entry
     *  in abort history for diagnostics. */
    abortSlotInfo: {
        type: 'buy' | 'sell';
        itemName: string;
        progress: number;
        /** Stale reason string (or 'frozen swap-out' for swap aborts). */
        reason: string;
        /** Abort category: 'eta' (ETA-based stale), 'swap' (frozen swap-out),
         *  'config' (item removed from list — legacy). */
        category: AbortCategory;
        /** Original cached ETA in minutes. */
        etaMin: number;
        /** Requested offer quantity (from the GE slot). */
        requestedQty: number;
        /** Price per item (buy price for buys, sell price for sells). */
        price: number;
        /** Timestamp (ms) when the offer was placed (from cache entry). */
        placedAt: number;
        /** True when this is a stale-detection sell abort with <25% progress
         *  that should increment the sell-abort count and apply a buy freeze
         *  on successful completion. Set at stale-detection time so the
         *  side effect runs exactly once, after the abort actually completes
         *  (not when the abort is merely initiated — a reload mid-abort would
         *  otherwise leave the count incremented while the offer is still
         *  live, causing the next stale detection to increment again). */
        countSellAbort: boolean;
    } | null;
    /** Wall-clock timestamp of the last periodic cache cleanup. The cache
     *  is cleaned every 60 seconds to remove expired 'idle' entries and
     *  expired buy-freeze entries, keeping the cache bounded during long
     *  sessions without breaks. */
    lastCleanupMs: number;
    /** Consecutive failure counters for major "stuck" states. When any
     *  counter reaches MAX_CONSECUTIVE_FAILURES, the bot terminates with
     *  an error log. Counters reset to 0 on success. Keys: 'geOpen',
     *  'geSubScreen', 'collect'. */
    failureCounters: Record<string, number>;
    /** Wall-clock timestamp of the last GE-open click dispatch. Used to
     *  enforce a minimum real-time cooldown (GE_OPEN_WALL_CLOCK_COOLDOWN_MS)
     *  between GE-open clicks, independent of the tick-based action delay.
     *  This prevents double-clicking the booth/clerk when the SDK fires a
     *  burst of ticks immediately after login (the tick counter can advance
     *  several ticks in milliseconds, causing the tick-based delay to elapse
     *  instantly). */
    lastGeOpenDispatchMs: number;
    /** Wall-clock timestamp of the last collect-to-inventory click dispatch.
     *  Same purpose as lastGeOpenDispatchMs but for the collect action —
     *  prevents double-clicking collect when a tick burst causes the
     *  tick-based delay to elapse instantly. */
    lastCollectDispatchMs: number;
    /** Pending buy reprices: maps lowercase item name → bumped buy price.
     *  Set when a high-profit stalled buy qualifies for repricing (see
     *  BUY_REPRICE_* constants). After the abort flow completes, the buy
     *  scan checks this map and overrides the purchase price. Cleared
     *  when the buy is placed or in resetAutoLoop. In-memory only — not
     *  persisted. If the bot reloads mid-reprice, the reprice is lost
     *  and the item gets a normal buy at the original price (safe fallback). */
    pendingReprices: Map<string, number>;
    /** Buy reprice counts: maps lowercase item name → number of reprices
     *  attempted. Used to cap reprices at BUY_REPRICE_MAX_COUNT. Reset
     *  when a buy is successfully placed (the reprice worked) or when the
     *  item is frozen (normal abort without repricing — gives a fresh
     *  start after the freeze expires). In-memory only. */
    buyRepriceCounts: Map<string, number>;
    /** Idle activity state machine. When the bot is idle (no GE actions)
     *  and an idle activity is selected, the bot performs a productive
     *  activity instead of logging out. See idle-activity/chocolate-dust.ts. */
    idleActivityPhase: IdleActivityPhase;
    /** Sub-step within the banking phase of idle activity (0-based). */
    idleActivitySubStep: number;
    /** Tick when the idle activity was last acted on, for humanised delays. */
    idleActivityLastTick: number;
    /** Wall-clock timestamp (ms) when the next GE action is due. When this
     *  time is reached, the idle activity cleans up (banks items) and yields
     *  to normal GE logic. Set when the idle activity starts, based on
     *  bot.nextActionEtaMin from the idle path. 0 = not set. */
    idleActivityGeActionDueMs: number;
    /** Set when the idle activity's bank has run out of ingredients (ash,
     *  supercompost, chocolate bars, etc). When true, the idle activity will
     *  not be restarted for the rest of the session — the bot falls back to
     *  normal GE + logout behavior. Reset on script reload. */
    idleActivityDepleted: boolean;
    /** When "Any" idle activity mode is selected, tracks which specific
     *  activity (1=chocolate, 2=ultra compost, 3=goat horn) is currently
     *  running. The auto-loop dispatch uses this to delegate to the correct
     *  activity-specific tick handler. 0 = none selected yet (scanning). */
    idleActivityCurrent: number;
    /** When "Any" idle activity mode is selected, tracks which specific
     *  activities have been depleted (bank out of ingredients). When all
     *  three are depleted, the global idleActivityDepleted flag is set and
     *  the bot falls through to normal logout behavior. Reset on script
     *  reload. */
    idleActivityAnyDepleted: Set<number>;
    /** Set when the idle activity is in cleanup-for-GE mode: bank all idle
     *  items, then yield to GE logic instead of starting a new activity.
     *  Used after a hot reload when idleActivityPhase is 'none' but idle
     *  items are still in the inventory. The bot needs to bank the items
     *  before GE flows (collect, sell, buy) can proceed, since the
     *  hasIdleActivityItems guards block GE flows while idle items are
     *  present. Without this, the bot would start a new idle activity
     *  instead of banking and doing GE flows. */
    idleActivityCleanupForGe: boolean;
}

export const createAutoLoopState = (): AutoLoopState => ({
    phase: 'idle',
    activeBuyFlow: null,
    activeSellFlow: null,
    activeAbortFlow: null,
    targetSlotIndex: -1,
    lastActionMs: 0,
    profilesInitialised: false,
    cache: null,
    sellAttemptedItems: new Set(),
    buyAttemptedItems: new Set(),
    buyFreezeUntil: new Map(),
    buyFreezeSources: new Map(),
    historicalProtectionsApplied: new Set(),
    itemAbortCounts: new Map(),
    cacheReconciled: false,
    cacheReconstructed: false,
    needsPostLoginCleanup: true,
    abortSlotInfo: null,
    lastCleanupMs: 0,
    failureCounters: {},
    lastGeOpenDispatchMs: 0,
    lastCollectDispatchMs: 0,
    pendingReprices: new Map(),
    buyRepriceCounts: new Map(),
    idleActivityPhase: 'none',
    idleActivitySubStep: 0,
    idleActivityLastTick: -1,
    idleActivityGeActionDueMs: 0,
    idleActivityDepleted: false,
    idleActivityCurrent: 0,
    idleActivityAnyDepleted: new Set(),
    idleActivityCleanupForGe: false,
});

// --- Helper: initialise profiles ------------------------------------------

const ensureProfiles = (bot: StarkMercher): void => {
    if (bot.autoLoop.profilesInitialised) return;
    // Use bot.currentPlayerName (set by initSessionProfile on login) instead
    // of titan.state.client.localPlayer?.name — the localPlayer read creates
    // a native Player handle. This is a one-time call but the handle
    // elimination is still beneficial across many login cycles.
    const playerName = bot.currentPlayerName;
    if (playerName) {
        setDelayProfileForAccount(playerName);
        const delayProfile = getActiveDelayProfile();
        if (delayProfile) setClickJitterProfile(generateClickJitterProfile(delayProfile));
        setTypingMistakeProfileForAccount(playerName);
    }
    setClickJitterDebugLog((msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); });
    setTypingMistakeDebugLog((msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); });
    setClickWidgetDebugLog((msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); });
    bot.autoLoop.profilesInitialised = true;
};

// --- Helper: ensure cache is loaded ---------------------------------------

const ensureCache = (bot: StarkMercher): OfferCacheManager => {
    // Determine the current account name. Use bot.currentPlayerName (set
    // by initSessionProfile on login and updated immediately on rotation)
    // instead of titan.state.client.localPlayer?.name — the localPlayer read
    // creates a native Player handle on every call.
    const currentPlayer = bot.currentPlayerName || 'unknown';
    if (!bot.autoLoop.cache) {
        bot.autoLoop.cache = new OfferCacheManager(bot, currentPlayer);
    } else if (bot.autoLoop.cache.getAccountName() !== currentPlayer) {
        // Account rotation changed the active account. Save the old cache
        // (so the previous account's pending sells are persisted) and reload
        // with the new account's cache. Without this, the cache manager
        // remains bound to the old account while profit attribution uses
        // the new account — causing cross-account profit attribution
        // (e.g. Ba112's sells recorded under Cyber4Gras).
        if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: account changed %s -> %s, refreshing cache manager',
            bot.autoLoop.cache.getAccountName(), currentPlayer);
        bot.autoLoop.cache.save();
        bot.autoLoop.cache.reload(currentPlayer);
    }
    return bot.autoLoop.cache;
};

// --- Helper: debug log -----------------------------------------------------

const debugLog = (bot: StarkMercher, msg: string): void => {
    if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg);
};

// --- Helper: info log ------------------------------------------------------
// Important, uncommon events: offer placement/failure, cache reconciliation,
// item freezing, repricing, account changes. Gated by logInfo so the user
// can silence all non-error logging. Errors (parse/save failures, offer
// failures) remain unconditional.

const infoLog = (bot: StarkMercher, msg: string): void => {
    if (bot.logInfoValue) titan.logf('[Stark Mercher] %s', msg);
};

/** Formats a delay value with humanisation layer info for debug logs.
 *  Returns e.g. "4t" or "4t [hesitation+outlier]" or "12t [micro-distraction]". */
const fmtDelay = (ticks: number): string => {
    const layers = getLastDelayLayers();
    return layers ? `${ticks}t [${layers}]` : `${ticks}t`;
};

// --- Helper: get occupied item names from slots ---------------------------

const getOccupiedItemNames = (slots: OfferSlotState[]): Set<string> => {
    const names = new Set<string>();
    for (const s of slots) {
        if (s.itemName && (s.type === 'buy' || s.type === 'sell')) {
            names.add(s.itemName.trim().toLowerCase());
        }
    }
    return names;
};

// --- Helper: check if any slot needs collection ---------------------------
// The collect widget (GE_COLLECT_WIDGET = 30474246) has visible=true whenever
// the GE interface is open, even when there's nothing to collect. So we can't
// rely on widget visibility. Instead, we check slot states: if at least one
// slot has status 'completed_or_aborted' and is not empty, there's something
// to collect.
const hasCompletedOrAbortedSlot = (slots: OfferSlotState[]): boolean =>
    slots.some(s => s.type !== 'empty' && s.status === 'completed_or_aborted');

// --- Helper: check if a sell offer is 100% completed ----------------------
// A sell offer is 100% completed when the progress bar is full (inner >= outer)
// and the slot type is 'sell'. This means the item has been fully sold and
// will be collected when we hit "Collect".
const isSellOfferCompleted = (slot: OfferSlotState): boolean => {
    return slot.type === 'sell' && slot.status === 'completed_or_aborted';
};

// --- Helper: check stale offer conditions ---------------------------------

/**
 * Checks if a sell offer is stale and should be aborted.
 * Returns a human-readable reason string if stale, or null if not.
 */
const isSellOfferStale = (slot: OfferSlotState, cache: OfferCacheManager): string | null => {
    if (slot.type !== 'sell' || !slot.itemName) return null;
    // Only abort active offers (not completed ones — those get collected).
    if (slot.status !== 'active') return null;

    const entry = cache.get(slot.itemName);
    if (!entry) return null; // no timestamp to check

    // Dump-floor guard: if the sell price is already at the tax-break-even
    // floor and the revision count has reached the final dump threshold,
    // the price cannot be reduced further under the no-loss invariant (rev 0-8).
    // However, after a configurable hold period with 0% progress, the
    // controlled loss dump (Option 1) allows pricing below the tax break-even
    // floor to free the slot. The hold timer is longer (90 min) for the first
    // controlled loss dump (rev 8 → 9) and shorter (30 min) for subsequent
    // re-reductions (rev 9+). When the hold timer expires, the guard lets the
    // stale checks below proceed — the 0-progress absolute cap will catch it
    // and trigger an abort, after which the sell scan calls reviseSellPrice
    // which applies the controlled loss pricing tier (rev 9+).
    if (cache.isAtDumpFloor(slot.itemName)) {
        const revCount = cache.getRevisionCount(slot.itemName);
        // At rev 9+ and can't reduce further (at 80% of buyPrice minimum) —
        // the offer is at the absolute floor. Let it sit and fill at its
        // own pace; no further action possible.
        if (revCount >= 9 && !cache.canReduceControlledLoss(slot.itemName)) {
            return null;
        }
        // Determine hold timer: 90 min for rev 8 (at tax break-even floor),
        // 30 min for rev 9+ (already accepting controlled loss).
        const holdMin = revCount >= 9
            ? DUMP_FLOOR_CONTROLLED_LOSS_HOLD_MIN
            : DUMP_FLOOR_HOLD_MIN;
        if (!cache.isDumpFloorStuck(slot.itemName, holdMin)) {
            return null; // hold timer hasn't expired — keep waiting
        }
        // Hold timer expired — fall through to the stale checks below.
        // The 0-progress absolute cap will fire and trigger an abort.
        // The sell scan will then revise the price below the tax break-even
        // floor (controlled loss dump, rev 9+).
    }

    const now = Date.now();
    const elapsedMs = now - entry.offerPlacedAt;
    const elapsedMin = elapsedMs / 60000;

    // --- Reconstructed-sell profit guard ---
    // Entries created by reverse reconstruction (cache loss after client
    // restart) track pre-existing offers from a previous session. Their
    // prices may be stale or no longer profitable. Abort if:
    //   (a) Zero or negative net profit per item (after GE tax) — the sell
    //       will never make money, e.g. Dragonstone bolt tips at 411gp sell
    //       with 403gp buy (8gp tax = 0gp net profit). Aborted immediately.
    //   (b) Very low profit per slot per hour (< 5k gp/hr) when a sell ETA
    //       is available — the slot is worth more than this, e.g. Raw sea
    //       turtle at 6gp/item * 806 qty / 5.1h ETA = ~946 gp/hr. Only fires
    //       after a 5-minute grace period AND only if the offer has 0%
    //       progress — thin-margin sells that are actively filling are left
    //       alone so they can complete at the original price.
    // Only applies to reconstructed entries — entries we placed ourselves
    // are deliberate picks and should follow the normal ETA-based stale rules.
    // The reconstructed flag is cleared when the bot places its own sell offer
    // (recordSellOffer) or confirms one (confirmSellOffer), so the guard only
    // fires on the original pre-existing offer, not on the bot's re-lists.
    if (entry.reconstructed) {
        const netSell = getNetSellPrice(entry.sellPrice);
        const profitPerItem = netSell - entry.buyPrice;
        // Tolerance threshold: the reconstructed buy price comes from
        // priceHistory's 1h average (the actual cache was lost), which can
        // differ from the real buy price by 2-3%. For thin-margin items, this
        // small error can flip a profitable sell into an apparent loss. Only
        // abort if the net loss exceeds max(5gp, 2% of sell price) — losses
        // within this tolerance are likely reconstruction artefacts, not
        // genuine losses. The sell stays in the slot and completes normally;
        // if it was actually profitable (as in the Toadflax case: reconstructed
        // buy=2207 vs actual buy=2160, sell=2224), the item sells at a real
        // profit. If it was genuinely unprofitable, the ETA-based stale checks
        // will catch it eventually.
        const reconLossTolerance = Math.max(5, Math.round(entry.sellPrice * 0.02));
        if (profitPerItem <= -reconLossTolerance) {
            return `reconstructed zero-profit sell: net ${netSell}gp (sell ${entry.sellPrice}gp - tax ${getGeTax(entry.sellPrice)}gp) <= buy ${entry.buyPrice}gp (loss ${profitPerItem}gp/item exceeds ${reconLossTolerance}gp tolerance) — aborting to free slot`;
        }
        // Low profit/hr check — only when we have a sell ETA > 0.
        // Give the offer a grace period and only abort if it hasn't started
        // filling. Thin-margin sells that are actively filling should be left
        // alone to complete at the original price rather than being driven to
        // a loss through revision cycles.
        const reconSellEta = entry.saleEtaMinutes ?? 0;
        if (reconSellEta > 0 && slot.itemQuantity > 0
            && slot.progress < 0.01
            && elapsedMin >= RECONSTRUCTED_SELL_GRACE_PERIOD_MIN) {
            const profitPerSlotHour = (profitPerItem * slot.itemQuantity) / (reconSellEta / 60);
            if (profitPerSlotHour < RECONSTRUCTED_SELL_PROFIT_PER_SLOT_HOUR_MIN) {
                return `reconstructed low-profit sell: ${profitPerSlotHour.toFixed(0)}gp/hr (${profitPerItem}gp/item * ${slot.itemQuantity} qty / ${reconSellEta.toFixed(1)}min ETA) < ${RECONSTRUCTED_SELL_PROFIT_PER_SLOT_HOUR_MIN}gp/hr minimum, 0% progress after ${elapsedMin.toFixed(1)}min — aborting to free slot`;
            }
        }
    }

    // We never abort sell offers for items we already own — we need to sell
    // them to recover our investment regardless of whether they're still
    // merchable candidates. Only ETA-based staleness applies to sell offers.

    // Prefer the cached ETA (runtime — based on the actual offer quantity)
    // over live merchable data (simulation — based on the 50m cash stack
    // quantity). The runtime ETA is accurate for the actual offer size and
    // produces correct stale-check thresholds. Fall back to live merch data
    // if the cache has no ETA (e.g. reconstructed entries).
    const merch = getMerchableItem(slot.itemName);
    const rawEta = (entry.saleEtaMinutes ?? 0) || (merch ? merch.saleEtaMinutes : 0);

    // Absolute cap for 0-progress sells: if nothing has sold after the
    // ETA-scaled cap, abort and revise the price. This catches:
    //   - Items with ETA=0 (cached/reconstructed entries with no sale ETA)
    //     → uses the flat 20min floor
    //   - High-ETA items that clearly aren't moving at the listed price
    //     → uses clamp(eta * 0.5, 20, 60) so a 114min ETA sell gets 57min
    //       instead of being aborted at 20min (18% of ETA)
    // Without this, high-value sells (e.g. 647k Ornate maul handle) can sit
    // at 0% for 1-2 hours tying up capital.
    if (slot.progress < 0.01) {
        const absoluteCap = rawEta > 0
            ? computeSellZeroProgressCap(Math.max(rawEta, SELL_ETA_FLOOR_MIN))
            : SELL_ZERO_PROGRESS_ABSOLUTE_ABORT_MIN;
        if (elapsedMin >= absoluteCap) {
            return `0-progress absolute cap: ${elapsedMin.toFixed(1)}min elapsed >= ${absoluteCap.toFixed(1)}min, progress 0% — sell price ${entry.sellPrice}gp (buy ${entry.buyPrice}gp, margin ${entry.sellPrice - entry.buyPrice}gp)`;
        }
    }

    // Partial-progress stall with no ETA: if the sell has made some progress
    // (>=1%) but has a zero/unavailable ETA, the ETA-based checks below are
    // skipped. Without this check, partial-progress sells with no ETA can
    // sit indefinitely at a stale progress level — e.g. Contract of Glyphic
    // Attenuation stuck at 69.5% for 60+ minutes with ETA=0, tying up
    // capital and a GE slot. Use the time since the last progress update
    // (tracked by the stale-check loop via lastSellProgressAt) to detect
    // true stagnation. Fall back to total elapsed time if no progress
    // tracking exists (e.g. reconstructed entries that never changed).
    if (slot.progress >= 0.01 && rawEta <= 0) {
        const lastProgressAt = entry.lastSellProgressAt;
        const stallMin = lastProgressAt !== undefined
            ? (now - lastProgressAt) / 60000
            : elapsedMin;
        if (stallMin >= SELL_PARTIAL_PROGRESS_NO_ETA_STALL_MIN) {
            return `partial-progress stall (no ETA): ${stallMin.toFixed(1)}min since last progress >= ${SELL_PARTIAL_PROGRESS_NO_ETA_STALL_MIN}min, progress ${(slot.progress * 100).toFixed(1)}% — sell price ${entry.sellPrice}gp (buy ${entry.buyPrice}gp, margin ${entry.sellPrice - entry.buyPrice}gp)`;
        }
        return null; // still within grace period, keep waiting
    }

    if (rawEta <= 0) return null; // no ETA data at all — can't determine staleness
    // Floor the ETA so high-volume items with tiny runtime ETAs don't get
    // aborted almost instantly — see SELL_ETA_FLOOR_MIN comment above.
    const eta = Math.max(rawEta, SELL_ETA_FLOOR_MIN);

    // Progress-since-revision extension: if the offer has made progress
    // recently (within the last half-ETA window) and we haven't exceeded
    // 2x ETA, skip the ETA-based stale checks. The offer is actively selling
    // — give it more time instead of prematurely revising the price.
    // This prevents aborting offers that are filling at a reasonable rate
    // but slower than the ETA predicted (e.g. Diamond dragon bolts at 67%
    // sold when the ETA predicted 100%).
    // The extension is capped at 2x ETA to prevent infinitely extending
    // truly slow items. If progress stalled more than half an ETA window
    // ago, the extension doesn't apply — the item is no longer actively
    // selling.
    if (hasRecentSellProgress(entry, eta, now) && elapsedMin < eta * SELL_PROGRESS_EXTENSION_CAP_RATIO) {
        return null;
    }

    // Dynamic ETA threshold scaled by profit margin — thin-margin items
    // get more time to sell before being revised (since each 1gp cut is a
    // large % of their profit), while high-margin items are revised sooner.
    const profit = entry.sellPrice - entry.buyPrice;
    const abortRatio = computeSellEtaAbortRatio(profit);
    const etaThreshold = eta * abortRatio;
    if (elapsedMin >= etaThreshold && slot.progress < SELL_PROGRESS_ABORT_THRESHOLD) {
        return `ETA exceeded: ${elapsedMin.toFixed(1)}min elapsed >= ${etaThreshold.toFixed(1)}min (${(abortRatio * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress ${(slot.progress * 100).toFixed(1)}% < ${(SELL_PROGRESS_ABORT_THRESHOLD * 100).toFixed(0)}% — sell price ${entry.sellPrice}gp (buy ${entry.buyPrice}gp, margin ${profit}gp)`;
    }

    // Stalled near completion: 100% of ETA passed with >=50% sold but offer
    // hasn't completed. The last 10% may never sell at this price — abort
    // so the unsold items can be re-listed at a revised (lower) price.
    const etaThresholdStalled = eta * SELL_ETA_ABORT_RATIO_STALLED;
    if (slot.progress >= SELL_PROGRESS_STALLED_THRESHOLD && elapsedMin >= etaThresholdStalled) {
        return `stalled near completion: ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdStalled.toFixed(1)}min (${(SELL_ETA_ABORT_RATIO_STALLED * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress ${(slot.progress * 100).toFixed(1)}% — sell price ${entry.sellPrice}gp (buy ${entry.buyPrice}gp, margin ${entry.sellPrice - entry.buyPrice}gp)`;
    }

    return null;
};

/**
 * Checks if a buy offer is stale and should be aborted.
 * Returns a human-readable reason string if stale, or null if not.
 */
const isBuyOfferStale = (slot: OfferSlotState, cache: OfferCacheManager): string | null => {
    if (slot.type !== 'buy' || !slot.itemName) return null;
    // Only abort active offers (not completed ones — those get collected).
    if (slot.status !== 'active') return null;

    const entry = cache.get(slot.itemName);
    if (!entry) return null;

    const now = Date.now();
    const elapsedMs = now - entry.offerPlacedAt;
    const elapsedMin = elapsedMs / 60000;

    // Items removed from merchableItems.json are NOT immediately aborted.
    // They may still be merchable — the list is volatile during development
    // and an item removed and re-added shouldn't cause abort churn. Instead,
    // let the ETA-based checks below handle them: if the offer doesn't fill
    // within the ETA thresholds, it will be aborted as stale. If it does
    // fill, the sell scan will sell it regardless of merchable status.

    // Prefer the cached ETA (runtime — based on the actual offer quantity)
    // over live merchable data (simulation — based on the 50m cash stack
    // quantity). The runtime ETA is accurate for the actual offer size.
    const merch = getMerchableItem(slot.itemName);
    const rawEta = (entry.purchaseEtaMinutes ?? 0) || (merch ? merch.purchaseEtaMinutes : 0);
    if (rawEta <= 0) return null; // no ETA data at all — can't determine staleness
    // Floor the ETA so high-volume items with tiny runtime ETAs don't get
    // aborted almost instantly — see BUY_ETA_FLOOR_MIN comment above.
    const eta = Math.max(rawEta, BUY_ETA_FLOOR_MIN);

    const isLowball = merch ? merch.lowballPercent > 0 : false;
    const profitMargin = merch ? merch.profitMargin : undefined;

    // Compute runtime profit/hr for profit-aware abort scaling. High profit/hr
    // items get more patience before being aborted because the opportunity
    // cost of freeing the slot is higher (especially when the pool is
    // exhausted). Thin-margin items are excluded from scaling (they already
    // get 125% of ETA via the thin-margin exception).
    const isThinMargin = profitMargin !== undefined && profitMargin <= BUY_ZERO_PROGRESS_THIN_MARGIN_THRESHOLD;
    const sellEta = entry.saleEtaMinutes ?? (merch ? merch.saleEtaMinutes : 0);
    const turnoverEta = eta + Math.max(sellEta, 0);
    const quantity = slot.itemQuantity || entry.buyQuantity || 0;
    const runtimeProfitPerSlotHour = (!isThinMargin && profitMargin !== undefined && turnoverEta > 0 && quantity > 0)
        ? (quantity * profitMargin) * (60 / turnoverEta)
        : 0;
    const profitScaleFactor = computeBuyProfitScaleFactor(runtimeProfitPerSlotHour);
    const profitCeilingScaleFactor = computeBuyProfitCeilingScaleFactor(runtimeProfitPerSlotHour);
    const profitScaleSuffix = profitScaleFactor > 1.0
        ? `, profit/hr ${runtimeProfitPerSlotHour.toFixed(0)}gp (scale ${profitScaleFactor.toFixed(2)}x)`
        : '';

    // Buy (0 bought): min(125% of ETA * profitScale, ETA-scaled absolute cap) passed with 0 bought → abort
    // The absolute cap is ETA-scaled so long-ETA items (e.g. Ancient essence
    // at 64min ETA) get more patience before being aborted — high-volume
    // lumpy-fill items often sit at 0% then fill all at once. Fast items
    // (≤30min ETA non-lowball) keep the 15min floor (unchanged).
    // Thin-margin items (profitMargin <= 3gp) get 125% of ETA as the cap,
    // so the ETA threshold is the effective check (not the absolute cap).
    // High profit/hr items get scaled thresholds — see profit scaling above.
    const absoluteAbortMin = computeBuyZeroProgressCap(eta, isLowball, profitMargin, profitScaleFactor, profitCeilingScaleFactor);
    const etaRatioZeroScaled = BUY_ETA_ABORT_RATIO_ZERO * profitScaleFactor;
    const etaThresholdZero = Math.min(eta * etaRatioZeroScaled, absoluteAbortMin);
    if (slot.progress <= 0 && elapsedMin >= etaThresholdZero) {
        const reason = etaThresholdZero === absoluteAbortMin
            ? `0-progress absolute cap: ${elapsedMin.toFixed(1)}min elapsed >= ${absoluteAbortMin.toFixed(1)}min cap (ETA ${eta.toFixed(1)}min, ${isLowball ? 'lowball' : 'non-lowball'}${isThinMargin ? ', thin-margin' : ''}${profitScaleSuffix}), progress 0% — buy price ${entry.buyPrice}gp`
            : `ETA exceeded (0 bought): ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdZero.toFixed(1)}min (${(etaRatioZeroScaled * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA${profitScaleSuffix}), progress 0% — buy price ${entry.buyPrice}gp`;
        return reason;
    }

    // Buy (partial fill, no progress): progress > 0 but < 100% and hasn't
    // increased for the ETA-scaled no-progress threshold → abort. This catches
    // offers that filled partially then stalled (e.g. 6/8 Occult necklaces
    // at 74% with no movement for 15+ minutes). The threshold scales with ETA
    // so fast items get a strict 10-min floor while slow high-ticket items
    // (e.g. 2 items with 1hr ETA) get up to 30 min of patience.
    // High profit/hr items get scaled thresholds.
    // lastBuyProgress/lastBuyProgressAt are updated by the stale-check loop
    // in autoLoopTick before this function is called.
    if (slot.progress > 0 && slot.progress < 1 && entry.lastBuyProgressAt) {
        const noProgressMs = now - entry.lastBuyProgressAt;
        const noProgressMin = noProgressMs / 60000;
        const noProgressMinScaled = BUY_NO_PROGRESS_MIN * profitScaleFactor;
        const noProgressMaxScaled = BUY_NO_PROGRESS_MAX * profitCeilingScaleFactor;
        const noProgressThreshold = Math.max(noProgressMinScaled, Math.min(eta * BUY_NO_PROGRESS_RATIO, noProgressMaxScaled));
        if (noProgressMin >= noProgressThreshold) {
            return `no progress for ${noProgressMin.toFixed(1)}min (threshold ${noProgressThreshold.toFixed(1)}min = ${BUY_NO_PROGRESS_RATIO * 100}% of ${eta.toFixed(1)}min ETA${profitScaleSuffix}), progress ${(slot.progress * 100).toFixed(1)}% — buy price ${entry.buyPrice}gp`;
        }
    }

    // Buy (multi-qty, partial fill): 90% of ETA passed with >0% but <50% bought → abort.
    // The progress > 0 guard ensures 0-progress offers are handled only by the
    // 0-fill check above, which gives more patience (125% ETA or the absolute
    // floor, whichever is lower). Without this guard, a 0-progress offer with a
    // short ETA (e.g. Soul rune at 3.2min) gets aborted at 90% of ETA (2.88min)
    // before the 0-fill check ever fires.
    // High profit/hr items get a scaled ratio.
    const etaRatioMultiScaled = BUY_ETA_ABORT_RATIO_MULTI * profitScaleFactor;
    const etaThresholdMulti = eta * etaRatioMultiScaled;
    if (slot.itemQuantity > 1 && slot.progress > 0 && slot.progress < BUY_PROGRESS_ABORT_THRESHOLD && elapsedMin >= etaThresholdMulti) {
        return `ETA exceeded (partial): ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdMulti.toFixed(1)}min (${(etaRatioMultiScaled * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA${profitScaleSuffix}), progress ${(slot.progress * 100).toFixed(1)}% < ${(BUY_PROGRESS_ABORT_THRESHOLD * 100).toFixed(0)}% — buy price ${entry.buyPrice}gp`;
    }

    // Buy (stalled near completion): 100% of ETA passed with >=50% bought
    // but offer hasn't completed. The last 5% may never fill due to price
    // shifts — abort so we can sell what we have and free the slot.
    // High profit/hr items get a scaled ratio.
    const etaRatioStalledScaled = BUY_ETA_ABORT_RATIO_STALLED * profitScaleFactor;
    const etaThresholdStalled = eta * etaRatioStalledScaled;
    if (slot.itemQuantity > 1 && slot.progress >= BUY_PROGRESS_STALLED_THRESHOLD && elapsedMin >= etaThresholdStalled) {
        return `stalled near completion: ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdStalled.toFixed(1)}min (${(etaRatioStalledScaled * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA${profitScaleSuffix}), progress ${(slot.progress * 100).toFixed(1)}% — buy price ${entry.buyPrice}gp`;
    }

    return null;
};

// --- Helper: check if a stalled buy qualifies for repricing ----------------
// Returns the bumped buy price if repricing is viable, or null if the item
// should go through the normal abort + freeze path instead.
const computeBuyReprice = (
    slot: OfferSlotState,
    cache: OfferCacheManager,
    repriceCount: number,
): number | null => {
    if (slot.type !== 'buy' || !slot.itemName) return null;
    const entry = cache.get(slot.itemName);
    if (!entry) return null;

    // Gate 1: max reprice count
    if (repriceCount >= BUY_REPRICE_MAX_COUNT) return null;

    const merch = getMerchableItem(slot.itemName);
    if (!merch) return null;

    // Gate 2: margin must be thick enough to absorb a bump
    const grossMargin = merch.salePrice - entry.buyPrice;
    if (grossMargin < BUY_REPRICE_MIN_MARGIN_GP) return null;

    // Gate 3: profit/hr must be high enough to justify the extra attention
    const isLowball = merch.lowballPercent > 0;
    const isThinMargin = merch.profitMargin !== undefined && merch.profitMargin <= BUY_ZERO_PROGRESS_THIN_MARGIN_THRESHOLD;
    const sellEta = entry.saleEtaMinutes ?? merch.saleEtaMinutes ?? 0;
    const rawEta = (entry.purchaseEtaMinutes ?? 0) || merch.purchaseEtaMinutes || 0;
    const eta = Math.max(rawEta, BUY_ETA_FLOOR_MIN);
    const turnoverEta = eta + Math.max(sellEta, 0);
    const quantity = slot.itemQuantity || entry.buyQuantity || 0;
    const runtimeProfitPerSlotHour = (!isLowball && !isThinMargin && turnoverEta > 0 && quantity > 0)
        ? (quantity * merch.profitMargin) * (60 / turnoverEta)
        : 0;
    if (runtimeProfitPerSlotHour < BUY_REPRICE_MIN_PROFIT_PER_HOUR) return null;

    // Compute the bump: smaller of 0.5% of buy price and 10% of gross margin
    const bump = Math.max(1, Math.min(
        Math.floor(entry.buyPrice * BUY_REPRICE_BUY_PRICE_RATIO),
        Math.floor(grossMargin * BUY_REPRICE_MARGIN_RATIO),
    ));
    const newBuyPrice = entry.buyPrice + bump;

    // Gate 4: post-bump viability — recompute profit/hr with the reduced margin
    const newMargin = merch.salePrice - newBuyPrice;
    const postBumpProfitPerHour = (!isLowball && !isThinMargin && turnoverEta > 0 && quantity > 0)
        ? (quantity * newMargin) * (60 / turnoverEta)
        : 0;
    if (postBumpProfitPerHour < BUY_REPRICE_POST_BUMP_MIN_PROFIT_PER_HOUR) return null;

    return newBuyPrice;
};
// For each active slot, compute the remaining minutes until the next action
// (earlier of completion or stale-abort threshold). Returns the minimum
// across all slots, or -1 if no ETA data is available. Used by the break
// system to time the return so the bot logs back in when there's something
// to do, instead of sampling a random 2-5 min duration.
const computeNextActionEtaMin = (slots: OfferSlotState[], cache: OfferCacheManager): number => {
    const now = Date.now();
    let minRemaining = -1;

    for (const slot of slots) {
        if (slot.type === 'empty' || !slot.itemName || slot.status !== 'active') continue;

        const entry = cache.get(slot.itemName);
        if (!entry || entry.offerPlacedAt <= 0) continue;

        const elapsedMin = (now - entry.offerPlacedAt) / 60000;

        // Determine the ETA and the earliest abort threshold ratio for this slot.
        let eta = 0;
        let abortRatio = 1.0; // default: completion (100% of ETA)

        if (slot.type === 'buy') {
            const merch = getMerchableItem(slot.itemName);
            // Prefer cached runtime ETA over live simulation ETA.
            const rawBuyEta = (entry.purchaseEtaMinutes ?? 0) || (merch ? merch.purchaseEtaMinutes : 0);
            if (rawBuyEta <= 0) continue;
            // Floor the ETA so break timing doesn't log back in too early for
            // high-volume items with tiny runtime ETAs — see BUY_ETA_FLOOR_MIN.
            eta = Math.max(rawBuyEta, BUY_ETA_FLOOR_MIN);
            // Compute profit scale factor (must match isBuyOfferStale).
            const profitMargin = merch ? merch.profitMargin : undefined;
            const isThinMargin = profitMargin !== undefined && profitMargin <= BUY_ZERO_PROGRESS_THIN_MARGIN_THRESHOLD;
            const sellEta = entry.saleEtaMinutes ?? (merch ? merch.saleEtaMinutes : 0);
            const turnoverEta = eta + Math.max(sellEta, 0);
            const quantity = slot.itemQuantity || entry.buyQuantity || 0;
            const runtimeProfitPerSlotHour = (!isThinMargin && profitMargin !== undefined && turnoverEta > 0 && quantity > 0)
                ? (quantity * profitMargin) * (60 / turnoverEta)
                : 0;
            const profitScaleFactor = computeBuyProfitScaleFactor(runtimeProfitPerSlotHour);
            const profitCeilingScaleFactor = computeBuyProfitCeilingScaleFactor(runtimeProfitPerSlotHour);
            // 0% progress: stale at min(125% of ETA * profitScale, absolute cap)
            // <50% progress: stale at 90% of ETA * profitScale (earlier than completion)
            // >=50% progress: stalled check at 100% of ETA * profitScale
            if (slot.progress <= 0) {
                const isLowball = merch ? merch.lowballPercent > 0 : false;
                const absoluteAbortMin = computeBuyZeroProgressCap(eta, isLowball, profitMargin, profitScaleFactor, profitCeilingScaleFactor);
                abortRatio = Math.min(BUY_ETA_ABORT_RATIO_ZERO * profitScaleFactor, absoluteAbortMin / eta);
            } else if (slot.progress < BUY_PROGRESS_ABORT_THRESHOLD && slot.itemQuantity > 1) {
                abortRatio = BUY_ETA_ABORT_RATIO_MULTI * profitScaleFactor;
            }
            // Partial-fill no-progress: separate timer based on
            // lastBuyProgressAt, not offerPlacedAt. Compute its remaining
            // time and take the minimum against the ETA-based threshold.
            if (slot.progress > 0 && slot.progress < 1 && entry.lastBuyProgressAt) {
                const noProgressMinScaled = BUY_NO_PROGRESS_MIN * profitScaleFactor;
                const noProgressMaxScaled = BUY_NO_PROGRESS_MAX * profitCeilingScaleFactor;
                const noProgressThreshold = Math.max(
                    noProgressMinScaled,
                    Math.min(eta * BUY_NO_PROGRESS_RATIO, noProgressMaxScaled),
                );
                const noProgressElapsed = (now - entry.lastBuyProgressAt) / 60000;
                const noProgressRemaining = noProgressThreshold - noProgressElapsed;
                if (noProgressRemaining > 0 && (minRemaining < 0 || noProgressRemaining < minRemaining)) {
                    minRemaining = noProgressRemaining;
                }
            }
        } else if (slot.type === 'sell') {
            const merch = getMerchableItem(slot.itemName);
            // Prefer cached runtime ETA over live simulation ETA.
            const rawSellEta = (entry.saleEtaMinutes ?? 0) || (merch ? merch.saleEtaMinutes : 0);
            // 0% progress: earliest abort is the ETA-scaled absolute cap if
            // ETA is missing/0 (flat 20min floor), or min(ETA-scaled cap,
            // dynamic ratio) if ETA exists. The ETA-scaled cap prevents
            // long-ETA sells from being aborted at 20min (18% of a 114min
            // ETA) — see computeSellZeroProgressCap.
            if (slot.progress < 0.01) {
                if (rawSellEta <= 0) {
                    // No ETA data — only the flat absolute cap applies.
                    const remaining = SELL_ZERO_PROGRESS_ABSOLUTE_ABORT_MIN - elapsedMin;
                    if (remaining > 0 && (minRemaining < 0 || remaining < minRemaining)) {
                        minRemaining = remaining;
                    }
                    continue;
                }
                // Floor the ETA so high-volume items with tiny runtime ETAs
                // don't get aborted almost instantly — see SELL_ETA_FLOOR_MIN.
                eta = Math.max(rawSellEta, SELL_ETA_FLOOR_MIN);
                const absoluteThreshold = computeSellZeroProgressCap(eta);
                const profit = entry.sellPrice - entry.buyPrice;
                const ratioThreshold = eta * computeSellEtaAbortRatio(profit);
                abortRatio = Math.min(absoluteThreshold / eta, ratioThreshold / eta);
            } else {
                if (rawSellEta <= 0) continue;
                // Floor the ETA so high-volume items with tiny runtime ETAs
                // don't get aborted almost instantly — see SELL_ETA_FLOOR_MIN.
                eta = Math.max(rawSellEta, SELL_ETA_FLOOR_MIN);
                // <25% progress: stale at dynamic ratio (35-95%, earlier than completion)
                // >=50% progress: stalled check at 100% of ETA (same as completion)
                if (slot.progress < SELL_PROGRESS_ABORT_THRESHOLD) {
                    const profit = entry.sellPrice - entry.buyPrice;
                    abortRatio = computeSellEtaAbortRatio(profit);
                }
                // Progress-since-revision extension: if the offer has recent
                // progress, the ETA-based checks are skipped until 2x ETA.
                // Reflect this in the idle prediction so the break system
                // doesn't log back in prematurely.
                if (hasRecentSellProgress(entry, eta, now)) {
                    abortRatio = SELL_PROGRESS_EXTENSION_CAP_RATIO; // 2x ETA
                }
            }
        } else {
            continue;
        }

        const thresholdMin = eta * abortRatio;
        const remaining = thresholdMin - elapsedMin;
        if (remaining > 0 && (minRemaining < 0 || remaining < minRemaining)) {
            minRemaining = remaining;
        }
    }

    return minRemaining;
};

// --- Historical protections (loss-history cooldown + abort-history seeding) --

/** Applies historical protections for the current account:
 *  1. Loss-history cooldown: scans merch history losses within the lookback
 *     window and applies a buy freeze for each affected item (until
 *     latestLossTime + LOSS_COOLDOWN_FREEZE_MS).
 *  2. Abort-history seeding: scans abort history for sell aborts within the
 *     lookback window and seeds the live sell-abort count so progressive
 *     freezes and hard-skips recognize repeated historical sell failures.
 *
 *  Idempotent: only runs once per account per session (tracked in
 *  `historicalProtectionsApplied`). On reload, the set is cleared but the
 *  persisted itemAbortCounts already reflect prior seeding — the
 *  `Math.max(currentCount, historicalCount)` reconciliation prevents
 *  re-inflation. Freeze sources are labeled in `buyFreezeSources` for
 *  diagnostic visibility. */
const applyHistoricalProtections = (bot: StarkMercher, loop: AutoLoopState): void => {
    const accountName = bot.currentPlayerName || '';
    if (!accountName) return;
    const normKey = accountName.trim().toLowerCase();
    if (loop.historicalProtectionsApplied.has(normKey)) return;

    const now = Date.now();
    let freezeChanged = false;
    let countsChanged = false;
    let lossCooldownApplied = 0;
    let abortsSeeded = 0;

    // --- 1. Loss-history cooldown ---
    // Scan completed losses within the lookback window. For each item with a
    // recent loss, apply a buy freeze until (latestLossTime + cooldown). This
    // prevents re-buying items that have been confirmed unprofitable.
    const merchHistory = getMerchHistory(bot, accountName);
    const lossItems = new Map<string, number>(); // item key -> latest loss timestamp
    for (const loss of merchHistory.losses) {
        const lossTime = Date.parse(loss.date);
        if (isNaN(lossTime)) continue;
        if (now - lossTime > LOSS_HISTORY_LOOKBACK_MS) continue;
        const key = loss.item.trim().toLowerCase();
        const existing = lossItems.get(key);
        if (!existing || lossTime > existing) {
            lossItems.set(key, lossTime);
        }
    }
    for (const [key, latestLossTime] of lossItems) {
        const freezeUntil = latestLossTime + LOSS_COOLDOWN_FREEZE_MS;
        if (freezeUntil <= now) continue; // cooldown already expired
        const existing = loop.buyFreezeUntil.get(key);
        if (!existing || existing < freezeUntil) {
            loop.buyFreezeUntil.set(key, freezeUntil);
            loop.buyFreezeSources.set(key, 'loss-cooldown');
            freezeChanged = true;
            lossCooldownApplied++;
        }
    }

    // --- 2. Abort-history seeding ---
    // Count sell aborts per item within the lookback window. Seed the live
    // sell-abort count and lastSellAbortAt if the historical count exceeds
    // the current live count. Set lastSellAbortAt to now so the count
    // survives the normal 2h decay window. The seeded count feeds into the
    // effective count (buy + sell) — items with 3+ effective aborts are
    // hard-skipped by the hard-skip scan on the next tick. No explicit freeze
    // is applied here (the hard-skip via buyLimitedNames is the stronger
    // protection for historical aborts).
    const abortHistory = getAbortHistory(bot, accountName);
    const sellAbortsByItem = new Map<string, number>(); // item key -> count
    for (const abort of abortHistory.aborts) {
        if (abort.type !== 'sell') continue;
        const abortTime = Date.parse(abort.date);
        if (isNaN(abortTime)) continue;
        if (now - abortTime > HISTORICAL_SELL_ABORT_SEED_LOOKBACK_MS) continue;
        const key = abort.item.trim().toLowerCase();
        sellAbortsByItem.set(key, (sellAbortsByItem.get(key) ?? 0) + 1);
    }
    for (const [key, histCount] of sellAbortsByItem) {
        const existing = loop.itemAbortCounts.get(key);
        const currentSellCount = existing?.sellCount ?? 0;
        // Only seed if the historical count is higher than what's already
        // loaded (idempotent — prevents re-inflation on every reload).
        if (histCount <= currentSellCount) continue;
        const newSellCount = histCount;
        loop.itemAbortCounts.set(key, {
            count: existing?.count ?? 0,
            lastAbortAt: existing?.lastAbortAt ?? 0,
            sellCount: newSellCount,
            lastSellAbortAt: now, // set to now so decay window starts fresh
        });
        countsChanged = true;
        abortsSeeded++;
    }

    if (freezeChanged) saveBuyFreeze(bot, loop.buyFreezeUntil);
    if (countsChanged) saveItemAbortCounts(bot, loop.itemAbortCounts);

    if (lossCooldownApplied > 0 || abortsSeeded > 0) {
        if (bot.logInfoValue) titan.logf(
            '[Stark Mercher] Auto: historical protections applied for "%s" — %d loss cooldown(s), %d sell-abort seed(s).',
            accountName, lossCooldownApplied, abortsSeeded,
        );
    }

    loop.historicalProtectionsApplied.add(normKey);
};

// --- The main tick function ------------------------------------------------

/**
 * Runs one tick of the auto-merch loop. Returns true if an action was
 * dispatched (the caller should set a delay). Returns false if just polling.
 *
 * The caller (stark-mercher.ts tickLogic) should:
 * 1. Check if autoMode is enabled
 * 2. Call autoLoopTick(bot, tick)
 * 3. If it returns true, the delay is already set via setAction inside
 */
export const autoLoopTick = (bot: StarkMercher, tick: number): boolean => {
    // Switch merchable item pool based on mode (F2P mode reads from
    // f2pMerchableItems.json with relaxed runtime thresholds).
    setF2pMode(bot.autoModeValue === 3);

    const loop = bot.autoLoop;

    // --- Idle activity state machine ---
    // When active, the bot performs a productive activity (e.g. grinding
    // chocolate dust) instead of logging out for short breaks. The activity
    // runs before the normal GE logic so it can consume the tick. When the
    // activity signals completion (returns false), the normal GE logic
    // resumes. GE actions take priority — if a GE action is due, the idle
    // activity cleans up (banks items) and yields to GE mode.
    //
    // Rotation over idle activity: if a DIFFERENT account has become eligible
    // (its break lapsed or it woke up), the idle activity also cleans up and
    // yields so the break system logs out and rotates to the eligible
    // account. Without this, the current account keeps grinding the idle
    // activity until its own nightly break, leaving the eligible account
    // waiting. The eligibility check is throttled to 10 seconds (matching
    // the wallClockStep rotation poll) to avoid iterating the roster every
    // tick.
    // Respect the action delay set by the idle activity itself (setAction
    // in the idle-activity module) — don't run the idle activity step while
    // the previous action's delay is still pending.

    // --- Post-reload / startup idle item cleanup ---
    // After a hot reload (or at script start), idleActivityPhase is 'none'
    // (reset by resetAutoLoop) but idle items may still be in the inventory.
    // The hasIdleActivityItems guards (Step 3 collect, Step 4 stale, Step 5
    // sell/buy) block ALL GE flows while idle items are present, so without
    // this cleanup the bot would skip GE flows. This trigger banks the idle
    // items, then yields to GE logic. After all GE flows are done, Step 11
    // starts a new idle activity as normal (only if an activity is selected).
    //
    // This fires for ALL idle activity settings including "None" — if the
    // user switched the setting to "None" with idle items still in the
    // inventory (e.g. after a hot reload, or items left over from a previous
    // session), the bot must still bank them before GE flows can proceed.
    // For "None", the Any-mode scanning path is used because its
    // SUB_DEPOSIT_ALL_IDLE step deposits ALL items from all three activities
    // (the specific-activity cleanup phases only deposit their own items).
    if (loop.idleActivityPhase === 'none' && hasIdleActivityItems(bot)) {
        loop.idleActivityCleanupForGe = true;
        const activity = bot.idleActivityValue;
        if (activity === IDLE_ACTIVITY_ANY || activity === IDLE_ACTIVITY_NONE) {
            // "Any" or "None" — use the scanning phase with the cleanup flag.
            // The scanning phase opens the bank, deposits all idle items
            // (from all three activities), closes the bank, and yields to
            // GE logic instead of picking and starting a new activity.
            startScanning(loop);
        } else {
            // Specific activity — use the activity's existing cleanup
            // phase. The cleanup phase deposits the activity's items,
            // closes the bank, and returns false (yields to GE logic).
            // Set idleActivityCurrent so the dispatch calls the right
            // tick handler.
            loop.idleActivityCurrent = activity;
            loop.idleActivityPhase = 'cleanup';
            loop.idleActivitySubStep = 0; // SUB_OPEN_BANK
            loop.idleActivityLastTick = -1; // allow immediate bank open
        }
    }

    if (loop.idleActivityPhase !== 'none') {
        if (!canPerformAction(bot)) return true; // wait for delay
        let geActionDue = loop.idleActivityGeActionDueMs > 0
            && Date.now() >= loop.idleActivityGeActionDueMs;
        // If a GE offer completed (detected via chat) while an idle activity
        // was active, yield immediately instead of waiting for the ETA-based
        // timer. The bot needs to collect, sell, and place new offers.
        if (bot.geOfferCompletedChatMs > 0) {
            bot.geOfferCompletedChatMs = 0;
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: GE offer completed (chat) — yielding idle activity to resume GE operations');
            geActionDue = true;
        }
        // Throttled rotation-due check (every 10 seconds). selectNextAccount
        // iterates the roster and parses the break-state JSON per account,
        // so we avoid calling it every tick.
        let rotationDue = false;
        const now = Date.now();
        if (now - bot.lastLoggedInRotationCheckMs >= 10000) {
            bot.lastLoggedInRotationCheckMs = now;
            rotationDue = isRotationDueForLoggedIn(bot) !== null;
        }
        const yieldFor = geActionDue || rotationDue;

        // --- "Any" mode scanning phase ---
        // When "Any" idle activity is selected, the bot opens the bank,
        // checks which activities have ingredients, and randomly picks one.
        // The scanning phase is handled by anyActivityTick in
        // idle-activity/any-activity.ts. Once an activity is picked, the
        // phase transitions to 'banking' (via startXxx) and the dispatch
        // below delegates to the activity-specific tick handler.
        if (loop.idleActivityPhase === 'scanning') {
            const stillScanning = anyActivityTick(bot, loop, yieldFor);
            if (stillScanning) return true;
            // Scanning finished without picking an activity (all depleted,
            // or GE action due) — fall through to normal GE logic.
            if (loop.idleActivityDepleted) {
                debugLog(bot, `Auto: idle activity depleted — no ingredients found for any activity, idle activity disabled for this session`);
            }
            // If an activity was just picked, idleActivityPhase is now
            // 'banking' — fall through to the activity dispatch below.
            // Cast to IdleActivityPhase because anyActivityTick may have
            // changed the phase (TS doesn't track mutations across calls).
            const phaseAfterScan = loop.idleActivityPhase as IdleActivityPhase;
            if (phaseAfterScan === 'none') return true;
        }

        // --- Activity-specific dispatch ---
        // For "Any" mode, use idleActivityCurrent (set during scanning).
        // For specific activities, use the setting value directly.
        const selectedActivity = bot.idleActivityValue;
        const currentActivity = selectedActivity === IDLE_ACTIVITY_ANY
            ? loop.idleActivityCurrent
            : selectedActivity;
        let stillActive: boolean;
        if (currentActivity === IDLE_ACTIVITY_ULTRA_COMPOST) {
            stillActive = ultraCompostTick(bot, loop, yieldFor);
        } else if (currentActivity === IDLE_ACTIVITY_GOAT_HORN) {
            stillActive = goatHornTick(bot, loop, yieldFor);
        } else {
            stillActive = chocolateDustTick(bot, loop, yieldFor);
        }
        if (stillActive) return true;
        // Activity finished — fall through to normal GE logic.
        if (loop.idleActivityDepleted) {
            // For "Any" mode: if this activity depleted but others may still
            // have ingredients, re-enter the scanning phase instead of giving
            // up. Add the just-finished activity to the depleted set so it
            // isn't picked again.
            if (selectedActivity === IDLE_ACTIVITY_ANY && currentActivity !== 0) {
                loop.idleActivityAnyDepleted.add(currentActivity);
                if (loop.idleActivityAnyDepleted.size < 3) {
                    // Other activities may still have ingredients — re-scan.
                    loop.idleActivityDepleted = false;
                    debugLog(bot, `Auto: idle activity ${currentActivity} depleted — re-scanning bank for other activities`);
                    startScanning(loop);
                    return true;
                }
                // All three activities depleted — stay depleted for the session.
                debugLog(bot, `Auto: all idle activities depleted — idle activity disabled for this session`);
            } else {
                debugLog(bot, `Auto: idle activity depleted — bank out of ingredients, idle activity disabled for this session`);
            }
        }
    }

    ensureProfiles(bot);
    const cache = ensureCache(bot);

    // Apply historical protections (loss-history cooldown + abort-history
    // seeding) once per account per session. Runs after cache is loaded so
    // the account name is available. Skips silently if no account is active
    // or protections have already been applied for this account.
    applyHistoricalProtections(bot, loop);

    // --- Inventory helpers ---
    // findInInv and countCoinsInInv use the module-level cross-tick
    // inventory cache (getInvSnapshot). The cache is invalidated after
    // any inventory-changing action (collect, sell/buy offer placed, abort
    // with partial fill). See invalidateInvCache() at the top of this file.
    /** Find an item in inventory by name using the cached snapshot.
     *  Returns null if not found. Case-sensitive name match (same as
     *  titan.utils.inventory.find for string queries — the SDK does a
     *  case-insensitive substring match, but all our callers use exact
     *  item names from the cache/slots, so exact match is fine). */
    const findInInv = (itemName: string): titan.Item | null => {
        const snap = getInvSnapshot();
        // Try exact match first.
        const exact = snap.get(itemName);
        if (exact) return exact;
        // Fall back to case-insensitive match (the SDK's find() does
        // case-insensitive substring, so be conservative).
        const lower = itemName.trim().toLowerCase();
        for (const [name, item] of snap) {
            if (name.trim().toLowerCase() === lower) return item;
        }
        return null;
    };
    /** Count coins (item ID 995) from the cached snapshot. */
    const countCoinsInInv = (): number => {
        let total = 0;
        for (const item of getInvSnapshot().values()) {
            if (item.id === 995) total += item.quantity;
        }
        return total;
    };

    // Clear the idle-for-break flag at the start of each auto-loop tick.
    // It gets set again only when we reach the "nothing to do" branch at
    // the bottom of this function.
    // Only reset the idle timers if the bot was NOT idle on the previous
    // tick — if it was idle, the break system in session.ts is counting
    // down using loopIdleSinceTick and shortBreakDelayTicks, and wiping
    // them here would restart the countdown every tick.
    const wasIdle = bot.loopIdleForBreak;
    bot.loopIdleForBreak = false;
    if (!wasIdle) {
        bot.loopIdleSinceTick = -1;
        bot.shortBreakDelayTicks = -1;
        bot.nextActionEtaMin = -1;
        // NOTE: checkedAtHalfEta is NOT cleared here. This block fires
        // whenever the bot was not idle on the previous tick — but after
        // a login, loopIdleForBreak is false (reset by resetInFlightAction
        // State), so wasIdle is false even though no GE action was
        // performed. Clearing checkedAtHalfEta here would wipe the 90%
        // escalation memory on every login. Instead, checkedAtHalfEta is
        // cleared at the specific GE action completion sites below
        // (buy/sell/abort/collect/completed-sell).
    }

    // Throttle idle-path diagnostic logs. When the bot is continuously idle,
    // the "nothing to do" logs (GE slots, stale check, sell/buy scan, ETA)
    // repeat every tick. Only log them every ~5 seconds to prevent spam.
    // Action-triggering logs (abort, sell, buy, collect) always log.
    const verboseIdleDiag = tick - bot.lastIdleDiagTick >= IDLE_DIAG_INTERVAL_TICKS;

    // --- Post-login cleanup ---
    // On the first auto-loop tick after logging back in from a break,
    // remove 'idle' cache entries whose buy-limit window has expired.
    // Also clean up expired buy-freeze entries. This keeps the cache
    // bounded — without it, 'idle' entries would accumulate forever.
    if (loop.needsPostLoginCleanup) {
        loop.needsPostLoginCleanup = false;
        const removed = cache.cleanupExpiredIdleEntries();
        // Clean up expired buy-freeze entries.
        const now = Date.now();
        let freezeRemoved = false;
        for (const [name, until] of loop.buyFreezeUntil) {
            if (now >= until) { loop.buyFreezeUntil.delete(name); loop.buyFreezeSources.delete(name); freezeRemoved = true; }
        }
        if (freezeRemoved) saveBuyFreeze(bot, loop.buyFreezeUntil);
        if (removed > 0) cache.save();
        loop.lastCleanupMs = now;
    }

    // --- Periodic cache cleanup (every 60s) ---
    // During long sessions without breaks (e.g. all slots occupied, no idle
    // time to trigger a short break), expired 'idle' entries and expired
    // buy-freeze entries can accumulate. This periodic sweep
    // keeps the cache bounded. The cost is one cache iteration per 60
    // seconds — negligible.
    const cleanupNow = Date.now();
    if (cleanupNow - loop.lastCleanupMs >= 60_000) {
        const removed = cache.cleanupExpiredIdleEntries();
        let freezeRemoved = false;
        for (const [name, until] of loop.buyFreezeUntil) {
            if (cleanupNow >= until) { loop.buyFreezeUntil.delete(name); loop.buyFreezeSources.delete(name); freezeRemoved = true; }
        }
        if (freezeRemoved) saveBuyFreeze(bot, loop.buyFreezeUntil);
        if (removed > 0) {
            cache.save();
            debugLog(bot, `Auto: periodic cache cleanup removed ${removed} expired entr${removed === 1 ? 'y' : 'ies'}`);
        }
        loop.lastCleanupMs = cleanupNow;
    }

    // --- Defer to active flows ---
    // If a buy/sell/abort flow is in progress, tick it and return.
    if (loop.activeBuyFlow) {
        const flow = loop.activeBuyFlow;
        if (flow.status === 'in_progress') {
            // Invalidate widget cache before each flow step — flows need
            // fresh widget state to detect screen transitions.
            invalidateGeWidgetCache();
            debugLog(bot, `Auto: ticking buy flow for ${flow.itemName}`);
            if (flow.tick()) {
                setAction(bot, 'auto_buy', flow.lastDelay);
            }
            return true;
        }
        if (flow.status === 'done') {
            if (bot.logInfoValue) titan.log('[Stark Mercher] Auto: buy offer placed successfully.');
            // Invalidate — a new buy offer changes GE slot state.
            invalidateGeWidgetCache();
            invalidateBooleanStateCache();
            // Invalidate inventory cache — coins decreased.
            invalidateInvCache();
            // Reset the reprice count — the buy was placed (whether at the
            // original or repriced price), so the reprice cycle is complete.
            // If this item stalls again, it starts with a fresh reprice count.
            loop.buyRepriceCounts.delete(flow.itemName.trim().toLowerCase());
            // Save the cache after recording the buy offer.
            cache.save();
            // A new buy offer changes the GE state — reset the break tier
            // so the next break starts fresh at 50% ETA.
            bot.checkedAtHalfEta = false;
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: buy offer failed: %s', flow.error);
        }
        loop.activeBuyFlow = null;
        loop.phase = 'idle';
        bot.statusText = '';
        // Thinking pause after Confirm — simulates reading the result before
        // the next action. Human data shows 3-8s typical, rare 8-15s outliers.
        const delay = createDelay(5, 50, 20);
        setAction(bot, 'auto_idle', delay);
        debugLog(bot, `Auto: action=auto_idle delay=${fmtDelay(delay)} (buy flow ended)`);
        return true;
    }

    if (loop.activeSellFlow) {
        const flow = loop.activeSellFlow;
        if (flow.status === 'in_progress') {
            // Invalidate widget cache before each flow step — flows need
            // fresh widget state to detect screen transitions.
            invalidateGeWidgetCache();
            debugLog(bot, `Auto: ticking sell flow for ${flow.itemName}`);
            if (flow.tick()) {
                setAction(bot, 'auto_sell', flow.lastDelay);
            }
            return true;
        }
        if (flow.status === 'done') {
            if (bot.logInfoValue) titan.log('[Stark Mercher] Auto: sell offer placed successfully.');
            // Invalidate — a new sell offer changes GE slot state.
            invalidateGeWidgetCache();
            invalidateBooleanStateCache();
            // Invalidate inventory cache — items removed from inventory.
            invalidateInvCache();
            // Mark the sell as confirmed — the offer is now live on the GE.
            // This tells the re-list logic that a future abort+re-list is a
            // genuine "didn't sell" event worthy of a price revision.
            cache.confirmSellOffer(flow.itemName);
            cache.save();
            // A new sell offer changes the GE state — reset the break tier
            // so the next break starts fresh at 50% ETA.
            bot.checkedAtHalfEta = false;
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: sell offer failed: %s', flow.error);
        }
        loop.activeSellFlow = null;
        loop.phase = 'idle';
        bot.statusText = '';
        // Thinking pause after Confirm — simulates reading the result before
        // the next action. Human data shows 3-8s typical, rare 8-15s outliers.
        const delay = createDelay(5, 50, 20);
        setAction(bot, 'auto_idle', delay);
        debugLog(bot, `Auto: action=auto_idle delay=${fmtDelay(delay)} (sell flow ended)`);
        return true;
    }

    if (loop.activeAbortFlow) {
        const flow = loop.activeAbortFlow;
        if (flow.status === 'in_progress') {
            // Safety: skip advancing the abort flow when idle-activity items
            // are in the inventory. The abort flow's step 7 (collect) would
            // click "collect to inventory" into a full inventory, causing
            // "your inventory is too full to take everything". Instead, fall
            // through to the rest of autoLoopTick so the idle activity can
            // re-start (Step 11) and bank the items first. The abort flow
            // stays at its current step and resumes once the inventory is
            // clear. The aborted offer's items are safe in the GE slot.
            if (hasIdleActivityItems(bot)) {
                if (bot.logDebugValue) debugLog(bot, 'Auto: abort flow paused — idle activity items in inventory, waiting for cleanup before collecting');
            } else {
                // Invalidate widget cache before each flow step — flows need
                // fresh widget state to detect screen transitions.
                invalidateGeWidgetCache();
                debugLog(bot, `Auto: ticking abort flow for slot ${flow.slotIndex + 1}`);
                if (flow.tick()) {
                    setAction(bot, 'auto_abort', flow.lastDelay);
                }
                return true;
            }
        }
        if (flow.status === 'done') {
            if (bot.logInfoValue) titan.log('[Stark Mercher] Auto: offer aborted successfully.');
            // Invalidate — aborting an offer changes GE slot state.
            invalidateGeWidgetCache();
            invalidateBooleanStateCache();
            // Invalidate inventory cache — partial fills may have been
            // collected to inventory during the abort flow.
            invalidateInvCache();
            // Clean up cache entry for buy offers with 0% progress — nothing
            // was bought, so there's nothing to collect or sell. The cache
            // entry is stale and would confuse future stale checks.
            // Partial buys (progress > 0) keep their entry — the collected
            // items will be sold in the next loop iteration.
            // IMPORTANT: The progress value in abortSlotInfo was captured at
            // abort trigger time, not at completion time. The buy offer may
            // have partially filled during the abort flow (especially if the
            // first abort attempt failed and had to be retried). Check the
            // inventory to see if any items were actually collected before
            // removing the cache entry — if items are in inventory, keep the
            // entry so buy-limit tracking (totalBought) is preserved.
            if (loop.abortSlotInfo && loop.abortSlotInfo.type === 'buy' && loop.abortSlotInfo.progress <= 0) {
                const itemName = loop.abortSlotInfo.itemName;
                const freezeKey = itemName.trim().toLowerCase();
                const inInventory = findInInv(itemName);
                if (inInventory) {
                    // The buy partially filled during the abort flow — items
                    // were collected to inventory. Keep the cache entry so
                    // buy-limit tracking is preserved. The sell scan will
                    // pick up the items and sell them in the next iteration.
                    debugLog(bot, `Auto: keeping cache entry for ${itemName} (buy offer partially filled during abort — items in inventory, buy-limit tracking preserved)`);
                } else if (loop.pendingReprices.has(freezeKey)) {
                    // This buy was aborted for repricing — keep the cache entry
                    // so the buy scan can pick up the pending reprice and
                    // re-place the offer at the higher price immediately.
                    debugLog(bot, `Auto: keeping cache entry for ${itemName} (pending reprice at ${loop.pendingReprices.get(freezeKey)}gp)`);
                } else {
                    cache.remove(itemName);
                    cache.save();
                    debugLog(bot, `Auto: removed cache entry for ${itemName} (buy offer aborted with 0% progress — nothing to collect)`);
                }
            }
            // Record abort history entry for diagnostics. This captures
            // aborted offers (including 0-fill buys that leave no trace in
            // merch history) so we can diagnose low overnight profit.
            const abortPlayerName = bot.currentPlayerName || '';
            if (loop.abortSlotInfo && abortPlayerName) {
                const info = loop.abortSlotInfo;
                const elapsedMin = (Date.now() - info.placedAt) / 60000;
                // For buy offers, filledQty = items in inventory (if any).
                // For sell offers, filledQty = listed qty - remaining in inv.
                let filledQty = 0;
                if (info.type === 'buy') {
                    const inInv = findInInv(info.itemName);
                    filledQty = inInv ? inInv.quantity : 0;
                } else {
                    // Sell abort: the difference between what was listed and
                    // what's back in inventory is what sold before the abort.
                    const entry = cache.get(info.itemName);
                    const inInv = findInInv(info.itemName);
                    if (entry?.sellQuantity !== undefined && inInv) {
                        filledQty = Math.max(0, entry.sellQuantity - inInv.quantity);
                    }
                }
                recordAbort(bot, abortPlayerName, {
                    item: info.itemName,
                    type: info.type,
                    requestedQty: info.requestedQty,
                    filledQty,
                    reason: info.reason,
                    category: info.category,
                    elapsedMin: Math.round(elapsedMin * 10) / 10,
                    etaMin: info.etaMin,
                    price: info.price,
                    date: new Date().toISOString(),
                });
                debugLog(bot, `Auto: abort history recorded — [${info.category}] ${info.type} ${info.itemName}, requested=${info.requestedQty}, filled=${filledQty}, elapsed=${(elapsedMin).toFixed(1)}min, eta=${info.etaMin}min, reason="${info.reason}"`);
            }
            // Sell-abort count + progressive buy freeze: incremented here on
            // successful abort completion (not at stale-detection time) so a
            // reload interrupting the abort flow does not inflate the count.
            // The countSellAbort flag was set at stale-detection time when the
            // conditions were met (type=sell, non-config abort, <25% progress).
            // The sell count feeds into the same progressive buy freeze and
            // hard-skip mechanism as buy aborts (via the effective count =
            // buy + sell). This prevents re-buying items that consistently
            // fail to sell at the projected price.
            if (loop.abortSlotInfo && loop.abortSlotInfo.countSellAbort) {
                const sellItemName = loop.abortSlotInfo.itemName;
                const newSellCount = incrementItemSellAbortCount(bot, loop.itemAbortCounts, sellItemName);
                const freezeKey = sellItemName.trim().toLowerCase();
                const existingFreeze = loop.buyFreezeUntil.get(freezeKey);
                if (existingFreeze && existingFreeze > Date.now()) {
                    debugLog(bot, `Auto: ${sellItemName} already frozen (expires in ${Math.round((existingFreeze - Date.now()) / 60000)} min) — not re-freezing (sell-abort count ${newSellCount} — ${loop.abortSlotInfo.reason})`);
                } else {
                    const freezeMs = computeProgressiveFreezeMs(loop.itemAbortCounts, sellItemName);
                    const freezeUntil = Date.now() + freezeMs;
                    loop.buyFreezeUntil.set(freezeKey, freezeUntil);
                    loop.buyFreezeSources.set(freezeKey, 'sell-abort');
                    saveBuyFreeze(bot, loop.buyFreezeUntil);
                    const effectiveCount = computeEffectiveAbortCount(loop.itemAbortCounts.get(freezeKey));
                    if (effectiveCount >= ITEM_ABORT_HARD_SKIP_THRESHOLD) {
                        if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: freezing %s from buying for %d min and hard-skipping (sell-abort count %d, effective count %d >= %d — %s)',
                            sellItemName, Math.round(freezeMs / 60000), newSellCount, effectiveCount, ITEM_ABORT_HARD_SKIP_THRESHOLD, loop.abortSlotInfo.reason);
                    } else {
                        if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: freezing %s from buying for %d min (sell-abort count %d, effective count %d — %s)',
                            sellItemName, Math.round(freezeMs / 60000), newSellCount, effectiveCount, loop.abortSlotInfo.reason);
                    }
                }
            }
            // An abort changes the GE state (slot freed, items collected)
            // — reset the break tier so the next break starts fresh.
            bot.checkedAtHalfEta = false;
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: abort failed: %s', flow.error);
        }
        loop.activeAbortFlow = null;
        loop.abortSlotInfo = null;
        loop.phase = 'idle';
        bot.statusText = '';
        // Thinking pause after Collect — simulates reading the result before
        // the next action. Human data shows 3-8s typical, rare 8-15s outliers.
        const delay = createDelay(5, 50, 20);
        setAction(bot, 'auto_idle', delay);
        debugLog(bot, `Auto: action=auto_idle delay=${fmtDelay(delay)} (abort flow ended)`);
        return true;
    }

    // --- Step 1: Check if GE is open ---
    if (!isGeOpen()) {
        // GE not open — try to open it.
        if (!nearGrandExchange()) {
            debugLog(bot, 'Auto: GE not open and not near GE — walking to GE');
            bot.statusText = '[WALK] [Grand Exchange]';
            walkToGe();
            const delay = createDelay(5, 30, 8);
            setAction(bot, 'auto_walk', delay);
            debugLog(bot, `Auto: action=auto_walk delay=${fmtDelay(delay)}`);
            return true;
        }
        // Near GE — try to open it via clerk or booth.
        // Use a longer delay (8-15 ticks / 4.8-9s) after clicking so the
        // player has time to walk to the booth and the interface has time
        // to open. Without this, the loop re-clicks every 1-4 ticks,
        // sending the player running around the GE area.
        //
        // Wall-clock cooldown: the SDK can fire a burst of ticks immediately
        // after login (the tick counter advances several ticks in
        // milliseconds), causing the tick-based action delay to elapse
        // instantly. This cooldown prevents a second GE-open click from
        // being dispatched before the first one has had time to take effect.
        const geOpenCooldownRemaining = GE_OPEN_WALL_CLOCK_COOLDOWN_MS - (Date.now() - loop.lastGeOpenDispatchMs);
        if (geOpenCooldownRemaining > 0) {
            debugLog(bot, `Auto: GE not open, near GE — waiting ${(geOpenCooldownRemaining / 1000).toFixed(1)}s wall-clock cooldown before re-clicking`);
            bot.statusText = '[OPEN] [Grand Exchange]';
            const delay = createDelay(3, 8, 6);
            setAction(bot, 'auto_open_ge', delay);
            debugLog(bot, `Auto: action=auto_open_ge delay=${fmtDelay(delay)} (wall-clock cooldown)`);
            return true;
        }
        debugLog(bot, 'Auto: GE not open, near GE — opening via clerk/booth');
        bot.statusText = '[OPEN] [Grand Exchange]';
        if (openGe()) {
            // Invalidate — opening GE changes widget state.
            invalidateGeWidgetCache();
            invalidateBooleanStateCache();
            loop.lastGeOpenDispatchMs = Date.now();
            const failures = recordFailure(loop, 'geOpen');
            debugLog(bot, `Auto: GE open click dispatched (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
            if (checkFailureTerminate(bot, loop, 'geOpen', 'Opening Grand Exchange')) return true;
            const delay = createDelay(6, 15, 3);
            setAction(bot, 'auto_open_ge', delay);
            debugLog(bot, `Auto: action=auto_open_ge delay=${fmtDelay(delay)} (waiting for GE to open)`);
        } else {
            // Couldn't find clerk or booth — wait and retry.
            const failures = recordFailure(loop, 'geOpen');
            debugLog(bot, `Auto: no clerk/booth found — waiting (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
            if (checkFailureTerminate(bot, loop, 'geOpen', 'Finding G.E clerk/booth')) return true;
            bot.statusText = '[SEARCH] [G.E Clerk]';
            const delay = createDelay(5, 50, 8);
            setAction(bot, 'auto_wait', delay);
            debugLog(bot, `Auto: action=auto_wait delay=${fmtDelay(delay)} (no clerk/booth)`);
        }
        return true;
    }
    // GE is open — reset the failure counter.
    resetFailure(loop, 'geOpen');

    // --- Step 1b: Close GE sub-screens ---
    // If the offer config screen, search prompt, or price prompt is open
    // (e.g. after a script reload mid-flow, or a misclick), close it with
    // Escape to return to the main GE view. Without this, slot clicks would
    // land on the sub-screen instead of the intended slot.
    if (isOfferConfigOpen() || isSearchPromptShown() || isPricePromptShown()) {
        const failures = recordFailure(loop, 'geSubScreen');
        debugLog(bot, `Auto: GE sub-screen open (offer config / search / price prompt) — closing with Escape (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (checkFailureTerminate(bot, loop, 'geSubScreen', 'Closing GE sub-screen')) return true;
        bot.statusText = '[CLOSE] [GE Sub-screen]';
        sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Escape), { reason: 'close GE sub-screen' });
        // Invalidate — closing sub-screen changes widget state.
        invalidateGeWidgetCache();
        invalidateBooleanStateCache();
        const delay = createDelay(2, 30, 8);
        setAction(bot, 'auto_close_ge_screen', delay);
        return true;
    }
    // No sub-screen open — reset the failure counter.
    resetFailure(loop, 'geSubScreen');

    // --- Step 2: Get all slot states ---
    const audit = auditGeState();
    const slots = audit.slots;
    const slotSummary = slots.map((s, i) => {
        if (s.type === 'empty') return `${i + 1}:empty`;
        return `${i + 1}:${s.type}:${s.status}:${s.itemName ?? '?'}:${Math.round(s.progress * 100)}%`;
    }).join(' | ');
    if (verboseIdleDiag) debugLog(bot, `Auto: GE open — slots: ${slotSummary}`);

    // --- Step 2b: One-time cache reconciliation (startup) ---
    // On the first GE-open tick after script start, remove orphaned cache
    // entries — items that are not in any GE slot, not in inventory, and not
    // referenced by an active flow. These are leftover entries from completed
    // merches whose cache.remove() didn't run before the script restarted.
    //
    // Guard: if any slot has type 'unknown', the GE widget hasn't fully
    // loaded the slot contents yet. Unknown slots have null itemName, so
    // they won't be in slotItemNames — running reconciliation now would
    // incorrectly remove active cache entries as orphaned. Defer to the
    // next tick (don't set cacheReconciled) so the guard retries.
    if (!loop.cacheReconciled) {
        if (slots.some(s => s.type === 'unknown')) {
            debugLog(bot, 'Auto: cache reconciliation deferred — GE slots not yet readable');
        } else {
            loop.cacheReconciled = true;
            const slotItemNames = new Set(slots
                .filter(s => s.itemName)
                .map(s => s.itemName!.trim().toLowerCase()));
            const removed: string[] = [];
            for (const cacheKey of cache.getAllItemNames()) {
                const lower = cacheKey.trim().toLowerCase();
                if (slotItemNames.has(lower)) continue; // still in a GE slot
                // Check inventory — item may have been collected and not yet sold
                if (findInInv(cacheKey)) continue;
                // Preserve entries with active buy-limit tracking (totalBought
                // > 0 within the 4-hour window) even if not in a slot or
                // inventory — the buy-limit data must persist across cycles.
                const entry = cache.get(cacheKey);
                if (entry && entry.totalBought && entry.totalBought > 0) {
                    const windowStart = entry.firstBoughtAt ?? entry.limitReachedAt ?? entry.offerPlacedAt;
                    if (Date.now() - windowStart < OfferCacheManager.BUY_LIMIT_COOLDOWN_MS) {
                        continue; // buy-limit window still active — keep entry
                    }
                }
                // Preserve entries with pending sell profit — the completed-sell
                // sweep (Step 3) needs to record the profit before this entry can
                // be safely removed. Without this, a hot-reload between collecting
                // a completed sell and the sweep running loses the profit
                // permanently (the item is no longer in any slot or inventory, so
                // reconciliation would otherwise treat it as orphaned).
                if (entry && entry.mode === 'sell' && entry.sellQuantity !== undefined && entry.sellQuantity > 0) {
                    continue; // pending sell profit — let the sweep handle it
                }
                // Orphaned — not in any slot or inventory, no active buy-limit
                cache.remove(cacheKey);
                removed.push(cacheKey);
            }
            if (removed.length > 0) {
                cache.save();
                if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: cache reconciliation removed %d orphaned entr%s: %s',
                    removed.length, removed.length === 1 ? 'y' : 'ies', removed.join(', '));
            } else {
                debugLog(bot, 'Auto: cache reconciliation — no orphaned entries');
            }
        }
    }

    // --- Step 2c: Reverse reconciliation (reconstruct missing cache entries) ---
    // After a client restart that loses the hidden cache setting, active GE
    // offers survive on the server but have no cache entry. Without
    // reconstruction, the staleness checks bail out (they need offerPlacedAt),
    // completed sells lose their profit, and stuck offers sit forever.
    // This step iterates over occupied slots and reconstructs cache entries
    // from merchableItems.json / priceHistory.json so the bot can manage them.
    //
    // Guard: same 'unknown' slot check as forward reconciliation. Unknown
    // slots can't be reconstructed (no itemName, no type, no priceText).
    // Defer to the next tick so both reconciliation steps run together
    // once the GE widget is fully readable.
    if (!loop.cacheReconstructed) {
        if (slots.some(s => s.type === 'unknown')) {
            debugLog(bot, 'Auto: reverse reconstruction deferred — GE slots not yet readable');
        } else {
            loop.cacheReconstructed = true;
            const reconstructed: string[] = [];
            const skipped: string[] = [];
            const refreshed: string[] = [];
            const modeFixed: string[] = [];
            for (const slot of slots) {
                if (slot.type === 'empty' || !slot.itemName) continue;
            const lower = slot.itemName.trim().toLowerCase();
            const existing = cache.get(slot.itemName);
            if (existing) {
                // Entry already exists. If it's an unconfirmed sell offer
                // but the offer is clearly live on the GE (it's in a slot),
                // the sell flow completed but confirmSellOffer was never
                // called (e.g. hot-reload between flow completion and
                // confirmation, or the flow completed but the script
                // restarted before the cache saved). Refresh the placement
                // timestamp and mark as confirmed so stale checks measure
                // from now (the restart time) instead of the original
                // recordSellOffer time (which was before the flow started).
                if (slot.type === 'sell' && existing.mode === 'sell' && !existing.sellConfirmed) {
                    existing.sellConfirmed = true;
                    existing.offerPlacedAt = Date.now();
                    cache.markDirty();
                    refreshed.push(slot.itemName);
                }
                // Mode mismatch: the GE slot type differs from the cache
                // entry mode. This happens when a plugin reload (e.g. npm
                // run build) causes the hidden setting to revert to a stale
                // value — the in-memory sell-mode update was lost, but
                // the GE still has the live offer. Without correction, the stale checker uses wrong-mode data (wrong
                // sell price, wrong sell ETA, wrong elapsed time from the
                // original buy placement) and may prematurely abort the
                // offer. Parse the GE slot's actual price and fix the mode.
                if ((slot.type === 'buy' || slot.type === 'sell') && slot.type !== existing.mode) {
                    let mismatchSlotPrice: number | undefined;
                    if (slot.priceText) {
                        const parsed = parseInt(slot.priceText.replace(/[^0-9]/g, ''), 10);
                        if (Number.isFinite(parsed) && parsed > 0) mismatchSlotPrice = parsed;
                    }
                    if (cache.fixModeMismatch(slot.itemName, slot.type, slot.itemQuantity, mismatchSlotPrice)) {
                        modeFixed.push(`${slot.itemName} (${existing.mode}->${slot.type})`);
                    }
                }
                continue;
            }
            // Only reconstruct active or completed/aborted offers with a
            // known type. Skip 'unknown' status slots (can't determine type).
            if (slot.type !== 'buy' && slot.type !== 'sell') continue;
            // Parse the per-unit offer price from the GE slot's priceText
            // (e.g. "2,069 coins"). This is the actual price the bot typed
            // when placing the offer — using it instead of the 1h market
            // average prevents false loss/profit recording after cache loss.
            let slotPrice: number | undefined;
            if (slot.priceText) {
                const parsed = parseInt(slot.priceText.replace(/[^0-9]/g, ''), 10);
                if (Number.isFinite(parsed) && parsed > 0) slotPrice = parsed;
            }
            const created = cache.reconstructEntry(
                slot.itemName,
                slot.type,
                slot.itemQuantity,
                slotPrice,
            );
            if (created) {
                reconstructed.push(`${slot.itemName} (${slot.type})`);
            } else {
                skipped.push(slot.itemName);
            }
        }
        if (reconstructed.length > 0 || refreshed.length > 0 || modeFixed.length > 0) {
            cache.save();
        }
        if (reconstructed.length > 0) {
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: reverse reconciliation reconstructed %d entr%s: %s',
                reconstructed.length, reconstructed.length === 1 ? 'y' : 'ies', reconstructed.join(', '));
        } else {
            debugLog(bot, 'Auto: reverse reconciliation — no missing entries');
        }
        if (refreshed.length > 0) {
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: reverse reconciliation refreshed %d unconfirmed sell entr%s (offer live on GE, placement time reset): %s',
                refreshed.length, refreshed.length === 1 ? 'y' : 'ies', refreshed.join(', '));
        }
        if (modeFixed.length > 0) {
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: reverse reconciliation fixed %d mode mismatch%s (setting reverted after reload — restored from live GE slot): %s',
                modeFixed.length, modeFixed.length === 1 ? '' : 'es', modeFixed.join(', '));
        }
        if (skipped.length > 0) {
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: reverse reconciliation skipped %d slot(s) (no price data): %s',
                skipped.length, skipped.join(', '));
        }
        }
    }

    // --- Step 3: Completed-sell sweep + Collect ---
    // First, sweep for 100% completed sells. After a sell offer completes
    // fully and is collected, the item is no longer in any GE slot or
    // inventory. The cache entry still has mode='sell' and sellQuantity > 0.
    // We record the profit and clear sellQuantity to prevent double-counting.
    // Fast-path: skip the entire sweep if no cache entries have active sell
    // state. This avoids per-tick inventory scans for every cache entry when
    // no sells are in flight (the common case when all slots are buys or
    // idle).
    //
    // PRE-COLLECT RECORDING: If a sell slot is completed_or_aborted (100%
    // progress, type=sell) and the bot did NOT initiate an abort for it
    // (no activeAbortFlow, no abortSlotInfo), the profit is recorded
    // IMMEDIATELY — before the collect click. This eliminates the
    // vulnerability window where a hot-reload between the collect and the
    // next tick's sweep could lose the profit permanently (the cache
    // setting may revert to a stale pre-sell state, or fixModeMismatch
    // may clear sell fields when a new buy for the same item is already
    // live on the GE). Reconstructed entries (from cache loss after a
    // client restart) are excluded — we can't distinguish a natural
    // completion from an interrupted abort from a previous session, so
    // those still wait for the collect + inInv check.
    const playerName = bot.currentPlayerName || '';

    // Helper: record completed-sell profit for a cache entry. Captures all
    // profit/history data, clears sell fields, saves the cache, THEN writes
    // profit/history. Returns true if profit was recorded.
    const recordCompletedSellProfit = (cacheKey: string): boolean => {
        const entry = cache.get(cacheKey);
        if (!entry || entry.mode !== 'sell' || entry.sellQuantity === undefined || entry.sellQuantity <= 0) return false;
        // CAPTURE all profit/history data from the cache entry BEFORE clearing
        // and saving. The cache must be persisted (with sell fields cleared)
        // BEFORE we write to dailyProfit/merchHistory. This prevents double-
        // counting on hot-reload: if we crash after profit is written but
        // before the cache is saved, the sweep would re-trigger and record
        // the profit again. By saving the cache first, a crash between the
        // cache save and the profit write loses one tracking entry (the GP
        // is still correct in the coin pouch) — far better than double-counting.
        const soldQty = entry.sellQuantity;
        // Record the final partial sale batch so we can compute the merch
        // history summary from all partial sales (including this one).
        cache.recordPartialSale(cacheKey, entry.sellPrice, soldQty);
        const partials = cache.getPartialSales(cacheKey);
        // Compute the weighted-average profit across ALL partial sale
        // batches (including the final one just recorded). This ensures
        // the daily profit and merch history use the SAME profit figure.
        // The previous approach computed daily profit from entry.sellPrice
        // (the current/last sell price) × soldQty, which diverged from the
        // merch history's weighted-average profit when there were price
        // revisions with partial fills at different prices (e.g. some units
        // sold at 2294, then the price revised to 2279 and the rest sold).
        // Using the weighted average for both eliminates the discrepancy.
        const totalQty = partials.reduce((s, p) => s + p.qty, 0);
        const weightedSum = partials.reduce((s, p) => s + p.price * p.qty, 0);
        const avgSold = totalQty > 0 ? Math.round(weightedSum / totalQty) : 0;
        const netAvgSold = getNetSellPrice(avgSold);
        const profit = (netAvgSold - entry.buyPrice) * totalQty;
        const taxPerItem = getGeTax(avgSold);
        const profitPerItem = netAvgSold - entry.buyPrice;
        // Capture merch history data from the entry BEFORE clearing.
        let merchEntry: Omit<MerchHistoryEntry, 'profit'> | null = null;
        let merchProfit = 0;
        if (totalQty > 0 && playerName) {
            merchProfit = profit; // same as daily profit — single source of truth
            const revisions = entry.revisedPrices.length > 0 ? entry.revisedPrices.length - 1 : 0;
            const lastSale = partials[partials.length - 1];
            // Diagnostic fields for overnight profit analysis.
            // requestedBuyQty = totalBought (what the bot actually bought,
            //   which may be less than the original buy offer requested if
            //   the buy was aborted with a partial fill).
            // actualBoughtQty = totalBought (same — what was bought).
            // sellElapsedMin = time from offer placement (or last revision)
            //   to now. This is the sell offer duration, not the full cycle.
            // buyEtaMin / buyAbortReason are not available at this point
            //   because the buy offer completed naturally (the cache entry
            //   transitioned from buy → sell). The abort history captures
            //   aborted buys separately.
            const actualBoughtQty = entry.totalBought ?? totalQty;
            const sellElapsedMin = (Date.now() - entry.offerPlacedAt) / 60000;
            merchEntry = {
                item: cacheKey,
                qty: totalQty,
                date: new Date(lastSale.timestamp).toISOString(),
                buy: entry.buyPrice,
                avgSold,
                revisions,
                requestedBuyQty: actualBoughtQty,
                actualBoughtQty,
                buyAbortReason: null,
                buyElapsedMin: undefined,
                buyEtaMin: entry.purchaseEtaMinutes,
                revisionPrices: [...entry.revisedPrices],
                sellElapsedMin: Math.round(sellElapsedMin * 10) / 10,
            };
        }
        // Now clear sell fields and SAVE the cache BEFORE writing profit/history.
        cache.clearPartialSales(cacheKey);
        cache.clearSellQuantity(cacheKey);
        // Do NOT remove the cache entry — preserve buy-limit tracking
        // (totalBought, firstBoughtAt, limitReachedAt) so the bot knows how
        // much of the item's 4-hour buy limit has been consumed. Only clear
        // sell-specific fields and reset mode to 'idle'.
        cache.clearSellFields(cacheKey);
        cache.save();
        // Now safe to write profit and history — if we crash here, the cache
        // already shows the sell as cleared so the sweep won't re-trigger.
        // Skip recording losses from entries with a reconstructed buy price —
        // the buy price came from priceHistory's 1h average or merchableItems
        // (the actual cache was lost), which can differ from the real buy
        // price by 2-3%. For thin-margin items, this error can flip a
        // profitable sell into an apparent loss (e.g. Toadflax: reconstructed
        // buy=2207 vs actual buy=2160, sell=2224 → phantom -16,956gp loss +
        // 2h buy freeze on a profitable item). Profits are still recorded
        // (conservative — better to under-report losses than over-report
        // them). The loss-history cooldown scans merch history losses, so
        // skipping the recording also prevents the phantom cooldown.
        //
        // Uses `reconstructedBuyPrice` (not `reconstructed`) because the
        // `reconstructed` flag is cleared on re-list (recordSellOffer) to
        // prevent infinite abort cycles. `reconstructedBuyPrice` survives
        // re-list and is only cleared when the bot places a new buy offer
        // with a known price (recordBuyOffer).
        const isReconLoss = entry.reconstructedBuyPrice && merchProfit < 0;
        if (profit !== 0 && playerName && !isReconLoss) {
            addDailyProfit(bot, playerName, profit);
            debugLog(bot, `Auto: daily profit += ${profit}gp (${totalQty}x ${cacheKey} @ ${profitPerItem}gp/item net — avgSold=${avgSold}gp, tax=${taxPerItem}gp, buy=${entry.buyPrice}gp — 100% completed sell)`);
        }
        if (merchEntry && playerName && merchProfit !== 0 && !isReconLoss) {
            recordMerchCycle(bot, playerName, merchEntry, merchProfit);
            debugLog(bot, `Auto: merch history recorded — ${cacheKey} ${merchEntry.qty}x, avgSold=${merchEntry.avgSold}gp (net=${getNetSellPrice(merchEntry.avgSold)}gp after tax), buy=${entry.buyPrice}gp, profit=${merchProfit}gp, revisions=${merchEntry.revisions}, sellElapsed=${merchEntry.sellElapsedMin ?? '?'}min, revisionPrices=[${merchEntry.revisionPrices?.join(',') ?? ''}]`);
        }
        if (isReconLoss) {
            debugLog(bot, `Auto: skipping reconstructed loss recording — ${cacheKey} ${totalQty}x, buy=${entry.buyPrice}gp (reconstructedBuyPrice, uncertain), avgSold=${avgSold}gp, apparent loss=${merchProfit}gp — buy price is unreliable after cache loss`);
        }
        debugLog(bot, `Auto: completed-sell sweep — ${cacheKey} sold 100% (${totalQty}x), profit recorded, buy-limit data preserved`);
        // A sell cycle completing changes GE state (slot freed, items sold)
        // — reset the break tier so the next break starts fresh.
        bot.checkedAtHalfEta = false;
        return true;
    };

    if (cache.hasActiveSellEntries()) {
    for (const cacheKey of cache.getAllItemNames()) {
        const entry = cache.get(cacheKey);
        if (!entry || entry.mode !== 'sell' || entry.sellQuantity === undefined || entry.sellQuantity <= 0) continue;
        // Is this item still in any GE slot? (active or completed/aborted)
        const matchingSlot = slots.find(s => s.itemName && s.itemName.trim().toLowerCase() === cacheKey.trim().toLowerCase());
        if (matchingSlot) {
            // Item is still in a GE slot. If the slot is a completed/aborted
            // SELL (100% progress), record the profit NOW — before the
            // collect click. This prevents profit loss if a hot-reload
            // occurs between the collect and the next tick's sweep.
            //
            // Safety guards:
            //   1. No active abort flow and no recently-completed abort
            //      (abortSlotInfo) — if the bot initiated an abort, the
            //      AbortOfferFlow handles cache updates and the sell scan
            //      handles re-listing with partial profit.
            //   2. Entry is NOT reconstructed — reconstructed entries may
            //      be interrupted aborts from a previous session that we
            //      can't distinguish from natural completions. Those wait
            //      for the collect + inInv check (post-collect path below).
            //   3. Entry is sell-confirmed — the sell was placed by the bot
            //      and is live on the GE (not a stale/unconfirmed entry).
            if (matchingSlot.type === 'sell'
                && matchingSlot.status === 'completed_or_aborted'
                && !loop.activeAbortFlow
                && !loop.abortSlotInfo
                && !entry.reconstructed
                && entry.sellConfirmed) {
                debugLog(bot, `Auto: completed-sell pre-collect — ${cacheKey} slot is completed_or_aborted sell (100%), recording profit before collect`);
                if (recordCompletedSellProfit(cacheKey)) {
                    updateProfitDisplay(bot);
                }
            }
            continue; // still in a slot — profit recorded or not yet completed
        }
        // Is this item in inventory? (returned after an abort — profit
        // will be recorded at re-list time in Step 5)
        const inInv = findInInv(cacheKey);
        if (inInv) continue; // in inventory — abort case, handled at re-list
        // Item is not in any slot or inventory → sell completed 100% and
        // already collected (post-collect path). Record profit now.
        if (recordCompletedSellProfit(cacheKey)) {
            updateProfitDisplay(bot);
        }
    }
    } // end hasActiveSellEntries fast-path

    if (hasCompletedOrAbortedSlot(slots) && !hasIdleActivityItems(bot)) {
        // Completed/aborted slot detected — click collect to inventory.
        // Safety: skip collecting if idle activity items are in the inventory
        // (the inventory may be full of chocolate bars/dust, leaving no room
        // to collect). The idle activity cleans up before resuming GE mode.
        // Profit for completed sells is recorded by the sweep above (for
        // 100% completed) or at re-list time in Step 5 (for partial aborts).
        //
        // Wall-clock cooldown: same rationale as the GE-open cooldown — tick
        // bursts after login can cause the tick-based delay to elapse
        // instantly, leading to a duplicate collect click that the game
        // responds to with "You have nothing to collect." and a Cancel opcode.
        const collectCooldownRemaining = COLLECT_WALL_CLOCK_COOLDOWN_MS - (Date.now() - loop.lastCollectDispatchMs);
        if (collectCooldownRemaining > 0) {
            debugLog(bot, `Auto: completed/aborted offer detected — waiting ${(collectCooldownRemaining / 1000).toFixed(1)}s wall-clock cooldown before re-collecting`);
            bot.statusText = '[COLLECT] [G.E]';
            const delay = createDelay(3, 8, 6);
            setAction(bot, 'auto_collect', delay);
            debugLog(bot, `Auto: action=auto_collect delay=${fmtDelay(delay)} (wall-clock cooldown)`);
            return true;
        }
        const failures = recordFailure(loop, 'collect');
        debugLog(bot, `Auto: completed/aborted offer detected — collecting to inventory (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (checkFailureTerminate(bot, loop, 'collect', 'Collecting completed/aborted offer')) return true;
        bot.statusText = '[COLLECT] [G.E]';
        if (clickCollectToInventory()) {
            // Invalidate — collecting changes GE slot state and inventory.
            invalidateGeWidgetCache();
            invalidateBooleanStateCache();
            invalidateInvCache();
            loop.lastCollectDispatchMs = Date.now();
            // Collecting a completed/aborted offer changes GE state —
            // reset the break tier so the next break starts fresh.
            bot.checkedAtHalfEta = false;
            // Thinking pause after Collect — simulates reading the result
            // before the next action. Human data shows 3-8s typical, rare
            // 8-15s outliers.
            const delay = createDelay(5, 50, 20);
            setAction(bot, 'auto_collect', delay);
            debugLog(bot, `Auto: action=auto_collect delay=${fmtDelay(delay)}`);
        } else {
            // Collect widget not clickable — wait.
            const delay = createDelay(2, 40, 8);
            setAction(bot, 'auto_wait', delay);
            debugLog(bot, `Auto: action=auto_wait delay=${fmtDelay(delay)} (collect not clickable)`);
        }
        return true;
    }
    // No completed/aborted slots — reset the collect failure counter.
    resetFailure(loop, 'collect');

    // --- Step 4: Stale offers flow ---
    // Check each occupied slot for stale conditions.
    // Safety: skip stale-offer aborting when idle-activity items are in the
    // inventory. The abort flow's step 7 (collect) would click "collect to
    // inventory" into a full inventory, causing "your inventory is too full
    // to take everything". The idle activity cleans up (banks items) before
    // resuming GE mode, at which point stale checks resume.
    if (hasIdleActivityItems(bot)) {
        if (verboseIdleDiag) debugLog(bot, 'Auto: skipping stale-offer check — idle activity items in inventory, waiting for cleanup');
        // Fall through to Step 5 (sell scan) and Step 11 (idle activity start)
        // — the idle activity will bank the items and resume GE operations.
    } else {
    if (verboseIdleDiag) debugLog(bot, 'Auto: checking for stale offers');
    bot.statusText = '[CHECK] [Stale Offers]';
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot.type === 'empty' || slot.status !== 'active') continue;

        // Update no-progress tracking for partial-fill buy offers before
        // the stale check. When the live slot progress differs from the
        // cached lastBuyProgress, record the new progress and timestamp.
        // This feeds the no-progress abort rule in isBuyOfferStale.
        if (slot.type === 'buy' && slot.itemName && slot.progress > 0 && slot.progress < 1) {
            const entry = cache.get(slot.itemName);
            if (entry) {
                const lastProgress = entry.lastBuyProgress ?? 0;
                // Use a small epsilon to avoid float jitter causing spurious
                // updates every tick (progress is read from widget bars and
                // can fluctuate by tiny amounts).
                if (Math.abs(slot.progress - lastProgress) > 0.005) {
                    entry.lastBuyProgress = slot.progress;
                    entry.lastBuyProgressAt = Date.now();
                    cache.markDirty();
                }
            }
        }

        // Update sell progress tracking for the progress-since-revision
        // extension in isSellOfferStale. When the live slot progress differs
        // from the cached lastSellProgress, record the new progress and
        // timestamp. This lets the stale checker detect offers that are
        // actively filling but haven't completed within the original ETA,
        // and extend their stale window instead of prematurely revising.
        if (slot.type === 'sell' && slot.itemName && slot.progress > 0 && slot.progress < 1) {
            const entry = cache.get(slot.itemName);
            if (entry) {
                const lastProgress = entry.lastSellProgress ?? 0;
                if (Math.abs(slot.progress - lastProgress) > 0.005) {
                    entry.lastSellProgress = slot.progress;
                    entry.lastSellProgressAt = Date.now();
                    cache.markDirty();
                }
            }
        }

        let sellReason = slot.type === 'sell' ? isSellOfferStale(slot, cache) : null;
        let buyReason = slot.type === 'buy' ? isBuyOfferStale(slot, cache) : null;

        // --- Idle-activity ingredient buy protection ---
        // When an idle activity is selected, the user may manually place buy
        // offers for the activity's ingredients (e.g. volcanic ash, chocolate
        // bars, desert goat horns). These are NOT merch buy offers — they're
        // manual purchases for the idle activity. Never abort them as stale.
        // The slot is already occupied by an active buy, so the buy scan
        // won't try to use it for a new merch offer.
        if (buyReason && slot.itemName) {
            const ingredientNames = getIdleActivityIngredientNames(bot);
            if (ingredientNames.has(slot.itemName.trim().toLowerCase())) {
                if (verboseIdleDiag) debugLog(bot, `Auto: skipping stale check for ${slot.itemName} in slot ${i + 1} — idle activity ingredient (manual buy)`);
                buyReason = null;
            }
        }

        // --- Idle-activity result product sell protection ---
        // When an idle activity is selected, the user may manually place sell
        // offers for the activity's output (e.g. goat horn dust, ultracompost,
        // chocolate dust). These are NOT merch sell offers — they're manual
        // sales of the activity's output. Never abort them as stale.
        if (sellReason && slot.itemName) {
            const resultProductNames = getIdleActivityResultProductNames(bot);
            if (resultProductNames.has(slot.itemName.trim().toLowerCase())) {
                if (verboseIdleDiag) debugLog(bot, `Auto: skipping stale check for ${slot.itemName} in slot ${i + 1} — idle activity result product (manual sell)`);
                sellReason = null;
            }
        }

        let isF2pSwapOut = false;

        // --- F2P 45-min minimum slot occupation with swap-out exception ---
        // F2P mode uses lowball-style 1gp margins with only 3 GE slots, so
        // offers need more time to fill. Block ETA-based buy aborts until the
        // offer has occupied the slot for at least 45 minutes — UNLESS a
        // higher-ranked F2P item is available to swap in (not in any slot,
        // not frozen, not buy-limited). In that case, allow the early abort
        // so the slot can be more productive.
        if (buyReason && bot.autoModeValue === 3 && slot.itemName) {
            const entry = cache.get(slot.itemName);
            const elapsedMin = entry ? (Date.now() - entry.offerPlacedAt) / 60000 : 0;
            if (elapsedMin < F2P_MIN_SLOT_OCCUPATION_MIN) {
                // Under the 45-min minimum. Check if a higher-ranked F2P item
                // is available to swap in. Reuse the buy-scan infrastructure:
                // build the exclusion sets and call getFirstUnoccupiedMerchableItem.
                if (!isMerchableDataValid().valid) {
                    // Stale data — can't safely pick a swap candidate. Wait.
                    buyReason = null;
                } else {
                    const swapOccupiedNames = getOccupiedItemNames(slots);
                    const swapCoinCount = countCoinsInInv();
                    const swapBuyLimitedNames = cache.getBuyLimitedItemNames();
                    const swapFrozenNames = new Set<string>();
                    const swapNow = Date.now();
                    for (const [fname, funtil] of loop.buyFreezeUntil) {
                        if (swapNow < funtil) swapFrozenNames.add(fname);
                    }
                    const swapSlotBudget = Math.min(swapCoinCount, Math.floor(swapCoinCount * F2P_SLOT_BUDGET_MULTIPLIER));
                    const swapCandidate = getFirstUnoccupiedMerchableItem(
                        swapOccupiedNames, swapSlotBudget, swapBuyLimitedNames, isMembersWorld(), swapFrozenNames, 'non-lowball',
                    );
                    if (swapCandidate) {
                        // Better item available — allow the early abort (swap-out).
                        isF2pSwapOut = true;
                        debugLog(bot, `Auto: F2P swap-out — ${slot.itemName} in slot ${i + 1} (${elapsedMin.toFixed(1)}min < ${F2P_MIN_SLOT_OCCUPATION_MIN}min min, ${buyReason}) — replacing with higher-ranked ${swapCandidate.item.itemName} (profit/hr ${Math.round(swapCandidate.runtimeProfitPerSlotHour)}gp)`);
                    } else {
                        // No better item — wait for the 45-min minimum.
                        buyReason = null;
                    }
                }
            }
        }

        if (sellReason || buyReason) {
            const reason = sellReason ?? buyReason ?? '';
            debugLog(bot, `Auto: aborting stale offer in slot ${i + 1} (${slot.type} ${slot.itemName} — ${reason})`);
            bot.statusText = `[ABORT] [${slot.itemName ?? 'unknown'}] [Slot ${i + 1}]`;
            // If this is a buy offer, freeze the item so we don't immediately
            // re-list it at the same price. The freeze lasts 5 minutes —
            // long enough for market conditions to shift.
            // Skip the freeze if:
            //   - the item is already frozen (e.g. a previous abort attempt
            //     failed and we're retrying — don't extend the freeze timer)
            //   - the abort is config-driven (item removed from
            //     merchableItems.json) — the item wasn't stale, just removed
            //     from the list, so re-buying it immediately is fine if it's
            //     added back.
            //   - the abort is an F2P swap-out (the item is being replaced
            //     by a higher-ranked item, not abandoned — don't penalize it).
            const isConfigAborrt = reason.startsWith('no longer in merchableItems.json');
            if (slot.type === 'buy' && slot.itemName && !isConfigAborrt && !isF2pSwapOut) {
                const freezeKey = slot.itemName.trim().toLowerCase();
                // Check if this high-profit stalled buy qualifies for repricing
                // instead of freezing. Repricing aborts the offer and immediately
                // re-places at a higher price, without freezing the item.
                const currentRepriceCount = loop.buyRepriceCounts.get(freezeKey) ?? 0;
                const repriceBuyPrice = computeBuyReprice(slot, cache, currentRepriceCount);
                if (repriceBuyPrice !== null) {
                    // Reprice: set pending reprice, increment count, skip freeze.
                    // The abort count is NOT incremented — reprices are retries,
                    // not give-ups. The reprice count is the separate limiter.
                    loop.pendingReprices.set(freezeKey, repriceBuyPrice);
                    loop.buyRepriceCounts.set(freezeKey, currentRepriceCount + 1);
                    if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: repricing %s — aborting buy at %dgp, will re-place at %dgp (reprice %d/%d — %s)',
                        slot.itemName, cache.get(slot.itemName)?.buyPrice ?? 0, repriceBuyPrice,
                        currentRepriceCount + 1, BUY_REPRICE_MAX_COUNT, reason);
                } else {
                    // Reset reprice state — this abort is a normal give-up, so
                    // the item starts fresh after the freeze expires.
                    loop.pendingReprices.delete(freezeKey);
                    loop.buyRepriceCounts.delete(freezeKey);
                const existingFreeze = loop.buyFreezeUntil.get(freezeKey);
                if (existingFreeze && existingFreeze > Date.now()) {
                    debugLog(bot, `Auto: ${slot.itemName} already frozen (expires in ${Math.round((existingFreeze - Date.now()) / 60000)} min) — not re-freezing`);
                } else {
                    // Increment the abort count and use a progressive freeze
                    // duration. Items that repeatedly fail to fill get longer
                    // freezes, and are eventually hard-skipped entirely.
                    const newCount = incrementItemAbortCount(bot, loop.itemAbortCounts, slot.itemName);
                    const freezeMs = computeProgressiveFreezeMs(loop.itemAbortCounts, slot.itemName);
                    const freezeUntil = Date.now() + freezeMs;
                    loop.buyFreezeUntil.set(freezeKey, freezeUntil);
                    loop.buyFreezeSources.set(freezeKey, 'buy-abort');
                    saveBuyFreeze(bot, loop.buyFreezeUntil);
                    const effectiveCount = computeEffectiveAbortCount(loop.itemAbortCounts.get(freezeKey));
                    if (effectiveCount >= ITEM_ABORT_HARD_SKIP_THRESHOLD) {
                        if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: freezing %s from buying for %d min and hard-skipping (buy abort %d, effective count %d >= %d — %s)',
                            slot.itemName, Math.round(freezeMs / 60000), newCount, effectiveCount, ITEM_ABORT_HARD_SKIP_THRESHOLD, reason);
                    } else {
                        if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: freezing %s from buying for %d min (buy abort %d, effective count %d — %s)',
                            slot.itemName, Math.round(freezeMs / 60000), newCount, effectiveCount, reason);
                    }
                }
                } // end else (not repricing — normal freeze path)
            }
            // Sell abort count + freeze: when a sell offer is aborted with
            // <25% progress, the sell-abort count is incremented and a
            // progressive buy freeze is applied on abort COMPLETION (not here
            // at detection time). The countSellAbort flag is set here and the
            // actual increment + freeze is deferred to the abort-completion
            // path (flow.status === 'done'). This prevents duplicate counting
            // when a reload interrupts the abort flow — the in-memory
            // abortSlotInfo is lost on reload, so the count is not incremented
            // and no freeze is applied; the next stale detection creates a
            // fresh abortSlotInfo, and only if that abort completes does the
            // count increment + freeze apply. See the abort-completion path
            // for the actual incrementItemSellAbortCount + freeze call. The
            // sell count feeds into the effective count (buy + sell) for the
            // progressive freeze duration and hard-skip threshold.
            const countSellAbort = slot.type === 'sell' && !isConfigAborrt && slot.progress < 0.25;
            loop.activeAbortFlow = new AbortOfferFlow({
                slotIndex: i,
                delayFn: createDelay,
                debugLog: (msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); },
            });
            // Record slot info so we can clean up the cache entry on abort
            // completion and record an abort history entry for diagnostics.
            // Buy offers with 0% progress have nothing to collect, so the
            // cache entry is removed. Partial buys keep their entry (collected
            // items will be sold in the next loop iteration).
            if (slot.itemName) {
                const abortEntry = cache.get(slot.itemName);
                const merch = getMerchableItem(slot.itemName);
                // Prefer cached runtime ETA over live simulation ETA.
                const etaMin = slot.type === 'buy'
                    ? ((abortEntry?.purchaseEtaMinutes ?? 0) || (merch ? merch.purchaseEtaMinutes : 0))
                    : ((abortEntry?.saleEtaMinutes ?? 0) || (merch ? merch.saleEtaMinutes : 0));
                const price = slot.type === 'buy'
                    ? (abortEntry?.buyPrice ?? 0)
                    : (abortEntry?.sellPrice ?? 0);
                loop.abortSlotInfo = {
                    type: slot.type as 'buy' | 'sell',
                    itemName: slot.itemName,
                    progress: slot.progress,
                    reason,
                    category: (isF2pSwapOut ? 'swap' : 'eta') as AbortCategory,
                    etaMin,
                    requestedQty: slot.itemQuantity,
                    price,
                    placedAt: abortEntry?.offerPlacedAt ?? Date.now(),
                    countSellAbort,
                };
            } else {
                loop.abortSlotInfo = null;
            }
            loop.phase = 'aborting';
            return true; // the flow will be ticked on the next call
        }

        // Not stale — log the diagnostic comparison so the user can see
        // how close an offer is to being aborted.
        if (slot.itemName) {
            const entry = cache.get(slot.itemName);
            if (entry) {
                const elapsedMin = (Date.now() - entry.offerPlacedAt) / 60000;
                const merch = getMerchableItem(slot.itemName);
                // Prefer cached runtime ETA over live simulation ETA.
                const cachedEta = slot.type === 'sell' ? (entry.saleEtaMinutes ?? 0) : (entry.purchaseEtaMinutes ?? 0);
                const liveEta = merch
                    ? (slot.type === 'sell' ? merch.saleEtaMinutes : merch.purchaseEtaMinutes)
                    : 0;
                const eta = cachedEta || liveEta;
                const ratio = eta > 0 ? (elapsedMin / eta) * 100 : 0;
                const etaSource = cachedEta > 0 ? '' : (liveEta > 0 ? ' (live)' : ' (cached)');
                if (verboseIdleDiag) debugLog(bot, `Auto: slot ${i + 1} ${slot.type} ${slot.itemName} — ${(slot.progress * 100).toFixed(1)}% progress, ${elapsedMin.toFixed(1)}min/${eta.toFixed(1)}min ETA${etaSource} (${ratio.toFixed(0)}%), not stale`);
            }
        }
    }
    if (verboseIdleDiag) debugLog(bot, 'Auto: no stale offers found');
    } // end else (not idle activity items — stale check ran)

    // --- Step 5: Selling flow ---
    // Check for empty slots and inventory items to sell.
    // Safety: if idle activity items are in the inventory (chocolate dust,
    // bars, knife, ultracompost, supercompost), skip the sell scan entirely
    // — these items must never be sold on the GE. The idle activity cleans
    // up before resuming GE mode, so this is a defensive guard against
    // unexpected state. Volcanic ash is stackable and kept across cycles, so
    // it doesn't trigger hasIdleActivityItems — it's filtered out below by
    // getIdleActivityExcludedSellIds so it's never listed for sale.
    let skipBuyForIdleCleanup = false;
    const emptySlot = findEmptyOfferSlot();
    if (emptySlot !== -1 && !hasIdleActivityItems(bot)) {
        // Get inventory items from the cached snapshot (single getAll()
        // call already made for this tick, shared across all sections).
        const invItems = [...getInvSnapshot().values()];
        const occupiedNames = getOccupiedItemNames(slots);
        const excludedSellIds = getIdleActivityExcludedSellIds(bot);
        const sellableItems = invItems.filter(i => i.id !== 995 && !excludedSellIds.has(i.id));
        if (verboseIdleDiag) debugLog(bot, `Auto: sell scan — empty slot ${emptySlot + 1}, ${sellableItems.length} non-coin inv item(s)${sellableItems.length > 0 ? ': ' + sellableItems.map(i => `${i.name}x${i.quantity}`).join(', ') : ''}`);

        for (const item of invItems) {
            // Skip coins (ID 995) and idle activity ingredients (ash, knife, etc).
            if (item.id === 995) continue;
            if (excludedSellIds.has(item.id)) continue;

            const itemName = item.name.trim();
            const lowerName = itemName.toLowerCase();

            // Skip items we've already tried to sell this loop iteration.
            if (loop.sellAttemptedItems.has(lowerName)) continue;

            // Check if the item is already in a GE slot.
            if (occupiedNames.has(lowerName)) {
                // Buy slot: items from a partial buy abort are in inventory
                // but the buy is still active — don't sell them until the
                // buy completes or is aborted.
                let inBuySlot = false;
                for (const slot of slots) {
                    if (slot.itemName && slot.itemName.trim().toLowerCase() === lowerName && slot.type === 'buy') {
                        inBuySlot = true;
                        break;
                    }
                }
                if (inBuySlot) {
                    debugLog(bot, `Auto: skipping ${itemName} — currently being bought in a GE slot`);
                    loop.sellAttemptedItems.add(lowerName);
                    continue;
                }
                // Sell slot: the item is already listed for sale. OSRS sell
                // offers at the same price fill FIFO, so a second sell offer
                // would never fill until the first completes — it just wastes
                // a GE slot and ties up capital. Abort the existing sell so
                // the items return to inventory, combine with what's already
                // there, and re-list as a single consolidated offer. This
                // cleans up duplicate sells that may have been created by
                // edge cases (e.g. GE state lag after sell placement, hot
                // reloads during abort flows). Each consolidation cycle
                // reduces the duplicate count by one.
                let sellSlotIdx = -1;
                for (const slot of slots) {
                    if (slot.itemName && slot.itemName.trim().toLowerCase() === lowerName && slot.type === 'sell') {
                        sellSlotIdx = slots.indexOf(slot);
                        break;
                    }
                }
                if (sellSlotIdx !== -1) {
                    const sellSlot = slots[sellSlotIdx];
                    if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: consolidating %s — aborting sell in slot %d (%d%% progress) to combine with %dx in inventory',
                        itemName, sellSlotIdx + 1, Math.round(sellSlot.progress * 100), item.quantity);
                    bot.statusText = `[CONSOLIDATE] [${itemName}] [slot ${sellSlotIdx + 1} → inventory]`;
                    loop.activeAbortFlow = new AbortOfferFlow({
                        slotIndex: sellSlotIdx,
                        delayFn: createDelay,
                        debugLog: (msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); },
                    });
                    const abortEntry = cache.get(itemName);
                    const abortMerch = getMerchableItem(itemName);
                    loop.abortSlotInfo = {
                        type: 'sell' as 'buy' | 'sell',
                        itemName,
                        progress: sellSlot.progress,
                        reason: 'consolidating duplicate sell — items in inventory alongside active sell',
                        category: 'swap' as AbortCategory,
                        etaMin: (abortEntry?.saleEtaMinutes ?? 0) || (abortMerch ? abortMerch.saleEtaMinutes : 0),
                        requestedQty: sellSlot.itemQuantity,
                        price: abortEntry?.sellPrice ?? 0,
                        placedAt: abortEntry?.offerPlacedAt ?? Date.now(),
                        countSellAbort: false,
                    };
                    loop.phase = 'aborting';
                    return true;
                }
            }

            // This item is not in any GE slot — we can sell it.
            // Determine the sell price.
            let sellPrice = cache.getSellPrice(itemName);
            let fallbackBuyPrice = 0; // for profit tracking when using fallback
            if (sellPrice === null) {
                // Not in cache or merchableItems.json — fall back to
                // priceHistory.json (last known 1h average prices). This
                // handles items that became orphaned after a long script
                // stop or a JSON refresh during sleep.
                const history = getPriceHistoryEntry(itemName);
                if (history && history.sell > 0) {
                    // Freshness guard: if the priceHistory data is older than
                    // 10 minutes, determine-flips.mjs has stopped running and
                    // the price may be stale. Skip the item — holding is safer
                    // than selling at a potentially outdated price. The item
                    // will be sold once fresh data arrives.
                    if (!isPriceHistoryFresh(history)) {
                        const ageMin = Math.round((Date.now() - history.fetchedAt) / 60000);
                        if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: priceHistory fallback for %s is stale (%d min old — determine-flips.mjs may have stopped) — skipping sell', itemName, ageMin);
                        loop.sellAttemptedItems.add(lowerName);
                        continue;
                    }
                    // Liquidate-at-break-even: if the 1h average spread is too
                    // thin for the 2% GE tax, list at the tax-break-even price
                    // (smallest sell price where sell - 2% tax > buyPrice) so
                    // the item is listed for sale rather than trapped in
                    // inventory. If it doesn't sell, the revision mechanism
                    // (rev 0-5 percentage reductions, rev 6 abandon to the
                    // tax-break-even floor, rev 8 final dump at the same
                    // floor, rev 9+ controlled loss below the floor) will
                    // progressively cut the price, eventually accepting a
                    // loss to free the GP.
                    const netSell = getNetSellPrice(history.sell);
                    if (history.buy > 0 && netSell <= history.buy) {
                        sellPrice = taxBreakEvenFloor(history.buy);
                        fallbackBuyPrice = history.buy;
                        debugLog(bot, `Auto: priceHistory fallback for ${itemName} listing at break-even — 1h spread too thin for tax (sell=${history.sell}gp, net=${netSell}gp, buy=${history.buy}gp) — listing at ${sellPrice}gp, revisions will cut if needed`);
                    } else {
                        sellPrice = history.sell;
                        fallbackBuyPrice = history.buy;
                        debugLog(bot, `Auto: using priceHistory fallback for ${itemName} — sell=${sellPrice}gp, buy=${fallbackBuyPrice}gp`);
                    }
                } else {
                    // No price data anywhere — skip to avoid selling at an unknown price.
                    debugLog(bot, `Auto: no sell price for ${itemName} — skipping (not in cache, merchableItems, or priceHistory)`);
                    loop.sellAttemptedItems.add(lowerName);
                    continue;
                }
            }

            // Check if this is a re-listing (item already in cache with a
            // previous sell offer that didn't sell). If so, record profit
            // for the items that sold before the abort, then revise the price.
            // CAPTURE the profit data BEFORE any cache mutations, then save
            // the cache BEFORE writing to dailyProfit. This prevents double-
            // counting on hot-reload: if we crash after profit is written but
            // before the cache is saved, the old sellQuantity would still be
            // present and the bot would re-compute the same partial sale profit.
            let pendingPartialProfit = 0;
            let pendingPartialLog = '';
            const existingEntry = cache.get(itemName);
            if (existingEntry && existingEntry.mode === 'sell' && existingEntry.sellQuantity !== undefined) {
                // This item was previously listed for sale but was aborted
                // (it's back in inventory after collect). The difference
                // between the listed quantity and what's in inventory now
                // is the quantity that actually sold.
                const soldQty = existingEntry.sellQuantity - item.quantity;
                if (soldQty > 0) {
                    const netSellPrice = getNetSellPrice(existingEntry.sellPrice);
                    const profitPerItem = netSellPrice - existingEntry.buyPrice;
                    pendingPartialProfit = profitPerItem * soldQty;
                    const taxPerItem = getGeTax(existingEntry.sellPrice);
                    pendingPartialLog = `${pendingPartialProfit}gp (${soldQty}x ${itemName} sold @ ${profitPerItem}gp/item net — sell=${existingEntry.sellPrice}gp, tax=${taxPerItem}gp, buy=${existingEntry.buyPrice}gp before abort)`;
                    // Track this partial sale batch for merch history.
                    // The summary entry is created when the cycle completes
                    // (100% sold) in the completed-sell sweep above.
                    cache.recordPartialSale(itemName, existingEntry.sellPrice, soldQty);
                    debugLog(bot, `Auto: partial sale recorded — ${soldQty}x ${itemName} @ ${existingEntry.sellPrice}gp (will be included in merch history at cycle completion)`);
                }
                // Revise the price downward (escalating reduction + abandon threshold).
                // Only revise if the previous sell offer was actually confirmed
                // on the GE. If sellConfirmed is false, the sell flow was
                // interrupted by a hot-reload before the offer was placed — the
                // item never had a chance to sell, so revising the price would
                // unfairly penalize it. Re-list at the same price instead.
                if (cache.isSellConfirmed(itemName)) {
                    const revisedPrice = cache.reviseSellPrice(itemName);
                    if (revisedPrice !== null) {
                        sellPrice = revisedPrice;
                        const revCount = cache.getRevisionCount(itemName);
                        // revCount here is AFTER the new price was pushed to
                        // revisedPrices, so it is one higher than the
                        // revisionCount used inside computeRevisedSellPrice
                        // (which is computed BEFORE the push). The thresholds
                        // below are adjusted by +1 to match the stage that
                        // actually produced this price:
                        //   controlled loss fires at revisionCount >= 9 → revCount >= 10
                        //   final dump fires at revisionCount >= 8      → revCount >= 9
                        //   abandon fires at revisionCount >= 6          → revCount >= 7
                        if (revCount >= 10) {
                            debugLog(bot, `Auto: ${itemName} controlled loss dump — selling at ${revisedPrice}gp (revision ${revCount}, below tax break-even floor) to free slot`);
                        } else if (revCount >= 9) {
                            debugLog(bot, `Auto: ${itemName} final dump — selling at ${revisedPrice}gp (revision ${revCount}, tax break-even floor) to free slot`);
                        } else if (revCount >= 7) {
                            debugLog(bot, `Auto: ${itemName} abandoned — selling at ${revisedPrice}gp (revision ${revCount}, tax break-even floor) to free slot`);
                        }
                    }
                } else {
                    debugLog(bot, `Auto: ${itemName} re-listing at same price (${existingEntry.sellPrice}gp) — previous sell flow was interrupted before confirmation, no revision applied`);
                }
            }

            // --- Fast-sell check ---
            // Small quantities of low-value items (e.g. 10 chaos runes from
            // a partial buy) aren't worth occupying a GE slot. Halve the sell
            // price for a guaranteed quick sale to free the slot. All three
            // conditions must be met: small qty, low total value, AND the
            // halved price must still be above the buy price (never fast-sell
            // at a loss).
            const fastSellBuyPrice = cache.getBuyPrice(itemName) ?? fallbackBuyPrice;
            let fastSell = false;
            if (item.quantity < FAST_SELL_QTY_THRESHOLD && sellPrice * item.quantity < FAST_SELL_VALUE_CAP) {
                const halvedPrice = Math.max(1, Math.floor(sellPrice * FAST_SELL_PRICE_MULTIPLIER));
                // Use net sell price (after 2% GE tax) for the loss check —
                // selling at halvedPrice when net(halvedPrice) <= buyPrice is
                // a guaranteed loss after tax even if halvedPrice > buyPrice.
                const netHalved = getNetSellPrice(halvedPrice);
                if (fastSellBuyPrice > 0 && netHalved <= fastSellBuyPrice) {
                    // Halving would sell at or below buy price after tax —
                    // skip fast-sell and sell at normal price to avoid a loss.
                    debugLog(bot, `Auto: skipping fast-sell for ${itemName} — net halved price ${netHalved}gp (gross ${halvedPrice}gp - tax ${halvedPrice - netHalved}gp) <= buy price ${fastSellBuyPrice}gp (would sell at a loss after tax)`);
                } else {
                    fastSell = true;
                    sellPrice = halvedPrice;
                    if (bot.logInfoValue) titan.logf('[Stark Mercher] Auto: fast-selling %dx %s @ %dgp each (50%% of sell price — small qty, low value, freeing slot)',
                        item.quantity, itemName, sellPrice);
                }
            }

            // Record the sell offer in the cache.
            // Pass the actual quantity being sold (= actual bought qty) and
            // the item's GE buy limit so the cache can track cumulative
            // bought quantity for the 4-hour buy limit.
            // If we used the priceHistory fallback, use its buy price for
            // profit tracking when the cache has no buy price.
            const buyPrice = cache.getBuyPrice(itemName) ?? fallbackBuyPrice;
            const merch = getMerchableItem(itemName);
            const limit = merch?.limit;
            // Compute the runtime sell ETA based on the actual quantity being
            // sold (not the simulation quantity) so the cache stores an
            // accurate sell ETA for the stale checker and cache dump.
            const runtimeSellEta = computeRuntimeSellEtaMinutes(itemName, item.quantity);
            cache.recordSellOffer(itemName, sellPrice, buyPrice, item.quantity, limit, runtimeSellEta || undefined);
            // SAVE the cache before starting the sell flow. This ensures that
            // if we crash after the cache save but before the sell completes,
            // the cache already reflects the new sell state (sellQuantity =
            // current inventory qty) so the partial profit won't be re-computed
            // on restart.
            cache.save();
            // NOTE: Partial sell profit is NOT recorded to daily profit here.
            // It will be included in the TOTAL profit recorded at cycle
            // completion (100% sold) in the completed-sell sweep, which uses
            // the weighted-average sell price across ALL partial batches.
            // Recording it here too would double-count in daily profit while
            // merch history (which only records at completion) would be correct
            // — creating a permanent discrepancy between the two.
            // The partial sale batch IS tracked via cache.recordPartialSale()
            // above so the merch history summary includes it.
            if (pendingPartialProfit !== 0) {
                debugLog(bot, `Auto: partial sale tracked — ${pendingPartialLog} (will be recorded in daily profit at cycle completion)`);
            }

            // Start the sell flow.
            const netSell = getNetSellPrice(sellPrice);
            const projSellProfit = (netSell - buyPrice) * item.quantity;
            const sellEtaNote = runtimeSellEta > 0 ? `, sellEta ${runtimeSellEta.toFixed(1)}min` : '';
            if (fastSell) {
                debugLog(bot, `Auto: fast-selling ${item.quantity}x ${itemName} @ ${sellPrice}gp each in slot ${emptySlot + 1} (50%% of sell price) — proj profit ${projSellProfit >= 0 ? '+' : ''}${projSellProfit}gp${sellEtaNote}`);
            } else {
                debugLog(bot, `Auto: selling ${item.quantity}x ${itemName} @ ${sellPrice}gp each in slot ${emptySlot + 1} — proj profit ${projSellProfit >= 0 ? '+' : ''}${projSellProfit}gp${sellEtaNote}`);
            }
            bot.statusText = `[SELL] [${formatQty(item.quantity)} ${itemName}] [${formatGpShort(sellPrice * item.quantity)} (${sellPrice}ea)]`;
            loop.activeSellFlow = new SellOfferFlow({
                itemName,
                quantity: item.quantity,
                price: sellPrice,
                delayFn: createDelay,
                debugLog: (msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); },
            });
            loop.phase = 'selling';
            loop.sellAttemptedItems.clear(); // reset for next iteration
            return true;
        }

        // No sellable items found in inventory — clear the attempted set
        // and fall through to the buying flow.
        if (verboseIdleDiag) debugLog(bot, 'Auto: no sellable items found in inventory — falling through to buying');
        loop.sellAttemptedItems.clear();
    } else if (emptySlot === -1 && !hasIdleActivityItems(bot)) {
        // No empty slots for selling. Check if there are sellable items in
        // inventory that need a slot. If so, abort the buy offer with 0%
        // progress (nothing bought yet — no loss) and the lowest projected
        // profit/hr to free a slot for the sell. This keeps the slot usage
        // dynamic: all 8 slots can be used for buys, but when a sale is
        // needed we sacrifice the least-productive buy (lowest profit/hr,
        // oldest as tiebreaker) to make room. This is consistent with item
        // selection, which picks the highest profit/hr first.
        //
        // Skip this entirely when idle activity items are in inventory —
        // they are non-coin items so they'd be treated as "sellable", but
        // they can't be sold on the GE. Aborting buys to free slots for
        // them would loop forever (abort buy → place new buy → abort again).
        // The idle activity state machine is responsible for cleaning up
        // its items before resuming GE mode.
        //
        // Note: hasIdleActivityItems() only detects non-stackable items
        // (ultracompost, supercompost). Stackable idle-activity items like
        // volcanic ash are kept in the inventory across cycles (including
        // after cleanup) and are NOT detected by hasIdleActivityItems. They
        // are filtered out here via getIdleActivityExcludedSellIds, matching
        // the sell scan's filter. Without this, volcanic ash would be treated
        // as "sellable" by this code but filtered out by the sell scan,
        // causing an infinite churn loop (abort buy → sell scan finds nothing
        // → buy scan refills slot → abort again).
        const excludedSellIdsForAbort = getIdleActivityExcludedSellIds(bot);
        const invItemsForAbort = [...getInvSnapshot().values()];
        const sellableForAbort = invItemsForAbort.filter(i => i.id !== 995 && !excludedSellIdsForAbort.has(i.id));
        if (sellableForAbort.length > 0) {
            // Find sellable items that are not currently being bought (those
            // are skipped during sell anyway — selling them would conflict
            // with the active buy offer).
            const occupiedNamesForAbort = getOccupiedItemNames(slots);
            const trulySellable = sellableForAbort.filter(i => {
                const lower = i.name.trim().toLowerCase();
                if (occupiedNamesForAbort.has(lower)) {
                    // Skip if the item has an active BUY offer (would conflict).
                    for (const s of slots) {
                        if (s.itemName && s.itemName.trim().toLowerCase() === lower && s.type === 'buy') {
                            return false;
                        }
                    }
                }
                return true;
            });
            if (trulySellable.length > 0) {
                // Find the buy offer with the lowest projected profit/hr
                // (0% progress only — nothing bought yet, so no loss). This
                // keeps the swap decision consistent with item selection
                // (highest profit/hr first → sacrifice lowest profit/hr
                // first). Tiebreaker: oldest placedAt (most likely dud).
                let swapSlotIdx = -1;
                let lowestProfitPerHour = Infinity;
                let swapPlacedAt = Infinity;
                for (let i = 0; i < slots.length; i++) {
                    const s = slots[i];
                    if (s.type !== 'buy' || s.status !== 'active' || s.progress > 0) continue;
                    if (!s.itemName) continue;
                    const entry = cache.get(s.itemName);
                    const placedAt = entry?.offerPlacedAt ?? Infinity;
                    // Compute projected profit/hr from cached prices + ETAs.
                    // Falls back to merchableItems.json ETAs if the cache
                    // entry doesn't have them (e.g. reconstructed entries).
                    const buyPrice = entry?.buyPrice ?? 0;
                    const sellPrice = entry?.sellPrice ?? 0;
                    const buyEta = entry?.purchaseEtaMinutes
                        ?? getMerchableItem(s.itemName)?.purchaseEtaMinutes
                        ?? 0;
                    const sellEta = entry?.saleEtaMinutes
                        ?? getMerchableItem(s.itemName)?.saleEtaMinutes
                        ?? 0;
                    const turnoverEta = buyEta + sellEta;
                    const netSell = sellPrice - getGeTax(sellPrice);
                    const profitPerItem = netSell - buyPrice;
                    const qty = s.itemQuantity;
                    const profitPerHour = turnoverEta > 0
                        ? (qty * profitPerItem) * (60 / turnoverEta)
                        : 0;
                    // Pick lowest profit/hr; on tie, pick oldest.
                    if (profitPerHour < lowestProfitPerHour
                        || (profitPerHour === lowestProfitPerHour && placedAt < swapPlacedAt)) {
                        lowestProfitPerHour = profitPerHour;
                        swapPlacedAt = placedAt;
                        swapSlotIdx = i;
                    }
                }
                if (swapSlotIdx !== -1) {
                    const abortSlot = slots[swapSlotIdx];
                    debugLog(bot, `Auto: no empty sell slot — aborting lowest profit/hr 0-progress buy ${abortSlot.itemName} in slot ${swapSlotIdx + 1} (${Math.round(lowestProfitPerHour)}gp/hr) to free slot for sell`);
                    bot.statusText = `[ABORT] [${abortSlot.itemName}] [Free for Sell]`;
                    // Clear any pending reprice — the item is being swapped out
                    // to free a slot for selling, not repriced.
                    loop.pendingReprices.delete(abortSlot.itemName.trim().toLowerCase());
                    loop.buyRepriceCounts.delete(abortSlot.itemName.trim().toLowerCase());
                    loop.activeAbortFlow = new AbortOfferFlow({
                        slotIndex: swapSlotIdx,
                        delayFn: createDelay,
                        debugLog: (msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); },
                    });
                    const abortEntry = cache.get(abortSlot.itemName);
                    const abortMerch = getMerchableItem(abortSlot.itemName);
                    loop.abortSlotInfo = {
                        type: 'buy',
                        itemName: abortSlot.itemName,
                        progress: abortSlot.progress,
                        reason: 'freeing slot for sell (lowest profit/hr 0-progress buy)',
                        category: 'swap' as AbortCategory,
                        etaMin: (abortEntry?.purchaseEtaMinutes ?? 0) || (abortMerch ? abortMerch.purchaseEtaMinutes : 0),
                        requestedQty: abortSlot.itemQuantity,
                        price: abortEntry?.buyPrice ?? 0,
                        placedAt: abortEntry?.offerPlacedAt ?? Date.now(),
                        countSellAbort: false,
                    };
                    loop.phase = 'aborting';
                    return true;
                }
            }
        }
        debugLog(bot, 'Auto: no empty slots for selling — all slots occupied');
    } else if (hasIdleActivityItems(bot)) {
        // Idle items in inventory but not in an active idle activity cycle
        // (e.g. left over from a hot reload mid-activity, or the setting was
        // switched to "None" with items still in the inventory). Skip sell,
        // abort, AND buy — the items can't be sold on the GE, and placing
        // buy offers with a full inventory would cause "you don't have
        // enough inventory space" when the buy fills and can't be collected.
        // The cleanup-for-GE trigger above banks the items before any GE
        // flows resume, regardless of the idle activity setting.
        skipBuyForIdleCleanup = true;
        if (verboseIdleDiag) debugLog(bot, 'Auto: idle activity items in inventory — skipping sell/abort/buy, waiting for cleanup to bank items');
    }

    // --- Step 6: Buying flow ---
    // Check for empty slots and merchable items to buy.
    let emptyBuySlot = findEmptyOfferSlot();

    // If idle activity items are in inventory (e.g. after a hot reload
    // mid-activity, or the setting was switched to "None" with items still
    // present), skip buying — the cleanup-for-GE trigger above banks the
    // items before any GE buy offers are placed. Without this, the bot
    // would place buy offers with a full inventory, causing "you don't
    // have enough inventory space" when the buy fills and can't be
    // collected.
    if (emptyBuySlot !== -1 && skipBuyForIdleCleanup) {
        emptyBuySlot = -1;
    }

    if (emptyBuySlot !== -1) {
        // Data validity safeguard — don't place new buy offers if merchable
        // data is stale (determine-flips.mjs hasn't run recently). The bot
        // still logs in and manages existing offers (collect completed sells,
        // abort stale offers, sell inventory) — this only prevents new buys
        // until fresh data arrives via hot reload.
        const dataCheck = isMerchableDataValid();
        if (!dataCheck.valid) {
            if (verboseIdleDiag) debugLog(bot, `Auto: skipping buy scan — merchable data stale (${dataCheck.reason})`);
            loop.buyAttemptedItems.clear();
            // Fall through to the idle path (short break / logout / rotation).
            // Setting emptyBuySlot = -1 skips the buy scan and enters the
            // "all slots occupied" else branch, which also skips the frozen
            // swap when data is stale and reaches the idle scheduler at the
            // bottom of this function.
            emptyBuySlot = -1;
        }
    }

    // --- Slow Mode / pre-sleep priority flags (shared by both branches) ---
    // Declared here so both the empty-slot buy scan and the all-slots-occupied
    // frozen swap-out path can use them. getMinutesUntilNightlySleep is a pure
    // JS calculation (no native SDK calls), so computing it once per tick is
    // cheap. Slow Mode only affects buy-offer item selection — login/logout,
    // breaks, rotation, and hop timing are unchanged.
    const minutesUntilSleep = getMinutesUntilNightlySleep(bot);
    const preSleepPriority = minutesUntilSleep <= PRE_SLEEP_PRIORITY_MINUTES;
    const slowMode = bot.autoModeValue === 2;

    if (emptyBuySlot !== -1) {
        // All 8 slots are available for buy offers. When a sell is needed,
        // the sell scan (Step 5) aborts the 0-progress buy offer with the
        // lowest projected profit/hr to free a slot — so we don't need to
        // reserve slots for sales here.
        let currentBuySlots = 0;
        let emptySlotCount = 0;
        for (const s of slots) {
            if (s.type === 'buy') currentBuySlots++;
            if (s.type === 'empty') emptySlotCount++;
        }
        const occupiedNames = getOccupiedItemNames(slots);
        // Count coins from the cached inventory snapshot (single getAll()
        // call shared across all sections of this tick). This is the total
        // budget available for new buy offers.
        const coinCount = countCoinsInInv();
        // --- Per-slot budget with profit-scaled soft cap ---
        // Divide the available coins by the number of empty slots to get a
        // base per-slot budget, then allow up to MAX_SLOT_BUDGET_MULTIPLIER ×
        // the base. This prevents a single expensive item from consuming all
        // the cash when there are multiple empty slots to fill, while still
        // allowing a highly profitable item to take "a bit more" than its
        // fair share. With 1 empty slot, the cap is the full coinCount.
        const baseSlotBudget = emptySlotCount > 0
            ? Math.floor(coinCount / emptySlotCount)
            : coinCount;
        const slotBudget = Math.min(coinCount, Math.floor(baseSlotBudget * (bot.autoModeValue === 3 ? F2P_SLOT_BUDGET_MULTIPLIER : MAX_SLOT_BUDGET_MULTIPLIER)));
        // Get the set of items currently buy-limited (within the 4-hour GE
        // cooldown). These are skipped by getFirstUnoccupiedMerchableItem.
        const buyLimitedNames = cache.getBuyLimitedItemNames();
        // Also skip items where the remaining buy limit is below 20% of the
        // full limit (partial purchases in the current 4-hour window that
        // haven't triggered the full-limit cooldown yet).
        const allMerchItems = getMerchableItems();
        const buyThresholdNames = cache.getBuyLimitThresholdItemNames(
            allMerchItems.map(i => ({ itemName: i.itemName, limit: i.limit })),
            20,
        );
        for (const name of buyThresholdNames) buyLimitedNames.add(name);
        if (buyLimitedNames.size > 0) {
            debugLog(bot, `Auto: ${buyLimitedNames.size} item(s) buy-limited — skipping: ${[...buyLimitedNames].join(', ')}`);
        }
        if (verboseIdleDiag) debugLog(bot, `Auto: buy scan — empty slot ${emptyBuySlot + 1}, coins=${coinCount}, slotBudget=${slotBudget} (${emptySlotCount} empty slots, ${bot.autoModeValue === 3 ? F2P_SLOT_BUDGET_MULTIPLIER : MAX_SLOT_BUDGET_MULTIPLIER}x cap), occupied=${occupiedNames.size}, buyLimited=${buyLimitedNames.size}, buy slots=${currentBuySlots}/${slots.length}`);

        // Build the set of currently-frozen items (buy offers recently aborted).
        // Expired freezes are cleaned up lazily here.
        const now = Date.now();
        const frozenNames = new Set<string>();
        let freezeRemoved = false;
        for (const [name, until] of loop.buyFreezeUntil) {
            if (now < until) {
                frozenNames.add(name);
            } else {
                loop.buyFreezeUntil.delete(name);
                loop.buyFreezeSources.delete(name);
                freezeRemoved = true;
            }
        }
        if (freezeRemoved) saveBuyFreeze(bot, loop.buyFreezeUntil);
        if (frozenNames.size > 0) {
            if (verboseIdleDiag) {
                const labeled = [...frozenNames].map(n => `${n} [${loop.buyFreezeSources.get(n) ?? 'restored'}]`);
                debugLog(bot, `Auto: ${frozenNames.size} item(s) buy-frozen — skipping: ${labeled.join(', ')}`);
            }
        }

        // Hard-skip items with too many recent aborts (buy OR sell) — the
        // market price estimate is systematically wrong for them, and
        // re-listing at the same price just wastes another GE slot cycle. Buy
        // aborts mean the buy price is too low; sell aborts (<25% progress)
        // mean the sell price is too high. Both feed into the effective count
        // (buy + sell). Added to buyLimitedNames so they're skipped by all
        // scan tiers (primary, frozen fallback, partial fallback, and swap
        // candidate).
        let hardSkipRemoved = false;
        for (const [name, entry] of loop.itemAbortCounts) {
            const effectiveCount = computeEffectiveAbortCount(entry);
            const hardSkip = effectiveCount >= ITEM_ABORT_HARD_SKIP_THRESHOLD;
            if (hardSkip) {
                buyLimitedNames.add(name);
            } else {
                // Decay: delete the entry only when BOTH buy and sell counts
                // have expired past their respective reset windows. Zero out
                // individual expired counters while keeping the entry if the
                // other counter is still active.
                const now = Date.now();
                const buyExpired = now - entry.lastAbortAt >= ITEM_ABORT_COUNT_RESET_MS;
                const sellExpired = !entry.lastSellAbortAt || now - entry.lastSellAbortAt >= SELL_ABORT_COUNT_RESET_MS;
                if (buyExpired && sellExpired) {
                    loop.itemAbortCounts.delete(name);
                    hardSkipRemoved = true;
                } else if (buyExpired && entry.count > 0) {
                    entry.count = 0;
                    entry.lastAbortAt = 0;
                    hardSkipRemoved = true;
                } else if (sellExpired && (entry.sellCount ?? 0) > 0) {
                    entry.sellCount = 0;
                    entry.lastSellAbortAt = undefined;
                    hardSkipRemoved = true;
                }
            }
        }
        if (hardSkipRemoved) saveItemAbortCounts(bot, loop.itemAbortCounts);
        let hardSkipNames = 0;
        for (const name of buyLimitedNames) {
            const entry = loop.itemAbortCounts.get(name);
            if (entry && computeEffectiveAbortCount(entry) >= ITEM_ABORT_HARD_SKIP_THRESHOLD) hardSkipNames++;
        }
        if (hardSkipNames > 0) {
            debugLog(bot, `Auto: ${hardSkipNames} item(s) hard-skipped (effective abort count >= ${ITEM_ABORT_HARD_SKIP_THRESHOLD})`);
        }

        // --- Buy scan with lowball tiering (cash-stack-aware) ---
        // Each item is evaluated at runtime based on the per-slot budget
        // (slotBudget), NOT the full coin stack. The runtime quantity is
        // min(floor(slotBudget/price), limit) — this prevents a single
        // expensive item from consuming all coins when there are multiple
        // empty slots to fill. The scan returns the item with the highest
        // runtimeProfitPerSlotHour that passes the profit/hr and turnover
        // filters.
        //
        // **Pre-sleep lowball priority**: During the final 30 minutes before
        // nightly sleep, the tier order is reversed to prefer lowball items
        // (buy below market, slower fills, higher margins) over non-lowball
        // items (instant-fill, buy at market). Offers placed shortly before
        // sleep will remain unattended for ~4h, making slower lowball offers
        // more suitable. The lowball turnover cap is also relaxed from 120min
        // to 240min during this window. Invalid, disabled, expired, or
        // already-started nightly schedules do NOT activate pre-sleep mode
        // (getMinutesUntilNightlySleep returns Infinity in those cases).
        //
        // Normal tier order:
        //   1. Non-lowball, non-frozen (primary — instant-fill)
        //   2. Non-lowball, frozen fallback (soonest-expiring freeze)
        //   3. Lowball, non-frozen (only when all non-lowball exhausted)
        //   4. Lowball, frozen fallback (last resort)
        //   5. Partial fallback (lower profit/hr threshold, longer turnover)
        //
        // Pre-sleep tier order (overrides Normal and Slow):
        //   1. Lowball, non-frozen (relaxed 240min turnover)
        //   2. Lowball, frozen fallback (relaxed 240min turnover)
        //   3. Non-lowball, non-frozen
        //   4. Non-lowball, frozen fallback
        //   5. Partial fallback (lowball first, then non-lowball)
        //
        // Slow Mode tier order (when Mode = Slow and pre-sleep NOT active):
        //   0. Lowball with buy ETA 30-60min, non-frozen (preferred — slow
        //      high-margin fills suited to the ~30min login cadence)
        //      0b. ...frozen fallback (same ETA filter)
        //   1-5. Normal tier order (unchanged fallback if tier 0 is empty)
        // Pre-sleep takes precedence over Slow Mode — it's the stronger
        // condition and already does lowball-first with the 240min cap.
        const slowPreferredActive = slowMode && !preSleepPriority;
        const firstTier: LowballTier = preSleepPriority ? 'lowball' : 'non-lowball';
        const secondTier: LowballTier = preSleepPriority ? 'non-lowball' : 'lowball';
        const firstTierMaxTurnover = preSleepPriority && firstTier === 'lowball'
            ? PRE_SLEEP_LOWBALL_MAX_TURNOVER_MINUTES
            : RUNTIME_MAX_TURNOVER_MINUTES;
        if (preSleepPriority) {
            debugLog(bot, `Auto: pre-sleep lowball priority active — ${minutesUntilSleep.toFixed(1)}min until nightly sleep, lowball turnover cap relaxed to ${PRE_SLEEP_LOWBALL_MAX_TURNOVER_MINUTES}min`);
        } else if (slowPreferredActive) {
            debugLog(bot, `Auto: slow mode preferred tier active — targeting lowball items with buy ETA ${SLOW_PREFERRED_MIN_BUY_ETA_MINUTES}-${SLOW_PREFERRED_MAX_BUY_ETA_MINUTES}min (turnover cap ${PRE_SLEEP_LOWBALL_MAX_TURNOVER_MINUTES}min), normal tier order as fallback`);
        }

        let merch: BuyScanResult | null = null;

        // Tier 0 (Slow Mode only): preferred lowball items with buy ETA in
        // the 30-60min range. Skipped when pre-sleep is active (pre-sleep
        // already prefers lowball with the 240min cap and no ETA band).
        if (slowPreferredActive) {
            merch = getFirstUnoccupiedMerchableItem(
                occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), frozenNames,
                'lowball', PRE_SLEEP_LOWBALL_MAX_TURNOVER_MINUTES,
                SLOW_PREFERRED_MIN_BUY_ETA_MINUTES, SLOW_PREFERRED_MAX_BUY_ETA_MINUTES,
            );
            if (!merch && frozenNames.size > 0) {
                merch = getFrozenFallbackItem(
                    loop.buyFreezeUntil, occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(),
                    'lowball', PRE_SLEEP_LOWBALL_MAX_TURNOVER_MINUTES,
                    SLOW_PREFERRED_MIN_BUY_ETA_MINUTES, SLOW_PREFERRED_MAX_BUY_ETA_MINUTES,
                );
                if (merch && verboseIdleDiag) {
                    const freezeMs = loop.buyFreezeUntil.get(merch.item.itemName.trim().toLowerCase()) ?? 0;
                    const remainingMs = freezeMs - Date.now();
                    debugLog(bot, `Auto: slow preferred frozen fallback — ${merch.item.itemName} (buy ETA ${merch.runtimePurchaseEtaMinutes.toFixed(1)}min, freeze expires in ${Math.max(0, Math.round(remainingMs / 60000))} min)`);
                }
            }
            if (merch && verboseIdleDiag) {
                debugLog(bot, `Auto: slow preferred pick — ${merch.item.itemName} (buy ETA ${merch.runtimePurchaseEtaMinutes.toFixed(1)}min, profit/hr ${Math.round(merch.runtimeProfitPerSlotHour)}gp)`);
            }
        }

        // Normal/pre-sleep tier order (also serves as the fallback when Slow
        // Mode's preferred tier found nothing).
        if (!merch) {
            merch = getFirstUnoccupiedMerchableItem(occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), frozenNames, firstTier, firstTierMaxTurnover);
        }

        // Tier 2: first-tier frozen fallback.
        if (!merch && frozenNames.size > 0) {
            merch = getFrozenFallbackItem(loop.buyFreezeUntil, occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), firstTier, firstTierMaxTurnover);
            if (merch) {
                const freezeMs = loop.buyFreezeUntil.get(merch.item.itemName.trim().toLowerCase()) ?? 0;
                const remainingMs = freezeMs - Date.now();
                if (verboseIdleDiag) debugLog(bot, `Auto: using frozen ${firstTier} item ${merch.item.itemName} as fallback — no other ${firstTier} items available (freeze expires in ${Math.max(0, Math.round(remainingMs / 60000))} min)`);
            }
        }

        // Tier 3: second-tier, non-frozen — only when all first-tier items are
        // occupied, buy-limited, frozen, or unaffordable.
        if (!merch) {
            merch = getFirstUnoccupiedMerchableItem(occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), frozenNames, secondTier);
            if (merch) {
                if (verboseIdleDiag) debugLog(bot, `Auto: using ${secondTier} item ${merch.item.itemName}${merch.item.lowballPercent > 0 ? ` (${merch.item.lowballPercent.toFixed(2)}% lowball)` : ''} — all ${firstTier} items occupied/limited/frozen/unaffordable`);
            }
        }

        // Tier 4: second-tier frozen fallback — last resort.
        if (!merch && frozenNames.size > 0) {
            merch = getFrozenFallbackItem(loop.buyFreezeUntil, occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), secondTier);
            if (merch) {
                const freezeMs = loop.buyFreezeUntil.get(merch.item.itemName.trim().toLowerCase()) ?? 0;
                const remainingMs = freezeMs - Date.now();
                if (verboseIdleDiag) debugLog(bot, `Auto: using frozen ${secondTier} item ${merch.item.itemName} as fallback — no other items available (freeze expires in ${Math.max(0, Math.round(remainingMs / 60000))} min)`);
            }
        }

        // Tier 5: Partial fallback — lower profit/hr threshold (5000 vs 20000)
        // and longer max turnover (240min vs 150min). Only tried when all
        // standard scans fail. Same tier ordering as the primary scan:
        // first-tier (lowball in pre-sleep, non-lowball in normal) first.
        let partial: PartialBuyResult | null = null;
        if (!merch) {
            // First-tier partial.
            partial = getFirstPartialBuyItem(occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), frozenNames, RUNTIME_MIN_ABSOLUTE_PROFIT_GP, firstTier);
            if (partial) {
                if (verboseIdleDiag) debugLog(bot, `Auto: partial-quantity buy (${firstTier}) — ${partial.item.itemName} buying ${partial.quantity} (profit ${partial.quantity * partial.item.profitMargin}gp, runtime fallback)`);
            } else if (frozenNames.size > 0) {
                // First-tier frozen fallback.
                partial = getFrozenFallbackPartial(loop.buyFreezeUntil, occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), RUNTIME_MIN_ABSOLUTE_PROFIT_GP, firstTier);
                if (partial) {
                    if (verboseIdleDiag) debugLog(bot, `Auto: partial-quantity buy (frozen ${firstTier} fallback) — ${partial.item.itemName} buying ${partial.quantity} (profit ${partial.quantity * partial.item.profitMargin}gp)`);
                }
            }
            // Second-tier partial — only if no first-tier partial found.
            if (!partial) {
                partial = getFirstPartialBuyItem(occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), frozenNames, RUNTIME_MIN_ABSOLUTE_PROFIT_GP, secondTier);
                if (partial) {
                    if (verboseIdleDiag) debugLog(bot, `Auto: partial-quantity buy (${secondTier}) — ${partial.item.itemName} buying ${partial.quantity} (profit ${partial.quantity * partial.item.profitMargin}gp, runtime fallback)`);
                } else if (frozenNames.size > 0) {
                    // Second-tier frozen fallback.
                    partial = getFrozenFallbackPartial(loop.buyFreezeUntil, occupiedNames, slotBudget, buyLimitedNames, isMembersWorld(), RUNTIME_MIN_ABSOLUTE_PROFIT_GP, secondTier);
                    if (partial) {
                        if (verboseIdleDiag) debugLog(bot, `Auto: partial-quantity buy (frozen ${secondTier} fallback) — ${partial.item.itemName} buying ${partial.quantity} (profit ${partial.quantity * partial.item.profitMargin}gp)`);
                    }
                }
            }
        }

        if (merch) {
            const mItem = merch.item;
            const lowerName = mItem.itemName.trim().toLowerCase();

            // Skip items we've already tried to buy this loop iteration.
            if (!loop.buyAttemptedItems.has(lowerName)) {
                // Check for a pending reprice — if this item was aborted for
                // repricing (high-profit stalled buy), override the purchase
                // price with the bumped price and clear the pending entry.
                const repriceBuyPrice = loop.pendingReprices.get(lowerName);
                if (repriceBuyPrice !== undefined) {
                    debugLog(bot, `Auto: applying pending reprice for ${mItem.itemName} — buy price ${mItem.purchasePrice}gp → ${repriceBuyPrice}gp`);
                    mItem.purchasePrice = repriceBuyPrice;
                    loop.pendingReprices.delete(lowerName);
                }
                // Adjust the buy quantity based on remaining GE buy limit.
                // If we've partially bought this item in the current 4-hour
                // window, we can only buy up to (limit - totalBought).
                const remaining = cache.getRemainingBuyLimit(mItem.itemName, mItem.limit);
                const adjustedQty = Math.min(merch.quantity, remaining);
                if (adjustedQty <= 0) {
                    // Shouldn't happen (threshold check above filters this),
                    // but guard against it anyway.
                    debugLog(bot, `Auto: ${mItem.itemName} has no remaining buy limit — skipping`);
                    loop.buyAttemptedItems.add(lowerName);
                    return true;
                }
                const adjustedTotal = adjustedQty * mItem.purchasePrice;

                // Skip buy offers below the minimum value threshold. When
                // the cash stack is low, placing tiny offers (e.g. 35 Death
                // runes for 6.5k GP) wastes a GE slot on negligible profit.
                // Fall through to the "nothing to do" branch — the bot will
                // take a short break / logout / rotate to the next account,
                // and resume buying once sells complete and coins recover.
                if (adjustedTotal < MIN_BUY_OFFER_VALUE) {
                    if (verboseIdleDiag) debugLog(bot, `Auto: skipping buy offer for ${mItem.itemName} — total ${adjustedTotal}gp below ${MIN_BUY_OFFER_VALUE}gp minimum (coins=${coinCount})`);
                    // Fall through to "nothing to do" — don't return true.
                } else {
                // Record the buy offer in the cache.
                cache.recordBuyOffer(mItem, merch.runtimePurchaseEtaMinutes, merch.runtimeSaleEtaMinutes, adjustedQty);
                cache.save();

                const qtyNote = adjustedQty < merch.quantity ? ` (reduced from ${merch.quantity} — buy limit remaining)` : '';
                debugLog(bot, `Auto: buying ${adjustedQty}x ${mItem.itemName} @ ${mItem.purchasePrice}gp each (total ${adjustedTotal}gp) in slot ${emptyBuySlot + 1} — coins available: ${coinCount}${qtyNote} — profit/hr ${Math.round(merch.runtimeProfitPerSlotHour)}gp, buyEta ${merch.runtimePurchaseEtaMinutes.toFixed(1)}min, sellEta ${merch.runtimeSaleEtaMinutes.toFixed(1)}min`);
                bot.statusText = `[BUY] [${formatQty(adjustedQty)} ${mItem.itemName}] [${formatGpShort(adjustedTotal)} (${mItem.purchasePrice}ea)]`;
                loop.activeBuyFlow = new BuyOfferFlow({
                    itemName: mItem.itemName,
                    quantity: adjustedQty,
                    price: mItem.purchasePrice,
                    delayFn: createDelay,
                    debugLog: (msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); },
                });
                loop.phase = 'buying';
                loop.buyAttemptedItems.clear();
                return true;
                } // end else (offer above MIN_BUY_OFFER_VALUE)
            }
        } else if (partial) {
            const pItem = partial.item;
            const lowerName = pItem.itemName.trim().toLowerCase();

            if (!loop.buyAttemptedItems.has(lowerName)) {
                // Check for a pending reprice (same as the merch path).
                const repriceBuyPrice = loop.pendingReprices.get(lowerName);
                if (repriceBuyPrice !== undefined) {
                    debugLog(bot, `Auto: applying pending reprice for ${pItem.itemName} — buy price ${pItem.purchasePrice}gp → ${repriceBuyPrice}gp`);
                    pItem.purchasePrice = repriceBuyPrice;
                    loop.pendingReprices.delete(lowerName);
                }
                // Adjust the partial quantity based on remaining buy limit.
                const remaining = cache.getRemainingBuyLimit(pItem.itemName, pItem.limit);
                const adjustedQty = Math.min(partial.quantity, remaining);
                if (adjustedQty <= 0) {
                    debugLog(bot, `Auto: ${pItem.itemName} has no remaining buy limit — skipping partial buy`);
                    loop.buyAttemptedItems.add(lowerName);
                    return true;
                }
                const adjustedTotal = adjustedQty * pItem.purchasePrice;

                // Same MIN_BUY_OFFER_VALUE guard as the merch path.
                if (adjustedTotal < MIN_BUY_OFFER_VALUE) {
                    if (verboseIdleDiag) debugLog(bot, `Auto: skipping partial buy offer for ${pItem.itemName} — total ${adjustedTotal}gp below ${MIN_BUY_OFFER_VALUE}gp minimum (coins=${coinCount})`);
                    // Fall through to "nothing to do" — don't return true.
                } else {
                // Record the buy offer in the cache. We pass the item as-is
                // (cache uses itemName/limit/sellPrice); the reduced quantity
                // is handled by the BuyOfferFlow below. Pass runtime ETAs
                // from the scan result so the cache stores accurate values
                // for the actual affordable quantity.
                cache.recordBuyOffer(pItem, partial.runtimePurchaseEtaMinutes, partial.runtimeSaleEtaMinutes, adjustedQty);
                cache.save();

                const partialProfit = (pItem.salePrice - pItem.purchasePrice) * adjustedQty;
                const partialBuyEta = partial.runtimePurchaseEtaMinutes ? partial.runtimePurchaseEtaMinutes.toFixed(1) : '?';
                const partialSellEta = partial.runtimeSaleEtaMinutes ? partial.runtimeSaleEtaMinutes.toFixed(1) : '?';
                debugLog(bot, `Auto: buying ${adjustedQty}x ${pItem.itemName} @ ${pItem.purchasePrice}gp each (total ${adjustedTotal}gp) in slot ${emptyBuySlot + 1} — coins available: ${coinCount} (partial — full qty ${pItem.quantityToPurchase} needs ${pItem.totalPurchasePrice}gp) — profit ${partialProfit}gp, buyEta ${partialBuyEta}min, sellEta ${partialSellEta}min`);
                bot.statusText = `[BUY] [${formatQty(adjustedQty)} ${pItem.itemName}] [${formatGpShort(adjustedTotal)} (${pItem.purchasePrice}ea, partial)]`;
                loop.activeBuyFlow = new BuyOfferFlow({
                    itemName: pItem.itemName,
                    quantity: adjustedQty,
                    price: pItem.purchasePrice,
                    delayFn: createDelay,
                    debugLog: (msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); },
                });
                loop.phase = 'buying';
                loop.buyAttemptedItems.clear();
                // Reset the reprice count — the buy was placed.
                loop.buyRepriceCounts.delete(lowerName);
                return true;
                } // end else (partial offer above MIN_BUY_OFFER_VALUE)
            }
        } else {
            // No affordable merchable item found — log a summary of why.
            // Uses runtime evaluation to classify items.
            let occupied = 0, buyLimited = 0, frozen = 0, unaffordable = 0, belowVolumeFloor = 0, belowThreshold = 0, belowProfitFloor = 0;
            for (const item of allMerchItems) {
                const lower = item.itemName.trim().toLowerCase();
                if (occupiedNames.has(lower)) { occupied++; continue; }
                if (buyLimitedNames.has(lower)) { buyLimited++; continue; }
                if (frozenNames.has(lower)) { frozen++; continue; }
                // Check volume floor before affordability — items below the
                // 15/hr effective volume floor are rejected regardless of
                // budget, so report them separately from unaffordable items.
                if (getEffectiveMinVolume(item) < RUNTIME_MIN_EFFECTIVE_VOLUME) {
                    belowVolumeFloor++;
                    continue;
                }
                // Evaluate at runtime to see why it was rejected.
                const evalResult = evaluateItemAtRuntime(item, slotBudget);
                if (!evalResult) {
                    unaffordable++;
                    continue;
                }
                // Item is affordable but below profit/hr or turnover thresholds.
                if (evalResult.runtimeProfitPerSlotHour < RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM ||
                    evalResult.runtimeTurnoverEtaMinutes > RUNTIME_MAX_TURNOVER_MINUTES) {
                    belowThreshold++;
                    continue;
                }
                // Item passes profit/hr and turnover but total absolute profit
                // is below the 20k floor (e.g. small quantity of a thin-margin
                // item).
                if (evalResult.runtimeTotalProfit < RUNTIME_MIN_ABSOLUTE_PROFIT_GP) {
                    belowProfitFloor++;
                }
            }
            debugLog(bot, `Auto: no merchable item to buy — ${occupied} occupied, ${buyLimited} buy-limited, ${frozen} frozen, ${unaffordable} unaffordable (budget=${slotBudget}), ${belowVolumeFloor} below volume floor, ${belowThreshold} below profit/hr or turnover threshold, ${belowProfitFloor} below 20k profit floor — coins=${coinCount}`);
        }

        loop.buyAttemptedItems.clear();
    } else {
        // All slots occupied. Check if any buy slot has a frozen item that
        // should be swapped out for a non-frozen merchable item. The frozen
        // item was only placed as a fallback (no other items were available
        // at the time). If a non-frozen merchable item is now available,
        // abort the frozen item's slot to make room. Skip offers that are
        // nearly complete (>= 50% progress) — let them finish naturally.
        // Skip swap if merchable data is stale — we don't want to abort a
        // frozen offer and replace it with an item picked from stale data.
        // Fall through to the idle path below instead of returning false —
        // returning false skips idle scheduling (setAction + loopIdleForBreak),
        // causing a tight loop every tick with no delay, no break eligibility,
        // and per-tick log spam.
        if (!isMerchableDataValid().valid) {
            loop.buyAttemptedItems.clear();
        } else {
        const nowSwap = Date.now();
        const swapFrozenNames = new Set<string>();
        for (const [name, until] of loop.buyFreezeUntil) {
            if (nowSwap < until) swapFrozenNames.add(name);
        }
        if (swapFrozenNames.size > 0) {
            const swapOccupiedNames = getOccupiedItemNames(slots);
            const swapCoinCount = countCoinsInInv();
            const swapBuyLimitedNames = cache.getBuyLimitedItemNames();
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                if (slot.type !== 'buy' || !slot.itemName || slot.status !== 'active') continue;
                const slotItemLower = slot.itemName.trim().toLowerCase();
                if (!swapFrozenNames.has(slotItemLower)) continue;
                if (slot.progress >= 0.5) continue; // nearly done — let it finish

                // Is there a non-frozen merchable item available to replace it?
                // Tiering mirrors the primary buy scan: in Slow Mode (and not
                // pre-sleep), try the slow preferred tier (lowball, buy ETA
                // 30-60min) first; otherwise prefer non-lowball (instant-fill)
                // then lowball.
                let swapCandidate: BuyScanResult | null = null;
                const swapSlowPreferred = slowMode && !preSleepPriority;
                if (swapSlowPreferred) {
                    swapCandidate = getFirstUnoccupiedMerchableItem(
                        swapOccupiedNames, swapCoinCount, swapBuyLimitedNames, isMembersWorld(), swapFrozenNames,
                        'lowball', PRE_SLEEP_LOWBALL_MAX_TURNOVER_MINUTES,
                        SLOW_PREFERRED_MIN_BUY_ETA_MINUTES, SLOW_PREFERRED_MAX_BUY_ETA_MINUTES,
                    );
                }
                if (!swapCandidate) {
                    swapCandidate = getFirstUnoccupiedMerchableItem(swapOccupiedNames, swapCoinCount, swapBuyLimitedNames, isMembersWorld(), swapFrozenNames, 'non-lowball');
                }
                if (!swapCandidate) {
                    swapCandidate = getFirstUnoccupiedMerchableItem(swapOccupiedNames, swapCoinCount, swapBuyLimitedNames, isMembersWorld(), swapFrozenNames, 'lowball');
                }
                if (swapCandidate) {
                    debugLog(bot, `Auto: aborting frozen fallback buy ${slot.itemName} in slot ${i + 1} (${(slot.progress * 100).toFixed(0)}% progress) — replacing with non-frozen merchable item ${swapCandidate.item.itemName}`);
                    bot.statusText = `[SWAP] [${slot.itemName} → ${swapCandidate.item.itemName}]`;
                    // Don't re-freeze — the item is already frozen.
                    // Clear any pending reprice — the item is being swapped out,
                    // not repriced.
                    loop.pendingReprices.delete(slot.itemName.trim().toLowerCase());
                    loop.buyRepriceCounts.delete(slot.itemName.trim().toLowerCase());
                    loop.activeAbortFlow = new AbortOfferFlow({
                        slotIndex: i,
                        delayFn: createDelay,
                        debugLog: (msg: string) => { if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg); },
                    });
                    const swapAbortEntry = cache.get(slot.itemName);
                    const swapMerch = getMerchableItem(slot.itemName);
                    loop.abortSlotInfo = {
                        type: 'buy',
                        itemName: slot.itemName,
                        progress: slot.progress,
                        reason: 'frozen swap-out',
                        category: 'swap' as AbortCategory,
                        etaMin: (swapAbortEntry?.purchaseEtaMinutes ?? 0) || (swapMerch ? swapMerch.purchaseEtaMinutes : 0),
                        requestedQty: slot.itemQuantity,
                        price: swapAbortEntry?.buyPrice ?? 0,
                        placedAt: swapAbortEntry?.offerPlacedAt ?? Date.now(),
                        countSellAbort: false,
                    };
                    loop.phase = 'aborting';
                    return true;
                }
                break; // only check the first frozen buy slot
            }
        }
        if (verboseIdleDiag) debugLog(bot, 'Auto: no empty slots for buying — all slots occupied');
        } // end else (merchable data valid)
    }

    // --- All slots occupied or nothing to do ---
    loop.phase = 'waiting';
    const idleDelay = createDelay(1, 100, 20);
    setAction(bot, 'auto_idle', idleDelay);
    const occupiedCount = slots.filter(s => s.type !== 'empty').length;
    // Compute the ETA-based break duration hint: the minimum remaining time
    // until the next action on any slot (earlier of completion or stale-abort
    // threshold). The break system uses this to time the return so the bot
    // logs back in when there's something to do. -1 = no ETA data (the break
    // system will fall back to a random 2-5 min duration).
    bot.nextActionEtaMin = computeNextActionEtaMin(slots, cache);

    // --- Idle activity ---
    // If an idle activity is selected (e.g. Chocolate Dust), start it
    // instead of signalling the break system. The bot stays logged in
    // and performs the activity until the next GE action is due, at
    // which point it cleans up (banks items) and resumes GE mode.
    // If the bank runs out of idle-activity items, the activity
    // transitions to 'depleted' and falls through to the normal
    // logout-on-idle behavior below. The idleActivityDepleted flag
    // prevents the idle activity from restarting for the rest of the
    // session (until script reload), so the bot doesn't loop between
    // starting the activity and immediately hitting depletion again.
    if (bot.idleActivityValue > 0 && !loop.idleActivityDepleted) {
        const etaMs = bot.nextActionEtaMin > 0
            ? bot.nextActionEtaMin * 60000
            : 120000; // default 2 min if no ETA data
        loop.idleActivityGeActionDueMs = Date.now() + etaMs;
        const activity = bot.idleActivityValue;
        if (activity === IDLE_ACTIVITY_ANY) {
            // "Any" mode — start the scanning phase. The scanning phase opens
            // the bank, checks which activities have ingredients, and randomly
            // picks one. When that activity depletes, the dispatch re-enters
            // the scanning phase to pick the next available activity.
            startScanning(loop);
            bot.statusText = `[IDLE] [${occupiedCount}/${slots.length} [Any]`;
            if (verboseIdleDiag) {
                bot.lastIdleDiagTick = tick;
                debugLog(bot, `Auto: starting idle activity (Any) — scanning bank for ingredients, next GE check in ${(etaMs / 60000).toFixed(1)}min`);
            }
        } else {
            let activityName: string;
            if (activity === IDLE_ACTIVITY_ULTRA_COMPOST) {
                activityName = 'Ultra Compost';
                startUltraCompost(loop);
            } else if (activity === IDLE_ACTIVITY_GOAT_HORN) {
                activityName = 'Goat Horn Dust';
                startGoatHorn(loop);
            } else {
                activityName = 'Chocolate Dust';
                startChocolateDust(loop);
            }
            bot.statusText = `[IDLE] [${occupiedCount}/${slots.length} slots] [${activityName}]`;
            if (verboseIdleDiag) {
                bot.lastIdleDiagTick = tick;
                debugLog(bot, `Auto: starting idle activity (${activityName}) — next GE check in ${(etaMs / 60000).toFixed(1)}min`);
            }
        }
        return true;
    }

    bot.statusText = `[IDLE] [${occupiedCount}/${slots.length} slots]`;
    // Signal that the auto-loop is idle — the break system will use this
    // to trigger a short logout break when auto mode is on.
    // The break system computes a randomised tick delay (5-20 ticks +
    // variance layers) before actually logging out.
    bot.loopIdleForBreak = true;
    // Throttle the idle diagnostic: log the "nothing to do" + ETA summary
    // every ~5 seconds (IDLE_DIAG_INTERVAL_TICKS) instead of every tick.
    if (verboseIdleDiag) {
        bot.lastIdleDiagTick = tick;
        debugLog(bot, `Auto: action=auto_idle delay=${fmtDelay(idleDelay)} (nothing to do — ${occupiedCount}/${slots.length} slots occupied)`);
        if (bot.nextActionEtaMin > 0) {
            debugLog(bot, `Auto: next action ETA ${bot.nextActionEtaMin.toFixed(1)}min (break will target this)`);
        }
    }
    // Note: do NOT set loopIdleSinceTick here — breakStep() in session.ts
    // sets it and computes the randomised pre-logout delay. If we set it
    // here, breakStep() skips the delay computation and logs out immediately.
    return true;
};

// --- Reset (called on onEnable / mode switch) ------------------------------

export const resetAutoLoop = (bot: StarkMercher): void => {
    const loop = bot.autoLoop;
    loop.phase = 'idle';
    loop.activeBuyFlow = null;
    loop.activeSellFlow = null;
    loop.activeAbortFlow = null;
    loop.targetSlotIndex = -1;
    loop.lastActionMs = 0;
    loop.profilesInitialised = false;
    loop.cache = null;
    loop.sellAttemptedItems.clear();
    loop.buyAttemptedItems.clear();
    // Restore the global buy-freeze map from the hidden setting so freezes
    // survive hot reloads and client restarts. Expired entries are dropped
    // during load. The freeze map is global (not account-keyed) — freezes
    // represent market/item-level signals, not account-specific state.
    loop.buyFreezeUntil = loadBuyFreeze(bot);
    loop.buyFreezeSources = new Map();
    loop.historicalProtectionsApplied = new Set();
    loop.itemAbortCounts = loadItemAbortCounts(bot);
    loop.failureCounters = {};
    loop.lastGeOpenDispatchMs = 0;
    loop.lastCollectDispatchMs = 0;
    loop.pendingReprices = new Map();
    loop.buyRepriceCounts = new Map();
    loop.idleActivityPhase = 'none';
    loop.idleActivitySubStep = 0;
    loop.idleActivityLastTick = -1;
    loop.idleActivityGeActionDueMs = 0;
    loop.idleActivityCurrent = 0;
    loop.idleActivityAnyDepleted = new Set();
    loop.idleActivityCleanupForGe = false;
    bot.geOfferCompletedChatMs = 0;
};
