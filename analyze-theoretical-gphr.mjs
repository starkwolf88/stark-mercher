// Theoretical profit/hr model — mirrors the runtime evaluation logic.
// For each cash stack, greedily fill 8 slots by runtime profit/hr,
// using the same evaluateItemAtRuntime + slotBudget logic as the plugin.
//
// Run: node analyze-theoretical-gphr.mjs

import fs from 'fs';

const items = JSON.parse(fs.readFileSync('./merchableItems.json', 'utf8'));

const MARKET_SHARE = 50;
const TWO_HOUR_VOLUME_BUFFER = 15;
const RUNTIME_MIN_ABSOLUTE_PROFIT_GP = 20000;
const RUNTIME_MIN_PROFIT_PER_SLOT_HOUR = 20000;
const RUNTIME_MAX_TURNOVER_MINUTES = 120;
const MAX_SLOT_BUDGET_MULTIPLIER = 2.5;
const SLOTS = 8;

function computeRuntimeEtas(item, quantity) {
    if (quantity <= 0) return null;
    const lowballVolumeFactor = 1 - ((item.lowballPercent || 0) * 4.0 / 100);
    const effectivePurchaseVolume = Math.min(
        item.twoHourAverageHourlyPurchaseVolume * (1 - TWO_HOUR_VOLUME_BUFFER / 100),
        item.oneHourPurchaseVolume,
    ) * (MARKET_SHARE / 100) * lowballVolumeFactor;
    const effectiveSaleVolume = Math.min(
        item.twoHourAverageHourlySaleVolume * (1 - TWO_HOUR_VOLUME_BUFFER / 100),
        item.oneHourSaleVolume,
    ) * (MARKET_SHARE / 100);
    if (effectivePurchaseVolume <= 0 || effectiveSaleVolume <= 0) return null;
    const purchaseEtaMinutes = quantity / (effectivePurchaseVolume / 60);
    const saleEtaMinutes = quantity / (effectiveSaleVolume / 60);
    return {
        purchaseEtaMinutes,
        saleEtaMinutes,
        turnoverEtaMinutes: purchaseEtaMinutes + saleEtaMinutes,
    };
}

function evaluateItemAtRuntime(item, availableCoins) {
    if (item.purchasePrice > availableCoins) return null;
    const runtimeQuantity = Math.min(
        Math.floor(availableCoins / item.purchasePrice),
        item.limit,
    );
    if (runtimeQuantity <= 0) return null;
    const runtimeTotalCost = runtimeQuantity * item.purchasePrice;
    const etas = computeRuntimeEtas(item, runtimeQuantity);
    if (!etas) return null;
    if (etas.turnoverEtaMinutes > RUNTIME_MAX_TURNOVER_MINUTES) return null;
    const runtimeProfitPerSlotHour = (runtimeQuantity * item.profitMargin) * (60 / etas.turnoverEtaMinutes);
    const runtimeTotalProfit = runtimeQuantity * item.profitMargin;
    if (runtimeProfitPerSlotHour < RUNTIME_MIN_PROFIT_PER_SLOT_HOUR) return null;
    if (runtimeTotalProfit < RUNTIME_MIN_ABSOLUTE_PROFIT_GP) return null;
    return {
        item,
        runtimeQuantity,
        runtimeTotalCost,
        runtimePurchaseEtaMinutes: etas.purchaseEtaMinutes,
        runtimeSaleEtaMinutes: etas.saleEtaMinutes,
        runtimeTurnoverEtaMinutes: etas.turnoverEtaMinutes,
        runtimeProfitPerSlotHour,
        runtimeTotalProfit,
    };
}

function simulateCashStack(coins) {
    let remainingCoins = coins;
    const filledSlots = [];
    const usedItems = new Set();

    for (let slot = 0; slot < SLOTS; slot++) {
        const emptySlots = SLOTS - slot;
        const slotBudget = Math.min(remainingCoins, Math.floor(remainingCoins / emptySlots) * MAX_SLOT_BUDGET_MULTIPLIER);

        let best = null;
        for (const item of items) {
            if (usedItems.has(item.itemName)) continue;
            const evalResult = evaluateItemAtRuntime(item, slotBudget);
            if (!evalResult) continue;
            if (!best || evalResult.runtimeProfitPerSlotHour > best.runtimeProfitPerSlotHour) {
                best = evalResult;
            }
        }

        if (!best) break;
        filledSlots.push(best);
        usedItems.add(best.item.itemName);
        remainingCoins -= best.runtimeTotalCost;
    }

    return { filledSlots, remainingCoins };
}

console.log(`merchableItems.json: ${items.length} items, dataFetchedAt: ${new Date(items[0]?.dataFetchedAt).toISOString()}`);
console.log('');

for (const cashStackMillions of [5, 10, 15, 20, 30, 50]) {
    const coins = cashStackMillions * 1e6;
    const { filledSlots, remainingCoins } = simulateCashStack(coins);
    const totalProfitPerHour = filledSlots.reduce((sum, s) => sum + s.runtimeProfitPerSlotHour, 0);
    const totalCapitalDeployed = filledSlots.reduce((sum, s) => sum + s.runtimeTotalCost, 0);
    const avgTurnover = filledSlots.length > 0
        ? filledSlots.reduce((sum, s) => sum + s.runtimeTurnoverEtaMinutes, 0) / filledSlots.length
        : 0;

    console.log(`=== ${cashStackMillions}M cash stack ===`);
    console.log(`Slots filled: ${filledSlots.length}/8`);
    console.log(`Capital deployed: ${(totalCapitalDeployed / 1e6).toFixed(2)}M / ${cashStackMillions}M (${(100 * totalCapitalDeployed / coins).toFixed(0)}%)`);
    console.log(`Leftover coins: ${(remainingCoins / 1e6).toFixed(2)}M`);
    console.log(`Average turnover per slot: ${avgTurnover.toFixed(1)} min`);
    console.log(`Total theoretical profit/hr: ${(totalProfitPerHour / 1000).toFixed(0)}k gp/hr`);
    console.log('');
    console.log('  Slot | Item                              | Qty      | Cost      | Margin  | Turnover  | Profit/hr');
    console.log('  -----|-----------------------------------|----------|-----------|---------|-----------|----------');
    filledSlots.forEach((s, i) => {
        const name = s.item.itemName.padEnd(33).slice(0, 33);
        const qty = String(s.runtimeQuantity).padStart(8);
        const cost = (s.runtimeTotalCost / 1e6).toFixed(2).padStart(7) + 'M';
        const margin = (s.item.profitMargin + 'gp').padStart(7);
        const turnover = (s.runtimeTurnoverEtaMinutes.toFixed(1) + 'min').padStart(9);
        const profitHr = ((s.runtimeProfitPerSlotHour / 1000).toFixed(0) + 'k').padStart(8);
        console.log(`  ${String(i + 1).padStart(4)} | ${name} | ${qty} | ${cost} | ${margin} | ${turnover} | ${profitHr}`);
    });
    console.log('');
}
