// ============================================================================
// Buy offer flow — state machine for placing a buy offer from start to finish
// ============================================================================
// This is a multi-tick state machine. The plugin creates an instance, calls
// tick() once per game tick, and checks .status to know when it's done.
//
// Usage:
//   const offer = new BuyOfferFlow({ itemName: 'Air rune', quantity: 100, price: 5 });
//   // Each tick, when the bot is ready to act:
//   if (offer.status === 'in_progress') {
//       if (offer.tick()) setAction(bot, 'buy_offer', offer.lastDelay);
//   }
//   if (offer.status === 'done') { /* proceed to next task */ }
//   if (offer.status === 'failed') { /* handle offer.error */ }
//
// tick() returns true when an action was dispatched (click, type, Enter).
// tick() returns false when it's just polling game state (no action).
// After tick() returns true, the caller should set a delay using offer.lastDelay.
// ============================================================================

import {
    clickBuySlot,
    typeString,
    pressEnter,
    clickQtyEnter,
    clickPriceEnter,
    clickConfirm,
    clickSearchResult,
} from './actions.js';
import {
    isGeOpen,
    isOfferConfigOpen,
    isSearchPromptShown,
    isPricePromptShown,
    readOfferItemName,
    readOfferQuantity,
    readOfferPrice,
    findEmptyOfferSlot,
    isSlotOccupied,
    offerSlotCount,
    auditGeState,
    getOfferSlotState,
    scanSearchResults,
    type GeAudit,
    type OfferSlotState,
} from './widgets.js';
import { isTyping } from '../input/typing.js';
import { cancelTypingMistakeSequence } from '../input/typing-mistakes.js';

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
    /**
     * Optional humanised delay function. Called as delayFn(base, triggerChance, max?)
     * after each dispatching step. Returns the tick count to wait. If not
     * provided, defaults to the base (no humanisation).
     */
    delayFn?: (base: number, triggerChance: number, max?: number) => number;
    /**
     * Optional debug log callback. Called before each action with a
     * human-readable description of what the step is about to do.
     */
    debugLog?: (msg: string) => void;
}

export type BuyOfferStatus = 'in_progress' | 'done' | 'failed';

// Max ticks to wait for any single game-state transition before failing.
const MAX_WAIT_TICKS = 10;
// Max re-attempts for a single action (click/type/enter) before failing.
const MAX_REATTEMPTS = 3;

export class BuyOfferFlow {
    status: BuyOfferStatus = 'in_progress';
    error: string | null = null;

    /** Tick count to wait after the last dispatched action (read by the caller). */
    lastDelay: number = 1;

    private slotIndex: number = -1; // 0-indexed, -1 = first available
    private _itemName: string = '';
    /** The item name being bought (public read-only access for overlay). */
    get itemName(): string { return this._itemName; }
    readonly quantity: number;
    readonly price: number;
    private readonly delayFn: (base: number, triggerChance: number, max?: number) => number;
    private readonly debugLog: (msg: string) => void;

    private step = 0;
    private waitTicks = 0;
    private typingStarted = false;
    // Re-attempt counter per step. Reset on advance(). If an action fails
    // (returns false or the expected state doesn't appear), we re-attempt
    // up to MAX_REATTEMPTS times before failing. This prevents spam-clicking:
    // we only re-attempt when the expected state hasn't appeared after waiting.
    private reattempts = 0;
    // Set by step 6 when the GE's default price already matches our target
    // but the quantity doesn't. After the quantity is submitted (step 12),
    // we skip the price entry steps (13-16) and go straight to validation
    // (step 17) instead of clicking "Enter price".
    private _skipPriceEntry = false;

