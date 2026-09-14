// ============================================================================
// Sell offer flow — state machine for placing a sell offer from start to finish
// ============================================================================
// This is a multi-tick state machine. The plugin creates an instance, calls
// tick() once per game tick, and checks .status to know when it's done.
//
// Usage:
//   const flow = new SellOfferFlow({ itemName: 'Air rune', quantity: 100, price: 5 });
//   if (flow.status === 'in_progress') {
//       if (flow.tick()) setAction(bot, 'sell_offer', flow.lastDelay);
//   }
//   if (flow.status === 'done') { /* proceed to next task */ }
//   if (flow.status === 'failed') { /* handle flow.error */ }
//
// tick() returns true when an action was dispatched (click, type, Enter).
// tick() returns false when it's just polling game state (no action).
// After tick() returns true, the caller should set a delay using lastDelay.
//
// Steps:
//   0:  Resolve slot and verify GE is open
//   1:  Click "Create Sell offer" on the chosen slot
//   2:  Wait for offer config screen to open
//   3:  Find the item in inventory and click it
//   4:  Wait for item to load in the config screen and validate name
//   5:  Check quantity — if item spans multiple inv slots, proceed to "All";
//       otherwise skip to price check (step 8)
//   6:  Click the "All" quantity button (only when item spans multiple inv slots)
//   7:  Wait for quantity to update to the full inventory total
//   8:  Check current price — if it matches target, skip to validate (step 14)
//   9:  Click "Enter price" button
//   10: Wait for price prompt
//   11: Type price
//   12: Wait for typing to complete
//   13: Press Enter to submit price
//   14: Validate offer (item name, price, quantity)
//   15: Click confirm
//   16: Wait for config screen to close and verify slot is occupied
//
// Note: Quantity is only set explicitly when the same item spans multiple
// inventory slots (e.g. a noted stack + unnoted singles). In that case,
// clicking a single inventory slot only selects that slot's quantity, so
// the "All" button must be clicked to combine all matching slots into one
// offer. When the item is in a single inventory slot, the GE already defaults
// to the full stack quantity, so the quantity steps are skipped.
// ============================================================================

import {
    clickSellSlot,
    clickQtyAll,
    typeString,
    pressEnter,
    clickPriceEnter,
    clickConfirm,
} from './actions.js';
import { GE_SELL_INVENTORY_WIDGET } from './constants.js';
import {
    isGeOpen,
    isOfferConfigOpen,
    isPricePromptShown,
    readOfferItemName,
    readOfferPrice,
    readOfferQuantity,
    findEmptyOfferSlot,
    isSlotOccupied,
    offerSlotCount,
    getOfferSlotState,
} from './widgets.js';
import { isTyping } from '../input/typing.js';
import { cancelTypingMistakeSequence } from '../input/typing-mistakes.js';
import { formatGeInput } from '../general/helpers.js';

export interface SellOfferOptions {
    /** Slot number 1-8, or undefined for first available empty slot. */
    slot?: number;
    /** Item name — used to find the item in inventory. */
    itemName: string;
    /** Quantity to sell. */
    quantity: number;
    /** Price per item. */
    price: number;
    /**
     * Optional humanised delay function. Called as
     * delayFn(base, triggerChance, max?, suppressDistractions?) after each
     * dispatching step. Returns the tick count to wait.
     */
    delayFn?: (base: number, triggerChance: number, max?: number, suppressDistractions?: boolean) => number;
    /**
     * Optional debug log callback.
     */
    debugLog?: (msg: string) => void;
}

export type SellOfferStatus = 'in_progress' | 'done' | 'failed';

// Max ticks to wait for any single game-state transition before re-attempting.
const MAX_WAIT_TICKS = 10;
// Max re-attempts for a single action before failing.
const MAX_REATTEMPTS = 3;

export class SellOfferFlow {
    status: SellOfferStatus = 'in_progress';
    error: string | null = null;

    /** Tick count to wait after the last dispatched action (read by the caller). */
    lastDelay: number = 1;

    private slotIndex: number = -1; // 0-indexed, -1 = first available
    private readonly _itemName: string;
    /** The item name being sold (public read-only access for overlay). */
    get itemName(): string { return this._itemName; }
    readonly quantity: number;
    readonly price: number;
    private readonly delayFn: (base: number, triggerChance: number, max?: number, suppressDistractions?: boolean) => number;
    private readonly debugLog: (msg: string) => void;

    private step = 0;
    private waitTicks = 0;
    private typingStarted = false;
    private reattempts = 0;
    // True when the item spans multiple inventory slots (e.g. noted stack +
    // unnoted singles). In that case clicking one inv slot only selects that
    // slot's quantity, so we must click the "All" button to combine all
    // matching slots into one offer. When false (single inv slot), the GE
    // already defaults to the full stack and no quantity step is needed.
    private needsQtyAll = false;

