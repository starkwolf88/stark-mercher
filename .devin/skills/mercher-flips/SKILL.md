# Stark Mercher — `determine-flips.mjs` deep analysis

## Native handle exhaustion — NEVER loop over native SDK queries

**CRITICAL rule for all Titan plugins (mercher, mixology, herblore).** Do NOT write `for`/`while` loops that call `titan.queries.widgets(grp).toArray()`, `titan.queries.objects().toArray()`, `titan.queries.npcs().toArray()`, or any other `titan.queries.*().toArray()` per iteration. Each `toArray()` creates native handle objects. The JS engine does NOT GC between loop iterations, so handles accumulate simultaneously. The native handle table is FINITE — once exhausted, EVERY subsequent native SDK call (overlay, `onGameTick`, `onMainLoop`, `onClientTick`, widget/object lookups) throws `null` simultaneously, producing the cascade:

```
onMainLoop error: null
onGameTick error: null
onClientTick error: null
onDisable error: null
auto-disabled after 3 consecutive failures
```

The ONLY recovery is toggling the plugin off/on (reinitialises the native context).

**Historical cause (mixology)**: A "diagnostic" 1200-group widget scan in `antiban/login.ts` `findTitleWidget()` iterated groups 0-1199 calling `titan.queries.widgets(grp).toArray()` each iteration. Each scan created 12,000-60,000 native widget handles; after a few 60-second-throttled scans, the handle table was corrupted and every callback threw `null`. The scan was removed; `findTitleWidget()` now uses `titan.state.widgets.find(packedId)` then `findByText(text)` as fallback.

**Rules**:
1. Use targeted lookups — `titan.state.widgets.find(packedId)`, `titan.state.widgets.findByText(text)`, `titan.queries.widgets(specificGroup).toArray()` — never unscoped or looped queries.
2. If a diagnostic scan is ever needed, run it ONCE via Titan Shell (`titan.log(...)`) from the user's manual input, NOT from plugin callback code.
3. Any `toArray()` call inside a loop is a bug.
4. `titan.queries.widgets().textContains(...).toArray()` (unscoped recursive widget query) is also expensive (500-1000ms+) and should be replaced with `findByText`.

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
| `CASH_STACK_MILLIONS` | 10 (was 87) | Total GP available for flipping. User tunes this to the account's actual cash. |
| `CASH_STACK` | `CASH_STACK_MILLIONS * 1e6` | Numeric cash stack. |
| `SALE_BUFFER_PERCENTAGE` | 0.01 | Extra 1% safety margin removed from sell price to protect against downward movement. |
| `AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO` | 0.20 (was 0.25) | Target cash per GE slot if all slots were equal (≈ 5 slots). |
| `AVERAGE_SLOT_CASH_STACK_ALLOCATION` | `CASH_STACK * ratio` | Base GP allocated per slot (e.g. 10m stack → 2m/slot). |
| `MARKET_SHARE_ASSUMPTION_PERCENTAGE` | 35 | Used in ETA calculation: assume the bot captures 35% of the observed buy/sell volume. |
| `MAX_TURNOVER_HOURS` | 2.5 | Reject items whose combined buy+sell ETA exceeds 150 minutes. |
| `TWO_HOUR_VOLUME_BUFFER_PERCENTAGE` | 15 | Reduce 2h volume by 15% before using it for ETAs (safety margin). |
| `PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD` | 20000 | `actualProfitPerSlotHour` must be ≥ 20k. |
| `ROI_MINIMUM_PERCENTAGE_THRESHOLD` | 1 | `returnOnInvestmentPercentage` must be ≥ 1%. |

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
  │   determineFiveMinuteVsOneHour*Change()  reject large 5m vs 1h price spikes/drops
  │   applyLowball()                         volume-scaled lowball on buy price (1h vol proxy)
  │   calculateSalePrice()                   tax (0 if < 50gp) + buffer
  │   calculateProfitMargin()                profitMargin; filter if < 1 or limit*profit < 10k
  │   → filteredItems[]
  ├─ getTimeSeriesData()                     fetch/update hourly series, cached locally
  ├─ convertTimeSeriesData()                 compute 2h/3h/4h/7d averages and 4h crash data
  ├─ for each item with time series:
  │   validatePurchasePrice()                fall back to 2h/3h averages if no 5m
  │   validateSalePrice()
  │   clampPrices()                          cap price at 2h average + 5%/50k
  │   applyLowball()                         re-apply lowball with accurate 3h volume (resets to base first)
  │   calculateSalePrice()                   recompute tax/buffer after clamping
  │   calculateProfitMargin()
  │   determineIrregularVolumes()            reject 3h volume too far from 7d baseline
  │   determineTrendSlope()                  reject 3+ recent price drops or 2+ drops + 1 flat
  │   determineSalePriceSpike()              reject 1h/3h sale price > 7d baseline
  │   determinePurchasePriceDrop()           reject 1h/3h purchase price < 7d baseline
  │   calculateMaxProfitPerSlotHour()        maxProfitPerSlotHour = min(3h volume, limit) * profitMargin
  │   → filteredItemsBeforeCashAllocation[]
  ├─ compute averageProfitPerSlotHour
  ├─ for each item:
  │   calculateSlotCashAllocation()          core cash allocation logic
  │   calculateQuantityToPurchase()          quantity, totalPurchasePrice
  │   calculateEtas()                        buy/sell/turnover ETAs (reduced buy vol for lowball)
  │   calculateProfitability()               actualProfitPerSlotHour, ROI, totalProfit
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
  "2": { "name": "Steel cannonball", "buy": 249, "sell": 256, "fetchedAt": 1788175308405 },
  ...
}
```

- ~1,800–3,000 entries (every item with valid 1h data + mapping name)
- Written every run regardless of `merchableItems.length` (the 1h data is always available)
- Consumed by `data/price-history.ts` in the plugin as a fallback sell-price source for inventory items that aren't in `merchableItems.json` or the offer cache (e.g. orphaned items after a long script stop or a JSON refresh during sleep)

## Volume-scaled lowball

Instead of buying at the 5m average low (instant-buy price), the script applies a small lowball to the buy price. High-volume items have a wide price distribution — many trades happen below the average low, so a small lowball still fills quickly.

**Lowball tiers** (based on 3h average hourly volume, 1h volume as fallback in first pass):

| 3h avg volume | Lowball % |
|---|---|
| > 200k/hr | 2% |
| 50k–200k/hr | 1.5% |
| 10k–50k/hr | 1% |
| < 10k/hr | 0% (buy at market) |

**Gate**: Only applied when `min(volume, limit) >= 5000` — targets high-quantity items where a small per-unit margin adds up.

**ETA adjustment**: Effective buy volume is reduced by `1.5x lowball%` (e.g., 2% lowball → 97% of volume fills the offer). This is conservative.

**Idempotency**: `applyLowball` stores `lowballBasePrice` (the pre-lowball price) so the second pass can reset and re-apply without stacking.

**Output fields**: `lowballPercent`, `lowballAmount`, `lowballBasePrice` are written to `merchableItems.json`.

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
5. The ratio `weightedProfit / averageProfitPerSlotHour` lets highly profitable items receive more than the base 20% slot allocation.
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

The bot assumes it captures 35% of observed volume. ETA is proportional to `quantityToPurchase` and inversely proportional to effective volume per minute.

## Profitability calculation

```js
itemData.actualProfitPerSlotHour = (itemData.quantityToPurchase * itemData.profitMargin) * (60 / itemData.turnoverEtaMinutes);
itemData.returnOnInvestmentPercentage = (itemData.profitMargin / itemData.purchasePrice) * 100;
itemData.totalProfit = itemData.profitMargin * itemData.quantityToPurchase;
```

`actualProfitPerSlotHour` is the expected profit per hour once the full offer cycles.
`returnOnInvestmentPercentage` is the profit margin as a percent of purchase price.

## Flip scoring

```js
const turnoverPenalty = Math.exp(-Math.pow(item.turnoverEtaMinutes / 30, 2));
item.flipScore = item.actualProfitPerSlotHour
               * Math.log1p(item.returnOnInvestmentPercentage)
               * (1 - Math.min(item.totalPurchasePrice / CASH_STACK, 1))
               * turnoverPenalty;
