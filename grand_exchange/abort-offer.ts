// ============================================================================
// Abort offer flow — state machine for aborting an existing GE offer
// ============================================================================
// This is a multi-tick state machine. The plugin creates an instance, calls
// tick() once per game tick, and checks .status to know when it's done.
//
// Usage:
//   const flow = new AbortOfferFlow({ slotIndex: 0, delayFn, debugLog });
//   if (flow.status === 'in_progress') {
//       if (flow.tick()) setAction(bot, 'abort_offer', flow.lastDelay);
//   }
//   if (flow.status === 'done') { /* slot is now aborted, collect if needed */ }
//   if (flow.status === 'failed') { /* handle flow.error */ }
//
// tick() returns true when an action was dispatched (click, type, Enter).
// tick() returns false when it's just polling game state (no action).
// After tick() returns true, the caller should set a delay using lastDelay.
//
// Steps:
//   0: Verify GE is open and the target slot is occupied
//   1: Click into the offer slot (open detail screen)
//   2: Wait for detail screen to open
//   3: Click "Abort offer" button
//   4: Wait for abort to register (status text changes from "so far" to no "so far")
//   5: Click "Back" button to return to main GE screen
//   6: Wait for main GE screen (detail screen closed)
//   7: Click "Collect" to collect coins/items back to inventory
//   8: Wait for collection to complete (slot becomes empty)
// ============================================================================

import {
    clickOfferSlot,
    clickAbortOffer,
    clickBack,
    clickCollectToInventory,
} from './actions.js';
import {
    isGeOpen,
    isOfferDetailOpen,
    isOfferConfigOpen,
    isOfferAborted,
    isSlotOccupied,
    getOfferSlotState,
} from './widgets.js';

export interface AbortOfferOptions {
    /** Slot index 0-7 to abort. */
    slotIndex: number;
    /**
     * Optional humanised delay function. Called as delayFn(base, triggerChance, max?)
     * after each dispatching step. Returns the tick count to wait.
     */
    delayFn?: (base: number, triggerChance: number, max?: number) => number;
    /**
     * Optional debug log callback.
     */
    debugLog?: (msg: string) => void;
}

export type AbortOfferStatus = 'in_progress' | 'done' | 'failed';

// Max ticks to wait for any single game-state transition before re-attempting.
const MAX_WAIT_TICKS = 10;
// Max re-attempts for a single action before failing.
const MAX_REATTEMPTS = 3;

export class AbortOfferFlow {
    status: AbortOfferStatus = 'in_progress';
    error: string | null = null;

    /** Tick count to wait after the last dispatched action (read by the caller). */
    lastDelay: number = 1;

    readonly slotIndex: number;
    private readonly delayFn: (base: number, triggerChance: number, max?: number) => number;
    private readonly debugLog: (msg: string) => void;

    private step = 0;
    private waitTicks = 0;
    private reattempts = 0;

    constructor(opts: AbortOfferOptions) {
        this.slotIndex = opts.slotIndex;
        this.delayFn = opts.delayFn ?? ((base: number) => Math.max(1, base));
        this.debugLog = opts.debugLog ?? (() => {});
    }

    tick(): boolean {
        if (this.status !== 'in_progress') return false;

        switch (this.step) {
            case 0:  return this.verifySlot();
            case 1:  return this.clickSlotStep();
            case 2:  return this.waitForDetailScreen();
            case 3:  return this.clickAbortStep();
            case 4:  return this.waitForAbortConfirm();
            case 5:  return this.clickBackStep();
            case 6:  return this.waitForMainScreen();
            case 7:  return this.clickCollectStep();
            case 8:  return this.waitForCollection();
            default:
                this.status = 'done';
                return false;
        }
    }

    // --- Helpers ---

    private fail(reason: string): void {
        this.status = 'failed';
        this.error = reason;
    }

    private advance(): void {
        this.step++;
        this.waitTicks = 0;
        this.reattempts = 0;
    }

    private computeDelay(base: number = 1, triggerChance: number = 100, max?: number): void {
        this.lastDelay = this.delayFn(base, triggerChance, max);
        this.log(`Step ${this.step}: Delaying ${this.lastDelay} tick${this.lastDelay === 1 ? '' : 's'}`);
    }

    private log(msg: string): void {
        this.debugLog(msg);
    }

    private waitTick(): boolean {
        this.waitTicks++;
        if (this.waitTicks > MAX_WAIT_TICKS) {
            this.reattempts++;
            if (this.reattempts > MAX_REATTEMPTS) {
                this.fail(`Timed out at step ${this.step} after ${MAX_REATTEMPTS} re-attempts`);
            } else {
                this.log(`Step ${this.step}: state not reached, re-attempt ${this.reattempts}/${MAX_REATTEMPTS}`);
                this.waitTicks = 0;
            }
        }
        return false;
    }

