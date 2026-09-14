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
import { getMerchableItemById } from '../data/merchable-items.js';
import { getPriceHistoryEntryById } from '../data/price-history.js';

// Cross-tick widget cache — persists across ticks to reduce native handle
// creation. Each titan.state.widgets.children() and .find() call creates a
// native WidgetState handle. The previous per-tick cache cleared every tick,
// creating ~11 handles/tick (~39 with inventory). Over 4-8 hours this
// exhausted the finite native handle table, causing FPS to gradually drop
// to 0.
//
// The cache now persists for up to WIDGET_CACHE_TTL_TICKS ticks (5 minutes)
// as a safety net. Callers MUST call invalidateGeWidgetCache() after any
// action that changes GE widget state (offer placed/aborted/collected, GE
// opened/closed, screen transition, click dispatched within a flow). The
// flow handler in auto-loop.ts invalidates at the start of each flow tick
// to ensure flows always see fresh state. During idle monitoring (the
// majority of a long session), the cache is valid for up to 5 minutes,
// reducing handle creation by ~100x vs per-tick caching.
//
// Tick counter resets (disconnect/hop) are handled by the tick < baseTick
// check, which clears the cache immediately.
const WIDGET_CACHE_TTL_TICKS = 500; // 500 ticks ≈ 5 minutes
let widgetCacheBaseTick = -1;
const cachedChildren: Record<number, titan.WidgetState[]> = {};
const cachedFinds: Record<number, titan.WidgetState | null> = {};

/** Invalidates the cross-tick widget cache. Must be called after any action
 *  that changes GE widget state (offer placed/aborted/collected, GE
 *  opened/closed, screen transition, click dispatched within a flow). */
export const invalidateGeWidgetCache = (): void => {
    for (const key of Object.keys(cachedChildren)) {
        delete cachedChildren[key as any];
    }
    for (const key of Object.keys(cachedFinds)) {
        delete cachedFinds[key as any];
    }
    widgetCacheBaseTick = -1;
};

const checkWidgetCacheExpiry = (): void => {
    const tick = titan.state.client.tick;
    if (widgetCacheBaseTick < 0 || tick < widgetCacheBaseTick || tick - widgetCacheBaseTick >= WIDGET_CACHE_TTL_TICKS) {
        invalidateGeWidgetCache();
        widgetCacheBaseTick = tick;
    }
};

