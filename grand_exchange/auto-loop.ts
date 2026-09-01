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
import { getMerchableItems, getMerchableItem, getFirstUnoccupiedMerchableItem, isMerchable, type MerchableItem } from '../data/merchable-items.js';
import { getPriceHistoryEntry } from '../data/price-history.js';
import { OfferCacheManager } from '../data/offer-cache.js';
import { addDailyProfit } from '../data/daily-profit.js';
import { recordMerchCycle, type MerchHistoryEntry } from '../data/merch-history.js';

// --- Stale offer thresholds ------------------------------------------------
// Sell: dynamic % of ETA passed with <25% sold → abort (scaled by profit margin)
// Buy (0 bought): 100% of ETA passed with 0 bought → abort
// Buy (multi-qty): 75% of ETA passed with <50% bought → abort
// If the item is no longer in merchableItems.json, abort immediately
// (the price target is stale).
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
const BUY_ETA_ABORT_RATIO_ZERO = 1.0;    // 100% of buy ETA (0 bought)
const BUY_ETA_ABORT_RATIO_MULTI = 0.75;  // 75% of buy ETA (<50% bought)
const BUY_PROGRESS_ABORT_THRESHOLD = 0.50; // <50% bought
const BUY_ETA_ABORT_RATIO_STALLED = 1.0; // 100% of buy ETA (stalled near completion)
const BUY_PROGRESS_STALLED_THRESHOLD = 0.50; // >=50% bought but not completing

// --- Fast-sell thresholds --------------------------------------------------
// When we have a small quantity of low-value items (e.g. 10 chaos runes from
// a partial buy that got aborted), occupying a GE slot for them isn't worth
// it. Fast-sell at 50% of the sell price for a guaranteed quick sale to free
// the slot for a new profitable cycle. Only applies when BOTH conditions are
// met:
//   1. Quantity is small (< FAST_SELL_QTY_THRESHOLD) — a few items isn't
//      worth a slot regardless of per-item value.
//   2. Total sell value is low (< FAST_SELL_VALUE_CAP) — even a small
//      quantity of high-value items (e.g. 1 item at 500k) should sell at
//      normal price to avoid real GP loss.
const FAST_SELL_QTY_THRESHOLD = 50;
const FAST_SELL_VALUE_CAP = 100_000;     // 100k GP total sell value
const FAST_SELL_PRICE_MULTIPLIER = 0.5;  // 50% of sell price

// --- Buy freeze-out --------------------------------------------------------
// When a buy offer is aborted (stale — not buying at the offered price), we
// temporarily freeze that item so we don't immediately re-list it at the
// same price. The freeze duration is long enough for market conditions to
// shift but short enough to not miss opportunities.
const BUY_FREEZE_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// --- Consecutive failure tracking -------------------------------------------
// Major "stuck" states (GE won't open, sub-screen won't close, collect button
// not clickable) terminate the bot after this many consecutive failures.
// Recoverable failures (price mismatch, quantity validation, search not found)
// do NOT use this system — they press Esc and retry the loop.
const MAX_CONSECUTIVE_FAILURES = 3;

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
// The buy-freeze map is persisted in a hidden JSON setting (keyed by account
// name) so it survives hot reloads and client restarts. Without persistence,
// a reload during a freeze window would cause the bot to immediately re-buy
// an item whose buy offer was just aborted as stale.

/** Resolves the current account name for freeze persistence. */
const resolveFreezeAccountName = (bot: StarkMercher): string => {
    return bot.currentPlayerName
        || titan.state.client.localPlayer?.name
        || bot.lastActiveAccountSetting.value.trim()
        || 'unknown';
};

/** Loads the buy-freeze map for an account from the hidden setting.
 *  Drops expired entries during load so the in-memory map starts clean. */