    constructor(opts: SellOfferOptions) {
        this._itemName = opts.itemName;
        this.quantity = opts.quantity;
        this.price = opts.price;
        this.delayFn = opts.delayFn ?? ((base: number) => Math.max(1, base));
        this.debugLog = opts.debugLog ?? (() => {});

        if (opts.slot !== undefined && opts.slot >= 1) {
            this.slotIndex = opts.slot - 1;
        }
    }

    tick(): boolean {
        if (this.status !== 'in_progress') return false;

        switch (this.step) {
            case 0:  return this.resolveSlot();
            case 1:  return this.clickSellSlotStep();
            case 2:  return this.waitForConfigScreen();
            case 3:  return this.clickInventoryItem();
            case 4:  return this.waitForItemLoad();
            case 5:  return this.checkQtyStep();
            case 6:  return this.clickQtyAllStep();
            case 7:  return this.waitForQtyUpdate();
            case 8:  return this.checkPriceStep();
            case 9:  return this.clickPriceEnterStep();
            case 10: return this.waitForPricePrompt();
            case 11: return this.startTypingPrice();
            case 12: return this.waitForPriceTyping();
            case 13: return this.submitPrice();
            case 14: return this.validateOffer();
            case 15: return this.clickConfirmStep();
            case 16: return this.waitForConfirm();
            default:
                this.status = 'done';
                return false;
        }
    }

    // --- Helpers ---

    private fail(reason: string): void {
        // Cancel any stuck typing-mistake sequence so it doesn't poison
        // the next typing operation.
        cancelTypingMistakeSequence();
        this.status = 'failed';
        this.error = reason;
    }

    private advance(): void {
        this.step++;
        this.waitTicks = 0;
        this.typingStarted = false;
        this.reattempts = 0;
    }

