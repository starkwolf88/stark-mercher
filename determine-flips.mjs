import { promises as fs } from 'fs';

const debug = false;
const F2P_MODE = process.argv.includes('--f2p');
const MAX_RESULTS = 100; // Maximum number of merchable items to output after sorting by profitability
const GE_TAX_PERCENTAGE = 2; // Grand Exchange sale tax percentage deducted from sell price
const CASH_STACK_MILLIONS = 50; // Total flipping cash in millions for readability
const CASH_STACK = CASH_STACK_MILLIONS * 1000000; // Total GP available for flipping
const SALE_BUFFER_RATIO = 0.05; // Sell undercut: 5% of post-tax margin (margin after 2% GE tax). Makes the initial sell price competitive so items sell in 1-2 attempts instead of cycling through revisions. Can never filter items by itself (buffer <= post-tax margin). Thin-margin items (post-tax < 20gp) get 0.
const AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO = 0.125; // Percentage of total cash assumed to be used per GE slot (~8 slots)
const AVERAGE_SLOT_CASH_STACK_ALLOCATION = CASH_STACK * AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO; // Average GP allocated per GE slot
const MARKET_SHARE_ASSUMPTION_PERCENTAGE = 50; // calculateEtas() Assume 50% market share to estimate ETAs and profit/hr. Raised from 35% — the 35% assumption understated profit/hr by ~2×, filtering out items that genuinely earn 30-40k/hr at realistic capture rates. 50% is still conservative (the 15% volume buffer on top gives effective 42.5% assumed capture).
const MAX_TURNOVER_HOURS = 6; // calculateEtas() Maximum allowed turnover ETA at 50m allocation (secondary sanity check — primary gate is actualProfitPerSlotHour)
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

// --- F2P curated flip list --------------------------------------------------
// High-volume F2P items that are merchable with a fixed 1gp margin. These
// bypass the normal filter pipeline entirely — the pipeline uses the same
// API data but applies a simple formula: buy at (sell - tax - 1), capped at
// (5m low - 1) to avoid buying at market when the 1h avgHigh lags a downward
// move. Sell at the 1h avgHigh. Output goes to f2pMerchableItems.json
// (separate from merchableItems.json) so the runtime can switch between P2P
// and F2P pools. Items are chosen by 1h volume (all >100k/hr) and price range
// (25-200gp where a 1gp margin is viable after 2% GE tax).
const F2P_CURATED_ITEM_IDS = new Set([
    562,    // Chaos rune   — ~934k vol/hr, 18k limit
    560,    // Death rune   — ~811k vol/hr, 25k limit
    561,    // Nature rune  — ~446k vol/hr, 18k limit
    453,    // Coal         — ~387k vol/hr, 13k limit
    564,    // Cosmic rune  — ~315k vol/hr, 18k limit
    563,    // Law rune     — ~269k vol/hr, 18k limit
    444,    // Gold ore     — ~256k vol/hr, 30k limit
    890,    // Adamant arrow— ~148k vol/hr, 11k limit (no tax, <50gp)
    1987,   // Grapes       — ~116k vol/hr, 20k limit
    1515,   // Yew logs     — ~115k vol/hr, 12k limit
]);
const F2P_FIXED_MARGIN = 1; // 1gp profit per unit after tax
const F2P_SPIKE_DEVIATION_THRESHOLD = 0.10; // Skip if 5m avgHigh deviates >10% from 1h avgHigh
let f2pMerchableItems = [];

// F2P pre-filter items — collected before any filters apply, used only when
// --f2p flag is passed. Captures every F2P item with valid 5m/1h prices so we
// can see the raw after-tax margin distribution and build a curated F2P list.
let f2pPreFilterItems = [];

// F2P filter reason tracking — records which pipeline filter removed each F2P
// item. Used to populate the "Filtered By" column in the F2P CSV output.
const f2pFilterReason = new Map();
const recordF2pFilter = (itemData, reason) => {
    if (F2P_MODE && !itemData.members) f2pFilterReason.set(itemData.itemId, reason);
};

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
let purchasePriceSpikeFiltered = 0; // determinePurchasePriceSpike()
let purchasePriceDropFiltered = 0; // determinePurchasePriceDrop()
let profitPerSlotHourFiltered = 0; // calculateMaxProfitPerSlotHour()
let quantityToPurchaseFiltered = 0 // calculateQuantityToPurchase()
let etaVolumeLowFiltered = 0; // calculateEtas()
let etaTurnoverFiltered = 0; // calculateEtas()
let actualProfitPerSlotHourFiltered = 0; // calculateProfitability()
let returnOnInvestmentFiltered = 0; // calculateProfitability()
let taxAwareMarginFiltered = 0; // calculateProfitability() — high-value items failing tax floor or ETA-scaled margin % guard
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
        recordF2pFilter(itemData, 'Name exclusion');
        return false;
    }
    return true;
};

