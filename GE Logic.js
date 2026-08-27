
    GE_OFFER_SLOT_CREATE_BUY_SLOT = 3;
    GE_SEARCH_RESULT_TEXT_WIDGET = 10616884;
    geScanSearchResults(itemName) {
        const wanted = itemName.trim().toLowerCase();
        const children = titan.state.widgets.children(this.GE_SEARCH_RESULT_TEXT_WIDGET);
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
    }
    GE_SEARCH_PROMPT_WIDGET = 10616876; // Chatbox.MES_TEXT2 "What would you like to buy?" -- confirms the search input is ready
    GE_PRICE_PROMPT_WIDGET = 10616875; // Chatbox.MES_TEXT "Set a price for each item:" -- confirms the price input is ready
    GE_SEARCH_PROMPT_DELAY_TICKS = 0; // widget visibility is the real gate now; act the tick it's shown
    _geSlotClicked = false;
    _geSearchPromptTicks = 0;
    _geInterfaceOpened = false;
    GE_AMOUNT_WIDGET = 30474266; // shared quantity/price button list
    GE_SELECTED_ITEM_SLOT = 27; // dynamic child of GE_AMOUNT_WIDGET showing the selected item's name
    GE_QTY_ENTER_SLOT = 7; // "Enter quantity" on GE_AMOUNT_WIDGET
    GE_PRICE_ENTER_SLOT = 12; // "Enter price" on GE_AMOUNT_WIDGET
    GE_CONFIRM_WIDGET = 30474270; // "Confirm" the offer
    GE_COLLECT_WIDGET = 30474246; // "Collect to inventory"
    GE_PRICE_TEXT_SLOT = 41; // dynamic child of GE_AMOUNT_WIDGET showing "<n> coins" per-item price
    _geQtySet = false;
    _gePriceSet = false;
    _geConfirmed = false;
    // After Confirm is clicked and the offer screen actually closes, wait this many ticks then
    // check the box we started the offer in actually shows the item -- confirms the offer really
    // posted instead of just assuming the click landed.
    GE_VERIFY_DELAY_TICKS = 2;
    _geVerifyTicks = 0;
    _geActiveBoxIndex = -1;

    // Hand back a box we claimed but never posted an offer in, so it stays usable.
    geReleaseActiveBox() {
        if (this._geActiveBoxIndex === -1) return;
        this._geOccupiedBoxes.delete(this._geActiveBoxIndex);
        this._geActiveBoxIndex = -1;
        this._geVerifyTicks = 0;
        this._geSlotClicked = false;
    }
    GE_SEARCH_SELECT_DELAY_TICKS = 1; // exact-text-match is the real gate; the earlier flakiness here was the wrong click target (now fixed), not timing
    _geSearchSelectTicks = 0;
    GE_NUMBER_ENTRY_DELAY_TICKS = 0; // both fields are now gated on their own prompt/selection widgets being shown
    _geQtyClicked = false;
    _geQtyPromptTicks = 0;
    _gePriceClicked = false;
    _gePricePromptTicks = 0;
    _geTargetPriceCached = 0;
    _geShoppingDone = false;
    _geShoppingActive = false;
    _geQueue = [];
    _geDrainTicks = 0;
    GE_DRAIN_TIMEOUT_TICKS = 50;
    // Same widget/slot as "Collect to inventory" -- "Collect to bank" is a different menu-action
    // identifier on the same p0=0 child, confirmed via click log: CC_OP(57) id=2 p0=0 p1=30474246.
    GE_COLLECT_SLOT = 0;
    GE_COLLECT_TO_BANK_IDENTIFIER = 2;
    // Lists this size or smaller fit in the boxes at once, so let everything fill and collect in
    // one sweep at the end instead of collecting early.
    GE_COLLECT_EARLY_THRESHOLD = 6;
    // Extra settle time once collecting looks ready, instead of clicking the instant it flips true.
    GE_COLLECT_SETTLE_TICKS = 2;
    _geCollectReadyTicks = 0;
    geShouldCollectNow(list) {
        if (!this._geQueue.length) return true;
        // Cap at the boxes we actually have -- on F2P's 3 slots a 4-6 item list would otherwise
        // refuse to collect while every box was full, and the queue could never drain.
        const threshold = Math.min(this.GE_COLLECT_EARLY_THRESHOLD, this.geOfferSlotCount());
        if (list.length <= threshold) return false;
        return this.geFindEmptyOfferSlot() === -1;
    }

    GE_BULK_QTY_THRESHOLD = 500;
    GE_BULK_MARKUP = 1.2;
    GE_MULTI_QTY_THRESHOLD = 10;
    GE_MULTI_QTY_MARKUP = 1.5;
    geTargetPrice(marketPrice, qty) {
        if (qty >= this.GE_BULK_QTY_THRESHOLD) return Math.ceil(marketPrice * this.GE_BULK_MARKUP);
        if (qty > this.GE_MULTI_QTY_THRESHOLD) return Math.ceil(marketPrice * this.GE_MULTI_QTY_MARKUP);
        if (marketPrice < 1000) return 5000;
        if (marketPrice < 5000) return 10000;
        if (marketPrice < 10000) return 20000;
        if (marketPrice < 20000) return 30000;
        return Math.ceil(marketPrice * 1.2);
    }

    geFindWidget(packedId, slot) {
        // Direct cached-state reads (find()/children()) instead of the query-builder API --
        // titan.queries.widgets() dispatches a full query on every call regardless of result size
        // and was the main source of GE lag (confirmed ~570ms on a single call).
        if (slot === undefined) return titan.state.widgets.find(packedId);
        const children = titan.state.widgets.children(packedId);
        return children[slot] || null;
    }
    GE_OFFER_SLOT_CREATE_BUY_SLOT = 3;
    GE_SEARCH_RESULT_TEXT_WIDGET = 10616884;
    geScanSearchResults(itemName) {
        const wanted = itemName.trim().toLowerCase();
        const children = titan.state.widgets.children(this.GE_SEARCH_RESULT_TEXT_WIDGET);
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
    }
    GE_SEARCH_PROMPT_WIDGET = 10616876; // Chatbox.MES_TEXT2 "What would you like to buy?" -- confirms the search input is ready
    GE_PRICE_PROMPT_WIDGET = 10616875; // Chatbox.MES_TEXT "Set a price for each item:" -- confirms the price input is ready
    GE_SEARCH_PROMPT_DELAY_TICKS = 0; // widget visibility is the real gate now; act the tick it's shown
    _geSlotClicked = false;
    _geSearchPromptTicks = 0;
    _geInterfaceOpened = false;
    GE_AMOUNT_WIDGET = 30474266; // shared quantity/price button list
    GE_SELECTED_ITEM_SLOT = 27; // dynamic child of GE_AMOUNT_WIDGET showing the selected item's name
    GE_QTY_ENTER_SLOT = 7; // "Enter quantity" on GE_AMOUNT_WIDGET
    GE_PRICE_ENTER_SLOT = 12; // "Enter price" on GE_AMOUNT_WIDGET
    GE_CONFIRM_WIDGET = 30474270; // "Confirm" the offer
    GE_COLLECT_WIDGET = 30474246; // "Collect to inventory"
    GE_PRICE_TEXT_SLOT = 41; // dynamic child of GE_AMOUNT_WIDGET showing "<n> coins" per-item price
    _geQtySet = false;
    _gePriceSet = false;
    _geConfirmed = false;
    // After Confirm is clicked and the offer screen actually closes, wait this many ticks then
    // check the box we started the offer in actually shows the item -- confirms the offer really
    // posted instead of just assuming the click landed.
    GE_VERIFY_DELAY_TICKS = 2;
    _geVerifyTicks = 0;
    _geActiveBoxIndex = -1;

    // Hand back a box we claimed but never posted an offer in, so it stays usable.
    geReleaseActiveBox() {
        if (this._geActiveBoxIndex === -1) return;
        this._geOccupiedBoxes.delete(this._geActiveBoxIndex);
        this._geActiveBoxIndex = -1;
        this._geVerifyTicks = 0;
        this._geSlotClicked = false;
    }
    GE_SEARCH_SELECT_DELAY_TICKS = 1; // exact-text-match is the real gate; the earlier flakiness here was the wrong click target (now fixed), not timing
    _geSearchSelectTicks = 0;
    GE_NUMBER_ENTRY_DELAY_TICKS = 0; // both fields are now gated on their own prompt/selection widgets being shown
    _geQtyClicked = false;
    _geQtyPromptTicks = 0;
    _gePriceClicked = false;
    _gePricePromptTicks = 0;
    _geTargetPriceCached = 0;
    _geShoppingDone = false;
    _geShoppingActive = false;
    _geQueue = [];
    _geDrainTicks = 0;
    GE_DRAIN_TIMEOUT_TICKS = 50;
    // Same widget/slot as "Collect to inventory" -- "Collect to bank" is a different menu-action
    // identifier on the same p0=0 child, confirmed via click log: CC_OP(57) id=2 p0=0 p1=30474246.
    GE_COLLECT_SLOT = 0;
    GE_COLLECT_TO_BANK_IDENTIFIER = 2;
    // Lists this size or smaller fit in the boxes at once, so let everything fill and collect in
    // one sweep at the end instead of collecting early.
    GE_COLLECT_EARLY_THRESHOLD = 6;
    // Extra settle time once collecting looks ready, instead of clicking the instant it flips true.
    GE_COLLECT_SETTLE_TICKS = 2;
    _geCollectReadyTicks = 0;
    geShouldCollectNow(list) {
        if (!this._geQueue.length) return true;
        // Cap at the boxes we actually have -- on F2P's 3 slots a 4-6 item list would otherwise
        // refuse to collect while every box was full, and the queue could never drain.
        const threshold = Math.min(this.GE_COLLECT_EARLY_THRESHOLD, this.geOfferSlotCount());
        if (list.length <= threshold) return false;
        return this.geFindEmptyOfferSlot() === -1;
    }

    GE_BULK_QTY_THRESHOLD = 500;
    GE_BULK_MARKUP = 1.2;
    GE_MULTI_QTY_THRESHOLD = 10;
    GE_MULTI_QTY_MARKUP = 1.5;
    geTargetPrice(marketPrice, qty) {
        if (qty >= this.GE_BULK_QTY_THRESHOLD) return Math.ceil(marketPrice * this.GE_BULK_MARKUP);
        if (qty > this.GE_MULTI_QTY_THRESHOLD) return Math.ceil(marketPrice * this.GE_MULTI_QTY_MARKUP);
        if (marketPrice < 1000) return 5000;
        if (marketPrice < 5000) return 10000;
        if (marketPrice < 10000) return 20000;
        if (marketPrice < 20000) return 30000;
        return Math.ceil(marketPrice * 1.2);
    }

    geFindWidget(packedId, slot) {
        // Direct cached-state reads (find()/children()) instead of the query-builder API --
        // titan.queries.widgets() dispatches a full query on every call regardless of result size
        // and was the main source of GE lag (confirmed ~570ms on a single call).
        if (slot === undefined) return titan.state.widgets.find(packedId);
        const children = titan.state.widgets.children(packedId);
        return children[slot] || null;
    }
