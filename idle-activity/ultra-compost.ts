// ============================================================================
// Idle Activity — Ultra Compost
// ============================================================================
// When the bot has no GE actions to process and "Ultra Compost" is selected
// as the idle activity, the bot makes ultra compost by using volcanic ash
// on supercompost. This keeps the account productively occupied instead of
// logging out for short breaks.
//
// Flow:
//   1. Open bank (walk-then-click pattern from herblore — see openBankStep)
//   2. Deposit all ultracompost (the product from the previous cycle)
//   3. Withdraw all volcanic ash (stackable — 1 inventory slot, kept across cycles)
//   4. Withdraw all supercompost (fills remaining inventory slots, ash stays)
//   5. Close bank
//   6. Use volcanic ash on supercompost → make-X dialogue
//   7. Press spacebar to make all
//   8. Wait until all supercompost is converted (or ash runs out)
//   9. Repeat from step 1
//
// Exit conditions:
//   - Next GE action is due → cleanup (bank ultracompost + supercompost, keep
//     ash) → resume GE mode
//   - Bank out of supercompost or volcanic ash → resume normal logout behavior
//   - Nightly sleep due → cleanup → nightly break
//
// Banking follows the herblore/mixology pattern:
//   - One action per tick (one deposit or one withdraw per tick)
//   - After a withdraw, set bankClosePending and close on the next tick
//   - Use withdrawAllItem (bank is in "All" mode — left-click withdraws all)
//   - Use Escape to close the bank (bank.close() can throw)
//   - Volcanic ash is stackable and kept in the inventory across cycles —
//     no need to deposit and re-withdraw it each time. Ash is NOT deposited
//     during cleanup (only ultracompost and supercompost are), so it stays
//     in the inventory for the next idle activity cycle.
//   - Deposit ultracompost BEFORE withdrawing ash/supercompost — this frees
//     slots first so the withdraws don't fail with "you don't have enough
//     inventory space" when the inventory is full of ultracompost.
//
// Converting differs from chocolate dust:
//   - Chocolate dust: knife on bar → no dialogue, auto-processes all
//   - Ultra compost: ash on supercompost → make-X dialogue → press spacebar
//     to make all → game processes them one by one with a short animation
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import type { AutoLoopState } from '../grand_exchange/auto-loop.js';
import { getInvSnapshot, invalidateInvCache } from '../grand_exchange/auto-loop.js';
import { setAction } from '../general/timing.js';
import { createDelay } from '../antiban/humanised-delay.js';
import { walkToGe } from '../grand_exchange/clerk.js';
import { isGeOpen, isBankOpen, invalidateBooleanStateCache } from '../grand_exchange/widgets.js';
import { sendKeyWithJitter, clickWithJitter } from '../antiban/click-jitter.js';
import { depositItemAndNoted } from './idle-deposit.js';

// --- Item IDs ---------------------------------------------------------------
// Supercompost: non-stackable (1 slot per bucket), noteable
// Volcanic ash: stackable (1 slot regardless of quantity)
// Ultracompost: non-stackable (1 slot per bucket), noteable
// Recipe: 1 supercompost + 2 volcanic ash → 1 ultracompost
const SUPERCOMPOST_ID = 6034;
const VOLCANIC_ASH_ID = 21622;
const ULTRACOMPOST_ID = 21483;

// --- Banking sub-steps ------------------------------------------------------
const SUB_OPEN_BANK = 0;
const SUB_DEPOSIT_ULTRA = 1;
const SUB_DEPOSIT_SUPER = 2;
const SUB_DEPOSIT_ASH = 3;
const SUB_WITHDRAW_ASH = 4;
const SUB_WITHDRAW_SUPER = 5;
const SUB_CLOSE_BANK = 6;

// --- Converting sub-steps ---------------------------------------------------
// 0 = select volcanic ash with "Use" (WIDGET_TARGET — first half of split use-on)
// 1 = wait a humanised gap, then click supercompost (WIDGET_TARGET_ON_WIDGET)
// 2 = waiting for make-X dialogue to appear
// 3 = press spacebar to make all
// 4 = processing — idle until all supercompost is converted
const SUB_CONV_USE_ASH = 0;
const SUB_CONV_CLICK_SUPER = 1;
const SUB_CONV_WAIT_DIALOGUE = 2;
const SUB_CONV_PRESS_SPACE = 3;
const SUB_CONV_PROCESSING = 4;