const determinePurchaseAndSalePrices = (itemData) => {
    if (itemData.fiveMinutePurchasePrice && itemData.fiveMinuteSalePrice) {
        itemData.purchasePrice = itemData.fiveMinutePurchasePrice;
        itemData.rawSalePrice = itemData.fiveMinuteSalePrice;
    }
    // Filter out items that cost more than the simulation cash stack.
    // This is the "pool width dial": lower cash stack = fewer items
    // (only affordable items), higher cash stack = more items (expensive
    // items included). The plugin then evaluates each item at runtime
    // based on the player's actual coins.
    if (itemData.purchasePrice > CASH_STACK) {
        purchasePriceExceedsCashStackFiltered++;
        recordF2pFilter(itemData, 'Price > 50m cash stack');
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
    // Sell buffer: 5% of post-tax margin (margin remaining after 2% GE tax).
    // This directly measures what's available and can never make an item
    // negative by itself. Thin-margin items (post-tax margin < 20gp) get 0
    // buffer (same as before); thick-margin items get a meaningful undercut
    // so they sell in 1-2 attempts instead of cycling through revisions.
    const postTaxMargin = Math.max(0, (itemData.rawSalePrice || 0) - itemData.saleTaxAmount - (itemData.purchasePrice || 0));
    itemData.saleBufferAmount = Math.floor(postTaxMargin * SALE_BUFFER_RATIO);
    itemData.salePriceExcludingTax = Math.floor(itemData.rawSalePrice - itemData.saleTaxAmount);
    itemData.salePriceExcludingTaxAndBuffer = Math.floor(itemData.salePriceExcludingTax - itemData.saleBufferAmount);
    itemData.salePrice = Math.floor(itemData.rawSalePrice - itemData.saleBufferAmount);
};

const calculateProfitMargin = (itemData) => {
    itemData.profitMargin = Math.floor(itemData.salePriceExcludingTaxAndBuffer - itemData.purchasePrice);
    if (itemData.profitMargin < 1) {
        profitMarginFiltered++;
        recordF2pFilter(itemData, 'Profit margin < 1gp');
        return false;
    }
    if ((itemData.profitMargin * itemData.limit) < 10000) {
        limitProfitPerFlipFiltered++
        recordF2pFilter(itemData, 'Limit × profit < 10k');
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
                recordF2pFilter(itemData, 'Time series fetch failed');
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
            recordF2pFilter(itemData, 'No 3h average data');
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
                recordF2pFilter(itemData, 'No 2h/3h purchase price');
                return false;
            }
        }
    }
    // Filter out items that cost more than the simulation cash stack
    // (pool width dial — see determinePurchaseAndSalePrices).
    if (itemData.purchasePrice > CASH_STACK) {
        validatedPurchasePriceExceedsCashStack++;
        recordF2pFilter(itemData, 'Validated price > 50m cash stack');
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
                recordF2pFilter(itemData, 'No 2h/3h sale price');
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

// --- Competitive buffer (non-lowball items only) ---------------------------
// Non-lowball items buy at the 5m average low price (market price). Adding a
// small competitive buffer on top of the buy price ensures the offer fills
// reliably even if the market ticks up slightly between data refresh (every
// 3 min) and offer placement. The buffer is 5% of the gross margin, floored
// (no minimum), so thin-margin items (<20gp) are unaffected (0gp buffer) while
// thicker-margin items get a small upward nudge that costs ~5% of profit but
// significantly improves fill rates.
//
// Only applies to non-lowball items (lowballPercent === 0) — lowball items
// already buy below market by design and have their own fill-rate tradeoff.
//
// No idempotency concern: applyLowball() resets purchasePrice to
// lowballBasePrice before this runs in each pass, so the buffer always
// starts from the pre-buffer base price. The buffer is applied once per
// pass and does not stack.
const COMPETITIVE_BUFFER_RATIO = 0.05; // 5% of gross margin
const applyCompetitiveBuffer = (itemData) => {
    // Only apply to non-lowball items.
    if ((itemData.lowballPercent || 0) > 0) {
        itemData.competitiveBuffer = 0;
        return;
    }
    const basePrice = itemData.purchasePrice;
    const rawMargin = (itemData.rawSalePrice || 0) - basePrice;
    if (rawMargin <= 0) {
        itemData.competitiveBuffer = 0;
        return;
    }
    const buffer = Math.max(1, Math.floor(rawMargin * COMPETITIVE_BUFFER_RATIO));
    itemData.competitiveBuffer = buffer;
    itemData.purchasePrice = basePrice + buffer;
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
        recordF2pFilter(itemData, 'Irregular volumes');
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
        recordF2pFilter(itemData, 'Trend slope (crashing)');
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
        recordF2pFilter(itemData, 'Sale price spike (1h vs 7d)');
        return false;
    } else if (itemData.threeHourAverageHourlySalePrice > (itemData.sevenDayAverageHourlySalePrice * maxMultiplier3h)) {
        salePriceSpikeFiltered++;
        recordF2pFilter(itemData, 'Sale price spike (3h vs 7d)');
        return false;
    }
    return true;
};

