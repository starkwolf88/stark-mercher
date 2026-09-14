// Hard volume floor analysis — test different minimum effective volume thresholds.
// Run: node analyze-volume-floor.mjs

import fs from 'fs';

const items = JSON.parse(fs.readFileSync('./merchableItems.json', 'utf8'));

const MARKET_SHARE = 35;
const TWO_HOUR_VOLUME_BUFFER = 15;
const RUNTIME_MIN_ABSOLUTE_PROFIT_GP = 20000;
const RUNTIME_MIN_PROFIT_PER_SLOT_HOUR = 20000;
const RUNTIME_MAX_TURNOVER_MINUTES = 120;
const COINS = 20e6;

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

function computeEtas(item, quantity) {
    if (quantity <= 0) return null;
    const { effBuy, effSell } = effectiveVolumes(item);
    if (effBuy <= 0 || effSell <= 0) return null;
    return {
        purchaseEtaMinutes: quantity / (effBuy / 60),
        saleEtaMinutes: quantity / (effSell / 60),
        turnoverEtaMinutes: (quantity / (effBuy / 60)) + (quantity / (effSell / 60)),
    };
}

function evaluate(item, coins, minVolFloor = 0) {
    if (item.purchasePrice > coins) return null;
    const qty = Math.min(Math.floor(coins / item.purchasePrice), item.limit);
    if (qty <= 0) return null;
    const { effBuy, effSell } = effectiveVolumes(item);
    const minVol = Math.min(effBuy, effSell);
    if (minVol < minVolFloor) return null;
    const etas = computeEtas(item, qty);
    if (!etas) return null;
    if (etas.turnoverEtaMinutes > RUNTIME_MAX_TURNOVER_MINUTES) return null;
    const profitPerSlotHour = (qty * item.profitMargin) * (60 / etas.turnoverEtaMinutes);
    const totalProfit = qty * item.profitMargin;
    if (profitPerSlotHour < RUNTIME_MIN_PROFIT_PER_SLOT_HOUR) return null;
    if (totalProfit < RUNTIME_MIN_ABSOLUTE_PROFIT_GP) return null;
    return { item, qty, etas, profitPerSlotHour, totalProfit, minVol };
}

// Baseline (no floor)
const baseline = [];
for (const item of items) {
    const ev = evaluate(item, COINS);
    if (ev) baseline.push(ev);
}
baseline.sort((a, b) => b.profitPerSlotHour - a.profitPerSlotHour);

console.log(`=== Hard volume floor analysis at ${COINS / 1e6}M cash ===`);
console.log(`Baseline (no floor): ${baseline.length} items pass`);
console.log('');

// Test floors: 10, 25, 50, 75, 100, 150, 200, 300, 500
const floors = [10, 25, 50, 75, 100, 150, 200, 300, 500];
console.log('  Floor | Pass | Removed | Top item profit/hr | Lowest vol item');
console.log('  ------|------|---------|-------------------|----------------');
for (const floor of floors) {
    const passing = [];
    for (const item of items) {
        const ev = evaluate(item, COINS, floor);
        if (ev) passing.push(ev);
    }
    passing.sort((a, b) => b.profitPerSlotHour - a.profitPerSlotHour);
    const topProfit = passing.length > 0 ? (passing[0].profitPerSlotHour / 1000).toFixed(0) + 'k' : '-';
    const lowestVol = passing.length > 0 ? passing[passing.length - 1].minVol.toFixed(0) + '/hr' : '-';
    console.log(`  ${String(floor).padStart(5)} | ${String(passing.length).padStart(4)} | ${String(baseline.length - passing.length).padStart(7)} | ${topProfit.padStart(17)} | ${lowestVol}`);
}
console.log('');

// Detailed breakdown for key floors: 50, 100, 200
for (const floor of [50, 100, 200]) {
    const passing = [];
    for (const item of items) {
        const ev = evaluate(item, COINS, floor);
        if (ev) passing.push(ev);
    }
    passing.sort((a, b) => b.profitPerSlotHour - a.profitPerSlotHour);
    
    console.log(`=== Floor = ${floor} units/hr (${passing.length} items) ===`);
    console.log('  #  | Item                              | Vol/hr   | Turnover  | Profit/hr | Qty');
    console.log('  ----|-----------------------------------|----------|-----------|-----------|--------');
    for (const ev of passing) {
        const name = ev.item.itemName.padEnd(33).slice(0, 33);
        const vol = (ev.minVol.toFixed(0) + '/hr').padStart(8);
        const turnover = (ev.etas.turnoverEtaMinutes.toFixed(1) + 'min').padStart(9);
        const profitHr = ((ev.profitPerSlotHour / 1000).toFixed(0) + 'k').padStart(8);
        const qty = String(ev.qty).padStart(8);
        console.log(`  ${String(passing.indexOf(ev) + 1).padStart(3)} | ${name} | ${vol} | ${turnover} | ${profitHr} | ${qty}`);
    }
    
    const removed = baseline.filter(b => !passing.some(p => p.item.itemName === b.item.itemName));
    if (removed.length > 0) {
        console.log(`  Removed by floor=${floor}:`);
        for (const ev of removed) {
            console.log(`    ${ev.item.itemName.padEnd(33)} vol=${ev.minVol.toFixed(0)}/hr turnover=${ev.etas.turnoverEtaMinutes.toFixed(1)}min profit=${(ev.profitPerSlotHour/1000).toFixed(0)}k`);
        }
    }
    console.log('');
}

// Also show: what's the volume of items that ACTUALLY got selected in the runtime logs?
// From the logs, the items that stalled: Dark bow(6), Master wand(3), Abyssal dagger(7),
// Heavy ballista, Frost dragon bones, Contract of Familiar Acquisition, Raw sea turtle,
// Blighted super restore, Mixed hide boots, Dragon harpoon, Bastion potion, etc.
// Let's check their volumes.
console.log('=== Volume of items observed stalling in runtime logs ===');
const stallItems = [
    'Dark bow', 'Master wand', 'Abyssal dagger (p++)', 'Heavy ballista',
    'Frost dragon bones', 'Contract of Familiar Acquisition', 'Raw sea turtle',
    'Blighted super restore(4)', 'Mixed hide boots', 'Dragon harpoon',
    'Bastion potion(4)', 'Diamond dragon bolts (e)', 'Elder chaos hood',
    'Rune dart', 'Rune arrow', 'Coal', 'Marlin', 'Cooked karambwan',
    'Adamantite bar', 'Wrath rune', 'Mahogany plank', 'Amethyst dart tip',
    'Soul rune', 'Zulrah\'s scales', 'Red chinchompa',
];
for (const name of stallItems) {
    const item = items.find(i => i.itemName.toLowerCase() === name.toLowerCase());
    if (!item) { console.log(`  ${name.padEnd(35)} NOT FOUND`); continue; }
    const { effBuy, effSell } = effectiveVolumes(item);
    const minVol = Math.min(effBuy, effSell);
    const stalled = ['Dark bow', 'Master wand', 'Abyssal dagger (p++)', 'Heavy ballista',
        'Frost dragon bones', 'Contract of Familiar Acquisition', 'Raw sea turtle',
        'Blighted super restore(4)', 'Mixed hide boots', 'Dragon harpoon',
        'Bastion potion(4)', 'Diamond dragon bolts (e)', 'Elder chaos hood'].includes(name);
    const tag = stalled ? ' [STALLED]' : '';
    console.log(`  ${name.padEnd(35)} vol=${minVol.toFixed(0).padStart(6)}/hr buy=${effBuy.toFixed(0)}/hr sell=${effSell.toFixed(0)}/hr${tag}`);
}
