import {
    GE_OFFER_SLOT_WIDGET_IDS,
    GE_AMOUNT_WIDGET,
    GE_SELECTED_ITEM_SLOT,
    GE_PRICE_TEXT_SLOT,
    GE_SEARCH_RESULT_TEXT_WIDGET,
    GE_SEARCH_PROMPT_WIDGET,
    GE_PRICE_PROMPT_WIDGET,
    GE_SLOTS_MEMBERS,
    GE_SLOTS_F2P,
    GE_SLOT_TYPE_LABEL,
    GE_SLOT_ITEM,
    GE_SLOT_ITEM_NAME,
    GE_SLOT_PRICE,
    GE_SLOT_PROGRESS_BAR_OUTER,
    GE_SLOT_PROGRESS_BAR_INNER,
    GE_ABORT_WIDGET,
    GE_DETAIL_STATUS_SLOT,
} from './constants.js';

let cachedChildrenTick = -1;
const cachedChildren: Record<number, titan.WidgetState[]> = {};

const childrenForParent = (packedId: number): titan.WidgetState[] => {
    const tick = titan.state.client.tick;
    if (cachedChildrenTick !== tick) {
        cachedChildrenTick = tick;
        for (const key of Object.keys(cachedChildren)) {
            delete cachedChildren[key as any];
        }
    }
    if (cachedChildren[packedId] !== undefined) {
        return cachedChildren[packedId];
    }
    try {
        cachedChildren[packedId] = titan.state.widgets.children(packedId);
    } catch (e) {
        cachedChildren[packedId] = [];
    }
    return cachedChildren[packedId];
};

// findWidget()
// Direct cached-state read via find()/children() — avoids the expensive
// titan.queries.widgets() query-builder API (~570ms per call).
export const findWidget = (packedId: number, slot?: number): titan.WidgetState | null => {
    if (slot === undefined) return titan.state.widgets.find(packedId);
    const children = childrenForParent(packedId);
    return children[slot] || null;
};

// widgetShown()
export const widgetShown = (w: titan.WidgetState | null): boolean =>
    !!(w && w.visible);

// isGeOpen()
// The GE interface is open. Uses the SDK's built-in check rather than a
// manual widget lookup — the amount widget (GE_AMOUNT_WIDGET) is only
// present on the offer config screen, not the main GE slot view.
export const isGeOpen = (): boolean =>
    titan.utils.bank.isGeOpen;

// isOfferConfigOpen()
// The offer configuration screen is open (showing item, quantity, price,
// confirm). This is the screen that appears after clicking a search result.
// The GE_AMOUNT_WIDGET is only visible on this screen, not the main GE slot
// view.
export const isOfferConfigOpen = (): boolean =>
    widgetShown(findWidget(GE_AMOUNT_WIDGET));

// isSearchPromptShown()
// "What would you like to buy?" — confirms the search input is ready.
export const isSearchPromptShown = (): boolean =>
    widgetShown(findWidget(GE_SEARCH_PROMPT_WIDGET));

// isPricePromptShown()
// "Set a price for each item:" — confirms the price input is ready.
export const isPricePromptShown = (): boolean =>
    widgetShown(findWidget(GE_PRICE_PROMPT_WIDGET));

// isOfferDetailOpen()
// The offer detail screen is open (after clicking into an occupied slot).
// This screen shows the item, progress, abort button, and status text.
export const isOfferDetailOpen = (): boolean =>
    widgetShown(findWidget(GE_ABORT_WIDGET));

// readOfferDetailStatus()
// Reads the status text from the offer detail screen.
// Returns the raw text (may contain <col=...> tags).
//   Active:  "You have bought a total of X so far for a total price of Y coins."
//   Aborted: "You bought a total of X for a total price of Y coins."
// Returns null if the detail screen is not open or the text is unreadable.
export const readOfferDetailStatus = (): string | null => {
    const w = findWidget(GE_ABORT_WIDGET, GE_DETAIL_STATUS_SLOT);
    if (!w || !w.visible || !w.text) return null;
    return w.text;
};

