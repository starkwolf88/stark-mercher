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
import { createDelay, getActiveDelayProfile, setDelayProfileForAccount } from '../antiban/humanised-delay.js';
import { setClickJitterProfile, generateClickJitterProfile, setClickJitterDebugLog } from '../antiban/click-jitter.js';
import { BuyOfferFlow, SellOfferFlow, AbortOfferFlow } from './index.js';
import {
    isGeOpen,
    auditGeState,
    getOfferSlotState,
    offerSlotCount,
    findEmptyOfferSlot,
    type OfferSlotState,
    type GeAudit,
} from './widgets.js';
import { clickCollectToInventory } from './actions.js';
import { openGe, nearGrandExchange, walkToGe } from './clerk.js';
import { getMerchableItems, getMerchableItem, getFirstUnoccupiedMerchableItem, isMerchable, type MerchableItem } from '../data/merchable-items.js';
import { OfferCacheManager } from '../data/offer-cache.js';

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
 * Returns true if the offer should be aborted.
 */
const isSellOfferStale = (slot: OfferSlotState, cache: OfferCacheManager): boolean => {
    if (slot.type !== 'sell' || !slot.itemName) return false;
    // Only abort active offers (not completed ones — those get collected).
    if (slot.status !== 'active') return false;

    const entry = cache.get(slot.itemName);
    if (!entry) return false; // no timestamp to check

    const now = Date.now();
    const elapsedMs = now - entry.offerPlacedAt;
    const elapsedMin = elapsedMs / 60000;

    // If the item is no longer in merchableItems.json, abort immediately.
    if (!isMerchable(slot.itemName)) {
        return true;
    }

    const merch = getMerchableItem(slot.itemName);
    if (!merch) return false;

    const eta = merch.saleEtaMinutes;
    if (eta <= 0) return false;

    // 75% of ETA passed with <25% sold → abort
    if (elapsedMin >= eta * SELL_ETA_ABORT_RATIO && slot.progress < SELL_PROGRESS_ABORT_THRESHOLD) {
        return true;
    }
    return false;
};

/**
 * Checks if a buy offer is stale and should be aborted.
 * Returns true if the offer should be aborted.
 */