geWidgetShown(w) {
        return !!(w && w.visible);
    }

    geClick(packedId, childSlot = -1, identifier = 1) {
        if (!this.geFindWidget(packedId)) return false;
        this._geDidAction = true;
        return titan.state.widgets.interact(57, identifier, childSlot, packedId);
    }

    geType(str) {
        this._geDidAction = true;
        titan.keyboard.sendString(str);
    }

    // Reads the live "<n> coins" per-item price off the offer screen.
    geReadOfferPrice() {
        const w = this.geFindWidget(this.GE_AMOUNT_WIDGET, this.GE_PRICE_TEXT_SLOT);
        if (!w || !w.text) return null;
        const n = parseInt(w.text.replace(/[^0-9]/g, ""), 10);
        return Number.isFinite(n) ? n : null;
    }

    GE_ZONE_CENTER = { x: 3165, y: 3490, plane: 0 };
    GE_ZONE_RADIUS = 20;
    GE_WALK_POINT = { x: 3165, y: 3485, plane: 0 };
    GE_BANK_WALK_POINT = { x: 3165, y: 3485, plane: 0 };
    nearGrandExchange(player) {
        return !!player && player.plane === this.GE_ZONE_CENTER.plane &&
            this.tileDistance({ x: player.worldX, y: player.worldY }, this.GE_ZONE_CENTER) <= this.GE_ZONE_RADIUS;
    }

    get GE_CLERK_IDS() {
        const NPC = titan.gamevals.NpcID;
        return [NPC.GE_CLERK_1, NPC.GE_CLERK_2, NPC.GE_CLERK_3, NPC.GE_CLERK_4];
    }

    geItemName(itemId) {
        const def = titan.state.itemDef(itemId);
        return def ? def.name : null;
    }
