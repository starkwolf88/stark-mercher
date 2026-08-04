// export type OfferData = {
//     offerState: net.runelite.api.GrandExchangeOfferState;
//     offerPrice: number;
//     itemId: number;
//     amountSpent: number;
//     totalQuantity: number;
//     quantityFulfilled: number;
//     percentageFulfilled: number;
//     offerStartTimestamp: number;
// };

// export type FlippableItems = {
//     itemId: number;
//     purchaseEtaMinutes: number;
//     saleEtaMinutes: number;
// } & Record<string, unknown>;

// export type PriceData = {
//     avgLowPrice?: number;
//     avgHighPrice?: number;
//     lowPriceVolume?: number;
//     highPriceVolume?: number;
// };

// export type BehaviourProfile = {
//     grandExchangeBoothOverNpcWeighting: number
// };

export const variables = {
    // debugEnabled: bot.variables.getBooleanVariable('Debug'),
    // behaviourProfile: {
    //     grandExchangeBoothOverNpcWeighting: 50
    // } as BehaviourProfile,
    // flippableItems: [] as FlippableItems[],
    // currentOffers: {} as Record<string, OfferData>,
    // nextFlippableItemsFetchTick: 0,
    // // flippableItemsFetchTickInterval: 100
    // flippableItemsFetchTickInterval: 9999999999, // TESTING
    // oneHourDataFetchTickInterval: 100,
    // slots: {
    //     slotsEmpty: 0,
    //     slotsBuying: 0,
    //     slotsBought: 0,
    //     slotsSelling: 0,
    //     slotsSold: 0,
    //     slotsAborted: 0
    // },
    // oneHourPriceData: {} as Record<string, PriceData>,
    // itemsWithSellingIssues: [] as number[],
    // itemToSell: {
    //     id: 0,
    //     price: 0
    // }
    timeout: 0
};

// export const createSalePriceGlobalKey = (itemId: number) => `salePrice_${client.getLocalPlayer().getName()}_${itemId}`;