# Stark Mercher Bot — Strict Rules

## Native handle exhaustion — NEVER loop over native SDK queries

**CRITICAL.** Do NOT write `for`/`while` loops that call `titan.queries.widgets(grp).toArray()`, `titan.queries.objects().toArray()`, `titan.queries.npcs().toArray()`, or any other `titan.queries.*().toArray()` per iteration. Each `toArray()` creates native handle objects. The JS engine does NOT GC between loop iterations, so handles accumulate simultaneously. The native handle table is FINITE — once exhausted, EVERY subsequent native SDK call (overlay, `onGameTick`, `onMainLoop`, `onClientTick`) throws `null` simultaneously, producing the cascade `onMainLoop error: null` → `onGameTick error: null` → `onClientTick error: null` → `onDisable error: null` → `auto-disabled after 3 consecutive failures`. The ONLY recovery is toggling the plugin off/on. This bug was caused in the mixology plugin by a 1200-group widget scan in `findTitleWidget()`; the mercher must never introduce the same pattern. Use targeted lookups (`titan.state.widgets.find(packedId)`, `titan.state.widgets.findByText(text)`, `titan.queries.widgets(specificGroup).toArray()`) — never unscoped or looped queries. Any `toArray()` call inside a loop is a bug. If a diagnostic scan is needed, run it ONCE via Titan Shell from the user's manual input, NOT from plugin callback code.

### Per-frame overlay queries — same root cause, slower accumulation

The overlay render callback runs at 30-60 FPS. Calling `titan.utils.inventory.count(995)` or `titan.utils.inventory.getAll()` every frame creates ~60 native query handles per second. The JS engine doesn't GC between frames, so handles accumulate and exhaust the table over hours — the same class of bug as the mixology looped scan, just slower. **The overlay must NEVER call `titan.queries.*` or `titan.utils.inventory.*` directly.** Instead, it reads cached values from the bot instance (`bot.cachedCoinCount`, `bot.cachedDailyProfit`) that are refreshed by the auto-loop (which already reads them) and by a fallback timer in `onGameTick` (every 30 ticks / ~18 seconds when the auto-loop isn't running). This reduces native handle creation from ~60/sec to ~1/18sec.

### Per-tick inventory queries — single snapshot per tick

The auto-loop previously called `titan.utils.inventory.find()` and `titan.utils.inventory.count()` 5+ times per tick, each creating a separate native query handle. Now it builds a single `Map<string, Item>` snapshot from one `getAll()` call at the top of `autoLoopTick` and reuses it for all inventory lookups within that tick (`findInInv()`, `countCoinsInInv()`). This reduces per-tick native queries from 5+ to 1.

## User build preference

- Do **not** run `npm run build`, `npm run watch`, or any other build/compilation command unless the user explicitly asks. The user will build the plugin manually when they are ready.
- `npm run typecheck` runs `tsc --noEmit`. The codebase has pre-existing type errors; new errors introduced by a change must be fixed.
- Standard verification after code changes: `npm run typecheck`, `npm run state-guard`, `npm run test:scenarios`, `npm run test:integration`. Do not run these unless explicitly asked.

## File / module layout

