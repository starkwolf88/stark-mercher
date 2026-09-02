import { promises as fs } from 'fs';

const debug = false;
const MAX_RESULTS = 100; // Maximum number of merchable items to output after sorting by profitability
const GE_TAX_PERCENTAGE = 2; // Grand Exchange sale tax percentage deducted from sell price
const CASH_STACK_MILLIONS = 10; // Total flipping cash in millions for readability
const CASH_STACK = CASH_STACK_MILLIONS * 1000000; // Total GP available for flipping
const SALE_BUFFER_PERCENTAGE = 0.01; // Extra safety margin removed from sell price to protect against price movement
const AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO = 0.20; // Percentage of total cash assumed to be used per GE slot (~5 slots)
const AVERAGE_SLOT_CASH_STACK_ALLOCATION = CASH_STACK * AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO; // Average GP allocated per GE slot
const MARKET_SHARE_ASSUMPTION_PERCENTAGE = 35; // calculateEtas() Assume 35% market share to estimate ETA's better
const MAX_TURNOVER_HOURS = 2.5; // calculateEtas() Maximum allowed time for a full flip cycle (purchase + sale)
const TWO_HOUR_VOLUME_BUFFER_PERCENTAGE = 15;

// Item specific variables
const EXCLUDED_NAME_STRINGS = [
    " bond",
    "arrow(p",
    "knife(p",
    "(2)",
    "(1)",
    " paint",
    "ornament kit",
    "upgrade kit",
    "cow slippers"
];
const INCLUDED_NAME_STRINGS = [
    'moth mix'
];
const ESTIMATED_LIMIT_FIXES = {
    31638: 2000, // Extended stamina potion(4)
    13249: 10000, // Key master teleport
    29684: 10000
}

// Price data variables
let itemTimeSeriesData = {};
let itemLongTermCrashData = {}; // Cached 30d v2 timeseries for determineLongTermCrash()
let oneHourPriceData = {};
let mappingItemData = {};
let fiveMinuteDataMap = {};
let twentyFourHourDataMap = {};
let filteredItems = [];
let filteredItemsWithTimeSeries = [];
let filteredItemsWithFullData = [];
let filteredItemsBeforeCashAllocation = [];
let merchableItems = [];

// Filter variables
let mappingEntryFiltered = 0;
let twentyFourHourEntryFiltered = 0;
let itemNameFiltered = 0; // excludeNameStrings()
let purchasePriceExceedsCashStackFiltered = 0; // determinePurchaseAndSalePrices()
let fiveMinuteVsOneHourPurchasePriceChangeFiltered = 0; // determineFiveMinuteVsOneHourPurchasePriceChange()
let fiveMinuteVsOneHourSalePriceChangeFiltered = 0; // determineFiveMinuteVsOneHourSalePriceChange()
let profitMarginFiltered = 0; // calculateProfitMargin()
let limitProfitPerFlipFiltered = 0; // calculateProfitMargin()
let timeSeriesDataFiltered = 0;
let threeHourDataFiltered = 0;
let purchasePriceNotAvailableFiltered = 0; // validatePurchasePrice()
let validatedPurchasePriceExceedsCashStack = 0; // validatePurchasePrice()
let salePriceNotAvailableFiltered = 0; // validateSalePrice()
let irregularVolumesFiltered = 0; // determineIrregularVolumes()
let trendSlopeFiltered = 0; // determineTrendSlope()
let salePriceSpikeFiltered = 0; // determineSalePriceSpike()
let purchasePriceDropFiltered = 0; // determinePurchasePriceDrop()
let profitPerSlotHourFiltered = 0; // calculateMaxProfitPerSlotHour()
let quantityToPurchaseFiltered = 0 // calculateQuantityToPurchase()
let etaVolumeLowFiltered = 0; // calculateEtas()
let etaTurnoverFiltered = 0; // calculateEtas()
let actualProfitPerSlotHourFiltered = 0; // calculateProfitability()
let returnOnInvestmentFiltered = 0; // calculateProfitability()
let longTermCrashFiltered = 0; // determineLongTermCrash()

try {
    const file = await fs.readFile('item_time_series_data.json', 'utf-8');
    itemTimeSeriesData = JSON.parse(file);
} catch (err) {
    if (err.code !== 'ENOENT') throw err; // ignore if file doesn't exist
}

try {
    const crashFile = await fs.readFile('item_long_term_crash_data.json', 'utf-8');
    itemLongTermCrashData = JSON.parse(crashFile);
} catch (err) {
    if (err.code !== 'ENOENT') throw err; // ignore if file doesn't exist
}

// 30-day crash data is cached per item and only refetched if older than this TTL.
// The 30d lookback window barely shifts over 3-minute cycles, so a 24h TTL is
// more than sufficient and avoids bursting the v2 API every run.
const LONG_TERM_CRASH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
// Small delay between v2 API calls to avoid the OSRS Wiki load balancer dropping
// connections (ECONNABORTED) when many items need a fresh fetch in one run.
const LONG_TERM_CRASH_FETCH_DELAY_MS = 200;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));


async function getPriceData() {
    const fiveMinutePriceDataFetch = await fetchFromAPI('5m');
    const oneHourPricesDataFetch = await fetchFromAPI('1h');
    const twentyFourHourPricesDataFetch = await fetchFromAPI('24h');
    const mappingItemDataFetch = await fetchFromAPI('mapping');

    // TESTING
    // fs.writeFile('fiveMinutePriceDataFetch.json', JSON.stringify(await fetchFromAPI('5m')));
    // fs.writeFile('oneHourPricesDataFetch.json', JSON.stringify(await fetchFromAPI('1h')));
    // fs.writeFile('twentyFourHourPricesDataFetch.json', JSON.stringify(await fetchFromAPI('24h')));
    // fs.writeFile('mappingItemDataFetch.json', JSON.stringify(await fetchFromAPI('mapping')));
    // const fiveMinutePriceDataFetch = JSON.parse(await fs.readFile('fiveMinutePriceDataFetch.json', 'utf-8'));
    // const oneHourPricesDataFetch = JSON.parse(await fs.readFile('oneHourPricesDataFetch.json', 'utf-8'));
    // const twentyFourHourPricesDataFetch = JSON.parse(await fs.readFile('twentyFourHourPricesDataFetch.json', 'utf-8'));
    // const mappingItemDataFetch = JSON.parse(await fs.readFile('mappingItemDataFetch.json', 'utf-8'));

    oneHourPriceData = oneHourPricesDataFetch.data;
    mappingItemData = new Map(mappingItemDataFetch.map(item => [item.id, item]));
    fiveMinuteDataMap = new Map(Object.entries(fiveMinutePriceDataFetch.data).map(([id, data]) => [Number(id), data]));
    twentyFourHourDataMap = new Map(Object.entries(twentyFourHourPricesDataFetch.data).map(([id, data]) => [Number(id), data]));
};

async function fetchFromAPI(endpoint) {
    const response = await fetch(`https://prices.runescape.wiki/api/v1/osrs/${endpoint}`, { headers: { "User-Agent": "[Stark] Mercher. st_rk@outlook.com" } });
    return response.json();
}

async function fetchFromAPIV2(endpoint) {
    const response = await fetch(`https://prices.runescape.wiki/api/v2/osrs/${endpoint}`, { headers: { "User-Agent": "[Stark] Mercher. st_rk@outlook.com" } });
    return response.json();
}

