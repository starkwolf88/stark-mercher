// ============================================================================
// Idle Activity — Chocolate Dust
// ============================================================================
// When the bot has no GE actions to process and "Chocolate Dust" is selected
// as the idle activity, the bot grinds chocolate bars into chocolate dust
// using a knife. This keeps the account productively occupied instead of
// logging out for short breaks.
//
// Flow:
//   1. Open bank (walk-then-click pattern from herblore — see openBankStep)
//   2. Deposit any chocolate dust / leftover bars in inventory
//   3. Ensure a knife is in inventory (withdraw if missing)
//   4. Withdraw-all chocolate bars (fills remaining inventory slots)
//   5. Close bank
//   6. Use knife on a chocolate bar → make-all dialog
//   7. Wait until all chocolate bars are converted
//   8. Repeat from step 1
//
// Exit conditions:
//   - Next GE action is due → cleanup (bank items) → resume GE mode
//   - Bank out of chocolate bars → resume normal logout behavior
//   - Nightly sleep due → cleanup → nightly break
//
// Banking follows the herblore/mixology pattern:
//   - One action per tick (one deposit or one withdraw per tick)
//   - After a withdraw, set bankClosePending and close on the next tick
//   - Use withdrawAllItem (Withdraw-All) — the deposit-all cleanup step
//     in any-activity.ts ensures the inventory is empty before withdrawing
//     is rejected by the game when the bank has more bars than free slots
//   - Use Escape to close the bank (bank.close() can throw)
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import type { AutoLoopState } from '../grand_exchange/auto-loop.js';
import { getInvSnapshot, invalidateInvCache } from '../grand_exchange/auto-loop.js';
import { setAction } from '../general/timing.js';
import { createDelay } from '../antiban/humanised-delay.js';
import { walkToGe } from '../grand_exchange/clerk.js';
import { isGeOpen, isBankOpen, invalidateBooleanStateCache } from '../grand_exchange/widgets.js';
import { sendKeyWithJitter } from '../antiban/click-jitter.js';
import { depositItemAndNoted } from './idle-deposit.js';

// --- Item IDs ---------------------------------------------------------------
const KNIFE_ID = 946;
const CHOCOLATE_BAR_ID = 1973;
const CHOCOLATE_DUST_ID = 1975;

// --- Banking sub-steps ------------------------------------------------------
const SUB_OPEN_BANK = 0;
const SUB_DEPOSIT_DUST = 1;
const SUB_DEPOSIT_BARS = 2;
const SUB_WITHDRAW_KNIFE = 3;
const SUB_WITHDRAW_BARS = 4;
const SUB_CLOSE_BANK = 5;

// --- Converting sub-steps ---------------------------------------------------
// 0 = use knife on a bar (once)
// 1 = processing — idle until bars are gone
const SUB_CONV_USE_KNIFE = 0;
const SUB_CONV_PROCESSING = 1;

// --- Processing cache refresh -----------------------------------------------
// The game chops chocolate bars one by one with a short animation. The
// cross-tick inventory cache has a 500-tick TTL, so without periodic
// invalidation the bot wouldn't detect conversion completion until the cache
// expires (~5 min) — the barCount would stay frozen at the pre-processing
// value and the bot would loop forever. Refreshing every 15 ticks (~9s)
// keeps the snapshot fresh enough to detect completion promptly while only
// adding ~1 getAll() call per 15 ticks (~4/min) — far below the native handle
// exhaustion threshold.
const PROCESSING_CACHE_REFRESH_TICKS = 15;

// --- Bank open throttle -----------------------------------------------------
// Minimum ticks between bank.open() clicks. Without this, the bot can
// click open on consecutive ticks, toggling the bank closed immediately
// (bank booths are toggles — a second click closes the interface).
const BANK_OPEN_THROTTLE_TICKS = 5;

// --- Debug log spam guard ---------------------------------------------------
// Only log idle_conv_check when barCount changes from the last logged value,
// instead of every tick. Avoids hundreds of identical log lines during the
// processing phase.
let lastLoggedBarCount = -1;

