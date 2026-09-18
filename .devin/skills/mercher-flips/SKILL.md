# Stark Mercher — `determine-flips.mjs` deep analysis

## Native handle exhaustion

For the shared rule (NEVER loop over `titan.queries.*().toArray()`), see
`~/.codeium/windsurf/memories/titan-performance-rules.md`.

> Source file: `determine-flips.mjs`
> Output files: `merchableItems.json` (inlined into the plugin bundle at build time), `priceHistory.json` (fallback price lookup, also inlined)
> Related plugin files: `data/merchable-items.ts`, `data/price-history.ts`

## Purpose

`determine-flips.mjs` is a Node automation that queries the OSRS Wiki Prices API,
processes the data, and writes a ranked list of merchable items to
`merchableItems.json`. The plugin then bundles this JSON at build time and uses it
to decide which GE offers to place.

## Configuration constants

| Constant | Default | Meaning |
|----------|---------|---------|
| `MAX_RESULTS` | 100 (was 20) | Max items kept after sorting by `flipScore`. JSON size grows, but plugin still iterates the whole list. |
| `GE_TAX_PERCENTAGE` | 2 | GE sale tax deducted from raw sell price when computing `salePriceExcludingTax`. |
| `GE_TAX_EXEMPTION_THRESHOLD` | 50 | Items with a `rawSalePrice` below 50gp are exempt from GE sales tax — `saleTaxAmount` is set to 0 instead of `floor(price * 0.02)`. This matches the OSRS game rule and allows low-priced items (e.g. Fire rune at 4-5gp) to have a viable margin. |
| `CASH_STACK_MILLIONS` | 50 | **Pool-width dial.** Items costing more than `CASH_STACK` are filtered out. Set lower (e.g. 10) for fewer results, higher (e.g. 500) for more. The plugin evaluates each item at runtime based on the player's actual coins — this value only controls which items make it into the JSON, not the runtime decision. |
| `CASH_STACK` | `CASH_STACK_MILLIONS * 1e6` | Numeric cash stack (simulation only — controls pool width via `purchasePrice > CASH_STACK` filter). |
| `SALE_BUFFER_RATIO` | 0.05 | Sell undercut: 5% of post-tax margin (margin after 2% GE tax). Makes the initial sell price competitive so items sell in 1-2 attempts instead of cycling through revisions. Can never filter items by itself (buffer <= post-tax margin). Thin-margin items (post-tax < 20gp) get 0. |
| `AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO` | 0.125 | Target cash per GE slot if all slots were equal (≈ 8 slots). Simulation only — runtime quantity is computed from actual coins. |
| `AVERAGE_SLOT_CASH_STACK_ALLOCATION` | `CASH_STACK * ratio` | Base GP allocated per slot (simulation only). |
| `MARKET_SHARE_ASSUMPTION_PERCENTAGE` | 50 | Used in ETA and profit/hr calculation: assume the bot captures 50% of the observed buy/sell volume. Raised from 35% — the 35% assumption understated profit/hr by ~2×, filtering out items that genuinely earn 30-40k/hr at realistic capture rates. 50% is still conservative (the 15% volume buffer on top gives effective 42.5% assumed capture). |
| `MAX_TURNOVER_HOURS` | 6 | Secondary sanity check: rejects items with turnover ETA > 6h at the 50m allocation. The primary quality gate is `actualProfitPerSlotHour >= 20,000` (which is quantity-independent). At 6h, this doesn't filter any legitimate items — the maximum turnover for an item passing the 20k profit/hr filter is ~4h (quantity capped at 1h volume, 50% market share assumption). |
| `TWO_HOUR_VOLUME_BUFFER_PERCENTAGE` | 15 | Reduce 2h volume by 15% before using it for ETAs (safety margin). |
| `PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD` | 20000 | `actualProfitPerSlotHour` must be ≥ 20k. This value is quantity-independent (the formula simplifies to `margin / (1/buyVol + 1/sellVol)` — quantity cancels out), so filtering at 20k here matches the runtime threshold exactly. Items below 20k at 50m are also below 20k at any cash stack — they would never be bought under any circumstance and should not pollute `merchableItems.json`. |
| `RUNTIME_MIN_EFFECTIVE_VOLUME` | 15 | Runtime-only floor: items whose effective volume (min of buy/sell, after 50% market share + 15% 2h buffer + lowball penalty) is below 15 units/hr are rejected by `evaluateItemAtRuntime`. Small GE limits can keep the modeled ETA under 120min despite terrible volume (e.g. Dark bow at 6/hr, Master wand at 3/hr, Heavy ballista at 6/hr), so the ETA cap alone doesn't catch them. This filters ~110 thin-volume items from the pool, leaving ~92 — large enough for multi-account scaling. Sell-side stale detection and sell ETA are unaffected (items already held still sell normally). |
| `ROI_MINIMUM_PERCENTAGE_THRESHOLD` | 0.5 | `returnOnInvestmentPercentage` must be ≥ 0.5%. Lowered from 1% so high-volume thin-margin items (e.g. Steel cannonball, ~0.83% ROI with 11k limit and ~18min turnover) that pass the profit-per-slot-hour gate aren't rejected by a proxy metric. The PPSH threshold (20k) is the real profitability gate; ROI is a secondary spread-thickness guard. |
| `TAX_AWARE_PRICE_THRESHOLD` | 10000 | Only apply the tax-aware margin filter to items above this purchase price. Low-value items are exempt because their 1gp minimum price movement makes thin margins viable at high volume (e.g. Revenant ether at 1gp margin, 3gp tax, 143k gp/hr). |
| `TAX_AWARE_MARGIN_TO_TAX_FLOOR` | 1.0 | Hard floor: for items above `TAX_AWARE_PRICE_THRESHOLD`, the net margin (after tax + 1% buffer) must be ≥ the GE tax amount (M/T ≥ 1.0). Blocks guaranteed-loss items like Contract of Glyphic Attenuation (270k buy, 5.2k margin, 5.4k tax, M/T 0.96×). |
| `TAX_AWARE_MARGIN_PCT_SHORT_ETA` | 0.5 | Price-movement guard for items with sell ETA < 30 min: margin as % of purchase price must be ≥ 0.5%. Fast-selling items need less buffer because they're exposed to market drift for less time. |
| `TAX_AWARE_MARGIN_PCT_MEDIUM_ETA` | 1.0 | Price-movement guard for items with sell ETA 30–90 min: margin as % of purchase price must be ≥ 1.0%. |
| `TAX_AWARE_MARGIN_PCT_LONG_ETA` | 1.5 | Price-movement guard for items with sell ETA > 90 min: margin as % of purchase price must be ≥ 1.5%. Long-selling items need more buffer against market drift. Replaces the old flat `TAX_AWARE_MARGIN_TO_TAX_RATIO = 1.5` which conflated tax coverage with price-movement buffer and unfairly penalised high-priced items (a 20m item with 500k margin has M/T 1.23× but M/P 2.5%, a healthy buffer). The ETA-scaled M/P guard directly measures how much the market can drift before the margin is wiped, while the separate M/T ≥ 1.0 hard floor ensures tax is always covered. |
| `ONE_HOUR_SALE_SPIKE_*` | scale 0.5, min 10%, max 20% | Margin-aware 1h vs 7d sustained sale spike threshold. `maxSpikePct = clamp(marginPct * 0.5, 10, 20)`. Filters items whose 1h average is significantly above the 7d baseline (sustained uptrend, not transient spike). High-margin items keep the 20% cap. |
| `THREE_HOUR_SALE_SPIKE_*` | scale 0.4, min 8%, max 15% | Margin-aware 3h vs 7d sustained sale spike threshold. Slightly tighter than 1h because a 3h sustained spike is more concerning. |
| `ONE_HOUR_PURCHASE_SPIKE_*` | scale 0.5, min 15%, max 25% | Margin-aware 1h vs 7d sustained **purchase** spike threshold. `maxSpikePct = clamp(marginPct * 0.5, 15, 25)`. Mirrors the sale spike filter but for the buy price. Higher minimum (15% vs 10%) because normal market trends regularly produce 5-10% moves above the 7d average that are legitimate and profitable — the filter targets only genuine manipulation/transient pump spikes (e.g. Ham robe 69.83%, Dark kebbit fur 22.10%, Antipoison(3) 18.24%). Empirical analysis of merch history showed zero losses from purchase-price spikes; all losses were sell-side. |
| `THREE_HOUR_PURCHASE_SPIKE_*` | scale 0.4, min 12%, max 20% | Margin-aware 3h vs 7d sustained purchase spike threshold. Higher minimum (12% vs 8%) for the same rationale as the 1h filter. |
| `ONE_HOUR_VS_SEVEN_DAY_PRICE_DROP_MIN_MULTIPLIER` | 0.92 | Rejects items whose 1h purchase price is < 92% of the 7d average (sustained downtrend/crash). |
| `THREE_HOUR_PRICE_DROP_MIN_MULTIPLIER` | 0.90 | Rejects items whose 3h average purchase price is < 90% of the 7d average. |
| `FIVE_MINUTE_VS_ONE_HOUR_*_PRICE_CHANGE_*` | scale 0.4, min 2%, max 5%/10% | Margin-aware 5m vs 1h transient spike **clamp**. Instead of filtering the item, this CLAMPS the 5m price down toward the 1h average when the 5m price spikes above it by more than the threshold. This neutralises transient 5m spikes (like the Diamond's 2.3% spike) without removing the item from the pool. Downward drops are left as-is (beneficial). |

## API sources

All endpoints are on `https://prices.runescape.wiki/api/v1/osrs/` except
`determineLongTermCrash` which uses `/api/v2/osrs/`:

| Endpoint | Purpose |
|----------|---------|
| `5m` | Latest 5-minute average low/high prices and volumes. |
| `1h` | Latest 1-hour average low/high prices and volumes. |
| `24h` | Latest 24-hour average low/high prices and volumes. |
| `mapping` | Item names, GE limits, item IDs. |
| `timeseries?timestep=1h&id={id}` | Hourly time series for the last ~7 days. Cached in `item_time_series_data.json`. |
| `timeseries?lookback=30d&id={id}` (v2) | 30-day time series for long-term crash detection. Cached per-item in `item_long_term_crash_data.json` with a 24h TTL (`LONG_TERM_CRASH_CACHE_TTL_MS`); only refetched when the cached entry is older than 24h. A 200ms delay (`LONG_TERM_CRASH_FETCH_DELAY_MS`) is inserted between v2 calls to avoid the OSRS Wiki load balancer dropping connections (`ECONNABORTED`) when many items need a fresh fetch in one run. |

## High-level pipeline

```
getMerchableItems()
  ├─ capture dataFetchedAt timestamp
  ├─ getPriceData()                          fetch 5m / 1h / 24h / mapping
  ├─ for each 1h item:
  │   buildItemDataObject()                  add mapping, 5m, 24h data
  │   excludeNameStrings()                   name filters
  │   determinePurchaseAndSalePrices()       use 5m price if available; cap at CASH_STACK
  │   determineFiveMinuteVsOneHour*Change()  clamp 5m price toward 1h avg on upward spikes (margin-aware)
  │   calculateSalePrice()                   tax (0 if < 50gp) + 5% post-tax margin undercut
  │   calculateProfitMargin()                at market price; if fails → applyLowball() + retry
  │   applyCompetitiveBuffer()               +5% of margin to non-lowball buy prices (min 1gp)
  │   → filteredItems[]
  ├─ getTimeSeriesData()                     fetch/update hourly series, cached locally
  ├─ convertTimeSeriesData()                 compute 2h/3h/4h/7d averages and 4h crash data
  ├─ for each item with time series:
  │   validatePurchasePrice()                fall back to 2h/3h averages if no 5m
  │   validateSalePrice()
  │   clampPrices()                          cap price at 2h average + 5%/50k
  │   calculateSalePrice()                   recompute tax/undercut after clamping
  │   calculateProfitMargin()                at clamped market price; if fails → applyLowball() + retry
  │   applyCompetitiveBuffer()               +5% of margin to non-lowball buy prices (min 1gp)
  │   determineIrregularVolumes()            reject 3h volume too far from 7d baseline
  │   determineTrendSlope()                  reject 3+ recent price drops or 2+ drops + 1 flat
  │   determineSalePriceSpike()              reject 1h/3h sale price > 7d baseline (margin-aware threshold)
  │   determinePurchasePriceSpike()          reject 1h/3h purchase price > 7d baseline (margin-aware, tighter: min 7%/5%)
  │   determinePurchasePriceDrop()           reject 1h/3h purchase price < 7d baseline
  │   calculateMaxProfitPerSlotHour()        maxProfitPerSlotHour = min(3h vol, limit) * lowballFactor * profitMargin
  │   → filteredItemsBeforeCashAllocation[]
  ├─ compute averageProfitPerSlotHour
  ├─ for each item:
  │   calculateSlotCashAllocation()          core cash allocation logic
  │   calculateQuantityToPurchase()          quantity, totalPurchasePrice
  │   calculateEtas()                        buy/sell/turnover ETAs (4.0x lowball volume factor), reject if turnover > 6h
  │   calculateProfitability()               actualProfitPerSlotHour (reject if < 20k), ROI (reject if < 0.5%), tax-aware margin (reject if high-value & margin < 1.5× tax), totalProfit
  │   determineLongTermCrash()               reject if 30d recent price > 10% below 90th percentile baseline
  │   add dataFetchedAt / dataFetchedAtIso
  │   → merchableItems[]
  ├─ determineFlipScore()                    score and sort
  ├─ write merchableItems.json (skip if 0 results)
  └─ write priceHistory.json (always — uses 1h data already fetched)
```

## `priceHistory.json`

A lightweight fallback price lookup written every run alongside `merchableItems.json`. Uses the 1h average prices already fetched in `getPriceData()` — **no extra API calls**.

```json
{
  "2": { "name": "Steel cannonball", "buy": 249, "sell": 256, "buyVolume": 100000, "sellVolume": 95000, "fetchedAt": 1788175308405 },
  ...
}
```

- ~1,800–3,000 entries (every item with valid 1h data + mapping name)
- Written every run regardless of `merchableItems.length` (the 1h data is always available)
- Includes `buyVolume` (1h low price volume) and `sellVolume` (1h high price volume) fields, used by `reconstructEntry` to compute approximate ETAs for priceHistory-only items after cache loss (using the same 50% market share assumption as the main ETA calculation)
- Consumed by `data/price-history.ts` in the plugin as a fallback sell-price source for inventory items that aren't in `merchableItems.json` or the offer cache (e.g. orphaned items after a long script stop or a JSON refresh during sleep). Also used by reverse reconciliation (`OfferCacheManager.reconstructEntry`) to reconstruct cache entries for live GE offers after the cache is lost to a client restart, when the item is no longer in `merchableItems.json`. The reconstruction also parses the GE slot's `priceText` widget for the actual offer price, using the priceHistory buy/sell only as the counterpart (buy price for sell offers, sell price for buy offers).

## Volume-scaled lowball (fallback only)

Lowball is a **fallback mechanism** to expand the item pool — it only applies to items that fail the profit margin filter at market price. Items that pass at market price retain their original buy price (plus the competitive buffer). This gives a broader range of items to buy if the non-lowball pool is exhausted, without unnecessarily reducing margins on items that are already profitable.

**How it works** (both passes):
1. Try `calculateProfitMargin()` at market price (5m average low).
2. If it passes → non-lowball item. Apply competitive buffer, recalculate margin, continue.
3. If it fails → `applyLowball()` to reduce the buy price and create margin. Retry `calculateProfitMargin()`.
4. If the lowballed margin passes → lowball item, continue. If it still fails → filtered out.

**Lowball tiers** (based on 3h average hourly volume, 1h volume as fallback in first pass):

| 3h avg volume | Lowball % |
|---|---|
| > 200k/hr | 2% |
| 50k–200k/hr | 1.5% |
| 10k–50k/hr | 1% |
| < 10k/hr | 0% (no lowball possible — filtered out if margin fails) |

**Gate**: Only applied when `min(volume, limit) >= 5000` — targets high-quantity items where a small per-unit margin adds up.

**Margin-aware cap** (`LOWBALL_MARGIN_CAP_RATIO = 0.5`): The lowball amount is capped at 50% of the raw margin (`rawSalePrice - basePrice`). For thin-margin items (e.g. 3gp spread on a 150gp item), a flat 2% lowball (3gp) would eat the entire margin and produce a buy offer below the market floor that never fills. Capping at 50% of the margin ensures the lowball never eliminates more than half the spread. If the capped amount is < 1gp, no lowball is applied (buy at market).

**24h floor**: The final `purchasePrice` is clamped to at least (`twentyFourHourAvgLowPrice - 1`), but never above `basePrice`. This prevents the lowball from pushing below the broader 24h market average, where only the bottom tail of the price distribution would fill the offer — not enough volume for large orders. The 24h average low is stored on `itemData.twentyFourHourAvgLowPrice` in `buildItemDataObject()`.

**Actual applied percent**: After the margin cap and 24h floor are applied, `lowballPercent` and `lowballAmount` are recomputed to reflect the actual reduction from `basePrice`. This ensures the ETA volume factor is accurate.

**ETA adjustment**: Effective buy volume is reduced by `4.0x lowball%` (e.g., 2% lowball → 92% of volume fills the offer). Increased from 2.0x — lowball offers fill significantly slower than the 2.0x factor predicted, causing offers to sit at 0% progress well past their predicted ETA.

**Profitability adjustment**: The lowball volume factor (4.0x) is also applied in `calculateMaxProfitPerSlotHour` so lowballed items are correctly filtered (the 20k profit-per-slot-hour gate accounts for slower fills) and ranked (`flipScore` reflects the slower fill rate, so lowballed items rank below equivalent non-lowball items).

**Idempotency**: `applyLowball` stores `lowballBasePrice` (the pre-lowball price) so the second pass can reset and re-apply without stacking.

**Output fields**: `lowballPercent`, `lowballAmount`, `lowballBasePrice` are written to `merchableItems.json`.

## Competitive buffer (non-lowball items only)

Non-lowball items buy at the 5m average low price (market price). A small competitive buffer is added on top of the buy price to ensure offers fill reliably even if the market ticks up slightly between data refresh (every 3 min) and offer placement.

**Formula**: `buffer = Math.max(1, Math.floor(rawMargin * 0.05))` where `rawMargin = rawSalePrice - purchasePrice` (at market price, before buffer). The buffer has a **minimum of 1gp** so thin-margin items (<20gp margin) that would otherwise get 0gp still get a 1gp upward nudge — buying at exactly market price puts the offer at the back of the queue, while +1gp puts it ahead of market sellers. Thicker-margin items get a larger upward nudge that costs ~5% of profit but significantly improves fill rates.

**Gate**: Only applies to non-lowball items (`lowballPercent === 0`). Lowball items already buy below market by design and do not get the competitive buffer.

**Applied after**: `calculateSalePrice()` and after the item passes `calculateProfitMargin()` at market price. The profit margin is then recalculated with the buffered buy price. Applied in both the first and second pass.

**Output field**: `competitiveBuffer` (in gp) is written to `merchableItems.json`.

## Sell-side undercut (post-tax margin)

The sell price is set at the 5m average high price (the instant-sell ceiling) minus a competitive undercut. The undercut is **5% of post-tax margin** — the profit remaining after 2% GE tax is deducted from the gross margin. This directly measures what's available and can never make an item negative by itself.

**Formula**: `saleBufferAmount = floor(postTaxMargin * 0.05)` where `postTaxMargin = max(0, rawSalePrice - saleTaxAmount - purchasePrice)`.

**Why post-tax margin, not gross margin or price**:
- The previous buffer was 0.01% of price (`SALE_BUFFER_PERCENTAGE = 0.01` applied as `(price / 100) * 0.01 = price * 0.0001`) — essentially zero. The sell price was basically the 5m avg high, so items sat at the instant-sell ceiling and required many revisions to sell.
- 10% of **gross** margin was tried first but filtered ~5 items — for items where the 2% GE tax consumes most of the margin (spread ≈ 2%), 10% of gross margin + 5% buy buffer + tax exceeded the entire margin, producing negative profit.
- % of **post-tax** margin avoids this: the buffer is always <= post-tax margin, so it can never eliminate profit by itself. The 5% buy buffer is also taken from gross margin but is small enough (5% of gross vs 2% tax) that it doesn't cause issues.

**Scaling across margin thickness**:
- Thick-margin items (e.g. Impish whistle: 212k post-tax): 10,622gp undercut — meaningful, should sell in 1-2 attempts.
- Medium-margin items (e.g. Dragon cannonball: 85gp post-tax): 4gp undercut.
- Thin-margin items (post-tax < 20gp): 0gp undercut — same as before, the runtime revision system handles them with its aggressive thin-margin schedule.

**Applied in**: `calculateSalePrice()`, called in both the first and second pass. The undercut is computed from the pre-buy-buffer market spread, so it doesn't change when the buy-side competitive buffer is applied afterward.

**Output field**: `saleBufferAmount` (in gp) is written to `merchableItems.json`.

## Cash allocation and quantity logic (core of Odium-ward / high-price issue)

### `calculateSlotCashAllocation(itemData)`

```js
const capitalEfficiency = itemData.profitMargin / itemData.purchasePrice;
const weightedProfit = itemData.maxProfitPerSlotHour
                       * Math.sqrt(1 + capitalEfficiency)
                       * itemData.threeHourAverageHourlyVolume;
itemData.cashAllocation = Math.min(
    AVERAGE_SLOT_CASH_STACK_ALLOCATION * (weightedProfit / averageProfitPerSlotHour),
    CASH_STACK
);
```

Key behaviours:

1. `capitalEfficiency` = profit per item relative to item price (ROI per flip).
2. `Math.sqrt(1 + capitalEfficiency)` gives a small boost to high-ROI items.
3. `maxProfitPerSlotHour` already equals `min(3h hourly volume, limit) * profitMargin`.
4. `weightedProfit` then multiplies `maxProfitPerSlotHour` by `threeHourAverageHourlyVolume` **again**, so volume is double-counted.
5. The ratio `weightedProfit / averageProfitPerSlotHour` lets highly profitable items receive more than the base 12.5% slot allocation.
6. The final value is capped at `CASH_STACK` (100% of the stack). There is no other upper bound.

Result: a single high-profit item can be allocated the entire cash stack, because the cap is `CASH_STACK` rather than, for example, `AVERAGE_SLOT_CASH_STACK_ALLOCATION * someMaxMultiplier`.

### `calculateQuantityToPurchase(itemData)`

```js
itemData.quantityToPurchase = Math.min(
    Math.floor(itemData.cashAllocation / itemData.purchasePrice),
    itemData.limit,
    Math.floor(itemData.threeHourAverageHourlyVolume)
);
itemData.totalPurchasePrice = itemData.purchasePrice * itemData.quantityToPurchase;
```

Then there is an intended slow-item cap:

```js
if (itemData.turnoverEtaMinutes >= 60 && itemData.totalPurchasePrice > CASH_STACK * 0.5) {
    itemData.quantityToPurchase = Math.max(1, Math.floor(CASH_STACK * 0.5 / itemData.purchasePrice));
    itemData.totalPurchasePrice = itemData.purchasePrice * itemData.quantityToPurchase;
}
```

### Known bug: slow-item cap is dead code

`calculateQuantityToPurchase` is called **before** `calculateEtas`. At that point
`turnoverEtaMinutes` has not been set yet, so it is `undefined`. The condition
`undefined >= 60` is `false`, so the 50% cash-stack cap for slow items **never** fires.

This means an expensive item can claim the whole cash stack even if its ETA is > 1 hour.

## ETA calculation

```js
const effectivePurchaseVolume = Math.min(
    itemData.twoHourAverageHourlyPurchaseVolume * (1 - TWO_HOUR_VOLUME_BUFFER_PERCENTAGE / 100),
    itemData.oneHourPurchaseVolume
) * (MARKET_SHARE_ASSUMPTION_PERCENTAGE / 100);

itemData.purchaseEtaMinutes = itemData.quantityToPurchase / (effectivePurchaseVolume / 60);
itemData.saleEtaMinutes     = itemData.quantityToPurchase / (effectiveSaleVolume / 60);
itemData.turnoverEtaMinutes = itemData.purchaseEtaMinutes + itemData.saleEtaMinutes;
```

The bot assumes it captures 50% of observed volume. ETA is proportional to `quantityToPurchase` and inversely proportional to effective volume per minute. At runtime, `evaluateItemAtRuntime` also enforces a **minimum effective volume floor** (`RUNTIME_MIN_EFFECTIVE_VOLUME = 15` units/hr) using the same buffered, market-share-adjusted effective buy/sell volumes — items below this floor are rejected before ETA/profit ranking, because a small GE limit can keep the modeled ETA under the 120min cap despite the market only producing a few relevant trades per hour.

## Profitability calculation

```js
itemData.actualProfitPerSlotHour = (itemData.quantityToPurchase * itemData.profitMargin) * (60 / itemData.turnoverEtaMinutes);
itemData.returnOnInvestmentPercentage = (itemData.profitMargin / itemData.purchasePrice) * 100;
itemData.totalProfit = itemData.profitMargin * itemData.quantityToPurchase;
```

`actualProfitPerSlotHour` is the expected profit per hour once the full offer cycles.
`returnOnInvestmentPercentage` is the profit margin as a percent of purchase price.

**`actualProfitPerSlotHour` filter (re-added)**: Items with `actualProfitPerSlotHour < 20,000` are filtered out. This value is **quantity-independent** — the formula simplifies to `margin / (1/buyVol + 1/sellVol)`, so the quantity (and thus the cash stack) cancels out. An item at 2,749gp/hr at 50m is also 2,749gp/hr at 500k. The runtime plugin's `RUNTIME_PROFIT_PER_SLOT_HOUR_MINIMUM` (20,000gp/hr) would reject it at every cash stack, so it should never be in `merchableItems.json`. This filter ensures the list only contains items the plugin would actually buy under some cash-stack scenario.

**`MAX_TURNOVER_HOURS` cap (re-added at 6h)**: Secondary sanity check — rejects items with turnover ETA > 6h at the 50m allocation. The primary gate is the profit/hr filter above. At 6h, this doesn't filter any legitimate items (max turnover for a 20k profit/hr item is ~4h due to the quantity cap at 1h volume + 50% market share), but catches pathologically slow items if the profit/hr calculation has edge-case errors.

## Flip scoring

```js
item.flipScore = item.maxProfitPerSlotHour * Math.log1p(item.returnOnInvestmentPercentage);
```

- `maxProfitPerSlotHour` (`min(3h volume, limit) * profitMargin`) is the primary driver — it's cash-stack-independent (intrinsic quality) and already accounts for volume (high-volume items move more units per hour).
- `Math.log1p(ROI)` favours higher-ROI items with diminishing returns.
- The old `(1 - totalPurchasePrice / CASH_STACK)` penalty was **removed** — it distorted rankings by making expensive items look better at higher cash stacks.
- The old `turnoverPenalty` was **removed** — it used simulation-era `turnoverEtaMinutes` (which depends on allocation quantity), introducing a cash-stack dependency. `maxProfitPerSlotHour` already captures volume, making the penalty redundant.
- The ranking is now identical regardless of `CASH_STACK_MILLIONS`; only the item pool width changes (via the `purchasePrice > CASH_STACK` filter).

## Price clamping (`clampPrice`)

```js
return Math.round(Math.min(price, average * 1.05, average + 50000));
```

`clampPrices()` clamps **four** fields against their 2h averages:
`purchasePrice`, `rawSalePrice`, `lowballBasePrice`, and `salePrice`.
Clamping `rawSalePrice` (not just `salePrice`) is critical because
`calculateSalePrice()` is called **after** `clampPrices()` in the second
pass and recomputes `salePrice = floor(rawSalePrice - saleBufferAmount)`.
An unclamped `rawSalePrice` — e.g. a low-volume 5m avgHighPrice spike
that bypassed the 5m-vs-1h spike filter (volume ratio < 5%) — would
overwrite the clamped `salePrice` with the spiked value. This was the
root cause of the Rune platebody 48,190gp sell price (market ~38,400):
a single anomalous 5m trade set `rawSalePrice` to ~48,677, the spike
clamp was skipped due to low relative volume, and `calculateSalePrice`
then produced a 48,190gp sell target that would never fill. Clamping
`lowballBasePrice` similarly prevents `applyLowball()` (also called
after `clampPrices`) from bypassing the clamp via the stored base price.

## Staleness handling

Recent changes:

1. `dataFetchedAt` and `dataFetchedAtIso` are captured at the start of
   `getMerchableItems()` and added to every output item.
2. If `merchableItems.length === 0`, the script does **not** overwrite
   `merchableItems.json`; it preserves the previous file.
3. `data/merchable-items.ts` has two data validity safeguards via
   `isMerchableDataValid()`: (a) the JSON must contain ≥ 5 items, and
   (b) the newest `dataFetchedAt` across all items must be within the last
   10 minutes. If either check fails, the bot skips placing new buy offers
   (and frozen-item swaps) but still logs in to manage existing offers —
   collecting completed sells, aborting stale offers, and selling inventory.
   The overlay shows `[DATA STALE]`. On hot reload with valid data, new buys
   resume automatically.

## Known issues and design concerns

### 1. Expensive items and cash-stack awareness (RESOLVED)

Previously, `CASH_STACK` determined which items were included and how they were ranked. Items costing more than the cash stack were filtered out, and the `flipScore` penalised items that consumed a large fraction of the stack. This meant the same item had different rankings at different cash stacks.

**Fix**: `determine-flips.mjs` now runs at `CASH_STACK_MILLIONS = 50` to produce the widest item pool. The `flipScore` is cash-stack-independent (based on `maxProfitPerSlotHour * log1p(ROI) * turnoverPenalty`). The plugin evaluates each item at runtime via `evaluateItemAtRuntime(item, slotBudget)` — where `slotBudget = min(coins, floor(coins / emptySlots) * 2.5)` — computing the actual quantity the player can afford within the per-slot budget, the runtime ETA, and the runtime profit/hr. The runtime buy/sell ETAs are stored in the offer cache (`purchaseEtaMinutes`/`saleEtaMinutes` fields) via `recordBuyOffer`/`recordSellOffer`, so the stale checker and cache dump use accurate thresholds for the actual offer quantity, not the simulation quantity. The stale checker prefers the cached runtime ETA over the live simulation ETA from `merchableItems.json`. Reconstructed entries (after cache loss to a client restart) also use `computeRuntimeEtas(merch, slotQuantity)` to recalculate accurate ETAs from the actual offer quantity, rather than inheriting the 50m simulation ETAs — this prevents the stale checker from waiting far longer than it should for offers with smaller runtime quantities (e.g. Ancient essence at 124k units gets ~42min buy ETA instead of the 113min simulation ETA). The sell stale checker applies a **5min minimum ETA floor** (`SELL_ETA_FLOOR_MIN = 5`) so high-volume items with tiny runtime sell ETAs (e.g. Ancient essence at 0.8min for 4518 units) don't get aborted almost instantly — the mathematical ETA is correct for volume but doesn't account for the price being too high, and aborting after <1min creates a rapid abort/re-list cycle that wastes GE slots. The 0-progress sell absolute cap is **ETA-scaled** (`computeSellZeroProgressCap = clamp(eta * 0.5, 20, 60)` min) so long-ETA sells (e.g. 114min ETA) aren't aborted at 20min (18% of ETA) — fast items (≤40min ETA) get the 20min floor, slow items get up to 60min. **Sell-side stale aborts** are handled by the existing `reviseSellPrice()` mechanism — a progressive buy freeze is applied on abort completion (deferred from detection time to avoid inflation from interrupted abort flows). After a 0-progress sell abort, the item is immediately eligible for re-listing at a revised (lower) price — the freeze only prevents future buys, not the current sell re-list cycle. The revision schedule: revisions 0–1 reduce gross profit by 5%, revisions 2–3 by 8%, revisions 4–5 by 12%, revision 6 abandons the floor (price = buyPrice - 2), revision 8 final-dumps at buyPrice - 5. **Early abandon for floor-stuck items**: if an item is already at the tax break-even floor and still not selling, a margin-aware number of consecutive floor-hit revisions triggers an early abandon (drop to buyPrice - 2) instead of cycling at the same floor price for the full 6-revision schedule (~50+ minutes). The threshold is **margin-aware**: thin-margin items (< 10gp gross margin, e.g. Revenant ether at 5gp) abandon after **4 floor-hits** since abandoning bulk items is very costly (a 25k-unit ether abandon cost -120,000gp); thick-margin items (>= 10gp) abandon after **2 floor-hits** since the slot is worth more than waiting. The `floorHitCount` field on the cache entry tracks consecutive floor-hits and resets to 0 whenever a price revision actually changes the price. The sell ETA abort ratio minimum is 75% (raised from 35%) — high-value items have high Poisson noise and need more time to clear before revising. This actively chases the market down until the item sells, rather than holding it in inventory at the same price and hoping the market comes back — which risks larger losses if the market continues downward. **Floor-hit markers** in `reviseSellPrice` advance the revision count even when the price is already at the tax-break-even floor, so floor-stuck items can reach the abandon (rev 6) and final-dump (rev 8) thresholds instead of looping forever at the same price. The simulation-era `quantityToPurchase`, `totalPurchasePrice`, `actualProfitPerSlotHour`, and `turnoverEtaMinutes` fields in the JSON are kept for diagnostic reference but are NOT used for runtime decisions.

### 2. `calculateSlotCashAllocation` double-counts volume

`maxProfitPerSlotHour` already includes `threeHourAverageHourlyVolume` (via
`Math.min(volume, limit) * profitMargin`). `weightedProfit` then multiplies by
`threeHourAverageHourlyVolume` again. This magnifies differences between high and
low volume items.

### 3. `calculateQuantityToPurchase` ignores the number of GE slots

The script allocates cash per item as if each item gets its own slot, but there
are only 8 GE slots total. Buying 100 different items is impossible in practice,
but the script ranks them and the plugin tries to fill slots greedily. Cash-stack
allocation per item does not account for simultaneous slots.

### 4. Long-term crash detector can fail closed

`determineLongTermCrash` returns `false` (filters the item) if the API request
fails for any reason (network, rate limit, empty response). This is safe but can
silently remove otherwise good items. The 30d v2 response is cached per-item in
`item_long_term_crash_data.json` with a 24h TTL, so a transient network failure
on a given run falls back to the previous day's cached data rather than filtering
the item — only items with no cache entry (or a stale one) are at risk of being
filtered by a network blip.

### 5. `MAX_TURNOVER_HOURS = 2.5` is strict

Any item whose combined buy+sell ETA exceeds 150 minutes is rejected. This pushes
the script toward fast items but still allows high-price, low-volume items if the
volume estimate is generous.

## Design intent (user-confirmed)

- **Primary goal**: maximum **profit per hour**, not maximum ROI per flip or
  maximum number of flips.
- **Cash stack target**: `AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO` (currently
  0.125) is the *base* per-slot target. With a 10m stack the base allocation is
  1.25m per slot.
- **Scaling is allowed** for items that are both **very profitable AND have high
  turnover**. An 11k Chaos rune flip for 1 gp profit that turns over in 5 minutes
  and a 1m item that turns over 100k profit in 30 minutes can both be correct.
- **Slot target**: ~8 slots actively flipping (all GE slots used for buys).
  When a sell is needed, the sell scan dynamically frees a slot by aborting
  the 0-progress buy offer with the lowest projected profit/hr (oldest as
  tiebreaker — no loss since nothing was bought). This keeps the swap
  consistent with item selection (highest profit/hr first → sacrifice
  lowest profit/hr first).
- **Turnover-aware caps** (confirmed):
  - `turnoverEtaMinutes < 30` → max 80% of `CASH_STACK`
  - `30 <= turnoverEtaMinutes < 90` → max 50% of `CASH_STACK`
  - `turnoverEtaMinutes >= 90` → max 25% of `CASH_STACK`
- **Iterative allocation is preferred**: because ETA depends on quantity and
  quantity depends on allocation, the allocation should be computed iteratively.

## Implementation

The cash-allocation logic in `determine-flips.mjs` was refactored to be
**iterative, turnover-aware, and profit-per-slot-hour driven**.

### Helper functions

- `computeQuantityForAllocation(itemData, cashAllocation)` — returns
  `min(floor(allocation / purchasePrice), limit, floor(3hVolume))`.
- `computeEtasForQuantity(itemData, quantity)` — returns purchase/sale/turnover
  ETAs for a given quantity using the existing effective-volume formula.
- `computeProfitabilityForQuantity(itemData, quantity, turnoverEtaMinutes)` —
  returns `actualProfitPerSlotHour` and guards against zero/negative inputs.
- `getTurnoverCap(turnoverEtaMinutes)` — maps ETA to a max cash-stack share:
  - `< 30 min` → 80%
  - `30–90 min` → 50%
  - `> 90 min` → 25%

### Iterative allocation algorithm

For each candidate item:

1. `baseAllocation = max(AVERAGE_SLOT_CASH_STACK_ALLOCATION, purchasePrice)`.
2. Compute base quantity, base ETA, and base `actualProfitPerSlotHour`.
3. `scale = sqrt(actualProfit / averageActualProfitPerSlotHour)` (only scales
   above 1 for above-average items; dampened to avoid runaway values).
4. Iterate:
   - Compute quantity from current allocation.
   - Compute ETA.
   - `newAllocation = min(baseAllocation * scale, getTurnoverCap(eta), CASH_STACK)`.
   - Stop when the allocation stops changing significantly (<= 1000 gp).
5. Set `itemData.cashAllocation`, then compute final `quantityToPurchase`,
   ETAs, profitability, and `flipScore`.

### Key changes from the old logic

- **Removed volume double-counting**: `calculateSlotCashAllocation` no longer
  multiplies `maxProfitPerSlotHour` by `threeHourAverageHourlyVolume` a second
  time.
- **Uses actual profit per slot hour for scaling**: `actualProfitPerSlotHour`
  (post-ETA) is used instead of `maxProfitPerSlotHour` (pre-ETA).
- **Dead slow-item cap removed**: the old `if (turnoverEtaMinutes >= 60)` cap in
  `calculateQuantityToPurchase` was unreachable because ETA had not been
  computed yet; the new caps are applied inside the iterative allocation loop.
- **Extra JSON fields avoided**: the first-pass average is computed from a local
  `baseActualProfits` array rather than storing temporary data on `itemData`.

### Observed effect

With a 10m stack the latest run produced 42 items (up from 27) and no item
consumed more than ~4.2m GP. Examples:

- Chaos rune: 18,000 @ 103gp = 1.85m, 6 min turnover, 483k gp/hr
- Law rune: 18,000 @ 121gp = 2.18m, 17 min turnover, 181k gp/hr
- Tome of Fire (empty): 2 @ 1.65m = 3.3m, 23 min turnover (was 6 @ 9.94m)
- Odium ward: 1 @ 3.13m, 38 min turnover (was 3 units tying up ~9.4m)
- Sunfire fanatic chausses: 1 @ 3.71m, 42 min turnover (was 2 units tying up 7.5m)
- Mage's book: 1 @ 4.22m, 17 min turnover

The algorithm now preserves similar profit-per-slot-hour for expensive/slow
items while freeing up cash for additional slots.

## F2P / P2P membership handling

- `determine-flips.mjs` reads `mappingEntry.members` from the OSRS Wiki `/mapping`
  endpoint and stores `members: boolean` on every output item.
- `data/merchable-items.ts` exposes `members` on `MerchableItem` and
  `getFirstUnoccupiedMerchableItem` accepts an `isMembersWorld` flag and a
  `lowballTier` flag (`'non-lowball'`, `'lowball'`, or `'any'`).
- `grand_exchange/widgets.ts` already provides `isMembersWorld()` and
  `offerSlotCount()` (3 slots F2P, 8 P2P).
- `grand_exchange/auto-loop.ts` passes `isMembersWorld()` to
  `getFirstUnoccupiedMerchableItem`, so F2P worlds only consider F2P items.

## F2P curated flip list

A separate F2P data path bypasses the normal filter pipeline. It uses a
curated list of 10 high-volume F2P items (`F2P_CURATED_ITEM_IDS` in
`determine-flips.mjs`) and applies a simple formula:

```
sellPrice = 1h avgHigh
tax = sellPrice < 50 ? 0 : floor(sellPrice * 0.02)
buyPrice = sellPrice - tax - 1  (fixed 1gp margin)
```

**5m market cap**: The buy price is capped at `(5m low - 1)` to prevent
buying at or above the current market. When the 1h avgHigh lags a downward
market move, the formula's buy price can be at the current market price,
causing an instant fill (not a lowball). The cap ensures the bot always
lowballs below the current market. If the capped price leaves no margin
(buyPrice < 1), the item is skipped.

Output goes to `f2pMerchableItems.json` (separate from `merchableItems.json`)
so the runtime can switch between P2P and F2P pools via `autoMode === 3`.
The runtime calls `setF2pMode(true)` which relaxes runtime thresholds.

## Relationship to plugin

`data/merchable-items.ts` imports `merchableItems.json` at build time and exposes
`getMerchableItems`, `getMerchableItem`, `getMerchableItemById`,
`getFirstUnoccupiedMerchableItem`, `getFirstPartialBuyItem`, `isLowballItem`,
and `isMerchableDataValid`.
The plugin uses `purchasePrice`, `salePrice`, `quantityToPurchase`, `limit`, and
`totalPurchasePrice` from each item to place GE offers. The `dataFetchedAt`
timestamp is used by `isMerchableDataValid()` as a freshness safeguard — if the
newest `dataFetchedAt` is older than 10 minutes, the bot skips new buy offers
but still logs in to manage existing offers. The `lowballPercent`, `lowballAmount`,
and `lowballBasePrice` fields are used by the buy scan to prioritise instant-fill
(non-lowball) items over slower lowball items — see "Lowball buy-scan tiering" below.

### Lowball buy-scan tiering

The auto-loop buy scan uses a 5-tier priority order to ensure GE slots fill with
instant-buy items before slower lowball offers are attempted:

1. **Non-lowball, non-frozen** — `getFirstUnoccupiedMerchableItem(..., 'non-lowball')`
2. **Non-lowball, frozen fallback** — `getFrozenFallbackItem(..., 'non-lowball')`
3. **Lowball, non-frozen** — `getFirstUnoccupiedMerchableItem(..., 'lowball')`
4. **Lowball, frozen fallback** — `getFrozenFallbackItem(..., 'lowball')`
5. **Partial fallback** — lower profit/hr threshold (5k vs 20k), longer max turnover (240min vs 150min)

**Pre-sleep lowball priority**: During the final 30 minutes before nightly
sleep (`getMinutesUntilNightlySleep(bot) ≤ 30`), the tier order reverses to
lowball-first (tiers 1↔3, 2↔4 swap), and the lowball primary scan's turnover
cap is relaxed from 120min to 240min. Lowball offers (buy below market, slower
fills, higher margins) are better suited for the ~4h unattended sleep window.
Invalid, disabled, expired, or already-started nightly schedules do NOT
activate pre-sleep mode (`getMinutesUntilNightlySleep` returns `Infinity`).
The partial fallback also reverses to lowball-first during pre-sleep. The
diagnostic log `Auto: pre-sleep lowball priority active — Xmin until nightly
sleep, lowball turnover cap relaxed to 240min` fires when active.

**Slow Mode preferred tier**: When `autoMode === 2` (Slow) AND pre-sleep is
NOT active, a tier 0 is prepended ahead of the normal 5-tier order. Tier 0
targets lowball items whose runtime **buy ETA** falls in the 30–60 minute
range (`SLOW_PREFERRED_MIN_BUY_ETA_MINUTES`/`SLOW_PREFERRED_MAX_BUY_ETA_MINUTES`,
using the same relaxed 240min turnover cap as pre-sleep). These slower,
higher-margin fills suit the ~30-minute account login cadence (accounts are
effectively logged in approximately every 30 minutes, so a 30–60min buy ETA
aligns with the next login window). If tier 0 finds nothing, the scan falls
through to the normal tier order (1–5) unchanged — fast non-lowball flips
remain eligible. The frozen swap-out path (all slots occupied) also tries
the slow preferred tier first when Slow Mode is active. Slow Mode does NOT
alter login/logout/break/rotation/hop timing; it only changes buy-offer
item selection. Pre-sleep takes precedence over Slow Mode when both would
apply (pre-sleep is the stronger condition and already does lowball-first
with the 240min cap). The diagnostic log `Auto: slow mode preferred tier
active — targeting lowball items with buy ETA 30-60min (turnover cap 240min),
normal tier order as fallback` fires when active. The `minBuyEtaMinutes`/
`maxBuyEtaMinutes` optional parameters on `getFirstUnoccupiedMerchableItem`,
`getFirstPartialBuyItem`, `getFrozenFallbackItem`, and
`getFrozenFallbackPartial` implement the ETA band filter (undefined = no
filter, preserving existing behavior for all other callers).

**Absolute profit floor (all tiers)**: Every scan tier enforces `runtimeTotalProfit ≥ RUNTIME_MIN_ABSOLUTE_PROFIT_GP` (20k). This prevents placing a buy offer for a tiny quantity of an item that would earn less than 20k even if it fills perfectly — e.g. 1106x Death rune @ 1gp profit = 1.1k total, or 250k leftover → 5 snapdragon seeds → 1k profit. Short-ETA items can show high profit/hr despite tiny absolute profit (e.g. Death rune at 0.3min ETA shows ~221k/hr), so the profit/hr filter alone is insufficient. The floor ensures a slot and ~30s of click time is never wasted on sub-20k offers.

**Effective volume floor (all tiers)**: `evaluateItemAtRuntime` rejects items whose effective volume (min of buy/sell, after 50% market share + 15% 2h buffer + lowball penalty) is below `RUNTIME_MIN_EFFECTIVE_VOLUME` (15 units/hr). Small GE limits can keep the modeled ETA under the 120min turnover cap despite terrible volume (e.g. Dark bow at 6/hr, Master wand at 3/hr, Heavy ballista at 6/hr), so the ETA cap alone doesn't catch them — these items waste GE slots at 0% progress for 30+ minutes before being aborted. The floor filters ~110 thin-volume items from the pool, leaving ~92 — large enough for multi-account scaling. Sell-side stale detection and sell ETA are unaffected (items already held still sell normally).

**All 8 slots for buys**: All GE slots are available for buy offers — no slots
are reserved for sales. When a sell is needed but all slots are occupied, the sell
scan aborts the 0-progress buy offer with the lowest projected profit/hr (oldest
as tiebreaker — nothing bought, so no loss) to free a slot. This maximizes buying
throughput while keeping items moving, and keeps the swap decision consistent with
item selection (highest profit/hr first → sacrifice lowest profit/hr first).

**Per-slot budget with profit-scaled soft cap**: The available coins are divided
by the number of empty GE slots to get a `baseSlotBudget`, then multiplied by
`MAX_SLOT_BUDGET_MULTIPLIER = 2.5` to get the `slotBudget` passed to the scan.
This prevents a single expensive item from consuming all the cash when there are
multiple empty slots to fill — with 6 empty slots and 15m coins, the budget is
`min(15m, floor(15m/6) * 2.5) = 6.25m`, so a 14.8m item is skipped in favour of
cheaper items that fill multiple slots. With 1 empty slot, the budget is the full
coin stack (nothing else to fill).

**Absolute profit/hr ranking**: Within each tier, items are ranked by
`runtimeProfitPerSlotHour` (absolute profit per slot per hour). The bot picks the
highest-earning item first, then fills remaining slots with cheaper items using leftover
coins — this maximises total profit across all slots. A minimum profit-per-coin-hour
floor (0.005, i.e. 5k profit per 1m coins per hour) prevents wasting capital on items
that earn very little per coin invested. The absolute profit/hr filter (≥ 20k) ensures
cheap low-quality items aren't picked. The absolute total profit floor (≥ 20k, see above)
ensures items with tiny quantities aren't picked despite high profit/hr.

Lowball items (`lowballPercent > 0`) buy below market price and fill slower; their
ETA is adjusted by a `4.0x lowball%` volume factor heuristic, but the real fill rate
depends on the price distribution below the lowballed price, making profit-per-hour
less reliable than non-lowball items. The partial-quantity fallback and frozen
swap-out follow the same non-lowball-first tiering (reversed to lowball-first
during the pre-sleep window — see "Pre-sleep lowball priority" above; in Slow Mode
the slow preferred tier is tried first — see "Slow Mode preferred tier" above).

Changes to `determine-flips.mjs` affect the plugin only after `npm run build`
re-bundles the JSON.
