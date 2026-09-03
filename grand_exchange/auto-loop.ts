// ============================================================================
// Auto-merch loop — the main automation state machine
// ============================================================================
// This is the production loop that runs when "Auto Merch" mode is enabled.
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
import { setAction } from '../general/timing.js';
import { formatQty, formatGpShort } from '../general/helpers.js';
import { createDelay, getActiveDelayProfile, setDelayProfileForAccount } from '../antiban/humanised-delay.js';
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
    type OfferSlotState,
    type GeAudit,
} from './widgets.js';
import { clickCollectToInventory } from './actions.js';
import { getNetSellPrice, getGeTax } from './constants.js';
import { openGe, nearGrandExchange, walkToGe } from './clerk.js';
import { getMerchableItems, getMerchableItem, getFirstUnoccupiedMerchableItem, getFirstPartialBuyItem, isLowballItem, evaluateItemAtRuntime, RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM, RUNTIME_MAX_TURNOVER_MINUTES, type MerchableItem, type PartialBuyResult, type BuyScanResult, type LowballTier } from '../data/merchable-items.js';
import { getCrossAccountBuyingItemCount } from '../general/state-persist.js';
import { getRoster } from '../antiban/account-rotation.js';
import { getPriceHistoryEntry } from '../data/price-history.js';
import { OfferCacheManager } from '../data/offer-cache.js';
import { addDailyProfit, getDailyProfit } from '../data/daily-profit.js';
import { recordMerchCycle, type MerchHistoryEntry } from '../data/merch-history.js';
import { recordAbort, type AbortCategory } from '../data/abort-history.js';

// --- Stale offer thresholds ------------------------------------------------
// Sell: dynamic % of ETA passed with <25% sold → abort (scaled by profit margin)
// Buy (0 bought): 125% of ETA passed with 0 bought → abort
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
// The sell ETA abort ratio scales with profit margin so that thin-margin
// items get more time to sell (a 1gp cut on a 2gp margin is 50% of profit),
// while high-margin items are revised sooner (a 5k cut on 100k is only 5%).
// Formula: clamp(0.95 - log10(profit) * 0.075, 0.50, 0.95)

const SELL_PROGRESS_ABORT_THRESHOLD = 0.25; // <25% sold
const SELL_ETA_ABORT_RATIO_STALLED = 1.0; // 100% of sell ETA (stalled near completion)
const SELL_PROGRESS_STALLED_THRESHOLD = 0.50; // >=50% sold but not completing

/**
 * Computes the dynamic sell ETA abort ratio based on the profit margin.
 * Thin-margin items get up to 95% of ETA; high-margin items as low as 50%.
 */
const computeSellEtaAbortRatio = (profit: number): number => {
    if (profit <= 0) return 0.95;
    const ratio = 0.95 - Math.log10(profit) * 0.075;
    return Math.max(0.50, Math.min(0.95, ratio));
};
const BUY_ETA_ABORT_RATIO_ZERO = 1.25;   // 125% of buy ETA (0 bought)
const BUY_ETA_ABORT_RATIO_MULTI = 0.90;  // 90% of buy ETA (<50% bought)
const BUY_PROGRESS_ABORT_THRESHOLD = 0.50; // <50% bought
const BUY_ETA_ABORT_RATIO_STALLED = 1.0; // 100% of buy ETA (stalled near completion)
const BUY_PROGRESS_STALLED_THRESHOLD = 0.50; // >=50% bought but not completing

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
            titan.logf('[Stark Mercher] Migrated buy-freeze setting to global format (%d active entries).', result.size);
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
    crossAccountSkipNames: Set<string> = new Set(),
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
        if (crossAccountSkipNames.has(lower)) continue;
        if (!membersWorld && item.members) continue;
        if (lowballTier === 'non-lowball' && isLowballItem(item)) continue;
        if (lowballTier === 'lowball' && !isLowballItem(item)) continue;
        // Evaluate at runtime based on actual coins.
        const evalResult = evaluateItemAtRuntime(item, coinCount);
        if (!evalResult) continue;
        if (evalResult.runtimeProfitPerSlotHour < RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM) continue;
        if (evalResult.runtimeTurnoverEtaMinutes > RUNTIME_MAX_TURNOVER_MINUTES) continue;
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
    minProfitGp: number = 15000,
    lowballTier: LowballTier = 'any',
    crossAccountSkipNames: Set<string> = new Set(),
): PartialBuyResult | null => {
    const sorted = [...buyFreezeUntil.entries()]
        .sort((a, b) => a[1] - b[1]);
    for (const [name] of sorted) {
        const item = getMerchableItem(name);
        if (!item) continue;
        const lower = item.itemName.trim().toLowerCase();
        if (occupiedNames.has(lower)) continue;
        if (buyLimitedNames.has(lower)) continue;
        if (crossAccountSkipNames.has(lower)) continue;
        if (!membersWorld && item.members) continue;
        if (lowballTier === 'non-lowball' && isLowballItem(item)) continue;
        if (lowballTier === 'lowball' && !isLowballItem(item)) continue;
        // Evaluate at runtime with lower thresholds for fallback.
        const evalResult = evaluateItemAtRuntime(item, coinCount);
        if (!evalResult) continue;
        if (evalResult.runtimeProfitPerSlotHour < 5000) continue;
        if (evalResult.runtimeTurnoverEtaMinutes > 240) continue;
        return {
            item,
            quantity: evalResult.runtimeQuantity,
            totalCost: evalResult.runtimeTotalCost,
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
    cacheReconciled: false,
    cacheReconstructed: false,
    needsPostLoginCleanup: true,
    abortSlotInfo: null,
    lastCleanupMs: 0,
    failureCounters: {},
    lastGeOpenDispatchMs: 0,
    lastCollectDispatchMs: 0,
});

// --- Helper: initialise profiles ------------------------------------------

const ensureProfiles = (bot: StarkMercher): void => {
    if (bot.autoLoop.profilesInitialised) return;
    const playerName = titan.state.client.localPlayer?.name;
    if (playerName) {
        setDelayProfileForAccount(playerName);
        const delayProfile = getActiveDelayProfile();
        if (delayProfile) setClickJitterProfile(generateClickJitterProfile(delayProfile));
        setTypingMistakeProfileForAccount(playerName);
    }
    setClickJitterDebugLog((msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); });
    setTypingMistakeDebugLog((msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); });
    bot.autoLoop.profilesInitialised = true;
};

// --- Helper: ensure cache is loaded ---------------------------------------

const ensureCache = (bot: StarkMercher): OfferCacheManager => {
    if (!bot.autoLoop.cache) {
        const playerName = titan.state.client.localPlayer?.name ?? 'unknown';
        bot.autoLoop.cache = new OfferCacheManager(bot, playerName);
    }
    return bot.autoLoop.cache;
};

// --- Helper: debug log -----------------------------------------------------