    constructor(opts: BuyOfferOptions) {
        this.quantity = opts.quantity;
        this.price = opts.price;
        // Default delayFn returns the base unchanged (no humanisation).
        this.delayFn = opts.delayFn ?? ((base: number) => Math.max(1, base));

        // Default debugLog is a no-op.
        this.debugLog = opts.debugLog ?? (() => {});

        // Resolve item name — need it for the GE search.
        if (opts.itemName) {
            this._itemName = opts.itemName;
        } else if (opts.itemId !== undefined) {
            const def = titan.state.itemDef(opts.itemId);
            if (def && def.name) {
                this._itemName = def.name;
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

    // resumeFromState()
    // Reconstructs the flow step from a live GE state audit. Called on
    // script start (onEnable) to recover after a reload/disconnect. The
    // flow picks up at the correct step instead of starting from 0.
    //
    // Recovery logic:
    //   - GE closed → fail (can't recover, need GE open)
    //   - Offer config open with correct item + correct qty + correct price → step 18 (validate & confirm)
    //   - Offer config open with correct item + correct qty but wrong/missing price → step 12 (click price enter)
    //   - Offer config open with correct item but wrong/missing qty → step 7 (click qty enter)
    //   - Offer config open with wrong item → fail (can't safely recover)
    //   - Search prompt open → step 3 (start typing)
    //   - Price prompt open → step 14 (start typing price)
    //   - GE main screen with a slot matching our item → offer already placed, done
    //   - GE main screen, no matching slot → start fresh from step 0
    resumeFromState(audit: GeAudit): void {
        if (this.status !== 'in_progress') return;

        if (!audit.geOpen) {
            this.fail('GE is not open — cannot resume');
            return;
        }

        // Price prompt is open — we were mid-price-entry.
        if (audit.screen === 'price_prompt') {
            this.log('Resume: price prompt open — resuming at price typing');
            this.step = 14;
            this.resolveSlotFromAudit(audit);
            return;
        }

        // Search prompt is open — we were mid-search.
        if (audit.screen === 'search_prompt') {
            this.log('Resume: search prompt open — resuming at search typing');
            this.step = 3;
            this.resolveSlotFromAudit(audit);
            return;
        }

        // Offer config screen is open — determine how far we got.
        if (audit.screen === 'offer_config') {
            const configName = audit.configItemName;
            if (!configName) {
                // Config screen open but item name not readable yet — wait for it.
                this.log('Resume: offer config open but item name not readable — waiting at step 6');
                this.step = 6;
                this.resolveSlotFromAudit(audit);
                return;
            }
            if (configName.toLowerCase() !== this._itemName.toLowerCase()) {
                this.fail(`Resume: wrong item in config screen — expected "${this._itemName}", got "${configName}"`);
                return;
            }
            // Item matches. Check qty and price to determine step.
            const qtyOk = audit.configQuantity !== null && audit.configQuantity === this.quantity;
            const priceOk = audit.configPrice !== null && audit.configPrice === this.price;
            if (qtyOk && priceOk) {
                this.log('Resume: offer config complete — resuming at validate & confirm');
                this.step = 17;
            } else if (qtyOk && !priceOk) {
                this.log('Resume: qty correct, price not set — resuming at price entry');
                this.step = 12;
            } else {
                this.log('Resume: item correct, qty not set — resuming at qty entry');
                this.step = 7;
            }
            this.resolveSlotFromAudit(audit);
            return;
        }

        // Main GE screen — check if our offer was already placed.
        for (let i = 0; i < audit.slots.length; i++) {
            const s = audit.slots[i];
            if (s.type === 'buy' && s.itemName && s.itemName.toLowerCase() === this._itemName.toLowerCase()) {
                this.log(`Resume: offer already placed in slot ${i + 1} — done`);
                this.slotIndex = i;
                this.status = 'done';
                return;
            }
        }

        // Main GE screen, no matching offer — start fresh.
        this.log('Resume: GE main screen, no matching offer — starting fresh');
        this.step = 0;
    }

    // resolveSlotFromAudit()
    // Tries to determine which slot we were using from the audit. If a slot
    // has a buy offer matching our item, that's our slot. Otherwise leave
    // slotIndex as-is (it may have been set in the constructor).
    private resolveSlotFromAudit(audit: GeAudit): void {
        for (let i = 0; i < audit.slots.length; i++) {
            const s = audit.slots[i];
            if (s.type === 'buy' && s.itemName && s.itemName.toLowerCase() === this._itemName.toLowerCase()) {
                this.slotIndex = i;
                this.log(`Resume: identified slot ${i + 1} from audit`);
                return;
            }
        }
        // If no slot found and slotIndex is still -1, resolveSlot() will
        // find an empty one on the next tick.
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
            case 5:  return this.clickSearchResultStep();
            case 6:  return this.waitForConfigAndValidate();
            case 7:  return this.clickQtyEnterStep();
            case 8:  return this.waitForQtyPrompt();
            case 9:  return this.startTypingQty();
            case 10: return this.waitForQtyTyping();
            case 11: return this.submitQty();
            case 12: return this.clickPriceEnterStep();
            case 13: return this.waitForPricePrompt();
            case 14: return this.startTypingPrice();
            case 15: return this.waitForPriceTyping();
            case 16: return this.submitPrice();
            case 17: return this.validateOffer();
            case 18: return this.clickConfirmStep();
            case 19: return this.waitForConfirm();
            default:
                this.status = 'done';
                return false;
        }
    }

    // --- Helpers ---

    private fail(reason: string): void {
        // Cancel any stuck typing-mistake sequence so it doesn't poison
        // the next typing operation (a stuck sequence keeps isTyping()
        // true, preventing any waitForTyping step from ever advancing).
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

    // computeDelay()
    // Call after dispatching an action. Stores the humanised delay in
    // lastDelay so the caller can read it for setAction(). Uses base=1,
    // triggerChance=100 (full humanisation on every step — tweak later).
    // max: optional ceiling to clip the delay (useful for testing).
    private computeDelay(base: number = 1, triggerChance: number = 100, max?: number): void {
        this.lastDelay = this.delayFn(base, triggerChance, max);
        this.log(`Step ${this.step}: Delaying ${this.lastDelay} tick${this.lastDelay === 1 ? '' : 's'}`);
    }

    // log()
    // Debug log a message before an action. The caller (plugin) decides
    // whether to actually print it via the debugLog callback.
    private log(msg: string): void {
        this.debugLog(msg);
    }

    // waitTick()
    // Called when polling game state (no action dispatched). Increments
    // the wait counter. If we exceed MAX_WAIT_TICKS, we re-attempt the
    // action (up to MAX_REATTEMPTS times) by resetting the step's wait
    // counter. After MAX_REATTEMPTS re-attempts, we fail.
    private waitTick(): boolean {
        this.waitTicks++;
        if (this.waitTicks > MAX_WAIT_TICKS) {
            this.reattempts++;
            if (this.reattempts > MAX_REATTEMPTS) {
                this.fail(`Timed out at step ${this.step} after ${MAX_REATTEMPTS} re-attempts`);
            } else {
                this.log(`Step ${this.step}: state not reached, re-attempt ${this.reattempts}/${MAX_REATTEMPTS}`);
                // Cancel any stuck typing-mistake sequence before retrying.
                // A stuck sequence keeps isTyping() true, so the re-attempt
                // would also hang at the waitForTyping step without this.
                cancelTypingMistakeSequence();
                this.waitTicks = 0;
                this.typingStarted = false;
            }
        }
        return false; // no action dispatched, just polling
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
        this.computeDelay(1, 30, 4);
        this.advance();
        return true; // resolved, set a delay before clicking
    }

    // Step 1: Click the buy button on the chosen slot.
    private clickBuySlotStep(): boolean {
        this.log(`Step 1: Clicking buy on slot ${this.slotIndex + 1}`);
        if (!clickBuySlot(this.slotIndex)) {
            return this.waitTick(); // widget not ready, retry
        }
        this.computeDelay(2, 30, 4);
        this.advance();
        return true;
    }

    // Step 2: Wait for the search prompt to appear.
    private waitForSearchPrompt(): boolean {
        if (!isSearchPromptShown()) {
            return this.waitTick();
        }
        // Set a delay before the next action (typing).
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 3: Start typing the item name.
    private startTypingSearch(): boolean {
        this.log(`Step 3: Typing search "${this._itemName}"`);
        if (!this.typingStarted) {
            if (!typeString(this._itemName, 'name')) {
                return this.waitTick(); // typing couldn't start, retry
            }
            this.typingStarted = true;
            this.computeDelay(1, 30, 4);
            return true; // typing started, set a delay
        }
        // Already started — shouldn't reach here, but advance just in case.
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 4: Wait for typing to complete.
    private waitForSearchTyping(): boolean {
        if (isTyping()) {
            return this.waitTick();
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 5: Scan search results and click the exact match.
    // Instead of pressing Enter (which selects the first result and can pick
    // the wrong item — e.g. "Charcoal" when searching "Coal"), we scan the
    // search result text widgets for an exact case-insensitive name match
    // and click that specific result by its child slot index.
    private clickSearchResultStep(): boolean {
        const { active, matchIndex } = scanSearchResults(this._itemName);
        if (!active) {
            // Results not visible yet — wait for them to appear.
            return this.waitTick();
        }
        if (matchIndex < 0) {
            // Results are visible but no exact match — fail.
            this.fail(`No exact match for "${this._itemName}" in GE search results`);
            return false;
        }
        this.log(`Step 5: Clicking search result "${this._itemName}" (index ${matchIndex})`);
        if (!clickSearchResult(matchIndex)) {
            return this.waitTick();
        }
        this.computeDelay(2, 30, 4);
        this.advance();
        return true;
    }

    // Step 6: Wait for the offer configuration screen and validate the item.
    // After Enter selects the first result, the config screen opens showing
    // the item name. We compare it to what we searched for — if it doesn't
    // match, we Escape out and fail to prevent buying the wrong item.
    private waitForConfigAndValidate(): boolean {
        if (isSearchPromptShown() || !isOfferConfigOpen()) {
            return this.waitTick();
        }
        // Validate the item name matches what we intended to buy.
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
            // Wrong item loaded — Escape out and fail.
            this.log(`Item mismatch: expected "${this._itemName}", got "${loadedName}" — escaping`);
            titan.keyboard.sendKey(titan.keyboard.Key.Escape);
            this.fail(`Wrong item loaded: expected "${this._itemName}", got "${loadedName}"`);
            return false;
        }
        this.log(`Item validated: "${loadedName}"`);
        // Check if the GE's default quantity and price already match our
        // targets. The buy config screen defaults to qty=1 and a market
        // price. If our target qty is 1, skip the qty entry steps (7-11).
        // If the default price also matches, skip the price entry steps
        // (12-16) and go straight to validation (step 17).
        const currentQty = readOfferQuantity();
        const currentPrice = readOfferPrice();
        const qtyOk = currentQty !== null && currentQty === this.quantity;
        const priceOk = currentPrice !== null && currentPrice === this.price;
        if (qtyOk && priceOk) {
            this.log(`Step 6: qty=${currentQty} and price=${currentPrice}gp already match target — skipping entry steps`);
            this.step = 17; // skip to validate
            this.waitTicks = 0;
            this.reattempts = 0;
            this.computeDelay(1, 30, 4);
            this.advance();
            return true;
        }
        if (priceOk && !qtyOk) {
            // Price already matches but qty doesn't — skip price entry after
            // qty is set. We'll still type the qty, then jump to validation.
            this.log(`Step 6: price=${currentPrice}gp matches target, qty=${currentQty ?? 'unknown'} ≠ ${this.quantity} — will set qty only`);
            this._skipPriceEntry = true;
        } else if (qtyOk && !priceOk) {
            // Qty already matches but price doesn't — skip qty entry, go
            // straight to price entry. Set step=11 so advance() brings us
            // to step 12 (clickPriceEnterStep) — the actual "Enter price"
            // click. Setting step=12 here would advance to 13
            // (waitForPricePrompt) which skips the click entirely.
            this.log(`Step 6: qty=${currentQty} matches target, price=${currentPrice ?? 'unknown'}gp ≠ ${this.price}gp — will set price only`);
            this.step = 11; // advance() -> 12 = clickPriceEnterStep
            this.waitTicks = 0;
            this.reattempts = 0;
            this.computeDelay(1, 30, 4);
            this.advance();
            return true;
        }
        // Set a delay before the next action (clicking qty enter).
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 8: Click the "Enter quantity" button.
    private clickQtyEnterStep(): boolean {
        this.log('Step 8: Clicking "Enter quantity"');
        if (!clickQtyEnter()) {
            return this.waitTick();
        }
        this.computeDelay(2, 30, 4);
        this.advance();
        return true;
    }

    // Step 9: Wait for the quantity input prompt.
    // The OSRS GE quantity prompt appears in the chatbox. We don't have a
    // dedicated widget ID for it, so we wait 1 tick for the prompt to
    // register after the click.
    private waitForQtyPrompt(): boolean {
        if (this.waitTicks < 1) {
            this.waitTicks++;
            return false;
        }
        // Set a delay before the next action (typing the quantity).
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 10: Start typing the quantity.
    private startTypingQty(): boolean {
        this.log(`Step 10: Typing quantity "${this.quantity}"`);
        if (!this.typingStarted) {
            if (!typeString(String(this.quantity), 'quantity')) {
                return this.waitTick();
            }
            this.typingStarted = true;
            this.computeDelay(1, 30, 4);
            return true;
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 11: Wait for quantity typing to complete.
    private waitForQtyTyping(): boolean {
        if (isTyping()) {
            return this.waitTick();
        }
        // Set a delay before the next action (pressing Enter).
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 12: Press Enter to submit the quantity.
    private submitQty(): boolean {
        this.log('Step 12: Pressing Enter to submit quantity');
        if (!pressEnter()) {
            return this.waitTick();
        }
        // If the default price already matched our target (detected in step 6),
        // skip the price entry steps and go straight to validation.
        if (this._skipPriceEntry) {
            this.log('Step 12: skipping price entry — default price already matches target');
            this.step = 17; // skip to validate
            this.waitTicks = 0;
            this.reattempts = 0;
            this.computeDelay(1, 30, 4);
            this.advance();
            return true;
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 13: Click the "Enter price" button.
    private clickPriceEnterStep(): boolean {
        this.log('Step 13: Clicking "Enter price"');
        if (!clickPriceEnter()) {
            return this.waitTick();
        }
        this.computeDelay(2, 30, 4);
        this.advance();
        return true;
    }

    // Step 14: Wait for the price prompt to appear.
    private waitForPricePrompt(): boolean {
        if (!isPricePromptShown()) {
            return this.waitTick();
        }
        // Set a delay before the next action (typing the price).
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 15: Start typing the price.
    private startTypingPrice(): boolean {
        this.log(`Step 15: Typing price "${this.price}"`);
        if (!this.typingStarted) {
            if (!typeString(String(this.price), 'price')) {
                return this.waitTick();
            }
            this.typingStarted = true;
            this.computeDelay(1, 30, 4);
            return true;
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 16: Wait for price typing to complete.
    private waitForPriceTyping(): boolean {
        if (isTyping()) {
            return this.waitTick();
        }
        // Set a delay before the next action (pressing Enter).
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 17: Press Enter to submit the price.
    private submitPrice(): boolean {
        this.log('Step 17: Pressing Enter to submit price');
        if (!pressEnter()) {
            return this.waitTick();
        }
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 18: Validate the offer before confirming.
    // Reads the quantity and price from the offer config screen and compares
    // them to what we intended. If anything doesn't match, we Escape out and
    // fail to prevent an incorrect purchase.
    private validateOffer(): boolean {
        // Give the screen a tick to update after pressing Enter on the price.
        if (this.waitTicks < 1) {
            this.waitTicks++;
            return false;
        }
        const loadedQty = readOfferQuantity();
        const loadedPrice = readOfferPrice();
        const loadedName = readOfferItemName();

        const errors: string[] = [];
        if (loadedName && loadedName.toLowerCase() !== this._itemName.toLowerCase()) {
            errors.push(`item: expected "${this._itemName}", got "${loadedName}"`);
        }
        if (loadedQty !== null && loadedQty !== this.quantity) {
            errors.push(`quantity: expected ${this.quantity}, got ${loadedQty}`);
        }
        if (loadedPrice !== null && loadedPrice !== this.price) {
            errors.push(`price: expected ${this.price}, got ${loadedPrice}`);
        }

        if (errors.length > 0) {
            const msg = `Offer validation failed — ${errors.join(', ')}`;
            this.log(msg);
            // Escape out of the config screen to prevent an incorrect purchase.
            titan.keyboard.sendKey(titan.keyboard.Key.Escape);
            this.fail(msg);
            return false;
        }

        this.log(`Offer validated: ${this.quantity}x ${this._itemName} @ ${this.price}gp each`);
        // Set a delay before the next action (clicking confirm).
        this.computeDelay(1, 30, 4);
        this.advance();
        return true;
    }

    // Step 19: Click the confirm button.
    private clickConfirmStep(): boolean {
        this.log('Step 19: Clicking confirm');
        if (!clickConfirm()) {
            return this.waitTick();
        }
        this.computeDelay(2, 30, 4);
        this.advance();
        return true;
    }

    // Step 19: Wait for the offer config screen to close and verify the
    // slot is now occupied with the correct item (offer was placed).
    private waitForConfirm(): boolean {
        if (isOfferConfigOpen()) {
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
        // Verify the slot contains the correct item.
        const slotState = getOfferSlotState(this.slotIndex);
        if (slotState.itemName && slotState.itemName.toLowerCase() !== this._itemName.toLowerCase()) {
            this.fail(`Offer placed with wrong item: expected "${this._itemName}", got "${slotState.itemName}"`);
            return false;
        }
        this.log(`Offer confirmed in slot ${this.slotIndex + 1}: ${slotState.itemName ?? this._itemName}`);
        this.advance();
        return false;
    }
}
