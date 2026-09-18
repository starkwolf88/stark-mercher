// ============================================================================
// Idle Activity — Goat Horn Dust
// ============================================================================
// When the bot has no GE actions to process and "Goat Horn Dust" is selected
// as the idle activity, the bot grinds desert goat horns into goat horn dust
// using a pestle and mortar. This keeps the account productively occupied
// instead of logging out for short breaks.
//
// Flow:
//   1. Open bank (walk-then-click pattern from herblore — see openBankStep)
//   2. Deposit any goat horn dust / leftover horns in inventory
//   3. Ensure a pestle and mortar is in inventory (withdraw if missing)
//   4. Withdraw-all desert goat horns (fills remaining inventory slots)
//   5. Close bank
//   6. Use pestle and mortar on a goat horn → make-all dialog
//   7. Wait until all goat horns are converted
//   8. Repeat from step 1
//
// Exit conditions:
//   - Next GE action is due → cleanup (bank items) → resume GE mode
//   - Bank out of goat horns → resume normal logout behavior
//   - Nightly sleep due → cleanup → nightly break
//
// Banking follows the herblore/mixology pattern:
//   - One action per tick (one deposit or one withdraw per tick)
//   - After a withdraw, set bankClosePending and close on the next tick
//   - Use withdrawAllItem (Withdraw-All) — the deposit-all cleanup step
//     in any-activity.ts ensures the inventory is empty before withdrawing
//     is rejected by the game when the bank has more horns than free slots
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
import { depositItemAndNoted, resolveNotedId } from './idle-deposit.js';

// --- Item IDs ---------------------------------------------------------------
const PESTLE_AND_MORTAR_ID = 233;
const GOAT_HORN_ID = 9735;
const GOAT_HORN_DUST_ID = 9736;

// --- Banking sub-steps ------------------------------------------------------
const SUB_OPEN_BANK = 0;
const SUB_DEPOSIT_DUST = 1;
const SUB_DEPOSIT_HORNS = 2;
const SUB_WITHDRAW_PESTLE = 3;
const SUB_WITHDRAW_HORNS = 4;
const SUB_CLOSE_BANK = 5;

// --- Converting sub-steps ---------------------------------------------------
// 0 = use pestle and mortar on a horn (once)
// 1 = processing — idle until horns are gone
const SUB_CONV_USE_PESTLE = 0;
const SUB_CONV_PROCESSING = 1;

// --- Processing cache refresh -----------------------------------------------
// The game grinds goat horns one by one with a short animation. The cross-tick
// inventory cache has a 500-tick TTL, so without periodic invalidation the bot
// wouldn't detect conversion completion until the cache expires (~5 min) —
// the hornCount would stay frozen at the pre-processing value and the bot
// would loop forever. Refreshing every 15 ticks (~9s) keeps the snapshot fresh
// enough to detect completion promptly while only adding ~1 getAll() call per
// 15 ticks (~4/min) — far below the native handle exhaustion threshold.
const PROCESSING_CACHE_REFRESH_TICKS = 15;

// --- Bank open throttle -----------------------------------------------------
// Minimum ticks between bank.open() clicks. Without this, the bot can
// click open on consecutive ticks, toggling the bank closed immediately
// (bank booths are toggles — a second click closes the interface).
const BANK_OPEN_THROTTLE_TICKS = 5;

// --- Debug log spam guard ---------------------------------------------------
// Only log idle_conv_check when hornCount changes from the last logged value,
// instead of every tick. Avoids hundreds of identical log lines during the
// ~2-minute processing phase.
let lastLoggedHornCount = -1;

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
 * Start the goat horn dust idle activity. Called when the bot transitions
 * from idle (no GE actions) to idle activity. Sets the phase to 'banking'
 * and resets the sub-step counter.
 */
export const startGoatHorn = (loop: AutoLoopState): void => {
    loop.idleActivityPhase = 'banking';
    loop.idleActivitySubStep = SUB_OPEN_BANK;
    loop.idleActivityLastTick = -1; // allow immediate first click
    lastLoggedHornCount = -1; // ensure first conv_check log fires
};