const buildItemDataObject = (itemData) => {

    // Add mapping data.
    const mappingEntry = mappingItemData.get(itemData.itemId);
    if (!mappingEntry) {
        mappingEntryFiltered++;
        return false;
    }
    itemData.itemName = mappingEntry.name;

    // Determine item limit and membership flag.
    itemData.limit = mappingEntry.limit;
    if (!itemData.limit) {
        itemData.itemId in ESTIMATED_LIMIT_FIXES ? itemData.limit = ESTIMATED_LIMIT_FIXES[itemData.itemId] : itemData.limit = 4;
    }
    itemData.members = mappingEntry.members === true;

    // Add five minute data if available.
    const fiveMinuteEntry = fiveMinuteDataMap.get(itemData.itemId);
    if (fiveMinuteEntry) {
        itemData.fiveMinutePurchasePrice = fiveMinuteEntry.avgLowPrice;
        itemData.fiveMinuteSalePrice = fiveMinuteEntry.avgHighPrice;
        itemData.fiveMinutePurchaseVolume = fiveMinuteEntry.lowPriceVolume;
        itemData.fiveMinuteSaleVolume = fiveMinuteEntry.highPriceVolume;
    }

    // Add 24 hour data if available.
    const twentyFourHourEntry = twentyFourHourDataMap.get(itemData.itemId);
    if (!twentyFourHourEntry || twentyFourHourEntry.lowPriceVolume < 5 || twentyFourHourEntry.highPriceVolume < 5 || !twentyFourHourEntry.avgLowPrice || !twentyFourHourEntry.avgHighPrice || twentyFourHourEntry.avgHighPrice < 10 || twentyFourHourEntry.avgLowPrice < 10) {
        twentyFourHourEntryFiltered++;
        return false;
    }
    // Store 24h average low for use as a lowball floor in applyLowball().
    itemData.twentyFourHourAvgLowPrice = twentyFourHourEntry.avgLowPrice;
    return true;
};

const excludeNameStrings = (itemData) => {
    const itemNameLower = itemData.itemName.toLowerCase();
    if (EXCLUDED_NAME_STRINGS.some(nameString => itemNameLower.includes(nameString)) && !INCLUDED_NAME_STRINGS.some(nameString => itemNameLower.includes(nameString))) {
        itemNameFiltered++;
        return false;
    }
    return true;
};

const determinePurchaseAndSalePrices = (itemData) => {
    if (itemData.fiveMinutePurchasePrice && itemData.fiveMinuteSalePrice) {
        itemData.purchasePrice = itemData.fiveMinutePurchasePrice;
        itemData.rawSalePrice = itemData.fiveMinuteSalePrice;
    }
    if (itemData.purchasePrice > CASH_STACK) {
        purchasePriceExceedsCashStackFiltered++;
        return false;
    }
    return true;
}

const FIVE_MINUTE_VS_ONE_HOUR_PURCHASE_RELATIVE_VOLUME_CHANGE_MAX_THRESHOLD = 0.05;
const FIVE_MINUTE_VS_ONE_HOUR_PURCHASE_PRICE_CHANGE_MAX_PERCENTAGE = 5;
const FIVE_MINUTE_VS_ONE_HOUR_PURCHASE_PRICE_CHANGE_MIN_PERCENTAGE = 2;
const FIVE_MINUTE_VS_ONE_HOUR_PURCHASE_PRICE_CHANGE_MARGIN_SCALE = 0.4;
const determineFiveMinuteVsOneHourPurchasePriceChange = (itemData) => {
    if (!itemData.fiveMinutePurchasePrice || !itemData.oneHourPurchasePrice || !itemData.oneHourPurchaseVolume) return true;

    // Relative volume check. If 5-minute trades are less than 5% of the 1-hour average, ignore the spike/drop
    if ((itemData.fiveMinutePurchaseVolume / itemData.oneHourPurchaseVolume) < FIVE_MINUTE_VS_ONE_HOUR_PURCHASE_RELATIVE_VOLUME_CHANGE_MAX_THRESHOLD) return true;

    // Margin-aware threshold: thin-margin items get a tighter threshold
    // because a small price movement can wipe out the profit.
    const roughMarginPct = itemData.purchasePrice > 0
        ? ((itemData.rawSalePrice - itemData.purchasePrice) / itemData.purchasePrice) * 100
        : 0;
    const maxChangePct = Math.min(
        FIVE_MINUTE_VS_ONE_HOUR_PURCHASE_PRICE_CHANGE_MAX_PERCENTAGE,
        Math.max(FIVE_MINUTE_VS_ONE_HOUR_PURCHASE_PRICE_CHANGE_MIN_PERCENTAGE, roughMarginPct * FIVE_MINUTE_VS_ONE_HOUR_PURCHASE_PRICE_CHANGE_MARGIN_SCALE)
    );

    // CLAMP instead of filter: if the 5m price spikes above the 1h average
    // by more than the threshold, clamp it down to the 1h average + threshold.
    // This neutralises transient 5m spikes (like the Diamond's 2.3% spike)
    // without removing the item from the pool. Downward drops are left as-is
    // (they're beneficial — we buy cheaper).
    const maxPurchasePrice = Math.floor(itemData.oneHourPurchasePrice * (1 + maxChangePct / 100));
    if (itemData.fiveMinutePurchasePrice > maxPurchasePrice) {
        itemData.fiveMinutePurchasePrice = maxPurchasePrice;
        itemData.purchasePrice = maxPurchasePrice;
        fiveMinuteVsOneHourPurchasePriceChangeFiltered++;
    }
    return true;
};

const FIVE_MINUTE_VS_ONE_HOUR_SALE_RELATIVE_VOLUME_CHANGE_MAX_THRESHOLD = 0.05;
const FIVE_MINUTE_VS_ONE_HOUR_SALE_PRICE_CHANGE_MAX_PERCENTAGE = 10;
const FIVE_MINUTE_VS_ONE_HOUR_SALE_PRICE_CHANGE_MIN_PERCENTAGE = 2;
const FIVE_MINUTE_VS_ONE_HOUR_SALE_PRICE_CHANGE_MARGIN_SCALE = 0.4;
const determineFiveMinuteVsOneHourSalePriceChange = (itemData) => {
    if (!itemData.fiveMinuteSalePrice || !itemData.oneHourSalePrice || !itemData.oneHourSaleVolume) return true;

    // Relative volume check. If 5-minute trades are less than 5% of the 1-hour average, ignore the spike/drop
    if ((itemData.fiveMinuteSaleVolume / itemData.oneHourSaleVolume) < FIVE_MINUTE_VS_ONE_HOUR_SALE_RELATIVE_VOLUME_CHANGE_MAX_THRESHOLD) return true;

    // Margin-aware threshold: thin-margin items get a tighter threshold
    // because a small price movement can wipe out the profit.
    const roughMarginPct = itemData.purchasePrice > 0
        ? ((itemData.rawSalePrice - itemData.purchasePrice) / itemData.purchasePrice) * 100
        : 0;
    const maxChangePct = Math.min(
        FIVE_MINUTE_VS_ONE_HOUR_SALE_PRICE_CHANGE_MAX_PERCENTAGE,
        Math.max(FIVE_MINUTE_VS_ONE_HOUR_SALE_PRICE_CHANGE_MIN_PERCENTAGE, roughMarginPct * FIVE_MINUTE_VS_ONE_HOUR_SALE_PRICE_CHANGE_MARGIN_SCALE)
    );

    // CLAMP instead of filter: if the 5m sale price spikes above the 1h
    // average by more than the threshold, clamp it down to the 1h average +
    // threshold. This neutralises transient 5m spikes (like the Diamond's
    // 2.3% spike) without removing the item from the pool. The sell target
    // will be based on the clamped price, not the spiked one. Downward drops
    // are left as-is (they're conservative — we sell cheaper, more likely to
    // fill).
    const maxSalePrice = Math.floor(itemData.oneHourSalePrice * (1 + maxChangePct / 100));
    if (itemData.fiveMinuteSalePrice > maxSalePrice) {
        itemData.fiveMinuteSalePrice = maxSalePrice;
        itemData.rawSalePrice = maxSalePrice;
        fiveMinuteVsOneHourSalePriceChangeFiltered++;
    }
    return true;
};

