// Volume distribution + low-volume ETA penalty impact analysis.
// Run: node analyze-volume-penalty.mjs

import fs from 'fs';

const items = JSON.parse(fs.readFileSync('./merchableItems.json', 'utf8'));

const MARKET_SHARE = 35;
const TWO_HOUR_VOLUME_BUFFER = 15;
const RUNTIME_MIN_ABSOLUTE_PROFIT_GP = 20000;
const RUNTIME_MIN_PROFIT_PER_SLOT_HOUR = 20000;
const RUNTIME_MAX_TURNOVER_MINUTES = 120;

function effectiveVolumes(item) {
    const lowballVolumeFactor = 1 - ((item.lowballPercent || 0) * 4.0 / 100);
    const effBuy = Math.min(
        item.twoHourAverageHourlyPurchaseVolume * (1 - TWO_HOUR_VOLUME_BUFFER / 100),
        item.oneHourPurchaseVolume,
    ) * (MARKET_SHARE / 100) * lowballVolumeFactor;
    const effSell = Math.min(
        item.twoHourAverageHourlySaleVolume * (1 - TWO_HOUR_VOLUME_BUFFER / 100),
        item.oneHourSaleVolume,
    ) * (MARKET_SHARE / 100);
    return { effBuy, effSell };
}

function computeEtas(item, quantity, volumePenaltyMultiplier = 1.0) {
    if (quantity <= 0) return null;
    const { effBuy, effSell } = effectiveVolumes(item);
    const adjBuy = effBuy / volumePenaltyMultiplier;
    const adjSell = effSell / volumePenaltyMultiplier;
    if (adjBuy <= 0 || adjSell <= 0) return null;
    const purchaseEtaMinutes = quantity / (adjBuy / 60);
    const saleEtaMinutes = quantity / (adjSell / 60);
    return {
        purchaseEtaMinutes,
        saleEtaMinutes,
        turnoverEtaMinutes: purchaseEtaMinutes + saleEtaMinutes,
    };
}

function evaluate(item, coins, volumePenaltyMultiplier = 1.0) {
    if (item.purchasePrice > coins) return null;
    const qty = Math.min(Math.floor(coins / item.purchasePrice), item.limit);
    if (qty <= 0) return null;
    const etas = computeEtas(item, qty, volumePenaltyMultiplier);
    if (!etas) return null;
    if (etas.turnoverEtaMinutes > RUNTIME_MAX_TURNOVER_MINUTES) return null;
    const profitPerSlotHour = (qty * item.profitMargin) * (60 / etas.turnoverEtaMinutes);
    const totalProfit = qty * item.profitMargin;
    if (profitPerSlotHour < RUNTIME_MIN_PROFIT_PER_SLOT_HOUR) return null;
    if (totalProfit < RUNTIME_MIN_ABSOLUTE_PROFIT_GP) return null;
    return { item, qty, etas, profitPerSlotHour, totalProfit };
}

// --- Volume distribution ---
console.log(`=== Volume distribution (${items.length} items) ===`);
console.log('');

// Categorize by effective hourly sell volume (the binding constraint for sells)
const buckets = { '0-10': 0, '10-50': 0, '50-100': 0, '100-500': 0, '500-1000': 0, '1000+': 0 };
const lowVolumeItems = [];
for (const item of items) {
    const { effBuy, effSell } = effectiveVolumes(item);
    const minVol = Math.min(effBuy, effSell);
    let bucket;
    if (minVol < 10) { bucket = '0-10'; lowVolumeItems.push({ item, effBuy, effSell, minVol }); }
    else if (minVol < 50) bucket = '10-50';
    else if (minVol < 100) bucket = '50-100';
    else if (minVol < 500) bucket = '100-500';
    else if (minVol < 1000) bucket = '500-1000';
    else bucket = '1000+';
    buckets[bucket]++;
}
console.log('Effective hourly volume (min of buy/sell, after 35% share + buffer):');
for (const [bucket, count] of Object.entries(buckets)) {
    console.log(`  ${bucket.padEnd(10)}: ${count} items`);
}
console.log('');
console.log(`Low-volume items (<10 effective units/hr): ${lowVolumeItems.length}`);
lowVolumeItems.sort((a, b) => a.minVol - b.minVol);
for (const { item, effBuy, effSell, minVol } of lowVolumeItems.slice(0, 20)) {
    console.log(`  ${item.itemName.padEnd(35)} effBuy=${effBuy.toFixed(1)}/hr effSell=${effSell.toFixed(1)}/hr margin=${item.profitMargin}gp price=${item.purchasePrice}gp`);
}
if (lowVolumeItems.length > 20) console.log(`  ... and ${lowVolumeItems.length - 20} more`);
console.log('');