const childrenForParent = (packedId: number): titan.WidgetState[] => {
    checkWidgetCacheExpiry();
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

// findWidgetById() — cached via the same cross-tick cache as children().
// find() is called ~3-4 times per tick by auditGeState (isOfferConfigOpen,
// isSearchPromptShown, isPricePromptShown) and each call creates a native
// WidgetState handle. The cross-tick cache avoids redundant native calls
// when the same widget is looked up multiple times within the cache TTL.
const findWidgetById = (packedId: number): titan.WidgetState | null => {
    checkWidgetCacheExpiry();
    if (cachedFinds[packedId] !== undefined) {
        return cachedFinds[packedId];
    }
    try {
        cachedFinds[packedId] = titan.state.widgets.find(packedId);
    } catch (e) {
        cachedFinds[packedId] = null;
    }
    return cachedFinds[packedId];
};

// findWidget()
// Direct cached-state read via find()/children() — avoids the expensive
// titan.queries.widgets() query-builder API (~570ms per call).
// Both find() and children() results are cached across ticks (up to
// WIDGET_CACHE_TTL_TICKS). Call invalidateGeWidgetCache() after any
// state-changing action to ensure fresh reads.
export const findWidget = (packedId: number, slot?: number): titan.WidgetState | null => {
    if (slot === undefined) return findWidgetById(packedId);
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
//
// Cached via the boolean state cache (see below) — titan.utils.bank.isGeOpen
// is a composition helper that internally calls widgets.find(), creating a
// native WidgetState handle. isGeOpen() is called 2-3x per tick (tickLogic,
// autoLoop Step 1, auditGeState). Over 8 hours this created ~150k handles.
export const isGeOpen = (): boolean =>
    cachedBankIsGeOpen();

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
// NOTE: GE_PRICE_PROMPT_WIDGET is the chatbox dialogue container that is
// visible during BOTH the quantity prompt ("How many do you wish to buy?")
// and the price prompt ("Set a price for each item:"). This function only
// checks widget visibility — callers that need to distinguish between the
// two prompts should use isQuantityPromptShown() instead.
export const isPricePromptShown = (): boolean =>
    widgetShown(findWidget(GE_PRICE_PROMPT_WIDGET));

// readPromptText()
// Reads the text content of the GE chatbox prompt widget. Returns null if
// the widget isn't visible or has no text. The prompt text distinguishes
// between the quantity prompt ("How many do you wish to buy?") and the
// price prompt ("Set a price for each item:").
export const readPromptText = (): string | null => {
    const w = findWidget(GE_PRICE_PROMPT_WIDGET);
    if (!w || !w.visible || !w.text) return null;
    return w.text.trim();
};

// isQuantityPromptShown()
// Returns true if the GE quantity prompt is open ("How many do you wish to
// buy?"). This must be checked BEFORE isPricePromptShown() because the
// prompt widget is visible during both prompts.
export const isQuantityPromptShown = (): boolean => {
    const text = readPromptText();
    if (!text) return false;
    return text.toLowerCase().includes('how many');
};

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
        // OSRS formats quantities >= 1000 with commas (e.g. "14,593").
        // Allow commas in the text match; parseInt above already strips them.
        if (Number.isFinite(n) && n > 0 && w.text.trim().match(/^[\d,]+$/)) {
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

// scanSearchResultsUnique()
// Variant of scanSearchResults for early-stop typing. Returns whether the
// desired item is the ONLY visible result (unique match). Used by
// BuyOfferFlow to stop typing as soon as the item is uniquely identifiable
// — e.g. "magp" uniquely matches "Magpie impling jar" because no other GE
// item starts with "magp". This is both faster and more humanlike (real
// players stop typing once they see their item).
//
// Returns { active, unique, matchIndex, visibleCount }:
//   active       — results are visible (at least 1 result shown)
//   unique       — exactly 1 result visible AND it's an exact match
//   matchIndex   — the native child slot to pass to interact() (or -1)
//   visibleCount — total visible results (for diagnostics)
export const scanSearchResultsUnique = (itemName: string): {
    active: boolean;
    unique: boolean;
    matchIndex: number;
    visibleCount: number;
} => {
    const wanted = itemName.trim().toLowerCase();
    const children = childrenForParent(GE_SEARCH_RESULT_TEXT_WIDGET);
    let active = false;
    let visibleCount = 0;
    let matchIndex = -1;
    for (let i = 0; i < children.length; i++) {
        const w = children[i];
        if (!w || !w.visible || !w.text) continue;
        active = true;
        visibleCount++;
        if (w.text.trim().toLowerCase() === wanted) {
            const bg = children[i - 1];
            const bgSlot = bg ? bg.dynamicChildSlot : w.dynamicChildSlot - 1;
            matchIndex = bgSlot;
        }
    }
    // Unique = exactly 1 visible result AND it's our item.
    const unique = active && visibleCount === 1 && matchIndex >= 0;
    return { active, unique, matchIndex, visibleCount };
};

// isMembersWorld()
// Cached — titan.state.world.metadata() returns a full snapshot of the world
// list (~100+ objects) on every call. This is called multiple times per tick
// via offerSlotCount() and auditGeState(). The result only changes on a world
// hop or logout/login, so we cache it and invalidate via
// invalidateMembersWorldCache() on hop completion and any logout.
let cachedIsMembersWorld: boolean | null = null;

export const isMembersWorld = (): boolean => {
    if (cachedIsMembersWorld !== null) return cachedIsMembersWorld;
    const id = titan.state.world.current();
    if (id === null) {
        cachedIsMembersWorld = false;
        return false;
    }
    const meta = titan.state.world.metadata().find(w => w.id === id);
    cachedIsMembersWorld = meta ? meta.isMembers : false;
    return cachedIsMembersWorld;
};

/** Invalidates the cached isMembersWorld result. Must be called on hop
 *  completion and on any logout (break, disconnect, rotation) so the next
 *  isMembersWorld() call re-fetches from the live world list. */
export const invalidateMembersWorldCache = (): void => {
    cachedIsMembersWorld = null;
};

// --- Boolean state cache (isGeOpen, bank.isOpen, inventory.isOpen) ----------
// titan.utils.bank.isGeOpen, titan.utils.bank.isOpen, and
// titan.utils.inventory.isOpen are composition helpers that internally call
// titan.state.widgets.find(), each creating a native WidgetState handle.
// These are called every game tick from tickLogic, autoLoopTick, and
// idle-activity bank phases — 5-7 calls/tick. Over 8 hours this created
// ~300k+ native handles, gradually exhausting the finite handle table and
// causing FPS to drop to 0 (same root cause as the mixology 1200-group
// scan, just slower accumulation).
//
// The cache uses a short TTL (10 ticks ≈ 6 seconds) — responsive enough to
// detect unexpected GE/bank/inventory closing, but reduces handle creation
// by 10x. Callers MUST call invalidateBooleanStateCache() after any action
// that changes these states (GE opened/closed, bank opened/closed,
// inventory opened, hop, login). The cache also auto-expires on tick
// counter resets (disconnect/hop).
const BOOL_CACHE_TTL_TICKS = 10; // 10 ticks ≈ 6 seconds
let boolCacheBaseTick = -1;
let cachedGeOpen: boolean | null = null;
let cachedBankOpen: boolean | null = null;
let cachedInvOpen: boolean | null = null;

/** Invalidates the boolean state cache. Must be called after any action
 *  that changes GE/bank/inventory open state (GE opened/closed, bank
 *  opened/closed, inventory opened, hop, login). */
export const invalidateBooleanStateCache = (): void => {
    cachedGeOpen = null;
    cachedBankOpen = null;
    cachedInvOpen = null;
    cachedWorldSwitcherOpen = null;
    boolCacheBaseTick = -1;
};

const checkBoolCacheExpiry = (): void => {
    const tick = titan.state.client.tick;
    if (boolCacheBaseTick < 0 || tick < boolCacheBaseTick || tick - boolCacheBaseTick >= BOOL_CACHE_TTL_TICKS) {
        invalidateBooleanStateCache();
        boolCacheBaseTick = tick;
    }
};

/** Cached titan.utils.bank.isGeOpen. */
const cachedBankIsGeOpen = (): boolean => {
    checkBoolCacheExpiry();
    if (cachedGeOpen !== null) return cachedGeOpen;
    cachedGeOpen = titan.utils.bank.isGeOpen;
    return cachedGeOpen;
};

/** Cached titan.utils.bank.isOpen. */
export const isBankOpen = (): boolean => {
    checkBoolCacheExpiry();
    if (cachedBankOpen !== null) return cachedBankOpen;
    cachedBankOpen = titan.utils.bank.isOpen;
    return cachedBankOpen;
};

/** Cached titan.utils.inventory.isOpen. */
export const isInventoryOpen = (): boolean => {
    checkBoolCacheExpiry();
    if (cachedInvOpen !== null) return cachedInvOpen;
    cachedInvOpen = titan.utils.inventory.isOpen;
    return cachedInvOpen;
};

// --- World switcher cache ----------------------------------------------------
// titan.state.widgets.find(WORLD_SWITCHER_PACKED) creates a native
// WidgetState handle. isWorldSwitcherOpen() is called every game tick from
// tickLogic when GE/bank are closed. Cached via the boolean state cache
// (same 10-tick TTL) to avoid per-tick handle creation.
const WORLD_SWITCHER_PACKED = (69 << 16) | 0;
let cachedWorldSwitcherOpen: boolean | null = null;

/** True when the OSRS world switcher full-screen interface is open. */
export const isWorldSwitcherOpenCached = (): boolean => {
    checkBoolCacheExpiry();
    if (cachedWorldSwitcherOpen !== null) return cachedWorldSwitcherOpen;
    try {
        const w = titan.state.widgets.find(WORLD_SWITCHER_PACKED);
        cachedWorldSwitcherOpen = !!(w && w.exists && w.visible);
    } catch {
        cachedWorldSwitcherOpen = false;
    }
    return cachedWorldSwitcherOpen;
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

// resolveTruncatedItemName()
// The GE slot widget (child 19) truncates long item names with "..." when
// the name doesn't fit the slot's text area. This happens for single-word
// item names with no spaces (e.g. "Antidote++(4)" → "Antidote++...") because
// the widget renderer can't break them across lines. Multi-word names wrap
// and are shown in full.
//
// The slot widget also exposes the OSRS itemId (child 18), which is stable
// and never truncated. We resolve the full name by looking up the itemId in
// merchableItems.json first (fast — ~30 items), then priceHistory.json
// (~1800-3000 items — covers every item with 1h Wiki data, not just
// merchable ones). Both are in-memory Map/array lookups — no native SDK
// calls. If neither has the itemId, the truncated name is returned as-is
// (same as the previous behavior — the slot stays unmanaged).
//
// This only fires when the name ends with "..." (rare), so non-truncated
// names incur zero overhead.
const resolveTruncatedItemName = (name: string, itemId: number): string => {
    if (!name.endsWith('...') || itemId <= 0) return name;
    const merch = getMerchableItemById(itemId);
    if (merch) return merch.itemName;
    const history = getPriceHistoryEntryById(itemId);
    if (history) return history.name;
    return name;
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

    const itemId = itemChild?.itemId ?? -1;
    const rawName = nameChild?.text?.trim() || null;
    // Resolve truncated names (ending with "...") via itemId lookup so
    // downstream code (reverse reconciliation, stale checks, profit tracking)
    // gets the full item name. See resolveTruncatedItemName above.
    const itemName = rawName ? resolveTruncatedItemName(rawName, itemId) : null;

    return {
        type,
        itemId,
        itemQuantity: itemChild?.itemQuantity ?? 0,
        itemName,
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
export type GeScreen = 'closed' | 'main' | 'offer_config' | 'search_prompt' | 'quantity_prompt' | 'price_prompt';

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
    quantityPromptShown: boolean;
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
    // Check quantity prompt BEFORE price prompt — the prompt widget is
    // visible during both, so isPricePromptShown() returns true for both.
    // isQuantityPromptShown() checks the prompt text for "how many".
    const quantityPromptShown = isQuantityPromptShown();
    const pricePromptShown = !quantityPromptShown && isPricePromptShown();

    let screen: GeScreen = 'closed';
    if (quantityPromptShown) screen = 'quantity_prompt';
    else if (pricePromptShown) screen = 'price_prompt';
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
        quantityPromptShown,
        pricePromptShown,
        configItemName: offerConfigOpen ? readOfferItemName() : null,
        configQuantity: offerConfigOpen ? readOfferQuantity() : null,
        configPrice: offerConfigOpen ? readOfferPrice() : null,
        slots,
    };
};
