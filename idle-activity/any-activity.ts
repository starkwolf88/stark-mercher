// ============================================================================
// Idle Activity — Any
// ============================================================================
// When "Any" is selected as the idle activity, the bot opens the bank, checks
// which of the three idle activities (Chocolate Dust, Ultra Compost, Goat Horn
// Dust) have ingredients available, and randomly picks one to run. When that
// activity depletes (bank out of ingredients), the bot re-scans the bank and
// picks the next available activity. When all activities are depleted, the bot
// falls through to normal logout behavior.
//
// This module provides:
//   - hasAnyActivityItems() — inventory check (union of all three activities)
//   - ANY_EXCLUDED_SELL_IDS — union of all three excluded sell ID sets
//   - ANY_INGREDIENT_NAMES — union of all three ingredient name sets
//   - ANY_RESULT_PRODUCT_NAMES — union of all three result product name sets
//   - checkAvailableActivities(bank) — returns activity IDs with bank ingredients
//   - pickRandomActivity(available, depleted) — random pick excluding depleted
//   - startScanning(loop) — sets the 'scanning' phase (opens bank, picks activity)
//   - anyActivityTick(bot, loop, geActionDue) — handles the 'scanning' phase
//
// The 'scanning' phase is handled here (not in the individual activity modules).
// Once an activity is picked, the scanning phase calls startXxx(loop) which
// transitions to that activity's 'banking' phase. The auto-loop dispatch then
// delegates to the activity-specific tick handler (chocolateDustTick, etc.).
//
// When an activity depletes, the auto-loop dispatch detects idleActivityDepleted
// and re-enters the scanning phase to pick the next activity.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import type { AutoLoopState } from '../grand_exchange/auto-loop.js';
import { setAction } from '../general/timing.js';
import { createDelay } from '../antiban/humanised-delay.js';
import { walkToGe } from '../grand_exchange/clerk.js';
import { isGeOpen, isBankOpen, invalidateBooleanStateCache } from '../grand_exchange/widgets.js';
import { sendKeyWithJitter } from '../antiban/click-jitter.js';
import { invalidateInvCache } from '../grand_exchange/auto-loop.js';
import { depositItemAndNoted } from './idle-deposit.js';
import { startChocolateDust, hasIdleActivityItems as hasChocolateDustItems, CHOCOLATE_DUST_EXCLUDED_SELL_IDS, CHOCOLATE_DUST_INGREDIENT_NAMES, CHOCOLATE_DUST_RESULT_PRODUCT_NAMES } from './chocolate-dust.js';
import { startUltraCompost, hasUltraCompostItems, ULTRA_COMPOST_EXCLUDED_SELL_IDS, ULTRA_COMPOST_INGREDIENT_NAMES, ULTRA_COMPOST_RESULT_PRODUCT_NAMES } from './ultra-compost.js';
import { startGoatHorn, hasGoatHornItems, GOAT_HORN_EXCLUDED_SELL_IDS, GOAT_HORN_INGREDIENT_NAMES, GOAT_HORN_RESULT_PRODUCT_NAMES } from './goat-horn.js';

// --- Activity IDs (must match auto-loop.ts) ---------------------------------
const IDLE_ACTIVITY_CHOCOLATE_DUST = 1;
const IDLE_ACTIVITY_ULTRA_COMPOST = 2;
const IDLE_ACTIVITY_GOAT_HORN = 3;

// --- Item IDs for bank ingredient checks ------------------------------------
// Chocolate Dust: knife (946) + chocolate bar (1973)
// Ultra Compost: volcanic ash (21622) + supercompost (6034)
// Goat Horn Dust: pestle and mortar (233) + desert goat horn (9735)
const KNIFE_ID = 946;
const CHOCOLATE_BAR_ID = 1973;
const CHOCOLATE_DUST_ID = 1975;
const VOLCANIC_ASH_ID = 21622;
const SUPERCOMPOST_ID = 6034;
const ULTRACOMPOST_ID = 21483;
const PESTLE_AND_MORTAR_ID = 233;
const GOAT_HORN_ID = 9735;
const GOAT_HORN_DUST_ID = 9736;

// --- Scanning sub-steps -----------------------------------------------------
// Deposit runs BEFORE the ingredient check so that items kept in the
// inventory across cycles (e.g. volcanic ash for ultra compost — stackable,
// kept in inventory by design) are in the bank when the check runs. Without
// this ordering, the ingredient check sees an empty bank for ash and reports
// "no ingredients found" even though ash is in the inventory.
const SUB_OPEN_BANK = 0;
const SUB_DEPOSIT_ALL_IDLE = 1;
const SUB_CHECK_INGREDIENTS = 2;