const GE_TAX_EXEMPTION_THRESHOLD = 50; // Items with a sale price below 50gp are exempt from GE sales tax

const calculateSalePrice = (itemData) => {
    itemData.saleTaxAmount = itemData.rawSalePrice < GE_TAX_EXEMPTION_THRESHOLD ? 0 : Math.floor((itemData.rawSalePrice / 100) * GE_TAX_PERCENTAGE);
    itemData.saleBufferAmount = Math.floor((itemData.rawSalePrice / 100) * SALE_BUFFER_PERCENTAGE);
    itemData.salePriceExcludingTax = Math.floor(itemData.rawSalePrice - itemData.saleTaxAmount);
    itemData.salePriceExcludingTaxAndBuffer = Math.floor(itemData.salePriceExcludingTax - itemData.saleBufferAmount);
    itemData.salePrice = Math.floor(itemData.rawSalePrice - itemData.saleBufferAmount);
};

const calculateProfitMargin = (itemData) => {
    itemData.profitMargin = Math.floor(itemData.salePriceExcludingTaxAndBuffer - itemData.purchasePrice);
    if (itemData.profitMargin < 1) {
        profitMarginFiltered++;
        return false;
    }
    if ((itemData.profitMargin * itemData.limit) < 10000) {
        limitProfitPerFlipFiltered++
        return false;
    }
    return true;
};

async function getTimeSeriesData() {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentHourSec = Math.floor(nowSec / 3600) * 3600;
    const expectedLatestTimestamp = currentHourSec - 3600;
    const expectedTimestampDate = new Date(expectedLatestTimestamp * 1000).toLocaleString();
    for (const itemData of filteredItems) {
        let fetchNewData = false;
        const existingSeries = itemTimeSeriesData[itemData.itemId];

        // No data. Fetch from API.
        if (!existingSeries || existingSeries.length === 0) {
            fetchNewData = true;
            debug && console.log(`No time series data for '${itemData.itemName}' [${itemData.itemId}]. Fetching data from API.`);
        } else {
            const lastTimestampSec = existingSeries[0].timestamp;
            const hoursBehind = Math.round((expectedLatestTimestamp - lastTimestampSec) / 3600);

            // 1 hour outdated. Get from 1h data.
            if (hoursBehind === 1) {
                debug && console.log(`[${expectedTimestampDate}] doesn't exist against '${itemData.itemName}' [${itemData.itemId}]. Adding data from 1h data.`);
                existingSeries.unshift({
                    timestamp: expectedLatestTimestamp,
                    avgHighPrice: itemData.oneHourSalePrice,
                    avgLowPrice: itemData.oneHourPurchasePrice,
                    highPriceVolume: itemData.oneHourSaleVolume,
                    lowPriceVolume: itemData.oneHourPurchaseVolume,
                    date: expectedTimestampDate
                });

                // 2 hours outdated. Fetch from API.
            } else if (hoursBehind > 1) {
                fetchNewData = true;
                debug && console.log(`Time series data for '${itemData.itemName}' [${itemData.itemId}] is at least 2 hours outdated. Fetching data from API.`);
            }
        }

        // If new data is required.
        if (fetchNewData) {
            const timeSeriesData = await fetchFromAPI(`timeseries?timestep=1h&id=${itemData.itemId}`);
            if (!timeSeriesData) {
                timeSeriesDataFiltered++;
                continue;
            }

            // Convert timestamps for readability.
            timeSeriesData.data.forEach(timeEvent => timeEvent.date = new Date(timeEvent.timestamp * 1000).toLocaleString());

            // Add to itemData.
            itemTimeSeriesData[itemData.itemId] = timeSeriesData.data.reverse();
        }
        itemData.timeSeriesData = itemTimeSeriesData[itemData.itemId];
        filteredItemsWithTimeSeries.push(itemData);
    }
    await fs.writeFile('item_time_series_data.json', JSON.stringify(itemTimeSeriesData, null, 2), 'utf-8');
};

const convertTimeSeriesData = () => {
    const twoHourDataPoints = 2;
    const threeHourDataPoints = 3;
    const fourHourDataPoints = 4;
    const sevenDayDataPoints = 168;
    for (const itemData of filteredItemsWithTimeSeries) {

        // 2 hour
        let twoHourPurchasePrices = 0;
        let twoHourSalePrices = 0;
        let twoHourPurchaseVolumes = 0;
        let twoHourSaleVolumes = 0;
        let twoHourPurchasePriceCount = 0;
        let twoHourSalePriceCount = 0;

        // 3 hour
        let threeHourPurchasePrices = 0;
        let threeHourSalePrices = 0;
        let threeHourPurchaseVolumes = 0;
        let threeHourSaleVolumes = 0;
        let threeHourPurchasePriceCount = 0;
        let threeHourSalePriceCount = 0;

        // 4 hour data points
        let fourHourData = {}

        // 7 day
        let sevenDayPurchasePrices = 0;
        let sevenDaySalePrices = 0;
        let sevenDayPurchaseVolumes = 0;
        let sevenDaySaleVolumes = 0;
        let sevenDayPurchasePriceCount = 0;
        let sevenDaySalePriceCount = 0;

        let dataPointKey = 1;
        itemData.timeSeriesData.forEach(timeEvent => {
            const purchasePrice = timeEvent.avgLowPrice;
            const salePrice = timeEvent.avgHighPrice;
            const purchaseVolume = timeEvent.lowPriceVolume || 0;
            const saleVolume = timeEvent.highPriceVolume || 0;

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

            // 4 hour data points
            if (dataPointKey <= fourHourDataPoints) fourHourData[timeEvent.timestamp] = timeEvent;

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

            dataPointKey++;
        });

        // Last 2 hours
        itemData.twoHourAverageHourlyPurchasePrice = twoHourPurchasePrices / twoHourPurchasePriceCount;
        itemData.twoHourAverageHourlySalePrice = twoHourSalePrices / twoHourSalePriceCount;
        itemData.twoHourAverageHourlyPurchaseVolume = twoHourPurchaseVolumes / twoHourDataPoints;
        itemData.twoHourAverageHourlySaleVolume = twoHourSaleVolumes / twoHourDataPoints;
        itemData.twoHourAverageHourlyVolume = (itemData.twoHourAverageHourlyPurchaseVolume + itemData.twoHourAverageHourlySaleVolume) / 2;

        // Last 3 hours
        itemData.threeHourAverageHourlyPurchasePrice = threeHourPurchasePrices / threeHourPurchasePriceCount;
        itemData.threeHourAverageHourlySalePrice = threeHourSalePrices / threeHourSalePriceCount;
        itemData.threeHourAverageHourlyPurchaseVolume = threeHourPurchaseVolumes / threeHourDataPoints;
        itemData.threeHourAverageHourlySaleVolume = threeHourSaleVolumes / threeHourDataPoints;
        itemData.threeHourAverageHourlyVolume = (itemData.threeHourAverageHourlyPurchaseVolume + itemData.threeHourAverageHourlySaleVolume) / 2;

        // Four hour data points
        itemData.fourHourData = fourHourData;

        // 1 hour average over 7 days
        itemData.sevenDayAverageHourlyPurchasePrice = sevenDayPurchasePrices / sevenDayPurchasePriceCount;
        itemData.sevenDayAverageHourlySalePrice = sevenDaySalePrices / sevenDaySalePriceCount;
        itemData.sevenDayAverageHourlyPurchaseVolume = sevenDayPurchaseVolumes / sevenDayDataPoints;
        itemData.sevenDayAverageHourlySaleVolume = sevenDaySaleVolumes / sevenDayDataPoints;
        itemData.sevenDayAverageHourlyVolume = (itemData.sevenDayAverageHourlyPurchaseVolume + itemData.sevenDayAverageHourlySaleVolume) / 2;

        // Remove time series data from object.
        delete (itemData.timeSeriesData);

        // Three hour data filter.
        if (!itemData.threeHourAverageHourlyPurchasePrice || !itemData.threeHourAverageHourlySalePrice || !itemData.threeHourAverageHourlyPurchaseVolume || !itemData.threeHourAverageHourlySaleVolume) {
            threeHourDataFiltered++;
            continue;
        }

        // Push to array.
        filteredItemsWithFullData.push(itemData);
    }
};

