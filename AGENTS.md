# Stark Mercher Bot — Strict Rules

## User build preference

- Do **not** run `npm run build`, `npm run watch`, or any other build/compilation command unless the user explicitly asks. The user will build the plugin manually when they are ready.
- `npm run typecheck` runs `tsc --noEmit`. The codebase has pre-existing type errors; new errors introduced by a change must be fixed.
- Standard verification after code changes: `npm run typecheck`, `npm run state-guard`, `npm run test:scenarios`, `npm run test:integration`. Do not run these unless explicitly asked.

## File / module layout

- `stark-mercher.ts` — main plugin class, settings, state, `onEnable`, `onGameTick`, `tickLogic`.
- `general/timing.ts` — `setAction`, `canPerformAction`, `shouldWait`; tick-based action throttling with backwards-tick recovery.
- `general/state.ts` — `sanityCheckState` (stub — add per-field stale-state corrections here as state is introduced).
- `general/lifecycle.ts` — `onEnable`, `terminate` helpers; resets all state including auto-loop state.
- `general/state-persist.ts` — offer cache persistence via hidden JSON setting (mixology-style per-account). `loadOfferCache`, `saveOfferCache`, `OfferCacheData`, `OfferCacheEntry`.
- `general/debug.ts` — debug widget logging.
- `general/variables.ts` — shared variables.
- `data/merchable-items.ts` — typed reader for `merchableItems.json` (inlined at build time by esbuild). `getMerchableItems`, `getMerchableItem`, `isMerchable`, `getFirstUnoccupiedMerchableItem`, `MerchableItem`.
- `data/offer-cache.ts` — `OfferCacheManager` wrapping the persisted cache with price revision logic (0.05% reduction capped at 5% of gross profit, min 1 gp, never below buyPrice+1) and Wiki API stub. `fetchWikiPrice` (stub — URL not yet configured).
- `antiban/humanised-delay.ts` — `DelayProfile`, `generateDelayProfile`, `setDelayProfileForAccount`, `createDelay`; per-account deterministic humanised delay function inspired by mixology's anti-ban layers (jitter, hesitation, outlier, jitter amplification).
- `input/typing.ts` — `humanType`, `isTyping`, `cancelTyping`, `setTypingProfile`, `setTypingProfileForAccount`; humanised keyboard typing with per-character delays.
- `input/typing-profile.ts` — `TypingProfile` (`baselineMs`, `jitterMs`), deterministic per-account profile generation via djb2 hash + mulberry32 PRNG.
- `grand_exchange/buy-offer.ts` — `BuyOfferFlow` multi-tick state machine for placing a buy offer from start to finish (21 steps).
- `grand_exchange/sell-offer.ts` — `SellOfferFlow` multi-tick state machine for placing a sell offer (18 steps).
- `grand_exchange/abort-offer.ts` — `AbortOfferFlow` multi-tick state machine for aborting an offer and collecting (9 steps).
- `grand_exchange/auto-loop.ts` — automated merching loop state machine. `autoLoopTick`, `createAutoLoopState`, `resetAutoLoop`, `AutoLoopState`, `AutoLoopPhase`. Loop order: GE-open check → collect → stale offers → sell → buy.
- `grand_exchange/actions.ts` — GE click, typing, Enter, quantity, price, confirmation helpers.
- `grand_exchange/widgets.ts` — GE widget reads and state predicates (`isGeOpen`, `isSearchPromptShown`, `isPricePromptShown`, `scanSearchResults`, `findEmptyOfferSlot`, `isSlotOccupied`, `offerSlotCount`, `auditGeState`, `getOfferSlotState`).
- `grand_exchange/index.ts` — re-exports GE modules.
- `grand_exchange/clerk.ts` — GE access: `findClerk` (NPC), `findGeBooth` (tile object with "Exchange" action), `findExchangePoint` (nearest of clerk/booth), `openGe`, `nearGrandExchange`, `walkToGe`.
- `grand_exchange/constants.ts` — GE widget IDs and constants.
- `grand_exchange/pricing.ts` — GE pricing logic.
- `widgets/widget-functions.ts` — widget utility functions.
- `widgets/widgets.ts` — widget definitions.
- `titan-plugin-sdk.d.ts` — Titan API declarations and settings APIs.
- `titan-gamevals.d.ts` — Titan game value declarations.

