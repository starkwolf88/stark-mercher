import { findWidget, widgetShown } from './widgets.js';
import { humanType } from '../input/typing.js';
import { clickWithJitter, sendKeyWithJitter } from '../antiban/click-jitter.js';
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
    GE_ABORT_WIDGET,
    GE_ABORT_SLOT,
    GE_BACK_WIDGET,
    GE_SEARCH_RESULT_TEXT_WIDGET,
} from './constants.js';

// clickWidget()
// Dispatch a CC_OP (opcode 57) against a widget using the instance interact
// method, which includes a synthetic click at the widget's screen bounds.
// The static titan.state.widgets.interact() does NOT include a synthetic
// click — using it would be a detection vector (DoAction without mouse
// activity at widget coordinates).
// childSlot selects a dynamic child beneath the widget (undefined for whole widget).
//
// All clicks are routed through clickWithJitter() which defers the interact()
// to a client tick (~20ms) with 0-N client ticks of reaction-time jitter.
// This prevents clicks from landing on exact game-tick boundaries (0/600/1200ms)
// — the strongest bot fingerprint over long sessions.
//
// Because the click is deferred, this function returns true if the widget was
// found (the click will be dispatched) and false if the widget was not found.
// The actual interact() result is delivered via the onAccepted/onRejected
// callbacks.
export const clickWidget = (
    packedId: number,
    childSlot: number = -1,
    identifier: number = 1,
    opts?: { doubleClick?: boolean; onAccepted?: () => void; onRejected?: () => void; reason?: string },
): boolean => {
    const w = findWidget(packedId);
    if (!w) return false;
    const reason = opts?.reason ?? `widget ${packedId}`;
    // Build a human-readable description of the exact interact() call for
    // debug logging. Shows whether childSlot is passed or omitted.
    const callDesc = childSlot >= 0
        ? `interact(57, ${identifier}, ${childSlot})`
        : `interact(57, ${identifier})`;
    // Re-resolve the widget inside the callback — the handle from findWidget
    // may be stale by the time the deferred click fires (1-2 client ticks later).
    // When childSlot is -1 (no dynamic child), omit the third arg entirely
    // rather than passing undefined — the SDK's native binding may treat
    // "arg not passed" differently from "arg is undefined".
    clickWithJitter(
        () => {
            const live = titan.state.widgets.find(packedId);
            if (!live) {
                titan.logf('[Stark Mercher] Click widget not found: %s (packedId=%d)', reason, packedId);
                return false;
            }
            const ok = childSlot >= 0
                ? live.interact(57, identifier, childSlot)
                : live.interact(57, identifier);
            titan.logf('[Stark Mercher] Click %s: %s -> %s (packedId=%d)', reason, callDesc, ok, packedId);
            return ok;
        },
        {
            doubleClick: opts?.doubleClick,
            onAccepted: opts?.onAccepted,
            onRejected: opts?.onRejected,
            reason,
        },
    );
    return true; // widget found, click dispatched
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
// Press Enter with reaction-time jitter (deferred to a client tick).
// Returns true if the key dispatch was scheduled. The actual result is
// delivered via the onResult callback if provided.
export const pressEnter = (opts?: { reason?: string; onResult?: (ok: boolean) => void }): boolean => {
    sendKeyWithJitter(
        () => titan.keyboard.sendKey(titan.keyboard.Key.Enter),
        { reason: opts?.reason ?? 'Enter', onResult: opts?.onResult },
    );
    return true;
};

// clickBuySlot()
// Click the "Buy" button on an offer slot to open the buy search screen.
export const clickBuySlot = (slotIndex: number): boolean => {
    const packedId = GE_OFFER_SLOT_WIDGET_IDS[slotIndex];
    if (!findWidget(packedId)) return false;
    return clickWidget(packedId, GE_SLOT_CREATE_BUY, 1, { reason: `buy slot ${slotIndex + 1}` });
};

// clickSellSlot()
// Click the "Sell" button on an offer slot to open the sell screen.
export const clickSellSlot = (slotIndex: number): boolean => {
    const packedId = GE_OFFER_SLOT_WIDGET_IDS[slotIndex];
    if (!findWidget(packedId)) return false;
    return clickWidget(packedId, GE_SLOT_CREATE_SELL, 1, { reason: `sell slot ${slotIndex + 1}` });
};

// clickQtyEnter()
// Click the "Enter quantity" button on the offer configuration screen.
export const clickQtyEnter = (): boolean =>
    clickWidget(GE_AMOUNT_WIDGET, GE_QTY_ENTER_SLOT, 1, { reason: 'enter quantity' });

// clickPriceEnter()
// Click the "Enter price" button on the offer configuration screen.
export const clickPriceEnter = (): boolean =>
    clickWidget(GE_AMOUNT_WIDGET, GE_PRICE_ENTER_SLOT, 1, { reason: 'enter price' });

// clickConfirm()
// Confirm the current offer.
export const clickConfirm = (): boolean =>
    clickWidget(GE_CONFIRM_WIDGET, -1, 1, { reason: 'confirm offer' });

// clickCollectToInventory()
// Collect all items from completed offers to the inventory.
export const clickCollectToInventory = (): boolean =>
    clickWidget(GE_COLLECT_WIDGET, GE_COLLECT_SLOT, GE_COLLECT_TO_INVENTORY, { reason: 'collect to inventory' });

// clickCollectToBank()
// Collect all items from completed offers to the bank.
export const clickCollectToBank = (): boolean =>
    clickWidget(GE_COLLECT_WIDGET, GE_COLLECT_SLOT, GE_COLLECT_TO_BANK, { reason: 'collect to bank' });

// clickOfferSlot()
// Click into an occupied offer slot to view its detail screen.
// Must pass child slot 2 explicitly — the game resolves the action to
// child 2 ("View offer"), but without passing it the synthetic click
// lands at the parent widget's position which may not overlap with the
// actual clickable area, causing the click to not register.
export const clickOfferSlot = (slotIndex: number): boolean => {
    const packedId = GE_OFFER_SLOT_WIDGET_IDS[slotIndex];
    if (!findWidget(packedId)) return false;
    return clickWidget(packedId, 2, 1, { reason: `open slot ${slotIndex + 1} detail` });
};

// clickAbortOffer()
// Click the "Abort offer" button on the offer detail screen.
export const clickAbortOffer = (): boolean =>
    clickWidget(GE_ABORT_WIDGET, GE_ABORT_SLOT, 1, { reason: 'abort offer' });

// clickBack()
// Click the "Back" button to return from the offer detail screen
// to the main GE slot view.
export const clickBack = (): boolean =>
    clickWidget(GE_BACK_WIDGET, -1, 1, { reason: 'back to GE main' });

// clickSearchResult()
// Click a specific GE search result by its child slot index. This replaces
// pressing Enter (which selects the first result and can pick the wrong item,
// e.g. "Charcoal" when searching "Coal"). The matchIndex is obtained from
// scanSearchResults() in widgets.ts, which scans the result text widgets for
// an exact case-insensitive name match.
export const clickSearchResult = (matchIndex: number): boolean =>
    clickWidget(GE_SEARCH_RESULT_TEXT_WIDGET, matchIndex, 1, { reason: `search result ${matchIndex}` });