// --- Bank open throttle -----------------------------------------------------
const BANK_OPEN_THROTTLE_TICKS = 5;

// --- Public API: inventory / sell / ingredient checks -----------------------

/** Check if the inventory contains items from ANY of the three idle activities.
 *  Used as a safety check before GE operations. */
export const hasAnyActivityItems = (): boolean =>
    hasChocolateDustItems() || hasUltraCompostItems() || hasGoatHornItems();

/** Union of all three activities' excluded sell IDs. The sell scan filters
 *  these out so no idle-activity ingredient is ever listed for sale. */
export const ANY_EXCLUDED_SELL_IDS: ReadonlySet<number> = new Set([
    ...CHOCOLATE_DUST_EXCLUDED_SELL_IDS,
    ...ULTRA_COMPOST_EXCLUDED_SELL_IDS,
    ...GOAT_HORN_EXCLUDED_SELL_IDS,
]);

/** Union of all three activities' ingredient names. Buy offers for these
 *  items are never aborted as stale when "Any" mode is selected. */
export const ANY_INGREDIENT_NAMES: ReadonlySet<string> = new Set([
    ...CHOCOLATE_DUST_INGREDIENT_NAMES,
    ...ULTRA_COMPOST_INGREDIENT_NAMES,
    ...GOAT_HORN_INGREDIENT_NAMES,
]);

/** Union of all three activities' result product names. Sell offers for
 *  these items are never aborted as stale when "Any" mode is selected. */
export const ANY_RESULT_PRODUCT_NAMES: ReadonlySet<string> = new Set([
    ...CHOCOLATE_DUST_RESULT_PRODUCT_NAMES,
    ...ULTRA_COMPOST_RESULT_PRODUCT_NAMES,
    ...GOAT_HORN_RESULT_PRODUCT_NAMES,
]);

// --- Public API: bank ingredient check -------------------------------------

/** Check which activities have ingredients in the bank. Returns an array of
 *  activity IDs (1, 2, 3) for activities whose ingredients are present. The
 *  bank must be open — uses bank.contains() which reads the bank's item list.
 *
 *  Each activity requires both its tool and its consumable ingredient:
 *    Chocolate Dust (1): knife + chocolate bars
 *    Ultra Compost (2): volcanic ash + supercompost
 *    Goat Horn Dust (3): pestle and mortar + desert goat horns
 */
export const checkAvailableActivities = (bank: typeof titan.utils.bank): number[] => {
    const available: number[] = [];
    if (bank.contains(KNIFE_ID) && bank.contains(CHOCOLATE_BAR_ID)) {
        available.push(IDLE_ACTIVITY_CHOCOLATE_DUST);
    }
    if (bank.contains(VOLCANIC_ASH_ID) && bank.contains(SUPERCOMPOST_ID)) {
        available.push(IDLE_ACTIVITY_ULTRA_COMPOST);
    }
    if (bank.contains(PESTLE_AND_MORTAR_ID) && bank.contains(GOAT_HORN_ID)) {
        available.push(IDLE_ACTIVITY_GOAT_HORN);
    }
    return available;
};

/** Pick a random activity from the available list, excluding any that are in
 *  the depleted set. Returns 0 if none are available. */
export const pickRandomActivity = (
    available: number[],
    depleted: ReadonlySet<number>,
): number => {
    const candidates = available.filter(a => !depleted.has(a));
    if (candidates.length === 0) return 0;
    return candidates[Math.floor(Math.random() * candidates.length)];
};

// --- Scanning phase: open bank, check ingredients, start activity -----------

/** Start the scanning phase. Called when "Any" mode is selected and the idle
 *  branch is reached, or when an activity depletes and we need to pick the
 *  next one. Sets the phase to 'scanning' and resets the sub-step. */
export const startScanning = (loop: AutoLoopState): void => {
    loop.idleActivityPhase = 'scanning';
    loop.idleActivitySubStep = SUB_OPEN_BANK;
    loop.idleActivityLastTick = -1; // allow immediate first click
};

/** Open the bank using the walk-then-click pattern (same as the individual
 *  activity modules). Duplicated here to avoid a cross-module dependency. */
