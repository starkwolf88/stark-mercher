const ITEM_ID = 2440;
const GE_TAX_PERCENTAGE = 2;
const SALE_BUFFER_PERCENTAGE = 0.01;

// Price data variables
let mappingItemData = {};
let fiveMinuteDataMap = {};
let oneHourDataMap = {};
let twentyFourHourDataMap = {};
let timeSeriesData = {};

let itemData = {
    itemId: ITEM_ID,
    fiveMinuteData: {},
    oneHourData: {},
    twentyFourHourData: {},
    timeSeriesData: {
        sevenDay: {},
        twoHour: {},
        threeHour: {},
        hourlyBreakdown: {}
    },
    calculatedData: {}
};
async function getPriceData() {
    const fiveMinutePriceDataFetch = await fetchFromAPI('5m');
    const oneHourPricesDataFetch = await fetchFromAPI('1h');
    const twentyFourHourPricesDataFetch = await fetchFromAPI('24h');
    const mappingItemDataFetch = await fetchFromAPI('mapping');
    const timeSeriesDataFetch = await fetchFromAPI(`timeseries?timestep=1h&id=${ITEM_ID}`)
    timeSeriesData = timeSeriesDataFetch.data.reverse();
    mappingItemData = new Map(mappingItemDataFetch.map(item => [item.id, item]));
    fiveMinuteDataMap = new Map(Object.entries(fiveMinutePriceDataFetch.data).map(([id, data]) => [Number(id), data]));
    oneHourDataMap = new Map(Object.entries(oneHourPricesDataFetch.data).map(([id, data]) => [Number(id), data]));
    twentyFourHourDataMap = new Map(Object.entries(twentyFourHourPricesDataFetch.data).map(([id, data]) => [Number(id), data]));

    // Add mapping data.
    const mappingEntry = mappingItemData.get(ITEM_ID);
    if (mappingItemData.get(ITEM_ID)) {
        itemData.itemName = mappingEntry.name;
        itemData.limit = mappingEntry.limit;
    }

    const fiveMinuteEntry = fiveMinuteDataMap.get(ITEM_ID);
    if (fiveMinuteEntry) {
        itemData.fiveMinuteData.fiveMinutePurchasePrice = fiveMinuteEntry.avgLowPrice;
        itemData.fiveMinuteData.fiveMinuteSalePrice = fiveMinuteEntry.avgHighPrice;
        itemData.fiveMinuteData.fiveMinutePurchaseVolume = fiveMinuteEntry.lowPriceVolume;
        itemData.fiveMinuteData.fiveMinuteSaleVolume = fiveMinuteEntry.highPriceVolume;
    }

    const oneHourEntry = oneHourDataMap.get(ITEM_ID);
    if (oneHourEntry) {
        itemData.oneHourData.oneHourPurchasePrice = oneHourEntry.avgLowPrice;
        itemData.oneHourData.oneHourSalePrice = oneHourEntry.avgHighPrice;
        itemData.oneHourData.oneHourPurchaseVolume = oneHourEntry.lowPriceVolume;
        itemData.oneHourData.oneHourSaleVolume = oneHourEntry.highPriceVolume;
    }

    const twentyFourHourEntry = twentyFourHourDataMap.get(ITEM_ID);
    if (twentyFourHourEntry) {
        itemData.twentyFourHourData.twentyFourHourPurchasePrice = twentyFourHourEntry.avgLowPrice;
        itemData.twentyFourHourData.twentyFourHourSalePrice = twentyFourHourEntry.avgHighPrice;
        itemData.twentyFourHourData.twentyFourHourPurchaseVolume = twentyFourHourEntry.lowPriceVolume;
        itemData.twentyFourHourData.twentyFourHourSaleVolume = twentyFourHourEntry.highPriceVolume;
    }
};

async function fetchFromAPI(endpoint) {
    const response = await fetch(`https://prices.runescape.wiki/api/v1/osrs/${endpoint}`, {headers: {"User-Agent": "[Stark] Mercher. st_rk@outlook.com"}});
    return response.json();
}