const debugLog = (bot: StarkMercher, msg: string): void => {
    if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg);
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

    const now = Date.now();
    const elapsedMs = now - entry.offerPlacedAt;
    const elapsedMin = elapsedMs / 60000;

    // We never abort sell offers for items we already own — we need to sell
    // them to recover our investment regardless of whether they're still
    // merchable candidates. Only ETA-based staleness applies to sell offers.

    // Use live merchable data for ETA if available; fall back to the ETA
    // cached at buy time if the item has been removed from merchableItems.json.
    const merch = getMerchableItem(slot.itemName);
    const eta = merch ? merch.saleEtaMinutes : (entry.saleEtaMinutes ?? 0);
    if (eta <= 0) return null; // no ETA data at all — can't determine staleness

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

    // Use live merchable data for ETA if available; fall back to the ETA
    // cached at buy time if the item has been removed from merchableItems.json.
    const merch = getMerchableItem(slot.itemName);
    const eta = merch ? merch.purchaseEtaMinutes : (entry.purchaseEtaMinutes ?? 0);
    if (eta <= 0) return null; // no ETA data at all — can't determine staleness

    // Buy (0 bought): 125% of ETA passed with 0 bought → abort
    const etaThresholdZero = eta * BUY_ETA_ABORT_RATIO_ZERO;
    if (slot.progress <= 0 && elapsedMin >= etaThresholdZero) {
        return `ETA exceeded (0 bought): ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdZero.toFixed(1)}min (${(BUY_ETA_ABORT_RATIO_ZERO * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress 0% — buy price ${entry.buyPrice}gp`;
    }

    // Buy (multi-qty): 90% of ETA passed with <50% bought → abort
    const etaThresholdMulti = eta * BUY_ETA_ABORT_RATIO_MULTI;
    if (slot.itemQuantity > 1 && slot.progress < BUY_PROGRESS_ABORT_THRESHOLD && elapsedMin >= etaThresholdMulti) {
        return `ETA exceeded (partial): ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdMulti.toFixed(1)}min (${(BUY_ETA_ABORT_RATIO_MULTI * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress ${(slot.progress * 100).toFixed(1)}% < ${(BUY_PROGRESS_ABORT_THRESHOLD * 100).toFixed(0)}% — buy price ${entry.buyPrice}gp`;
    }

    // Buy (stalled near completion): 100% of ETA passed with >=50% bought
    // but offer hasn't completed. The last 5% may never fill due to price
    // shifts — abort so we can sell what we have and free the slot.
    const etaThresholdStalled = eta * BUY_ETA_ABORT_RATIO_STALLED;
    if (slot.itemQuantity > 1 && slot.progress >= BUY_PROGRESS_STALLED_THRESHOLD && elapsedMin >= etaThresholdStalled) {
        return `stalled near completion: ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdStalled.toFixed(1)}min (${(BUY_ETA_ABORT_RATIO_STALLED * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress ${(slot.progress * 100).toFixed(1)}% — buy price ${entry.buyPrice}gp`;
    }

    return null;
};

