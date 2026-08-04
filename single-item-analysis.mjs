const ITEM_ID = 1513;
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
    const timeSeriesDataFetch = await fetchFromAPI(`timeseries?timestep=1h&id=${ITEM_ID}`);
    
    timeSeriesData = timeSeriesDataFetch.data.reverse();
    mappingItemData = new Map(mappingItemDataFetch.map(item => [item.id, item]));
    fiveMinuteDataMap = new Map(Object.entries(fiveMinutePriceDataFetch.data).map(([id, data]) => [Number(id), data]));
    oneHourDataMap = new Map(Object.entries(oneHourPricesDataFetch.data).map(([id, data]) => [Number(id), data]));
    twentyFourHourDataMap = new Map(Object.entries(twentyFourHourPricesDataFetch.data).map(([id, data]) => [Number(id), data]));

    // Add mapping data.
    const mappingEntry = mappingItemData.get(ITEM_ID);
    if (mappingEntry) {
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

    let sevenDayPurchasePrices = 0;
    let sevenDaySalePrices = 0;
    let sevenDayPurchaseVolumes = 0;
    let sevenDaySaleVolumes = 0;
    let sevenDayPurchasePriceCount = 0;
    let sevenDaySalePriceCount = 0;

    let threeHourPurchasePrices = 0;
    let threeHourSalePrices = 0;
    let threeHourPurchaseVolumes = 0;
    let threeHourSaleVolumes = 0;
    let threeHourPurchasePriceCount = 0;
    let threeHourSalePriceCount = 0;

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

        if (dataPointKey <= sevenDayDataPoints) {
            if (purchasePrice) { sevenDayPurchasePrices += purchasePrice; sevenDayPurchasePriceCount++; }
            if (salePrice) { sevenDaySalePrices += salePrice; sevenDaySalePriceCount++; }
            sevenDayPurchaseVolumes += purchaseVolume;
            sevenDaySaleVolumes += saleVolume;
        }

        if (dataPointKey <= twentyFourHourDataPoints) {
            itemData.timeSeriesData.hourlyBreakdown[new Date(timeEvent.timestamp * 1000).toLocaleString()] = 
                `Purchase Price: ${timeEvent.avgLowPrice}. Sale Price: ${timeEvent.avgHighPrice}. Purchase Volume: ${timeEvent.lowPriceVolume}. Sale Volume: ${timeEvent.highPriceVolume}`;
        }

        if (dataPointKey <= threeHourDataPoints) {
            if (purchasePrice) { threeHourPurchasePrices += purchasePrice; threeHourPurchasePriceCount++; }
            if (salePrice) { threeHourSalePrices += salePrice; threeHourSalePriceCount++; }
            threeHourPurchaseVolumes += purchaseVolume;
            threeHourSaleVolumes += saleVolume;
        }

        if (dataPointKey <= twoHourDataPoints) {
            if (purchasePrice) { twoHourPurchasePrices += purchasePrice; twoHourPurchasePriceCount++; }
            if (salePrice) { twoHourSalePrices += salePrice; twoHourSalePriceCount++; }
            twoHourPurchaseVolumes += purchaseVolume;
            twoHourSaleVolumes += saleVolume;
        }

        dataPointKey++;
    });

    itemData.timeSeriesData.sevenDay.sevenDayAverageHourlyPurchasePrice = sevenDayPurchasePrices / sevenDayPurchasePriceCount;
    itemData.timeSeriesData.sevenDay.sevenDayAverageHourlySalePrice = sevenDaySalePrices / sevenDaySalePriceCount;
    
    itemData.timeSeriesData.threeHour.threeHourAverageHourlyPurchasePrice = threeHourPurchasePrices / threeHourPurchasePriceCount;
    itemData.timeSeriesData.threeHour.threeHourAverageHourlySalePrice = threeHourSalePrices / threeHourSalePriceCount;
    
    itemData.timeSeriesData.twoHour.twoHourAverageHourlyPurchasePrice = twoHourPurchasePrices / twoHourPurchasePriceCount;
    itemData.timeSeriesData.twoHour.twoHourAverageHourlySalePrice = twoHourSalePrices / twoHourSalePriceCount;
};

// --- NEW REENTRY / CURRENT SALE PRICE LOGIC ---
const determineCurrentSalePrice = () => {
    // Determine the current live baseline high price (prefer 5m data if active, fallback to 1h average)
    const liveHighPrice = itemData.fiveMinuteData.fiveMinuteSalePrice || itemData.oneHourData.oneHourSalePrice;
    
    if (!liveHighPrice) {
        console.log("⚠️ Warning: No active sale price data found. Market might be completely dead for this item.");
        return;
    }

    itemData.calculatedData.rawCurrentSalePrice = liveHighPrice;
    itemData.calculatedData.saleTaxAmount = Math.floor((liveHighPrice / 100) * GE_TAX_PERCENTAGE);
    itemData.calculatedData.saleBufferAmount = Math.floor((liveHighPrice / 100) * SALE_BUFFER_PERCENTAGE);
    
    // Recommended price to put into the GE slot to sell instantly/safely without unnecessary lag
    itemData.calculatedData.recommendedListingPrice = Math.floor(liveHighPrice - itemData.calculatedData.saleBufferAmount);
};

await getPriceData();
convertTimeSeriesData();
determineCurrentSalePrice();

// Output concise text helper for your reentry use-case
const bold = `\x1b[1m`;
const green = `\x1b[32m`;
const magenta = `\x1b[35m`;
const normal = `\x1b[0m`;

// Keep full object print available if you still want the deep dive JSON
console.log(itemData);

console.log('-------------------------------------------------------------------------------------------------------------------------------------------------------------');
console.log(`${magenta}[REENTRY CHECK: ${itemData.itemName.toUpperCase()}]${normal}`);
console.log(`${bold}RECOMMENDED GE LISTING PRICE:${normal} ${green}[${itemData.calculatedData.recommendedListingPrice?.toLocaleString()}gp]${normal} (Accounts for 1% safety buffer)`);
console.log(`${bold}RAW LIVE MARKET HIGH:${normal} [${itemData.calculatedData.rawCurrentSalePrice?.toLocaleString()}gp] | ${bold}ESTIMATED GE TAX:${normal} [${itemData.calculatedData.saleTaxAmount?.toLocaleString()}gp]`);
console.log('-------------------------------------------------------------------------------------------------------------------------------------------------------------');