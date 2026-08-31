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
import { setClickJitterProfile, generateClickJitterProfile, setClickJitterDebugLog } from '../antiban/click-jitter.js';
import { BuyOfferFlow, SellOfferFlow, AbortOfferFlow } from './index.js';
import {
    isGeOpen,
    auditGeState,
    getOfferSlotState,
    offerSlotCount,
    findEmptyOfferSlot,
    isMembersWorld,
    type OfferSlotState,
    type GeAudit,
} from './widgets.js';
import { clickCollectToInventory } from './actions.js';
import { openGe, nearGrandExchange, walkToGe } from './clerk.js';
import { getMerchableItems, getMerchableItem, getFirstUnoccupiedMerchableItem, isMerchable, type MerchableItem } from '../data/merchable-items.js';
import { getPriceHistoryEntry } from '../data/price-history.js';
import { OfferCacheManager } from '../data/offer-cache.js';
import { addDailyProfit } from '../data/daily-profit.js';
import { recordMerchCycle } from '../data/merch-history.js';

// --- Stale offer thresholds ------------------------------------------------
// Sell: 75% of ETA passed with <25% sold → abort
// Buy (0 bought): 100% of ETA passed with 0 bought → abort
// Buy (multi-qty): 75% of ETA passed with <50% bought → abort
// If the item is no longer in merchableItems.json, abort immediately
// (the price target is stale).