const convertTimeSeriesData = () => {
    const sevenDayDataPoints = 168;
    const twentyFourHourDataPoints = 24;
    const threeHourDataPoints = 3;
    const twoHourDataPoints = 2;

    // 7 day
    let sevenDayPurchasePrices = 0;
    let sevenDaySalePrices = 0;
    let sevenDayPurchaseVolumes = 0;
    let sevenDaySaleVolumes = 0;
    let sevenDayPurchasePriceCount = 0;
    let sevenDaySalePriceCount = 0;

    // 3 hour
    let threeHourPurchasePrices = 0;
    let threeHourSalePrices = 0;
    let threeHourPurchaseVolumes = 0;
    let threeHourSaleVolumes = 0;
    let threeHourPurchasePriceCount = 0;
    let threeHourSalePriceCount = 0;

    // 2 hour
    let twoHourPurchasePrices = 0;
    let twoHourSalePrices = 0;
    let twoHourPurchaseVolumes = 0;
    let twoHourSaleVolumes = 0;
    let twoHourPurchasePriceCount = 0;
    let twoHourSalePriceCount = 0;

    let dataPointKey = 1;
    timeSeriesData.forEach(timeEvent => {
        const purchasePrice = timeEvent.avgLowPrice;
        const salePrice = timeEvent.avgHighPrice;
        const purchaseVolume = timeEvent.lowPriceVolume || 0;
        const saleVolume = timeEvent.highPriceVolume || 0;

        // 7 day
        if (dataPointKey <= sevenDayDataPoints) {
            if (purchasePrice !== null && purchasePrice !== undefined) {
                sevenDayPurchasePrices += purchasePrice;
                sevenDayPurchasePriceCount++;
            }
            if (salePrice !== null && salePrice !== undefined) {
                sevenDaySalePrices += salePrice;
                sevenDaySalePriceCount++;
            }
            sevenDayPurchaseVolumes += purchaseVolume;
            sevenDaySaleVolumes += saleVolume;
        }

        // 24 hours
        if (dataPointKey <= twentyFourHourDataPoints) itemData.timeSeriesData.hourlyBreakdown[new Date(timeEvent.timestamp * 1000).toLocaleString()] = `Purchase Price: ${timeEvent.avgLowPrice}. Sale Price: ${timeEvent.avgHighPrice}. Purchase Volume: ${timeEvent.lowPriceVolume}. Sale Volume: ${timeEvent.highPriceVolume}`;

        // 3 hours
        if (dataPointKey <= threeHourDataPoints) {
            if (purchasePrice !== null && purchasePrice !== undefined) {
                threeHourPurchasePrices += purchasePrice;
                threeHourPurchasePriceCount++;
            }
            if (salePrice !== null && salePrice !== undefined) {
                threeHourSalePrices += salePrice;
                threeHourSalePriceCount++;
            }
            threeHourPurchaseVolumes += purchaseVolume;
            threeHourSaleVolumes += saleVolume;
        }

        // 2 hours
        if (dataPointKey <= twoHourDataPoints) {
            if (purchasePrice !== null && purchasePrice !== undefined) {
                twoHourPurchasePrices += purchasePrice;
                twoHourPurchasePriceCount++;
            }
            if (salePrice !== null && salePrice !== undefined) {
                twoHourSalePrices += salePrice;
                twoHourSalePriceCount++;
            }
            twoHourPurchaseVolumes += purchaseVolume;
            twoHourSaleVolumes += saleVolume;
        }

        dataPointKey++;
    });

    // 1 hour average over 7 days
    itemData.timeSeriesData.sevenDay.sevenDayAverageHourlyPurchasePrice = sevenDayPurchasePrices / sevenDayPurchasePriceCount;
    itemData.timeSeriesData.sevenDay.sevenDayAverageHourlySalePrice = sevenDaySalePrices / sevenDaySalePriceCount;
    itemData.timeSeriesData.sevenDay.sevenDayAverageHourlyPurchaseVolume = sevenDayPurchaseVolumes / sevenDayDataPoints;
    itemData.timeSeriesData.sevenDay.sevenDayAverageHourlySaleVolume = sevenDaySaleVolumes / sevenDayDataPoints;
    itemData.timeSeriesData.sevenDay.sevenDayAverageHourlyVolume = (itemData.timeSeriesData.sevenDay.sevenDayAverageHourlyPurchaseVolume + itemData.timeSeriesData.sevenDay.sevenDayAverageHourlySaleVolume) / 2;

    // Last 3 hours
    itemData.timeSeriesData.threeHour.threeHourAverageHourlyPurchasePrice = threeHourPurchasePrices / threeHourPurchasePriceCount;
    itemData.timeSeriesData.threeHour.threeHourAverageHourlySalePrice = threeHourSalePrices / threeHourSalePriceCount;
    itemData.timeSeriesData.threeHour.threeHourAverageHourlyPurchaseVolume = threeHourPurchaseVolumes / threeHourDataPoints;
    itemData.timeSeriesData.threeHour.threeHourAverageHourlySaleVolume = threeHourSaleVolumes / threeHourDataPoints;
    itemData.timeSeriesData.threeHour.threeHourAverageHourlyVolume = (itemData.timeSeriesData.threeHour.threeHourAverageHourlyPurchaseVolume + itemData.timeSeriesData.threeHour.threeHourAverageHourlySaleVolume) / 2;

    // Last 2 hours
    itemData.timeSeriesData.twoHour.twoHourAverageHourlyPurchasePrice = twoHourPurchasePrices / twoHourPurchasePriceCount;
    itemData.timeSeriesData.twoHour.twoHourAverageHourlySalePrice = twoHourSalePrices / twoHourSalePriceCount;
    itemData.timeSeriesData.twoHour.twoHourAverageHourlyPurchaseVolume = twoHourPurchaseVolumes / twoHourDataPoints;
    itemData.timeSeriesData.twoHour.twoHourAverageHourlySaleVolume = twoHourSaleVolumes / twoHourDataPoints;
    itemData.timeSeriesData.twoHour.twoHourAverageHourlyVolume = (itemData.timeSeriesData.twoHour.twoHourAverageHourlyPurchaseVolume + itemData.timeSeriesData.twoHour.twoHourAverageHourlySaleVolume) / 2;
};