// --- Helper: compute next-action ETA for break timing ----------------------
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
            eta = merch ? merch.purchaseEtaMinutes : (entry.purchaseEtaMinutes ?? 0);
            if (eta <= 0) continue;
            // 0% progress: stale at 125% of ETA (later than completion)
            // <50% progress: stale at 90% of ETA (earlier than completion)
            // >=50% progress: stalled check at 100% of ETA (same as completion)
            if (slot.progress < BUY_PROGRESS_ABORT_THRESHOLD && slot.itemQuantity > 1) {
                abortRatio = BUY_ETA_ABORT_RATIO_MULTI;
            }
        } else if (slot.type === 'sell') {
            const merch = getMerchableItem(slot.itemName);
            eta = merch ? merch.saleEtaMinutes : (entry.saleEtaMinutes ?? 0);
            if (eta <= 0) continue;
            // <25% progress: stale at dynamic ratio (50-95%, earlier than completion)
            // >=50% progress: stalled check at 100% of ETA (same as completion)
            if (slot.progress < SELL_PROGRESS_ABORT_THRESHOLD) {
                const profit = entry.sellPrice - entry.buyPrice;
                abortRatio = computeSellEtaAbortRatio(profit);
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
    ensureProfiles(bot);
    const cache = ensureCache(bot);
    const loop = bot.autoLoop;

    // --- Cached inventory snapshot ---
    // Build a name→Item map once per tick from a single getAll() call.
    // This replaces multiple titan.utils.inventory.find(name) calls (each
    // creates a native query handle) with a map lookup. The find() calls
    // were in: completed-sell sweep, cache reconciliation, abort completion,
    // and sell scan — up to 5+ separate native queries per tick.
    // The snapshot is built lazily — only accessed when a section needs it.
    let invSnapshot: Map<string, titan.Item> | null = null;
    const getInvSnapshot = (): Map<string, titan.Item> => {
        if (invSnapshot) return invSnapshot;
        invSnapshot = new Map();
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
        // Clear the half-ETA check flag — the bot did something on the
        // previous tick (collect/sell/buy/abort), so the next break should
        // start fresh at 50% ETA.
        bot.checkedAtHalfEta = false;
    }

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
            if (now >= until) { loop.buyFreezeUntil.delete(name); freezeRemoved = true; }
        }
        if (freezeRemoved) saveBuyFreeze(bot, loop.buyFreezeUntil);
        if (removed > 0) cache.save();
        loop.lastCleanupMs = now;
    }

    // --- Periodic cache cleanup (every 60s) ---
    // During long sessions without breaks (e.g. all slots occupied, no idle
    // time to trigger a short break), expired 'idle' entries and expired
    // buy-freeze entries can accumulate. This periodic sweep keeps the cache
    // bounded. The cost is one cache iteration per 60 seconds — negligible.
    const cleanupNow = Date.now();
    if (cleanupNow - loop.lastCleanupMs >= 60_000) {
        const removed = cache.cleanupExpiredIdleEntries();
        let freezeRemoved = false;
        for (const [name, until] of loop.buyFreezeUntil) {
            if (cleanupNow >= until) { loop.buyFreezeUntil.delete(name); freezeRemoved = true; }
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
            debugLog(bot, `Auto: ticking buy flow for ${flow.itemName}`);
            if (flow.tick()) {
                setAction(bot, 'auto_buy', flow.lastDelay);
            }
            return true;
        }
        if (flow.status === 'done') {
            titan.log('[Stark Mercher] Auto: buy offer placed successfully.');
            // Save the cache after recording the buy offer.
            cache.save();
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: buy offer failed: %s', flow.error);
        }
        loop.activeBuyFlow = null;
        loop.phase = 'idle';
        bot.statusText = '';
        const delay = createDelay(1, 35, 8);
        setAction(bot, 'auto_idle', delay);
        debugLog(bot, `Auto: action=auto_idle delay=${delay}t (buy flow ended)`);
        return true;
    }

    if (loop.activeSellFlow) {
        const flow = loop.activeSellFlow;
        if (flow.status === 'in_progress') {
            debugLog(bot, `Auto: ticking sell flow for ${flow.itemName}`);
            if (flow.tick()) {
                setAction(bot, 'auto_sell', flow.lastDelay);
            }
            return true;
        }
        if (flow.status === 'done') {
            titan.log('[Stark Mercher] Auto: sell offer placed successfully.');
            // Mark the sell as confirmed — the offer is now live on the GE.
            // This tells the re-list logic that a future abort+re-list is a
            // genuine "didn't sell" event worthy of a price revision.
            cache.confirmSellOffer(flow.itemName);
            cache.save();
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: sell offer failed: %s', flow.error);
        }
        loop.activeSellFlow = null;
        loop.phase = 'idle';
        bot.statusText = '';
        const delay = createDelay(1, 35, 8);
        setAction(bot, 'auto_idle', delay);
        debugLog(bot, `Auto: action=auto_idle delay=${delay}t (sell flow ended)`);
        return true;
    }

    if (loop.activeAbortFlow) {
        const flow = loop.activeAbortFlow;
        if (flow.status === 'in_progress') {
            debugLog(bot, `Auto: ticking abort flow for slot ${flow.slotIndex + 1}`);
            if (flow.tick()) {
                setAction(bot, 'auto_abort', flow.lastDelay);
            }
            return true;
        }
        if (flow.status === 'done') {
            titan.log('[Stark Mercher] Auto: offer aborted successfully.');
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
                const inInventory = findInInv(itemName);
                if (inInventory) {
                    // The buy partially filled during the abort flow — items
                    // were collected to inventory. Keep the cache entry so
                    // buy-limit tracking is preserved. The sell scan will
                    // pick up the items and sell them in the next iteration.
                    debugLog(bot, `Auto: keeping cache entry for ${itemName} (buy offer partially filled during abort — items in inventory, buy-limit tracking preserved)`);
                } else {
                    cache.remove(itemName);
                    cache.save();
                    debugLog(bot, `Auto: removed cache entry for ${itemName} (buy offer aborted with 0% progress — nothing to collect)`);
                }
            }
            // Record abort history entry for diagnostics. This captures
            // aborted offers (including 0-fill buys that leave no trace in
            // merch history) so we can diagnose low overnight profit.
            const abortPlayerName = bot.currentPlayerName || titan.state.client.localPlayer?.name || '';
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
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: abort failed: %s', flow.error);
        }
        loop.activeAbortFlow = null;
        loop.abortSlotInfo = null;
        loop.phase = 'idle';
        bot.statusText = '';
        const delay = createDelay(1, 35, 8);
        setAction(bot, 'auto_idle', delay);
        debugLog(bot, `Auto: action=auto_idle delay=${delay}t (abort flow ended)`);
        return true;
    }

    // --- Step 1: Check if GE is open ---
    if (!isGeOpen()) {
        // GE not open — try to open it.
        if (!nearGrandExchange()) {
            debugLog(bot, 'Auto: GE not open and not near GE — walking to GE');
            bot.statusText = 'Walking to Grand Exchange';
            walkToGe();
            const delay = createDelay(5, 30, 8);
            setAction(bot, 'auto_walk', delay);
            debugLog(bot, `Auto: action=auto_walk delay=${delay}t`);
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
            bot.statusText = 'Opening Grand Exchange';
            const delay = createDelay(3, 8, 6);
            setAction(bot, 'auto_open_ge', delay);
            debugLog(bot, `Auto: action=auto_open_ge delay=${delay}t (wall-clock cooldown)`);
            return true;
        }
        debugLog(bot, 'Auto: GE not open, near GE — opening via clerk/booth');
        bot.statusText = 'Opening Grand Exchange';
        if (openGe()) {
            loop.lastGeOpenDispatchMs = Date.now();
            const failures = recordFailure(loop, 'geOpen');
            debugLog(bot, `Auto: GE open click dispatched (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
            if (checkFailureTerminate(bot, loop, 'geOpen', 'Opening Grand Exchange')) return true;
            const delay = createDelay(6, 15, 3);
            setAction(bot, 'auto_open_ge', delay);
            debugLog(bot, `Auto: action=auto_open_ge delay=${delay}t (waiting for GE to open)`);
        } else {
            // Couldn't find clerk or booth — wait and retry.
            const failures = recordFailure(loop, 'geOpen');
            debugLog(bot, `Auto: no clerk/booth found — waiting (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
            if (checkFailureTerminate(bot, loop, 'geOpen', 'Finding G.E clerk/booth')) return true;
            bot.statusText = 'Searching for G.E clerk/booth';
            const delay = createDelay(5, 50, 8);
            setAction(bot, 'auto_wait', delay);
            debugLog(bot, `Auto: action=auto_wait delay=${delay}t (no clerk/booth)`);
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
        bot.statusText = 'Closing GE sub-screen';
        sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Escape), { reason: 'close GE sub-screen' });
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
    debugLog(bot, `Auto: GE open — slots: ${slotSummary}`);

    // --- Step 2b: One-time cache reconciliation (startup) ---
    // On the first GE-open tick after script start, remove orphaned cache
    // entries — items that are not in any GE slot, not in inventory, and not
    // referenced by an active flow. These are leftover entries from completed
    // merches whose cache.remove() didn't run before the script restarted.
    if (!loop.cacheReconciled) {
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
            titan.logf('[Stark Mercher] Auto: cache reconciliation removed %d orphaned entr%s: %s',
                removed.length, removed.length === 1 ? 'y' : 'ies', removed.join(', '));
        } else {
            debugLog(bot, 'Auto: cache reconciliation — no orphaned entries');
        }
    }

    // --- Step 2c: Reverse reconciliation (reconstruct missing cache entries) ---
    // After a client restart that loses the hidden cache setting, active GE
    // offers survive on the server but have no cache entry. Without
    // reconstruction, the staleness checks bail out (they need offerPlacedAt),
    // completed sells lose their profit, and stuck offers sit forever.
    // This step iterates over occupied slots and reconstructs cache entries
    // from merchableItems.json / priceHistory.json so the bot can manage them.
    if (!loop.cacheReconstructed) {
        loop.cacheReconstructed = true;
        const reconstructed: string[] = [];
        const skipped: string[] = [];
        for (const slot of slots) {
            if (slot.type === 'empty' || !slot.itemName) continue;
            const lower = slot.itemName.trim().toLowerCase();
            if (cache.get(slot.itemName)) continue; // already has an entry
            // Only reconstruct active or completed/aborted offers with a
            // known type. Skip 'unknown' status slots (can't determine type).
            if (slot.type !== 'buy' && slot.type !== 'sell') continue;
            const created = cache.reconstructEntry(
                slot.itemName,
                slot.type,
                slot.itemQuantity,
            );
            if (created) {
                reconstructed.push(`${slot.itemName} (${slot.type})`);
            } else {
                skipped.push(slot.itemName);
            }
        }
        if (reconstructed.length > 0) {
            cache.save();
            titan.logf('[Stark Mercher] Auto: reverse reconciliation reconstructed %d entr%s: %s',
                reconstructed.length, reconstructed.length === 1 ? 'y' : 'ies', reconstructed.join(', '));
        } else {
            debugLog(bot, 'Auto: reverse reconciliation — no missing entries');
        }
        if (skipped.length > 0) {
            titan.logf('[Stark Mercher] Auto: reverse reconciliation skipped %d slot(s) (no price data): %s',
                skipped.length, skipped.join(', '));
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
    const playerName = bot.currentPlayerName || titan.state.client.localPlayer?.name || '';
    if (cache.hasActiveSellEntries()) {
    for (const cacheKey of cache.getAllItemNames()) {
        const entry = cache.get(cacheKey);
        if (!entry || entry.mode !== 'sell' || entry.sellQuantity === undefined || entry.sellQuantity <= 0) continue;
        // Is this item still in any GE slot? (active or completed/aborted)
        const inSlot = slots.some(s => s.itemName && s.itemName.trim().toLowerCase() === cacheKey.trim().toLowerCase());
        if (inSlot) continue; // still in a slot — not yet collected
        // Is this item in inventory? (returned after an abort — profit
        // will be recorded at re-list time in Step 5)
        const inInv = findInInv(cacheKey);
        if (inInv) continue; // in inventory — abort case, handled at re-list
        // Item is not in any slot or inventory → sell completed 100%.
        // CAPTURE all profit/history data from the cache entry BEFORE clearing
        // and saving. The cache must be persisted (with sell fields cleared)
        // BEFORE we write to dailyProfit/merchHistory. This prevents double-
        // counting on hot-reload: if we crash after profit is written but
        // before the cache is saved, the sweep would re-trigger and record
        // the profit again. By saving the cache first, a crash between the
        // cache save and the profit write loses one tracking entry (the GP
        // is still correct in the coin pouch) — far better than double-counting.
        const soldQty = entry.sellQuantity;
        const netSellPrice = getNetSellPrice(entry.sellPrice);
        const profitPerItem = netSellPrice - entry.buyPrice;
        const profit = profitPerItem * soldQty;
        const taxPerItem = getGeTax(entry.sellPrice);
        // Record the final partial sale batch so we can compute the merch
        // history summary from all partial sales (including this one).
        cache.recordPartialSale(cacheKey, entry.sellPrice, soldQty);
        const partials = cache.getPartialSales(cacheKey);
        // Capture merch history data from the entry BEFORE clearing.
        let merchEntry: Omit<MerchHistoryEntry, 'profit'> | null = null;
        let merchProfit = 0;
        if (partials.length > 0 && playerName) {
            const totalQty = partials.reduce((s, p) => s + p.qty, 0);
            const weightedSum = partials.reduce((s, p) => s + p.price * p.qty, 0);
            const avgSold = totalQty > 0 ? Math.round(weightedSum / totalQty) : 0;
            const netAvgSold = getNetSellPrice(avgSold);
            merchProfit = (netAvgSold - entry.buyPrice) * totalQty;
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
        if (profit !== 0 && playerName) {
            addDailyProfit(bot, playerName, profit);
            // Cache the updated daily profit for the overlay.
            bot.cachedDailyProfit = getDailyProfit(bot, playerName);
            bot.cachedDailyProfitAccount = playerName;
            debugLog(bot, `Auto: daily profit += ${profit}gp (${soldQty}x ${cacheKey} @ ${profitPerItem}gp/item net — sell=${entry.sellPrice}gp, tax=${taxPerItem}gp, buy=${entry.buyPrice}gp — 100% completed sell)`);
        }
        if (merchEntry && playerName && merchProfit !== 0) {
            recordMerchCycle(bot, playerName, merchEntry, merchProfit);
            debugLog(bot, `Auto: merch history recorded — ${cacheKey} ${merchEntry.qty}x, avgSold=${merchEntry.avgSold}gp (net=${getNetSellPrice(merchEntry.avgSold)}gp after tax), buy=${entry.buyPrice}gp, profit=${merchProfit}gp, revisions=${merchEntry.revisions}, sellElapsed=${merchEntry.sellElapsedMin ?? '?'}min, revisionPrices=[${merchEntry.revisionPrices?.join(',') ?? ''}]`);
        }
        debugLog(bot, `Auto: completed-sell sweep — ${cacheKey} sold 100% (${soldQty}x), profit recorded, buy-limit data preserved`);
    }
    } // end hasActiveSellEntries fast-path

    if (hasCompletedOrAbortedSlot(slots)) {
        // Completed/aborted slot detected — click collect to inventory.
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
            bot.statusText = 'Collecting from G.E';
            const delay = createDelay(3, 8, 6);
            setAction(bot, 'auto_collect', delay);
            debugLog(bot, `Auto: action=auto_collect delay=${delay}t (wall-clock cooldown)`);
            return true;
        }
        const failures = recordFailure(loop, 'collect');
        debugLog(bot, `Auto: completed/aborted offer detected — collecting to inventory (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (checkFailureTerminate(bot, loop, 'collect', 'Collecting completed/aborted offer')) return true;
        bot.statusText = 'Collecting from G.E';
        if (clickCollectToInventory()) {
            loop.lastCollectDispatchMs = Date.now();
            const delay = createDelay(2, 40, 8);
            setAction(bot, 'auto_collect', delay);
            debugLog(bot, `Auto: action=auto_collect delay=${delay}t`);
        } else {
            // Collect widget not clickable — wait.
            const delay = createDelay(2, 40, 8);
            setAction(bot, 'auto_wait', delay);
            debugLog(bot, `Auto: action=auto_wait delay=${delay}t (collect not clickable)`);
        }
        return true;
    }
    // No completed/aborted slots — reset the collect failure counter.
    resetFailure(loop, 'collect');

    // --- Step 4: Stale offers flow ---
    // Check each occupied slot for stale conditions.
    debugLog(bot, 'Auto: checking for stale offers');
    bot.statusText = 'Checking for stale offers';
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot.type === 'empty' || slot.status !== 'active') continue;

        const sellReason = slot.type === 'sell' ? isSellOfferStale(slot, cache) : null;
        const buyReason = slot.type === 'buy' ? isBuyOfferStale(slot, cache) : null;
        if (sellReason || buyReason) {
            const reason = sellReason ?? buyReason ?? '';
            debugLog(bot, `Auto: aborting stale offer in slot ${i + 1} (${slot.type} ${slot.itemName} — ${reason})`);
            bot.statusText = `Aborting stale offer for ${slot.itemName ?? 'unknown'} in slot ${i + 1}`;
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
            const isConfigAborrt = reason.startsWith('no longer in merchableItems.json');
            if (slot.type === 'buy' && slot.itemName && !isConfigAborrt) {
                const freezeKey = slot.itemName.trim().toLowerCase();
                const existingFreeze = loop.buyFreezeUntil.get(freezeKey);
                if (existingFreeze && existingFreeze > Date.now()) {
                    debugLog(bot, `Auto: ${slot.itemName} already frozen (expires in ${Math.round((existingFreeze - Date.now()) / 60000)} min) — not re-freezing`);
                } else {
                    const freezeUntil = Date.now() + BUY_FREEZE_DURATION_MS;
                    loop.buyFreezeUntil.set(freezeKey, freezeUntil);
                    saveBuyFreeze(bot, loop.buyFreezeUntil);
                    titan.logf('[Stark Mercher] Auto: freezing %s from buying for %d min (buy offer aborted — %s)',
                        slot.itemName, Math.round(BUY_FREEZE_DURATION_MS / 60000), reason);
                }
            }
            loop.activeAbortFlow = new AbortOfferFlow({
                slotIndex: i,
                delayFn: createDelay,
                debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
            });
            // Record slot info so we can clean up the cache entry on abort
            // completion and record an abort history entry for diagnostics.
            // Buy offers with 0% progress have nothing to collect, so the
            // cache entry is removed. Partial buys keep their entry (collected
            // items will be sold in the next loop iteration).
            if (slot.itemName) {
                const abortEntry = cache.get(slot.itemName);
                const merch = getMerchableItem(slot.itemName);
                const etaMin = slot.type === 'buy'
                    ? (merch ? merch.purchaseEtaMinutes : (abortEntry?.purchaseEtaMinutes ?? 0))
                    : (merch ? merch.saleEtaMinutes : (abortEntry?.saleEtaMinutes ?? 0));
                const price = slot.type === 'buy'
                    ? (abortEntry?.buyPrice ?? 0)
                    : (abortEntry?.sellPrice ?? 0);
                loop.abortSlotInfo = {
                    type: slot.type as 'buy' | 'sell',
                    itemName: slot.itemName,
                    progress: slot.progress,
                    reason,
                    category: 'eta' as AbortCategory,
                    etaMin,
                    requestedQty: slot.itemQuantity,
                    price,
                    placedAt: abortEntry?.offerPlacedAt ?? Date.now(),
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
                const eta = merch
                    ? (slot.type === 'sell' ? merch.saleEtaMinutes : merch.purchaseEtaMinutes)
                    : (slot.type === 'sell' ? (entry.saleEtaMinutes ?? 0) : (entry.purchaseEtaMinutes ?? 0));
                const ratio = eta > 0 ? (elapsedMin / eta) * 100 : 0;
                const etaSource = merch ? '' : ' (cached)';
                debugLog(bot, `Auto: slot ${i + 1} ${slot.type} ${slot.itemName} — ${(slot.progress * 100).toFixed(1)}% progress, ${elapsedMin.toFixed(1)}min/${eta.toFixed(1)}min ETA${etaSource} (${ratio.toFixed(0)}%), not stale`);
            }
        }
    }
    debugLog(bot, 'Auto: no stale offers found');

    // --- Step 5: Selling flow ---
    // Check for empty slots and inventory items to sell.
    const emptySlot = findEmptyOfferSlot();
    if (emptySlot !== -1) {
        // Get inventory items from the cached snapshot (single getAll()
        // call already made for this tick, shared across all sections).
        const invItems = [...getInvSnapshot().values()];
        const occupiedNames = getOccupiedItemNames(slots);
        const sellableItems = invItems.filter(i => i.id !== 995);
        debugLog(bot, `Auto: sell scan — empty slot ${emptySlot + 1}, ${sellableItems.length} non-coin inv item(s)${sellableItems.length > 0 ? ': ' + sellableItems.map(i => `${i.name}x${i.quantity}`).join(', ') : ''}`);

        for (const item of invItems) {
            // Skip coins (ID 995).
            if (item.id === 995) continue;

            const itemName = item.name.trim();
            const lowerName = itemName.toLowerCase();

            // Skip items we've already tried to sell this loop iteration.
            if (loop.sellAttemptedItems.has(lowerName)) continue;

            // Skip items that are currently being bought in a GE slot.
            // When we collect a partially bought offer, the items go to
            // inventory, but we don't want to sell them until the buy
            // offer completes or is aborted. Items that are only being
            // SOLD in another slot are NOT skipped — OSRS allows the same
            // item to be listed in multiple sell slots simultaneously.
            if (occupiedNames.has(lowerName)) {
                let skipForBuy = false;
                for (const slot of slots) {
                    if (slot.itemName && slot.itemName.trim().toLowerCase() === lowerName && slot.type === 'buy') {
                        debugLog(bot, `Auto: skipping ${itemName} — currently being bought in a GE slot`);
                        loop.sellAttemptedItems.add(lowerName);
                        skipForBuy = true;
                        break;
                    }
                }
                if (skipForBuy) continue;
            }

            // This item is not being bought — we can sell it.
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
                    sellPrice = history.sell;
                    fallbackBuyPrice = history.buy;
                    debugLog(bot, `Auto: using priceHistory fallback for ${itemName} — sell=${sellPrice}gp, buy=${fallbackBuyPrice}gp`);
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
                    pendingPartialLog = `daily profit += ${pendingPartialProfit}gp (${soldQty}x ${itemName} sold @ ${profitPerItem}gp/item net — sell=${existingEntry.sellPrice}gp, tax=${taxPerItem}gp, buy=${existingEntry.buyPrice}gp before abort)`;
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
                        if (revCount >= 8) {
                            debugLog(bot, `Auto: ${itemName} final dump — selling at ${revisedPrice}gp (revision ${revCount}) to free slot`);
                        } else if (revCount >= 6) {
                            debugLog(bot, `Auto: ${itemName} abandoned — selling at ${revisedPrice}gp (revision ${revCount}, floor dropped to buy-2)`);
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
                if (fastSellBuyPrice > 0 && halvedPrice <= fastSellBuyPrice) {
                    // Halving would sell at or below buy price — skip fast-sell
                    // and sell at normal price to avoid a loss.
                    debugLog(bot, `Auto: skipping fast-sell for ${itemName} — halved price ${halvedPrice}gp <= buy price ${fastSellBuyPrice}gp (would sell at a loss)`);
                } else {
                    fastSell = true;
                    sellPrice = halvedPrice;
                    titan.logf('[Stark Mercher] Auto: fast-selling %dx %s @ %dgp each (50%% of sell price — small qty, low value, freeing slot)',
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
            cache.recordSellOffer(itemName, sellPrice, buyPrice, item.quantity, limit);
            // SAVE the cache BEFORE writing daily profit. This ensures that
            // if we crash between the cache save and the profit write, the
            // cache already reflects the new sell state (sellQuantity = current
            // inventory qty) so the partial profit won't be re-computed on
            // restart. We lose one profit tracking entry at worst, not a
            // double-count.
            cache.save();
            // Now safe to write the pending partial profit.
            if (pendingPartialProfit !== 0 && playerName) {
                addDailyProfit(bot, playerName, pendingPartialProfit);
                // Cache the updated daily profit for the overlay.
                bot.cachedDailyProfit = getDailyProfit(bot, playerName);
                bot.cachedDailyProfitAccount = playerName;
                debugLog(bot, `Auto: ${pendingPartialLog}`);
            }

            // Start the sell flow.
            if (fastSell) {
                debugLog(bot, `Auto: fast-selling ${item.quantity}x ${itemName} @ ${sellPrice}gp each in slot ${emptySlot + 1} (50%% of sell price)`);
            } else {
                debugLog(bot, `Auto: selling ${item.quantity}x ${itemName} @ ${sellPrice}gp each in slot ${emptySlot + 1}`);
            }
            bot.statusText = `Selling ${formatQty(item.quantity)} ${itemName} for ${formatGpShort(sellPrice * item.quantity)} (${sellPrice}ea)`;
            loop.activeSellFlow = new SellOfferFlow({
                itemName,
                quantity: item.quantity,
                price: sellPrice,
                delayFn: createDelay,
                debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
            });
            loop.phase = 'selling';
            loop.sellAttemptedItems.clear(); // reset for next iteration
            return true;
        }

        // No sellable items found in inventory — clear the attempted set
        // and fall through to the buying flow.
        debugLog(bot, 'Auto: no sellable items found in inventory — falling through to buying');
        loop.sellAttemptedItems.clear();
    } else {
        // No empty slots for selling. Check if there are sellable items in
        // inventory that need a slot. If so, abort the oldest buy offer with
        // 0% progress (nothing bought yet — no loss) to free a slot for the
        // sell. This keeps the slot usage dynamic: all 8 slots can be used
        // for buys, but when a sale is needed we sacrifice the least-
        // productive buy (oldest 0-progress) to make room.
        const invItemsForAbort = [...getInvSnapshot().values()];
        const sellableForAbort = invItemsForAbort.filter(i => i.id !== 995);
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
                // Find the oldest buy offer with 0% progress (nothing bought).
                let oldestSlotIdx = -1;
                let oldestPlacedAt = Infinity;
                for (let i = 0; i < slots.length; i++) {
                    const s = slots[i];
                    if (s.type !== 'buy' || s.status !== 'active' || s.progress > 0) continue;
                    if (!s.itemName) continue;
                    const entry = cache.get(s.itemName);
                    const placedAt = entry?.offerPlacedAt ?? Infinity;
                    if (placedAt < oldestPlacedAt) {
                        oldestPlacedAt = placedAt;
                        oldestSlotIdx = i;
                    }
                }
                if (oldestSlotIdx !== -1) {
                    const abortSlot = slots[oldestSlotIdx];
                    debugLog(bot, `Auto: no empty sell slot — aborting oldest 0-progress buy ${abortSlot.itemName} in slot ${oldestSlotIdx + 1} to free slot for sell`);
                    bot.statusText = `Freeing slot for sell — aborting ${abortSlot.itemName}`;
                    loop.activeAbortFlow = new AbortOfferFlow({
                        slotIndex: oldestSlotIdx,
                        delayFn: createDelay,
                        debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
                    });
                    const abortEntry = cache.get(abortSlot.itemName);
                    const abortMerch = getMerchableItem(abortSlot.itemName);
                    loop.abortSlotInfo = {
                        type: 'buy',
                        itemName: abortSlot.itemName,
                        progress: abortSlot.progress,
                        reason: 'freeing slot for sell (oldest 0-progress buy)',
                        category: 'swap' as AbortCategory,
                        etaMin: abortMerch ? abortMerch.purchaseEtaMinutes : (abortEntry?.purchaseEtaMinutes ?? 0),
                        requestedQty: abortSlot.itemQuantity,
                        price: abortEntry?.buyPrice ?? 0,
                        placedAt: abortEntry?.offerPlacedAt ?? Date.now(),
                    };
                    loop.phase = 'aborting';
                    return true;
                }
            }
        }
        debugLog(bot, 'Auto: no empty slots for selling — all slots occupied');
    }

    // --- Step 6: Buying flow ---
    // Check for empty slots and merchable items to buy.
    const emptyBuySlot = findEmptyOfferSlot();

    // --- Cross-account buy dedup ---
    // Prevent multiple accounts from buying the same item and competing
    // on price. Up to MAX_ACCOUNTS_PER_ITEM (2) accounts can buy the same
    // item. With a 2-account roster, the threshold is 1 (no overlap).
    // With 3+ accounts, the threshold is 2 (max 2 accounts per item).
    const MAX_ACCOUNTS_PER_ITEM = 2;
    const roster = getRoster(bot);
    const crossAccountThreshold = Math.min(MAX_ACCOUNTS_PER_ITEM, Math.max(1, roster.length - 1));
    const crossAccountSkipNames = new Set<string>();
    if (roster.length >= 2) {
        const currentAccount = bot.currentPlayerName || '';
        const buyingCounts = getCrossAccountBuyingItemCount(bot, currentAccount);
        for (const [name, count] of buyingCounts) {
            if (count >= crossAccountThreshold) {
                crossAccountSkipNames.add(name);
            }
        }
        if (crossAccountSkipNames.size > 0) {
            debugLog(bot, `Auto: ${crossAccountSkipNames.size} item(s) cross-account saturated (threshold ${crossAccountThreshold}) — skipping: ${[...crossAccountSkipNames].join(', ')}`);
        }
    }

    if (emptyBuySlot !== -1) {
        // All 8 slots are available for buy offers. When a sell is needed,
        // the sell scan (Step 5) aborts the oldest 0-progress buy offer to
        // free a slot — so we don't need to reserve slots for sales here.
        let currentBuySlots = 0;
        for (const s of slots) {
            if (s.type === 'buy') currentBuySlots++;
        }
        const occupiedNames = getOccupiedItemNames(slots);
        // Count coins from the cached inventory snapshot (single getAll()
        // call shared across all sections of this tick). This is the total
        // budget available for new buy offers.
        const coinCount = countCoinsInInv();
        // Cache the coin count for the overlay so it doesn't have to
        // call titan.utils.inventory.count(995) every frame (which
        // exhausts native handles over hours).
        bot.cachedCoinCount = coinCount;
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
        debugLog(bot, `Auto: buy scan — empty slot ${emptyBuySlot + 1}, coins=${coinCount}, occupied=${occupiedNames.size}, buyLimited=${buyLimitedNames.size}, buy slots=${currentBuySlots}/${slots.length}`);

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
                freezeRemoved = true;
            }
        }
        if (freezeRemoved) saveBuyFreeze(bot, loop.buyFreezeUntil);
        if (frozenNames.size > 0) {
            debugLog(bot, `Auto: ${frozenNames.size} item(s) buy-frozen — skipping: ${[...frozenNames].join(', ')}`);
        }

        // --- Buy scan with lowball tiering (cash-stack-aware) ---
        // Each item is evaluated at runtime based on the player's actual
        // coins. The runtime quantity is min(floor(coins/price), limit) —
        // NOT the simulation quantityToPurchase from determine-flips.mjs
        // (which was computed at a 50m cash stack). The scan returns the
        // item with the highest runtimeProfitPerSlotHour that passes the
        // profit/hr and turnover filters.
        //
        // Non-lowball items (instant-fill, buy at market) are tried first.
        // Lowball items (buy below market, slower fills, less reliable ETA)
        // are only attempted when all non-lowball items are occupied,
        // buy-limited, frozen, or unaffordable. Within each lowball tier,
        // frozen items are used as a fallback (an empty slot earns 0gp).
        //
        // Tier order:
        //   1. Non-lowball, non-frozen (primary — instant-fill)
        //   2. Non-lowball, frozen fallback (soonest-expiring freeze)
        //   3. Lowball, non-frozen (only when all non-lowball exhausted)
        //   4. Lowball, frozen fallback (last resort)
        //   5. Partial fallback (lower profit/hr threshold, longer turnover)
        let merch = getFirstUnoccupiedMerchableItem(occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), frozenNames, 'non-lowball', crossAccountSkipNames);

        // Tier 2: non-lowball frozen fallback.
        if (!merch && frozenNames.size > 0) {
            merch = getFrozenFallbackItem(loop.buyFreezeUntil, occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), 'non-lowball', crossAccountSkipNames);
            if (merch) {
                const freezeMs = loop.buyFreezeUntil.get(merch.item.itemName.trim().toLowerCase()) ?? 0;
                const remainingMs = freezeMs - Date.now();
                debugLog(bot, `Auto: using frozen non-lowball item ${merch.item.itemName} as fallback — no other non-lowball items available (freeze expires in ${Math.max(0, Math.round(remainingMs / 60000))} min)`);
            }
        }

        // Tier 3: lowball, non-frozen — only when all non-lowball items are
        // occupied, buy-limited, frozen, or unaffordable.
        if (!merch) {
            merch = getFirstUnoccupiedMerchableItem(occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), frozenNames, 'lowball', crossAccountSkipNames);
            if (merch) {
                debugLog(bot, `Auto: using lowball item ${merch.item.itemName} (${merch.item.lowballPercent.toFixed(2)}% lowball) — all non-lowball items occupied/limited/frozen/unaffordable`);
            }
        }

        // Tier 4: lowball frozen fallback — last resort.
        if (!merch && frozenNames.size > 0) {
            merch = getFrozenFallbackItem(loop.buyFreezeUntil, occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), 'lowball', crossAccountSkipNames);
            if (merch) {
                const freezeMs = loop.buyFreezeUntil.get(merch.item.itemName.trim().toLowerCase()) ?? 0;
                const remainingMs = freezeMs - Date.now();
                debugLog(bot, `Auto: using frozen lowball item ${merch.item.itemName} as fallback — no other items available (freeze expires in ${Math.max(0, Math.round(remainingMs / 60000))} min)`);
            }
        }

        // Tier 5: Partial fallback — lower profit/hr threshold (5000 vs 20000)
        // and longer max turnover (240min vs 150min). Only tried when all
        // standard scans fail. Same lowball tiering: non-lowball first.
        let partial: PartialBuyResult | null = null;
        if (!merch) {
            // Non-lowball partial.
            partial = getFirstPartialBuyItem(occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), frozenNames, 15000, 'non-lowball', crossAccountSkipNames);
            if (partial) {
                debugLog(bot, `Auto: partial-quantity buy — ${partial.item.itemName} buying ${partial.quantity} (profit ${partial.quantity * partial.item.profitMargin}gp, runtime fallback)`);
            } else if (frozenNames.size > 0) {
                // Non-lowball frozen fallback.
                partial = getFrozenFallbackPartial(loop.buyFreezeUntil, occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), 15000, 'non-lowball', crossAccountSkipNames);
                if (partial) {
                    debugLog(bot, `Auto: partial-quantity buy (frozen non-lowball fallback) — ${partial.item.itemName} buying ${partial.quantity} (profit ${partial.quantity * partial.item.profitMargin}gp)`);
                }
            }
            // Lowball partial — only if no non-lowball partial found.
            if (!partial) {
                partial = getFirstPartialBuyItem(occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), frozenNames, 15000, 'lowball', crossAccountSkipNames);
                if (partial) {
                    debugLog(bot, `Auto: partial-quantity buy (lowball) — ${partial.item.itemName} buying ${partial.quantity} (profit ${partial.quantity * partial.item.profitMargin}gp, runtime fallback)`);
                } else if (frozenNames.size > 0) {
                    // Lowball frozen fallback.
                    partial = getFrozenFallbackPartial(loop.buyFreezeUntil, occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), 15000, 'lowball', crossAccountSkipNames);
                    if (partial) {
                        debugLog(bot, `Auto: partial-quantity buy (frozen lowball fallback) — ${partial.item.itemName} buying ${partial.quantity} (profit ${partial.quantity * partial.item.profitMargin}gp)`);
                    }
                }
            }
        }

        if (merch) {
            const mItem = merch.item;
            const lowerName = mItem.itemName.trim().toLowerCase();

            // Skip items we've already tried to buy this loop iteration.
            if (!loop.buyAttemptedItems.has(lowerName)) {
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
                    debugLog(bot, `Auto: skipping buy offer for ${mItem.itemName} — total ${adjustedTotal}gp below ${MIN_BUY_OFFER_VALUE}gp minimum (coins=${coinCount})`);
                    // Fall through to "nothing to do" — don't return true.
                } else {
                // Record the buy offer in the cache.
                cache.recordBuyOffer(mItem);
                cache.save();

                const qtyNote = adjustedQty < merch.quantity ? ` (reduced from ${merch.quantity} — buy limit remaining)` : '';
                debugLog(bot, `Auto: buying ${adjustedQty}x ${mItem.itemName} @ ${mItem.purchasePrice}gp each (total ${adjustedTotal}gp) in slot ${emptyBuySlot + 1} — coins available: ${coinCount}${qtyNote}`);
                bot.statusText = `Buying ${formatQty(adjustedQty)} ${mItem.itemName} for ${formatGpShort(adjustedTotal)} (${mItem.purchasePrice}ea)`;
                loop.activeBuyFlow = new BuyOfferFlow({
                    itemName: mItem.itemName,
                    quantity: adjustedQty,
                    price: mItem.purchasePrice,
                    delayFn: createDelay,
                    debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
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
                    debugLog(bot, `Auto: skipping partial buy offer for ${pItem.itemName} — total ${adjustedTotal}gp below ${MIN_BUY_OFFER_VALUE}gp minimum (coins=${coinCount})`);
                    // Fall through to "nothing to do" — don't return true.
                } else {
                // Record the buy offer in the cache. We pass the item as-is
                // (cache uses itemName/limit/sellPrice); the reduced quantity
                // is handled by the BuyOfferFlow below.
                cache.recordBuyOffer(pItem);
                cache.save();

                debugLog(bot, `Auto: buying ${adjustedQty}x ${pItem.itemName} @ ${pItem.purchasePrice}gp each (total ${adjustedTotal}gp) in slot ${emptyBuySlot + 1} — coins available: ${coinCount} (partial — full qty ${pItem.quantityToPurchase} needs ${pItem.totalPurchasePrice}gp)`);
                bot.statusText = `Buying ${formatQty(adjustedQty)} ${pItem.itemName} for ${formatGpShort(adjustedTotal)} (${pItem.purchasePrice}ea, partial)`;
                loop.activeBuyFlow = new BuyOfferFlow({
                    itemName: pItem.itemName,
                    quantity: adjustedQty,
                    price: pItem.purchasePrice,
                    delayFn: createDelay,
                    debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
                });
                loop.phase = 'buying';
                loop.buyAttemptedItems.clear();
                return true;
                } // end else (partial offer above MIN_BUY_OFFER_VALUE)
            }
        } else {
            // No affordable merchable item found — log a summary of why.
            // Uses runtime evaluation to classify items.
            let occupied = 0, buyLimited = 0, frozen = 0, unaffordable = 0, belowThreshold = 0;
            for (const item of allMerchItems) {
                const lower = item.itemName.trim().toLowerCase();
                if (occupiedNames.has(lower)) { occupied++; continue; }
                if (buyLimitedNames.has(lower)) { buyLimited++; continue; }
                if (frozenNames.has(lower)) { frozen++; continue; }
                // Evaluate at runtime to see why it was rejected.
                const evalResult = evaluateItemAtRuntime(item, coinCount);
                if (!evalResult) {
                    unaffordable++;
                    continue;
                }
                // Item is affordable but below profit/hr or turnover thresholds.
                if (evalResult.runtimeProfitPerSlotHour < RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM ||
                    evalResult.runtimeTurnoverEtaMinutes > RUNTIME_MAX_TURNOVER_MINUTES) {
                    belowThreshold++;
                }
            }
            debugLog(bot, `Auto: no merchable item to buy — ${occupied} occupied, ${buyLimited} buy-limited, ${frozen} frozen, ${unaffordable} unaffordable, ${belowThreshold} below profit/hr or turnover threshold — coins=${coinCount}`);
        }

        loop.buyAttemptedItems.clear();
    } else {
        // All slots occupied. Check if any buy slot has a frozen item that
        // should be swapped out for a non-frozen merchable item. The frozen
        // item was only placed as a fallback (no other items were available
        // at the time). If a non-frozen merchable item is now available,
        // abort the frozen item's slot to make room. Skip offers that are
        // nearly complete (>= 50% progress) — let them finish naturally.
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
                // Prefer non-lowball (instant-fill) swap candidates first,
                // then lowball — same tiering as the primary buy scan.
                let swapCandidate = getFirstUnoccupiedMerchableItem(swapOccupiedNames, swapCoinCount, swapBuyLimitedNames, isMembersWorld(), swapFrozenNames, 'non-lowball', crossAccountSkipNames);
                if (!swapCandidate) {
                    swapCandidate = getFirstUnoccupiedMerchableItem(swapOccupiedNames, swapCoinCount, swapBuyLimitedNames, isMembersWorld(), swapFrozenNames, 'lowball', crossAccountSkipNames);
                }
                if (swapCandidate) {
                    debugLog(bot, `Auto: aborting frozen fallback buy ${slot.itemName} in slot ${i + 1} (${(slot.progress * 100).toFixed(0)}% progress) — replacing with non-frozen merchable item ${swapCandidate.item.itemName}`);
                    bot.statusText = `Swapping frozen ${slot.itemName} for ${swapCandidate.item.itemName}`;
                    // Don't re-freeze — the item is already frozen.
                    loop.activeAbortFlow = new AbortOfferFlow({
                        slotIndex: i,
                        delayFn: createDelay,
                        debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
                    });
                    const swapAbortEntry = cache.get(slot.itemName);
                    const swapMerch = getMerchableItem(slot.itemName);
                    loop.abortSlotInfo = {
                        type: 'buy',
                        itemName: slot.itemName,
                        progress: slot.progress,
                        reason: 'frozen swap-out',
                        category: 'swap' as AbortCategory,
                        etaMin: swapMerch ? swapMerch.purchaseEtaMinutes : (swapAbortEntry?.purchaseEtaMinutes ?? 0),
                        requestedQty: slot.itemQuantity,
                        price: swapAbortEntry?.buyPrice ?? 0,
                        placedAt: swapAbortEntry?.offerPlacedAt ?? Date.now(),
                    };
                    loop.phase = 'aborting';
                    return true;
                }
                break; // only check the first frozen buy slot
            }
        }
        debugLog(bot, 'Auto: no empty slots for buying — all slots occupied');
    }

    // --- All slots occupied or nothing to do ---
    loop.phase = 'waiting';
    const idleDelay = createDelay(1, 100, 20);
    setAction(bot, 'auto_idle', idleDelay);
    const occupiedCount = slots.filter(s => s.type !== 'empty').length;
    debugLog(bot, `Auto: action=auto_idle delay=${idleDelay}t (nothing to do — ${occupiedCount}/${slots.length} slots occupied)`);
    bot.statusText = `Idle — ${occupiedCount}/${slots.length} slots occupied`;
    // Signal that the auto-loop is idle — the break system will use this
    // to trigger a short logout break when auto mode is on.
    // The break system computes a randomised tick delay (5-20 ticks +
    // variance layers) before actually logging out.
    bot.loopIdleForBreak = true;
    // Compute the ETA-based break duration hint: the minimum remaining time
    // until the next action on any slot (earlier of completion or stale-abort
    // threshold). The break system uses this to time the return so the bot
    // logs back in when there's something to do. -1 = no ETA data (the break
    // system will fall back to a random 2-5 min duration).
    bot.nextActionEtaMin = computeNextActionEtaMin(slots, cache);
    if (bot.nextActionEtaMin > 0) {
        debugLog(bot, `Auto: next action ETA ${bot.nextActionEtaMin.toFixed(1)}min (break will target this)`);
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
    loop.failureCounters = {};
    loop.lastGeOpenDispatchMs = 0;
    loop.lastCollectDispatchMs = 0;
};