// --- Helpers ----------------------------------------------------------------
// These helpers read from the cross-tick inventory snapshot exported by
// auto-loop.ts instead of calling `titan.utils.inventory.getAll()` directly.
// Each direct `getAll()` call creates ~28 native Item handles; calling it
// per tick (e.g. via `hasIdleActivityItems()` from the auto-loop's idle path)
// exhausts the finite native handle table over hours, causing FPS to decay.
// The snapshot is cached for up to 100 ticks (~60s) and invalidated after any
// inventory-changing action, so these reads are both cheap and fresh enough.

/** Count items of a specific ID in the inventory (from cached snapshot). */
const countInvItem = (itemId: number): number => {
    let count = 0;
    for (const item of getInvSnapshot().values()) {
        if (item.id === itemId) count += item.quantity;
    }
    return count;
};

/** Find the first inventory item matching an ID (from cached snapshot).
 *  Returns null if not found. */
const findInvItem = (itemId: number): titan.Item | null => {
    for (const item of getInvSnapshot().values()) {
        if (item.id === itemId) return item;
    }
    return null;
};

/** Count free inventory slots (28 - occupied), from cached snapshot. */
const freeInventorySlots = (): number => {
    let occupied = 0;
    for (const _ of getInvSnapshot().values()) occupied++;
    return 28 - occupied;
};

/**
 * Open the bank using the walk-then-click pattern from the herblore plugin.
 * `bank.open()` path-walks to the nearest bank if the player is not adjacent,
 * and OSRS closes the bank interface when the player moves. So we must:
 *   1. If bank is already open → return 'open'
 *   2. If not near a bank → walk to GE area (which has banks) → return 'walking'
 *   3. If near a bank → click open (throttled) → return 'clicked'
 *
 * The throttle prevents double-clicking the bank toggle. The caller should
 * call this on consecutive ticks until it returns 'open'.
 *
 * If the GE interface is open when we're about to click the bank, there's a
 * 25% chance to close it with Esc first (human-like "leave the GE" gesture)
 * before opening the bank. The caller handles the 'close_ge' return by
 * waiting a tick then re-calling openBankStep.
 */
const openBankStep = (bot: StarkMercher, loop: AutoLoopState): 'open' | 'walking' | 'clicked' | 'close_ge' => {
    const bank = titan.utils.bank;
    const tick = titan.state.client.tick;

    if (isBankOpen()) return 'open';

    // Throttle: don't click open if we recently dispatched a click.
    const ticksSinceLast = tick - loop.idleActivityLastTick;
    if (ticksSinceLast < BANK_OPEN_THROTTLE_TICKS) return 'clicked';

    // If not near a bank, walk to the GE area first (the GE has bank booths
    // on the east and west sides). bank.open() would path-walk and cause an
    // open/close loop, so we walk first and click open on the next pass.
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

    // Near a bank — click open. The throttle prevents double-clicking.
    bank.open();
    invalidateBooleanStateCache();
    const delay = createDelay(3, 25, 8);
    setAction(bot, 'idle_bank_open', delay);
    loop.idleActivityLastTick = tick;
    return 'clicked';
};

// --- Public API -------------------------------------------------------------

/**
 * Start the chocolate dust idle activity. Called when the bot transitions
 * from idle (no GE actions) to idle activity. Sets the phase to 'banking'
 * and resets the sub-step counter.
 */
export const startChocolateDust = (loop: AutoLoopState): void => {
    loop.idleActivityPhase = 'banking';
    loop.idleActivitySubStep = SUB_OPEN_BANK;
    loop.idleActivityLastTick = -1; // allow immediate first click
    lastLoggedBarCount = -1; // ensure first conv_check log fires
};

/**
 * Run one tick of the chocolate dust idle activity state machine.
 * Returns true if the activity is still active (consumed the tick), or
 * false if the activity has finished and the bot should resume normal
 * behavior (either GE mode or logout).
 *
 * @param bot - The bot instance.
 * @param loop - The auto-loop state.
 * @param geActionDue - True if the next GE action is due (the bot should
 *   clean up and resume GE mode).
 * @returns true if the tick was consumed by idle activity, false if the
 *   bot should resume normal behavior.
 */