const openBankStep = (bot: StarkMercher, loop: AutoLoopState): 'open' | 'walking' | 'clicked' | 'close_ge' => {
    const bank = titan.utils.bank;
    const tick = titan.state.client.tick;

    if (isBankOpen()) return 'open';

    const ticksSinceLast = tick - loop.idleActivityLastTick;
    if (ticksSinceLast < BANK_OPEN_THROTTLE_TICKS) return 'clicked';

    if (!bank.isNearBank()) {
        walkToGe();
        const delay = createDelay(5, 30, 12);
        setAction(bot, 'idle_walk_bank', delay);
        loop.idleActivityLastTick = tick;
        return 'walking';
    }

    // The GE interface intercepts game-world clicks, so bank.open() would
    // land on a GE widget ("View offer") instead of the banker. Always close
    // the GE with Esc first, then open the bank on the next pass.
    if (isGeOpen()) {
        sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Escape), { reason: 'close GE before banking' });
        const delay = createDelay(2, 20, 6);
        setAction(bot, 'idle_close_ge', delay);
        loop.idleActivityLastTick = tick;
        return 'close_ge';
    }

    bank.open();
    invalidateBooleanStateCache();
    const delay = createDelay(3, 25, 8);
    setAction(bot, 'idle_bank_open', delay);
    loop.idleActivityLastTick = tick;
    return 'clicked';
};

/** Map an activity ID to its display name. */
const activityName = (activity: number): string => {
    if (activity === IDLE_ACTIVITY_ULTRA_COMPOST) return 'Ultra Compost';
    if (activity === IDLE_ACTIVITY_GOAT_HORN) return 'Goat Horn Dust';
    return 'Chocolate Dust';
};

/** Start a specific activity by ID. Delegates to the activity's start function. */
const startActivity = (loop: AutoLoopState, activity: number): void => {
    if (activity === IDLE_ACTIVITY_ULTRA_COMPOST) {
        startUltraCompost(loop);
    } else if (activity === IDLE_ACTIVITY_GOAT_HORN) {
        startGoatHorn(loop);
    } else {
        startChocolateDust(loop);
    }
};

/** Run one tick of the scanning phase. Returns true if the scanning phase
 *  consumed the tick (still scanning or just started an activity), or false
 *  if all activities are depleted and the bot should resume normal behavior.
 *
 *  This is called from the auto-loop's idle-activity dispatch when
 *  loop.idleActivityPhase === 'scanning'. Once an activity is picked and
 *  started, the phase transitions to 'banking' (via startXxx) and the
 *  dispatch delegates to the activity-specific tick handler on subsequent
 *  ticks. */