const validatePurchasePrice = (itemData) => {
    if (!itemData.purchasePrice) {
        if (itemData.twoHourAverageHourlyPurchasePrice) {
            itemData.purchasePrice = itemData.twoHourAverageHourlyPurchasePrice;
        } else {
            if (itemData.threeHourAverageHourlyPurchasePrice) {
                itemData.purchasePrice = itemData.threeHourAverageHourlyPurchasePrice;
            } else {
                purchasePriceNotAvailableFiltered++;
                return false;
            }
        }
    }
    if (itemData.purchasePrice > CASH_STACK) {
        validatedPurchasePriceExceedsCashStack++;
        return false;
    }
    return true;
};

const validateSalePrice = (itemData) => {
    if (!itemData.salePrice) {
        if (itemData.twoHourAverageHourlySalePrice) {
            itemData.rawSalePrice = itemData.twoHourAverageHourlySalePrice;
        } else {
            if (itemData.threeHourAverageHourlySalePrice) {
                itemData.rawSalePrice = itemData.threeHourAverageHourlySalePrice;
            } else {
                salePriceNotAvailableFiltered++;
                return false;
            }
        }
    }
    return true;
};

const clampPrices = (itemData) => {
    itemData.purchasePrice = clampPrice(itemData.purchasePrice, itemData.twoHourAverageHourlyPurchasePrice);
    // Clamp rawSalePrice too — calculateSalePrice() is called AFTER
    // clampPrices() in the second pass and recomputes salePrice from
    // rawSalePrice, so an unclamped rawSalePrice (e.g. a low-volume 5m
    // avgHighPrice spike that bypassed the 5m-vs-1h spike filter) would
    // overwrite the clamped salePrice with the spiked value. This was the
    // root cause of the Rune platebody 48,190gp sell price (market ~38,400).
    itemData.rawSalePrice = clampPrice(itemData.rawSalePrice, itemData.twoHourAverageHourlySalePrice);
    // Clamp lowballBasePrice so applyLowball() (also called after
    // clampPrices) doesn't bypass the clamp via the stored base price.
    itemData.lowballBasePrice = clampPrice(itemData.lowballBasePrice ?? itemData.purchasePrice, itemData.twoHourAverageHourlyPurchasePrice);
    itemData.salePrice = clampPrice(itemData.salePrice, itemData.twoHourAverageHourlySalePrice);
};

// --- Volume-scaled lowball -------------------------------------------------
// Instead of buying at the 5m average low (instant-buy price), place a buy
// offer slightly below market. High-volume items have a wide price
// distribution — many trades happen below the average low, so a small
// lowball still fills quickly. The lowball % scales with volume:
//   > 200k/hr → 2%, 50k–200k → 1.5%, 10k–50k → 1%, < 10k → 0%
// Only applied to high-quantity items (min(volume, limit) >= 5000) where
// we're buying enough units that a small per-unit margin adds up.
//
// In the first pass, 3h volume isn't available yet (it comes from timeseries
// data between passes). We fall back to 1h purchase volume as a proxy so
// items with thin raw margins can survive the first-pass profit filter and
// reach the second pass where the accurate 3h volume is used.
//
// IMPORTANT: applyLowball must be idempotent within a single pass. The second
// pass resets purchasePrice to its pre-lowball value (stored in
// lowballBasePrice) before re-applying, so the lowball doesn't stack.
//
// MARGIN-AWARE CAP: The lowball amount is capped at 50% of the raw margin
// (rawSalePrice - basePrice). For thin-margin items (e.g. 3gp spread on a
// 150gp item), a flat 2% lowball (3gp) would eat the entire margin and
// produce a buy offer below the market floor that never fills. Capping at
// 50% of the margin ensures the lowball never eliminates more than half the
// spread. If the capped amount is < 1gp, no lowball is applied.
//
// 24H FLOOR: The final purchasePrice is clamped to at least
// (twentyFourHourAvgLowPrice - 1), but never above basePrice. This prevents
// the lowball from pushing below the broader 24h market average, which would
// only capture the bottom tail of the price distribution — not enough volume
// to fill a large order.
const LOWBALL_QUANTITY_GATE = 5000;
const LOWBALL_VOLUME_TIERS = [
    { minVolume: 200000, percent: 2.0 },
    { minVolume: 50000,  percent: 1.5 },
    { minVolume: 10000,  percent: 1.0 },
];
const LOWBALL_MARGIN_CAP_RATIO = 0.5; // cap at 50% of raw margin

const applyLowball = (itemData) => {
    // Use 3h volume if available (second pass), otherwise fall back to 1h
    // purchase volume (first pass — timeseries data not fetched yet).
    const volume = itemData.threeHourAverageHourlyVolume || itemData.oneHourPurchaseVolume || 0;
    const effectiveQty = Math.min(volume, itemData.limit || 0);
    if (effectiveQty < LOWBALL_QUANTITY_GATE) {
        itemData.lowballPercent = 0;
        itemData.lowballAmount = 0;
        itemData.lowballBasePrice = itemData.purchasePrice;
        return;
    }

    let percent = 0;
    for (const tier of LOWBALL_VOLUME_TIERS) {
        if (volume >= tier.minVolume) {
            percent = tier.percent;
            break;
        }
    }

    if (percent <= 0) {
        itemData.lowballPercent = 0;
        itemData.lowballAmount = 0;
        itemData.lowballBasePrice = itemData.purchasePrice;
        return;
    }

    // If a previous lowball was applied (second pass after first pass),
    // reset to the base price before re-applying so the lowball doesn't stack.
    const basePrice = itemData.lowballBasePrice ?? itemData.purchasePrice;
    let amount = Math.max(1, Math.floor(basePrice * percent / 100));

    // Margin-aware cap: don't lowball more than 50% of the raw spread.
    // rawSalePrice may not be set in the first pass (it is set by
    // determinePurchaseAndSalePrices before the first applyLowball call, so
    // it should be available, but guard just in case).
    const rawMargin = (itemData.rawSalePrice ? itemData.rawSalePrice : basePrice) - basePrice;
    if (rawMargin > 0) {
        const marginCap = Math.floor(rawMargin * LOWBALL_MARGIN_CAP_RATIO);
        if (marginCap < 1) {
            // Spread is too thin to lowball — buy at market.
            itemData.lowballPercent = 0;
            itemData.lowballAmount = 0;
            itemData.lowballBasePrice = basePrice;
            itemData.purchasePrice = basePrice;
            return;
        }
        amount = Math.min(amount, marginCap);
    }

    let finalPrice = Math.max(1, basePrice - amount);

    // 24h floor: don't lowball below the 24h average low (minus 1gp for
    // edge-case tolerance). Never push above basePrice.
    const floor = itemData.twentyFourHourAvgLowPrice;
    if (floor && floor > 0) {
        const flooredPrice = Math.max(finalPrice, floor - 1);
        finalPrice = Math.min(flooredPrice, basePrice);
    }

    // Recompute the actual applied amount/percent after cap and floor so
    // the ETA volume factor reflects reality.
    const appliedAmount = basePrice - finalPrice;
    const appliedPercent = basePrice > 0 ? (appliedAmount / basePrice) * 100 : 0;
    itemData.lowballPercent = appliedPercent;
    itemData.lowballAmount = appliedAmount;
    itemData.lowballBasePrice = basePrice;
    itemData.purchasePrice = finalPrice;
};

