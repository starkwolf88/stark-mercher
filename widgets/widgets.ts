// Imports
import { resolveChild } from './widget-functions';

// Parent widgets
const parentWidgets = {
    GE_OFFER_SLOT_1: () => titan.state.widgets.find(titan.gamevals.InterfaceID.GeOffers.INDEX_0)
}

// Child widgets
export const widgets = {
    ...parentWidgets,
    GE_OFFER_SLOT_1_BUY: resolveChild(parentWidgets.GE_OFFER_SLOT_1(), 3),
    GE_OFFER_SLOT_1_SELL: resolveChild(parentWidgets.GE_OFFER_SLOT_1(), 4)
};