// isOfferAborted()
// Checks the offer detail status text for the "so far" marker.
// Active offers say "so far", aborted offers do not.
// Returns null if the status text can't be read (detail screen not open).
export const isOfferAborted = (): boolean | null => {
    const text = readOfferDetailStatus();
    if (text === null) return null;
    // Strip <col=...> tags before checking for "so far".
    const clean = text.replace(/<col=[^>]*>/g, '').replace(/<\/col>/g, '');
    return !clean.includes('so far');
};

// readOfferPrice()
// Reads the live "<n> coins" per-item price off the offer screen.
export const readOfferPrice = (): number | null => {
    const w = findWidget(GE_AMOUNT_WIDGET, GE_PRICE_TEXT_SLOT);
    if (!w || !w.text) return null;
    const n = parseInt(w.text.replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
};

// readOfferItemName()
// Reads the selected item's name from the offer configuration screen.
// Returns null if the widget isn't visible or has no text.
export const readOfferItemName = (): string | null => {
    const w = findWidget(GE_AMOUNT_WIDGET, GE_SELECTED_ITEM_SLOT);
    if (!w || !w.visible || !w.text) return null;
    return w.text.trim();
};

// readOfferQuantity()
// Reads the current quantity from the offer configuration screen.
// The quantity is shown as a number in a child of GE_AMOUNT_WIDGET.
// Returns null if the widget isn't visible or has no parseable number.
export const readOfferQuantity = (): number | null => {
    // The quantity display is in a child of GE_AMOUNT_WIDGET.
    // We scan visible children for a numeric text value.
    const children = childrenForParent(GE_AMOUNT_WIDGET);
    for (let i = 0; i < children.length; i++) {
        const w = children[i];
        if (!w || !w.visible || !w.text) continue;
        const n = parseInt(w.text.replace(/[^0-9]/g, ''), 10);
        // The quantity widget shows just a number (no "coins" suffix like price).
        // Skip the price text widget (slot 41) which shows "<n> coins".
        if (i === GE_PRICE_TEXT_SLOT) continue;
        if (Number.isFinite(n) && n > 0 && w.text.trim().match(/^\d+$/)) {
            return n;
        }
    }
    return null;
};

// scanSearchResults()
// Scans the GE search result text widgets for an exact (case-insensitive)
// name match. Returns { active, matchIndex } where active means results are
// visible and matchIndex is the native child slot to pass to interact()
// (or -1 if no match).
//
// Each search result row has 3 children: a background rectangle (type 3),
// a text label (type 4), and an item sprite (type 5). The game resolves
// the "Select" action to the BACKGROUND widget (p0 = background slot),
// not the text widget. So we must pass the background's dynamicChildSlot
// to interact() — passing the text widget's slot causes the synthetic
// click to land at the text position, which doesn't match the game's
// expected p0, and the click doesn't register (same class of bug as the
// confirm button and offer slot opening fixes).
export const scanSearchResults = (itemName: string): { active: boolean; matchIndex: number } => {
    const wanted = itemName.trim().toLowerCase();
    const children = childrenForParent(GE_SEARCH_RESULT_TEXT_WIDGET);
    let active = false;
    for (let i = 0; i < children.length; i++) {
        const w = children[i];
        if (!w || !w.visible || !w.text) continue;
        active = true;
        if (w.text.trim().toLowerCase() !== wanted) continue;
        // Found the text match at index i. The background widget is at i-1
        // (the type-3 rectangle that precedes the text label). Return its
        // native child slot — the game resolves the Select action to this
        // widget, so the synthetic click must land at its screen position.
        const bg = children[i - 1];
        const bgSlot = bg ? bg.dynamicChildSlot : w.dynamicChildSlot - 1;
        return { active: true, matchIndex: bgSlot };
    }
    return { active, matchIndex: -1 };
};

// isMembersWorld()
export const isMembersWorld = (): boolean => {
    const id = titan.state.world.current();
    if (id === null) return false;
    const meta = titan.state.world.metadata().find(w => w.id === id);
    return meta ? meta.isMembers : false;
};

// offerSlotCount()
// F2P worlds have 3 GE slots, members worlds have 8.
export const offerSlotCount = (): number =>
    isMembersWorld() ? GE_SLOTS_MEMBERS : GE_SLOTS_F2P;

// offerSlotWidgetId()
// Returns the packed widget ID for offer slot index 0-7.
export const offerSlotWidgetId = (index: number): number =>
    GE_OFFER_SLOT_WIDGET_IDS[index];

// OfferSlotType
// The type of offer occupying a slot, derived from child 16's text.
export type OfferSlotType = 'buy' | 'sell' | 'empty' | 'unknown';

// OfferSlotStatus
// The status of an offer, derived from the progress bar widths.
//   'active'               — offer is buying/selling (inner bar < outer bar)
//   'completed_or_aborted' — offer is done and needs collection (inner bar == outer bar)
//   'unknown'              — progress couldn't be read
// Note: We cannot distinguish completed from aborted from the main UI.
// Both show a full inner bar (red for aborted, green for completed).
// This is acceptable because both states require collection — the bot
// will hit "Collect" which handles both cases.
export type OfferSlotStatus = 'active' | 'completed_or_aborted' | 'unknown';

// OfferSlotState
// Full state of a single GE offer slot, read from cached child widgets.
// All reads use the fast cached widget API (titan.state.widgets.children)
// — no query builder needed. Progress is read from child 21 (outer bar)
// and child 22 (inner bar) widths.
//
// The parent slot widget's itemId is always -1; the real data lives in:
//   child 16 — type label ("Buy"/"Sell"/"Empty")
//   child 18 — itemId + itemQuantity (total offer quantity, NOT bought/sold)
//   child 19 — item name text
//   child 21 — outer progress bar (full width, ~105px)
//   child 22 — inner progress bar (width scales with progress; full when completed/aborted)
//   child 25 — price text ("<n> coins")
export interface OfferSlotState {
    type: OfferSlotType;
    itemId: number;
    itemQuantity: number;
    itemName: string | null;
    priceText: string | null;
    status: OfferSlotStatus;
    /** Progress ratio 0.0–1.0 (inner bar width / outer bar width). 0 for empty slots. */
    progress: number;
}

// readOfferProgress()
// Reads the progress bar fill width from cached child widgets.
// Returns { fill, full } where fill is the inner bar width and full is the
// outer bar width. When fill >= full, the offer is completed or aborted.
// When fill < full, the offer is active (proportional progress).
const readOfferProgress = (packedId: number): { fill: number; full: number } => {
    const outer = findWidget(packedId, GE_SLOT_PROGRESS_BAR_OUTER);
    const inner = findWidget(packedId, GE_SLOT_PROGRESS_BAR_INNER);
    return {
        fill: inner?.width ?? 0,
        full: outer?.width ?? 0,
    };
};

// getOfferSlotState()
// Fast read of offer slot state from cached child widgets, including progress.
// Uses only childrenForParent() — no query builder — so it's safe
// to call on every tick.
export const getOfferSlotState = (index: number): OfferSlotState => {
    const packedId = GE_OFFER_SLOT_WIDGET_IDS[index];
    if (!packedId) return { type: 'empty', itemId: -1, itemQuantity: 0, itemName: null, priceText: null, status: 'unknown', progress: 0 };
    const typeLabel = findWidget(packedId, GE_SLOT_TYPE_LABEL)?.text?.trim().toLowerCase() ?? '';
    const itemChild = findWidget(packedId, GE_SLOT_ITEM);
    const nameChild = findWidget(packedId, GE_SLOT_ITEM_NAME);
    const priceChild = findWidget(packedId, GE_SLOT_PRICE);
    let type: OfferSlotType = 'unknown';
    if (typeLabel === 'empty') type = 'empty';
    else if (typeLabel === 'buy') type = 'buy';
    else if (typeLabel === 'sell') type = 'sell';

    // Read progress from cached child widget widths.
    let status: OfferSlotStatus = 'unknown';
    let progress = 0;
    if (type !== 'empty') {
        const { fill, full } = readOfferProgress(packedId);
        if (full > 0) {
            progress = fill / full;
            if (fill >= full) {
                status = 'completed_or_aborted';
            } else {
                status = 'active';
            }
        }
    }

    return {
        type,
        itemId: itemChild?.itemId ?? -1,
        itemQuantity: itemChild?.itemQuantity ?? 0,
        itemName: nameChild?.text?.trim() || null,
        priceText: priceChild?.text?.trim() || null,
        status,
        progress,
    };
};

// getOfferSlotStateWithProgress()
// Deprecated — getOfferSlotState() now reads progress from cached widgets.
// Kept for backwards compatibility; just calls getOfferSlotState().
export const getOfferSlotStateWithProgress = (index: number): OfferSlotState =>
    getOfferSlotState(index);

// findEmptyOfferSlot()
// Returns the index of the first empty offer slot (child 16 says "Empty"),
// or -1 if all slots are occupied.
export const findEmptyOfferSlot = (): number => {
    const count = offerSlotCount();
    for (let i = 0; i < count; i++) {
        if (getOfferSlotState(i).type === 'empty') return i;
    }
    return -1;
};

// isSlotOccupied()
// Returns true if the offer slot has an active buy or sell offer.
export const isSlotOccupied = (index: number): boolean => {
    const t = getOfferSlotState(index).type;
    return t === 'buy' || t === 'sell';
};

// anySlotOccupied()
export const anySlotOccupied = (): boolean => {
    const count = offerSlotCount();
    for (let i = 0; i < count; i++) {
        if (isSlotOccupied(i)) return true;
    }
    return false;
};

// GeScreen
// Which GE screen is currently visible.
export type GeScreen = 'closed' | 'main' | 'offer_config' | 'search_prompt' | 'price_prompt';

// GeAudit
// Full audit of GE state — used on script start (onEnable) to reconstruct
// where the bot was and resume safely. All reads use the fast cached widget
// API (no query builder) so this is safe to call on every tick if needed,
// though it's primarily intended for startup. Each slot now includes progress
// (status + progress ratio) read from cached child widget widths.
export interface GeAudit {
    screen: GeScreen;
    geOpen: boolean;
    offerConfigOpen: boolean;
    searchPromptShown: boolean;
    pricePromptShown: boolean;
    // Offer config screen details (only valid when screen === 'offer_config')
    configItemName: string | null;
    configQuantity: number | null;
    configPrice: number | null;
    // All offer slots (fast read, includes progress)
    slots: OfferSlotState[];
}

// auditGeState()
// Reads the full GE state from cached widgets. This is the startup audit
// that reconstructs where the bot was before a reload/disconnect. It uses
// only fast cached reads — no query builder — so it's safe to call on
// every tick. Each slot includes progress (status + progress ratio) read
// from child 21 (outer bar) and child 22 (inner bar) widths.
export const auditGeState = (): GeAudit => {
    const geOpen = isGeOpen();
    const offerConfigOpen = isOfferConfigOpen();
    const searchPromptShown = isSearchPromptShown();
    const pricePromptShown = isPricePromptShown();

    let screen: GeScreen = 'closed';
    if (pricePromptShown) screen = 'price_prompt';
    else if (searchPromptShown) screen = 'search_prompt';
    else if (offerConfigOpen) screen = 'offer_config';
    else if (geOpen) screen = 'main';

    const count = offerSlotCount();
    const slots: OfferSlotState[] = [];
    for (let i = 0; i < count; i++) {
        slots.push(getOfferSlotState(i));
    }

    return {
        screen,
        geOpen,
        offerConfigOpen,
        searchPromptShown,
        pricePromptShown,
        configItemName: offerConfigOpen ? readOfferItemName() : null,
        configQuantity: offerConfigOpen ? readOfferQuantity() : null,
        configPrice: offerConfigOpen ? readOfferPrice() : null,
        slots,
    };
};