/**
 * Run one tick of the goat horn dust idle activity state machine.
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
export const goatHornTick = (
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
        // --- Banking: open bank, deposit dust, withdraw horns ---
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

                // Deposit goat horn dust (one action per tick).
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
                    depositItemAndNoted(bank, GOAT_HORN_DUST_ID);
                    invalidateInvCache();
                    loop.idleActivitySubStep = SUB_DEPOSIT_HORNS;
                    const delay = createDelay(2, 20, 8);
                    setAction(bot, 'idle_bank_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Deposit leftover goat horns (one action per tick).
                case SUB_DEPOSIT_HORNS: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, GOAT_HORN_ID);
                    invalidateInvCache();
                    loop.idleActivitySubStep = SUB_WITHDRAW_PESTLE;
                    const delay = createDelay(2, 15, 6);
                    setAction(bot, 'idle_bank_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Ensure pestle and mortar is in inventory (withdraw if missing).
                case SUB_WITHDRAW_PESTLE: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    const pestleCount = countInvItem(PESTLE_AND_MORTAR_ID);
                    if (pestleCount === 0) {
                        if (bank.contains(PESTLE_AND_MORTAR_ID)) {
                            // withdrawItem does a left-click, which in "All"
                            // mode withdraws all. There's only 1 pestle and
                            // mortar, so this is equivalent to withdrawItem.
                            bank.withdrawItem(PESTLE_AND_MORTAR_ID);
                            invalidateInvCache(); // inventory changed — fresh snapshot next tick
                        } else {
                            // No pestle and mortar available — can't do the activity.
                            loop.idleActivityPhase = 'depleted';
                            return true;
                        }
                    }
                    loop.idleActivitySubStep = SUB_WITHDRAW_HORNS;
                    const delay = createDelay(3, 20, 8);
                    setAction(bot, 'idle_bank_pestle', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                // Withdraw desert goat horns to fill remaining inventory slots.
                // Goat horns are UNSTACKABLE — each takes 1 inventory slot.
                // The deposit-all cleanup step in any-activity.ts ensures the
                // inventory is empty before we reach this point, so there
                // should be plenty of free slots for Withdraw-All.
                case SUB_WITHDRAW_HORNS: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    if (!bank.contains(GOAT_HORN_ID)) {
                        // Bank out of goat horns — resume normal logout.
                        loop.idleActivityPhase = 'depleted';
                        return true;
                    }
                    const freeSlots = freeInventorySlots();
                    if (freeSlots <= 0) {
                        // No room for horns — skip to close.
                        loop.idleActivitySubStep = SUB_CLOSE_BANK;
                        return true;
                    }
                    bank.withdrawAllItem(GOAT_HORN_ID);
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

        // --- Converting: use pestle and mortar on goat horn → idle until done ---
        // Using a pestle and mortar on a goat horn starts processing
        // immediately — there is no make-all dialog. The game processes all
        // horns without further interaction.
        // Sub-steps:
        //   0: Use pestle and mortar on a horn (once)
        //   1: Processing — idle until all horns are converted to dust
        case 'converting': {
            const hornCount = countInvItem(GOAT_HORN_ID);

            if (bot.logDebugValue && hornCount !== lastLoggedHornCount) {
                lastLoggedHornCount = hornCount;
                const snap = getInvSnapshot();
                const names: string[] = [];
                for (const [name, item] of snap) {
                    names.push(`${name}x${item.quantity}(id=${item.id})`);
                }
                titan.logf(
                    '[Stark Mercher] idle_conv_check: hornCount=%d snapSize=%d snap=[%s]',
                    hornCount,
                    snap.size,
                    names.slice(0, 10).join(', '),
                );
            }

            // All horns converted — go back to banking for the next batch.
            if (hornCount === 0) {
                loop.idleActivityPhase = 'banking';
                loop.idleActivitySubStep = SUB_OPEN_BANK;
                loop.idleActivityLastTick = -1;
                return true;
            }

            switch (loop.idleActivitySubStep) {
                // Step 0: Use pestle and mortar on a goat horn (once).
                case SUB_CONV_USE_PESTLE: {
                    const pestle = findInvItem(PESTLE_AND_MORTAR_ID);
                    const horn = findInvItem(GOAT_HORN_ID);
                    if (!pestle || !horn) {
                        loop.idleActivityPhase = 'banking';
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    pestle.useOn(horn);
                    loop.idleActivitySubStep = SUB_CONV_PROCESSING;
                    loop.idleActivityLastTick = tick;
                    const delay = createDelay(3, 20, 8);
                    setAction(bot, 'idle_use_pestle', delay);
                    return true;
                }

                // Step 1: Processing — idle until all horns are converted.
                // The game processes all horns automatically after the pestle
                // and mortar is used. Just wait; no further interaction needed.
                case SUB_CONV_PROCESSING: {
                    // Periodically refresh the inventory cache during
                    // processing so the hornCount check at the top of the
                    // converting case detects completion promptly. Without
                    // this, the 500-tick cache TTL would delay completion
                    // detection by up to ~5 minutes, causing the bot to loop
                    // forever (the cached hornCount never reaches 0).
                    const ticksSinceUse = tick - loop.idleActivityLastTick;
                    if (ticksSinceUse > 0 && ticksSinceUse % PROCESSING_CACHE_REFRESH_TICKS === 0) {
                        invalidateInvCache();
                    }
                    // hornCount is checked at the top of the converting case.
                    // If horns are still present, just wait. No action needed.
                    return true;
                }

                default:
                    loop.idleActivitySubStep = SUB_CONV_USE_PESTLE;
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
                    depositItemAndNoted(bank, GOAT_HORN_DUST_ID);
                    loop.idleActivitySubStep = SUB_DEPOSIT_HORNS;
                    const delay = createDelay(2, 20, 8);
                    setAction(bot, 'idle_cleanup_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                case SUB_DEPOSIT_HORNS: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, GOAT_HORN_ID);
                    loop.idleActivitySubStep = SUB_WITHDRAW_PESTLE;
                    const delay = createDelay(2, 15, 6);
                    setAction(bot, 'idle_cleanup_deposit', delay);
                    loop.idleActivityLastTick = tick;
                    return true;
                }

                case SUB_WITHDRAW_PESTLE: {
                    if (!isBankOpen()) {
                        loop.idleActivitySubStep = SUB_OPEN_BANK;
                        loop.idleActivityLastTick = -1;
                        return true;
                    }
                    depositItemAndNoted(bank, PESTLE_AND_MORTAR_ID);
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
            const hasIdleItems = countInvItem(GOAT_HORN_DUST_ID) > 0
                || countInvItem(GOAT_HORN_ID) > 0
                || countInvItem(PESTLE_AND_MORTAR_ID) > 0;
            if (hasIdleItems) {
                const result = openBankStep(bot, loop);
                if (result === 'open') {
                    depositItemAndNoted(bank, GOAT_HORN_DUST_ID);
                    depositItemAndNoted(bank, GOAT_HORN_ID);
                    depositItemAndNoted(bank, PESTLE_AND_MORTAR_ID);
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
 * Check if the inventory contains any goat horn idle-activity items (goat
 * horn dust, desert goat horns, or pestle and mortar). Used as a safety
 * check before GE operations to prevent selling/collecting with idle items
 * in the inventory.
 */