const determineIrregularVolumes = (itemData) => {
    if (itemData.sevenDayAverageHourlyVolume < 5) return true; // Ignore low volume items

    const dropThresholdMin = 0.25;
    const dropThresholdMax = 0.4;
    const spikeThreshold = 2.5;
    const dynamicDropThreshold = Math.min(dropThresholdMax, Math.max(dropThresholdMin, (itemData.sevenDayAverageHourlyVolume / 100) * Math.log10(itemData.salePrice + 1)));
    const dynamicSpikeThreshold = Math.max(spikeThreshold, Math.log10(itemData.salePrice + 1));
    const threeHourVsSevenDayVolumeRatio = itemData.threeHourAverageHourlyVolume / itemData.sevenDayAverageHourlyVolume;
    itemData.threeHourVsSevenDayVolumeRatio = threeHourVsSevenDayVolumeRatio;
    if (threeHourVsSevenDayVolumeRatio < dynamicDropThreshold || threeHourVsSevenDayVolumeRatio > dynamicSpikeThreshold) {
        irregularVolumesFiltered++;
        return false;
    }
    return true;
};

const determineTrendSlope = (itemData) => {
    const rawPrices = Object.values(itemData.fourHourData).map(entry => entry.avgLowPrice ?? entry.avgHighPrice);
    const prices = [];
    let lastValidPrice = null;
    for (const p of rawPrices) {
        if (p != null) {
            prices.push(p);
            lastValidPrice = p;
        } else if (lastValidPrice != null) {
            prices.push(lastValidPrice);
        } else {
            prices.push(0);
        }
    }

    let drops = 0;
    let flats = 0;
    const minStepPercent = 0.02;
    for (let i = 1; i < prices.length; i++) {
        const stepDropPercent = (prices[i - 1] - prices[i]) / prices[i - 1];
        if (stepDropPercent >= minStepPercent) {
            drops++;
        } else if (stepDropPercent >= 0 && stepDropPercent < minStepPercent) {
            flats++;
        }
    }

    // 3+ drops, or 2+ drops and 1+ flats
    if (drops > 2 || (drops > 1 && flats > 0)) {
        trendSlopeFiltered++;
        return false;
    }

    return true;
}

// --- Margin-aware spike thresholds ------------------------------------------
// Two types of spike filters:
//
// 1. 5m vs 1h (above): catches TRANSIENT spikes — a 5-minute price window
//    that deviates significantly from the 1-hour average. This is the filter
//    that would have caught the Diamond's 2.3% 5m spike. Uses a tight 2%
//    floor because 5m and 1h averages should be close for high-volume items.
//
// 2. 1h/3h vs 7d (below): catches SUSTAINED spikes — the 1-hour or 3-hour
//    average is significantly above the 7-day baseline. This catches items
//    in a sustained uptrend, not transient 5m spikes. The 1h average smooths
//    out 5m spikes, so a 2% threshold here is far too tight — normal market
//    cycles produce 2-5% 1h vs 7d variation. The floor is set to 5% (1h) and
//    4% (3h) to only flag items in a clear sustained spike.
//
// Margin scaling applies to both: thin-margin items get a tighter threshold
// because a small spike consumes a larger fraction of the profit.
//
//   maxSpikePct = clamp(marginPct * scaleFactor, minPct, maxPct)
//
// Examples (marginPct = profitMargin / purchasePrice * 100):
//   3.4% margin (Diamond):  maxSpikePct1h = max(5, 1.7) = 5%   → 0.2% 1h spike NOT filtered (correct — 5m filter catches it)
//   10% margin:             maxSpikePct1h = max(5, 5)   = 5%
//   25% margin:             maxSpikePct1h = max(5, 12.5) = 12.5%
//   50%+ margin:            maxSpikePct1h = min(20, 25)  = 20%  (same as old fixed threshold)
const ONE_HOUR_SALE_SPIKE_MARGIN_SCALE = 0.5;
const ONE_HOUR_SALE_SPIKE_MIN_PCT = 10;
const ONE_HOUR_SALE_SPIKE_MAX_PCT = 20;
const THREE_HOUR_SALE_SPIKE_MARGIN_SCALE = 0.4;
const THREE_HOUR_SALE_SPIKE_MIN_PCT = 8;
const THREE_HOUR_SALE_SPIKE_MAX_PCT = 15;

const determineSalePriceSpike = (itemData) => {
    // Margin percentage based on the final profit margin (after lowball, tax, buffer).
    const marginPct = itemData.purchasePrice > 0
        ? (itemData.profitMargin / itemData.purchasePrice) * 100
        : 0;

    const maxSpikePct1h = Math.min(
        ONE_HOUR_SALE_SPIKE_MAX_PCT,
        Math.max(ONE_HOUR_SALE_SPIKE_MIN_PCT, marginPct * ONE_HOUR_SALE_SPIKE_MARGIN_SCALE)
    );
    const maxSpikePct3h = Math.min(
        THREE_HOUR_SALE_SPIKE_MAX_PCT,
        Math.max(THREE_HOUR_SALE_SPIKE_MIN_PCT, marginPct * THREE_HOUR_SALE_SPIKE_MARGIN_SCALE)
    );

    // Convert percentage thresholds to multipliers (1 + pct/100).
    const maxMultiplier1h = 1 + (maxSpikePct1h / 100);
    const maxMultiplier3h = 1 + (maxSpikePct3h / 100);

    if (itemData.oneHourSalePrice && itemData.oneHourSalePrice > (itemData.sevenDayAverageHourlySalePrice * maxMultiplier1h)) {
        salePriceSpikeFiltered++;
        return false;
    } else if (itemData.threeHourAverageHourlySalePrice > (itemData.sevenDayAverageHourlySalePrice * maxMultiplier3h)) {
        salePriceSpikeFiltered++;
        return false;
    }
    return true;
};

const ONE_HOUR_VS_SEVEN_DAY_PRICE_DROP_MIN_MULTIPLIER = 0.92; // Filters items whose 1h price is <95% of the 7 day price
const THREE_HOUR_PRICE_DROP_MIN_MULTIPLIER = 0.9; // 
const determinePurchasePriceDrop = (itemData) => {
    if (itemData.oneHourPurchasePrice && itemData.oneHourPurchasePrice < (itemData.sevenDayAverageHourlyPurchasePrice * ONE_HOUR_VS_SEVEN_DAY_PRICE_DROP_MIN_MULTIPLIER)) {
        purchasePriceDropFiltered++;
        return false;
    } else if (itemData.threeHourAverageHourlyPurchasePrice < (itemData.sevenDayAverageHourlyPurchasePrice * THREE_HOUR_PRICE_DROP_MIN_MULTIPLIER)) {
        purchasePriceDropFiltered++;
        return false;
    }
    return true;
};

const calculateMaxProfitPerSlotHour = (itemData) => {
    itemData.maxProfitPerSlotHour = Math.min(itemData.threeHourAverageHourlyVolume, itemData.limit) * itemData.profitMargin;
    if (itemData.maxProfitPerSlotHour < PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD) {
        profitPerSlotHourFiltered++;
        return false;
    }
    return true;
};