// --- Purchase price spike filter (1h/3h vs 7d) -------------------------------
// Mirrors the sell-side spike filter but for the buy price. Catches sustained
// uptrends where the 1h or 3h average buy price is significantly above the
// 7-day baseline. Protects against buying at the top of a manipulation spike
// or a transient pump that is likely to revert (e.g. Ham robe at 69.83% above
// 7-day average, Dark kebbit fur at 22.10%, Antipoison(3) at 18.24%).
//
// Uses higher minimum thresholds than the sell-side spike filter (15% vs 10%
// for 1h, 12% vs 8% for 3h) because:
// (1) Normal market fluctuation regularly produces 5-10% moves above the
// 7-day average — these are often legitimate trends that continue and produce
// profit (e.g. Twinflame staff at 7.41% spike sold for +78,581gp profit).
// (2) The 5m-vs-1h clamp already handles transient 5-minute spikes.
// (3) Genuine manipulation spikes (Ham robe 69%, Dark kebbit fur 22%,
// Antipoison 18%) are well above 15% and are reliably caught.
// (4) Empirical analysis of merch history showed zero losses caused by
// purchase-price spikes — all losses were sell-side (price drops during
// holding, thin margins + GE tax).
//
//   maxSpikePct = clamp(marginPct * 0.5, 15, 25)
//
// Examples:
//   1% margin:   maxSpikePct = max(15, 0.5)  = 15%
//   20% margin:  maxSpikePct = max(15, 10)   = 15%
//   40% margin:  maxSpikePct = max(15, 20)   = 20%
//   50%+ margin: maxSpikePct = min(25, 25)   = 25%
const ONE_HOUR_PURCHASE_SPIKE_MARGIN_SCALE = 0.5;
const ONE_HOUR_PURCHASE_SPIKE_MIN_PCT = 15;
const ONE_HOUR_PURCHASE_SPIKE_MAX_PCT = 25;
const THREE_HOUR_PURCHASE_SPIKE_MARGIN_SCALE = 0.4;
const THREE_HOUR_PURCHASE_SPIKE_MIN_PCT = 12;
const THREE_HOUR_PURCHASE_SPIKE_MAX_PCT = 20;

const determinePurchasePriceSpike = (itemData) => {
    const marginPct = itemData.purchasePrice > 0
        ? (itemData.profitMargin / itemData.purchasePrice) * 100
        : 0;

    const maxSpikePct1h = Math.min(
        ONE_HOUR_PURCHASE_SPIKE_MAX_PCT,
        Math.max(ONE_HOUR_PURCHASE_SPIKE_MIN_PCT, marginPct * ONE_HOUR_PURCHASE_SPIKE_MARGIN_SCALE)
    );
    const maxSpikePct3h = Math.min(
        THREE_HOUR_PURCHASE_SPIKE_MAX_PCT,
        Math.max(THREE_HOUR_PURCHASE_SPIKE_MIN_PCT, marginPct * THREE_HOUR_PURCHASE_SPIKE_MARGIN_SCALE)
    );

    const maxMultiplier1h = 1 + (maxSpikePct1h / 100);
    const maxMultiplier3h = 1 + (maxSpikePct3h / 100);

    if (itemData.oneHourPurchasePrice && itemData.oneHourPurchasePrice > (itemData.sevenDayAverageHourlyPurchasePrice * maxMultiplier1h)) {
        purchasePriceSpikeFiltered++;
        recordF2pFilter(itemData, 'Purchase price spike (1h vs 7d)');
        return false;
    } else if (itemData.threeHourAverageHourlyPurchasePrice > (itemData.sevenDayAverageHourlyPurchasePrice * maxMultiplier3h)) {
        purchasePriceSpikeFiltered++;
        recordF2pFilter(itemData, 'Purchase price spike (3h vs 7d)');
        return false;
    }
    return true;
};

const ONE_HOUR_VS_SEVEN_DAY_PRICE_DROP_MIN_MULTIPLIER = 0.92; // Filters items whose 1h price is <95% of the 7 day price
const THREE_HOUR_PRICE_DROP_MIN_MULTIPLIER = 0.9; // 
const determinePurchasePriceDrop = (itemData) => {
    if (itemData.oneHourPurchasePrice && itemData.oneHourPurchasePrice < (itemData.sevenDayAverageHourlyPurchasePrice * ONE_HOUR_VS_SEVEN_DAY_PRICE_DROP_MIN_MULTIPLIER)) {
        purchasePriceDropFiltered++;
        recordF2pFilter(itemData, 'Purchase price drop (1h vs 7d)');
        return false;
    } else if (itemData.threeHourAverageHourlyPurchasePrice < (itemData.sevenDayAverageHourlyPurchasePrice * THREE_HOUR_PRICE_DROP_MIN_MULTIPLIER)) {
        purchasePriceDropFiltered++;
        recordF2pFilter(itemData, 'Purchase price drop (3h vs 7d)');
        return false;
    }
    return true;
};