Module functions receive the bot instance as their first argument.

## SDK safety

- **VERY IMPORTANT. Do not use anything in the SDK that would risk bans by not using natural human mouse movement/clicks** — notably `invokeMenuAction` with `skipClick: true`, and any other API that bypasses the synthetic click phase (e.g. raw packet dispatch, `MenuOptionClicked.replaceWith()` with `skipClick`). All interactions must go through `interact()`, `useOn()`, or `WidgetState.interact()`, which include synthetic clicks at the target's screen position.
- Before implementing any feature or change that uses Titan SDK APIs, consult `titan-plugin-sdk.d.ts` to verify the available methods, signatures, and read-only vs writable state.
- If a new Titan SDK method or query returns dynamic data whose shape is not 100% certain, provide the exact one-liner to run in Titan's Shell and ask the user to confirm the returned object before using it in the plugin code. Anything run in Titan's Shell must be a single one-liner (no multi-line scripts). **All shell test commands must be wrapped in `titan.log(...)`** so the output is visible in the client log.

## Humanisation / anti-ban

- **Always keep humanisation / anti-ban in mind** for all changes (timings, fatigue, breaks, micro-AFKs, mistakes, etc.).
- The `createDelay(base, triggerChance)` function in `antiban/humanised-delay.ts` is the single entry point for humanised delays. Use it between any actions in the flow. `base` is clamped to minimum 1. `triggerChance` (0-100) is the % chance the humanisation layers fire on top of the base.
- The `DelayProfile` is deterministic per account name (same djb2/mulberry32 pattern as `typing-profile.ts`). Generate it via `setDelayProfileForAccount(playerName)` at startup.
- Humanisation layers (inspired by mixology): reaction bias, jitter, hesitation multiplier, delay outlier (with nested outlier), jitter amplification. These fire only when the trigger chance succeeds.
- The `humanType()` function in `input/typing.ts` already uses profile-derived per-character timing. The GE buy flow uses `typeString()` which routes through `humanType()`.
- Whenever a new humanisation / anti-ban profile setting is added, also add it to any profile summary logger so it is visible.

## esbuild does not type-check

- The build pipeline uses esbuild, which strips types via transpilation only — it does NOT do type analysis. A missing import (e.g. calling a function that was never imported) compiles cleanly and only fails at runtime when the line executes. Always run `npm run typecheck` after changes to catch these. When adding a function call, verify the function is imported in the same file.

## Robustness

- **Always be mindful of potential lag/client misclicks from the user when looking at the client/disconnections when creating code.** Avoid timed delays and rely on robust state game changes before continuing code logic.
- **Keep performance in mind** with any code we develop. For example, does something need to execute every single tick? Or can it be more efficient?
- Before making any amendments to existing code, analyse all existing code with the proposed changes and be as close to 100% sure as possible that those changes will not cause bugs/issues with any other code.
- When a change touches state or decisions that are shared across multiple modules, do not rely only on `npm run state-guard` and `npm run test:scenarios`. Explicitly trace all callers of the changed functions, inspect the shared `bot` state they read and write, and confirm the change does not regress `tickLogic` or any related path. Also remove or update any `AGENTS.md` or `global_rules.md` entries that become stale because of the change.
- When the user explains how the game (OSRS / the Titan client) handles something, add that fact to `global_rules.md` immediately so future code changes can use that understanding and avoid bugs.

## Client tick reset after disconnect/relogin/world hop

When the client disconnects and logs back in — whether from a raw disconnect, a world hop that involved a logout/login cycle, or any other reconnection — the client tick counter (`titan.state.client.tick`) can reset to a smaller value. All tick-based state becomes stale: `actionStartTime` is ahead of the current tick, making `ticksSinceAction = tick - actionStartTime` negative. Since `canPerformAction()` checks `ticksSinceAction >= actionDelay`, a negative value can never satisfy this, so the bot locks forever.