export const anyActivityTick = (
    bot: StarkMercher,
    loop: AutoLoopState,
    geActionDue: boolean,
): boolean => {
    // If a GE action is due, there's nothing to do — the scanning phase
    // hasn't started any activity yet, so there are no idle items to clean
    // up. Just yield to normal GE logic.
    // Exception: if idleActivityCleanupForGe is set (post-reload cleanup),
    // we must bank the idle items BEFORE yielding to GE logic — the
    // hasIdleActivityItems guards would block GE flows until the items
    // are banked.
    if (geActionDue && !loop.idleActivityCleanupForGe) {
        loop.idleActivityPhase = 'none';
        loop.idleActivitySubStep = 0;
        loop.idleActivityLastTick = -1;
        loop.idleActivityGeActionDueMs = 0;
        return false;
    }

    const tick = titan.state.client.tick;
    const bank = titan.utils.bank;

    switch (loop.idleActivitySubStep) {
        // Step 0: Open the bank (walk-then-click pattern).
        case SUB_OPEN_BANK: {
            const result = openBankStep(bot, loop);
            if (result === 'open') {
                loop.idleActivitySubStep = SUB_DEPOSIT_ALL_IDLE;
                loop.idleActivityLastTick = tick;
            }
            return true;
        }

        // Step 1: Deposit all items from all three idle activities before
        // checking ingredients. This cleans up any leftover items from a
        // previous interrupted activity that the picked activity's banking
        // flow wouldn't deposit (e.g. goat horns left in inventory when "Any"
        // mode picks ultra compost after a hot reload). Without this, the
        // leftover items fill inventory slots and the picked activity's
        // withdraws fail with "you don't have enough inventory space", causing
        // a stuck loop.
        //
        // Depositing BEFORE the ingredient check is critical because some
        // ingredients are kept in the inventory across cycles (e.g. volcanic
        // ash for ultra compost — stackable, kept in inventory by design).
        // If the check ran first, the bank would show no ash and the bot
        // would report "no ingredients found" even though ash is in the
        // inventory. Depositing first moves everything to the bank so the
        // check sees the full picture.
        //
        // depositAllOfItem is a no-op if the item isn't in the inventory, so
        // calling all of these unconditionally is safe. Volcanic ash is also
        // deposited here — while it's stackable and kept across ultra compost
        // cycles when staying in ultra compost, it must be deposited when
        // switching to a different activity (e.g. goat horn) so it doesn't
        // occupy a slot. The ultra compost banking flow will re-withdraw it
        // if ultra compost is picked again.
        case SUB_DEPOSIT_ALL_IDLE: {
            if (!isBankOpen()) {
                loop.idleActivitySubStep = SUB_OPEN_BANK;
                loop.idleActivityLastTick = -1;
                return true;
            }
            // Ensure bank is in item mode (not note mode). If the bank
            // is in note mode, withdrawn items are noted variants with
            // different item IDs, causing countInvItem(UNNOTED_ID) to
            // return 0 and the converting phase to loop endlessly.
            if (bank.isNotedMode) {
                bank.setNotedMode(false);
                if (bot.logDebugValue) {
                    titan.log('[Stark Mercher] idle_bank: switched from note mode to item mode');
                }
                const modeDelay = createDelay(2, 10, 4);
                setAction(bot, 'idle_bank_mode', modeDelay);
                loop.idleActivityLastTick = tick;
                return true; // retry deposit next tick
            }
            // Deposit all items from all three activities, including
            // stackable volcanic ash — it's re-withdrawn by ultra compost
            // banking if ultra compost is picked again.
            depositItemAndNoted(bank, CHOCOLATE_DUST_ID);
            depositItemAndNoted(bank, CHOCOLATE_BAR_ID);
            depositItemAndNoted(bank, KNIFE_ID);
            depositItemAndNoted(bank, ULTRACOMPOST_ID);
            depositItemAndNoted(bank, SUPERCOMPOST_ID);
            depositItemAndNoted(bank, VOLCANIC_ASH_ID);
            depositItemAndNoted(bank, GOAT_HORN_DUST_ID);
            depositItemAndNoted(bank, GOAT_HORN_ID);
            depositItemAndNoted(bank, PESTLE_AND_MORTAR_ID);
            invalidateInvCache();
            // Cleanup-for-GE mode: close the bank and yield to GE logic
            // instead of starting a new activity. The GE logic will handle
            // collect/sell/buy/stale flows, and Step 11 will start a new
            // idle activity when there's nothing else to do.
            if (loop.idleActivityCleanupForGe) {
                bank.close();
                invalidateBooleanStateCache();
                loop.idleActivityCleanupForGe = false;
                loop.idleActivityPhase = 'none';
                loop.idleActivitySubStep = 0;
                loop.idleActivityLastTick = -1;
                loop.idleActivityGeActionDueMs = 0;
                const cleanupDelay = createDelay(2, 15, 6);
                setAction(bot, 'idle_cleanup_done', cleanupDelay);
                return false; // Yield to GE logic
            }
            // Advance to the ingredient check. The bank is left open so
            // the check can read bank.contains() without reopening.
            loop.idleActivitySubStep = SUB_CHECK_INGREDIENTS;
            loop.idleActivityLastTick = tick;
            return true;
        }

        // Step 2: Bank is open (and all idle items have been deposited) —
        // check which activities have ingredients, pick one randomly
        // (excluding depleted), and start it. If none have ingredients, mark
        // all as depleted and fall through to normal logout behavior.
        case SUB_CHECK_INGREDIENTS: {
            if (!isBankOpen()) {
                loop.idleActivitySubStep = SUB_OPEN_BANK;
                loop.idleActivityLastTick = -1;
                return true;
            }
            const available = checkAvailableActivities(bank);
            const picked = pickRandomActivity(available, loop.idleActivityAnyDepleted);
            if (picked === 0) {
                // No activities have ingredients — all depleted. Close the
                // bank and fall through to normal logout behavior.
                bank.close();
                invalidateBooleanStateCache();
                loop.idleActivityPhase = 'none';
                loop.idleActivitySubStep = 0;
                loop.idleActivityLastTick = -1;
                loop.idleActivityGeActionDueMs = 0;
                loop.idleActivityDepleted = true;
                return false;
            }
            // Start the picked activity WITHOUT closing the bank. The
            // activity's own banking phase opens with openBankStep(), which
            // short-circuits on bank.isOpen and proceeds directly to its
            // deposit/withdraw sub-steps. Closing here would force an
            // immediate reopen on the next tick — a wasted close+open cycle
            // that adds tick overhead and an extra bank.open() native call
            // every time "Any" mode picks an activity.
            loop.idleActivityCurrent = picked;
            startActivity(loop, picked);
            const delay = createDelay(2, 15, 6);
            setAction(bot, 'idle_any_picked', delay);
            loop.idleActivityLastTick = tick;
            return true;
        }

        default:
            loop.idleActivitySubStep = SUB_OPEN_BANK;
            loop.idleActivityLastTick = -1;
            return true;
    }
};
