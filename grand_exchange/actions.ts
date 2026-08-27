import { findWidget, widgetShown } from './widgets.js';
import { humanType } from '../input/typing.js';
import {
    GE_OFFER_SLOT_WIDGET_IDS,
    GE_AMOUNT_WIDGET,
    GE_CONFIRM_WIDGET,
    GE_COLLECT_WIDGET,
    GE_COLLECT_SLOT,
    GE_COLLECT_TO_INVENTORY,
    GE_COLLECT_TO_BANK,
    GE_QTY_ENTER_SLOT,
    GE_PRICE_ENTER_SLOT,
    GE_SLOT_CREATE_BUY,
    GE_SLOT_CREATE_SELL,
} from './constants.js';

// clickWidget()
// Dispatch a CC_OP (opcode 57) against a widget using the instance interact
// method, which includes a synthetic click at the widget's screen bounds.
// The static titan.state.widgets.interact() does NOT include a synthetic
// click — using it would be a detection vector (DoAction without mouse
// activity at widget coordinates).
// childSlot selects a dynamic child beneath the widget (undefined for whole widget).
export const clickWidget = (packedId: number, childSlot: number = -1, identifier: number = 1): boolean => {
    const w = findWidget(packedId);
    if (!w) return false;
    return w.interact(57, identifier, childSlot >= 0 ? childSlot : undefined);
};

// typeString()
// Type a string into the active search/price/quantity input with humanlike
// per-character delays. Accepts optional delay range override and a
// completion callback (fires with true when done, false if cancelled).
export const typeString = (
    str: string,
    opts?: { minDelayMs?: number; maxDelayMs?: number },
    onDone?: (completed: boolean) => void,
): boolean => humanType(str, opts, onDone);

// pressEnter()
export const pressEnter = (): boolean =>
    titan.keyboard.sendKey(titan.keyboard.Key.Enter);

// clickBuySlot()
// Click the "Buy" button on an offer slot to open the buy search screen.
export const clickBuySlot = (slotIndex: number): boolean => {
    const packedId = GE_OFFER_SLOT_WIDGET_IDS[slotIndex];
    if (!findWidget(packedId)) return false;
    return clickWidget(packedId, GE_SLOT_CREATE_BUY);
};

// clickSellSlot()
// Click the "Sell" button on an offer slot to open the sell screen.
export const clickSellSlot = (slotIndex: number): boolean => {
    const packedId = GE_OFFER_SLOT_WIDGET_IDS[slotIndex];
    if (!findWidget(packedId)) return false;
    return clickWidget(packedId, GE_SLOT_CREATE_SELL);
};

// clickQtyEnter()
// Click the "Enter quantity" button on the offer configuration screen.
export const clickQtyEnter = (): boolean =>
    clickWidget(GE_AMOUNT_WIDGET, GE_QTY_ENTER_SLOT);

// clickPriceEnter()
// Click the "Enter price" button on the offer configuration screen.
export const clickPriceEnter = (): boolean =>
    clickWidget(GE_AMOUNT_WIDGET, GE_PRICE_ENTER_SLOT);

// clickConfirm()
// Confirm the current offer.
export const clickConfirm = (): boolean =>
    clickWidget(GE_CONFIRM_WIDGET);

// clickCollectToInventory()
// Collect all items from completed offers to the inventory.
export const clickCollectToInventory = (): boolean =>
    clickWidget(GE_COLLECT_WIDGET, GE_COLLECT_SLOT, GE_COLLECT_TO_INVENTORY);

// clickCollectToBank()
// Collect all items from completed offers to the bank.
export const clickCollectToBank = (): boolean =>
    clickWidget(GE_COLLECT_WIDGET, GE_COLLECT_SLOT, GE_COLLECT_TO_BANK);