buildGeShoppingList(module) {
        const base = module.geShoppingList ? module.geShoppingList() : [];
        const list = this.purchaseOptionalTransports.value
            ? [...base, ...this.transportShoppingList(module)]
            : [...base];
        const allowed = list.filter(entry => !this.itemUnavailableHere(entry.id));
        if (allowed.length !== list.length) {
            const dropped = list.filter(entry => this.itemUnavailableHere(entry.id))
                .map(entry => this.geItemName(entry.id) || entry.id);
            titan.log(`[GE] skipping members-only item(s), not tradeable on this world: ${dropped.join(", ")}`);
        }
        return allowed;
    }
GE_SLOTS_MEMBERS = 8;
GE_SLOTS_F2P = 3;
geOfferSlotCount() {
        return this.onMembersWorld() === false ? this.GE_SLOTS_F2P : this.GE_SLOTS_MEMBERS;
    }
    get GE_OFFER_SLOT_IDS() {
        const G = titan.gamevals.InterfaceID.GeOffers;
        const all = [G.INDEX_0, G.INDEX_1, G.INDEX_2, G.INDEX_3, G.INDEX_4, G.INDEX_5, G.INDEX_6, G.INDEX_7];
        return all.slice(0, this.geOfferSlotCount());
    }
    geOfferSlotWidgetId(index) {
        return this.GE_OFFER_SLOT_IDS[index];
    }
    _geOccupiedBoxes = new Set();
    geFindEmptyOfferSlot() {
        const ids = this.GE_OFFER_SLOT_IDS;
        for (let i = 0; i < ids.length; i++) {
            if (this._geOccupiedBoxes.has(i)) continue;
            const w = this.geFindWidget(ids[i]);
            if (w && w.itemId === -1) return i;
        }
        return -1;
    }
    geAnyBoxOccupied() {
        if (this._geOccupiedBoxes.size > 0) return true;
        const ids = this.GE_OFFER_SLOT_IDS;
        for (let i = 0; i < ids.length; i++) {
            const w = this.geFindWidget(ids[i]);
            if (w && w.itemId !== -1) return true;
        }
        return false;
    }
    GE_BOX_CLICK_DELAY_TICKS = 1;

    GE_ACTION_DELAY_TICKS = 1;
    GE_BANK_CLOSE_DELAY_TICKS = 1;
    _geActionCooldown = 0;
    _geDidAction = false;
    GE_BANK_OPEN_TIMEOUT_TICKS = 10;
    _geBankOpenTicks = 0;
    GE_BANK_READ_SETTLE_TICKS = 2;
    _geBankReadTicks = 0;