- `stark-mercher.ts` — main plugin class, settings, state, `onEnable`, `onGameTick`, `tickLogic`.
- `general/timing.ts` — `setAction`, `canPerformAction`, `shouldWait`; tick-based action throttling with backwards-tick recovery.
- `general/state.ts` — `sanityCheckState` (per-tick stale-state auto-correction: clears stale `abortSlotInfo`, resets phase when active flow is gone, clears stale `logoutComplete`), `resetInFlightActionState` (clears auto-loop flows + idle-for-break flags + cache reconciliation/reconstruction flags on hop/break/login transitions).
- `general/lifecycle.ts` — `onEnable`, `terminate` helpers; resets all state including auto-loop state and hop state.
- `general/state-persist.ts` — offer cache persistence via hidden JSON setting (mixology-style per-account). `loadOfferCache`, `saveOfferCache`, `OfferCacheData`, `OfferCacheEntry` (includes `sellQuantity` for daily profit tracking), `getCrossAccountBuyingItemCount` (reads all accounts' caches to build a `Map<itemName, count>` of active buy offers for cross-account buy dedup).
- `general/state.ts` — `sanityCheckState` (per-tick stale-state auto-correction), `resetInFlightActionState` (clears auto-loop flows + idle-for-break flags + cache reconciliation flags on hop/break/login transitions).
- `general/helpers.ts` — `isPlayerIdle` (stationary + animation grace check, used by hop safe-boundary).
- `general/debug.ts` — debug widget logging.
- `general/variables.ts` — shared variables.
- `data/merchable-items.ts` — typed reader for `merchableItems.json` (inlined at build time by esbuild). `getMerchableItems`, `getMerchableItem`, `isMerchable`, `getFirstUnoccupiedMerchableItem` (returns `BuyScanResult` with runtime quantity/profit/hr), `evaluateItemAtRuntime` (cash-stack-aware runtime evaluation), `isMerchableDataValid` (count + freshness safeguards), `MerchableItem`, `BuyScanResult`, `RuntimeEvaluation`, `MerchableDataValidity`.
- `data/price-history.ts` — typed reader for `priceHistory.json` (inlined at build time). `getPriceHistoryEntry`. Fallback sell-price lookup for items not in merchableItems.json or the offer cache (e.g. orphaned inventory items after a long script stop or JSON refresh during sleep). Uses 1h average prices — no extra API calls.
- `data/offer-cache.ts` — `OfferCacheManager` wrapping the persisted cache with price revision logic (5% of gross profit, min 1 gp, never below buyPrice+1), `reconstructEntry` (reverse reconciliation from live GE slots after cache loss), and Wiki API stub. `fetchWikiPrice` (stub — URL not yet configured).
- `data/daily-profit.ts` — per-account daily profit tracking. `addDailyProfit`, `getDailyProfit`, `resetDailyProfit`, `getDayStartMs`. Persisted in hidden JSON setting. Resets at UK midnight via day-rollover comparison on read/write.
- `widgets/bot-overlay.ts` — HUD overlay panel. `renderBotOverlay` draws Status, Inventory Coins, and Daily Profit. Registered via `this.overlay({ layer: 'AboveWidgets' })` in `stark-mercher.ts`.
- `antiban/humanised-delay.ts` — `DelayProfile`, `generateDelayProfile`, `setDelayProfileForAccount`, `createDelay`; per-account deterministic humanised delay function inspired by mixology's anti-ban layers (jitter, hesitation, outlier, jitter amplification).
- `antiban/hopper.ts` — `hopStep`, `completeHop`, `onChatMessage`. World hop state machine adapted from mixology. Picks a random safe members world at a profile-scheduled interval (18–45 min). Pauses auto-loop during hop and for a short resume delay after.
- `antiban/session.ts` — break/sleep state machine + hop safe-boundary functions. `breakStep`, `wallClockStep`, `resetBreakState`, `initSessionProfile`, `markNightlyBreakFinished`, `formatUKTime`, `getSafeBoundaryReason`, `isAtSafeBoundary`, `shouldPauseForHopBoundary`, `resetHop`, `forceHop`, `resetHopState`. Integrates multi-character rotation: on logout, `tryImmediateRotation()` checks if a different account is eligible immediately; during the break wait, `wallClockStep` periodically (every 10s) re-checks for a newly-eligible account; on break end, calls `selectNextAccount()` to pick the account whose break ends soonest (with longest-since-login tiebreaker).
- `antiban/account-rotation.ts` — multi-character roster management. `getRoster`, `isRotationEnabled`, `selectNextAccount`, `getSoonestBreakEndMs`, `recordAccountLogout`, `recordAccountLogin`, `loadRotationIndex`, `saveRotationIndex`, `isAccountSleeping`, per-account break state cache (`getAccountBreakState`/`saveAccountBreakState`/`clearAccountBreakState`). When the roster has 2+ names, the bot rotates between accounts: each runs the full auto-merch loop until idle, logs out, and the next eligible account (awake + break lapsed) logs in. Selection is time-based — the account whose break ends soonest is selected, with the longest-since-login tiebreaker preventing starvation. When the roster is empty or a single name, the bot behaves as a single-account bot.
- `input/typing.ts` — `humanType`, `isTyping`, `cancelTyping`, `setTypingProfile`, `setTypingProfileForAccount`; humanised keyboard typing with per-character delays. `isTyping()` also returns true while a typing-mistake correction sequence is active, and advances the tick-driven mistake state machine once per game tick via `tickMistakeSequence()`.
- `input/typing-profile.ts` — `TypingProfile` (`baselineMs`, `jitterMs`), deterministic per-account profile generation via djb2 hash + mulberry32 PRNG.
- `input/typing-mistakes.ts` — `TypingMistakeProfile` (`nameMistakeChance`, `quantityMistakeChance`, `priceMistakeChance`), `typeStringWithMistake`, `setTypingMistakeProfileForAccount`, `cancelTypingMistakeSequence`, `tickMistakeSequence`; occasional wrong-character + backspace correction during GE typing. The mistake sequence is driven by a **tick-based state machine** (not `setTimeout` — the Titan runtime does not expose `setTimeout`, so any use crashes the plugin with `ReferenceError`). `tickMistakeSequence()` is called from `isTyping()` in `typing.ts` every tick, advancing gap countdowns (realisation delay, post-backspace gap) using `titan.state.client.tick` for dedup. Phases: `phase1_typing` → `realise_gap` (count down N ticks) → `post_backspace_gap` (1 tick, Backspace on entry) → `phase2_typing` → done. A tick-based safety watchdog (`MAX_MISTAKE_DURATION_TICKS = 14` ≈ 8.4s) force-clears a stuck sequence. `BuyOfferFlow` and `SellOfferFlow` also call `cancelTypingMistakeSequence()` in `waitTick()` (on re-attempt) and `fail()` to prevent a stuck sequence from poisoning subsequent typing operations.
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
- The `humanType()` function in `input/typing.ts` already uses profile-derived per-character timing. The GE buy/sell flows use `typeString()` (in `grand_exchange/actions.ts`) which routes through `typeStringWithMistake()` in `input/typing-mistakes.ts`. This wraps `humanType()` with a small per-type chance of a wrong-character + backspace correction: the bot types part of the text, inserts a wrong character (a random letter for item names, a random digit for quantities/prices), waits a humanised realisation delay via `createDelay(2, 100, 3)` (1-3 ticks / 0.6-1.8s normally, 0.1% distraction bypasses the cap for 12-36s), presses Backspace, waits 1 tick, then types the remainder. The mistake chances are deterministic per account (`TypingMistakeProfile` via djb2/mulberry32): `nameMistakeChance`, `quantityMistakeChance`, and `priceMistakeChance` are each independently sampled in 0.3-1.0%, so a full buy offer flow (name + quantity + price) has roughly a 0.9-3.0% chance of at least one visible mistake. The mistake is always corrected before the flow's validation step, so the final typed text is always correct. `isTyping()` returns true for the entire sequence (including the realisation gap) so the flow's `waitForTyping` step doesn't advance prematurely. The mistake sequence is driven by a **tick-based state machine** (not `setTimeout` — the Titan runtime does not expose `setTimeout`), advanced once per game tick via `tickMistakeSequence()` called from `isTyping()`. A tick-based safety watchdog (`MAX_MISTAKE_DURATION_TICKS = 14` ≈ 8.4s) force-clears a stuck sequence, and `BuyOfferFlow`/`SellOfferFlow` call `cancelTypingMistakeSequence()` on re-attempt and failure to prevent a stuck sequence from blocking subsequent typing.
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
2. `resetInFlightActionState()` (break/hop/world transition — clears auto-loop flows, test flows, idle-for-break flags, cache reconciliation flags, and action throttle)
3. The handler that naturally ends the action (e.g. flow completion, flow failure)
4. The login/settle path if it relates to breaks or post-login UI

### 3. Defensive invariants in `tickLogic`

`sanityCheckState(bot, tick)` is called at the top of `tickLogic()`. It auto-corrects cheap stale state — clearing stale `abortSlotInfo` when no abort flow is active, resetting `phase` to `'idle'` when the corresponding flow is gone, and clearing stale `logoutComplete` when not in a break. New stale-state fixes go here; they must be logged.

### 4. Trace-first for state changes

When adding or changing state, add a `debugLog`/`humanLog` at the set and the reset. Do not rely on silence to mean success. The `logDebug` UI toggle controls whether debug logs are printed.

## Break and hop safe boundaries

The only blocker for a hop is the player actively animating or moving. `getSafeBoundaryReason()` checks only:
1. `bot.hopInProgress` — a world hop is already in flight.
2. `!isPlayerIdle(bot)` — the player is animating or moving.
3. **Idle buffer** — player has been idle for less than 2 ticks.

All other state (held items, GE interface, location) either persists across hops/logouts or is transient. `shouldPauseForHopBoundary(bot)` pauses `tickLogic()` to prevent starting new actions while a forced hop is waiting to dispatch.

## Break system

The mercher takes two types of logout breaks:

- **Short breaks** (1-10 min, ETA-based two-tier 50%/90%): Triggered when the auto-loop has nothing to do (all slots occupied, nothing to collect/sell/buy). The auto-loop sets `bot.loopIdleForBreak = true` when it reaches the idle branch. The break system in `breakStep()` checks these flags but enforces a **randomised tick-based delay** before actually logging out:
  - Base: 5-20 ticks
  - + 3 ticks (20% chance)
  - + 1-10 ticks (10% chance)
  - + 5-15 ticks (1% chance)
  
  The delay is computed once when the bot first becomes idle and stored in `bot.shortBreakDelayTicks`. This prevents logging out immediately while adding humanised randomness. The idle tick is reset whenever the auto-loop performs an action (set at the top of `autoLoopTick`).

  **Break duration**: When the auto-loop goes idle, it computes `bot.nextActionEtaMin` — the minimum remaining time (in minutes) until the next action on any slot. For each active slot, this is the earlier of:
  - **Completion**: the offer filling fully (100% of ETA)
  - **Stale abort**: the offer hitting its ETA abort threshold (90% for multi-qty buys with <50% progress; 125% for 0-fill buys; 50-95% for sells with <25% progress, scaled by profit margin via `computeSellEtaAbortRatio`; 100% otherwise)

  The break system uses `sampleEtaBasedBreakDuration()` to convert this hint into a break duration: `nextActionEtaMin * 0.5 * (1 ± 15% jitter)`, clamped to a **randomized 1–2 min floor** and **10 min ceiling**. The 50% ratio means the bot logs back in at half the ETA to check for early completions (items that bought/sold quicker than expected). The randomized floor prevents anti-ban-unfriendly very short breaks; the ceiling ensures the bot returns promptly. If no ETA data is available (`nextActionEtaMin <= 0`), it falls back to `sampleShortBreakDuration()` (random 2-5 min + profile variance/long-tail).

  This ensures the bot logs back in early enough to catch quick fills and collect/re-list sooner, instead of waiting the full ETA and potentially missing early completions.
- **Nightly sleep** (3.5-6.5h): Per-account profile with wake-first scheduling. Bedtime = wake time − sleep duration.

Both break types log the player out via `logoutForBreak()`. GE offers continue filling while logged out. After the break duration elapses (wall-clock), `wallClockStep()` → `loginStep()` logs the account back in.

`loopIdleSinceTick`, `shortBreakDelayTicks`, and `nextActionEtaMin` are reset in all the same places as `loopIdleForBreak`: `resetBreakState()`, login recovery, nightly break start, short break start, and at the top of `autoLoopTick()`.

## Multi-character account rotation

The bot supports rotating through a roster of accounts. Each account runs the full auto-merch loop until it goes idle (all slots occupied, nothing to collect/sell/buy), logs out, and the next eligible account logs in. This happens continuously — the bot does not wait for the current account's break to end before switching; it immediately checks the next account in the roster.

### Settings

- **`accountRoster`** (visible string setting) — comma-separated character names (e.g. `"Cyber4Gras,Account2,Account3"`). When 2+ names are listed, rotation is enabled. When empty or a single name, the bot behaves as a single-account bot (no rotation — same account relogin after every break).
- **`rotationIndexSetting`** (hidden) — stores the current rotation index (which account to check next). Persisted across hot reloads.
- **`accountBreakStateSetting`** (hidden) — stores per-account break state as JSON: `{ accountName: { lastLogoutAtMs, minBreakDurationMs, lastLoginAtMs } }`. Used to determine if an account's minimum break has lapsed and to break ties when multiple accounts are eligible simultaneously.

### Rotation model

1. Account A runs the full auto-merch loop → goes idle → takes an ETA-based short break (or nightly sleep) → logs out.
2. On logout, the account's break state is recorded: `lastLogoutAtMs = now`, `minBreakDurationMs = breakDuration` (the ETA-based duration for short breaks, or the full sleep duration for nightly sleeps). The `lastLoginAtMs` from any existing state is preserved.
3. **Immediate rotation check**: right after the logout completes, `tryImmediateRotation()` calls `selectNextAccount()` to check if a *different* account is eligible right now. If so, the bot skips the break wait and logs in the next account immediately. If no other account is eligible (all sleeping or on break), the bot waits for the break timer.
4. **Periodic idle-rotation check**: while waiting for the current account's break to end, `wallClockStep` periodically (every 10 seconds, throttled via `lastIdleRotationCheckMs`) calls `tryImmediateRotation()` to check if a different account has become eligible in the meantime (e.g. its shorter break elapsed while the current account's longer break is still running). If so, the bot rotates immediately instead of wasting time waiting for the current account's break. This prevents the gap where account B becomes eligible but the bot doesn't notice until account A's break ends.
5. When the break timer expires (and no immediate or idle rotation happened), `selectNextAccount()` selects the next account using a **time-based** policy (not roster order):
   - Skip any account currently in its nightly sleep window (checked via its SessionProfile).
   - For each remaining account, compute `breakEndMs = lastLogoutAtMs + minBreakDurationMs` (0 if no break state → eligible now).
   - Skip accounts whose `breakEndMs > now` (minimum break hasn't lapsed).
   - Among eligible accounts, pick the one with the oldest `lastLoginAtMs` (longest since last login). Accounts that have never logged in (`lastLoginAtMs = 0`) get highest priority. This prevents starvation — if multiple accounts' breaks end within the same 10-second poll interval, the one that hasn't been logged in for the longest gets priority rather than the one that happens to be first in the roster.
   - The "soonest break end" timing is handled by the 10-second periodic poll and `getSoonestBreakEndMs()` — the bot checks for eligibility at the right time, and when multiple accounts are eligible, the `lastLoginAtMs` tiebreaker decides.
6. The selected account's credentials are staged and the bot logs in. On successful login, the account's break state is updated: `lastLogoutAtMs = 0`, `minBreakDurationMs = 0`, `lastLoginAtMs = now` (preserving the entry for the tiebreaker rather than clearing it).
7. The new account runs the full auto-merch loop, and the cycle repeats.

### Overlay status timer

When multi-account rotation is enabled and the bot is logged out (`breakPhase === 'logged_out'`), the overlay status countdown uses `getSoonestBreakEndMs()` — the minimum `breakEndMs` across all non-sleeping roster accounts — rather than the current account's `breakTargetEndMs`. This shows the actual wait time until the next account becomes eligible, which may be sooner than the current account's own break end. When rotation is disabled, the overlay uses `breakTargetEndMs` as before.

### Per-account data (already isolated by account name)

- Offer cache, merch history, abort history, daily profit, session profile, hop state — all per-account, unchanged.
- Buy-freeze state — global (not account-keyed), unchanged.

### Cross-account buy dedup

When rotation is enabled (2+ accounts), the buy scan skips items that are already being bought by enough other accounts. This prevents multiple accounts from competing on price for the same item. The threshold is `min(2, rosterSize - 1)`: with a 2-account roster, the threshold is 1 (no overlap — if the other account is buying an item, skip it); with 3+ accounts, the threshold is 2 (up to 2 accounts can buy the same item, but the 3rd skips it). The check reads all accounts' offer caches from the shared `offerCacheSetting` (keyed by account name) via `getCrossAccountBuyingItemCount()`, which returns a `Map<itemName, count>` of active `mode: 'buy'` entries across all other accounts. Items where the count meets the threshold are added to `crossAccountSkipNames` and passed to all buy scan functions (primary, frozen fallback, partial fallback, and swap candidate).

### Sleep/wake schedules

Each account's sleep/wake schedule comes from its own `SessionProfile` (deterministic per account name). The `isAccountSleeping()` function in `account-rotation.ts` checks if the current wall-clock time falls within the account's sleep window (computed from `nightlySleepLengthBase` and `nightlyWakeBase`). If an account is sleeping, it is skipped during rotation. If all accounts are sleeping, the bot waits (retrying every 30 seconds). If only one account is awake, the bot cycles that one account respecting its break state — effectively behaving as a single-account bot until other accounts wake up.

### Nightly sleep with rotation

When an account's nightly sleep triggers, it logs out and its break state is recorded with the full sleep duration. The rotation then checks the next accounts — if they're also sleeping, the bot waits. When an account wakes up (its sleep window ends), it becomes eligible and the bot logs it in. The rotation index continues from where it left off — there is no "reset to first account" each morning.

### Single-account fallback

When `accountRoster` is empty or has a single name, `isRotationEnabled()` returns false and `selectNextAccountForLogin()` returns the current account name. The bot logs back into the same account after every break — identical to the pre-rotation behavior.

## Login retry timeout

`tryStageAndSubmitLogin()` tracks `bot.loginFirstAttemptAtMs`. If 5 minutes elapse without login, the bot terminates. A 10-attempt `submitCredentials` limit is a faster failure path. `loginIndex === 10` (or legacy `2`) means staged; `loginIndex === 9` covers both "game update in progress" and "you were signed out" — the snapshot doesn't expose message text, so we can't distinguish them. Index 9 uses exponential backoff (5s → 10s → 20s → 40s → 60s cap) with credential re-staging on each retry. If it's "signed out", the first fast retry succeeds. If it's a game update (which can last 30+ min), we back off to avoid hammering the login server. When a staged profile is first detected, the bot **re-stages** with `bot.currentPlayerName` before submitting — this ensures the staged profile matches the intended account after multi-account rotation (the OSRS client may still have the previous account's profile staged).

## Post-login settle delay

After the title screen disappears and the player is in-world, `loginStep()` sets `bot.postLoginResumeAtMs = now + createDelay(3, 5) ticks` (1.8-3s humanized settle). `tickLogic()` blocks until this elapses, giving the client time to render the world and clear promo/overlay widgets. After clicking "Click here to play", `postLoginResumeAtMs` is set to `MAX_SAFE_INTEGER` to block until the title disappears; the title-gone re-check interval is 8 ticks (~4.8s). When the settle completes, failure counters are reset (the login transition can cause false strikes e.g. GE not openable while the world is still loading).

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
  - **Paused** (default, value 0): No script logic runs at all — no login, no breaks, no hops, no merching. All loop callbacks (`onGameTick`, `onMainLoop`, `onGameStateChanged`, `onChatMessage`) return immediately. The overlay still renders so the user can see the status and switch to Auto Merch. This is the safe default for new clients — the bot does nothing until the user explicitly switches to Auto Merch.
  - **Auto Merch** (value 1): The bot runs the full automated merching loop: login, breaks, hops, GE-open check → collect → stale → sell → buy.
- The mode persists across hot reloads (it's a Titan setting). Switching from Paused to Auto Merch re-runs the startup audit on the next tick so the auto-loop reconciles from current GE state. Switching from Auto Merch to Paused stops all logic immediately on the next tick.
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

The `autoMode` combo setting selects between `Paused` (0, default) and `Auto Merch` (1). In Paused mode, all loop callbacks (`onGameTick`, `onMainLoop`, `onGameStateChanged`, `onChatMessage`) return immediately — no script logic runs at all. The overlay still renders so the user can switch modes. In Auto Merch mode, the bot runs the full automated merching loop (login, breaks, hops, GE actions). Switching to Auto Merch re-runs the startup audit; switching to Paused stops all logic on the next tick.

### Startup audit

On the first tick in Auto Merch mode (either on script start or when the user switches from Paused to Auto Merch), the bot audits the current GE state (is GE open? is offer config screen showing? which slots are occupied?) and logs active slots for visibility. If a GE sub-screen (offer config / search / price prompt) is open, the auto-loop closes it with Escape on the next tick. No flow resume is attempted — the auto-loop reconciles from cache state. The audit is skipped entirely in Paused mode (the `onGameTick` callback returns before the audit runs).

### Offer cache persistence

The offer cache is stored in a hidden string setting `offerCacheSetting` (key `offerCache`, default `'{}'`, `hidden: true`). The cache is a JSON object keyed by in-game player name, each containing a per-account `OfferCacheData` map from item name to `OfferCacheEntry`. This mirrors the mixology bot's `humanizationState` persistence pattern.

- **Load**: `OfferCacheManager` constructor calls `loadOfferCache(bot, accountName)` on first access (lazy).
- **Save**: After every mutation (offer placed, price revised, entry removed), `cache.save()` writes back to the hidden setting.
- **Hot-reload only**: The hidden setting survives plugin hot-reloads (off/on within the same client session) but does NOT reliably persist across client restarts. The Titan host only persists settings to disk when the user interacts with the UI; plugin-side `.value =` writes do not trigger the host's dirty flag. After a client restart, the cache may be empty while GE offers remain on the server. Reverse reconciliation (below) reconstructs missing entries from live GE slots.
- **One entry per item**: A slot can only contain a single item, so one cache entry per item name is sufficient.

### Reverse reconciliation (cache loss recovery)

When the cache is lost after a client restart, active GE offers survive on the server but have no cache entry. Without reconstruction, staleness checks bail out (they need `offerPlacedAt`), completed sells lose their profit, and stuck offers sit forever. Reverse reconciliation runs once on the first GE-open tick after script start (Step 2c, immediately after orphan reconciliation):

- Iterates over occupied slots with a known item name and type (`buy` or `sell`).
- For each slot with no existing cache entry, calls `cache.reconstructEntry()`.
- Prices and ETAs come from `merchableItems.json` (primary) or `priceHistory.json` (1h average fallback for items no longer in the merchable list).
- `offerPlacedAt` is set to `Date.now()` — the actual placement time is unknown, so the offer gets a fresh full ETA window before staleness checks can abort it. This is the safest choice since aborting an offer we know nothing about could discard partial fills.
- For sell offers, `sellQuantity` is set from the slot's item quantity so the completed-sell sweep can record profit when the sell finishes. `sellConfirmed` is set to `true` (the offer is already live on the GE).
- If no price data is found in either source, the slot is skipped (logged) — the offer is left alone until it completes or the user intervenes.
- Reconstructed profit is approximate: buy/sell prices come from current `merchableItems.json` or 1h averages, not the actual prices at which the offer was placed.

### `merchableItems.json` loading

The JSON is imported at the top of `data/merchable-items.ts` and inlined by esbuild at build time. The Titan SDK has no runtime file-system API, so the data is only refreshed when the plugin is rebuilt (which Titan hot-reloads). The external `determine-flips.mjs` process updates the file every 3 minutes; a rebuild + hot-reload picks up the new data.

### Data validity safeguards

`isMerchableDataValid()` in `data/merchable-items.ts` checks two safeguards before any account is logged in for merching:

1. **Count safeguard**: `merchableItems.json` must have ≥ 30 items. A sudden drop below 30 indicates the Wiki API returned bad data or `determine-flips.mjs` failed mid-run (e.g. partial write, network error).
2. **Freshness safeguard**: The newest `dataFetchedAt` across all items must be within the last 10 minutes. Since `determine-flips.mjs` runs every 3 min, data older than 10 min means the script stopped running or the Wiki API is down.

Both checks run dynamically (not cached) so hot reloads pick up new JSON automatically — the bot resumes as soon as a rebuild brings valid data. When data is invalid:
- `tryImmediateRotation()` and `selectNextAccountForLogin()` return null (no account logs in).
- The 10-second periodic poll in `wallClockStep` reports the error in the log every 10 seconds.
- The break-end "no eligible account" path reports the specific reason (invalid data vs. no eligible account).
- The overlay status shows `Data Invalid` instead of the normal countdown.
- Single-account mode is also blocked — the safeguard applies regardless of rotation.

### Auto-merch loop order

`autoLoopTick(bot, tick)` runs one tick of the loop:

1. **GE-open check (first)**: If GE is not open, walk to GE if not nearby, then open via `openGe()` (which tries the nearest of clerk NPC or "Exchange" booth object). This is the very first automated operation. A **wall-clock cooldown** (`GE_OPEN_WALL_CLOCK_COOLDOWN_MS = 3000ms`) enforced via `lastGeOpenDispatchMs` on `AutoLoopState` prevents a second GE-open click from being dispatched within 3 seconds of the previous one. This is necessary because the SDK can fire a burst of ticks immediately after login (the tick counter advances several ticks in milliseconds), causing the tick-based action delay to elapse instantly and the loop to re-enter and dispatch a duplicate click before the first one has taken effect. The cooldown is reset to 0 in `resetAutoLoop()` and in the tick-counter-reset block in `stark-mercher.ts` so the first GE-open after a restart/login goes through immediately.
2. **Close GE sub-screens**: If the offer config screen, search prompt, or price prompt is open (e.g. after a script reload mid-flow or a misclick), close it with Escape via `sendKeyWithJitter`. This prevents slot clicks from landing on the sub-screen instead of the intended slot.
3. **Defer to active flows**: If a buy/sell/abort flow is in progress, tick it and return.
4. **Get all slot states**: `auditGeState()` reads all 8 slots via cached widget children.
5. **Cache reconciliation (2b)**: One-time orphan removal — removes cache entries for items not in any GE slot, not in inventory, no active buy-limit window, and no pending sell profit.
6. **Reverse reconciliation (2c)**: One-time cache reconstruction — for occupied slots with no cache entry (lost after client restart), reconstructs entries from `merchableItems.json` / `priceHistory.json` so staleness checks and profit tracking work.
7. **Completed-sell sweep + Collect**: If any slot has `status === 'completed_or_aborted'`, click collect and return. A **wall-clock cooldown** (`COLLECT_WALL_CLOCK_COOLDOWN_MS = 3000ms`) enforced via `lastCollectDispatchMs` on `AutoLoopState` prevents a second collect click within 3 seconds of the previous one — same rationale as the GE-open cooldown (tick bursts after login can cause the tick-based delay to elapse instantly). The cooldown is reset in `resetAutoLoop()` and the tick-counter-reset block. Completed sell offers are NOT removed from the cache — entries are kept for buy-limit tracking (see below).
8. **Stale offers**: For each active slot, check stale conditions (sell: 75% ETA + <25% sold; buy: 125% ETA + 0 bought, or 90% ETA + <50% bought for multi-qty). Items removed from `merchableItems.json` are NOT immediately aborted — they may still be merchable, and the volatile list during development caused abort churn on every restart. Instead, ETA-based checks handle them using the cached `purchaseEtaMinutes` from buy time. Start an `AbortOfferFlow` if stale. Buy offers are frozen for 5 min when the abort is triggered — the freeze is **global** (not account-keyed) because it represents a market/item-level signal: an item that isn't buying at the offered price on one account is unlikely to buy at that price on another account either. The freeze is NOT re-applied if the item is already frozen (e.g. a previous abort attempt failed and is being retried), and is NOT applied for config-driven aborts (item removed from list — re-buying is fine if it's added back). After the abort flow completes, the cache entry is only removed if the item is NOT in inventory — if the buy partially filled during the abort flow (especially after a failed first attempt), the collected items are in inventory and the cache entry is kept to preserve buy-limit tracking. The sell scan will pick up the items in the next iteration. An abort history entry is recorded at abort completion via `recordAbort()` in `data/abort-history.ts`, capturing item, type, requested/filled qty, reason, category (`'eta'`, `'swap'`, or `'config'`), elapsed vs ETA, price, and timestamp — this is the key diagnostic for low overnight profit (aborted 0-fill buys leave no trace in merch history).
9. **Selling**: Find empty slot + non-coin inventory item not being bought. Items being SOLD in another GE slot are NOT skipped — OSRS allows the same item to be listed in multiple sell slots simultaneously, so the bot will place a second sell offer for an item that already has one in another slot. Only items with an active BUY offer in a GE slot are skipped (to avoid selling partially-filled buy collections before the buy completes). Use cached sell price (revised if re-listing) or merchableItems.json price. Pass the actual sell quantity and the item's GE buy limit to `recordSellOffer()` for buy-limit tracking. Start a `SellOfferFlow`. **Dynamic slot freeing**: If all 8 slots are occupied with buy offers and there are sellable items in inventory, the sell scan aborts the **oldest buy offer with 0% progress** (nothing bought yet — no loss) to free a slot for the sell. This keeps slot usage dynamic: all 8 slots can be used for buys, but when a sale is needed the least-productive buy (oldest 0-progress) is sacrificed. The abort uses category `'swap'` (no buy-freeze applied).
10. **Buying**: Find empty slot + best merchable item evaluated at **runtime** based on the player's actual coins. **All 8 slots are available for buy offers** — no slots are reserved for sales. When a sell is needed, the sell scan (Step 9) dynamically frees a slot by aborting the oldest 0-progress buy. `getFirstUnoccupiedMerchableItem` now returns a `BuyScanResult` containing the runtime quantity (`min(floor(coins / purchasePrice), limit)`), runtime total cost, runtime profit/hr, runtime turnover ETA, and **profit-per-coin-per-hour** (`runtimeProfitPerSlotHour / runtimeTotalCost`). Items are ranked by profit-per-coin-per-hour — this favours items that use coins efficiently across multiple slots, so 3x 5m items (50k/hr each = 150k/hr total) are preferred over 1x 14m item (100k/hr) when the player has 15m and multiple empty slots. The absolute profit/hr filter (≥ 20k) ensures cheap low-quality items aren't picked. Filters: profit/hr ≥ 20k, turnover ≤ 150min. The runtime quantity is then adjusted for remaining GE buy limit: `min(runtimeQuantity, remaining)`. Record buy offer in cache. Start a `BuyOfferFlow`. If no item passes the standard thresholds, a **partial fallback** scans with lower thresholds (profit/hr ≥ 5k, turnover ≤ 240min) to keep slots productive. If no item is found, the diagnostic logs a summary: how many items were occupied, buy-limited, frozen, unaffordable, and below threshold. **Frozen fallback**: If no non-frozen item is available, the bot falls back to a frozen item (soonest-expiring freeze preferred) rather than leaving a slot empty — an empty slot earns 0gp, while a frozen item might buy if market conditions have changed since the abort.
9. **Wait**: All slots occupied or nothing to do — idle with a humanised delay.

### GE 4-hour buy limit tracking

The GE enforces a per-item buy limit (from `merchableItems.json` `limit` field). The 4-hour window starts from the **first** item bought — not when the full limit is reached. After 4 hours from the first purchase, the limit completely resets regardless of how many were bought. For example, an item with limit 13000: buy 100 at 2:00 PM, buy 1000 more at 3:00 PM → at 6:00 PM (4 hours after first purchase) the full 13000 limit is available again.

- **Tracking**: `OfferCacheEntry` has `totalBought` (cumulative bought qty in the current window), `firstBoughtAt` (timestamp of the first purchase in the window), and `limitReachedAt` (timestamp when `totalBought >= limit`).
- **Recording**: `recordSellOffer()` in `data/offer-cache.ts` accepts `quantity` and `limit` params. The sell quantity = actual bought quantity (a buy offer may partially fill). It's added to `totalBought`; `firstBoughtAt` is set only when `totalBought` transitions from 0 to >0; when `totalBought >= limit`, `limitReachedAt` is set.
- **Checking**: `isBuyLimited(itemName)` returns true if `limitReachedAt` is set and the 4-hour window (from `firstBoughtAt`) hasn't expired. Lazily resets all tracking if the window has expired.
- **Remaining limit**: `getRemainingBuyLimit(itemName, limit)` returns `limit - totalBought` within the current window, or the full `limit` if the window has expired (resetting lazily).
- **Threshold skip**: `getBuyLimitThresholdItemNames(items, 20)` returns items where remaining < 20% of the limit. These are merged into the buy-limited set so `getFirstUnoccupiedMerchableItem()` skips them. This prevents buying tiny remaining quantities (e.g. 1280/13000 remaining).
- **Quantity adjustment**: After selecting an item to buy, the quantity is adjusted to `min(runtimeQuantity, remaining)`. The log notes when this happens: `(reduced from N — buy limit remaining)`.
- **Buying flow**: `getBuyLimitedItemNames()` returns all currently-limited item names (full limit hit + threshold-skipped). This set is passed to `getFirstUnoccupiedMerchableItem()` which skips limited items. The buy scan uses **lowball tiering**: non-lowball items (instant-fill, buy at market, `lowballPercent === 0`) are tried first, then lowball items (buy below market, `lowballPercent > 0`, slower fills, less reliable ETA). The tier order is: (1) non-lowball non-frozen, (2) non-lowball frozen fallback, (3) lowball non-frozen, (4) lowball frozen fallback, (5) partial fallback (lower thresholds). This ensures GE slots fill with instant-buy items before slower lowball offers are attempted, reducing slot idle time and ETA-exceeded aborts. The `lowballTier` parameter on `getFirstUnoccupiedMerchableItem` and `getFirstPartialBuyItem` controls which tier to scan (`'non-lowball'`, `'lowball'`, or `'any'`).
- **Cash-stack-aware evaluation**: `determine-flips.mjs` runs at `CASH_STACK_MILLIONS = 50` to produce a wide item pool. The `CASH_STACK` acts as a **pool-width dial**: items costing more than `CASH_STACK` are filtered out, so higher values include more expensive items. The `flipScore` in the JSON is fully cash-stack-independent (`maxProfitPerSlotHour * log1p(ROI)` — no simulation-era values used), so the ranking is identical regardless of the cash stack setting. At runtime, `evaluateItemAtRuntime(item, coins)` computes the actual quantity the player can afford (`min(floor(coins / purchasePrice), limit)`), the runtime ETA (using the same volume formula as determine-flips.mjs), and the runtime profit/hr. Items are ranked by **profit-per-coin-per-hour** (`runtimeProfitPerSlotHour / runtimeTotalCost`) — this favours items that use coins efficiently across multiple slots rather than one expensive item consuming the whole cash stack. The `quantityToPurchase`, `totalPurchasePrice`, `purchaseEtaMinutes`, `actualProfitPerSlotHour`, and `turnoverEtaMinutes` fields in the JSON are simulation-era values (at 50m allocation) and are NOT used for runtime decisions — they're kept for diagnostic reference only.
- **Cache retention**: Cache entries are NOT removed when a sell completes. `clearSellFields()` resets `mode` to `'idle'` and clears `sellQuantity`, `partialSales`, `revisedPrices`, and `sellConfirmed`, but preserves buy-limit tracking (`totalBought`, `firstBoughtAt`, `limitReachedAt`). `recordBuyOffer()` also preserves these fields from the existing entry. The entry's mode/price fields are overwritten by the next `recordBuyOffer()`. Startup reconciliation skips entries with active buy-limit windows (totalBought > 0 within 4 hours of `firstBoughtAt`). Reconciliation also skips entries with `mode='sell'` and `sellQuantity > 0` — these have pending unrecorded sell profit that the completed-sell sweep (Step 3) must process first. Without this skip, a hot-reload between collecting a completed sell and the sweep running would permanently lose the profit (the item is no longer in any slot or inventory, so reconciliation would otherwise treat it as orphaned). The sweep clears `sellQuantity` after recording profit, so the entry becomes eligible for reconciliation on the next startup.
- **Post-login cleanup**: On the first auto-loop tick after logging back in from a break, `cleanupExpiredIdleEntries()` removes 'idle' entries whose buy-limit window has expired (keeping the cache bounded). Expired `buyFreezeUntil` entries are also cleaned up at this point and the global persisted freeze map is re-saved.
- **Periodic cache cleanup**: In addition to post-login cleanup, `cleanupExpiredIdleEntries()` runs every 60 seconds during long sessions without breaks (e.g. all slots occupied, no idle time to trigger a short break). This prevents expired 'idle' and buy-freeze entries from accumulating unbounded over 24/7 operation. Expired freeze entries are pruned from the global persisted setting on each cleanup. The cost is one cache iteration per 60 seconds — negligible.
- **Merch history cap**: `recordMerchCycle()` trims to the most recent 200 entries per category (profits/losses) per account, preventing unbounded growth. Each entry now includes diagnostic fields for overnight profit analysis: `requestedBuyQty` (what the bot tried to buy vs `qty` = what actually sold), `actualBoughtQty` (from `totalBought`), `buyAbortReason` (null if buy completed naturally, or the stale reason if aborted), `buyElapsedMin`, `buyEtaMin` (original cached ETA), `revisionPrices` (array of actual sell prices at each revision, not just the count), and `sellElapsedMin` (how long the sell offer was active). These fields are optional — existing entries from before the change will have `undefined` and the log dump handles that gracefully.
- **Abort history**: Aborted offers (stale buys with 0% progress, partial-fill buys, sell aborts, frozen swap-outs) are recorded in a separate `abortHistorySetting` (hidden, key `abortHistory`) via `recordAbort()` in `data/abort-history.ts`. Each entry captures: `item`, `type` (buy/sell), `requestedQty`, `filledQty` (what actually filled before the abort — 0 for no-fill buys), `reason` (stale reason string or 'frozen swap-out'), `category` (`'eta'` for ETA-based stale aborts, `'swap'` for frozen swap-out aborts, `'config'` for legacy item-removed-from-list aborts — no longer produced but kept for existing entries), `elapsedMin`, `etaMin` (original cached ETA for comparing actual vs expected), `price`, and `date`. Capped at 200 entries per account. This is the key diagnostic for low overnight profit — aborted 0-fill buys represent wasted time and slot occupancy that merch history doesn't capture (they leave no completed cycle). The abort history is dumped alongside merch history during breaks and via the "Log Merch & Abort History" button, with the category tag shown as `[eta]`, `[swap]`, or `[unknown]` (for legacy entries without the field) before each entry.

### Price revision strategy

When a sell offer doesn't sell and is re-listed (after abort + collect), the price is revised downward using an **escalating reduction** that accelerates with the number of failed revisions. This finds the market price faster instead of slowly chasing a falling market with tiny cuts. The revision only applies if the previous sell offer was confirmed on the GE (`sellConfirmed === true`) — if a hot-reload interrupted the sell flow before the offer was placed, the item is re-listed at the same price with no revision penalty.

**Escalation schedule (by revision count, 0-indexed):**

| Revisions | Reduction rate | Floor |
|-----------|---------------|-------|
| 0–1 | 5% of gross profit | buyPrice + 1 |
| 2–3 | 8% of gross profit | buyPrice + 1 |
| 4–5 | 12% of gross profit | buyPrice + 1 |
| 6 | Abandon — floor drops | buyPrice − 2 |
| 7 | 12% of remaining margin | buyPrice − 2 |
| 8 | Final dump (fixed price) | buyPrice − 5 |

```
rate      = REVISION_RATES[min(revisionCount, 5)]  // 0.05, 0.05, 0.08, 0.08, 0.12, 0.12
floor     = revisionCount >= 6 ? buyPrice - 2 : buyPrice + 1
reduction = max(1, floor(abs(grossProfit) * rate))
newPrice  = max(floor, currentSell - reduction)
```

- Minimum 1 gp reduction (so even thin-margin items get a nudge).
- Before abandoning (revisions 0–5), the price never goes below buyPrice + 1 (never sell at a loss).
- After 6 revisions with 0% sold, the bot **abandons** — the floor drops to buyPrice − 2, accepting a small loss to free the slot faster.
- After 8 total revisions, the bot does a **final dump** at buyPrice − 5 to guarantee a quick sale and free the slot for a profitable item.
- Losses are correctly tracked: `addDailyProfit` subtracts negative profit from the daily total, and `recordMerchCycle` routes negative totals into the `losses` array in merch history.
- The sale price in `merchableItems.json` does NOT include GE tax (it's `rawSalePrice - saleBufferAmount`). GE tax (2%, exempt below 50gp) is deducted at profit-tracking time in `auto-loop.ts` using `getNetSellPrice()` from `constants.ts`.

### Dynamic sell ETA abort ratio

The sell ETA abort ratio scales with profit margin so thin-margin items get more time to sell before being revised (a 1gp cut on a 2gp margin is 50% of profit), while high-margin items are revised sooner (a 5k cut on 100k is only 5%):

```
ratio = clamp(0.95 - log10(profit) * 0.075, 0.50, 0.95)
```

- 2gp margin → 93% of ETA before abort
- 50gp margin → 82% of ETA before abort
- 500gp margin → 75% of ETA before abort (matches the old fixed ratio)
- 10k margin → 65% of ETA before abort
- 100k margin → 58% of ETA before abort
- 1m+ margin → 50% of ETA before abort (capped)

The stalled-near-completion ratio (100% of ETA) remains fixed — that's about offers that are nearly done but stuck, not about price revisions.

### Sell-price fallback chain

When the auto-loop's selling flow (Step 5) needs a sell price for an inventory item, it checks sources in order:

1. **Offer cache** (`cache.getSellPrice`) — primary source. Includes price revision logic for re-listed items.
2. **`priceHistory.json`** (`getPriceHistoryEntry`) — fallback. Written by `determine-flips.mjs` every run using the 1h average prices already fetched (no extra API calls). Used when an item is in inventory but has no cache entry and no `merchableItems.json` entry — e.g. after a long script stop or a JSON refresh during sleep. The 1h average high price is used as the sell price; the 1h average low price is used as the buy price for profit tracking.
3. **Skip** — if neither source has a price, the item is skipped (logged in debug) to avoid selling at an unknown price.

The Wiki API fallback (`fetchWikiPrice` in `data/offer-cache.ts`) remains a stub — the `priceHistory.json` fallback now covers the use case it was intended for, without requiring a runtime API call from the plugin.

### State lifecycle for auto-loop fields

- `autoLoop: AutoLoopState` — created via `createAutoLoopState()` on the class field. Reset in `resetState()` (lifecycle.ts) via `resetAutoLoop(bot)`.
- `autoLoop.activeBuyFlow/SellFlow/AbortFlow` — set when a flow starts, cleared when it completes (done/failed). Also cleared on tick-counter reset in `onGameTick`.
- `autoLoop.cache: OfferCacheManager | null` — lazily initialised on first `autoLoopTick`. Set to `null` in `resetAutoLoop()` so it re-loads from the hidden setting on next access.
- `autoLoop.profilesInitialised` — set to `true` after delay/jitter profiles are loaded. Reset to `false` in `resetAutoLoop()`.
- `autoLoop.sellAttemptedItems/buyAttemptedItems` — cleared after each loop iteration and in `resetAutoLoop()`.
- `autoLoop.buyFreezeUntil` — persisted in the hidden `buyFreezeSetting` (key `buyFreeze`, default `'{}'`, `hidden: true`). **Global (not account-keyed)** — a flat map of lowercase item name → freeze-until timestamp (ms). Freezes represent a market/item-level signal (an item isn't buying at the offered price), which is independent of which account is active. With multi-account rotation, an account-keyed freeze would let account B immediately re-buy an item that account A just aborted as stale. Set when a stale buy offer is aborted (5-min freeze). **Not re-applied if the item is already frozen** — if a previous abort attempt failed and the bot retries the abort, the existing freeze timer is preserved instead of being extended by the duration of the failed attempt. **Not applied for config-driven aborts** (item removed from `merchableItems.json`) — the item wasn't stale, just removed from the list, so re-buying is fine if it's added back. Restored in `resetAutoLoop()` on script start via `loadBuyFreeze()` (expired entries dropped during load; legacy nested `{ account: { item: until } }` format is migrated to flat on first load, keeping the latest expiration per item). Saved on every freeze set and on every cleanup that prunes expired entries (post-login, periodic 60s, buy-scan lazy). Survives hot reloads so a freeze applied after aborting a stale buy offer is not lost on plugin toggle. **Frozen items are skipped during buy scans, but used as a fallback** when no other merchable items are available — an empty slot earns 0gp, while a frozen item might buy if the price issue has resolved. The fallback is tiered by lowball: non-lowball frozen items are tried before lowball frozen items (via `getFrozenFallbackItem` with the `lowballTier` parameter), and logs which frozen item is being used. **Swap-out**: when all slots are occupied and a buy slot has a frozen item with < 50% progress, the bot checks if a non-frozen merchable item is now available. If so, it aborts the frozen item's buy offer (without re-freezing — the item is already frozen) to make room for the non-frozen item. Offers at >= 50% progress are left to finish naturally.
- `autoLoop.failureCounters` — `Record<string, number>` mapping failure key (`geOpen`, `geSubScreen`, `collect`) to consecutive failure count. Incremented by `recordFailure()`, reset to 0 by `resetFailure()` on success, cleared entirely in `resetAutoLoop()` and when the post-login settle completes. See "Consecutive failure termination" section.
- `autoLoop.abortSlotInfo` — set when an abort flow is initiated (stale offer or frozen swap-out). Carries `{ type, itemName, progress, reason, category, etaMin, requestedQty, price, placedAt }` for abort history recording. The `category` field (`'eta'`, `'swap'`, or `'config'`) tags the abort reason for diagnostic filtering. Cleared (`null`) when the abort flow ends (done or failed) and in `resetAutoLoop()`. The extended fields (reason, category, etaMin, requestedQty, price, placedAt) are captured from the cache entry and GE slot at abort trigger time so the abort history entry can be recorded at abort completion.

### GE booth object detection

`findGeBooth()` in `grand_exchange/clerk.ts` searches for tile objects within 20 tiles with `nameContains('Grand Exchange')` and `hasAction('Exchange')`. `findExchangePoint()` returns the nearest of clerk NPC or booth object. `openGe()` interacts with whichever is closer. This satisfies the requirement to check for the "Exchange Grand Exchange Booth" object as the first automated operation.

### Consecutive failure termination

Major "stuck" states terminate the bot after 3 consecutive failures (`MAX_CONSECUTIVE_FAILURES` in `auto-loop.ts`). Recoverable failures (price mismatch, quantity validation, search not found) do NOT use this system — they press Esc and retry the loop.

Tracked operations:
- **`geOpen`** — GE cannot be opened or no clerk/booth found. Counter increments on each failed attempt, resets when `isGeOpen()` returns true.
- **`geSubScreen`** — GE sub-screen (offer config / search / price prompt) cannot be closed with Escape. Counter increments on each Escape attempt, resets when no sub-screen is detected.
- **`collect`** — Completed/aborted offer cannot be collected. Counter increments when collect click fails, resets when no completed/aborted slots remain.

On the 3rd consecutive failure, `bot.terminated = true` and `bot.terminationReason` is set with a clear message. Counters are stored in `autoLoop.failureCounters` (a `Record<string, number>`), reset in `resetAutoLoop()` and when the post-login settle completes.

## External flip-selection pipeline (`determine-flips.mjs`)

`determine-flips.mjs` is a standalone Node automation that pulls OSRS Wiki price data, filters and ranks items, and writes `merchableItems.json`. esbuild inlines that JSON into the plugin bundle at build time; the Titan SDK has no runtime filesystem API.

- Skill / deep-reference: `.devin/skills/mercher-flips/SKILL.md`
- Output file: `merchableItems.json`
- Plugin consumer: `data/merchable-items.ts`

### Key tunables (user-edited constants)

| Constant | Current value | Meaning |
|----------|---------------|---------|
| `MAX_RESULTS` | 100 | Items kept after `flipScore` sorting. |
| `CASH_STACK_MILLIONS` | 10 | Total GP available for flipping. |
| `AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO` | 0.20 | Target base cash per slot (20% = 2m with 10m stack). |
| `MAX_TURNOVER_HOURS` | 2.5 | Max combined buy+sell ETA. |
| `GE_TAX_EXEMPTION_THRESHOLD` | 50 | Items with `rawSalePrice < 50gp` are exempt from GE sales tax (`saleTaxAmount = 0`). Matches the OSRS game rule. |
| `PROFIT_PER_SLOT_HOUR_MINIMUM_THRESHOLD` | 20000 | Minimum `actualProfitPerSlotHour` to pass. |
| `LOWBALL_QUANTITY_GATE` | 5000 | Only lowball items where `min(volume, limit) >= 5000`. |
| `LOWBALL_VOLUME_TIERS` | 200k→2%, 50k→1.5%, 10k→1% | Volume-scaled lowball percentages. |
| `LOWBALL_MARGIN_CAP_RATIO` | 0.5 | Lowball amount capped at 50% of raw margin (`rawSalePrice - basePrice`). Prevents eating the entire spread on thin-margin items. If capped amount < 1gp, no lowball is applied. |
| `LOWBALL_24H_FLOOR` | `24hAvgLow - 1` | Final buy price clamped to at least the 24h average low minus 1gp, never above `basePrice`. Prevents lowballing below the broader market average where insufficient volume exists to fill large orders. |
| `clampPrices` scope | `purchasePrice`, `rawSalePrice`, `lowballBasePrice`, `salePrice` | All four fields are clamped against their 2h averages (5% or 50k, whichever is smaller). Clamping `rawSalePrice` (not just `salePrice`) is critical because `calculateSalePrice()` runs after `clampPrices()` in the second pass and recomputes `salePrice` from `rawSalePrice` — an unclamped `rawSalePrice` (e.g. a low-volume 5m spike that bypassed the 5m-vs-1h filter) would overwrite the clamped `salePrice`. This was the root cause of the Rune platebody 48,190gp sell price (market ~38,400). |

### Cash-allocation implementation

The iterative, turnover-aware allocation is implemented in `determine-flips.mjs`:

1. **First pass**: for every candidate item, compute `actualProfitPerSlotHour` at the base allocation (`max(AVERAGE_SLOT_CASH_STACK_ALLOCATION, purchasePrice)`).
2. **Average baseline**: compute `averageActualProfitPerSlotHour` across all candidates.
3. **Scale**: for each item, scale the base allocation by `sqrt(actualProfit / averageProfit)` (dampened; only above-average items scale up).
4. **Turnover cap**: using the ETA from the scaled quantity, apply:
   - `turnoverEtaMinutes < 30` → max 80% of `CASH_STACK`
   - `30 <= turnoverEtaMinutes < 90` → max 50% of `CASH_STACK`
   - `turnoverEtaMinutes >= 90` → max 25% of `CASH_STACK`
5. **Iterate**: repeat allocation → quantity → ETA → cap until `cashAllocation` stabilises (up to 5 iterations), then compute final quantity, ETAs, and profitability.

This also fixes two underlying problems:
- **Volume double-counting removed**: `calculateSlotCashAllocation` no longer multiplies by `threeHourAverageHourlyVolume` after `maxProfitPerSlotHour` already includes volume.
- **Scaling uses actual profit per slot hour**: `actualProfitPerSlotHour` (post-ETA) is used instead of `maxProfitPerSlotHour` (pre-ETA), so slow, expensive items are not over-allocated.

### Design intent for flip selection

- Primary objective: **maximum profit per hour**.
- `AVERAGE_SLOT_CASH_STACK_ALLOCATION_RATIO` (0.125 = 1.25m of 10m) is the *base* per-slot allocation.
- Scaling above the base is allowed only for items that are both **very profitable AND high turnover**.
- Target ~8 active slots (all GE slots used for buys; sells dynamically free slots by aborting oldest 0-progress buys).
- Allocation must be **iterative and turnover-aware** because ETA depends on quantity and quantity depends on allocation.
- Confirmed turnover caps:
  - `< 30 min` → max 80% of stack
  - `30–90 min` → max 50% of stack
  - `> 90 min` → max 25% of stack

### F2P / P2P membership handling

- `determine-flips.mjs` reads `mappingEntry.members` from the OSRS Wiki `/mapping`
  endpoint and stores `members: boolean` on every output item.
- `data/merchable-items.ts` exposes `members` on the `MerchableItem` interface.
- `grand_exchange/widgets.ts` already provides `isMembersWorld()` and `offerSlotCount()`
  (3 slots on F2P, 8 on P2P).
- `getFirstUnoccupiedMerchableItem` accepts `isMembersWorld` and skips
  members-only items when the current world is F2P. `grand_exchange/auto-loop.ts`
  passes `isMembersWorld()` into it. It also accepts a `lowballTier` parameter
  (`'non-lowball'`, `'lowball'`, or `'any'`) that scopes the scan to instant-fill
  or lowballed items — see "Buying flow" above for the tier order.
- `data/merchable-items.ts` exposes `lowballPercent`, `lowballAmount`, and
  `lowballBasePrice` on the `MerchableItem` interface, plus an `isLowballItem`
  helper (`lowballPercent > 0`). These fields are written by `applyLowball()` in
  `determine-flips.mjs` and used by the buy scan to prioritise instant-fill items.

### Staleness guards

- Every output item now has `dataFetchedAt` and `dataFetchedAtIso`.
- If `merchableItems.length === 0`, `determine-flips.mjs` preserves the existing `merchableItems.json` instead of writing an empty array.
- `data/merchable-items.ts` filters out items whose `dataFetchedAt` is older than 10 minutes.

## Overlay HUD

The plugin draws a small on-screen panel via `this.overlay({ layer: 'AboveWidgets', render })` in `stark-mercher.ts`. The render callback calls `renderBotOverlay(bot)` from `widgets/bot-overlay.ts` every frame while `isHudActive` is true.

### Fields

- **Status** — top-level action string from `bot.statusText`. Updated by the auto-loop at each transition (walking to GE, opening GE, collecting, checking stale offers, aborting, placing buy/sell offer, idle). Break phases are handled directly by the overlay's `getStatusText()` (checks `bot.breakPhase` → "Logging out for break...", "On break", "Sleeping", "Logging in..."). In Paused mode, `statusText` is set to `'Paused'`.
- **Inventory Coins** — live read of `titan.utils.inventory.count(995)`, formatted with thousands separators (e.g. `1,000,000 gp`).
- **Daily Profit** — total profit since 00:00 UK, formatted with `+`/`-` sign and thousands separators. Green when positive, red when negative, grey when zero.

### Status text lifecycle

- `statusText` is set to `'Paused'` or `'Idle'` in `onEnable` depending on `autoMode`.
- `statusText` is set to `'Stopped'` in `onDisable` and `terminate()`.
- The auto-loop sets `statusText` at each step transition.
- `onSettingChanged` updates `statusText` when `autoMode` is toggled.
- The overlay's `getStatusText()` overrides `statusText` for break phases and terminated state.

### Overlay registration

- `isHudActive = false` on the class. Set to `true` in `onEnable`, `false` in `onDisable`.
- `hud = this.overlay({ layer: 'AboveWidgets', render: () => { if (!this.isHudActive) return; renderBotOverlay(this); } })`.
- The overlay renders every frame (client tick), not every game tick. All reads (inventory count, daily profit) are cheap cached operations.

## Daily profit tracking

Profit is tracked per-account in a hidden JSON setting (`dailyProfitSetting`, key `dailyProfit`). Each account has a `{ dayStartedAt, profit }` entry.

- **Recording**: Profit is recorded at two points, using `sellQuantity` stored in the offer cache entry. Both points deduct GE tax (2%, exempt below 50gp) using `getNetSellPrice()` from `constants.ts`:
  1. **Re-list time (Step 5)**: When an item is re-listed after an abort, `soldQty = entry.sellQuantity - item.quantity` (the difference between what was listed and what's still in inventory = what actually sold). Profit = `(getNetSellPrice(entry.sellPrice) - entry.buyPrice) * soldQty`. This handles partial aborts accurately.
  2. **Completed-sell sweep (Step 3)**: Runs every tick at the top of Step 3. A fast-path check (`cache.hasActiveSellEntries()`) skips the entire sweep when no cache entries have `mode='sell'` with `sellQuantity > 0`, avoiding per-tick inventory scans when no sells are in flight. When active sell entries exist, for each such entry, checks if the item is in any GE slot or inventory. If neither, the sell completed 100% — profit = `(getNetSellPrice(entry.sellPrice) - entry.buyPrice) * entry.sellQuantity`. Clears `sellQuantity` to prevent double-counting.
- **Merch history**: When a cycle completes (100% sold), `recordMerchCycle` is called with `totalProfit = (getNetSellPrice(avgSold) - entry.buyPrice) * totalQty`. The `avgSold` field in the history entry is the pre-tax average sell price (for reference); the `profit` field is after tax. The entry also includes diagnostic fields: `requestedBuyQty`/`actualBoughtQty` (from `totalBought`), `buyAbortReason` (null for natural completion), `buyEtaMin` (from `purchaseEtaMinutes`), `revisionPrices` (full array from `entry.revisedPrices`), and `sellElapsedMin` (time from `offerPlacedAt` to now).
- **`sellQuantity` field**: Stored in `OfferCacheEntry` when `recordSellOffer` is called. Represents the quantity currently listed in an active sell offer. Cleared by `clearSellQuantity()` after profit is recorded.
- **`sellConfirmed` field**: Set to `false` by `recordSellOffer()` when the sell flow starts, then set to `true` by `confirmSellOffer()` after the `SellOfferFlow` completes successfully. If a hot-reload interrupts the sell flow before the offer is placed on the GE, `sellConfirmed` remains `false`. The re-list logic checks `isSellConfirmed()` before calling `reviseSellPrice()` — if unconfirmed, the item is re-listed at the same price with no revision penalty (the offer never had a chance to sell). Backward compat: `undefined` (existing entries from before this field) is treated as `true`. Cleared by `clearSellFields()`.
- **Hot-reload write ordering (prevents double-counting)**: Both profit recording points (completed-sell sweep and re-list partial sell) capture the profit data from the cache entry, mutate the cache (clear sell fields / record new sell offer), and call `cache.save()` BEFORE calling `addDailyProfit()` or `recordMerchCycle()`. This ensures that if a hot-reload occurs between the cache save and the profit write, the cache already reflects the cleared/updated sell state — the sweep won't re-trigger and the partial sale won't be re-computed. The worst case is losing one tracking entry (the actual GP is still correct in the coin pouch), never double-counting.
- **Day rollover**: `getDayStartMs(now)` returns the epoch ms of midnight (00:00) for the current UK-local day. On every read (`getDailyProfit`) and write (`addDailyProfit`), the stored `dayStartedAt` is compared to the current day's midnight. If they differ, the profit is reset for the new day. This handles the script being stopped before midnight and restarted the next day.
- **Persistence**: The state is saved to the hidden setting on every `addDailyProfit` call. It survives client restarts and plugin reloads.
- **Per-account**: Keyed by `currentPlayerName` (or `localPlayer.name` as fallback), same as the offer cache.
- **GE tax**: The `salePrice` from `merchableItems.json` does NOT include GE tax (it's `rawSalePrice - saleBufferAmount`). GE tax is deducted at profit-tracking time using `getNetSellPrice(sellPrice)` from `constants.ts` (2% tax, exempt for items below 50gp). This ensures the daily profit and merch history reflect actual realized profit after tax.

## World hopping

The bot hops to a random safe members world at a profile-scheduled interval (18–45 min base, with jitter and long-tail outliers). This is adapted from stark-mixology's hopper.

### Settings

- `hopWorlds` (boolean, default `true`) — enables/disables world hopping.
- `hopRegion` (combo, default `0` = Any) — restricts hops to UK, Germany, US, or Any.
- `resetHop` (button) — clears the scheduled next hop timer.
- `forceHop` (button) — forces the next hop to become due immediately (still waits for a safe boundary).

### Hop profile (`HoppingProfile` in `SessionProfile`)

- `minMinutes` / `maxMinutes` — base interval range (18–25 / 32–45 min).
- `jitterMinutes` — +/- jitter (3–6 min).
- `outlierChance` / `outlierMultiplier` — long-tail outlier (3–8% chance, 1.3–1.8x).
- `outlierNestedChance` / `outlierNestedMultiplier` — nested outlier (15–25% chance, 1.3–1.5x).
- `cooldownMinTicks` / `cooldownMaxTicks` — post-hop cooldown (20–35 / 35–55 ticks).
- `resumeMinMs` / `resumeMaxMs` — post-hop resume delay (2500–5000 / 5000–8000 ms).

### Safe boundary

The only blockers for a hop are:
1. `hopInProgress` — a hop is already in flight.
2. `!isPlayerIdle(bot)` — the player is animating or moving.
3. Idle buffer — player has been idle for less than 2 ticks.

GE interface, inventory items, and location all persist across hops or are transient.

### Hop flow

1. `scheduleNextHop` samples an interval and sets `nextHopAtMs`.
2. When `Date.now() >= nextHopAtMs`, `forceHopPending` is set to pause new actions.
3. `isAtSafeBoundary` is checked — waits for player to be idle.
4. `pickWorld` filters `titan.state.world.list()` for safe members worlds in the chosen region.
5. `titan.state.world.hopIngame(worldId)` dispatches the hop.
6. `completeHop` (called from `onGameStateChanged` / `hopStep`) waits for login + world match, then resets state and starts a resume delay.
7. After the resume delay, the auto-loop resumes normally.

### State lifecycle

- All hop fields are reset in `resetHopState` (called from `resetState` in lifecycle.ts).
- `resetInFlightActionState` (called by `completeHop`) clears auto-loop flows, test flows, idle-for-break flags, and marks cache reconciliation and post-login cleanup for re-run after the transition.
- `sessionPlayStartMs` is set to -1 when a nightly break starts, and lazily re-initialised when the player is logged in and not on a break.

### Bot fields

| Field | Type | Default |
|---|---|---|
| `nextHopTick` | number | -1 |
| `nextHopAtMs` | number | -1 |
| `nextHopStartAtMs` | number | -1 |
| `nextHopTargetTicks` | number | -1 |
| `nextHopPausedRemainingMs` | number | -1 |
| `hopResumeAtMs` | number | -1 |
| `lastHopTick` | number | -1 |
| `lastHopMs` | number | -1 |
| `hopInProgress` | boolean | false |
| `hopSawLoggedOut` | boolean | false |
| `hopToWorldId` | number | -1 |
| `hopCooldownTick` | number | -1 |
| `hopCooldownTicks` | number | 30 |
| `forceHopPending` | boolean | false |
| `hopJustCompleted` | boolean | false |
| `hopJustCompletedAtMs` | number | -1 |
| `hopCount` | number | 0 |
| `sessionPlayStartMs` | number | -1 |
| `consecutiveMovingTicks` | number | 0 |
| `lastPlayerStationaryTick` | number | 0 |

## Overlay HUD (updated)

The overlay now includes a TIMERS section beneath the Daily Profit field:

- **Status** — shows break/sleep countdowns: `Sleeping (6h 56m 46s)`, `Breaking (2m 15s)`, `Hopping`, `Resuming`, `Logging out for break...`, `Logging in...`, plus the auto-loop status text.
- **Inventory Coins** — live coin count with thousands separators.
- **Daily Profit** — profit since 00:00 UK, green/red/grey.
- **TIMERS** section:
  - **Session (Day)** — elapsed since `sessionPlayStartMs`, with target duration in parentheses. Shows "Sleeping" during nightly break.
  - **Next Hop** — countdown to next world hop, or "Disabled", "Sleeping", "Hopping...", "Resuming...", "On Break", "Waiting to Hop...".
  - **Sleep Time** — UK-formatted bedtime (HH:MM), or "Sleeping" when currently sleeping.
  - **Wake Time** — UK-formatted wake time, with countdown `(in Xh Ym Zs)` when sleeping.