// --- Helpers for iterative allocation ----------------------------------------

const computeQuantityForAllocation = (itemData, cashAllocation) => {
    if (!itemData.purchasePrice || itemData.purchasePrice <= 0) return 0;
    return Math.min(
        Math.floor(cashAllocation / itemData.purchasePrice),
        itemData.limit,
        Math.floor(itemData.threeHourAverageHourlyVolume)
    );
};

const computeEtasForQuantity = (itemData, quantity) => {
    // Lowball reduces the effective buy volume: a buy offer below market
    // only captures the portion of trades that happen at or below the
    // lowballed price. Conservative factor: 1.5x the lowball %.
    const lowballVolumeFactor = 1 - ((itemData.lowballPercent || 0) * 1.5 / 100);
    const effectivePurchaseVolume = Math.min(
        itemData.twoHourAverageHourlyPurchaseVolume * (1 - TWO_HOUR_VOLUME_BUFFER_PERCENTAGE / 100),
        itemData.oneHourPurchaseVolume
    ) * (MARKET_SHARE_ASSUMPTION_PERCENTAGE / 100) * lowballVolumeFactor;
    const effectiveSaleVolume = Math.min(
        itemData.twoHourAverageHourlySaleVolume * (1 - TWO_HOUR_VOLUME_BUFFER_PERCENTAGE / 100),
        itemData.oneHourSaleVolume
    ) * (MARKET_SHARE_ASSUMPTION_PERCENTAGE / 100);
    if (effectivePurchaseVolume <= 0 || effectiveSaleVolume <= 0) return null;

    const purchaseEtaMinutes = quantity / (effectivePurchaseVolume / 60);
    const saleEtaMinutes = quantity / (effectiveSaleVolume / 60);
    const turnoverEtaMinutes = purchaseEtaMinutes + saleEtaMinutes;
    return { purchaseEtaMinutes, saleEtaMinutes, turnoverEtaMinutes };
};

const computeProfitabilityForQuantity = (itemData, quantity, turnoverEtaMinutes) => {
    if (!quantity || quantity <= 0 || !turnoverEtaMinutes || turnoverEtaMinutes <= 0) return 0;
    return (quantity * itemData.profitMargin) * (60 / turnoverEtaMinutes);
};

const getTurnoverCap = (turnoverEtaMinutes) => {
    if (turnoverEtaMinutes < 30) return CASH_STACK * 0.8;
    if (turnoverEtaMinutes < 90) return CASH_STACK * 0.5;
    return CASH_STACK * 0.25;
};

// --- Cash allocation (iterative, turnover-aware) -----------------------------

const calculateSlotCashAllocation = (itemData, averageActualProfitPerSlotHour) => {
    // Base allocation is the per-slot target, but we must be able to afford at
    // least one unit so expensive items can still be considered.
    const baseAllocation = Math.max(AVERAGE_SLOT_CASH_STACK_ALLOCATION, itemData.purchasePrice);

    // Compute actual profit per slot hour at the base allocation. Because
    // actualProfitPerSlotHour is independent of quantity (it depends only on
    // profit margin and effective hourly volume), this value is stable for the
    // item once quantity >= 1.
    const baseQuantity = computeQuantityForAllocation(itemData, baseAllocation);
    const baseEtas = computeEtasForQuantity(itemData, baseQuantity);
    const baseActualProfit = baseEtas
        ? computeProfitabilityForQuantity(itemData, baseQuantity, baseEtas.turnoverEtaMinutes)
        : 0;

    // Scale the base allocation by how this item's actual profit compares to
    // the average. Use a dampened scale (sqrt) to avoid runaway allocations.
    let scale = 1;
    if (averageActualProfitPerSlotHour > 0 && baseActualProfit > averageActualProfitPerSlotHour) {
        scale = Math.sqrt(baseActualProfit / averageActualProfitPerSlotHour);
    }

    // Iteratively refine allocation: allocation determines quantity, quantity
    // determines ETA, and ETA determines the turnover cap. The profit scale is
    // fixed (actualProfit is quantity-independent), so we converge on the
    // tightest turnover cap that still allows the scaled allocation.
    let allocation = baseAllocation;
    for (let i = 0; i < 5; i++) {
        const quantity = computeQuantityForAllocation(itemData, allocation);
        const etas = computeEtasForQuantity(itemData, quantity);
        if (!etas) break;
        const turnoverCap = getTurnoverCap(etas.turnoverEtaMinutes);
        const newAllocation = Math.min(baseAllocation * scale, turnoverCap, CASH_STACK);
        if (Math.abs(newAllocation - allocation) < 1000) break;
        allocation = newAllocation;
    }

    itemData.cashAllocation = Math.round(allocation);
};

const calculateQuantityToPurchase = (itemData) => {
    itemData.quantityToPurchase = computeQuantityForAllocation(itemData, itemData.cashAllocation);
    itemData.totalPurchasePrice = itemData.purchasePrice * itemData.quantityToPurchase;

    if (itemData.quantityToPurchase < 1) {
        quantityToPurchaseFiltered++;
        return false;
    }
    return true;
};

const calculateEtas = (itemData) => {
    const etas = computeEtasForQuantity(itemData, itemData.quantityToPurchase);
    if (!etas) {
        etaVolumeLowFiltered++;
        return false;
    }

    itemData.purchaseEtaMinutes = etas.purchaseEtaMinutes;
    itemData.saleEtaMinutes = etas.saleEtaMinutes;
    itemData.turnoverEtaMinutes = etas.turnoverEtaMinutes;
    if (itemData.turnoverEtaMinutes > (MAX_TURNOVER_HOURS * 60)) {
        etaTurnoverFiltered++;
        return false;
    }
    return true;
};

const PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD = 20000 // Minimum profit per hour an item could make before being filtered
const ROI_MINIMUM_PERCENTAGE_THRESHOLD = 0.5; // Minimum R.O.I % — lowered from 1% so high-volume thin-margin items (e.g. Steel cannonball) that pass the profit-per-slot-hour gate aren't rejected by a proxy metric
const calculateProfitability = (itemData) => {
    if (!itemData.turnoverEtaMinutes || itemData.turnoverEtaMinutes <= 0) {
        actualProfitPerSlotHourFiltered++;
        return false;
    }
    itemData.actualProfitPerSlotHour = (itemData.quantityToPurchase * itemData.profitMargin) * (60 / itemData.turnoverEtaMinutes);
    if (itemData.actualProfitPerSlotHour < PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD) {
        actualProfitPerSlotHourFiltered++;
        return false;
    }
    itemData.returnOnInvestmentPercentage = (itemData.profitMargin / itemData.purchasePrice) * 100;
    if (itemData.returnOnInvestmentPercentage < ROI_MINIMUM_PERCENTAGE_THRESHOLD) {
        returnOnInvestmentFiltered++;
        return false;
    }
    itemData.totalProfit = itemData.profitMargin * itemData.quantityToPurchase;
    return true;
};