const calculateMaxProfitPerSlotHour = (itemData) => {
    // Apply the lowball volume factor so lowballed items (which fill slower)
    // are correctly filtered and ranked. Without this, lowballed items appear
    // as profitable as their non-lowballed counterparts despite filling slower,
    // inflating their flipScore and passing the profit-per-slot-hour filter
    // when they shouldn't. Uses the same 4.0x factor as computeEtasForQuantity.
    const lowballVolumeFactor = 1 - ((itemData.lowballPercent || 0) * 4.0 / 100);
    const effectiveVolume = Math.min(itemData.threeHourAverageHourlyVolume, itemData.limit) * lowballVolumeFactor;
    itemData.maxProfitPerSlotHour = effectiveVolume * itemData.profitMargin;
    if (itemData.maxProfitPerSlotHour < PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD) {
        profitPerSlotHourFiltered++;
        recordF2pFilter(itemData, 'Profit/slot-hr < 20k');
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
    // lowballed price. Factor: 4.0x the lowball % (e.g. 2% lowball → 8%
    // volume reduction). Increased from 2.0x — lowball offers fill
    // significantly slower than the 2.0x factor predicted, causing offers
    // to sit at 0% progress well past their predicted ETA.
    const lowballVolumeFactor = 1 - ((itemData.lowballPercent || 0) * 4.0 / 100);
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
        recordF2pFilter(itemData, 'Quantity < 1');
        return false;
    }
    return true;
};

const calculateEtas = (itemData) => {
    const etas = computeEtasForQuantity(itemData, itemData.quantityToPurchase);
    if (!etas) {
        etaVolumeLowFiltered++;
        recordF2pFilter(itemData, 'ETA volume too low');
        return false;
    }

    itemData.purchaseEtaMinutes = etas.purchaseEtaMinutes;
    itemData.saleEtaMinutes = etas.saleEtaMinutes;
    itemData.turnoverEtaMinutes = etas.turnoverEtaMinutes;
    // Secondary sanity check: reject items with absurdly long turnover ETAs
    // at the 50m allocation. The primary quality gate is the
    // actualProfitPerSlotHour filter in calculateProfitability(), which is
    // quantity-independent and catches items like Games necklace(8) at
    // 2,749gp/hr. This turnover cap is a backstop for edge cases where the
    // profit/hr calculation might not catch a pathologically slow item.
    // At 6h (360 min), this doesn't filter any legitimate items — the
    // maximum turnover for an item passing the 20k profit/hr filter is
    // ~4h (quantity capped at 1h volume, 50% market share assumption).
    if (etas.turnoverEtaMinutes > MAX_TURNOVER_HOURS * 60) {
        etaTurnoverFiltered++;
        recordF2pFilter(itemData, 'Turnover ETA > 6h');
        return false;
    }
    return true;
};

const PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD = 20000 // Minimum profit per hour an item could make before being filtered
const ROI_MINIMUM_PERCENTAGE_THRESHOLD = 0.5; // Minimum R.O.I % — lowered from 1% so high-volume thin-margin items (e.g. Steel cannonball) that pass the profit-per-slot-hour gate aren't rejected by a proxy metric
// Tax-aware margin filter: for high-value items (> TAX_AWARE_PRICE_THRESHOLD),
// two independent conditions must pass:
//   1. Hard floor: margin >= tax (margin/tax >= 1.0). Blocks guaranteed-loss
//      items like Contract of Glyphic Attenuation (270k buy, 5.2k margin, 5.4k
//      tax, M/T 0.96x).
//   2. Price-movement guard: margin as a % of purchase price must exceed a
//      threshold scaled by expected sell time. This directly measures how much
//      the market can drift before the margin is wiped — unlike the old M/T
//      ratio which conflated tax coverage with price-movement buffer and
//      unfairly penalised high-priced items (a 20m item with 500k margin has
//      M/T 1.23x but M/P 2.5%, a healthy buffer). The ETA tiers are:
//        sell ETA < 30 min  → 0.5% (fast sale, minimal market exposure)
//        sell ETA 30-90 min → 1.0% (moderate exposure)
//        sell ETA > 90 min  → 1.5% (long exposure, more drift risk)
// Low-value items are exempt because their 1gp minimum price movement makes
// thin margins viable at high volume (e.g. Revenant ether at 1gp margin, 3gp
// tax, 143k gp/hr).
const TAX_AWARE_PRICE_THRESHOLD = 10000; // Only apply tax-aware filter to items above this price
const TAX_AWARE_MARGIN_TO_TAX_FLOOR = 1.0; // Hard floor: margin must cover tax (M/T >= 1.0)
const TAX_AWARE_MARGIN_PCT_SHORT_ETA = 0.5; // Min margin % for sell ETA < 30 min
const TAX_AWARE_MARGIN_PCT_MEDIUM_ETA = 1.0; // Min margin % for sell ETA 30-90 min
const TAX_AWARE_MARGIN_PCT_LONG_ETA = 1.5; // Min margin % for sell ETA > 90 min
const calculateProfitability = (itemData) => {
    if (!itemData.turnoverEtaMinutes || itemData.turnoverEtaMinutes <= 0) {
        actualProfitPerSlotHourFiltered++;
        recordF2pFilter(itemData, 'No turnover ETA');
        return false;
    }
    itemData.actualProfitPerSlotHour = (itemData.quantityToPurchase * itemData.profitMargin) * (60 / itemData.turnoverEtaMinutes);
    // Filter: actualProfitPerSlotHour must meet the minimum threshold.
    // This value is quantity-independent — the formula simplifies to
    // margin / (1/buyVol + 1/sellVol), so the quantity (and thus the cash
    // stack) cancels out. An item at 2,749gp/hr at 50m is also 2,749gp/hr
    // at 500k. The runtime plugin's RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM
    // (20,000gp/hr) would reject this item at every cash stack, so it
    // should never be in merchableItems.json. Filtering here at the same
    // threshold ensures the list only contains items the plugin would
    // actually buy under some cash-stack scenario.
    if (itemData.actualProfitPerSlotHour < PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD) {
        actualProfitPerSlotHourFiltered++;
        recordF2pFilter(itemData, 'Actual profit/hr < 20k');
        return false;
    }
    itemData.returnOnInvestmentPercentage = (itemData.profitMargin / itemData.purchasePrice) * 100;
    if (itemData.returnOnInvestmentPercentage < ROI_MINIMUM_PERCENTAGE_THRESHOLD) {
        returnOnInvestmentFiltered++;
        recordF2pFilter(itemData, 'ROI < 0.5%');
        return false;
    }
    // Tax-aware margin filter: high-value items must pass two independent
    // conditions — (1) margin covers tax (hard floor), and (2) margin as a
    // percentage of purchase price meets an ETA-scaled threshold (price-
    // movement guard). See the constant definitions above for full rationale.
    if (itemData.purchasePrice > TAX_AWARE_PRICE_THRESHOLD && itemData.saleTaxAmount > 0) {
        // Hard floor: margin must cover tax
        if (itemData.profitMargin < itemData.saleTaxAmount) {
            taxAwareMarginFiltered++;
            recordF2pFilter(itemData, 'Margin < GE tax');
            return false;
        }
        // Price-movement guard: margin % scaled by sell ETA
        const marginPct = (itemData.profitMargin / itemData.purchasePrice) * 100;
        const sellEtaMin = itemData.saleEtaMinutes || 60;
        const minMarginPct = sellEtaMin < 30
            ? TAX_AWARE_MARGIN_PCT_SHORT_ETA
            : sellEtaMin < 90
                ? TAX_AWARE_MARGIN_PCT_MEDIUM_ETA
                : TAX_AWARE_MARGIN_PCT_LONG_ETA;
        if (marginPct < minMarginPct) {
            taxAwareMarginFiltered++;
            recordF2pFilter(itemData, 'Margin % too low for ETA');
            return false;
        }
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
                recordF2pFilter(itemData, 'Long-term crash (fetch failed)');
                return false;
            }
            data = response.data;
            itemLongTermCrashData[itemData.itemId] = { fetchedAt: Date.now(), data };
        }

        if (!data || data.length === 0) {
            longTermCrashFiltered++;
            recordF2pFilter(itemData, 'Long-term crash (no data)');
            return false;
        }

        const prices = data.map(entry => entry.avgLowPrice ?? entry.avgHighPrice).filter(p => p != null && p > 0);

        if (prices.length < 10) {
            longTermCrashFiltered++;
            recordF2pFilter(itemData, 'Long-term crash (insufficient prices)');
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
            recordF2pFilter(itemData, 'Long-term crash (>10% drop)');
            return false;
        }
    } catch (err) {
        longTermCrashFiltered++;
        recordF2pFilter(itemData, 'Long-term crash (error)');
        return false;
    }
    return true;
};