    private computeDelay(base: number = 1, triggerChance: number = 100, max?: number): void {
        // suppressDistractions=true — these are mid-flow steps in a connected
        // sequence of clicks where a 6-60s distraction pause is non-human.
        this.lastDelay = this.delayFn(base, triggerChance, max, true);
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
                // Cancel any stuck typing-mistake sequence before retrying.
                cancelTypingMistakeSequence();
                this.waitTicks = 0;
                this.typingStarted = false;
            }
        }
        return false;
    }

    // --- Step methods ---

    // Step 0: Resolve slot and verify GE is open.
    private resolveSlot(): boolean {
        this.log('Step 0: Resolving offer slot');
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
        // Verify the item is in the inventory. Sum the quantity across ALL
        // matching slots — the same item can appear as a noted stack and
        // unnoted singles in separate slots (e.g. 6 noted Warrior rings +
        // 1 unnoted in slot 2 + 1 unnoted in slot 3). The GE sell offer
        // screen automatically combines noted + unnoted when you set the
        // quantity, so we just need the total to be >= the offer quantity.
        // We click the first matching slot — the game handles the rest.
        const lowerName = this._itemName.trim().toLowerCase();
        const matches = titan.utils.inventory.getAll().filter(
            i => i.name.trim().toLowerCase() === lowerName,
        );
        if (matches.length === 0) {
            this.fail(`Item "${this._itemName}" not found in inventory`);
            return false;
        }
        const totalQty = matches.reduce((sum, i) => sum + i.quantity, 0);
        if (totalQty < this.quantity) {
            this.fail(`Not enough "${this._itemName}" in inventory: have ${totalQty}, need ${this.quantity}`);
            return false;
        }
        // If the item spans multiple inventory slots, clicking one slot only
        // selects that slot's quantity. We'll need to click the "All" button
        // to combine all matching slots into one offer.
        this.needsQtyAll = matches.length > 1;
        const item = matches[0];
        this.log(`Found ${totalQty}x ${this._itemName} in inventory (slot ${item.slot})${this.needsQtyAll ? ' — multi-slot, will click All' : ''}`);
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 1: Click the "Create Sell offer" button on the chosen slot.
    private clickSellSlotStep(): boolean {
        this.log(`Step 1: Clicking sell on slot ${this.slotIndex + 1}`);
        if (!clickSellSlot(this.slotIndex)) {
            return this.waitTick();
        }
        this.computeDelay(1, 25, 4);
        this.advance();
        return true;
    }

    // Step 2: Wait for the offer config screen to open.
    // Unlike buy (which shows a search prompt first), sell goes directly
    // to the offer config screen after clicking "Create Sell offer".
    private waitForConfigScreen(): boolean {
        if (!isOfferConfigOpen()) {
            return this.waitTick();
        }
        this.log('Offer config screen open');
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 3: Click the item in the inventory.
    // The GE sell config screen adds a dynamic "Offer" action to inventory
    // items. The SDK's item.interact('Offer') doesn't recognize this dynamic
    // action, so we click the inventory widget directly at the item's slot
    // index using the same opcode/identifier as a manual click:
    //   opcode=57 (CC_OP), identifier=1, childSlot=item.slot
    // The inventory widget packed ID is 30605312 (group 467, child 0).
    private clickInventoryItem(): boolean {
        this.log(`Step 3: Clicking "${this._itemName}" in inventory`);
        const item = titan.utils.inventory.find(this._itemName);
        if (!item) {
            // Item may have moved or been consumed — re-check.
            if (this.waitTicks < 2) {
                this.waitTicks++;
                return false;
            }
            this.fail(`Item "${this._itemName}" disappeared from inventory`);
            return false;
        }
        const invWidget = titan.state.widgets.find(GE_SELL_INVENTORY_WIDGET);
        if (!invWidget) {
            return this.waitTick();
        }
        const ok = invWidget.interact(57, 1, item.slot);
        if (!ok) {
            return this.waitTick();
        }
        this.computeDelay(1, 25, 4);
        this.advance();
        return true;
    }

    // Step 4: Wait for the item to load in the config screen and validate.
    private waitForItemLoad(): boolean {
        if (!isOfferConfigOpen()) {
            return this.waitTick();
        }
        const loadedName = readOfferItemName();
        if (!loadedName) {
            // Name not readable yet — give it a couple ticks.
            if (this.waitTicks < 3) {
                this.waitTicks++;
                return false;
            }
            this.fail('Could not read item name from offer config screen');
            return false;
        }
        if (loadedName.toLowerCase() !== this._itemName.toLowerCase()) {
            this.log(`Item mismatch: expected "${this._itemName}", got "${loadedName}" — escaping`);
            titan.keyboard.sendKey(titan.keyboard.Key.Escape);
            this.fail(`Wrong item loaded: expected "${this._itemName}", got "${loadedName}"`);
            return false;
        }
        this.log(`Item validated: "${loadedName}"`);
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 5: Check whether we need to set the quantity via the "All" button.
    // When the item spans multiple inventory slots (e.g. a noted stack +
    // unnoted singles), clicking one inventory slot only selects that slot's
    // quantity. The "All" button must be clicked to combine all matching
    // slots into one offer. When the item is in a single inventory slot, the
    // GE already defaults to the full stack, so we skip to the price check.
    private checkQtyStep(): boolean {
        if (!this.needsQtyAll) {
            this.log('Step 5: Single inventory slot — GE defaults to full qty, skipping "All"');
            this.step = 8; // skip to price check
            this.waitTicks = 0;
            this.reattempts = 0;
            this.computeDelay(1, 30, 4);
            this.advance();
            return true;
        }
        // Multi-slot: check if the GE already shows the full quantity (e.g.
        // it auto-combined on click). If so, skip the "All" click.
        const currentQty = readOfferQuantity();
        if (currentQty !== null && currentQty === this.quantity) {
            this.log(`Step 5: Qty already ${currentQty} (matches target) — skipping "All"`);
            this.step = 8; // skip to price check
            this.waitTicks = 0;
            this.reattempts = 0;
            this.computeDelay(1, 30, 4);
            this.advance();
            return true;
        }
        this.log(`Step 5: Multi-slot item — qty=${currentQty ?? 'unknown'} ≠ target ${this.quantity} — will click "All"`);
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 6: Click the "All" quantity button to set the quantity to the
    // full inventory stack. This combines all matching inventory slots
    // (noted + unnoted) into one sell offer.
    private clickQtyAllStep(): boolean {
        this.log('Step 6: Clicking "All" quantity button');
        if (!clickQtyAll()) {
            return this.waitTick();
        }
        this.computeDelay(1, 25, 4);
        this.advance();
        return true;
    }

    // Step 7: Wait for the quantity to update to the full inventory total.
    private waitForQtyUpdate(): boolean {
        if (!isOfferConfigOpen()) {
            return this.waitTick();
        }
        const currentQty = readOfferQuantity();
        if (currentQty === null) {
            return this.waitTick();
        }
        if (currentQty !== this.quantity) {
            this.log(`Step 7: Qty ${currentQty} ≠ target ${this.quantity} after "All" click`);
            return this.waitTick();
        }
        this.log(`Step 7: Qty confirmed at ${currentQty}`);
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 8: Check the current price. The GE defaults to the market price
    // when an item is loaded into the sell config screen. If the defaulted
    // price already matches our target price, skip the price entry steps
    // entirely and go straight to validation (step 14).
    private checkPriceStep(): boolean {
        const currentPrice = readOfferPrice();
        if (currentPrice !== null && currentPrice === this.price) {
            this.log(`Step 8: Current price ${currentPrice}gp matches target — skipping price entry`);
            this.step = 14; // skip to validate
            this.waitTicks = 0;
            this.reattempts = 0;
            // Still set a delay before the next action (validation).
            this.computeDelay(1, 30, 4);
            this.advance();
            return true;
        }
        this.log(`Step 8: Current price ${currentPrice ?? 'unknown'}gp ≠ target ${this.price}gp — will set price`);
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 9: Click the "Enter price" button.
    private clickPriceEnterStep(): boolean {
        this.log('Step 9: Clicking "Enter price"');
        if (!clickPriceEnter()) {
            return this.waitTick();
        }
        this.computeDelay(1, 25, 4);
        this.advance();
        return true;
    }

    // Step 10: Wait for the price prompt to appear.
    private waitForPricePrompt(): boolean {
        if (!isPricePromptShown()) {
            return this.waitTick();
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 11: Start typing the price.
    private startTypingPrice(): boolean {
        this.log(`Step 11: Typing price "${formatGeInput(this.price)}"`);
        if (!this.typingStarted) {
            if (!typeString(formatGeInput(this.price), 'price')) {
                return this.waitTick();
            }
            this.typingStarted = true;
            this.computeDelay(1, 25, 4);
            return true;
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 12: Wait for price typing to complete.
    private waitForPriceTyping(): boolean {
        if (isTyping()) {
            return this.waitTick();
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 13: Press Enter to submit the price.
    private submitPrice(): boolean {
        this.log('Step 13: Pressing Enter to submit price');
        if (!pressEnter()) {
            return this.waitTick();
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 14: Validate the offer before confirming.
    // Validates item name, price, and (when applicable) quantity.
    private validateOffer(): boolean {
        if (this.waitTicks < 1) {
            this.waitTicks++;
            return false;
        }
        const loadedPrice = readOfferPrice();
        const loadedName = readOfferItemName();
        const loadedQty = readOfferQuantity();

        const errors: string[] = [];
        if (loadedName && loadedName.toLowerCase() !== this._itemName.toLowerCase()) {
            errors.push(`item: expected "${this._itemName}", got "${loadedName}"`);
        }
        if (loadedPrice !== null && loadedPrice !== this.price) {
            errors.push(`price: expected ${this.price}, got ${loadedPrice}`);
        }
        if (this.needsQtyAll && loadedQty !== null && loadedQty !== this.quantity) {
            errors.push(`qty: expected ${this.quantity}, got ${loadedQty}`);
        }

        if (errors.length > 0) {
            const msg = `Offer validation failed — ${errors.join(', ')}`;
            this.log(msg);
            titan.keyboard.sendKey(titan.keyboard.Key.Escape);
            this.fail(msg);
            return false;
        }

        this.log(`Offer validated: ${this._itemName} @ ${this.price}gp each${this.needsQtyAll ? ` (qty ${loadedQty ?? this.quantity})` : ''}`);
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 15: Click the confirm button.
    private clickConfirmStep(): boolean {
        this.log('Step 15: Clicking confirm');
        if (!clickConfirm()) {
            return this.waitTick();
        }
        this.computeDelay(1, 25, 4);
        this.advance();
        return true;
    }

    // Step 16: Wait for the config screen to close and verify the slot.
    private waitForConfirm(): boolean {
        if (isOfferConfigOpen()) {
            return this.waitTick();
        }
        if (!isSlotOccupied(this.slotIndex)) {
            // 10 ticks (6s) grace — after a hot reload, the confirm click
            // can take longer to register. A false failure here would lose
            // the sell and leave the inventory item unlisted.
            if (this.waitTicks < 10) {
                this.waitTicks++;
                return false;
            }
            this.fail('Offer was not placed — slot is still empty after confirm');
            return false;
        }
        const slotState = getOfferSlotState(this.slotIndex);
        if (slotState.itemName && slotState.itemName.toLowerCase() !== this._itemName.toLowerCase()) {
            this.fail(`Offer placed with wrong item: expected "${this._itemName}", got "${slotState.itemName}"`);
            return false;
        }
        this.log(`Sell offer confirmed in slot ${this.slotIndex + 1}: ${slotState.itemName ?? this._itemName}`);
        this.advance();
        return false;
    }
}