const determineLongTermCrash = async (itemData) => {
    try {
        // Check the per-item cache first. The 30d lookback window barely moves
        // between 3-minute cycles, so a cached entry younger than the TTL is
        // reused instead of hitting the v2 API.
        const cached = itemLongTermCrashData[itemData.itemId];
        let data;
        if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < LONG_TERM_CRASH_CACHE_TTL_MS) {
            data = cached.data;
        } else {
            const response = await fetchFromAPIV2(`timeseries?lookback=30d&id=${itemData.itemId}`);
            // Pace v2 calls so the Wiki load balancer doesn't drop connections
            // (ECONNABORTED) when many items need a fresh fetch in one run.
            await sleep(LONG_TERM_CRASH_FETCH_DELAY_MS);
            if (!response || !response.data || response.data.length === 0) {
                longTermCrashFiltered++;
                return false;
            }
            data = response.data;
            itemLongTermCrashData[itemData.itemId] = { fetchedAt: Date.now(), data };
        }

        if (!data || data.length === 0) {
            longTermCrashFiltered++;
            return false;
        }

        const prices = data.map(entry => entry.avgLowPrice ?? entry.avgHighPrice).filter(p => p != null && p > 0);

        if (prices.length < 10) {
            longTermCrashFiltered++;
            return false;
        }

        const midpoint = Math.floor(prices.length / 2);
        const earlyPrices = prices.slice(0, midpoint);

        // Sort early prices to find a stable high baseline (e.g., 90th percentile)
        earlyPrices.sort((a, b) => a - b);
        const p90Index = Math.floor(earlyPrices.length * 0.9);
        const highBaseline = earlyPrices[p90Index]; // Much safer than Math.max()

        // 2. Look at the very recent price (last 2 timestamps / last ~12 hours)
        const recentSlice = prices.slice(-2);
        const recentPrice = recentSlice.reduce((sum, p) => sum + p, 0) / recentSlice.length;

        // 3. If the recent price dropped more than 10% from its realistic high baseline
        const MAX_ALLOWED_DROP = 0.10; 
        if ((highBaseline - recentPrice) / highBaseline > MAX_ALLOWED_DROP) {
            longTermCrashFiltered++;
            return false;
        }
    } catch (err) {
        longTermCrashFiltered++;
        return false;
    }
    return true;
};

const determineFlipScore = () => {
    merchableItems.forEach(item => {
        const turnoverPenalty = Math.exp(-Math.pow(item.turnoverEtaMinutes / 30, 2));
        item.flipScore = item.actualProfitPerSlotHour * Math.log1p(item.returnOnInvestmentPercentage) * (1 - Math.min(item.totalPurchasePrice / CASH_STACK, 1)) * turnoverPenalty;
    });
    merchableItems.sort((a, b) => b.flipScore - a.flipScore);
};