// --- Inventory widget (group 149, child 0) — for split use-on ---------------
// The SDK's Item.useOn() sends WIDGET_TARGET + WIDGET_TARGET_ON_WIDGET in the
// same client frame with no delay between them. A human would select the first
// item, move the mouse, then click the second. We split useOn into two widget
// interactions with a humanised gap between them (same pattern as stark-mixology
// herblore — see potionUseOnStep / potionUseTargetStep).
const INVENTORY_WIDGET_PACKED_ID = (149 << 16) | 0;
const WIDGET_TARGET_OPCODE = 25;
const WIDGET_TARGET_ON_WIDGET_OPCODE = 58;

// --- Bank open throttle -----------------------------------------------------
const BANK_OPEN_THROTTLE_TICKS = 5;

// --- Dialogue wait patience -------------------------------------------------
// After using ash on supercompost, wait this many ticks for the make-X
// dialogue to appear before retrying the use-on. The dialogue usually
// appears within 1-2 ticks.
const DIALOGUE_WAIT_TICKS = 3;

// --- Processing timeout -----------------------------------------------------
// If processing hasn't completed after this many ticks, retry the use-on.
// This catches cases where the spacebar didn't register or the dialogue
// was dismissed without starting make-all.
const PROCESSING_TIMEOUT_TICKS = 200; // ~2 minutes
// How often to refresh the inventory cache during processing. The game
// converts supercompost one by one with a short animation. The cross-tick
// cache has a 500-tick TTL, so without periodic invalidation the bot
// wouldn't detect conversion completion until the cache expires (~5 min).
// Refreshing every 15 ticks (~9s) keeps the snapshot fresh enough to
// detect completion promptly while only adding ~1 getAll() call per 15
// ticks (~4/min) — far below the native handle exhaustion threshold.
const PROCESSING_CACHE_REFRESH_TICKS = 15;

// --- Debug log spam guard ---------------------------------------------------
// Only log idle_conv_check when superCount or ashCount changes from the last
// logged values, instead of every tick. Avoids hundreds of identical log
// lines during the processing phase.
let lastLoggedSuperCount = -1;
let lastLoggedAshCount = -1;

// --- Helpers ----------------------------------------------------------------
// These helpers read from the cross-tick inventory snapshot exported by
// auto-loop.ts instead of calling `titan.utils.inventory.getAll()` directly.

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
 * Same logic as chocolate-dust.ts openBankStep — see that file for docs.
 */
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

// --- Public API -------------------------------------------------------------

/**
 * Start the ultra compost idle activity. Called when the bot transitions
 * from idle (no GE actions) to idle activity. Sets the phase to 'banking'
 * and resets the sub-step counter.
 */
export const startUltraCompost = (loop: AutoLoopState): void => {
    loop.idleActivityPhase = 'banking';
    loop.idleActivitySubStep = SUB_OPEN_BANK;
    loop.idleActivityLastTick = -1; // allow immediate first click
    lastLoggedSuperCount = -1; // ensure first conv_check log fires
    lastLoggedAshCount = -1;
};

/**
 * Run one tick of the ultra compost idle activity state machine.
 * Returns true if the activity is still active (consumed the tick), or
 * false if the activity has finished and the bot should resume normal
 * behavior (either GE mode or logout).
 */