export const chocolateDustTick = (
    bot: StarkMercher,
    loop: AutoLoopState,
    geActionDue: boolean,
): boolean => {
    const tick = titan.state.client.tick;
    const bank = titan.utils.bank;

    // If a GE action is due, transition to cleanup (bank items first).
    if (geActionDue && loop.idleActivityPhase !== 'cleanup') {
        loop.idleActivityPhase = 'cleanup';
        loop.idleActivitySubStep = SUB_OPEN_BANK;
        loop.idleActivityLastTick = -1; // allow immediate bank open
        return true;
    }

    switch (loop.idleActivityPhase) {
        // --- Banking: open bank, deposit dust, withdraw bars ---
        // One action per tick. After each deposit/withdraw, advance to the
        // next sub-step and set a delay. The bank is closed on a separate
        // tick after the last withdraw (herblore's bankClosePending pattern).
        case 'banking': {
            switch (loop.idleActivitySubStep) {
                case SUB_OPEN_BANK: {
                    const result = openBankStep(bot, loop);
                    if (result === 'open') {
                        loop.idleActivitySubStep = SUB_DEPOSIT_DUST;
                        loop.idleActivityLastTick = tick;
                    }
                    // 'close_ge' and 'clicked' both just wait — the throttle
                    // in openBankStep prevents double-clicking. On the next
                    // eligible tick, openBankStep will click the bank booth.
                    return true;
                }

                // Deposit chocolate dust (one action per tick).
                case SUB_DEPOSIT_DUST: {
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
                    depositItemAndNoted(bank, CHOCOLATE_DUST_ID);
                    invalidateInvCache();
                    loop.idleActivitySubStep = SUB_DEPOSIT_BARS;
                    const delay = createDelay(2, 20, 8);
                    setAction(bot, 'idle_bank_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Deposit leftover chocolate bars (one action per tick).
                case SUB_DEPOSIT_BARS: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, CHOCOLATE_BAR_ID);
                    invalidateInvCache();
                    loop.idleActivitySubStep = SUB_WITHDRAW_KNIFE;
                    const delay = createDelay(2, 15, 6);
                    setAction(bot, 'idle_bank_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Ensure knife is in inventory (withdraw if missing).
                case SUB_WITHDRAW_KNIFE: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    const knifeCount = countInvItem(KNIFE_ID);
                    if (knifeCount === 0) {
                        if (bank.contains(KNIFE_ID)) {
                            // withdrawItem does a left-click, which in "All"
                            // mode withdraws all. There's only 1 knife, so
                            // this is equivalent to withdrawItem.
                            bank.withdrawItem(KNIFE_ID);
                            invalidateInvCache(); // inventory changed — fresh snapshot next tick
                        } else {
                            // No knife available — can't do the activity.
                            loop.idleActivityPhase = 'depleted';
                            return true;
                        }
                    }
                    loop.idleActivitySubStep = SUB_WITHDRAW_BARS;
                    const delay = createDelay(3, 20, 8);
                    setAction(bot, 'idle_bank_knife', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Withdraw chocolate bars to fill remaining inventory slots.
                // Chocolate bars are UNSTACKABLE — each takes 1 inventory slot.
                // The deposit-all cleanup step in any-activity.ts ensures the
                // inventory is empty before we reach this point, so there
                // should be plenty of free slots for Withdraw-All.
                case SUB_WITHDRAW_BARS: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    if (!bank.contains(CHOCOLATE_BAR_ID)) {
                        // Bank out of chocolate bars — resume normal logout.
                        loop.idleActivityPhase = 'depleted';
                        return true;
                    }
                    const freeSlots = freeInventorySlots();
                    if (freeSlots <= 0) {
                        // No room for bars — skip to close.
                        loop.idleActivitySubStep = SUB_CLOSE_BANK;
                        return true;
                    }
                    bank.withdrawAllItem(CHOCOLATE_BAR_ID);
                    invalidateInvCache(); // inventory changed — fresh snapshot next tick
                    loop.idleActivitySubStep = SUB_CLOSE_BANK;
                    const delay = createDelay(3, 25, 10);
                    setAction(bot, 'idle_bank_withdraw', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Close the bank (separate tick from the withdraw).
                // Uses Escape key — bank.close() can throw "widget arg11
                // builder was unavailable" (herblore reference).
                case SUB_CLOSE_BANK: {
                    if (isBankOpen()) {
                        bank.close();
                        invalidateBooleanStateCache();
                    }
                    loop.idleActivityPhase = 'converting';
                    loop.idleActivitySubStep = 0;
                    loop.idleActivityLastTick = tick;
                    const delay = createDelay(2, 15, 6);
                    setAction(bot, 'idle_bank_close', delay);
                    return true;
                }

                default:
                    loop.idleActivitySubStep = SUB_OPEN_BANK;
                    loop.idleActivityLastTick = -1;
                    return true;
            }
        }

        // --- Converting: use knife on chocolate bar → idle until done ---
        // Using a knife on a chocolate bar starts processing immediately —
        // there is no make-all dialog. The game processes all bars without
        // further interaction.
        // Sub-steps:
        //   0: Use knife on a bar (once)
        //   1: Processing — idle until all bars are converted to dust
        case 'converting': {
            const barCount = countInvItem(CHOCOLATE_BAR_ID);

            if (bot.logDebugValue && barCount !== lastLoggedBarCount) {
                lastLoggedBarCount = barCount;
                const snap = getInvSnapshot();
                const names: string[] = [];
                for (const [name, item] of snap) {
                    names.push(`${name}x${item.quantity}(id=${item.id})`);
                }
                titan.logf(
                    '[Stark Mercher] idle_conv_check: barCount=%d snapSize=%d snap=[%s]',
                    barCount,
                    snap.size,
                    names.slice(0, 10).join(', '),
                );
            }

            // All bars converted — go back to banking for the next batch.
            if (barCount === 0) {
                loop.idleActivityPhase = 'banking';
                loop.idleActivitySubStep = SUB_OPEN_BANK;
                loop.idleActivityLastTick = -1;
                return true;
            }

            switch (loop.idleActivitySubStep) {
                // Step 0: Use knife on a chocolate bar (once).
                case SUB_CONV_USE_KNIFE: {
                    const knife = findInvItem(KNIFE_ID);
                    const bar = findInvItem(CHOCOLATE_BAR_ID);
                    if (!knife || !bar) {
                        loop.idleActivityPhase = 'banking';
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    knife.useOn(bar);
                    loop.idleActivitySubStep = SUB_CONV_PROCESSING;
                    loop.idleActivityLastTick = tick;
                    const delay = createDelay(3, 20, 8);
                    setAction(bot, 'idle_use_knife', delay);
                    return true;
                }

                // Step 1: Processing — idle until all bars are converted.
                // The game processes all bars automatically after the knife
                // is used. Just wait; no further interaction needed.
                case SUB_CONV_PROCESSING: {
                    // Periodically refresh the inventory cache during
                    // processing so the barCount check at the top of the
                    // converting case detects completion promptly. Without
                    // this, the 500-tick cache TTL would delay completion
                    // detection by up to ~5 minutes, causing the bot to loop
                    // forever (the cached barCount never reaches 0).
                    const ticksSinceUse = tick - loop.idleActivityLastTick;
                    if (ticksSinceUse > 0 && ticksSinceUse % PROCESSING_CACHE_REFRESH_TICKS === 0) {
                        invalidateInvCache();
                    }
                    // barCount is checked at the top of the converting case.
                    // If bars are still present, just wait. No action needed.
                    return true;
                }

                default:
                    loop.idleActivitySubStep = SUB_CONV_USE_KNIFE;
                    return true;
            }
        }

        // --- Cleanup: bank all idle items before resuming GE mode ---
        case 'cleanup': {
            switch (loop.idleActivitySubStep) {
                case SUB_OPEN_BANK: {
                    const result = openBankStep(bot, loop);
                    if (result === 'open') {
                        loop.idleActivitySubStep = SUB_DEPOSIT_DUST;
                        loop.idleActivityLastTick = tick;
                    }
                    return true;
                }

                case SUB_DEPOSIT_DUST: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, CHOCOLATE_DUST_ID);
                    loop.idleActivitySubStep = SUB_DEPOSIT_BARS;
                    const delay = createDelay(2, 20, 8);
                    setAction(bot, 'idle_cleanup_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                case SUB_DEPOSIT_BARS: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, CHOCOLATE_BAR_ID);
                    loop.idleActivitySubStep = SUB_WITHDRAW_KNIFE;
                    const delay = createDelay(2, 15, 6);
                    setAction(bot, 'idle_cleanup_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                case SUB_WITHDRAW_KNIFE: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, KNIFE_ID);
                    loop.idleActivitySubStep = SUB_CLOSE_BANK;
                    const delay = createDelay(2, 15, 6);
                    setAction(bot, 'idle_cleanup_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                case SUB_CLOSE_BANK: {
                    if (isBankOpen()) {
                        bank.close();
                        invalidateBooleanStateCache();
                    }
                    loop.idleActivityPhase = 'none';
                    loop.idleActivitySubStep = 0;
                    loop.idleActivityLastTick = -1;
                    loop.idleActivityGeActionDueMs = 0;
                    const delay = createDelay(2, 15, 6);
                    setAction(bot, 'idle_cleanup_done', delay);
                    return false; // Resume normal GE behavior
                }

                default:
                    loop.idleActivitySubStep = SUB_OPEN_BANK;
                    loop.idleActivityLastTick = -1;
                    return true;
            }
        }

        // --- Depleted: bank out of items, resume normal logout ---
        case 'depleted': {
            const hasIdleItems = countInvItem(CHOCOLATE_DUST_ID) > 0
                || countInvItem(CHOCOLATE_BAR_ID) > 0
                || countInvItem(KNIFE_ID) > 0;
            if (hasIdleItems) {
                const result = openBankStep(bot, loop);
                if (result === 'open') {
                    depositItemAndNoted(bank, CHOCOLATE_DUST_ID);
                    depositItemAndNoted(bank, CHOCOLATE_BAR_ID);
                    depositItemAndNoted(bank, KNIFE_ID);
                    bank.close();
                    invalidateBooleanStateCache();
                    loop.idleActivityPhase = 'none';
                    loop.idleActivitySubStep = 0;
                    loop.idleActivityLastTick = -1;
                    loop.idleActivityGeActionDueMs = 0;
                    loop.idleActivityDepleted = true;
                    return false;
                }
                return true;
            }
            loop.idleActivityPhase = 'none';
            loop.idleActivitySubStep = 0;
            loop.idleActivityLastTick = -1;
            loop.idleActivityGeActionDueMs = 0;
            loop.idleActivityDepleted = true;
            return false;
        }

        default:
            loop.idleActivityPhase = 'none';
            return false;
    }
};

/**
 * Check if the inventory contains any idle-activity items (chocolate dust,
 * chocolate bars, or knife). Used as a safety check before GE operations
 * to prevent selling/collecting with idle items in the inventory.
 */
export const hasIdleActivityItems = (): boolean =>
    countInvItem(CHOCOLATE_DUST_ID) > 0
    || countInvItem(CHOCOLATE_BAR_ID) > 0
    || countInvItem(KNIFE_ID) > 0;

/** Item IDs that must never be sold on the GE when Chocolate Dust is the
 *  selected idle activity. The sell scan uses this to filter them out. */
export const CHOCOLATE_DUST_EXCLUDED_SELL_IDS: ReadonlySet<number> = new Set([
    KNIFE_ID,
    CHOCOLATE_BAR_ID,
    CHOCOLATE_DUST_ID,
]);

/** Lowercased ingredient names for Chocolate Dust. When this idle activity is
 *  selected, buy offers for these items are never aborted as stale — the
 *  user is manually buying them for the activity. */
export const CHOCOLATE_DUST_INGREDIENT_NAMES: ReadonlySet<string> = new Set([
    'chocolate bar',
]);

/** Lowercased result product names for Chocolate Dust. When this idle
 *  activity is selected, sell offers for these items are never aborted as
 *  stale — the user is manually selling the activity's output. */
export const CHOCOLATE_DUST_RESULT_PRODUCT_NAMES: ReadonlySet<string> = new Set([
    'chocolate dust',
]);