const SELL_ETA_ABORT_RATIO = 0.75;       // 75% of sell ETA
const SELL_PROGRESS_ABORT_THRESHOLD = 0.25; // <25% sold
const BUY_ETA_ABORT_RATIO_ZERO = 1.0;    // 100% of buy ETA (0 bought)
const BUY_ETA_ABORT_RATIO_MULTI = 0.75;  // 75% of buy ETA (<50% bought)
const BUY_PROGRESS_ABORT_THRESHOLD = 0.50; // <50% bought

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

    // If the item is no longer in merchableItems.json, abort immediately.
    if (!isMerchable(slot.itemName)) {
        return `no longer in merchableItems.json (sell price was ${entry.sellPrice}gp, buy price ${entry.buyPrice}gp)`;
    }

    const merch = getMerchableItem(slot.itemName);
    if (!merch) return null;

    const eta = merch.saleEtaMinutes;
    if (eta <= 0) return null;

    // 75% of ETA passed with <25% sold → abort
    const etaThreshold = eta * SELL_ETA_ABORT_RATIO;
    if (elapsedMin >= etaThreshold && slot.progress < SELL_PROGRESS_ABORT_THRESHOLD) {
        return `ETA exceeded: ${elapsedMin.toFixed(1)}min elapsed >= ${etaThreshold.toFixed(1)}min (${(SELL_ETA_ABORT_RATIO * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress ${(slot.progress * 100).toFixed(0)}% < ${(SELL_PROGRESS_ABORT_THRESHOLD * 100).toFixed(0)}% — sell price ${entry.sellPrice}gp (buy ${entry.buyPrice}gp, margin ${entry.sellPrice - entry.buyPrice}gp)`;
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

    // If the item is no longer in merchableItems.json, abort immediately.
    if (!isMerchable(slot.itemName)) {
        return `no longer in merchableItems.json (buy price was ${entry.buyPrice}gp)`;
    }

    const merch = getMerchableItem(slot.itemName);
    if (!merch) return null;

    const eta = merch.purchaseEtaMinutes;
    if (eta <= 0) return null;

    // Buy (0 bought): 100% of ETA passed with 0 bought → abort
    const etaThresholdZero = eta * BUY_ETA_ABORT_RATIO_ZERO;
    if (slot.progress <= 0 && elapsedMin >= etaThresholdZero) {
        return `ETA exceeded (0 bought): ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdZero.toFixed(1)}min (${(BUY_ETA_ABORT_RATIO_ZERO * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress 0% — buy price ${entry.buyPrice}gp`;
    }

    // Buy (multi-qty): 75% of ETA passed with <50% bought → abort
    const etaThresholdMulti = eta * BUY_ETA_ABORT_RATIO_MULTI;
    if (slot.itemQuantity > 1 && slot.progress < BUY_PROGRESS_ABORT_THRESHOLD && elapsedMin >= etaThresholdMulti) {
        return `ETA exceeded (partial): ${elapsedMin.toFixed(1)}min elapsed >= ${etaThresholdMulti.toFixed(1)}min (${(BUY_ETA_ABORT_RATIO_MULTI * 100).toFixed(0)}% of ${eta.toFixed(1)}min ETA), progress ${(slot.progress * 100).toFixed(0)}% < ${(BUY_PROGRESS_ABORT_THRESHOLD * 100).toFixed(0)}% — buy price ${entry.buyPrice}gp`;
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
    // the bottom of this function. Also reset the idle timer — if we're
    // here, the bot is about to try an action.
    bot.loopIdleForBreak = false;
    bot.loopIdleSinceTick = -1;
    bot.shortBreakDelayTicks = -1;

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
        const delay = createDelay(1, 50, 3);
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
            cache.save();
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: sell offer failed: %s', flow.error);
        }
        loop.activeSellFlow = null;
        loop.phase = 'idle';
        bot.statusText = '';
        const delay = createDelay(1, 50, 3);
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
            // After abort, the item may need to be re-sold or collected.
            // The next loop iteration will handle it.
            cache.save();
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Auto: abort failed: %s', flow.error);
        }
        loop.activeAbortFlow = null;
        loop.phase = 'idle';
        bot.statusText = '';
        const delay = createDelay(1, 50, 3);
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
            const delay = createDelay(2, 50, 5);
            setAction(bot, 'auto_walk', delay);
            debugLog(bot, `Auto: action=auto_walk delay=${delay}t`);
            return true;
        }
        // Near GE — try to open it via clerk or booth.
        debugLog(bot, 'Auto: GE not open, near GE — opening via clerk/booth');
        bot.statusText = 'Opening Grand Exchange';
        if (openGe()) {
            const delay = createDelay(2, 50, 5);
            setAction(bot, 'auto_open_ge', delay);
            debugLog(bot, `Auto: action=auto_open_ge delay=${delay}t`);
        } else {
            // Couldn't find clerk or booth — wait and retry.
            debugLog(bot, 'Auto: no clerk/booth found — waiting');
            bot.statusText = 'Searching for G.E clerk/booth';
            const delay = createDelay(3, 50, 8);
            setAction(bot, 'auto_wait', delay);
            debugLog(bot, `Auto: action=auto_wait delay=${delay}t (no clerk/booth)`);
        }
        return true;
    }

    // --- Step 2: Get all slot states ---
    const audit = auditGeState();
    const slots = audit.slots;
    const slotSummary = slots.map((s, i) => {
        if (s.type === 'empty') return `${i + 1}:empty`;
        return `${i + 1}:${s.type}:${s.status}:${s.itemName ?? '?'}:${Math.round(s.progress * 100)}%`;
    }).join(' | ');
    debugLog(bot, `Auto: GE open — slots: ${slotSummary}`);

    // --- Step 3: Completed-sell sweep + Collect ---
    // First, sweep for 100% completed sells. After a sell offer completes
    // fully and is collected, the item is no longer in any GE slot or
    // inventory. The cache entry still has mode='sell' and sellQuantity > 0.
    // We record the profit and clear sellQuantity to prevent double-counting.
    // This runs every tick (when GE is open and no flow is active) — it's
    // cheap: iterate cache entries, check slots + inventory.
    const playerName = bot.currentPlayerName || titan.state.client.localPlayer?.name || '';
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
        const soldQty = entry.sellQuantity;
        const profitPerItem = entry.sellPrice - entry.buyPrice;
        const profit = profitPerItem * soldQty;
        if (profit !== 0 && playerName) {
            addDailyProfit(bot, playerName, profit);
            debugLog(bot, `Auto: daily profit += ${profit}gp (${soldQty}x ${cacheKey} @ ${profitPerItem}gp/item — 100% completed sell)`);
        }
        // Record the final partial sale batch and build the merch history entry.
        cache.recordPartialSale(cacheKey, entry.sellPrice, soldQty);
        const partials = cache.getPartialSales(cacheKey);
        if (partials.length > 0 && playerName) {
            const totalQty = partials.reduce((s, p) => s + p.qty, 0);
            const weightedSum = partials.reduce((s, p) => s + p.price * p.qty, 0);
            const avgSold = totalQty > 0 ? Math.round(weightedSum / totalQty) : 0;
            const totalProfit = (avgSold - entry.buyPrice) * totalQty;
            const revisions = entry.revisedPrices.length > 0 ? entry.revisedPrices.length - 1 : 0;
            const lastSale = partials[partials.length - 1];
            recordMerchCycle(bot, playerName, {
                item: cacheKey,
                qty: totalQty,
                date: new Date(lastSale.timestamp).toISOString(),
                buy: entry.buyPrice,
                avgSold,
                revisions,
            }, totalProfit);
            debugLog(bot, `Auto: merch history recorded — ${cacheKey} ${totalQty}x, avgSold=${avgSold}gp, buy=${entry.buyPrice}gp, profit=${totalProfit}gp, revisions=${revisions}`);
        }
        cache.clearPartialSales(cacheKey);
        cache.clearSellQuantity(cacheKey);
        cache.save();
        debugLog(bot, `Auto: completed-sell sweep — ${cacheKey} sold 100% (${soldQty}x), profit recorded`);
    }

    if (hasCompletedOrAbortedSlot(slots)) {
        // Completed/aborted slot detected — click collect to inventory.
        // Profit for completed sells is recorded by the sweep above (for
        // 100% completed) or at re-list time in Step 5 (for partial aborts).
        debugLog(bot, 'Auto: completed/aborted offer detected — collecting to inventory');
        bot.statusText = 'Collecting from G.E';
        if (clickCollectToInventory()) {
            const delay = createDelay(1, 50, 3);
            setAction(bot, 'auto_collect', delay);
            debugLog(bot, `Auto: action=auto_collect delay=${delay}t`);
        } else {
            // Collect widget not clickable — wait.
            const delay = createDelay(2, 50, 5);
            setAction(bot, 'auto_wait', delay);
            debugLog(bot, `Auto: action=auto_wait delay=${delay}t (collect not clickable)`);
        }
        return true;
    }

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
            loop.activeAbortFlow = new AbortOfferFlow({
                slotIndex: i,
                delayFn: createDelay,
                debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
            });
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
                const eta = merch ? (slot.type === 'sell' ? merch.saleEtaMinutes : merch.purchaseEtaMinutes) : 0;
                const ratio = eta > 0 ? (elapsedMin / eta) * 100 : 0;
                debugLog(bot, `Auto: slot ${i + 1} ${slot.type} ${slot.itemName} — ${(slot.progress * 100).toFixed(0)}% progress, ${elapsedMin.toFixed(1)}min/${eta.toFixed(1)}min ETA (${ratio.toFixed(0)}%), not stale`);
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
            const existingEntry = cache.get(itemName);
            if (existingEntry && existingEntry.mode === 'sell' && existingEntry.sellQuantity !== undefined) {
                // This item was previously listed for sale but was aborted
                // (it's back in inventory after collect). The difference
                // between the listed quantity and what's in inventory now
                // is the quantity that actually sold.
                const soldQty = existingEntry.sellQuantity - item.quantity;
                if (soldQty > 0) {
                    const profitPerItem = existingEntry.sellPrice - existingEntry.buyPrice;
                    const profit = profitPerItem * soldQty;
                    if (profit !== 0 && playerName) {
                        addDailyProfit(bot, playerName, profit);
                        debugLog(bot, `Auto: daily profit += ${profit}gp (${soldQty}x ${itemName} sold @ ${profitPerItem}gp/item before abort)`);
                    }
                    // Track this partial sale batch for merch history.
                    // The summary entry is created when the cycle completes
                    // (100% sold) in the completed-sell sweep above.
                    cache.recordPartialSale(itemName, existingEntry.sellPrice, soldQty);
                    debugLog(bot, `Auto: partial sale recorded — ${soldQty}x ${itemName} @ ${existingEntry.sellPrice}gp (will be included in merch history at cycle completion)`);
                }
                // Revise the price downward.
                const revisedPrice = cache.reviseSellPrice(itemName);
                if (revisedPrice !== null) {
                    sellPrice = revisedPrice;
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
            cache.save();

            // Start the sell flow.
            debugLog(bot, `Auto: selling ${item.quantity}x ${itemName} @ ${sellPrice}gp each in slot ${emptySlot + 1}`);
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
        if (buyLimitedNames.size > 0) {
            debugLog(bot, `Auto: ${buyLimitedNames.size} item(s) buy-limited — skipping: ${[...buyLimitedNames].join(', ')}`);
        }
        debugLog(bot, `Auto: buy scan — empty slot ${emptyBuySlot + 1}, coins=${coinCount}, occupied=${occupiedNames.size}, buyLimited=${buyLimitedNames.size}`);
        const merch = getFirstUnoccupiedMerchableItem(occupiedNames, coinCount, buyLimitedNames, isMembersWorld());

        if (merch) {
            const lowerName = merch.itemName.trim().toLowerCase();

            // Skip items we've already tried to buy this loop iteration.
            if (!loop.buyAttemptedItems.has(lowerName)) {
                // Record the buy offer in the cache.
                cache.recordBuyOffer(merch);
                cache.save();

                debugLog(bot, `Auto: buying ${merch.quantityToPurchase}x ${merch.itemName} @ ${merch.purchasePrice}gp each (total ${merch.totalPurchasePrice}gp) in slot ${emptyBuySlot + 1} — coins available: ${coinCount}`);
                bot.statusText = `Buying ${formatQty(merch.quantityToPurchase)} ${merch.itemName} for ${formatGpShort(merch.totalPurchasePrice)} (${merch.purchasePrice}ea)`;
                loop.activeBuyFlow = new BuyOfferFlow({
                    itemName: merch.itemName,
                    quantity: merch.quantityToPurchase,
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
            const allItems = getMerchableItems();
            let skipReason = 'none found';
            for (const item of allItems) {
                const lower = item.itemName.trim().toLowerCase();
                if (occupiedNames.has(lower)) { skipReason = `first item (${item.itemName}) already occupied`; continue; }
                if (buyLimitedNames.has(lower)) { skipReason = `first item (${item.itemName}) buy-limited`; continue; }
                if (item.totalPurchasePrice > coinCount) { skipReason = `cannot afford ${item.itemName} (need ${item.totalPurchasePrice}gp, have ${coinCount}gp)`; }
                break;
            }
            debugLog(bot, `Auto: no merchable item to buy — reason: ${skipReason}`);
        }

        loop.buyAttemptedItems.clear();
    } else {
        debugLog(bot, 'Auto: no empty slots for buying — all slots occupied');
    }

    // --- All slots occupied or nothing to do ---
    loop.phase = 'waiting';
    const idleDelay = createDelay(1, 30, 5);
    setAction(bot, 'auto_idle', idleDelay);
    const occupiedCount = slots.filter(s => s.type !== 'empty').length;
    debugLog(bot, `Auto: action=auto_idle delay=${idleDelay}t (nothing to do — ${occupiedCount}/${slots.length} slots occupied)`);
    bot.statusText = `Idle — ${occupiedCount}/${slots.length} slots occupied`;
    // Signal that the auto-loop is idle — the break system will use this
    // to trigger a short logout break (2-5 min) when auto mode is on.
    // The break system computes a randomised tick delay (5-20 ticks +
    // variance layers) before actually logging out.
    bot.loopIdleForBreak = true;
    if (bot.loopIdleSinceTick < 0) bot.loopIdleSinceTick = tick;
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
};