export const ultraCompostTick = (
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
        // --- Banking: withdraw ash, deposit product, withdraw supercompost ---
        // Ash is stackable, so we keep it in the inventory across cycles —
        // no need to deposit and re-withdraw it each time. The flow is:
        //   1. Open bank
        //   2. Withdraw all volcanic ash (tops up the stack — 1 slot)
        //   3. Deposit all ultracompost (the product from the previous cycle)
        //   4. Withdraw all supercompost (fills remaining slots, ash stays)
        //   5. Close bank
        // Leftover supercompost from an incomplete previous cycle stays in
        // the inventory — withdraw-all just adds more on top. Both ash and
        // supercompost depletion are checked: if the bank runs out of either,
        // the activity transitions to 'depleted'.
        case 'banking': {
            switch (loop.idleActivitySubStep) {
                case SUB_OPEN_BANK: {
                    const result = openBankStep(bot, loop);
                    if (result === 'open') {
                        loop.idleActivitySubStep = SUB_DEPOSIT_ULTRA;
                        loop.idleActivityLastTick = tick;
                    }
                    return true;
                }

                // Deposit ultracompost (the product from the previous cycle)
                // FIRST — this frees slots for the ash and supercompost
                // withdraws. The deposit is unconditional (no countInvItem
                // check) to avoid a stale cache skipping the deposit, which
                // would cause "you don't have enough inventory space" when
                // the subsequent withdraws try to fill a still-full inventory.
                // depositAllOfItem is a no-op if the inventory has none.
                case SUB_DEPOSIT_ULTRA: {
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
                    depositItemAndNoted(bank, ULTRACOMPOST_ID);
                    invalidateInvCache(); // inventory changed — fresh snapshot next tick
                    loop.idleActivitySubStep = SUB_WITHDRAW_ASH;
                    const delay = createDelay(2, 20, 8);
                    setAction(bot, 'idle_bank_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Withdraw volcanic ash (stackable — 1 slot regardless
                // of qty). Ash is kept in the inventory across cycles, so this
                // just tops up the stack. If the bank is out of ash but the
                // inventory already has ash from a previous cycle, skip the
                // withdraw and proceed — the activity only depletes when
                // BOTH the bank and inventory have no ash.
                case SUB_WITHDRAW_ASH: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    if (!bank.contains(VOLCANIC_ASH_ID)) {
                        // Bank out of ash — check if inventory has enough from
                        // a previous cycle. Ash is stackable and kept across
                        // cycles, so the bank running out after the first
                        // withdraw-all is the normal case, not depletion.
                        const invAsh = countInvItem(VOLCANIC_ASH_ID);
                        if (invAsh < 2) {
                            // Both bank and inventory out of ash — depleted.
                            loop.idleActivityPhase = 'depleted';
                            return true;
                        }
                        // Inventory has ash — skip withdraw, proceed to
                        // supercompost withdraw.
                        loop.idleActivitySubStep = SUB_WITHDRAW_SUPER;
                        return true;
                    }
                    bank.withdrawAllItem(VOLCANIC_ASH_ID);
                    invalidateInvCache(); // inventory changed — fresh snapshot next tick
                    loop.idleActivitySubStep = SUB_WITHDRAW_SUPER;
                    const delay = createDelay(3, 20, 8);
                    setAction(bot, 'idle_bank_withdraw', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Withdraw-all supercompost (fills remaining inventory slots).
                // Supercompost is UNSTACKABLE — each takes 1 inventory slot.
                // The deposit-all cleanup step in any-activity.ts ensures the
                // inventory is empty before we reach this point, so there
                // should be plenty of free slots for Withdraw-All.
                // Volcanic ash stays in the inventory (1 stackable slot).
                // Leftover supercompost from an incomplete previous cycle also
                // stays — withdraw-all just adds more on top.
                case SUB_WITHDRAW_SUPER: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    if (!bank.contains(SUPERCOMPOST_ID)) {
                        // Bank out of supercompost — can't make ultracompost.
                        loop.idleActivityPhase = 'depleted';
                        return true;
                    }
                    const freeSlots = freeInventorySlots();
                    if (freeSlots <= 0) {
                        // No room for supercompost — skip to close.
                        loop.idleActivitySubStep = SUB_CLOSE_BANK;
                        return true;
                    }
                    bank.withdrawAllItem(SUPERCOMPOST_ID);
                    invalidateInvCache(); // inventory changed — fresh snapshot next tick
                    loop.idleActivitySubStep = SUB_CLOSE_BANK;
                    const delay = createDelay(3, 25, 10);
                    setAction(bot, 'idle_bank_withdraw', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Close the bank (separate tick from the withdraw).
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

        // --- Converting: use ash on supercompost → dialogue → spacebar ---
        case 'converting': {
            const superCount = countInvItem(SUPERCOMPOST_ID);
            const ashCount = countInvItem(VOLCANIC_ASH_ID);

            if (bot.logDebugValue && (superCount !== lastLoggedSuperCount || ashCount !== lastLoggedAshCount)) {
                lastLoggedSuperCount = superCount;
                lastLoggedAshCount = ashCount;
                // Dump the full inventory snapshot to diagnose the
                // idle_conv_done loop — see exactly what getAll() returns.
                const snap = getInvSnapshot();
                const names: string[] = [];
                for (const [name, item] of snap) {
                    names.push(`${name}x${item.quantity}(id=${item.id})`);
                }
                titan.logf(
                    '[Stark Mercher] idle_conv_check: superCount=%d ashCount=%d snapSize=%d snap=[%s]',
                    superCount,
                    ashCount,
                    snap.size,
                    names.slice(0, 10).join(', '),
                );
            }

            // All supercompost converted (or not enough ash to continue) —
            // go back to banking for the next batch. Add a randomized delay
            // so the bot doesn't instantly jump from processing to banking.
            if (superCount === 0 || ashCount < 2) {
                loop.idleActivityPhase = 'banking';
                loop.idleActivitySubStep = SUB_OPEN_BANK;
                loop.idleActivityLastTick = -1;
                const delay = createDelay(3, 30, 10);
                setAction(bot, 'idle_conv_done', delay);
                return true;
            }

            switch (loop.idleActivitySubStep) {
                // Step 0: Select volcanic ash with "Use" (WIDGET_TARGET).
                // This is the first half of the split use-on. The SDK's
                // Item.useOn() sends both WIDGET_TARGET and
                // WIDGET_TARGET_ON_WIDGET in the same client frame with no
                // delay between them. A human would select the first item,
                // move the mouse, then click the second. We split the
                // interaction into two widget clicks with a humanised gap
                // between them (same pattern as stark-mixology herblore).
                case SUB_CONV_USE_ASH: {
                    const ash = findInvItem(VOLCANIC_ASH_ID);
                    const superCompost = findInvItem(SUPERCOMPOST_ID);
                    if (!ash || !superCompost) {
                        loop.idleActivityPhase = 'banking';
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    const invWidget = titan.state.widgets.find(INVENTORY_WIDGET_PACKED_ID);
                    if (!invWidget || !invWidget.visible) {
                        // Fallback: widget not found, use the atomic useOn() call.
                        ash.useOn(superCompost);
                        loop.idleActivitySubStep = SUB_CONV_WAIT_DIALOGUE;
                        loop.idleActivityLastTick = tick;
                        const delay = createDelay(3, 20, 8);
                        setAction(bot, 'idle_use_ash', delay);
                        return true;
                    }
                    clickWithJitter(() => invWidget.interact(WIDGET_TARGET_OPCODE, 0, ash.slot), { reason: 'select volcanic ash (Use)' });
                    loop.idleActivitySubStep = SUB_CONV_CLICK_SUPER;
                    loop.idleActivityLastTick = tick;
                    // Humanised gap between selecting ash and clicking
                    // supercompost — simulates mouse travel + reaction time.
                    const gapDelay = createDelay(1, 4, 2);
                    setAction(bot, 'idle_use_ash', gapDelay);
                    return true;
                }

                // Step 1: Click supercompost (WIDGET_TARGET_ON_WIDGET).
                // After the humanised gap from step 0, click the second item
                // to complete the use-on interaction.
                case SUB_CONV_CLICK_SUPER: {
                    const superCompost = findInvItem(SUPERCOMPOST_ID);
                    if (!superCompost) {
                        loop.idleActivityPhase = 'banking';
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    const invWidget = titan.state.widgets.find(INVENTORY_WIDGET_PACKED_ID);
                    if (!invWidget || !invWidget.visible) {
                        // Widget gone mid-sequence — fall back to useOn() to
                        // complete the action.
                        const ash = findInvItem(VOLCANIC_ASH_ID);
                        if (ash) ash.useOn(superCompost);
                        loop.idleActivitySubStep = SUB_CONV_WAIT_DIALOGUE;
                        loop.idleActivityLastTick = tick;
                        const delay = createDelay(3, 20, 8);
                        setAction(bot, 'idle_use_ash', delay);
                        return true;
                    }
                    clickWithJitter(() => invWidget.interact(WIDGET_TARGET_ON_WIDGET_OPCODE, 0, superCompost.slot), { reason: 'use volcanic ash on supercompost' });
                    loop.idleActivitySubStep = SUB_CONV_WAIT_DIALOGUE;
                    loop.idleActivityLastTick = tick;
                    const delay = createDelay(3, 20, 8);
                    setAction(bot, 'idle_use_ash', delay);
                    return true;
                }

                // Step 2: Wait for the make-X dialogue to appear.
                // The dialogue usually appears within 1-2 ticks after the
                // use-on interaction. Wait a few ticks before pressing space.
                case SUB_CONV_WAIT_DIALOGUE: {
                    const ticksSinceUse = tick - loop.idleActivityLastTick;
                    if (ticksSinceUse < DIALOGUE_WAIT_TICKS) {
                        return true; // still waiting
                    }
                    loop.idleActivitySubStep = SUB_CONV_PRESS_SPACE;
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Step 3: Press spacebar to make all.
                // The make-X dialogue for ultracompost is confirmed with
                // spacebar (same as potion-making dialogues).
                case SUB_CONV_PRESS_SPACE: {
                    sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Space), { reason: 'make all ultracompost' });
                    loop.idleActivitySubStep = SUB_CONV_PROCESSING;
                    loop.idleActivityLastTick = tick;
                    const delay = createDelay(2, 15, 6);
                    setAction(bot, 'idle_press_space', delay);
                    return true;
                }

                // Step 4: Processing — wait until all supercompost is
                // converted (or ash runs out). The game processes them one by
                // one with a short animation. Just wait; no further
                // interaction needed. If processing stalls (no conversion
                // after a timeout), retry the use-on.
                case SUB_CONV_PROCESSING: {
                    const ticksSincePress = tick - loop.idleActivityLastTick;
                    if (ticksSincePress > PROCESSING_TIMEOUT_TICKS) {
                        // Processing timed out — retry the use-on. The
                        // spacebar may not have registered, or the dialogue
                        // was dismissed without starting make-all.
                        loop.idleActivitySubStep = SUB_CONV_USE_ASH;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    // Periodically refresh the inventory cache during
                    // processing so the superCount/ashCount check at the
                    // top of the converting case detects completion promptly.
                    // Without this, the 500-tick cache TTL would delay
                    // completion detection by up to ~5 minutes.
                    if (ticksSincePress > 0 && ticksSincePress % PROCESSING_CACHE_REFRESH_TICKS === 0) {
                        invalidateInvCache();
                    }
                    // superCount and ashCount are checked at the top of the
                    // converting case. If supercompost is still present and
                    // ash is sufficient, just wait. No action needed.
                    return true;
                }

                default:
                    loop.idleActivitySubStep = SUB_CONV_USE_ASH;
                    return true;
            }
        }

        // --- Cleanup: bank all idle items before resuming GE mode ---
        case 'cleanup': {
            switch (loop.idleActivitySubStep) {
                case SUB_OPEN_BANK: {
                    const result = openBankStep(bot, loop);
                    if (result === 'open') {
                        loop.idleActivitySubStep = SUB_DEPOSIT_ULTRA;
                        loop.idleActivityLastTick = tick;
                    }
                    return true;
                }

                case SUB_DEPOSIT_ULTRA: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, ULTRACOMPOST_ID);
                    invalidateInvCache();
                    loop.idleActivitySubStep = SUB_DEPOSIT_SUPER;
                    const delay = createDelay(2, 20, 8);
                    setAction(bot, 'idle_cleanup_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                case SUB_DEPOSIT_SUPER: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, SUPERCOMPOST_ID);
                    invalidateInvCache();
                    // Skip SUB_DEPOSIT_ASH — volcanic ash is stackable and kept
                    // in the inventory across cycles (including cleanup), so the
                    // next idle activity cycle can skip the ash withdraw step.
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
            const hasIdleItems = countInvItem(ULTRACOMPOST_ID) > 0
                || countInvItem(SUPERCOMPOST_ID) > 0
                || countInvItem(VOLCANIC_ASH_ID) > 0;
            if (hasIdleItems) {
                const result = openBankStep(bot, loop);
                if (result === 'open') {
                    depositItemAndNoted(bank, ULTRACOMPOST_ID);
                    depositItemAndNoted(bank, SUPERCOMPOST_ID);
                    depositItemAndNoted(bank, VOLCANIC_ASH_ID);
                    invalidateInvCache();
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
 * Check if the inventory contains any ultra compost idle-activity items
 * that would interfere with GE operations (ultracompost or supercompost).
 * Volcanic ash is excluded — it's stackable (1 slot) and kept in the
 * inventory across cycles, so it doesn't block GE sell/collect/abort.
 */
export const hasUltraCompostItems = (): boolean =>
    countInvItem(ULTRACOMPOST_ID) > 0
    || countInvItem(SUPERCOMPOST_ID) > 0;

/** Item IDs that must never be sold on the GE when Ultra Compost is the
 *  selected idle activity. Volcanic ash is included here even though it's
 *  kept in the inventory across cycles — the sell scan uses this to filter
 *  it out so the bot never lists ash (or any other ingredient) for sale. */
export const ULTRA_COMPOST_EXCLUDED_SELL_IDS: ReadonlySet<number> = new Set([
    VOLCANIC_ASH_ID,
    SUPERCOMPOST_ID,
    ULTRACOMPOST_ID,
]);

/** Lowercased ingredient names for Ultra Compost. When this idle activity is
 *  selected, buy offers for these items are never aborted as stale — the
 *  user is manually buying them for the activity. The slot is treated as
 *  pre-occupied (which it already is, since it contains an active buy). */
export const ULTRA_COMPOST_INGREDIENT_NAMES: ReadonlySet<string> = new Set([
    'volcanic ash',
    'supercompost',
]);

/** Lowercased result product names for Ultra Compost. When this idle
 *  activity is selected, sell offers for these items are never aborted as
 *  stale — the user is manually selling the activity's output. */
export const ULTRA_COMPOST_RESULT_PRODUCT_NAMES: ReadonlySet<string> = new Set([
    'ultracompost',
]);