    // --- Step methods ---

    // Step 0: Verify GE is open and the target slot is occupied.
    private verifySlot(): boolean {
        this.log(`Step 0: Verifying slot ${this.slotIndex + 1} is occupied`);
        if (!isGeOpen()) {
            this.fail('GE interface is not open');
            return false;
        }
        if (!isSlotOccupied(this.slotIndex)) {
            // Slot is already empty — nothing to abort.
            this.log(`Slot ${this.slotIndex + 1} is already empty — nothing to abort`);
            this.status = 'done';
            return false;
        }
        const state = getOfferSlotState(this.slotIndex);
        this.log(`Slot ${this.slotIndex + 1}: ${state.type} ${state.itemName ?? 'unknown'} (qty ${state.itemQuantity})`);
        this.computeDelay(1, 35, 5);
        this.advance();
        return true;
    }

    // Step 1: Click into the offer slot to open the detail screen.
    private clickSlotStep(): boolean {
        this.log(`Step 1: Clicking into slot ${this.slotIndex + 1}`);
        if (!clickOfferSlot(this.slotIndex)) {
            return this.waitTick();
        }
        this.computeDelay(2, 35, 5);
        this.advance();
        return true;
    }

    // Step 2: Wait for the offer detail screen to open.
    private waitForDetailScreen(): boolean {
        if (!isOfferDetailOpen()) {
            return this.waitTick();
        }
        this.log('Detail screen open');
        this.computeDelay(1, 35, 5);
        this.advance();
        return true;
    }

    // Step 3: Click the "Abort offer" button.
    private clickAbortStep(): boolean {
        this.log('Step 3: Clicking abort offer');
        if (!clickAbortOffer()) {
            return this.waitTick();
        }
        this.computeDelay(2, 35, 5);
        this.advance();
        return true;
    }

    // Step 4: Wait for the abort to register.
    // The status text changes from "You have bought a total of X so far..."
    // (active) to "You bought a total of X..." (aborted, no "so far").
    // We also accept the detail screen closing as an abort signal.
    private waitForAbortConfirm(): boolean {
        const aborted = isOfferAborted();
        if (aborted === true) {
            this.log('Abort confirmed — status text changed');
            this.computeDelay(1, 35, 5);
            this.advance();
            return true;
        }
        // If the detail screen closed, the abort may have gone through
        // and the game returned us to the main screen.
        if (!isOfferDetailOpen() && !isOfferConfigOpen()) {
            this.log('Abort confirmed — detail screen closed');
            // Skip the back button step since we're already on the main screen.
            this.step = 6;
            this.waitTicks = 0;
            this.reattempts = 0;
            this.computeDelay(2, 35, 5);
            this.advance();
            return true;
        }
        return this.waitTick();
    }

    // Step 5: Click the "Back" button to return to the main GE screen.
    private clickBackStep(): boolean {
        this.log('Step 5: Clicking back to main GE screen');
        if (!clickBack()) {
            return this.waitTick();
        }
        this.computeDelay(2, 35, 5);
        this.advance();
        return true;
    }

    // Step 6: Wait for the main GE screen (detail screen closed).
    private waitForMainScreen(): boolean {
        if (isOfferDetailOpen()) {
            return this.waitTick();
        }
        this.log('Main GE screen visible');
        this.computeDelay(1, 35, 5);
        this.advance();
        return true;
    }

    // Step 7: Click "Collect" to collect coins/items back to inventory.
    private clickCollectStep(): boolean {
        this.log('Step 7: Clicking collect to inventory');
        if (!clickCollectToInventory()) {
            return this.waitTick();
        }
        this.computeDelay(2, 35, 5);
        this.advance();
        return true;
    }

    // Step 8: Wait for collection to complete (slot becomes empty).
    // We give a few ticks for the collection to register and the slot to clear.
    private waitForCollection(): boolean {
        if (isSlotOccupied(this.slotIndex)) {
            // Give it a few ticks to register.
            if (this.waitTicks < 3) {
                this.waitTicks++;
                return false;
            }
            // Slot still occupied after waiting — the collect may not have
            // gone through, or there are still items to collect. Re-attempt.
            return this.waitTick();
        }
        this.log(`Slot ${this.slotIndex + 1} is now empty — abort flow complete`);
        // Add a final delay so the next tick has a grace period for the
        // game state to fully settle before the main loop checks state.
        this.computeDelay(1, 35, 5);
        this.advance();
        return false;
    }
}