const determineFlipScore = () => {
    // flipScore is fully cash-stack-independent. It ranks items by intrinsic
    // quality only — no simulation-era values (allocation, quantity, ETA) are
    // used. This means the ranking is identical regardless of what
    // CASH_STACK_MILLIONS is set to; only the item pool width changes.
    //
    // maxProfitPerSlotHour = min(3h volume, limit) * profitMargin — the
    // theoretical max profit per slot per hour. This already accounts for
    // volume (high-volume items move more units per hour), so a separate
    // turnover penalty is redundant and would introduce a cash-stack
    // dependency (via the simulation-era turnoverEtaMinutes).
    //
    // Math.log1p(ROI) favours higher-ROI items with diminishing returns.
    merchableItems.forEach(item => {
        item.flipScore = item.maxProfitPerSlotHour * Math.log1p(item.returnOnInvestmentPercentage);
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

        // F2P pre-filter capture: collect every F2P item with valid prices
        // before any filters apply. Used only when --f2p flag is passed.
        if (F2P_MODE && !itemData.members) {
            const f2pBuy = itemData.fiveMinutePurchasePrice || itemData.purchasePrice;
            const f2pSell = itemData.fiveMinuteSalePrice || itemData.rawSalePrice;
            if (f2pBuy && f2pSell) {
                const f2pTax = f2pSell < GE_TAX_EXEMPTION_THRESHOLD ? 0 : Math.floor((f2pSell / 100) * GE_TAX_PERCENTAGE);
                f2pPreFilterItems.push({
                    itemName: itemData.itemName,
                    itemId: itemData.itemId,
                    buyPrice: f2pBuy,
                    sellPrice: f2pSell,
                    margin: f2pSell - f2pTax - f2pBuy,
                    limit: itemData.limit,
                    oneHourVolume: (itemData.oneHourPurchaseVolume || 0) + (itemData.oneHourSaleVolume || 0),
                });
            }
        }

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

            // Calculate sale price at market buy price (no lowball yet).
            calculateSalePrice(itemData);

            // Try profit margin at market price first.
            if (calculateProfitMargin(itemData)) {
                // Passed at market price — apply competitive buffer to
                // improve fill rates (5% of margin, floored).
                applyCompetitiveBuffer(itemData);
                // Recalculate profit margin with the buffered buy price.
                calculateProfitMargin(itemData);
            } else {
                // Failed at market price — try lowball as a fallback to
                // create margin. Uses 1h purchase volume as a proxy since
                // 3h data isn't available yet. Only high-volume items with
                // thick enough spreads will get a lowball; the rest are
                // filtered out here.
                applyLowball(itemData);
                if (!calculateProfitMargin(itemData)) continue;
                // No competitive buffer on lowball items — they already
                // buy below market by design.
            }
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

        // Clamp prices to 2h averages.
        clampPrices(itemData);

        // Reset purchase price to the pre-lowball market price so we can
        // try at market price first. clampPrices already clamped
        // lowballBasePrice to the 2h average, so this is the clamped
        // market price.
        itemData.purchasePrice = itemData.lowballBasePrice ?? itemData.purchasePrice;

        // Calculate tax and sale buffer amount at market buy price.
        calculateSalePrice(itemData);

        // Try profit margin at market price first.
        if (calculateProfitMargin(itemData)) {
            // Passed at market price — apply competitive buffer to
            // improve fill rates (5% of margin, floored).
            applyCompetitiveBuffer(itemData);
            // Recalculate profit margin with the buffered buy price.
            calculateProfitMargin(itemData);
        } else {
            // Failed at market price — try lowball as a fallback to
            // create margin. Uses accurate 3h volume now available.
            applyLowball(itemData);
            if (!calculateProfitMargin(itemData)) continue;
        }

        // Determine irregular volumes.
        if (!determineIrregularVolumes(itemData)) continue;

        // Determine trend slope for items slowly crashing in price.
        if (!determineTrendSlope(itemData)) continue;

        // Determine price spike.
        if (!determineSalePriceSpike(itemData)) continue;

        // Determine purchase price spike (sustained uptrend on buy side).
        if (!determinePurchasePriceSpike(itemData)) continue;

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

    // --- F2P curated flip processing ----------------------------------------
    // Uses the same API data fetched above. For each curated F2P item:
    //   sellPrice = 1h avgHigh
    //   buyPrice  = sellPrice - tax - 1gp (fixed margin), capped at (5m low - 1)
    // The 5m cap prevents buying at or above the current market when the 1h
    // avgHigh lags a downward market move (would cause an instant fill at
    // market price instead of a lowball). Bypasses the normal filter pipeline
    // entirely. Output goes to a separate f2pMerchableItems.json so the
    // runtime can switch pools.
    f2pMerchableItems = [];
    for (const itemId of F2P_CURATED_ITEM_IDS) {
        const oneHourEntry = oneHourPriceData[itemId];
        if (!oneHourEntry || !oneHourEntry.avgHighPrice) continue;
        const mapping = mappingItemData.get(itemId);
        if (!mapping || !mapping.name) continue;

        const sellPrice = oneHourEntry.avgHighPrice;
        const oneHourPurchaseVolume = oneHourEntry.lowPriceVolume || 0;
        const oneHourSaleVolume = oneHourEntry.highPriceVolume || 0;

        // 5m sanity check — skip if 5m avgHigh deviates >10% from 1h (spiking).
        const fiveMinuteEntry = fiveMinuteDataMap.get(itemId);
        const fiveMinuteSalePrice = fiveMinuteEntry?.avgHighPrice;
        if (fiveMinuteSalePrice && Math.abs(fiveMinuteSalePrice - sellPrice) / sellPrice > F2P_SPIKE_DEVIATION_THRESHOLD) {
            continue;
        }

        const tax = sellPrice < GE_TAX_EXEMPTION_THRESHOLD ? 0 : Math.floor((sellPrice / 100) * GE_TAX_PERCENTAGE);
        let purchasePrice = sellPrice - tax - F2P_FIXED_MARGIN;

        // 5m market check — don't buy at or above the current market low.
        // The 1h avgHigh can lag the current market: when the market has
        // moved down since the 1h average was computed, the formula above
        // produces a buy price at or above the current 5m low, causing an
        // instant fill at market price (not a lowball). Cap the buy price
        // at (5m low - 1) so the bot always lowballs below the current
        // market. If the capped price leaves no margin, skip the item.
        const fiveMinuteMarketLow = fiveMinuteEntry?.avgLowPrice;
        if (fiveMinuteMarketLow && purchasePrice >= fiveMinuteMarketLow) {
            purchasePrice = fiveMinuteMarketLow - 1;
        }
        if (purchasePrice < 1) continue;

        const oneHourPurchasePrice = oneHourEntry.avgLowPrice;
        const fiveMinutePurchasePrice = fiveMinuteEntry?.avgLowPrice;
        const fiveMinutePurchaseVolume = fiveMinuteEntry?.lowPriceVolume || 0;
        const fiveMinuteSaleVolume = fiveMinuteEntry?.highPriceVolume || 0;
        const twentyFourHourEntry = twentyFourHourDataMap.get(itemId);
        const twentyFourHourAvgLowPrice = twentyFourHourEntry?.avgLowPrice;

        const limit = mapping.limit || 0;
        const quantityToPurchase = limit;
        const totalPurchasePrice = purchasePrice * quantityToPurchase;
        const profitMargin = (sellPrice - tax) - purchasePrice;
        const totalProfit = profitMargin * quantityToPurchase;

        // Build the full item object with all fields the runtime expects.
        // Volume fields use 1h data as a proxy for 2h/3h (no time series fetch).
        const item = {
            itemId,
            itemName: mapping.name,
            members: false,
            limit,
            purchasePrice,
            rawSalePrice: sellPrice,
            salePrice: sellPrice,
            saleTaxAmount: tax,
            saleBufferAmount: 0,
            salePriceExcludingTax: sellPrice - tax,
            salePriceExcludingTaxAndBuffer: sellPrice - tax,
            profitMargin,
            competitiveBuffer: 0,
            lowballPercent: 0,
            lowballAmount: 0,
            lowballBasePrice: purchasePrice,
            oneHourPurchasePrice,
            oneHourSalePrice: sellPrice,
            oneHourPurchaseVolume,
            oneHourSaleVolume,
            oneHourAverageVolume: (oneHourPurchaseVolume + oneHourSaleVolume) / 2,
            fiveMinutePurchasePrice,
            fiveMinuteSalePrice,
            fiveMinutePurchaseVolume,
            fiveMinuteSaleVolume,
            twentyFourHourAvgLowPrice,
            // No time series — use 1h as proxy for 2h/3h.
            twoHourAverageHourlyPurchaseVolume: oneHourPurchaseVolume,
            twoHourAverageHourlySaleVolume: oneHourSaleVolume,
            twoHourAverageHourlyVolume: (oneHourPurchaseVolume + oneHourSaleVolume) / 2,
            threeHourAverageHourlyPurchaseVolume: oneHourPurchaseVolume,
            threeHourAverageHourlySaleVolume: oneHourSaleVolume,
            threeHourAverageHourlyVolume: (oneHourPurchaseVolume + oneHourSaleVolume) / 2,
            quantityToPurchase,
            cashAllocation: totalPurchasePrice,
            totalPurchasePrice,
            totalProfit,
            dataFetchedAt,
            dataFetchedAtIso,
        };

        // Calculate ETAs using the same formula as the main pipeline.
        const etas = computeEtasForQuantity(item, quantityToPurchase);
        if (!etas) continue;
        item.purchaseEtaMinutes = etas.purchaseEtaMinutes;
        item.saleEtaMinutes = etas.saleEtaMinutes;
        item.turnoverEtaMinutes = etas.turnoverEtaMinutes;

        // Profit metrics.
        item.maxProfitPerSlotHour = Math.min(item.threeHourAverageHourlyVolume, limit) * profitMargin;
        item.actualProfitPerSlotHour = (quantityToPurchase * profitMargin) * (60 / etas.turnoverEtaMinutes);
        item.returnOnInvestmentPercentage = (profitMargin / purchasePrice) * 100;
        item.flipScore = item.maxProfitPerSlotHour * Math.log1p(item.returnOnInvestmentPercentage);

        f2pMerchableItems.push(item);
    }

    // Sort by flipScore descending (highest volume × ROI first).
    f2pMerchableItems.sort((a, b) => b.flipScore - a.flipScore);

    // Write f2pMerchableItems.json. Preserve existing file if 0 items (API down).
    if (f2pMerchableItems.length > 0) {
        await fs.writeFile('f2pMerchableItems.json', JSON.stringify(f2pMerchableItems, null, 2), 'utf-8');
        console.log(`F2P merchable items: ${f2pMerchableItems.length} written to f2pMerchableItems.json`);
    } else {
        console.log(`${'\x1b[33m'}WARNING: 0 F2P merchable items — preserving existing f2pMerchableItems.json${'\x1b[0m'}`);
    }

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
            buyVolume: oneHourEntry.lowPriceVolume || 0,
            sellVolume: oneHourEntry.highPriceVolume || 0,
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
        console.log('purchasePriceSpikeFiltered', purchasePriceSpikeFiltered);
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
        console.log('taxAwareMarginFiltered', taxAwareMarginFiltered);
        console.log('longTermCrashFiltered', longTermCrashFiltered);
    }
    console.log('Ending Result Count:', merchableItems.length);

    const bold = `\x1b[1m`;
    const normal = `\x1b[0m`;
    const green = `\x1b[32m`;
    const red = `\x1b[31m`;
    const yellow = `\x1b[33m`;
    const magenta = `\x1b[35m`;
    const cyan = `\x1b[36m`;
    const white = `\x1b[37m`;

    console.log('-------------------------------------------------------------------------------------------------------------------------------------------------------------');
    for (const itemData of merchableItems.slice(0, MAX_RESULTS)) {
        // console.log(JSON.stringify(itemData))
        const lowballPct = itemData.lowballPercent || 0;
        const lowballStr = lowballPct > 0
            ? `${yellow}[${lowballPct.toFixed(1)}%]${normal}`
            : `${green}[no]${normal}`;
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
            `${bold}TURNOVER ETA:${normal} ${green}[${formatEta(itemData.turnoverEtaMinutes)}]${normal} | ` +
            `${bold}LOWBALL:${normal} ${lowballStr}`
        );
    }
    console.log('-------------------------------------------------------------------------------------------------------------------------------------------------------------');
    console.log(`Last run: ${new Date().toLocaleString()}`);

    // F2P pre-filter table — only printed when --f2p flag is passed.
    // Shows every F2P item with valid 5m/1h prices, sorted by after-tax
    // margin descending. Green = positive margin, red = zero/negative.
    if (F2P_MODE) {
        f2pPreFilterItems.sort((a, b) => b.margin - a.margin);
        const profitable = f2pPreFilterItems.filter(i => i.margin > 0).length;
        const unprofitable = f2pPreFilterItems.length - profitable;

        console.log('\n' + '='.repeat(120));
        console.log(`${bold}F2P PRE-FILTER MARGIN TABLE${normal} — ${f2pPreFilterItems.length} items (${green}${profitable} profitable${normal}, ${red}${unprofitable} zero/negative${normal})`);
        console.log('='.repeat(120));
        console.log(
            `${bold}Item Name`.padEnd(40) + ' | ' +
            'Buy Price'.padStart(10) + ' | ' +
            'Sell Price'.padStart(10) + ' | ' +
            'Margin'.padStart(10) + ' | ' +
            'Limit'.padStart(8) + `${normal}`
        );
        console.log('-'.repeat(120));
        for (const item of f2pPreFilterItems) {
            const marginColor = item.margin > 0 ? green : red;
            const marginStr = (item.margin >= 0 ? '+' : '') + item.margin + 'gp';
            console.log(
                `${white}${item.itemName}`.padEnd(40) + ' | ' +
                `${cyan}${item.buyPrice.toLocaleString()}gp${normal}`.padStart(14) + ' | ' +
                `${cyan}${item.sellPrice.toLocaleString()}gp${normal}`.padStart(14) + ' | ' +
                `${marginColor}${marginStr}${normal}`.padStart(14) + ' | ' +
                `${yellow}${item.limit}${normal}`.padStart(8)
            );
        }
        console.log('='.repeat(120));
        console.log(`F2P items: ${f2pPreFilterItems.length} total | ${profitable} profitable | ${unprofitable} zero/negative\n`);

        // Write CSV file for easy external viewing.
        // Column G "Filtered By" shows which pipeline filter removed each item,
        // or "Passed all filters" if the item survived the entire pipeline.
        const merchableItemIds = new Set(merchableItems.map(i => i.itemId));
        const csvLines = ['Item Name,Buy Price,Sell Price,Margin,Limit,1h Volume,Item ID,Filtered By'];
        for (const item of f2pPreFilterItems) {
            const name = item.itemName.includes(',') ? `"${item.itemName}"` : item.itemName;
            const filteredBy = f2pFilterReason.get(item.itemId)
                ?? (merchableItemIds.has(item.itemId) ? 'Passed all filters' : 'Unknown (no time series)');
            csvLines.push(`${name},${item.buyPrice},${item.sellPrice},${item.margin},${item.limit},${item.oneHourVolume},${item.itemId},${filteredBy}`);
        }
        await fs.writeFile('f2p_margins.csv', csvLines.join('\n'), 'utf-8');
        console.log(`F2P CSV written to f2p_margins.csv (${f2pPreFilterItems.length} rows)`);
    }
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