- `canPerformAction()` in `general/timing.ts` has a defensive check: if `ticksSinceAction < 0`, it resets action state and returns `true`.
- `onGameTick` in `stark-mercher.ts` also detects `lastActionTick > tick` and resets stale action state.
- Any new tick-based state field must handle a backwards tick counter reset.

## State-change bug-prevention rules

These rules exist because the most common bugs are state values that outlive the event that set them.

### 1. State lifecycle map before editing

For any `bot.*` field that is added or touched, state the following in a **state impact note** before committing:
- Field name
- What sets it
- What clears it (exact success, failure, login, `onEnable`, `resetInFlightActionState`, or the handler that ends the action)
- Which files were changed

### 2. Reset checklist

Every new transient state must be reset in **all** of these places unless there is an explicit reason not to:
1. `onEnable()`
2. `resetInFlightActionState()` (break/hop/world transition — not yet implemented, add when needed)
3. The handler that naturally ends the action (e.g. flow completion, flow failure)
4. The login/settle path if it relates to breaks or post-login UI (not yet implemented, add when needed)

### 3. Defensive invariants in `tickLogic`

`sanityCheckState(bot, tick)` is called at the top of `tickLogic()`. It auto-corrects cheap stale state. New stale-state fixes go here; they must be logged.

### 4. Trace-first for state changes

When adding or changing state, add a `debugLog`/`humanLog` at the set and the reset. Do not rely on silence to mean success. The `logDebug` UI toggle controls whether debug logs are printed.

## Break and hop safe boundaries (for future implementation)

When breaks and world hopping are implemented, the only blocker for a hop or break should be the player actively animating or moving. `getSafeBoundaryReason()` should check only:
1. `bot.hopInProgress` — a world hop is already in flight.
2. `!isPlayerIdle(bot)` — the player is animating or moving.
3. **Idle buffer** — player has been idle for less than 2 ticks.

All other state (held items, GE interface, location) either persists across hops/logouts or is transient. `shouldPauseForHopBoundary(bot)` should pause `tickLogic()` to prevent starting new actions while a hop or break is waiting to dispatch.

## Login retry timeout (for future implementation)

When automated login is implemented, `tryStageAndSubmitLogin()` should track the first attempt timestamp. If 60 seconds elapse without login, the bot terminates. A 3-attempt `submitCredentials` limit within 1 minute is a faster failure path. `loginIndex === 10` means staged; `loginIndex === 9` means game update — retry every 30-60 seconds randomly, bypassing the 60-second timeout.

## Reset Break ends an active break immediately (for future implementation)

When breaks are implemented, `resetBreak()` should call `resumeFromBreak()` when `breakPhase === 'BREAK_ACTIVE'`, instead of only clearing session targets.

## Bank interactions (for future implementation)

When banking is implemented, the following rules apply (adapted from mixology):