async function getMerchableItems() {
    // Capture the fetch timestamp — all items in this run share the same
    // data fetch time. Used by the plugin to detect stale offer data
    // (e.g. when the game was updating or the wiki API was down).
    const dataFetchedAt = Date.now();
    const dataFetchedAtIso = new Date(dataFetchedAt).toISOString();

    await getPriceData();
    console.log('Starting Item Count:', Object.entries(oneHourPriceData).length)

    // Iterate one hour item data.
    let itemData = {};
    for (const [itemIdString, oneHourEntry] of Object.entries(oneHourPriceData)) {
        itemData = {
            itemId: Number(itemIdString),
            oneHourPurchasePrice: oneHourEntry.avgLowPrice,
            oneHourSalePrice: oneHourEntry.avgHighPrice,
            oneHourPurchaseVolume: oneHourEntry.lowPriceVolume || 0,
            oneHourSaleVolume: oneHourEntry.highPriceVolume || 0,
            oneHourAverageVolume: ((oneHourEntry.lowPriceVolume || 0) + (oneHourEntry.highPriceVolume || 0)) / 2,
            purchasePrice: oneHourEntry.avgLowPrice,
            rawSalePrice: oneHourEntry.avgHighPrice
        }

        // Add data from all API calls.
        if (!buildItemDataObject(itemData)) continue;

        // Exclude name strings.
        if (!excludeNameStrings(itemData)) continue;

        // Determine purchase and sale prices.
        if (!determinePurchaseAndSalePrices(itemData)) continue;

        // Determine 5 minute vs 1 hour purchases price change.
        if (!determineFiveMinuteVsOneHourPurchasePriceChange(itemData)) continue;

        // Determine 5 minute vs 1 hour sale price change.
        if (!determineFiveMinuteVsOneHourSalePriceChange(itemData)) continue;

        // Calculate price data if it exists.
        if (itemData.rawSalePrice && itemData.purchasePrice) {

            // Apply volume-scaled lowball to the buy price (first pass).
            // Uses 1h purchase volume as a proxy since 3h data isn't
            // available yet. This lets thin-margin high-volume items
            // survive the first-pass profit filter and reach the second
            // pass where the accurate 3h volume is used.
            applyLowball(itemData);

            // Calculate sale price.
            calculateSalePrice(itemData);

            // Calculate profitability.
            if (!calculateProfitMargin(itemData)) continue;
        }

        // Push to merchable items results.
        filteredItems.push(itemData);
    }

    // Get time series data
    await getTimeSeriesData();

    // Iterate filtered items with time series data and conver volume and price data.
    convertTimeSeriesData();

    // Iterate updated data with accurate volumes.
    for (const itemData of filteredItemsWithFullData) {

        // Validate purchase price.
        if (!validatePurchasePrice(itemData)) continue;

        // Validate sale price.
        if (!validateSalePrice(itemData)) continue;

        // Clamp prices 3 hour averages.
        clampPrices(itemData);

        // Apply volume-scaled lowball to the buy price (after clamping,
        // before tax/margin calculation so margins reflect the lowballed
        // buy price).
        applyLowball(itemData);

        // Calculate tax and sale buffer amount.
        calculateSalePrice(itemData);

        // Calculate profitability.
        if (!calculateProfitMargin(itemData)) continue;

        // Determine irregular volumes.
        if (!determineIrregularVolumes(itemData)) continue;

        // Determine trend slope for items slowly crashing in price.
        if (!determineTrendSlope(itemData)) continue;

        // Determine price spike.
        if (!determineSalePriceSpike(itemData)) continue;

        // Determine price drop.
        if (!determinePurchasePriceDrop(itemData)) continue;

        // Calculate profit per slot time.
        if (!calculateMaxProfitPerSlotHour(itemData)) continue;

        // Push to array.
        filteredItemsBeforeCashAllocation.push(itemData);
    };

    // First pass: compute actual profit per slot hour for each item at the base
    // allocation. This gives us an honest per-item baseline for scaling cash.
    // We use a parallel array rather than storing on itemData to avoid adding
    // extra fields to merchableItems.json.
    const baseActualProfits = [];
    for (const itemData of filteredItemsBeforeCashAllocation) {
        const baseAllocation = Math.max(AVERAGE_SLOT_CASH_STACK_ALLOCATION, itemData.purchasePrice);
        const baseQuantity = computeQuantityForAllocation(itemData, baseAllocation);
        const baseEtas = computeEtasForQuantity(itemData, baseQuantity);
        const baseActualProfit = baseEtas
            ? computeProfitabilityForQuantity(itemData, baseQuantity, baseEtas.turnoverEtaMinutes)
            : 0;
        baseActualProfits.push(baseActualProfit);
    }
    const averageActualProfitPerSlotHour = baseActualProfits.length > 0
        ? baseActualProfits.reduce((sum, p) => sum + p, 0) / baseActualProfits.length
        : 0;

    // Iterate items again.
    for (const itemData of filteredItemsBeforeCashAllocation) {

        // Calculate slot cash allocation (iterative, turnover-aware).
        calculateSlotCashAllocation(itemData, averageActualProfitPerSlotHour);

        // Calculate quantity to buy.
        if (!calculateQuantityToPurchase(itemData)) continue;

        // Calculate ETA's
        if (!calculateEtas(itemData)) continue;

        // Calculate profitability
        if (!calculateProfitability(itemData)) continue;

        // Determine if item is in a heavy multi-day downward spiral
        if (!await determineLongTermCrash(itemData)) continue;

        // Add the data fetch timestamp so the plugin can detect stale data.
        itemData.dataFetchedAt = dataFetchedAt;
        itemData.dataFetchedAtIso = dataFetchedAtIso;

        // Push to merchableItems.
        merchableItems.push(itemData);
    };

    // Determine sorting for most flippable items to be at the top.
    determineFlipScore();

    // Persist the 30d crash cache so subsequent runs can reuse it instead of
    // re-fetching every item every cycle. Saved regardless of whether any items
    // survived to merchableItems, since the cache work is valuable either way.
    await fs.writeFile('item_long_term_crash_data.json', JSON.stringify(itemLongTermCrashData, null, 2), 'utf-8');

    // If no items were found, preserve the existing file rather than wiping
    // it. This handles cases where the wiki API is down or the game is
    // updating — the plugin can still use the previous run's data (subject
    // to the 10-minute staleness check in merchable-items.ts).
    if (merchableItems.length === 0) {
        console.log(`${'\x1b[33m'}WARNING: 0 merchable items found — preserving existing merchableItems.json${'\x1b[0m'}`);
        console.log('-------------------------------------------------------------------------------------------------------------------------------------------------------------');
        return;
    }

    // Write to JSON file.
    await fs.writeFile('merchableItems.json', JSON.stringify(merchableItems, null, 2), 'utf-8');

    // Write priceHistory.json — a lightweight fallback price lookup for
    // items that end up in inventory but aren't in merchableItems.json or
    // the offer cache (e.g. after a long script stop or a JSON refresh
    // during sleep). Uses the 1h average prices already fetched above —
    // no extra API calls. Written every run regardless of merchableItems
    // count, since the 1h data is always available.
    const priceHistory = {};
    for (const [itemIdString, oneHourEntry] of Object.entries(oneHourPriceData)) {
        const mapping = mappingItemData.get(Number(itemIdString));
        if (!mapping || !mapping.name) continue;
        if (!oneHourEntry.avgLowPrice || !oneHourEntry.avgHighPrice) continue;
        priceHistory[itemIdString] = {
            name: mapping.name,
            buy: oneHourEntry.avgLowPrice,
            sell: oneHourEntry.avgHighPrice,
            fetchedAt: dataFetchedAt,
        };
    }
    await fs.writeFile('priceHistory.json', JSON.stringify(priceHistory, null, 2), 'utf-8');

    console.log('-------------------------------------------------------------------------------------------------------------------------------------------------------------');
    if (debug) {
        console.log('mappingEntryFiltered', mappingEntryFiltered);
        console.log('twentyFourHourEntryFiltered', twentyFourHourEntryFiltered);
        console.log('itemNameFiltered', itemNameFiltered);
        console.log('purchasePriceExceedsCashStackFiltered', purchasePriceExceedsCashStackFiltered);
        console.log('fiveMinuteVsOneHourPurchasePriceChangeFiltered', fiveMinuteVsOneHourPurchasePriceChangeFiltered);
        console.log('fiveMinuteVsOneHourSalePriceChangeFiltered', fiveMinuteVsOneHourSalePriceChangeFiltered);
        console.log('profitMarginFiltered', profitMarginFiltered);
        console.log('limitProfitPerFlipFiltered', limitProfitPerFlipFiltered);
        console.log('timeSeriesDataFiltered', timeSeriesDataFiltered);
        console.log('threeHourDataFiltered', threeHourDataFiltered);
        console.log('trendSlopeFiltered', trendSlopeFiltered);
        console.log('salePriceSpikeFiltered', salePriceSpikeFiltered);
        console.log('purchasePriceDropFiltered', purchasePriceDropFiltered);
        console.log('purchasePriceNotAvailableFiltered', purchasePriceNotAvailableFiltered);
        console.log('validatedPurchasePriceExceedsCashStack', validatedPurchasePriceExceedsCashStack);
        console.log('salePriceNotAvailableFiltered', salePriceNotAvailableFiltered);
        console.log('irregularVolumesFiltered', irregularVolumesFiltered);
        console.log('profitPerSlotHourFiltered', profitPerSlotHourFiltered);
        console.log('quantityToPurchaseFiltered', quantityToPurchaseFiltered);
        console.log('etaVolumeLowFiltered', etaVolumeLowFiltered);
        console.log('etaTurnoverFiltered', etaTurnoverFiltered);
        console.log('actualProfitPerSlotHourFiltered', actualProfitPerSlotHourFiltered);
        console.log('returnOnInvestmentFiltered', returnOnInvestmentFiltered);
        console.log('longTermCrashFiltered', longTermCrashFiltered);
    }
    console.log('Ending Result Count:', merchableItems.length);

    const bold = `\x1b[1m`;
    const normal = `\x1b[0m`;
    const green = `\x1b[32m`;
    const yellow = `\x1b[33m`;
    const magenta = `\x1b[35m`;
    const cyan = `\x1b[36m`;
    const white = `\x1b[37m`;

    console.log('-------------------------------------------------------------------------------------------------------------------------------------------------------------');
    for (const itemData of merchableItems.slice(0, MAX_RESULTS)) {
        // console.log(JSON.stringify(itemData))
        console.log(
            `${white}[${itemData.itemName.toUpperCase()}]${normal} | ` +
            // `${white}[${itemData.itemName.toUpperCase()}]${normal} ${yellow}[${itemData.itemId}]${normal} | ${bold}LIMIT:${normal} ${green}[${itemData.limit}]${normal} | ` +
            `${bold}BUY:${normal} ${cyan}${itemData.quantityToPurchase}${normal} ${green}[${itemData.purchasePrice.toLocaleString()}gp]${normal} ${yellow}(${(itemData.totalPurchasePrice).toLocaleString()}gp)${normal} | ` +
            `${bold}SELL:${normal} ${green}[${itemData.salePrice.toLocaleString()}gp]${normal} | ` +
            `${bold}PROFIT:${normal} ${green}[${itemData.profitMargin.toLocaleString()}gp]${normal} | ` +
            `${bold}TOTAL PROFIT:${normal} ${green}[${(itemData.totalProfit).toLocaleString()}gp]${normal} | ` +
            `${bold}PROFIT/HR:${normal} ${green}[${Math.round(itemData.actualProfitPerSlotHour).toLocaleString()}gp]${normal} | ` +
            `${bold}ROI:${normal} ${green}[${Number(itemData.returnOnInvestmentPercentage.toFixed(2))}%]${normal} | ` +
            `${bold}BUY ETA:${normal} ${green}[${formatEta(itemData.purchaseEtaMinutes)}]${normal} | ` +
            `${bold}SELL ETA:${normal} ${green}[${formatEta(itemData.saleEtaMinutes)}]${normal} | ` +
            `${bold}TURNOVER ETA:${normal} ${green}[${formatEta(itemData.turnoverEtaMinutes)}]${normal}`
        );
    }
    console.log('-------------------------------------------------------------------------------------------------------------------------------------------------------------');
    console.log(`Last run: ${new Date().toLocaleString()}`);
}

const clampPrice = (price, average, percent = 0.05, absolute = 50000) => {
    if (!Number.isFinite(price) || !Number.isFinite(average)) return price;
    const percentUpper = average * (1 + percent);
    const absoluteUpper = average + absolute;
    const upper = Math.min(percentUpper, absoluteUpper);
    return Math.round(Math.min(price, upper));
};

const percentageDifference = (a, b) => ((b - a) / b) * 100;

const formatEta = (minutesFloat) => {
    const totalSeconds = Math.ceil(minutesFloat * 60);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    // if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    return parts.join(' ');
};

getMerchableItems();
