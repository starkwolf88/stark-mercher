// ============================================================================
// Buy offer flow — state machine for placing a buy offer from start to finish
// ============================================================================
// This is a multi-tick state machine. The plugin creates an instance, calls
// tick() once per game tick, and checks .status to know when it's done.
//
// Usage:
//   const offer = new BuyOfferFlow({ itemId: 415, quantity: 100, price: 5000 });
//   // Each tick, when the bot is ready to act:
//   if (offer.status === 'in_progress') {
//       if (offer.tick()) setAction(bot, 'buy_offer', 1);  // action dispatched, wait 1 tick
//   }
//   if (offer.status === 'done') { /* proceed to next task */ }
//   if (offer.status === 'failed') { /* handle offer.error */ }
//
// tick() returns true when an action was dispatched (click, type, Enter).
// tick() returns false when it's just polling game state (no action).
// The plugin should set a 1-tick delay after tick() returns true, and idle
// (no delay) when it returns false.
// ============================================================================

import {
    clickBuySlot,
    typeString,
    pressEnter,
    clickQtyEnter,
    clickPriceEnter,
    clickConfirm,
} from './actions.js';
import {
    isGeOpen,
    isSearchPromptShown,
    isPricePromptShown,
    scanSearchResults,
    findEmptyOfferSlot,
    isSlotOccupied,
    offerSlotCount,
} from './widgets.js';
import { isTyping } from '../input/typing.js';

export interface BuyOfferOptions {
    /** Slot number 1-8, or undefined for first available empty slot. */
    slot?: number;
    /** Item ID — resolved to a name via titan.state.itemDef(). */
    itemId?: number;
    /** Item name — used directly for the GE search. */
    itemName?: string;
    /** Quantity to buy. */
    quantity: number;
    /** Price per item. */
    price: number;
}

export type BuyOfferStatus = 'in_progress' | 'done' | 'failed';

// Max ticks to wait for any single game-state transition before failing.
const MAX_WAIT_TICKS = 10;

export class BuyOfferFlow {
    status: BuyOfferStatus = 'in_progress';
    error: string | null = null;

    private slotIndex: number = -1; // 0-indexed, -1 = first available
    private itemName: string = '';
    private readonly quantity: number;
    private readonly price: number;

    private step = 0;
    private waitTicks = 0;
    private typingStarted = false;

    constructor(opts: BuyOfferOptions) {
        this.quantity = opts.quantity;
        this.price = opts.price;

        // Resolve item name — need it for the GE search.
        if (opts.itemName) {
            this.itemName = opts.itemName;
        } else if (opts.itemId !== undefined) {
            const def = titan.state.itemDef(opts.itemId);
            if (def && def.name) {
                this.itemName = def.name;
            } else {
                this.fail(`Could not resolve item name for ID ${opts.itemId}`);
                return;
            }
        } else {
            this.fail('Either itemId or itemName must be provided');
            return;
        }

        // Resolve slot — 1-8 to 0-indexed, or -1 for first available.
        if (opts.slot !== undefined && opts.slot >= 1) {
            this.slotIndex = opts.slot - 1;
        }
    }