const isBuyOfferStale = (slot: OfferSlotState, cache: OfferCacheManager): boolean => {
    if (slot.type !== 'buy' || !slot.itemName) return false;
    // Only abort active offers (not completed ones — those get collected).
    if (slot.status !== 'active') return false;

    const entry = cache.get(slot.itemName);
    if (!entry) return false;

    const now = Date.now();
    const elapsedMs = now - entry.offerPlacedAt;
    const elapsedMin = elapsedMs / 60000;

    // If the item is no longer in merchableItems.json, abort immediately.
    if (!isMerchable(slot.itemName)) {
        return true;
    }

    const merch = getMerchableItem(slot.itemName);
    if (!merch) return false;

    const eta = merch.purchaseEtaMinutes;
    if (eta <= 0) return false;

    // Buy (0 bought): 100% of ETA passed with 0 bought → abort
    if (slot.progress <= 0 && elapsedMin >= eta * BUY_ETA_ABORT_RATIO_ZERO) {
        return true;
    }

    // Buy (multi-qty): 75% of ETA passed with <50% bought → abort
    if (slot.itemQuantity > 1 && slot.progress < BUY_PROGRESS_ABORT_THRESHOLD && elapsedMin >= eta * BUY_ETA_ABORT_RATIO_MULTI) {
        return true;
    }

    return false;
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
    bot.loopIdleForBreak = false;

    // --- Defer to active flows ---
    // If a buy/sell/abort flow is in progress, tick it and return.
    if (loop.activeBuyFlow) {
        const flow = loop.activeBuyFlow;
        if (flow.status === 'in_progress') {
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
        const delay = createDelay(1, 50, 3);
        setAction(bot, 'auto_idle', delay);
        debugLog(bot, `Auto: action=auto_idle delay=${delay}t (buy flow ended)`);
        return true;
    }

    if (loop.activeSellFlow) {
        const flow = loop.activeSellFlow;
        if (flow.status === 'in_progress') {
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
        const delay = createDelay(1, 50, 3);
        setAction(bot, 'auto_idle', delay);
        debugLog(bot, `Auto: action=auto_idle delay=${delay}t (sell flow ended)`);
        return true;
    }

    if (loop.activeAbortFlow) {
        const flow = loop.activeAbortFlow;
        if (flow.status === 'in_progress') {
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
            walkToGe();
            const delay = createDelay(2, 50, 5);
            setAction(bot, 'auto_walk', delay);
            debugLog(bot, `Auto: action=auto_walk delay=${delay}t`);
            return true;
        }
        // Near GE — try to open it via clerk or booth.
        debugLog(bot, 'Auto: GE not open, near GE — opening via clerk/booth');
        if (openGe()) {
            const delay = createDelay(2, 50, 5);
            setAction(bot, 'auto_open_ge', delay);
            debugLog(bot, `Auto: action=auto_open_ge delay=${delay}t`);
        } else {
            // Couldn't find clerk or booth — wait and retry.
            debugLog(bot, 'Auto: no clerk/booth found — waiting');
            const delay = createDelay(3, 50, 8);
            setAction(bot, 'auto_wait', delay);
            debugLog(bot, `Auto: action=auto_wait delay=${delay}t (no clerk/booth)`);
        }
        return true;
    }

    // --- Step 2: Get all slot states ---
    const audit = auditGeState();
    const slots = audit.slots;

    // --- Step 3: Collect if needed ---
    if (hasCompletedOrAbortedSlot(slots)) {
        // Before collecting, check if any sell offer is 100% completed.
        // If so, update the cache entry — but DON'T remove it, because we
        // need to retain the buy-limit tracking data (totalBought,
        // limitReachedAt) across buy/sell cycles. The entry's mode will
        // be overwritten by the next recordBuyOffer() call.
        for (const slot of slots) {
            if (isSellOfferCompleted(slot) && slot.itemName) {
                const entry = cache.get(slot.itemName);
                if (entry) {
                    debugLog(bot, `Auto: sell offer for ${slot.itemName} completed — keeping cache entry for buy-limit tracking (totalBought=${entry.totalBought ?? 0})`);
                }
            }
        }
        cache.save();

        // Click collect to inventory.
        debugLog(bot, 'Auto: completed/aborted offer detected — collecting to inventory');
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
    for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        if (slot.type === 'empty' || slot.status !== 'active') continue;

        if (isSellOfferStale(slot, cache) || isBuyOfferStale(slot, cache)) {
            debugLog(bot, `Auto: aborting stale offer in slot ${i + 1} (${slot.type} ${slot.itemName})`);
            loop.activeAbortFlow = new AbortOfferFlow({
                slotIndex: i,
                delayFn: createDelay,
                debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
            });
            loop.phase = 'aborting';
            return true; // the flow will be ticked on the next call
        }
    }

    // --- Step 5: Selling flow ---
    // Check for empty slots and inventory items to sell.
    const emptySlot = findEmptyOfferSlot();
    if (emptySlot !== -1) {
        // Get inventory items (non-coins).
        const invItems = titan.utils.inventory.getAll();
        const occupiedNames = getOccupiedItemNames(slots);

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
            if (sellPrice === null) {
                // Not in cache or merchableItems.json — try Wiki API (stub).
                // For now, skip items we can't price.
                debugLog(bot, `Auto: no sell price for ${itemName} — skipping (Wiki API not configured)`);
                loop.sellAttemptedItems.add(lowerName);
                continue;
            }

            // Check if this is a re-listing (item already in cache with a
            // previous sell offer that didn't sell). If so, revise the price.
            const existingEntry = cache.get(itemName);
            if (existingEntry && existingEntry.mode === 'sell') {
                // This item was previously listed for sale but didn't sell
                // (it's back in inventory after an abort/collect).
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
            const buyPrice = cache.getBuyPrice(itemName) ?? 0;
            const merch = getMerchableItem(itemName);
            const limit = merch?.limit;
            cache.recordSellOffer(itemName, sellPrice, buyPrice, item.quantity, limit);
            cache.save();

            // Start the sell flow.
            debugLog(bot, `Auto: selling ${item.quantity}x ${itemName} @ ${sellPrice}gp each in slot ${emptySlot + 1}`);
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
        loop.sellAttemptedItems.clear();
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
        const merch = getFirstUnoccupiedMerchableItem(occupiedNames, coinCount, buyLimitedNames);

        if (merch) {
            const lowerName = merch.itemName.trim().toLowerCase();

            // Skip items we've already tried to buy this loop iteration.
            if (!loop.buyAttemptedItems.has(lowerName)) {
                // Record the buy offer in the cache.
                cache.recordBuyOffer(merch);
                cache.save();

                debugLog(bot, `Auto: buying ${merch.quantityToPurchase}x ${merch.itemName} @ ${merch.purchasePrice}gp each (total ${merch.totalPurchasePrice}gp) in slot ${emptyBuySlot + 1} — coins available: ${coinCount}`);
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
            // No affordable merchable item found — log if there are items
            // we could buy but can't afford, so the user knows why the bot
            // is idle.
            const allItems = getMerchableItems();
            for (const item of allItems) {
                if (occupiedNames.has(item.itemName.trim().toLowerCase())) continue;
                if (item.totalPurchasePrice > coinCount) {
                    debugLog(bot, `Auto: cannot afford ${item.itemName} (need ${item.totalPurchasePrice}gp, have ${coinCount}gp) — waiting`);
                }
                break; // only log the first unaffordable item
            }
        }

        loop.buyAttemptedItems.clear();
    }

    // --- All slots occupied or nothing to do ---
    loop.phase = 'waiting';
    const idleDelay = createDelay(1, 30, 5);
    setAction(bot, 'auto_idle', idleDelay);
    debugLog(bot, `Auto: action=auto_idle delay=${idleDelay}t (nothing to do)`);
    // Signal that the auto-loop is idle — the break system will use this
    // to trigger a short logout break (2-5 min) when auto mode is on.
    bot.loopIdleForBreak = true;
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