```

- `actualProfitPerSlotHour` is the main driver.
- `Math.log1p(ROI)` favours higher-ROI items but with diminishing returns.
- `(1 - totalPurchasePrice / CASH_STACK)` penalises items that tie up a large share of the cash stack.
- `turnoverPenalty` strongly penalises slow-turnover items (exponential of negative squared ETA/30).

## Price clamping (`clampPrice`)

```js
return Math.round(Math.min(price, average * 1.05, average + 50000));
```

Purchase and sale prices are capped at the 2h average plus the smaller of 5% or 50k.
This prevents outliers from distorting profit calculations.

## Staleness handling

Recent changes:

1. `dataFetchedAt` and `dataFetchedAtIso` are captured at the start of
   `getMerchableItems()` and added to every output item.
2. If `merchableItems.length === 0`, the script does **not** overwrite
   `merchableItems.json`; it preserves the previous file.
3. `data/merchable-items.ts` filters out items whose `dataFetchedAt` is older than
   10 minutes at plugin runtime.

## Known issues and design concerns

### 1. Expensive items consume the whole cash stack

With `CASH_STACK = 10m` and `AVERAGE_SLOT_CASH_STACK_ALLOCATION = 2m`, the script
still outputs items like:

- Tome of fire (empty): 6 × 1.65m = 9.94m
- Uncharged toxic trident: 3 × 3.18m = 9.53m
- Sunfire fanatic chausse: 2 × 3.77m = 7.54m

Root cause: `calculateSlotCashAllocation` can scale up to `CASH_STACK` and the
50% slow-item cap in `calculateQuantityToPurchase` is dead code because
`turnoverEtaMinutes` is computed later.

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
  0.20) is the *base* per-slot target. With a 10m stack the base allocation is
  2m per slot.
- **Scaling is allowed** for items that are both **very profitable AND have high
  turnover**. An 11k Chaos rune flip for 1 gp profit that turns over in 5 minutes
  and a 1m item that turns over 100k profit in 30 minutes can both be correct.
- **Slot target**: ~5 slots actively flipping, with ~3 slots used for selling
  items at any given time (8 total GE slots, members).
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
  `getFirstUnoccupiedMerchableItem` accepts an `isMembersWorld` flag.
- `grand_exchange/widgets.ts` already provides `isMembersWorld()` and
  `offerSlotCount()` (3 slots F2P, 8 P2P).
- `grand_exchange/auto-loop.ts` passes `isMembersWorld()` to
  `getFirstUnoccupiedMerchableItem`, so F2P worlds only consider F2P items.

## Relationship to plugin

`data/merchable-items.ts` imports `merchableItems.json` at build time and exposes
`getMerchableItems`, `getMerchableItem`, `getMerchableItemById`, and
`getFirstUnoccupiedMerchableItem`. The plugin uses `purchasePrice`, `salePrice`,
`quantityToPurchase`, `limit`, and `totalPurchasePrice` from each item to place GE
offers. The `dataFetchedAt` timestamp is used to ignore stale data.

Changes to `determine-flips.mjs` affect the plugin only after `npm run build`
re-bundles the JSON.