/** Count items matching an ID or its noted variant (from cached snapshot).
 *  Ingredients collected from manual GE offers arrive noted — a different
 *  item ID that countInvItem alone would miss. */
const countInvItemOrNoted = (itemId: number): number => {
    const notedId = resolveNotedId(itemId);
    return countInvItem(itemId) + (notedId > 0 ? countInvItem(notedId) : 0);
};

export const hasGoatHornItems = (): boolean =>
    countInvItemOrNoted(GOAT_HORN_DUST_ID) > 0
    || countInvItemOrNoted(GOAT_HORN_ID) > 0
    || countInvItemOrNoted(PESTLE_AND_MORTAR_ID) > 0;

/** Item IDs that must never be sold on the GE when Goat Horn Dust is the
 *  selected idle activity. The sell scan uses this to filter them out. */
export const GOAT_HORN_EXCLUDED_SELL_IDS: ReadonlySet<number> = new Set([
    PESTLE_AND_MORTAR_ID,
    GOAT_HORN_ID,
    GOAT_HORN_DUST_ID,
]);

/** Lowercased ingredient names for Goat Horn Dust. When this idle activity is
 *  selected, buy offers for these items are never aborted as stale — the
 *  user is manually buying them for the activity. */
export const GOAT_HORN_INGREDIENT_NAMES: ReadonlySet<string> = new Set([
    'desert goat horn',
]);

/** Lowercased result product names for Goat Horn Dust. When this idle
 *  activity is selected, sell offers for these items are never aborted as
 *  stale — the user is manually selling the activity's output. */
export const GOAT_HORN_RESULT_PRODUCT_NAMES: ReadonlySet<string> = new Set([
    'goat horn dust',
]);