- **Bank chest is a toggle — no doubleClick**: The GE clerk / bank chest is a toggle — clicking it when open closes it. `openBank()` must NOT use `doubleClick: true`. The `doubleClick` option is only safe for idempotent targets.
- **Bank open click in-flight guard**: `bot.bankOpenClickInFlight` is set to `true` inside `openBank()` before the click dispatch. While true, `openBank()` returns early. Cleared when bank opens, on timeout, on rejection, and in `resetInFlightActionState()`.
- **Bank interface must not be closed by the inventory-open guard**: If `onGameTick()` has a pre-`tickLogic` block that sends Escape or clicks the inventory tab, it must be guarded by `!titan.utils.bank.isOpen` — the bank has its own inventory view.
- **Bank open delay**: When `bankRun()` first observes `bank.isOpen`, wait 1 tick 95% of the time, or 2-3 ticks the remaining 5%, before starting any withdrawal. This stops the bot from withdrawing on the same tick the bank interface appears.
- **Bank close via Escape**: Use `titan.keyboard.sendKey(titan.keyboard.Key.Escape)` instead of `titan.utils.bank.close()`. The `bank.close()` API can throw "widget arg11 builder was unavailable"; Escape is a safer, synchronous close that takes the same WndProc path as a hardware key press.
- **Banking actions excluded from fatigue scaling**: Banking is a simple UI interaction not affected by fatigue. If fatigue scaling is implemented, banking actions (`banking`/`depositing`/`withdrawing`/`closing`) must be excluded from fatigue-based delay multipliers. A tired player still clicks deposit/withdraw quickly.
- **Banking actions excluded from jitter amplification**: A spontaneous 3-18s pause mid-banking is unnatural. Humans pause before opening or after closing the bank, not mid-banking. If jitter amplification is implemented, banking actions must be excluded.
- **Withdraw-X dialog handling**: `titan.utils.bank.withdrawItemAmount(itemId, amount)` opens the OSRS "Withdraw-X" dialog but does not type the amount or press Enter. However, it can also withdraw directly without opening a dialog (when the bank's last-used X amount matches). Handle both paths: (1) call `withdrawItemAmount`, (2) check if the dialog is open, (3) type the amount via `titan.keyboard.typeString()` and press Enter in the completion callback, OR proceed immediately if a direct withdrawal happened.
- **Withdraw-X dialog detection**: `titan.utils.bank.isSearchOpen` may not reliably return `true` for the amount entry dialog. Fall back to `titan.state.widgets.findByText('Enter an amount')` (direct native lookup, sub-millisecond) instead of expensive recursive widget queries.
- **Withdraw-X set once per script run**: The bank remembers the last X amount. After typing an amount once, `withdrawItemAmount(id, amount)` withdraws directly without opening a dialog. Track this with a flag so subsequent withdrawals skip the dialog detection phase.
- **Bank-open guard on `withdrawing`**: The `withdrawing` case must check `titan.utils.bank.isOpen` before querying bank contents. After a break or hop, the bot resumes in its pre-break state but the bank is closed — `bank.contains()` returns false when the bank isn't open, causing false "out of supplies" termination.

## Current bot behaviour

- The plugin has two modes via the `autoMode` combo setting:
  - **Manual Test** (default): The bot idles and only responds to the test buttons (Run Buy Test, Run Sell Test, Run Abort Test, slot checks). This is the original behaviour.
  - **Auto Merch**: The bot runs the automated merching loop (GE-open check → collect → stale → sell → buy). Manual test buttons still work in this mode — they are checked before the auto loop runs.
- When the "Run Buy Test" button is clicked, `buyTestRequested` is set and a `BuyOfferFlow` starts on the next ready tick.
- In Manual Test mode, the GE interface must be opened manually before clicking "Run Buy Test". In Auto Merch mode, the bot opens GE automatically via the nearest clerk or booth.
- Configurable test parameters: item name (string, default "Air rune"), quantity (string, default "2"), price (string, default "5"). These are string settings parsed and validated at runtime.
- The `BuyOfferFlow` is a 21-step state machine. Each action step calls `createDelay(1, 100)` (base 1 tick, 100% trigger chance) and stores the result in `lastDelay`. The caller uses `flow.lastDelay` in `setAction()`.
- When the flow reaches `done` or `failed`, the bot logs the result, clears the flow, and returns to idle.
- `onGameTick` always runs `gameTick`; it does not require `isRunning` to be true.
- Debug logging is controlled by a `logDebug` boolean UI setting (default `false`). When enabled, each action step logs what it's about to do before dispatching.
- The offer cache is persisted in a hidden string setting (`offerCache`) and survives restarts/hot-reloads. It is scoped per in-game player name.

## OSRS Grand Exchange buy offer flow (in-game mechanics)

1. Click "Create buy offer" button on any empty slot (1-8 for members, 1-3 for F2P) in the GE main UI.
2. The "What would you like to buy?" UI shows in the chatbox area — this is when we type the item name.
3. As you type, all items containing the typed text appear in a scrollbox in the chatbox UI area — results update live with each character.
4. The item is clicked from the results list — `scanSearchResults(itemName)` finds the exact case-insensitive match and `clickSearchResult(matchIndex)` clicks it by child slot. Pressing Enter is NOT used (it selects the first result, which can be wrong — e.g. "Charcoal" when searching "Coal").
5. The selected item is loaded into the "Set up offer" window — this is where quantity and price are configured. Defaults: quantity 1, price = market price.
6. The "..." button on quantity or price is clicked, which displays "How many do you wish to buy?" or "Set a price for each item" UI dialogue in the chatbox area respectively.
7. After typing a quantity/price and pressing Enter, the "Set up offer" UI updates with the specified values.
8. The "Confirm" button is pressed to place the offer.
9. The "Set up offer" UI closes and we're back at the main GE UI.

**Important**: Search results appear *while typing* (before Enter), not after Enter. The buy-offer flow scans `GE_SEARCH_RESULT_TEXT_WIDGET` (10616884) children for an exact name match and clicks that specific result via `clickWidget(10616884, matchIndex, 1)` — same CC_OP(57, 1, childSlot) pattern used for offer slots and confirm. If no exact match is found, the flow fails with a clear error.

## Auto-merch architecture

### Mode toggle

The `autoMode` combo setting selects between `Manual Test` (0, default) and `Auto Merch` (1). In Manual Test mode, the bot idles and only responds to the test buttons. In Auto Merch mode, the bot runs the automated merching loop after all manual test flow checks pass (so manual buttons still work in auto mode).

### Offer cache persistence

The offer cache is stored in a hidden string setting `offerCacheSetting` (key `offerCache`, default `'{}'`, `hidden: true`). The cache is a JSON object keyed by in-game player name, each containing a per-account `OfferCacheData` map from item name to `OfferCacheEntry`. This mirrors the mixology bot's `humanizationState` persistence pattern.

- **Load**: `OfferCacheManager` constructor calls `loadOfferCache(bot, accountName)` on first access (lazy).
- **Save**: After every mutation (offer placed, price revised, entry removed), `cache.save()` writes back to the hidden setting.
- **Survives restarts**: The hidden setting persists across client restarts and plugin hot-reloads. `resetAutoLoop()` clears the in-memory `OfferCacheManager` handle but does NOT clear the hidden setting — the cache is re-loaded from the setting on the next `autoLoopTick`.
- **One entry per item**: A slot can only contain a single item, so one cache entry per item name is sufficient.

### `merchableItems.json` loading

The JSON is imported at the top of `data/merchable-items.ts` and inlined by esbuild at build time. The Titan SDK has no runtime file-system API, so the data is only refreshed when the plugin is rebuilt (which Titan hot-reloads). The external `determine-flips.mjs` process updates the file every few minutes; a rebuild + hot-reload picks up the new data.

### Auto-merch loop order

`autoLoopTick(bot, tick)` runs one tick of the loop:

1. **GE-open check (first)**: If GE is not open, walk to GE if not nearby, then open via `openGe()` (which tries the nearest of clerk NPC or "Exchange" booth object). This is the very first automated operation.
2. **Defer to active flows**: If a buy/sell/abort flow is in progress, tick it and return.
3. **Get all slot states**: `auditGeState()` reads all 8 slots via cached widget children.
4. **Collect**: If any slot has `status === 'completed_or_aborted'`, click collect and return. Completed sell offers are NOT removed from the cache — entries are kept for buy-limit tracking (see below).
5. **Stale offers**: For each active slot, check stale conditions (sell: 75% ETA + <25% sold; buy: 100% ETA + 0 bought, or 75% ETA + <50% bought for multi-qty; aggressive abort if item no longer in merchableItems.json). Start an `AbortOfferFlow` if stale.
6. **Selling**: Find empty slot + non-coin inventory item not being bought. Use cached sell price (revised if re-listing) or merchableItems.json price. Pass the actual sell quantity and the item's GE buy limit to `recordSellOffer()` for buy-limit tracking. Start a `SellOfferFlow`.
7. **Buying**: Find empty slot + first unoccupied merchable item that is affordable AND not buy-limited (within the 4-hour GE cooldown). Record buy offer in cache. Start a `BuyOfferFlow`.
8. **Wait**: All slots occupied or nothing to do — idle with a humanised delay.

### GE 4-hour buy limit tracking

The GE enforces a per-item buy limit (from `merchableItems.json` `limit` field). The 4-hour cooldown only starts when the FULL limit has been purchased — partial purchases don't start the timer. For example, an item with limit 11000: buy 10999, wait 5 hours, buy 1 more → the 4-hour timer starts from that last purchase.

- **Tracking**: `OfferCacheEntry` has `totalBought` (cumulative bought qty in the current window) and `limitReachedAt` (timestamp when `totalBought >= limit`).
- **Recording**: `recordSellOffer()` in `data/offer-cache.ts` accepts `quantity` and `limit` params. The sell quantity = actual bought quantity (a buy offer may partially fill). It's added to `totalBought`; when `totalBought >= limit`, `limitReachedAt` is set.
- **Checking**: `isBuyLimited(itemName)` returns true if `limitReachedAt` is set and < 4 hours ago. Lazily resets (clears `totalBought` and `limitReachedAt`) if the cooldown has expired.
- **Buying flow**: `getBuyLimitedItemNames()` returns all currently-limited item names. This set is passed to `getFirstUnoccupiedMerchableItem()` which skips limited items.
- **Cache retention**: Cache entries are NOT removed when a sell completes. The entry is kept so buy-limit data persists across buy/sell cycles. The entry's mode/sellPrice fields are overwritten by the next `recordBuyOffer()`.

### Price revision strategy

When a sell offer doesn't sell and is re-listed (after abort + collect), the price is revised downward:

```
reduction = max(1, min(floor(currentSell * 0.0005), floor(grossProfit * 0.05)))
newPrice  = max(buyPrice + 1, currentSell - reduction)
```

- 0.05% of the current sale price (the "percent reduction").
- Capped at 5% of gross profit (currentSell - buyPrice).
- Minimum 1 gp reduction (so even cheap items get a meaningful cut).
- Never goes below buyPrice + 1 (never sell at a loss).
- If gross profit < 5 gp, revision is skipped (too thin to cut — abort instead).
- The sale price in `merchableItems.json` already includes the GE tax, so no additional tax calculation is performed during revision.

### Wiki API fallback (stub)

When an item is no longer in `merchableItems.json` and has no cache entry, `fetchWikiPrice(itemId)` is called to get the 1-hour OSRS Wiki price. The URL is currently a stub (`WIKI_API_URL = ''`) — the function returns `null` and the sell flow skips the item. The logic structure is in place; only the URL needs to be filled in later.

### State lifecycle for auto-loop fields

- `autoLoop: AutoLoopState` — created via `createAutoLoopState()` on the class field. Reset in `resetState()` (lifecycle.ts) via `resetAutoLoop(bot)`.
- `autoLoop.activeBuyFlow/SellFlow/AbortFlow` — set when a flow starts, cleared when it completes (done/failed). Also cleared on tick-counter reset in `onGameTick`.
- `autoLoop.cache: OfferCacheManager | null` — lazily initialised on first `autoLoopTick`. Set to `null` in `resetAutoLoop()` so it re-loads from the hidden setting on next access.
- `autoLoop.profilesInitialised` — set to `true` after delay/jitter profiles are loaded. Reset to `false` in `resetAutoLoop()`.
- `autoLoop.sellAttemptedItems/buyAttemptedItems` — cleared after each loop iteration and in `resetAutoLoop()`.

### GE booth object detection

`findGeBooth()` in `grand_exchange/clerk.ts` searches for tile objects within 20 tiles with `nameContains('Grand Exchange')` and `hasAction('Exchange')`. `findExchangePoint()` returns the nearest of clerk NPC or booth object. `openGe()` interacts with whichever is closer. This satisfies the requirement to check for the "Exchange Grand Exchange Booth" object as the first automated operation.