const loadBuyFreeze = (bot: StarkMercher, accountName: string): Map<string, number> => {
    const raw = bot.buyFreezeSetting.value;
    if (!raw || raw === '{}') return new Map();
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return new Map();
        const accountMap = parsed[accountName];
        if (!accountMap || typeof accountMap !== 'object') return new Map();
        const now = Date.now();
        const result = new Map<string, number>();
        for (const [name, until] of Object.entries(accountMap)) {
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

/** Saves the buy-freeze map for an account to the hidden setting.
 *  Merges into the full persisted state (other accounts are preserved). */
const saveBuyFreeze = (bot: StarkMercher, accountName: string, freezeMap: Map<string, number>): void => {
    try {
        const raw = bot.buyFreezeSetting.value;
        let all: Record<string, Record<string, number>> = {};
        if (raw && raw !== '{}') {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') all = parsed as Record<string, Record<string, number>>;
        }
        // Serialise the map — skip expired entries so we don't bloat the setting.
        const now = Date.now();
        const obj: Record<string, number> = {};
        for (const [name, until] of freezeMap) {
            if (now < until) obj[name] = until;
        }
        all[accountName] = obj;
        bot.buyFreezeSetting.value = JSON.stringify(all);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save buy-freeze state: %s', String(e));
    }
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
    /** Set to true on script start and when the bot logs back in after a
     *  break. Triggers a cache cleanup sweep on the next auto-loop tick
     *  (removes 'idle' entries with expired buy-limit windows, and expired
     *  buy-freeze entries). Cleared after the sweep runs. */
    needsPostLoginCleanup: boolean;
    /** Info about the slot being aborted, set when an abort flow is
     *  initiated. Used on abort completion to decide whether to clean
     *  the cache entry (buy offers with 0% progress have nothing to
     *  collect, so the cache entry is removed). */
    abortSlotInfo: { type: 'buy' | 'sell'; itemName: string; progress: number } | null;
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
    needsPostLoginCleanup: true,
    abortSlotInfo: null,
    lastCleanupMs: 0,
    failureCounters: {},
});

// --- Helper: initialise profiles ------------------------------------------

const ensureProfiles = (bot: StarkMercher): void => {
    if (bot.autoLoop.profilesInitialised) return;
    const playerName = titan.state.client.localPlayer?.name;
    if (playerName) {
        setDelayProfileForAccount(playerName);
        const delayProfile = getActiveDelayProfile();
        if (delayProfile) setClickJitterProfile(generateClickJitterProfile(delayProfile));
    }
    setClickJitterDebugLog((msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); });
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

    // If the item is no longer in merchableItems.json, abort only if the
    // offer has made zero progress. If it's partially filled, let it
    // complete so we can sell what we got.
    if (!isMerchable(slot.itemName) && slot.progress <= 0) {
        return `no longer in merchableItems.json (buy price was ${entry.buyPrice}gp)`;
    }

    // Use live merchable data for ETA if available; fall back to the ETA
    // cached at buy time if the item has been removed from merchableItems.json.
    const merch = getMerchableItem(slot.itemName);
    const eta = merch ? merch.purchaseEtaMinutes : (entry.purchaseEtaMinutes ?? 0);
    if (eta <= 0) return null; // no ETA data at all — can't determine staleness

    // Buy (0 bought): 100% of ETA passed with 0 bought → abort
    const etaThresholdZero = eta * BUY_ETA_ABORT_RATIO_ZERO;
    if (slot.progress <= 0 && elapsedMin >= etaThresholdZero) {
        return `ETA exceeded (0 bought): ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdZero.toFixed(1)}min (${(BUY_ETA_ABORT_RATIO_ZERO * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress 0% — buy price ${entry.buyPrice}gp`;
    }

    // Buy (multi-qty): 75% of ETA passed with <50% bought → abort
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
        if (freezeRemoved) saveBuyFreeze(bot, resolveFreezeAccountName(bot), loop.buyFreezeUntil);
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
        if (freezeRemoved) saveBuyFreeze(bot, resolveFreezeAccountName(bot), loop.buyFreezeUntil);
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
        const delay = createDelay(1, 40, 12);
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
        const delay = createDelay(1, 40, 12);
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
            if (loop.abortSlotInfo && loop.abortSlotInfo.type === 'buy' && loop.abortSlotInfo.progress <= 0) {
                cache.remove(loop.abortSlotInfo.itemName);
                cache.save();
                debugLog(bot, `Auto: removed cache entry for ${loop.abortSlotInfo.itemName} (buy offer aborted with 0% progress — nothing to collect)`);
            }
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: abort failed: %s', flow.error);
        }
        loop.activeAbortFlow = null;
        loop.abortSlotInfo = null;
        loop.phase = 'idle';
        bot.statusText = '';
        const delay = createDelay(1, 40, 12);
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
        debugLog(bot, 'Auto: GE not open, near GE — opening via clerk/booth');
        bot.statusText = 'Opening Grand Exchange';
        if (openGe()) {
            const failures = recordFailure(loop, 'geOpen');
            debugLog(bot, `Auto: GE open click dispatched (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
            if (checkFailureTerminate(bot, loop, 'geOpen', 'Opening Grand Exchange')) return true;
            const delay = createDelay(8, 15, 3);
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
            if (titan.utils.inventory.find(cacheKey)) continue;
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
        const inInv = titan.utils.inventory.find(cacheKey);
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
            merchEntry = {
                item: cacheKey,
                qty: totalQty,
                date: new Date(lastSale.timestamp).toISOString(),
                buy: entry.buyPrice,
                avgSold,
                revisions,
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
            debugLog(bot, `Auto: daily profit += ${profit}gp (${soldQty}x ${cacheKey} @ ${profitPerItem}gp/item net — sell=${entry.sellPrice}gp, tax=${taxPerItem}gp, buy=${entry.buyPrice}gp — 100% completed sell)`);
        }
        if (merchEntry && playerName && merchProfit !== 0) {
            recordMerchCycle(bot, playerName, merchEntry, merchProfit);
            debugLog(bot, `Auto: merch history recorded — ${cacheKey} ${merchEntry.qty}x, avgSold=${merchEntry.avgSold}gp (net=${getNetSellPrice(merchEntry.avgSold)}gp after tax), buy=${entry.buyPrice}gp, profit=${merchProfit}gp, revisions=${merchEntry.revisions}`);
        }
        debugLog(bot, `Auto: completed-sell sweep — ${cacheKey} sold 100% (${soldQty}x), profit recorded, buy-limit data preserved`);
    }
    } // end hasActiveSellEntries fast-path

    if (hasCompletedOrAbortedSlot(slots)) {
        // Completed/aborted slot detected — click collect to inventory.
        // Profit for completed sells is recorded by the sweep above (for
        // 100% completed) or at re-list time in Step 5 (for partial aborts).
        const failures = recordFailure(loop, 'collect');
        debugLog(bot, `Auto: completed/aborted offer detected — collecting to inventory (attempt ${failures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (checkFailureTerminate(bot, loop, 'collect', 'Collecting completed/aborted offer')) return true;
        bot.statusText = 'Collecting from G.E';
        if (clickCollectToInventory()) {
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
            // re-list it at the same price. The freeze lasts 15 minutes —
            // long enough for market conditions to shift.
            if (slot.type === 'buy' && slot.itemName) {
                const freezeKey = slot.itemName.trim().toLowerCase();
                const freezeUntil = Date.now() + BUY_FREEZE_DURATION_MS;
                loop.buyFreezeUntil.set(freezeKey, freezeUntil);
                saveBuyFreeze(bot, resolveFreezeAccountName(bot), loop.buyFreezeUntil);
                titan.logf('[Stark Mercher] Auto: freezing %s from buying for %d min (buy offer aborted — %s)',
                    slot.itemName, Math.round(BUY_FREEZE_DURATION_MS / 60000), reason);
            }
            loop.activeAbortFlow = new AbortOfferFlow({
                slotIndex: i,
                delayFn: createDelay,
                debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
            });
            // Record slot info so we can clean up the cache entry on abort
            // completion. Buy offers with 0% progress have nothing to collect,
            // so the cache entry is removed. Partial buys keep their entry
            // (collected items will be sold in the next loop iteration).
            loop.abortSlotInfo = slot.itemName ? {
                type: slot.type as 'buy' | 'sell',
                itemName: slot.itemName,
                progress: slot.progress,
            } : null;
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
        // Get inventory items (non-coins).
        const invItems = titan.utils.inventory.getAll();
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
            // offer completes or is aborted.
            if (occupiedNames.has(lowerName)) {
                // Check if the occupied slot is a buy offer for this item.
                for (const slot of slots) {
                    if (slot.itemName && slot.itemName.trim().toLowerCase() === lowerName && slot.type === 'buy') {
                        debugLog(bot, `Auto: skipping ${itemName} — currently being bought in a GE slot`);
                        loop.sellAttemptedItems.add(lowerName);
                        break;
                    }
                }
                continue;
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
            // price for a guaranteed quick sale to free the slot. Both the
            // quantity AND total value must be below their thresholds.
            let fastSell = false;
            if (item.quantity < FAST_SELL_QTY_THRESHOLD && sellPrice * item.quantity < FAST_SELL_VALUE_CAP) {
                fastSell = true;
                sellPrice = Math.max(1, Math.floor(sellPrice * FAST_SELL_PRICE_MULTIPLIER));
                titan.logf('[Stark Mercher] Auto: fast-selling %dx %s @ %dgp each (50%% of sell price — small qty, low value, freeing slot)',
                    item.quantity, itemName, sellPrice);
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
        debugLog(bot, 'Auto: no empty slots for selling — all slots occupied');
    }

    // --- Step 6: Buying flow ---
    // Check for empty slots and merchable items to buy.
    const emptyBuySlot = findEmptyOfferSlot();
    if (emptyBuySlot !== -1) {
        const occupiedNames = getOccupiedItemNames(slots);
        // Count coins in inventory (item ID 995). This is the total budget
        // available for new buy offers. We count once per loop iteration,
        // not per item, since the coin stack doesn't change between checks.
        const coinCount = titan.utils.inventory.count(995);
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
        debugLog(bot, `Auto: buy scan — empty slot ${emptyBuySlot + 1}, coins=${coinCount}, occupied=${occupiedNames.size}, buyLimited=${buyLimitedNames.size}`);

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
        if (freezeRemoved) saveBuyFreeze(bot, resolveFreezeAccountName(bot), loop.buyFreezeUntil);
        if (frozenNames.size > 0) {
            debugLog(bot, `Auto: ${frozenNames.size} item(s) buy-frozen — skipping: ${[...frozenNames].join(', ')}`);
        }

        let merch = getFirstUnoccupiedMerchableItem(occupiedNames, coinCount, buyLimitedNames, isMembersWorld(), frozenNames);

        // Fallback: if no non-frozen item was found, try again allowing frozen
        // items. An empty slot earns 0gp — a frozen item might buy now if the
        // price issue that caused the freeze has resolved. This only triggers
        // when there are genuinely no other merchable items available.
        if (!merch && frozenNames.size > 0) {
            merch = getFirstUnoccupiedMerchableItem(occupiedNames, coinCount, buyLimitedNames, isMembersWorld());
            if (merch) {
                debugLog(bot, `Auto: using frozen item ${merch.itemName} as fallback — no other merchable items available (empty slot is worse than a frozen item)`);
            }
        }

        if (merch) {
            const lowerName = merch.itemName.trim().toLowerCase();

            // Skip items we've already tried to buy this loop iteration.
            if (!loop.buyAttemptedItems.has(lowerName)) {
                // Adjust the buy quantity based on remaining GE buy limit.
                // If we've partially bought this item in the current 4-hour
                // window, we can only buy up to (limit - totalBought).
                const remaining = cache.getRemainingBuyLimit(merch.itemName, merch.limit);
                const adjustedQty = Math.min(merch.quantityToPurchase, remaining);
                if (adjustedQty <= 0) {
                    // Shouldn't happen (threshold check above filters this),
                    // but guard against it anyway.
                    debugLog(bot, `Auto: ${merch.itemName} has no remaining buy limit — skipping`);
                    loop.buyAttemptedItems.add(lowerName);
                    return true;
                }
                const adjustedTotal = adjustedQty * merch.purchasePrice;

                // Record the buy offer in the cache.
                cache.recordBuyOffer(merch);
                cache.save();

                const qtyNote = adjustedQty < merch.quantityToPurchase ? ` (reduced from ${merch.quantityToPurchase} — buy limit remaining)` : '';
                debugLog(bot, `Auto: buying ${adjustedQty}x ${merch.itemName} @ ${merch.purchasePrice}gp each (total ${adjustedTotal}gp) in slot ${emptyBuySlot + 1} — coins available: ${coinCount}${qtyNote}`);
                bot.statusText = `Buying ${formatQty(adjustedQty)} ${merch.itemName} for ${formatGpShort(adjustedTotal)} (${merch.purchasePrice}ea)`;
                loop.activeBuyFlow = new BuyOfferFlow({
                    itemName: merch.itemName,
                    quantity: adjustedQty,
                    price: merch.purchasePrice,
                    delayFn: createDelay,
                    debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
                });
                loop.phase = 'buying';
                loop.buyAttemptedItems.clear();
                return true;
            }
        } else {
            // No affordable merchable item found — log the reason.
            let skipReason = 'none found';
            for (const item of allMerchItems) {
                const lower = item.itemName.trim().toLowerCase();
                if (occupiedNames.has(lower)) { skipReason = `first item (${item.itemName}) already occupied`; continue; }
                if (buyLimitedNames.has(lower)) { skipReason = `first item (${item.itemName}) buy-limited`; continue; }
                if (frozenNames.has(lower)) { skipReason = `first item (${item.itemName}) buy-frozen`; continue; }
                if (item.totalPurchasePrice > coinCount) { skipReason = `cannot afford ${item.itemName} (need ${item.totalPurchasePrice}gp, have ${coinCount}gp)`; }
                break;
            }
            debugLog(bot, `Auto: no merchable item to buy — reason: ${skipReason}`);
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
            const swapCoinCount = titan.utils.inventory.count(995);
            const swapBuyLimitedNames = cache.getBuyLimitedItemNames();
            for (let i = 0; i < slots.length; i++) {
                const slot = slots[i];
                if (slot.type !== 'buy' || !slot.itemName || slot.status !== 'active') continue;
                const slotItemLower = slot.itemName.trim().toLowerCase();
                if (!swapFrozenNames.has(slotItemLower)) continue;
                if (slot.progress >= 0.5) continue; // nearly done — let it finish

                // Is there a non-frozen merchable item available to replace it?
                const swapCandidate = getFirstUnoccupiedMerchableItem(swapOccupiedNames, swapCoinCount, swapBuyLimitedNames, isMembersWorld(), swapFrozenNames);
                if (swapCandidate) {
                    debugLog(bot, `Auto: aborting frozen fallback buy ${slot.itemName} in slot ${i + 1} (${(slot.progress * 100).toFixed(0)}% progress) — replacing with non-frozen merchable item ${swapCandidate.itemName}`);
                    bot.statusText = `Swapping frozen ${slot.itemName} for ${swapCandidate.itemName}`;
                    // Don't re-freeze — the item is already frozen.
                    loop.activeAbortFlow = new AbortOfferFlow({
                        slotIndex: i,
                        delayFn: createDelay,
                        debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
                    });
                    loop.abortSlotInfo = {
                        type: 'buy',
                        itemName: slot.itemName,
                        progress: slot.progress,
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
    // to trigger a short logout break (2-5 min) when auto mode is on.
    // The break system computes a randomised tick delay (5-20 ticks +
    // variance layers) before actually logging out.
    bot.loopIdleForBreak = true;
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
    // Restore the buy-freeze map from the hidden setting so freezes survive
    // hot reloads and client restarts. Expired entries are dropped during
    // load. If no player name is available yet (e.g. logged out at reload
    // time), the last-active-account fallback is used.
    loop.buyFreezeUntil = loadBuyFreeze(bot, resolveFreezeAccountName(bot));
    loop.failureCounters = {};
};
