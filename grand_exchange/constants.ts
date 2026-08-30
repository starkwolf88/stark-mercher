// ============================================================================
// Grand Exchange widget IDs and constants
// ============================================================================
// These IDs are NOT in titan-gamevals.d.ts (which only has ItemID, NpcID,
// ObjectID). They were verified via click logs and widget inspection.
// Group 465 = GE offers interface. Group 162 = chatbox.
// ============================================================================

// --- Offer slot widget IDs (group 465, children 7-14) ----------------------
// The parent slot widget's itemId is always -1 — the actual offer data lives
// in child widgets (see GE_SLOT_* constants below).
export const GE_OFFER_SLOT_WIDGET_IDS = [
    30474247, // INDEX_0 (group 465, child 7)
    30474248, // INDEX_1 (group 465, child 8)
    30474249, // INDEX_2 (group 465, child 9)
    30474250, // INDEX_3 (group 465, child 10)
    30474251, // INDEX_4 (group 465, child 11)
    30474252, // INDEX_5 (group 465, child 12)
    30474253, // INDEX_6 (group 465, child 13)
    30474254, // INDEX_7 (group 465, child 14)
] as const;

// --- Offer slot child indices ----------------------------------------------
// Within each offer slot widget, these child slots hold the offer data.
// Verified via shell inspection: child 16 is the type label ("Buy"/"Sell"/
// "Empty"), child 18 holds itemId/itemQuantity, child 19 holds the item name,
// child 25 holds the price text ("<n> coins").
export const GE_SLOT_CREATE_BUY = 3;     // "Create Buy offer" button
export const GE_SLOT_CREATE_SELL = 4;    // "Create Sell offer" button
export const GE_SLOT_TYPE_LABEL = 16;    // "Buy" / "Sell" / "Empty"
export const GE_SLOT_ITEM = 18;          // itemId + itemQuantity
export const GE_SLOT_ITEM_NAME = 19;     // item name text
export const GE_SLOT_PRICE = 25;         // "<n> coins" per-item price
export const GE_SLOT_PROGRESS_BAR_OUTER = 21; // outer progress bar (full width, ~105px)
export const GE_SLOT_PROGRESS_BAR_INNER = 22; // inner fill bar (width scales with progress)

// --- Offer configuration widget (group 465, child 26) ----------------------
export const GE_AMOUNT_WIDGET = 30474266;

// Dynamic child slots within GE_AMOUNT_WIDGET:
export const GE_SELECTED_ITEM_SLOT = 27;  // shows the selected item's name
export const GE_QTY_ENTER_SLOT = 7;       // "Enter quantity" button
export const GE_PRICE_ENTER_SLOT = 12;    // "Enter price" button
export const GE_PRICE_TEXT_SLOT = 41;     // shows "<n> coins" per-item price

// --- Confirm button (group 465, child 30) ----------------------------------
export const GE_CONFIRM_WIDGET = 30474270;

// --- Collect button (group 465, child 6) -----------------------------------
// Same widget for "Collect to inventory" and "Collect to bank" — the
// identifier differentiates them. CC_OP(57) id=1 = inventory, id=2 = bank.
export const GE_COLLECT_WIDGET = 30474246;
export const GE_COLLECT_SLOT = 0;
export const GE_COLLECT_TO_INVENTORY = 1;
export const GE_COLLECT_TO_BANK = 2;

// --- Abort offer button (group 465, child 23) -------------------------------
// Appears on the offer detail screen after clicking into an occupied slot.
// interact(57, 1, 0) — CC_OP with child slot 0.
export const GE_ABORT_WIDGET = 30474263;
export const GE_ABORT_SLOT = 0;

// --- Back button (group 465, child 4) ---------------------------------------
// Returns from the offer detail screen to the main GE slot view.
// interact(57, 1) — no child slot.
export const GE_BACK_WIDGET = 30474244;

// --- Offer detail status text (child 2 of GE_ABORT_WIDGET) ------------------
// Shows "You have bought a total of X so far..." when active,
// and "You bought a total of X..." when aborted (no "so far").
export const GE_DETAIL_STATUS_SLOT = 2;

// --- Sell offer inventory widget (group 467, child 0) -----------------------
// When the GE sell config screen is open, clicking an inventory item at its
// slot index dispatches the "Offer" action (opcode=57, identifier=1,
// childSlot=item.slot). The SDK's item.interact('Offer') does not recognize
// this dynamic GE action, so we click the widget directly.
export const GE_SELL_INVENTORY_WIDGET = 30605312;

// --- Chatbox prompt widgets (group 162) ------------------------------------
export const GE_SEARCH_PROMPT_WIDGET = 10616876; // child 44 — "What would you like to buy?"
export const GE_PRICE_PROMPT_WIDGET = 10616875;  // child 43 — "Set a price for each item:"
export const GE_SEARCH_RESULT_TEXT_WIDGET = 10616884; // child 52 — search result text entries

// --- GE clerk NPC IDs (from titan.gamevals.NpcID) --------------------------
export const GE_CLERK_IDS = [
    titan.gamevals.NpcID.GE_CLERK_1, // 2148
    titan.gamevals.NpcID.GE_CLERK_2, // 2149
    titan.gamevals.NpcID.GE_CLERK_3, // 2150
    titan.gamevals.NpcID.GE_CLERK_4, // 2151
] as const;

// --- GE zone coordinates ---------------------------------------------------
export const GE_ZONE_CENTER = { x: 3165, y: 3490, plane: 0 };
export const GE_ZONE_RADIUS = 20;
export const GE_WALK_POINT = { x: 3165, y: 3485, plane: 0 };

// --- Slot counts -----------------------------------------------------------
export const GE_SLOTS_MEMBERS = 8;
export const GE_SLOTS_F2P = 3;