await getPriceData();
convertTimeSeriesData();

if (itemData.oneHourData) {
    itemData.calculatedData.saleTaxAmount = Math.floor((itemData.oneHourData.oneHourSalePrice / 100) * GE_TAX_PERCENTAGE);
    itemData.calculatedData.saleBufferAmount = Math.floor((itemData.oneHourData.oneHourSalePrice / 100) * SALE_BUFFER_PERCENTAGE);
    itemData.calculatedData.salePriceExcludingTax = Math.floor(itemData.oneHourData.oneHourSalePrice - itemData.calculatedData.saleTaxAmount);
    itemData.calculatedData.salePriceExcludingBuffer = Math.floor(itemData.oneHourData.oneHourSalePrice - itemData.calculatedData.saleBufferAmount);
    itemData.calculatedData.salePriceExcludingTaxAndBuffer = Math.floor(itemData.calculatedData.salePriceExcludingTax - itemData.calculatedData.saleBufferAmount);
    itemData.calculatedData.salePrice = itemData.calculatedData.salePriceExcludingBuffer;
    itemData.fiveMinuteData.fiveMinutePurchasePrice ? itemData.calculatedData.purchasePrice = itemData.fiveMinuteData.fiveMinutePurchasePrice : itemData.calculatedData.purchasePrice = itemData.oneHourData.oneHourPurchasePrice;
    itemData.calculatedData.profitMargin = Math.floor(itemData.calculatedData.salePriceExcludingTaxAndBuffer - itemData.calculatedData.purchasePrice);
    itemData.calculatedData.maxProfitPerSlotHour = Math.min(itemData.timeSeriesData.threeHour.threeHourAverageHourlyVolume, itemData.limit) * itemData.calculatedData.profitMargin;
}

console.log(itemData);