    // tick()
    // Call once per game tick when the bot is ready to act.
    // Returns true if an action was dispatched (set a delay).
    // Returns false if polling game state (idle this tick).
    tick(): boolean {
        if (this.status !== 'in_progress') return false;

        switch (this.step) {
            case 0:  return this.resolveSlot();
            case 1:  return this.clickBuySlotStep();
            case 2:  return this.waitForSearchPrompt();
            case 3:  return this.startTypingSearch();
            case 4:  return this.waitForSearchTyping();
            case 5:  return this.submitSearch();
            case 6:  return this.waitForResults();
            case 7:  return this.clickResult();
            case 8:  return this.waitForConfig();
            case 9:  return this.clickQtyEnterStep();
            case 10: return this.waitForQtyPrompt();
            case 11: return this.startTypingQty();
            case 12: return this.waitForQtyTyping();
            case 13: return this.submitQty();
            case 14: return this.clickPriceEnterStep();
            case 15: return this.waitForPricePrompt();
            case 16: return this.startTypingPrice();
            case 17: return this.waitForPriceTyping();
            case 18: return this.submitPrice();
            case 19: return this.clickConfirmStep();
            case 20: return this.waitForConfirm();
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
        this.typingStarted = false;
    }

    private waitTick(): boolean {
        this.waitTicks++;
        if (this.waitTicks > MAX_WAIT_TICKS) {
            this.fail(`Timed out at step ${this.step}`);
        }
        return false; // no action dispatched, just polling
    }

    // --- Step methods ---

    // Step 0: Resolve slot and verify GE is open.
    private resolveSlot(): boolean {
        if (!isGeOpen()) {
            this.fail('GE interface is not open — call openGe() first');
            return false;
        }
        if (this.slotIndex < 0) {
            const empty = findEmptyOfferSlot();
            if (empty === -1) {
                this.fail('No empty offer slots available');
                return false;
            }
            this.slotIndex = empty;
        }
        if (this.slotIndex >= offerSlotCount()) {
            this.fail(`Slot ${this.slotIndex + 1} exceeds available slots (${offerSlotCount()})`);
            return false;
        }
        if (isSlotOccupied(this.slotIndex)) {
            this.fail(`Slot ${this.slotIndex + 1} is already occupied`);
            return false;
        }
        this.advance();
        return true; // resolved, set a delay before clicking
    }

    // Step 1: Click the buy button on the chosen slot.
    private clickBuySlotStep(): boolean {
        if (!clickBuySlot(this.slotIndex)) {
            return this.waitTick(); // widget not ready, retry
        }
        this.advance();
        return true;
    }

    // Step 2: Wait for the search prompt to appear.
    private waitForSearchPrompt(): boolean {
        if (!isSearchPromptShown()) {
            return this.waitTick();
        }
        this.advance();
        return false; // state ready, no action this tick
    }

    // Step 3: Start typing the item name.
    private startTypingSearch(): boolean {
        if (!this.typingStarted) {
            if (!typeString(this.itemName)) {
                return this.waitTick(); // typing couldn't start, retry
            }
            this.typingStarted = true;
            return true; // typing started, set a delay
        }
        // Already started — shouldn't reach here, but advance just in case.
        this.advance();
        return false;
    }

    // Step 4: Wait for typing to complete.
    private waitForSearchTyping(): boolean {
        if (isTyping()) {
            return this.waitTick();
        }
        this.advance();
        return false;
    }

    // Step 5: Press Enter to submit the search.
    private submitSearch(): boolean {
        if (!pressEnter()) {
            return this.waitTick();
        }
        this.advance();
        return true;
    }

    // Step 6: Wait for search results to appear.
    private waitForResults(): boolean {
        const { active } = scanSearchResults(this.itemName);
        if (!active) {
            return this.waitTick();
        }
        this.advance();
        return false;
    }

    // Step 7: Scan results and click the matching item.
    private clickResult(): boolean {
        const { active, match } = scanSearchResults(this.itemName);
        if (!active) {
            return this.waitTick();
        }
        if (!match) {
            this.fail(`No search result matching "${this.itemName}"`);
            return false;
        }
        if (!match.interact(57, 1)) {
            return this.waitTick(); // click not accepted, retry
        }
        this.advance();
        return true;
    }

    // Step 8: Wait for the offer configuration screen.
    private waitForConfig(): boolean {
        if (isSearchPromptShown() || !isGeOpen()) {
            return this.waitTick();
        }
        this.advance();
        return false;
    }

    // Step 9: Click the "Enter quantity" button.
    private clickQtyEnterStep(): boolean {
        if (!clickQtyEnter()) {
            return this.waitTick();
        }
        this.advance();
        return true;
    }

    // Step 10: Wait for the quantity input prompt.
    // The OSRS GE quantity prompt appears in the chatbox. We don't have a
    // dedicated widget ID for it, so we wait 1 tick for the prompt to
    // register after the click.
    private waitForQtyPrompt(): boolean {
        if (this.waitTicks < 1) {
            this.waitTicks++;
            return false;
        }
        this.advance();
        return false;
    }

    // Step 11: Start typing the quantity.
    private startTypingQty(): boolean {
        if (!this.typingStarted) {
            if (!typeString(String(this.quantity))) {
                return this.waitTick();
            }
            this.typingStarted = true;
            return true;
        }
        this.advance();
        return false;
    }

    // Step 12: Wait for quantity typing to complete.
    private waitForQtyTyping(): boolean {
        if (isTyping()) {
            return this.waitTick();
        }
        this.advance();
        return false;
    }

    // Step 13: Press Enter to submit the quantity.
    private submitQty(): boolean {
        if (!pressEnter()) {
            return this.waitTick();
        }
        this.advance();
        return true;
    }

    // Step 14: Click the "Enter price" button.
    private clickPriceEnterStep(): boolean {
        if (!clickPriceEnter()) {
            return this.waitTick();
        }
        this.advance();
        return true;
    }

    // Step 15: Wait for the price prompt to appear.
    private waitForPricePrompt(): boolean {
        if (!isPricePromptShown()) {
            return this.waitTick();
        }
        this.advance();
        return false;
    }

    // Step 16: Start typing the price.
    private startTypingPrice(): boolean {
        if (!this.typingStarted) {
            if (!typeString(String(this.price))) {
                return this.waitTick();
            }
            this.typingStarted = true;
            return true;
        }
        this.advance();
        return false;
    }

    // Step 17: Wait for price typing to complete.
    private waitForPriceTyping(): boolean {
        if (isTyping()) {
            return this.waitTick();
        }
        this.advance();
        return false;
    }

    // Step 18: Press Enter to submit the price.
    private submitPrice(): boolean {
        if (!pressEnter()) {
            return this.waitTick();
        }
        this.advance();
        return true;
    }

    // Step 19: Click the confirm button.
    private clickConfirmStep(): boolean {
        if (!clickConfirm()) {
            return this.waitTick();
        }
        this.advance();
        return true;
    }

    // Step 20: Wait for the offer config screen to close and verify the
    // slot is now occupied (offer was placed).
    private waitForConfirm(): boolean {
        if (isGeOpen()) {
            return this.waitTick(); // config screen still open
        }
        // Config screen closed — verify the slot is occupied.
        if (!isSlotOccupied(this.slotIndex)) {
            // Give it a couple ticks to register.
            if (this.waitTicks < 3) {
                this.waitTicks++;
                return false;
            }
            this.fail('Offer was not placed — slot is still empty after confirm');
            return false;
        }
        this.advance();
        return false;
    }
}
