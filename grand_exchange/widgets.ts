import {
    GE_OFFER_SLOT_WIDGET_IDS,
    GE_AMOUNT_WIDGET,
    GE_PRICE_TEXT_SLOT,
    GE_SEARCH_RESULT_TEXT_WIDGET,
    GE_SLOTS_MEMBERS,
    GE_SLOTS_F2P,
} from './constants.js';

// findWidget()
// Direct cached-state read via find()/children() — avoids the expensive
// titan.queries.widgets() query-builder API (~570ms per call).
export const findWidget = (packedId: number, slot?: number): titan.WidgetState | null => {
    if (slot === undefined) return titan.state.widgets.find(packedId);
    const children = titan.state.widgets.children(packedId);
    return children[slot] || null;
};

// widgetShown()
export const widgetShown = (w: titan.WidgetState | null): boolean =>
    !!(w && w.visible);

// isGeOpen()
// The GE offer interface is open when the amount widget is present.
export const isGeOpen = (): boolean =>
    widgetShown(findWidget(GE_AMOUNT_WIDGET));

// isSearchPromptShown()
// "What would you like to buy?" — confirms the search input is ready.
export const isSearchPromptShown = (): boolean =>
    widgetShown(findWidget(GE_SEARCH_PROMPT_WIDGET));

// isPricePromptShown()
// "Set a price for each item:" — confirms the price input is ready.
export const isPricePromptShown = (): boolean =>
    widgetShown(findWidget(GE_PRICE_PROMPT_WIDGET));

// readOfferPrice()
// Reads the live "<n> coins" per-item price off the offer screen.
export const readOfferPrice = (): number | null => {
    const w = findWidget(GE_AMOUNT_WIDGET, GE_PRICE_TEXT_SLOT);
    if (!w || !w.text) return null;
    const n = parseInt(w.text.replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
};

// scanSearchResults()
// Scans the GE search result text widgets for an exact (case-insensitive)
// name match. Returns { active, match } where active means results are
// visible and match is the container widget to click (or null if no match).
export const scanSearchResults = (itemName: string): { active: boolean; match: titan.WidgetState | null } => {
    const wanted = itemName.trim().toLowerCase();
    const children = titan.state.widgets.children(GE_SEARCH_RESULT_TEXT_WIDGET);
    let active = false;
    for (let i = 0; i < children.length; i++) {
        const w = children[i];
        if (!w || !w.visible || !w.text) continue;
        active = true;
        if (w.text.trim().toLowerCase() !== wanted) continue;
        const container = i > 0 ? children[i - 1] : null;
        return { active: true, match: (container && container.visible) ? container : w };
    }
    return { active, match: null };
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

// findEmptyOfferSlot()
// Returns the index of the first offer slot whose itemId is -1 (empty),
// or -1 if all slots are occupied.
export const findEmptyOfferSlot = (): number => {
    const count = offerSlotCount();
    for (let i = 0; i < count; i++) {
        const w = findWidget(GE_OFFER_SLOT_WIDGET_IDS[i]);
        if (w && w.itemId === -1) return i;
    }
    return -1;
};

// isSlotOccupied()
// Returns true if the offer slot at index has an item (itemId !== -1).
export const isSlotOccupied = (index: number): boolean => {
    const w = findWidget(GE_OFFER_SLOT_WIDGET_IDS[index]);
    return !!(w && w.itemId !== -1);
};

// anySlotOccupied()
export const anySlotOccupied = (): boolean => {
    const count = offerSlotCount();
    for (let i = 0; i < count; i++) {
        if (isSlotOccupied(i)) return true;
    }
    return false;
};