// --- Count items passing filters at 20M cash stack ---
const COINS = 20e6;
console.log(`=== Items passing current filters at ${COINS / 1e6}M cash ===`);
console.log('');

let passCurrent = 0;
const passingItems = [];
for (const item of items) {
    const ev = evaluate(item, COINS);
    if (ev) {
        passCurrent++;
        passingItems.push(ev);
    }
}
passingItems.sort((a, b) => b.profitPerSlotHour - a.profitPerSlotHour);
console.log(`Items passing: ${passCurrent}`);
console.log('');
console.log('  #  | Item                              | Vol/hr   | Turnover  | Profit/hr | Qty');
console.log('  ----|-----------------------------------|----------|-----------|-----------|--------');
for (const ev of passingItems) {
    const { effBuy, effSell } = effectiveVolumes(ev.item);
    const minVol = Math.min(effBuy, effSell);
    const name = ev.item.itemName.padEnd(33).slice(0, 33);
    const vol = (minVol.toFixed(0) + '/hr').padStart(8);
    const turnover = (ev.etas.turnoverEtaMinutes.toFixed(1) + 'min').padStart(9);
    const profitHr = ((ev.profitPerSlotHour / 1000).toFixed(0) + 'k').padStart(8);
    const qty = String(ev.qty).padStart(8);
    console.log(`  ${String(passingItems.indexOf(ev) + 1).padStart(3)} | ${name} | ${vol} | ${turnover} | ${profitHr} | ${qty}`);
}
console.log('');

// --- Simulate low-volume penalty ---
// Penalty approach: multiply ETA by a factor that increases as volume decreases.
// Below 100 effective units/hr, apply a linear penalty scaling from 1.0x (at 100) to 3.0x (at 0).
// This makes thin-volume items' ETAs 2-3x longer, which pushes their turnover >120min
// or drops their profit/hr below 20k, filtering them out naturally.
function volumePenalty(item) {
    const { effBuy, effSell } = effectiveVolumes(item);
    const minVol = Math.min(effBuy, effSell);
    if (minVol >= 100) return 1.0;
    // Linear: 1.0x at 100, 3.0x at 0
    return 1.0 + (100 - minVol) / 100 * 2.0;
}

console.log(`=== With low-volume ETA penalty (1.0x at 100+ vol, scaling to 3.0x at 0 vol) ===`);
console.log('');

let passPenalty = 0;
const passingPenaltyItems = [];
for (const item of items) {
    const penalty = volumePenalty(item);
    const ev = evaluate(item, COINS, penalty);
    if (ev) {
        passPenalty++;
        passingPenaltyItems.push({ ...ev, penalty });
    }
}
passingPenaltyItems.sort((a, b) => b.profitPerSlotHour - a.profitPerSlotHour);
console.log(`Items passing: ${passPenalty} (was ${passCurrent})`);
console.log(`Items filtered out: ${passCurrent - passPenalty}`);
console.log('');
console.log('  #  | Item                              | Vol/hr   | Penalty  | Turnover  | Profit/hr | Qty');
console.log('  ----|-----------------------------------|----------|----------|-----------|-----------|--------');
for (const ev of passingPenaltyItems) {
    const { effBuy, effSell } = effectiveVolumes(ev.item);
    const minVol = Math.min(effBuy, effSell);
    const name = ev.item.itemName.padEnd(33).slice(0, 33);
    const vol = (minVol.toFixed(0) + '/hr').padStart(8);
    const penalty = (ev.penalty.toFixed(1) + 'x').padStart(8);
    const turnover = (ev.etas.turnoverEtaMinutes.toFixed(1) + 'min').padStart(9);
    const profitHr = ((ev.profitPerSlotHour / 1000).toFixed(0) + 'k').padStart(8);
    const qty = String(ev.qty).padStart(8);
    console.log(`  ${String(passingPenaltyItems.indexOf(ev) + 1).padStart(3)} | ${name} | ${vol} | ${penalty} | ${turnover} | ${profitHr} | ${qty}`);
}
console.log('');

// Show what got filtered out
const filteredOut = passingItems.filter(p => !passingPenaltyItems.some(pp => pp.item.itemName === p.item.itemName));
if (filteredOut.length > 0) {
    console.log('Filtered out by penalty:');
    for (const ev of filteredOut) {
        const { effBuy, effSell } = effectiveVolumes(ev.item);
        const minVol = Math.min(effBuy, effSell);
        const penalty = volumePenalty(ev.item);
        console.log(`  ${ev.item.itemName.padEnd(35)} vol=${minVol.toFixed(0)}/hr penalty=${penalty.toFixed(1)}x oldTurnover=${ev.etas.turnoverEtaMinutes.toFixed(1)}min oldProfit=${(ev.profitPerSlotHour/1000).toFixed(0)}k`);
    }
}
