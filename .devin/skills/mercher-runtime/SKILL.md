# Stark Mercher — Runtime auto-loop, state machine & log diagnostics

This skill covers the plugin's **runtime behavior**: the auto-merch loop, GE offer
state machines, cache lifecycle, stale/abort/revision logic, break/rotation/hop
systems, and how to diagnose bugs from logs. The companion skill
`mercher-flips/SKILL.md` covers the external `determine-flips.mjs` data pipeline.

Use this skill when: analyzing logs, diagnosing stuck/looping behavior, tracing
abort/relist cycles, understanding cache reconstruction, verifying break/rotation
behavior, or debugging any runtime issue.

---

## Mode toggle & Start/Stop Script button

`autoMode` combo: `Paused` (0, default) / `Normal` (1) / `Slow` (2) / `F2P`
(3). Paused = no script logic at all (every loop callback early-returns on
`autoModeValue === 0`); the overlay still renders. The **Start/Stop Script**
button (`startStop` buttonSetting, position -2 — top of the settings panel)
toggles the mode programmatically — identical to switching the Mode combo.
Stop saves the current mode to `lastActiveMode` (persisted via the hidden
`lastActiveMode` string setting — hot-reload only) and writes
`autoMode.value = 0`; Start writes `autoMode.value` back to the last active
mode. A `terminated` bot counts as stopped — clicking the button runs
`resetForResume()` (same recovery as a plugin toggle off/on, including a
fresh `scriptStartMs` since `terminate()` cleared the setting) before
resuming. The button invokes `onSettingChanged('autoMode')` after the
write; the mode-change block there is guarded by a previous-value check,
so it is idempotent whether or not the native layer fires the callback on
programmatic writes. `isRunning` mirrors `autoModeValue !== 0` (set in
`onEnable`/`onSettingChanged`, cleared by `resetState`/`terminate()`) —
informational only, not a gate.

**Log signatures** (same as a manual Mode switch):
- `Mode switched to Paused — all script logic stopped.` — Stop clicked
- `Mode switched to <Normal|Slow|F2P> — resuming on next tick.` — Start clicked
- `Start clicked — clearing terminated state and resuming.` — Start on a
  terminated bot (precedes the mode-switch log when the mode also changes)

---

## Auto-merch loop order (`autoLoopTick`)

The loop runs one tick at a time. Only one action per tick. When a flow is active,
the loop defers to it until it completes.

1. **GE-open check** — walk to GE if needed, open via clerk/booth. Wall-clock
   cooldown 3s prevents duplicate clicks during post-login tick bursts.
2. **Close GE sub-screens** — if offer config / search / price prompt is open
   (e.g. after a reload mid-flow), close with Escape.
3. **Defer to active flows** — if BuyOfferFlow / SellOfferFlow / AbortOfferFlow
   is in progress, tick it and return.
4. **Audit all 8 slot states** — `auditGeState()` reads slot type (buy/sell/empty),
   item name, quantity, price, progress, status. **Truncated name resolution**: the
   GE slot widget truncates long single-word item names with "..." (e.g.
   "Antidote++(4)" → "Antidote++...") because the renderer can't break them across
   lines. `getOfferSlotState()` resolves these via the slot's itemId (child 18,
   never truncated) — looking up `getMerchableItemById` then
   `getPriceHistoryEntryById` to recover the full name. Only fires when the name
   ends with "..." (rare); non-truncated names incur zero overhead. If neither
   data source has the itemId, the truncated name is kept (slot stays unmanaged).
5. **Cache reconciliation (one-time)** — removes orphaned cache entries (items not
   in any GE slot, not in inventory, no active buy-limit window, no pending sell
   profit). **'Unknown' slot guard**: if any slot has `type === 'unknown'` (GE
   widget not fully loaded yet), both reconciliation and reconstruction defer to
   the next tick — unknown slots have null `itemName`, so running reconciliation
   now would incorrectly remove active cache entries as orphaned. Both flags
   (`cacheReconciled`, `cacheReconstructed`) are only set when all slots are
   readable.
6. **Reverse reconstruction (one-time)** — reconstructs cache entries for occupied
   slots with no cache entry (cache lost after client restart). Also refreshes
   unconfirmed sells that are clearly live on the GE, and fixes mode mismatches
   where the cache entry's mode doesn't match the live GE slot type (caused by
   setting reverts after plugin reloads — e.g. `npm run build`). Subject to the
   same 'unknown' slot guard as step 5.
7. **Completed-sell sweep + Collect** — if any slot is `completed_or_aborted`,
   click collect. Wall-clock cooldown 3s. After collecting, a **thinking pause**
   of `createDelay(5, 50, 20)` is set (3-12s — simulates reading the result
   before the next action; matches human data showing 3-8s typical, rare
   8-15s outliers). Completed sells are NOT removed from
   cache (kept for buy-limit tracking). Profit is recorded here when a sell
   finishes 100%. **Pre-collect recording**: if a sell slot is
   `completed_or_aborted` (100% progress) and the bot did NOT initiate an
   abort (no `activeAbortFlow`, no `abortSlotInfo`), the profit is recorded
   IMMEDIATELY — before the collect click. This eliminates the vulnerability
   window where a hot-reload between the collect and the next tick's sweep
   could lose the profit permanently (the cache setting may revert to a
   stale pre-sell state, or `fixModeMismatch` may clear sell fields when a
   new buy for the same item is already live on the GE). Reconstructed
   entries (from cache loss after a client restart) are excluded — those
   still wait for the collect + `inInv` check (post-collect path).
8. **Stale offers** — for each active slot, check stale conditions. If stale,
   create an AbortOfferFlow. See "Stale checks" below.
9. **Selling** — find empty slot + non-coin inventory item. Skip items being
   bought in a GE slot (items from partial buy aborts wait for the buy to
   complete/abort). If the item is already in a **sell** slot, trigger a
   **consolidation abort** of that sell slot — the abort returns the sell's
   items to inventory, combining with what's already there. The next sell
   scan iteration places a single consolidated sell with the combined
   quantity. This cleans up duplicate sells that may have been created by
   edge cases (GE state lag, hot reloads during abort flows). Each
   consolidation cycle reduces the duplicate count by one. Start
   SellOfferFlow. Uses cached sell price (revised if re-listing) or
   merchableItems.json price or priceHistory.json fallback.
10. **Buying** — find empty slot + best merchable item at runtime. 5-tier scan
    (non-lowball → non-lowball frozen → lowball → lowball frozen → partial
    fallback). Start BuyOfferFlow. **Pre-sleep lowball priority**: during the
    final 30 minutes before nightly sleep, the tier order reverses to
    lowball → lowball frozen → non-lowball → non-lowball frozen → partial
    (lowball first), and the lowball turnover cap is relaxed from 120min to
    240min. Lowball offers (buy below market, slower fills, higher margins)
    are better suited for the ~4h unattended sleep window. Invalid, disabled,
    expired, or already-started nightly schedules do NOT activate pre-sleep
    mode. **Slow Mode preferred tier**: when `autoMode === 2` (Slow) AND
    pre-sleep is NOT active, a tier 0 is prepended that targets lowball items
    with a runtime buy ETA of 30–60 minutes (relaxed 240min turnover cap)
    ahead of the normal tier order. These slower, higher-margin fills suit
    the ~30-minute account login cadence. If tier 0 finds nothing, the scan
    falls through to the normal tier order unchanged — fast non-lowball flips
    remain eligible. The frozen swap-out path also tries the slow preferred
    tier first when Slow Mode is active. Slow Mode does NOT alter
    login/logout/break/rotation/hop timing; it only changes buy-offer item
    selection. Pre-sleep takes precedence over Slow Mode when both would
    apply. **Stale-data safeguard**: if `isMerchableDataValid()` fails (count
    < 5 or freshness > 10min), the buy scan is skipped and the loop falls
    through to the idle path (step 11) — it does NOT `return false`, which
    would skip idle scheduling and cause a tight loop every tick. The
    frozen-swap path (all slots occupied) also skips swaps when data is stale
    and falls through to idle.
11. **Wait** — all slots occupied or nothing to do. Idle with humanised delay.

### Log signatures for each step

| Step | Log line | Notes |
|------|----------|-------|
| 1 | `Click: opcode=23 ... text=Walk here` | Walking to GE |
| 1 | `Click: opcode=57 ... text=Exchange` | Opening GE booth |
| 2 | (no explicit log, Escape key) | Sub-screen close |
| 3 | (flow-specific logs) | See flow sections below |
| 5 | `Cache: post-login cleanup — ...` | Orphan removal |
| 6 | `Cache: reconstructed entry for X (...)` | Reverse reconciliation |
| 6 | `Cache: fixed mode mismatch for X (buy -> sell, ...)` | Mode mismatch fix |
| 6 | `Auto: reverse reconciliation reconstructed N entries: ...` | Summary |
| 6 | `Auto: reverse reconciliation fixed N mode mismatch(es) ...` | Mode mismatch summary |
| 7 | `Click collect to inventory: interact(57, 1, 0)` | Collect click |
| 7 | `Auto: offer aborted successfully.` | Abort flow completed |
| 8 | `Auto: aborting stale offer in slot N (...)` | Stale abort triggered |
| 9 | `Cache: recorded sell offer for X @ Ygp` | Sell recorded |
| 9 | `Auto: selling Nx X @ Ygp each in slot Z — proj profit +/-Pgp, sellEta Tmin` | Sell placed (includes projected profit + ETA) |
| 9 | `Auto: consolidating X — aborting sell in slot N (P% progress) to combine with Mx in inventory` | Duplicate sell consolidation abort triggered |
| 9 | `Auto: sell offer placed successfully.` | Sell flow completed |
| 10 | `Cache: recorded buy offer for X (buy=Y, sell=Z)` | Buy recorded |
| 10 | `Auto: buying Nx X @ Ygp each ... — profit/hr Pgp, buyEta Tmin, sellEta Tmin` | Buy placed (includes profit/hr + ETAs) |
| 10 | `Auto: buy offer placed successfully.` | Buy flow completed |
| 11 | `Idle — short break in N ticks` | Nothing to do |
| 11 | `Staying logged in — next action ETA Xmin (≤1min), re-checking in N ticks` | Imminent action, skipping break |
| * | `Delaying Nt (action, Nt elapsed of Mt)` | Humanisation delay in progress (debug only, once per action) |
| * | `Auto: action=auto_X delay=Nt [layers]` | Action set with humanisation layers (debug only) |

---

## Humanised delays (`createDelay`)

All action-to-action delays go through `createDelay(base, triggerChance, max?, suppressDistractions?)`
in `antiban/humanised-delay.ts`. Per-account deterministic `DelayProfile`
(djb2/mulberry32, same pattern as typing profiles).

**Layers** (in order):
1. **Reaction bias** (always) — ±2 ticks from account speed profile
2. **Jitter** (always) — ±1-2 ticks noise
3. **Hesitation** (triggered) — 1.5-3x multiplier
4. **Outlier** (triggered, 3-8%) — 1.3-1.8x, nested 15-25% for 1.3-1.5x
5. **Jitter amplification** (triggered, 0.5-2%) — +5-30 ticks
6. **Micro-distraction** (always, 2-4%, skipped when `suppressDistractions`) — +10-40 ticks (6-24s), bypasses `max`
7. **Rare distraction** (always, 0.1%, skipped when `suppressDistractions`) — +30-100 ticks (18-60s), bypasses `max`

Layers 6-7 fire independently of `triggerChance` and are not clipped by `max`,
creating a visible long tail in the reaction-time distribution. Over an hour of
active play, expect ~2-4 micro-distractions and ~0-1 rare distractions.

**`suppressDistractions`**: When `true`, layers 6-7 are skipped entirely. This is
used by the GE offer flows (buy/sell/abort) for their mid-flow steps — a 6-60s
pause between connected clicks (e.g. between clicking "Enter price" and typing
the digits) is non-human. The distraction layers still fire between independent
actions (idle, walk, open GE) via the auto-loop's direct `createDelay` calls,
where a human would actually glance at chat or tab out. The post-Confirm and
post-Collect thinking pauses (`createDelay(5, 50, 20)`) also allow distractions
to fire — a human reading the GE result may glance at chat or tab out. Without
this, each flow (~15-20 `createDelay` calls) had a ~46% chance of at least one
6-24s mid-flow pause.

**Debug logging**: When debug logging is enabled (`logInfo` is independent), each action delay log includes
which layers fired in brackets, e.g. `delay=4t [hesitation+outlier]` or
`delay=12t [micro-distraction]`. An empty bracket means only base+bias+jitter
applied. A separate `Delaying Nt (action, Nt elapsed of Mt)` log fires once per
action when the delay starts, showing the remaining wait — useful for verifying
humanisation is active and the bot isn't stuck.

**Diurnal pace (fatigue)**: After all layers fire, the final delay is scaled by
a diurnal pace multiplier that drifts smoothly across the waking day. After
nightly sleep ends, the player is "fresh" (0% fatigue, 0.8x multiplier = 20%
faster than baseline). Fatigue increases linearly to 100% just before the next
nightly sleep (1.05x multiplier = 5% slower than baseline). This models real
circadian rhythm — a short break doesn't reset fatigue, only a full night's
sleep does. The multiplier is applied to the final delay (after all layers), so
base, hesitation, outliers, and distractions all scale together with freshness.
Day bounds are set by `setDayBounds(startMs, endMs)` in
`antiban/humanised-delay.ts`, called from `markNightlyBreakFinished` (on wake),
`scheduleNextNightlyBreak` (on schedule recompute), and `restoreBreakState`
(on hot reload). The fatigue percentage is not displayed on the overlay (the
  overlay was stripped to a minimal mode-label + start time — the diurnal pace
multiplier is still applied internally by `createDelay`).

## GE position variation

`walkToGe()` picks a random tile from `GE_STAND_TILES` (12 tiles around the GE
area, near different clerks/booths) so the bot doesn't always stand on the same
tile. `GE_WALK_POINT` is retained as a fallback but no longer used directly.

## GE offer flows (state machines)

### BuyOfferFlow (~21 steps)

Click create buy → type item name → click search result → enter quantity → enter
price → confirm. Connected click steps use `computeDelay(1, 25, 4)` (1 tick
base, 25% hesitation, max 4 ticks — 75% of clicks land within 1-3 ticks for
rapid burst behavior, 25% hesitate to 2-4 ticks for normal pace). Wait-state
steps use `computeDelay(1, 30, 4)`. All mid-flow steps suppress 6-60s
distractions. After the flow completes (Confirm clicked + slot verified), the
auto-loop sets a **thinking pause** of `createDelay(5, 50, 20)` — 50% no
hesitation (~3-5 ticks ≈ 1.8-3s, "glanced at result"), 50% hesitation (~10
ticks ≈ 6s, "reading the result"), rare outlier up to 20 ticks (12s). This
matches human data showing 3-8s typical pauses after Confirm with rare 8-15s
outliers.

**Early-stop search typing**: While typing the item name (step 4), the flow
checks each tick whether the desired item has appeared as the **unique** GE
search result (e.g. "magp" uniquely matches "Magpie impling jar" because no
other GE item starts with "magp"). If so, the remaining typing is cancelled —
real players stop typing once they see their item. This is both faster and more
humanlike. A minimum prefix of 3 characters is required (the SDK types
char-by-char, and `scanSearchResultsUnique` reads the actual result widgets, so
the unique result is only visible after enough chars have been typed). The
early-stop check is naturally safe during typing-mistake sequences — the wrong
character won't produce an exact match for the target item, so
`scanSearchResultsUnique` won't return `unique: true` until the mistake is
corrected. After spotting the unique result, there's a **40% chance of a 1-2
tick "looking at results" delay** before clicking, simulating the human moment
of registering the result before acting.

**Log signature**: `Click buy slot N: interact(57, 1, 3)` → search result clicks →
`Click enter quantity` → `Click enter price` → `Click confirm offer` →
`Auto: buy offer placed successfully.`

**Early-stop log signatures**:
- `Step 4: Early-stop — unique result for "X" spotted (1 result), cancelling typing`
- `Step 4: Looking delay — waiting Nt before clicking result` (40% chance)
- `Step 4: Early-stop looking delay complete — advancing to click result`

**Stateless recovery after reload**: On the first tick after enable (or after
a tick-reset), `runStartupAudit()` in `stark-mercher.ts` audits the GE state.
If a GE sub-screen is open (offer config / search / quantity / price prompt),
it sends a one-time Escape to close it. The auto-loop then reopens the GE and
starts fresh flows from the main screen. This replaces the previous
flow-reconstruction approach (`startupResumeBuyFlow` + `resumeFromState`),
which was prone to stuck loops when the post-Escape widget state didn't match
the reconstructed flow's expectations (e.g. the quantity prompt closed before
the re-click landed, `interact()` returned false, and the flow looped
indefinitely on "state not reached").

**Title-screen deferral**: The audit is deferred if the player is on the title
screen or settling after login. The check uses `isTitleScreenVisible()` (exported
from `antiban/login.ts`, single targeted widget lookup via `findTitleWidget`) OR
`titleWaitingForGone` OR `postLoginResumeAtMs > 0`. If any is true, the audit
waits for the next tick (logged once via `startupAuditDeferredLogged` to avoid
spam). This prevents the audit from logging a misleading `screen=closed,
geOpen=false` state or attempting GE actions while the player is not yet
in-world. The existing login FSM remains responsible for clicking the title
screen. The audit runs on the first tick after the player is in-world and all
title/login/settle state has cleared.

This is safe because:
- Interrupted buys lost nothing (no items spent, no offer confirmed) — the
  orphaned cache entry is removed by cache reconciliation.
- Interrupted sells still have their items in inventory — the sell scan
  re-lists them at the same or revised price.
- Already-placed offers in GE slots are unaffected — they're handled by the
  collect / stale-check / sell-sweep flows normally.

The auto-loop's existing "close GE sub-screen" guard (Step 1b) remains as a
fallback: if the startup Escape doesn't land, the auto-loop will close the
sub-screen on the next tick.

Startup audit log signatures:
- `Startup audit deferred — title screen / login settle in progress` (when deferred)
- `Startup audit: screen=..., geOpen=..., slots=...` (when run)
- `Slot N: buy/sell X (qty N, N coins)` (per active slot)
- `Startup audit: GE sub-screen open — sending Escape to close (auto-loop will start fresh)`

**Quantity/price prompt disambiguation**: `GE_PRICE_PROMPT_WIDGET` (10616875)
is the chatbox dialogue container visible during BOTH the quantity prompt
("How many do you wish to buy?") and the price prompt ("Set a price for each
item:"). `auditGeState()` checks `isQuantityPromptShown()` (text contains
"how many") before `isPricePromptShown()` to correctly distinguish the two.

**Confirm-grace isolation (step 19)**: `waitForConfirm()` uses a single `waitTicks`
counter both for polling `isOfferConfigOpen()` (waiting for the config screen to
close after the Confirm click) and for the subsequent slot-occupied verification.
When the config screen takes 3+ ticks to close — common after a stateless
recovery resume at the validate/confirm step — the counter is exhausted before
slot verification begins, causing false
`Offer was not placed — slot is still empty after confirm` failures even when the
offer actually appears in the slot on the next tick. The fix resets `waitTicks = 0`
the first time `isOfferConfigOpen()` returns false, so the slot-occupied check
gets its own independent grace window separate from the config-screen
polling phase. The grace window is 10 ticks (6s) — increased from the original
3 ticks (1.8s) because after a hot reload, the confirm click can take longer
to process and the slot-occupied state may not register within 1.8s, causing
false `Offer was not placed` failures even when the offer was actually placed
(confirmed in runtime logs: slot showed `buy:active` in the next scan but the
flow had already failed). The reset is guarded by a `configClosedObserved`
flag (reset in `advance()`) so it fires exactly once on the open→closed
transition — without this guard, the reset would run every tick and the
slot-occupied grace counter could never accumulate, causing an infinite
active-but-stuck loop where the auto-loop ticks the buy flow forever with no
state transition, completion, or failure log (symptom: repeated
`Auto: ticking buy flow for X` with no progress). The same 10-tick grace
applies to `SellOfferFlow.waitForConfirm()`.

### SellOfferFlow

Click create sell → click inventory item (Offer) → enter price (quantity defaults
to full stack) → confirm. If item spans multiple inventory slots, clicks "All"
button to combine. Connected click steps use `computeDelay(1, 25, 4)` (rapid
burst timing — see BuyOfferFlow). After the flow completes, the auto-loop sets
a thinking pause of `createDelay(5, 50, 20)` (3-12s, see BuyOfferFlow).

**Log signature**: `Click sell slot N: interact(57, 1, 4)` → `Click: ... text=Offer`
→ `Click enter price` → `Click confirm offer` → `Auto: sell offer placed successfully.`

### AbortOfferFlow

Click slot detail (View offer) → click Abort → click Back → click Collect to
inventory. Connected click steps use `computeDelay(1, 25, 4)` (rapid burst
timing — see BuyOfferFlow). After the flow completes, the auto-loop sets a
thinking pause of `createDelay(5, 50, 20)` (3-12s, see BuyOfferFlow). After
completion, the abort history is recorded, the cache is
updated (re-list handling or buy-limit tracking), and — for stale sell aborts
with `<25%` progress — the sell-abort count is incremented and a progressive
buy freeze is applied (via the `countSellAbort` flag on `abortSlotInfo`, set
at detection time, with the actual increment + freeze deferred to abort
completion). The sell count feeds into the effective count (buy + sell) for
the progressive freeze duration and hard-skip threshold.

**Log signature**: `Click open slot N detail` → `Click abort offer` →
`Click back to GE main` → `Click collect to inventory` →
`Auto: offer aborted successfully.`

**CRITICAL**: The `Auto: offer aborted successfully.` line alone does NOT tell you
which abort path triggered it. The triggering log is one of:
- `Auto: aborting stale offer in slot N (type item — reason)` — normal stale path
- `Auto: no empty sell slot — aborting lowest profit/hr 0-progress buy ...` — sell slot
  freeing (sacrifices the buy with the lowest projected profit/hr, oldest as
  tiebreaker, to keep the swap consistent with item selection)
- `Auto: aborting frozen fallback buy ... — replacing with ...` — frozen swap-out

If you see `Auto: offer aborted successfully.` without a preceding trigger log,
check the abort history dump for the `reason` field to identify the cause.

---

## Stale checks (`isSellOfferStale` / `isBuyOfferStale`)

### Sell stale checks (in order)

1. **Dump-floor guard with controlled loss dump (Option 1)**:
   - If `cache.isAtDumpFloor(itemName)` is true (sell price ≤ tax break-even
     floor AND rev count ≥ 8), the guard checks a hold timer before deciding
     whether to skip stale checks:
   - **Rev 9+ at 80% minimum** (`!canReduceControlledLoss`): the price is at
     the absolute minimum (80% of buyPrice). Skip all stale checks — let the
     offer fill at its own pace.
   - **Rev 8 (at tax break-even floor)**: hold for `DUMP_FLOOR_HOLD_MIN`
     (90 min) at 0% progress. If the hold timer hasn't expired, skip stale
     checks. If it has expired, fall through to the 0-progress absolute cap
     below, which triggers an abort. The sell scan then calls
     `reviseSellPrice` which applies the controlled loss pricing tier (rev 9+,
     pricing below the tax break-even floor).
   - **Rev 9+ (below tax break-even floor)**: hold for
     `DUMP_FLOOR_CONTROLLED_LOSS_HOLD_MIN` (30 min) at 0% progress. Same
     fall-through behavior — shorter hold since the loss has already been
     accepted and the goal is to free the slot quickly.
   - The controlled loss dump reduces the sell price by 3% of buyPrice (min
     5gp) per revision, capped at 80% of buyPrice. Up to 4 controlled loss
     revisions (rev 9–12) are applied before the offer is left at the minimum.

2. **Reconstructed profit guard** (only for `entry.reconstructed === true`):
   - **Zero/negative profit**: `netSellPrice(sellPrice) - buyPrice <= -tolerance`
     after 2% GE tax → abort immediately (no grace period). Tolerance is
     `max(5gp, 2% of sell price)` to avoid false aborts from priceHistory
     reconstruction error.
   - **Low profit/hr**: `profitPerItem * quantity / (sellEta / 60) < 5000` → abort
     only after 5-min grace period AND only if 0% progress. If even 1 item sold,
     the offer is left alone.
   - The `reconstructed` flag is cleared by `recordSellOffer()` and
     `confirmSellOffer()`, so this guard only fires on the original pre-existing
     offer, not on the bot's own re-lists.
   - The `reconstructedBuyPrice` flag is NOT cleared by `recordSellOffer()` or
     `confirmSellOffer()` — it survives re-list cycles so the completed-sell
     sweep can skip recording phantom losses from uncertain buy prices. It is
     only cleared by `recordBuyOffer()` when the bot places a new buy with a
     known price.

3. **0-progress absolute cap**: `elapsed >= clamp(eta * 0.5, 20, 60)` min AND
   `progress < 0.01` → abort. Fast items (≤40min ETA) get 20min floor, slow items
   get up to 60min.

4. **Partial-progress stall with no ETA**: `progress >= 0.01` AND `rawEta <= 0`
   AND `timeSinceLastProgress >= 45min` → abort. Catches partial-progress sells
   that have no ETA data (cached/reconstructed entries with `saleEtaMinutes = 0`).
   Without this check, such offers skip all ETA-based stale checks (the
   `rawEta <= 0` bail-out) and can sit indefinitely at a stale progress level —
   e.g. Contract of Glyphic Attenuation stuck at 69.5% for 60+ minutes, tying up
   capital and a GE slot. Uses `lastSellProgressAt` (tracked by the stale-check
   loop) to measure time since last progress change; falls back to total elapsed
   time if no progress tracking exists. Threshold:
   `SELL_PARTIAL_PROGRESS_NO_ETA_STALL_MIN = 45`.

5. **Progress-since-revision extension**: if the offer has made progress recently
   (progress increased within the last half-ETA window) AND elapsed < 2x ETA →
   skip the ETA-based checks below. The offer is actively selling — give it more
   time instead of prematurely revising the price. This prevents aborting offers
   that are filling at a reasonable rate but slower than the ETA predicted (e.g.
   Dragon dragon bolts at 67% sold when the ETA predicted 100% — the item was
   actively selling, not stuck). Tracked via `lastSellProgress`/
   `lastSellProgressAt`, reset to 0 on every revision/re-list/confirm. The
   extension is capped at 2x ETA to prevent infinitely extending truly slow
   items. If progress stalled more than half an ETA window ago, the extension
   doesn't apply — the item is no longer actively selling.

6. **ETA-based stale**: `elapsed >= eta * abortRatio` AND `progress < 0.25` → abort.
   `abortRatio = clamp(0.95 - log10(profit) * 0.075, 0.50, 0.95)` — thin-margin
   items get more time (93% of ETA for 2gp margin), high-margin items less (50%
   for 1m+ margin). Minimum ETA floor: 5min (`SELL_ETA_FLOOR_MIN`).

7. **Stalled near completion**: `elapsed >= eta` AND `progress < 1.0` → abort.
   Catches offers that are nearly done but stuck.

### Buy stale checks

**Buy ETA floor**: `BUY_ETA_FLOOR_MIN = 10` min. Runtime buy ETAs for
high-volume items with small quantities (e.g. 2k Soul runes at ~3min) are
mathematically correct for volume but don't account for GE queue dynamics.
The ETA is floored to 10 min before any stale-check threshold is computed.

**Non-linear ETA model**: Runtime ETAs use `eta = BASE_FILL_TIME_MIN + (qty /
volume_per_hour * 60)` where `BASE_FILL_TIME_MIN = 5`. The base component
represents "time to first fill" independent of quantity — GE fills are
queue-based and chunky, so even a small order has to wait for sellers. This
prevents unrealistically short ETAs for small quantities of high-volume items.

**Profit/hr-based abort scaling**: Buy aborts are "giving up" — unlike sells,
there's no revision system to find the right price. The only reason to abort
a buy is if the slot could earn more profit/hr with a different item. High
profit/hr items get more patience because (1) the opportunity cost of freeing
the slot is higher (especially when the item pool is exhausted), (2) high-value
items have chunkier fill patterns (Poisson noise — at 50% of ETA, P(0 fills)
can exceed 50% for low-volume items), and (3) aborting and re-selecting has
overhead (freeze time + flow placement + new fill time).

The scale factor is log-scaled from the runtime minimum profit/hr (20k):
`factor = min(2.5, 1.0 + log10(profitPerSlotHour / 20000) * 0.75)`. At 20k
the factor is 1.0 (current behavior unchanged). At 50k ~1.5x, at 100k ~1.75x,
at 250k ~2.1x, capped at 2.5x. The floor (min) of the absolute cap scales by
the full factor; the ceiling (max) scales by a reduced factor (capped at 1.5x)
so high-profit items don't tie up a slot for 2+ hours. Thin-margin items
(profitMargin ≤ 3gp) are excluded from profit scaling — they already get 125%
of ETA via the thin-margin exception, and their profit/hr is inherently low.

| Profit/hr | Scale factor | 15min floor → | 60min ceiling → |
|-----------|-------------|---------------|-----------------|
| 20k | 1.0x | 15min | 60min |
| 50k | 1.53x | 22.9min | 79.5min |
| 100k | 1.75x | 26.3min | 90min (1.5x cap) |
| 243k | 2.1x | 31.5min | 90min (1.5x cap) |

The profit/hr is computed at stale-check time from the cache entry's ETAs and
the merchable item's profit margin: `runtimeProfitPerSlotHour = quantity *
profitMargin * (60 / turnoverEta)` where `turnoverEta = buyEta + sellEta`.

1. **0-fill absolute cap**: `elapsed >= clamp(eta * 0.5, 15 * sf, 60 * csf)`
   (non-lowball) or `clamp(eta * 0.5, 30 * sf, 90 * csf)` (lowball) AND
   `bought == 0` → abort. `sf` = profit scale factor (floor), `csf` = ceiling
   scale factor (max 1.5x). The effective threshold is `min(eta * 1.25 * sf,
   absolute cap)`.
   **Thin-margin exception**: for items with `profitMargin <= 3gp` (bulk-fill
   minimal-margin items like Ancient essence), the absolute cap is set to
   `eta * 1.25` (125% of ETA, no profit scaling), so the ETA threshold
   (`BUY_ETA_ABORT_RATIO_ZERO`) is the effective check. These items often sit
   at 0% then fill all at once, and the opportunity cost of a stuck slot is
   low. The normal buy-freeze applies after the abort.
2. **ETA + partial fill**: `elapsed >= eta * 0.90 * sf` AND `progress > 0` AND
   `bought < 0.5 * qty` → abort. The `progress > 0` guard ensures 0-progress
   offers are handled only by the 0-fill check above, which gives more patience
   (125% ETA or the absolute floor). Without this guard, a 0-progress offer with
   a short ETA (e.g. Soul rune at 3.2min) gets aborted at 90% of ETA (2.88min)
   before the 0-fill check ever fires.
3. **No-progress for partial fills**: `elapsed since last progress >=
   clamp(eta * 0.25, 10 * sf, 30 * csf)` min → abort. Tracked via
   `lastBuyProgress`/`lastBuyProgressAt`.
4. **Stalled near completion**: `elapsed >= eta * 1.0 * sf` AND
   `progress >= 0.50` → abort. The last 5% may never fill — abort so we can
   sell what we have and free the slot.

### F2P 45-min minimum slot occupation with swap-out exception

**F2P mode** (`autoMode === 3`) applies a 45-minute minimum slot occupation
before any ETA-based buy abort fires. F2P accounts have only 3 GE slots and
use lowball-style 1gp margins, so offers need more time to fill.

`F2P_MIN_SLOT_OCCUPATION_MIN = 45` — when a buy offer has been in a slot for
less than 45 minutes AND `isBuyOfferStale` returned a reason:

- If merchable data is stale → block the abort (wait).
- Run a buy scan (`getFirstUnoccupiedMerchableItem`) to find a higher-ranked
  F2P item not in any slot, not frozen, not buy-limited.
- If a better item is available → **allow the early abort** (swap-out):
  - Log: `Auto: F2P swap-out — X in slot N (Mmin < 45min min, reason) — replacing with higher-ranked Y (profit/hr Pgp)`
  - Skip the buy freeze (the item is being swapped, not abandoned).
  - Set abort category to `'swap'` (matches the frozen swap-out pattern).
- If no better item → **block the abort** (wait for the 45-min minimum).

After 45 minutes, ETA-based aborts fire normally (ETA acts as the fallback
for slow items where the ETA threshold exceeds 45min). Sell-side aborts are
unaffected.

### Abort reasons in logs

Abort history entries include a `reason` string that identifies the exact check:
- `reconstructed zero-profit sell: net Xgp ...` — reconstructed guard, zero profit
- `reconstructed low-profit sell: Xgp/hr ...` — reconstructed guard, low profit/hr
- `eta: 0-progress sell after Xmin (cap Ymin, eta Zmin)` — 0-progress absolute cap
- `partial-progress stall (no ETA): Xmin since last progress >= Ymin, progress Z%` — partial-progress stall with no ETA data
- `eta: sell stale at X% eta (Ymin elapsed, Z% sold)` — ETA-based stale
- `eta: sell stalled near completion (X% eta, Y% sold)` — stalled near completion
- `eta: sell progress-since-revision extension active (X% sold, Ymin elapsed, Zmin ETA)` — NOT an abort; this is the extension skipping the ETA-based checks because the offer is actively selling. No log line is emitted for this case (the stale checker simply returns null).
- `0-progress absolute cap: Xmin elapsed >= Ymin cap (ETA Zmin, non-lowball, profit/hr Pgp (scale Sx)), progress 0% — buy price Bgp` — buy 0-fill cap, profit-scaled
- `0-progress absolute cap: Xmin elapsed >= Ymin cap (ETA Zmin, non-lowball, thin-margin), progress 0% — buy price Bgp` — buy 0-fill cap, thin-margin (no profit scaling)
- `ETA exceeded (0 bought): Xmin elapsed >= Ymin (S% of Zmin ETA, profit/hr Pgp (scale Sx)), progress 0% — buy price Bgp` — buy ETA threshold, profit-scaled
- `ETA exceeded (partial): Xmin elapsed >= Ymin (S% of Zmin ETA, profit/hr Pgp (scale Sx)), progress P% < 50% — buy price Bgp` — buy ETA + partial, profit-scaled
- `no progress for Xmin (threshold Ymin = 25% of Zmin ETA, profit/hr Pgp (scale Sx)), progress P% — buy price Bgp` — buy no-progress, profit-scaled
- `stalled near completion: Xmin elapsed >= Ymin (S% of Zmin ETA, profit/hr Pgp (scale Sx)), progress P% — buy price Bgp` — buy stalled near completion, profit-scaled
- `frozen swap-out` — frozen item replaced with a better item
- `Auto: F2P swap-out — X in slot N (Mmin < 45min min, reason) — replacing with higher-ranked Y (profit/hr Pgp)` — F2P early abort under 45-min minimum, better item available

Note: The `, profit/hr Pgp (scale Sx)` suffix only appears when the scale
factor is > 1.0 (i.e. the item's profit/hr exceeds 20k). Items at or below
20k profit/hr have no suffix and use the base thresholds (unchanged behavior).

### Buy repricing (high-profit stalled buys)

When a high-profit buy offer stalls and would normally be aborted + frozen,
the bot can instead **reprice** — abort and immediately re-place the buy at
a slightly higher price, without freezing the item. This rescues buys that
are just slightly underpriced (e.g. Awakener's orb at 275k where a 500gp
bump can make the difference between filling and not filling).

**Gating** (all must be true):
- `profit/hr > 100k` (`BUY_REPRICE_MIN_PROFIT_PER_HOUR`)
- `gross margin ≥ 10gp` (`BUY_REPRICE_MIN_MARGIN_GP`) — thin margins can't absorb a bump
- `reprice count < 2` (`BUY_REPRICE_MAX_COUNT`) — don't keep bumping forever
- `post-bump profit/hr ≥ 50k` (`BUY_REPRICE_POST_BUMP_MIN_PROFIT_PER_HOUR`)

**Bump formula**: `max(1, min(floor(buyPrice * 0.005), floor(grossMargin * 0.10)))`
— the smaller of 0.5% of buy price and 10% of gross margin, minimum 1gp.

**Reprice count tracking**: `buyRepriceCounts` (in-memory `Map`) tracks how many
times each item has been repriced. Reset when a buy is successfully placed (the
reprice worked) or when the item is frozen (normal abort — fresh start after
freeze expires). Not persisted — if the bot reloads mid-reprice, the reprice
is lost and the item gets a normal buy at the original price (safe fallback).

**Pending reprice flow**: `pendingReprices` (in-memory `Map`) maps item name →
bumped buy price. Set when the stale check decides to reprice. After the abort
completes, the cache entry is kept (not removed) so the buy scan can pick up
the pending reprice. The buy scan overrides `mItem.purchasePrice` with the
reprice price and clears the pending entry.

**Log signatures**:
- `Auto: repricing X — aborting buy at Bgp, will re-place at Ngp (reprice M/2 — reason)` —
  reprice triggered
- `Auto: applying pending reprice for X — buy price Bgp → Ngp` —
  buy scan applying the reprice override

### Sell-abort freeze log signatures

When a sell offer is aborted with <25% progress, a progressive buy freeze is
applied to prevent re-buying the item (the sell price is too high for the
market, so the price estimate is systematically wrong — the same logic as buy
aborts where the buy price is too low). The freeze is applied on abort
**completion** (not at stale-detection time) so a reload interrupting the abort
flow does not inflate the count — the `countSellAbort` flag on `abortSlotInfo`
is set at detection time, and the actual `incrementItemSellAbortCount` +
freeze application run only after `Auto: offer aborted successfully.`:

- `Auto: freezing X from buying for N min (sell-abort count M, effective count E — reason)` —
  progressive buy freeze applied. The effective count (buy + sell aborts)
  determines the freeze duration and whether the item is hard-skipped.
- `Auto: freezing X from buying for N min and hard-skipping (sell-abort count M, effective count E >= 3 — reason)` —
  effective count reached the hard-skip threshold; the item is skipped by all
  buy scan tiers until the count decays.
- `Auto: X already frozen (expires in N min) — not re-freezing (sell-abort count M — reason)` —
  the item was already frozen (e.g. from a previous buy abort), so the freeze
  timer is not extended. The sell-abort count is still incremented for the
  effective count.

### Historical protections log signatures

On startup/account switch, the bot scans persisted merch history and abort
history to apply forward-looking protections for items with a track record
of losses or repeated sell aborts:

- `Auto: historical protections applied for "X" — N loss cooldown(s), M sell-abort seed(s).` —
  protections applied for account X. N items received a loss-history cooldown
  freeze (2h from latest loss), M items had their sell-abort count seeded
  from historical abort entries (24h lookback). The seeded sell count feeds
  into the effective count (buy + sell) — items with 3+ effective aborts are
  hard-skipped by the hard-skip scan on the next tick.

---

## Price revision strategy

When a sell is aborted (stale) and re-listed, the price is revised downward.
The revision count is `revisedPrices.length - 1` (0-indexed — the initial
placement is rev 0, the first price change is rev 1, etc.):

**All items** (standard and thin-margin use the same schedule — the margin
floors the reduction to 1gp for thin-margin items anyway):

| revCount | Reduction | Floor |
|----------|-----------|-------|
| 0–1 | 10% of gross profit | tax-break-even |
| 2–3 | 12% of gross profit | tax-break-even |
| 4–5 | 15% of gross profit | tax-break-even |
| 6 | **Drop directly to tax-break-even floor** (abandon) | tax-break-even |
| 7 | 15% of remaining margin | tax-break-even |
| 8 | Final dump (fixed price at tax-break-even floor) | tax-break-even |
| 9–12 | **Controlled loss dump** — 3% of buyPrice per revision (min 5gp) | 80% of buyPrice |

Note: at revCount 6 the sell price drops **directly** to the abandon floor
(buyPrice − 2) to free the slot immediately. A percentage-based reduction
would only chip away at the price slowly (e.g. Rune platebody: 119gp
reduction on a 998gp margin left the price 879gp above the floor, causing
many cycles through net-loss territory before the slot was freed). Dropping
directly to the floor matches the early-abandon path and frees the slot
~20 minutes sooner.

**Floor-hit markers**: When the price is already at the floor and can't be reduced,
`reviseSellPrice` still advances the revision count (pushes the current price to
`revisedPrices` as a marker). This ensures floor-stuck items eventually reach the
abandon (rev 6) and final dump (rev 8) thresholds instead of looping forever.

**Margin-aware early abandon**: `floorHitCount` tracks consecutive floor-hits.
Thin-margin items (< 10gp gross margin) abandon after 4 floor-hits; thick-margin
items (≥ 10gp) abandon after 2 floor-hits. This frees slots sooner instead of
cycling at the same floor price for 50+ minutes.

**Dump-floor stale guard with controlled loss dump (Option 1)**: Once the sell
price reaches the tax break-even floor AND the revision count has reached the
final dump threshold (8), `isSellOfferStale` checks a hold timer before
deciding whether to skip stale checks:
- **Rev 8 (at tax break-even floor)**: hold for 90 min (`DUMP_FLOOR_HOLD_MIN`).
  If the hold timer hasn't expired, skip stale checks (let the offer fill at
  its own pace). If it has expired with 0% progress, fall through to the
  0-progress absolute cap, which triggers an abort. The sell scan then calls
  `reviseSellPrice` which applies the controlled loss pricing tier (rev 9).
- **Rev 9+ (below tax break-even floor)**: hold for 30 min
  (`DUMP_FLOOR_CONTROLLED_LOSS_HOLD_MIN`). Same fall-through behavior — shorter
  hold since the loss has already been accepted.
- **Rev 9+ at 80% minimum** (`!canReduceControlledLoss`): the price is at the
  absolute minimum (80% of buyPrice). Skip stale checks permanently — the offer
  is left to fill at its own pace.

The controlled loss dump (rev 9–12) reduces the sell price by 3% of buyPrice
per revision (min 5gp), capped at 80% of buyPrice. This accepts a controlled
loss to free the slot for productive trading. The loss is recorded in merch
history as a negative profit entry, and the sell-abort count + buy freeze
prevent re-buying the item.

### Revision log signatures

- `Cache: revised X sell price Y -> Z gp` — price was reduced
- `Cache: X already at price floor (Ygp) — cannot revise` — at floor, no reduction
- `Cache: X at price floor (Ygp) — revision count advanced to N, floor-hit M/2` —
  floor-hit marker advanced
- `Cache: X early abandon after N floor-hits — sell price Y -> Z gp` — early
  abandon triggered
- `Cache: X final dump — sell at Ygp (buyPrice Z - 5) to free slot` — final dump
- `Cache: X already at or below dump price (Ygp <= Zgp) — cannot dump` — at dump
  floor, no further reduction possible
- `Cache: X controlled loss dump — sell price Y -> Z gp (below tax break-even floor, buy B) to free slot` —
  controlled loss dump (rev 9+), pricing below tax break-even to free stuck slot
- `Cache: X already at controlled loss minimum (Ygp <= Zgp) — cannot reduce further` —
  at 80% of buyPrice minimum, no further reduction possible

### Infinite loop warning signs in logs

If you see the same item repeatedly cycling through these logs without the sell
completing:
1. `recorded sell offer` → `sell offer placed successfully` → `offer aborted
   successfully` → `recorded sell offer` ... every ~30 seconds
2. The revision count keeps advancing but the price doesn't change (floor-hit
   markers accumulating)
3. The bot never reaches `Idle — short break in N ticks` (the loop consumes every
   tick)

**Known fixed causes**:
- `reconstructed` flag not cleared → reconstructed profit guard fires on every
  re-list (FIXED: cleared in `recordSellOffer` and `confirmSellOffer`)
- Low-profit/hr guard aborting instantly without grace period (FIXED: 5-min grace
  + 0% progress requirement)
- Price driven to dump floor (buyPrice − 5) by earlier bug, revision count past
  final dump threshold but price can't be reduced further → infinite abort/relist
  at same price (FIXED: `isAtDumpFloor` guard in `isSellOfferStale` skips stale
  checks when price ≤ buyPrice − 5 AND revision count ≥ 8)

---

## Cache lifecycle

### Entry creation

- `recordBuyOffer(item, runtimeBuyEta, runtimeSellEta, runtimeQuantity?)` — creates/overwrites entry
  with buy mode. Preserves buy-limit tracking from previous cycle. `runtimeQuantity`
  is persisted as `buyQuantity` for stateless recovery of `BuyOfferFlow` after a
  reload mid-flow.
- `recordSellOffer(name, sellPrice, buyPrice, qty, limit, runtimeSellEta)` —
  updates existing entry to sell mode, or creates new. Clears `reconstructed`
  (but NOT `reconstructedBuyPrice` — that survives re-list for phantom loss
  skipping). Sets `sellConfirmed = false` (set to `true` by `confirmSellOffer`
  after the flow completes). The runtime sell ETA is capped by a **value-aware
  cap** (`computeValueAwareSellEtaCap`) that scales with the item's total net
  profit: low-profit items (5k) get a 15min cap, high-profit items (40k+) get
  120min. This prevents low-volume, low-profit items (e.g. Goat horn: 763 qty
  at 10k profit, raw ETA 3442min) from occupying a slot for hours when the
  slot could earn more on a different item. The cap tightens automatically
  after revisions since re-listing at a lower price reduces total net profit.
- `reconstructEntry(name, type, qty, slotPrice)` — creates entry from live GE
  slot after cache loss. Marks `reconstructed: true` and
  `reconstructedBuyPrice: true`. Uses GE slot priceText as actual price, falls
  back to merchableItems.json then priceHistory.json. ETAs from
  merchableItems.json (via `computeRuntimeEtas` with the actual offer
  quantity) or computed from priceHistory 1h volume using the same non-linear
  ETA model (`BASE_FILL_TIME_MIN + qty / (effectiveVolume / 60)` with 50%
  market share and 15% volume buffer), capped at 120min via
  `RECONSTRUCTED_ETA_CAP_MIN`. Both paths produce ETAs consistent with the
  placement ETA — the priceHistory fallback no longer produces sub-5min ETAs
  that are impossible per the non-linear model.
- `fixModeMismatch(name, type, qty, slotPrice)` — corrects a cache entry whose
  mode doesn't match the live GE slot type. Happens when a plugin reload (e.g.
  `npm run build`) causes the hidden setting to revert to a stale value — the
  in-memory sell-mode update is lost, but the GE still has the live offer.
  Uses the GE slot's priceText as the actual price, resets `offerPlacedAt` to
  now, and applies the value-aware sell ETA cap (same as `recordSellOffer`).
  Preserves `buyPrice` and buy-limit tracking. Logs: `Cache: fixed mode
  mismatch for X (buy -> sell, ...)` and `Auto: reverse reconciliation fixed
  N mode mismatch(es) ...`.

### Entry lifecycle

```
recordBuyOffer → mode=buy, sellConfirmed=undefined
  ↓ (buy completes, items collected)
recordSellOffer → mode=sell, sellConfirmed=false
  ↓ (sell flow completes)
confirmSellOffer → sellConfirmed=true, offerPlacedAt=now
  ↓ (sell completes 100%)
completed-sell sweep → profit recorded (pre-collect or post-collect), clearSellFields()
  ↓
mode=idle (buy-limit tracking preserved)
  ↓ (next cycle)
recordBuyOffer → mode=buy (overwrites)
```

### Key fields

| Field | Purpose | Set by | Cleared by |
|-------|---------|--------|------------|
| `mode` | buy/sell/idle | recordBuyOffer/recordSellOffer/clearSellFields/fixModeMismatch | — |
| `buyPrice` | Buy offer price | recordBuyOffer/reconstructEntry/fixModeMismatch | — |
| `sellPrice` | Current sell price | recordSellOffer/reviseSellPrice/fixModeMismatch | — |
| `originalSellPrice` | First sell price | recordSellOffer/reconstructEntry | clearSellFields |
| `offerPlacedAt` | Timestamp of placement | recordBuyOffer/recordSellOffer/confirmSellOffer/fixModeMismatch | — |
| `revisedPrices` | Price revision history | recordSellOffer/reviseSellPrice/fixModeMismatch | clearSellFields |
| `sellConfirmed` | Sell offer is live on GE | confirmSellOffer=true, recordSellOffer=false, fixModeMismatch=true | clearSellFields |
| `sellQuantity` | Qty listed for sell | recordSellOffer/reconstructEntry/fixModeMismatch | clearSellFields/clearSellQuantity/fixModeMismatch |
| `reconstructed` | Entry from cache loss (stale-check guard) | reconstructEntry=true | recordSellOffer=false/confirmSellOffer=false/fixModeMismatch=false |
| `reconstructedBuyPrice` | Buy price uncertain (phantom loss skip) | reconstructEntry=true | recordBuyOffer=false (survives re-list) |
| `totalBought` | Cumulative bought qty | recordSellOffer | (lazily on 4h expiry) |
| `firstBoughtAt` | First buy timestamp | recordSellOffer | (lazily on 4h expiry) |
| `limitReachedAt` | Buy limit hit | recordSellOffer | (lazily on 4h expiry) |
| `lastBuyProgress` | Live fill progress | stale-check loop | — |
| `lastBuyProgressAt` | Progress timestamp | stale-check loop | — |
| `lastSellProgress` | Live sell progress | stale-check loop | recordSellOffer/confirmSellOffer/reviseSellPrice/clearSellFields |
| `lastSellProgressAt` | Sell progress timestamp | stale-check loop | recordSellOffer/confirmSellOffer/reviseSellPrice/clearSellFields |
| `purchaseEtaMinutes` | Buy ETA | recordBuyOffer/reconstructEntry | — |
| `saleEtaMinutes` | Sell ETA | recordBuyOffer/recordSellOffer/reconstructEntry | — |
| `buyQuantity` | Buy flow target qty | recordBuyOffer | next recordBuyOffer/clearSellFields |

### Cache dump format (in logs)

```
Dragonstone: mode=sell, buy=10790, sell=10785 (orig=11013), elapsed=6.4min,
  revisions=[11013 -> 11012 -> ...], net=10570gp (tax=215gp),
  projProfit=-220gp/item (-83380gp total), buyEta=10.4min, sellEta=16.6min,
  buyProgress=45.2% @ 2026-09-04T21:30:00.000Z, sellProgress=12.0% @ ...,
  floorHits=2, reconstructed
```

- `net` = sellPrice − GE tax (2%, exempt < 50gp)
- `projProfit` = (net − buy) × qty — negative means the sell will be a loss
- `elapsed` = minutes since `offerPlacedAt`
- `revisions` = full price revision history (shows how the price was driven down)
- `buyProgress`/`sellProgress` = last observed fill progress (%) and timestamp,
  updated by the stale-check loop each tick when progress changes — useful for
  diagnosing offers that appear stuck vs offers that are slowly filling
- `floorHits` = consecutive floor-hit revisions (price couldn't be reduced
  further). After 2 (thick margin) or 4 (thin margin), the item abandons early
- `reconstructed` = entry created by reverse reconciliation (cache loss after
  client restart), subject to the reconstructed profit guard
- `reconstructedBuyPrice` = buy price is uncertain (from priceHistory/
  merchableItems), phantom losses from this entry are skipped in the
  completed-sell sweep; cleared only when a new buy is placed

---

## Profit tracking

### Two recording points (both deduct GE tax)

1. **Re-list time** (Step 9): `soldQty = sellQuantity − inventoryQty` (what sold
   before the abort). Profit = `(netSellPrice − buyPrice) × soldQty`. Recorded
   at the current sell price for the partial batch that sold before the abort.
2. **Completed-sell sweep** (Step 7): If item not in any slot or inventory, sell
   completed 100% (post-collect path). Profit is computed from the
   **weighted-average sell price** across ALL partial sale batches (including
   the final batch), ensuring the daily profit and merch history use the SAME
   profit figure. The previous approach used `entry.sellPrice` (the current/last
   sell price) × `sellQuantity`, which diverged from the merch history's
   weighted-average profit when there were price revisions with partial fills
   at different prices.
   **Pre-collect path**: If a sell slot is `completed_or_aborted` (100%
   progress) and the bot did NOT initiate an abort, the profit is recorded
   IMMEDIATELY — before the collect click. This prevents profit loss when a
   hot-reload occurs between the collect and the next tick's sweep (the cache
   setting may revert, or `fixModeMismatch` may clear sell fields when a new
   buy for the same item is live on the GE). Reconstructed entries are
   excluded (can't distinguish natural completion from interrupted abort).

### Hot-reload write ordering (prevents double-counting)

Completed-sell sweep: capture profit data → mutate cache (clear sell fields) →
`cache.save()` → THEN `addDailyProfit()` / `recordMerchCycle()`. If a hot-reload
occurs between save and profit write, the cache already reflects the cleared
state — no double-counting. Worst case: lose one tracking entry (actual GP is
correct in the coin pouch).

Partial sell re-list: records partial sale batches in the cache via
`cache.recordPartialSale(...)` but does NOT call `addDailyProfit()`. Partial
profit is only counted once, at completed-cycle time, via
`recordCompletedSellProfit()` which computes the total weighted profit across
all partial batches. This prevents the double-counting that occurred when
partial profit was recorded at re-list time and again at completion.

### GE tax

- `GE_TAX_PERCENTAGE = 2` (2% on sells)
- `GE_TAX_EXEMPTION_THRESHOLD = 50` (items selling below 50gp are exempt)
- `getGeTax(sellPrice) = Math.floor((sellPrice / 100) * 2)`
- `getNetSellPrice(sellPrice) = sellPrice − getGeTax(sellPrice)`

---

## Break / rotation / hop systems

### Break types

- **Short break**: 3–8 min logout. Triggered at 50% ETA check (when the bot is
  idle and 50% of the shortest ETA has elapsed). The bot logs out, waits, then
  logs back in. **Stay-logged-in override**: if the next action ETA is ≤ 60
  seconds when the idle delay expires, the bot stays logged in and re-checks
  every 5–8 ticks (~3–5s) instead of logging out. This prevents rapid
  login/nothing-to-do/logout cycling when all slots are occupied and an offer
  is about to complete or hit an abort threshold. The stay-logged-in branch
  does not set `checkedAtHalfEta`, so the 50%→90% escalation is preserved for
  the subsequent real break.
- **Nightly break**: Sleep/wake cycle from the session profile (e.g. sleep=6.5h,
  wake=07:13). The bot logs out at sleep time and waits until wake time.
  The randomized bedtime/wake schedule persists across hot reloads via
  `saveBreakState(bot)` in `scheduleNextNightlyBreak()`. `clearBreakState()`
  (called when a break ends and the bot is back in-world) preserves the
  nightly schedule fields in the saved state — it saves a minimal state with
  `breakPhase='none'` and the schedule intact, instead of wiping to `'{}'`.
  This ensures a hot reload after a successful post-break login does not
  lose the schedule. `wipeBreakStateSetting()` (private) is used for true
  wipe cases: fully-passed nightly sleep window (schedule is stale) and
  parse errors. On tab reloads (hidden settings lost), the schedule is
  re-derived from the per-account session profile — the exact bedtime will
  differ, which is acceptable.

### Account rotation

When rotation is enabled and a break starts, the bot logs out the current account
and immediately rotates to the next eligible account (oldest `lastLoginAtMs`). If
no account is eligible, it polls every 20 seconds.

**Minimum re-login floor**: `MIN_ACCOUNT_BREAK_MS = 10 min` in `account-rotation.ts`
clamps the `minBreakDurationMs` recorded per account on logout. An account cannot
be re-selected by `selectNextAccount()` until 10 minutes have elapsed since its
logout, regardless of the ETA-based break duration. The hour-pause break is
exempt (passes `enforceMinBreak=false` to `recordAccountLogout`) so it keeps its
own 6-minute duration — it's time-bounded by the :05 wall clock.

**Rotation over idle activity**: when the current account is performing an idle
activity (chocolate dust, ultra compost, goat horn dust) and a different account
becomes eligible, the auto-loop calls `isRotationDueForLoggedIn(bot)` every 10
seconds (throttled via `bot.lastLoggedInRotationCheckMs`). If a different account
is eligible, the idle activity's `geActionDue` flag is set to `true`, triggering
the cleanup phase (bank all idle items, close bank, yield). The auto-loop then
sets `loopIdleForBreak = true`, the break system logs out with the normal
randomised delay, and `tryImmediateRotation()` picks the eligible account.
Without this, the current account keeps grinding the idle activity until its
own nightly break, leaving the eligible account waiting.

**Chat-triggered GE yield during idle activity**: when a GE offer completes
while an idle activity is active, the `onChatMessage` handler detects the
"Grand Exchange: Finished buying/selling X" game message and sets
`bot.geOfferCompletedChatMs`. The idle-activity dispatch checks this flag each
tick and, if set, forces `geActionDue = true` — triggering the same cleanup
phase (bank all idle items, close bank, yield to GE operations) as the
ETA-based timer. This lets the bot collect, sell, and place new offers
immediately when an offer completes, instead of waiting for the
`idleActivityGeActionDueMs` timer to expire. The flag is only set when
`idleActivityPhase !== 'none'` so normal GE operations (where completions are
handled by the collect/sweep flows) are unaffected. Reset in `resetAutoLoop`
and `resetInFlightActionState`.

**"Any" idle activity mode (value 4)**: when "Any" is selected, the bot opens
the bank, checks which of the three activities (Chocolate Dust, Ultra Compost,
Goat Horn Dust) have ingredients via `bank.contains()`, and randomly picks one
to run. When that activity depletes (bank out of ingredients), the auto-loop
dispatch adds it to `loop.idleActivityAnyDepleted`, clears
`loop.idleActivityDepleted`, and re-enters the `'scanning'` phase to pick the
next available activity. When all three are depleted,
`loop.idleActivityDepleted` stays `true` and the bot falls back to normal GE +
logout behavior for the rest of the session (until script reload). The
scanning phase is handled by `anyActivityTick` in
`idle-activity/any-activity.ts` (own `openBankStep`, duplicated to avoid a
cross-module dependency). `loop.idleActivityCurrent` (1, 2, or 3) tracks which
specific activity is running; the auto-loop dispatch uses it to delegate to
the correct activity-specific tick handler.

**Always close GE before opening the bank**: all four idle-activity modules'
`openBankStep` functions close the GE interface with Escape before calling
`bank.open()`. The GE interface intercepts game-world clicks, so
`bank.open()` while the GE is open lands on a GE widget ("View offer")
instead of the banker — opening a slot detail screen rather than the bank.
The previous 25% random chance was removed; the GE is now always closed
first, with a humanised delay before the bank-open click on the next pass.

**Cross-activity inventory cleanup in "Any" mode**: after a hot reload
mid-activity, the inventory may contain items from a DIFFERENT idle activity
(e.g. goat horns left over when "Any" mode picks ultra compost). The picked
activity's banking flow only deposits its own items, so the leftover items
would fill inventory slots and cause the picked activity's withdraws to fail
with "you don't have enough inventory space", creating a stuck loop. The
scanning phase includes a `SUB_DEPOSIT_ALL_IDLE` step that deposits ALL
non-stackable items from all three activities (chocolate dust, chocolate bars,
knives, ultracompost, supercompost, goat horn dust, goat horns, pestle and
mortar) before closing the bank and starting the picked activity.
`depositAllOfItem` is a no-op if the item isn't in the inventory, so the
unconditional calls are safe. Volcanic ash is also deposited — while it's
stackable and kept across ultra compost cycles when staying in ultra compost,
it must be deposited when switching to a different activity (e.g. goat horn)
so it doesn't occupy a slot. The ultra compost banking flow re-withdraws it
if ultra compost is picked again.

**Deposit-before-check ordering**: the scanning phase deposits all idle
items BEFORE checking `bank.contains()` for ingredients. This is critical
because some ingredients are kept in the inventory across cycles (e.g.
volcanic ash for ultra compost — stackable, kept in inventory by design).
If the check ran first, the bank would show no ash and the bot would report
"no ingredients found" even though ash is in the inventory. Depositing first
moves everything to the bank so the check sees the full picture. The
scanning sub-step order is: `SUB_OPEN_BANK` → `SUB_DEPOSIT_ALL_IDLE` →
`SUB_CHECK_INGREDIENTS` (pick & start activity).

**Noted-ingredient deposit**: every idle-activity deposit site (banking,
cleanup, and depleted phases across all four modules) uses
`depositItemAndNoted(bank, unnotedId)` from `idle-activity/idle-deposit.ts`
instead of `bank.depositAllOfItem(unnotedId)`. The helper resolves the
ingredient's noted variant via `titan.state.cache.item(unnotedId)` —
checking `noteId` first (the canonical "id of the noted version" field on
unnoted items) and falling back to `linkedId` (the bidirectional note-pair
link). Each candidate id is verified by looking up its ItemDef and confirming
`noted === true` before use, so a stale or unexpected field value can't cause
a wrong-item deposit. The resolution is cached in a module-level Map so the
native call only happens once per ingredient per session. The helper then
deposits BOTH the unnoted and noted variants. This handles the case where the
user leaves manual ingredient buy offers on the GE — collected items arrive
as noted variants with different item IDs, and the unnoted-only
`depositAllOfItem` would leave them in the inventory, occupying slots and
causing "you don't have enough inventory space" / stuck conversion loops.
Stackable items and tools without note pairs return `noteId = -1` and
`linkedId = -1` → only the unnoted variant is deposited. Unrelated
GE-collected items (e.g. Smoke runes, Steel cannonballs) are untouched —
only items whose unnoted OR noted ID matches a known idle-activity
ingredient are deposited.

**Noted-variant sell protection**: the same noted-ID gap existed on the sell
side — noted ingredients bypassed both `has*Items` (unnoted-only
`countInvItem`) and the sell scan's `*_EXCLUDED_SELL_IDS` filter, so a noted
ingredient collected from a manual GE buy offer could be listed for sale
(observed: supercompost). Fixes: (1) `hasChocolateDustItems`,
`hasUltraCompostItems`, and `hasGoatHornItems` count noted variants via
`countInvItemOrNoted` (exported `resolveNotedId` from `idle-deposit.ts`),
so noted ingredients trigger the cleanup-for-GE banking path; (2)
`getIdleActivityExcludedSellIds` expands the base excluded set with each
item's noted variant via `expandWithNotedIds` (cached per base set), so the
sell scan and the free-slot-for-sell abort check can never list a noted
ingredient either.

**Hot-reload recovery / startup with idle items in inventory**: after a hot
reload (or at script start), `idleActivityPhase` resets to `'none'` (in-memory
state lost) but the idle activity setting persists (visible setting). The bot
detects idle items in inventory via `hasIdleActivityItems`, skips sell/abort
(items can't be sold on GE), AND skips buying (would place buy offers with a
full inventory → "you don't have enough inventory space" when the buy fills
and can't be collected). **Idle-item cleanup-for-GE**: when
`idleActivityPhase === 'none'` and `hasIdleActivityItems(bot)` is true, the
auto-loop sets `loop.idleActivityCleanupForGe = true` and starts the cleanup
phase — for "Any" mode AND "None", `startScanning(loop)` enters the scanning
phase with the cleanup flag (the "None" case uses the Any-mode scanning path
because its `SUB_DEPOSIT_ALL_IDLE` step deposits ALL items from all three
activities, whereas the specific-activity cleanup phases only deposit their
own items); for specific activities, `idleActivityPhase` is set directly to
`'cleanup'`. The cleanup phase banks all idle items, closes the bank, and
returns `false` to yield to GE logic (collect, sell, buy, stale checks). The
`hasIdleActivityItems` guards (Step 3 collect, Step 4 stale, Step 5 sell/buy)
then pass because the inventory is clear. After all GE flows complete, Step 11
starts a new idle activity as normal (only if an activity other than "None" is
selected). This prevents the bot from starting a new idle activity before
processing pending GE completions (e.g. a completed sell detected via the
`geOfferCompletedChatMs` chat flag that survived the reload). In
`anyActivityTick`, the `idleActivityCleanupForGe` flag causes the scanning
phase to skip the ingredient check / activity picking
(`SUB_DEPOSIT_ALL_IDLE` closes the bank and returns `false` instead of
advancing to `SUB_CHECK_INGREDIENTS`). The `geActionDue` early-yield in
`anyActivityTick` is also bypassed when `idleActivityCleanupForGe` is set, so
the cleanup runs even if a GE action is already due.
If the idle activity is disabled (set to "None") AND no idle items are in the
inventory, the bot falls through to buying as normal. If idle items ARE in the
inventory (e.g. left over from a previous session or after switching the
setting to "None" mid-session), the cleanup-for-GE trigger banks them first
before any GE flows proceed.

**Log signatures**:
- `Rotation: recorded logout for X (min break Y min)` — break logout recorded
- `Rotation: selected account Y (last login ...)` — next account selected
- `Rotation: X logged out — immediately rotating to Y (skip break wait)` —
  immediate rotation
- `Rotation: no eligible accounts found (all sleeping or on break)` — polling

### Title-screen guard during login transition

`breakStep` has two `logging_in` branches — one in the logged-out section (calls
`loginStep`, then checks `titleFirstSeenAtMs > 0 || titleWaitingForGone` before
checking `isInWorld()`), and one in the logged-in section (same pattern). Both
call `loginStep(bot)` before checking `isInWorld()` and both have a title guard
that returns true without clearing break state if the title FSM is active.

This is necessary because `isLoggedIn` can become true while the "Click here to
play" title screen is still visible. The logged-out branch (which always calls
`loginStep`) is skipped when `isLoggedIn` is true, so `titleFirstSeenAtMs` is
never set by `loginStep` → `tryClickTitle`. Without calling `loginStep` in the
logged-in branch, the title guard at the top of the "Player is logged in"
section (which checks `titleFirstSeenAtMs > 0 || titleWaitingForGone`) would
not fire — both are 0/false because `loginStep` was never called to detect the
title. The break state would be cleared, `resetLoginState` would wipe
`postLoginResumeAtMs`, and the auto-loop would run while the title screen is
still visible — dispatching a GE-open click that resolves to `text=Play`.

The `loginStep` call only runs during `breakPhase === 'logging_in'` (a transient
state during login), not every tick — no per-tick native call during normal
operation.

### World hopping (global)

- **Interval**: bimodal/burst distribution (global — not per-account):
  70% normal 15–60 min, 20% burst 2–8 min, 10% long 60–150 min.
  After a burst hop, the next interval has a 50% chance of also being a
  burst, simulating the human pattern of hopping 2–3 times in quick
  succession when annoyed. Replaces the old flat 5–45 min uniform
  distribution.
- **Persisted**: `hopState` hidden setting survives reloads
- **Restored on startup**: `loadHopState()` restores the pending timer
- **Safe boundary**: only hops when the player is idle (not animating/moving), the post-login settle period has ended (`postLoginResumeAtMs <= 0` — `tickLogic` runs `hopStep` before the `postLoginResumeAtMs` gate, so without this check the hop is dispatched while the client is still settling, gets rejected by the world switcher with "busy action", and the native `hopIngame()` sequence continues to spam Logout/World Switcher clicks that interfere with the auto-loop), AND every GE flow has fully ended — `activeBuyFlow`, `activeSellFlow`, and `activeAbortFlow` must all be null, and `autoLoop.phase` must be `idle` or `waiting`. A flow can sit in a between-clicks wait where the player is visually stationary but the world switcher still rejects the hop with a "busy action" message, so the flow fields are the authoritative signal. When a hop is due but a flow is active, the hop stays pending and retries every tick until the gate passes — no far-future rescheduling.
- **shouldPauseForHopBoundary**: When `forceHopPending` is set, `shouldPauseForHopBoundary` blocks the auto-loop from starting NEW flows — but it does NOT block ticking active flows. This is critical: if an active flow were blocked mid-step, the flow would freeze (e.g. between "Clicking sell on slot 2" and the next step), the hop couldn't fire because `isAtSafeBoundary` sees the active flow, and the bot would deadlock until a reload. When any flow field is non-null, `shouldPauseForHopBoundary` returns false, allowing the auto-loop to defer to the flow and tick it to completion. The hop then fires at the safe boundary.
- **Close interfaces before hopping**: `hopStep()` closes the GE interface and bank interface with Escape before dispatching `hopIngame()`. The world switcher is blocked by a "busy action" if either interface is open — without this close, the hop fails, `cancelHop()` fires from the chat listener, and the native `hopIngame()` sequence (fire-and-forget) continues spamming door/world-switcher clicks that conflict with the auto-loop's GE-open clicks.
- **Cooldown**: 20–35 ticks after hop completes
- **Resume delay**: 2.5–8 seconds after hop. Also applied after `cancelHop()` (3s) as a safety net to prevent the auto-loop from resuming while the native `hopIngame()` sequence may still be finishing its clicks.

**Log signatures**:
- `Hop state restored — next hop in N min` — timer restored on startup
- (hop execution logs are in the hopper, not always visible in the main log)

### Script timer (persisted, no longer displayed on overlay)

- **Persisted**: `scriptStart` hidden setting stores the wall-clock timestamp
  (ms) of the first enable. Survives hot reloads only (same limitation as all
  hidden settings — not persisted to disk by the Titan host).
- **Restored on startup**: `resetState()` reads the setting; if a valid
  timestamp is present, `bot.scriptStartMs` is restored. If empty/zero (fresh
  start or client restart), it stamps `Date.now()` and saves it.
- **Cleared on terminate**: `terminate()` sets the setting to `'0'` so a
  manual stop + restart starts a fresh timer.
- **No longer displayed**: The overlay was stripped to a minimal mode-label
  + start time (Paused / Normal / Slow / F2P + "Start: HH:MM"). The Session (Day) timer, sleep
  countdown, and all other previous overlay fields were removed to
  eliminate per-frame allocations and native handle accumulation from the
  render path. `scriptStartMs` is still tracked internally for break/rotation
  timing.

**Log signatures**:
- `Script timer restored — running for N min` — timer restored on hot reload
- (no log on fresh start — silent stamp)

---

## Logging tiers

The plugin has three logging tiers, controlled by two UI settings:

- **Errors** (always logged, no toggle): parse/save failures, offer placement failures, `onMainLoop` errors, termination reasons, manual button-triggered dumps (`logCacheData`, `logHistory`, etc.). These are unconditional `titan.logf` calls.
- **Info** (`logInfo` boolean UI setting, default `true`): important, uncommon events — account rotation (selected account, immediate rotation, no eligible accounts, recorded logout), break start/end, nightly sleep, hour-pause, login/logout, world hops, offer placement/abort success, cache reconciliation, item freezing, repricing, startup audit, mode switched, tick counter reset, unexpected logout, post-login settle. Gated by `bot.logInfoValue` (cached plain-JS field, refreshed in `onSettingChanged`) via the `humanLog` helper (in `session.ts`, `hopper.ts`, `login.ts`) and `infoLog` helper (in `auto-loop.ts`), or inline `if (bot.logInfoValue)` / `if (this.logInfoValue)` checks.
- **Debug** (`logDebug` boolean UI setting, default `false`): verbose per-tick diagnostics — slot summaries, GE open clicks, idle activity diagnostics, click logging, delay/humanisation layers, cache cleanup details. Gated by `bot.logDebugValue` (cached plain-JS field, refreshed in `onSettingChanged`) via the `debugLog` helper or inline checks.

With `logInfo` off and `logDebug` off, only errors and manual dumps are logged. With `logInfo` on and `logDebug` off, important events are logged but verbose per-tick diagnostics are silenced. With both on, everything is logged.

## Common log patterns and what they mean

### Normal operation

```
Idle — short break in 22 ticks
Short break starting — 3 min logout (50% ETA check)
Rotation: recorded logout for Ba112 (min break 10 min [clamped to 10 min min])
Click: opcode=57 ... text=Logout
... (state dump on logout) ...
Rotation: selected account Cyber4Gras (last login never)
Rotation: Ba112 logged out — immediately rotating to Cyber4Gras (skip break wait)
... (login credentials for Cyber4Gras) ...
Submitted credentials for Cyber4Gras (attempt 1/10)
Startup audit: screen=closed, geOpen=false, slots=unknown,...
Logged back in, resuming auto-loop
```

### Cache reconstruction after restart

```
Cache: reconstructed entry for X (buy, buy=Y, sell=Z, qty=N) from GE slot priceText
Cache: reconstructed entry for Y (sell, buy=A, sell=B, qty=M) from GE slot priceText
Auto: reverse reconciliation reconstructed N entries: X (buy), Y (sell), ...
Cache: fixed mode mismatch for Z (buy -> sell, sell=142, buy=139, qty=3271)
Auto: reverse reconciliation fixed 1 mode mismatch (setting reverted after reload — restored from live GE slot): Z (buy->sell)
```

### Sell cycle (normal)

```
Cache: recorded sell offer for X @ Ygp
Click sell slot N: interact(57, 1, 4) -> true
Click: opcode=57 ... text=Offer
Click enter price: interact(57, 1, 12) -> true
Click confirm offer: interact(57, 1) -> true
Auto: sell offer placed successfully.
... (wait for sell ETA) ...
... (sell completes) ...
Click collect to inventory: interact(57, 1, 0) -> true
```

### Sell revision cycle (normal, price too high)

```
Auto: aborting stale offer in slot N (sell X — eta: sell stale at Y% eta...)
Click open slot N detail → Click abort offer → Click back → Click collect
Auto: offer aborted successfully.
Auto: freezing X from buying for N min (sell-abort count M, effective count E — reason)   ← only if <25% progress
Cache: revised X sell price Y -> Z gp
Cache: recorded sell offer for X @ Zgp
... (re-list at lower price) ...
```

### Stuck/loop warning signs

1. **Same item aborting every ~30 seconds** — reconstructed guard or stale check
   firing too aggressively. Check if `reconstructed` flag is being cleared.
2. **Revision count advancing but price not changing** — item at floor, floor-hit
   markers accumulating. Should eventually reach abandon (rev 6) or final dump
   (rev 8). If it doesn't, the floor-hit threshold logic may be broken. If the
   price is already at the dump floor (buyPrice − 5) and revision count ≥ 8, the
   dump-floor guard should skip stale checks — if aborts continue, the guard may
   not be firing.
3. **No `Idle — short break` lines** — the loop is consuming every tick on
   abort/relist, preventing breaks and rotation from firing.
   **Known fixed cause**: stale merchable-data guard `return false` in the
   all-slots-occupied branch — the bot had empty slots but stale data (29 items
   < 30 minimum), skipped the buy scan, then `return false` skipped idle
   scheduling, causing a tight loop every tick (~600ms) for 80+ seconds with
   per-tick log spam and no break/rotation eligibility. Fixed: the guard now
   falls through to the idle path instead of returning false.
4. **`projProfit=-Xgp/item` in cache dump** — the sell will be a loss after tax.
   This is expected at the dump floor (rev 6+) but shouldn't happen on fresh
   placements.
5. **`sellEta=3442min` or similar absurd value** — reconstructed ETA from
   priceHistory 1h volume for a low-volume item. Capped at 120min by
   `RECONSTRUCTED_ETA_CAP_MIN` (reconstructed entries) or by the value-aware
   cap (re-listed entries — see `RUNTIME_SELL_ETA_CAP_*` constants). If an
   absurd ETA still appears after re-listing, the value-aware cap may not be
   applying (check that `quantity` and `buyPrice` are passed to
   `recordSellOffer`).
6. **`Hop state restored — next hop in %d min`** (literal `%d`) — `titan.log`
   used instead of `titan.logf` (formatting bug, now fixed).

### Performance warning signs

- `slow JS dispatch: Xms (threshold=60ms)` — occasional is normal during login
  credential staging (~2000ms). Frequent occurrences indicate native handle
  exhaustion or expensive per-tick work.
- `auto-disabled after 3 consecutive failures` — native handle table exhausted.
  Only recovery is plugin toggle off/on. Caused by looping `toArray()` calls
  (see `mercher-flips/SKILL.md` native handle section) or by gradual handle
  accumulation from per-tick native calls over long sessions (4-8+ hours).
- **Gradual FPS degradation over 1-2+ hours** — caused by slow native handle
  accumulation from per-tick `getAll()` and `children()`/`find()` calls. The
  widget and inventory caches are now **cross-tick** (TTL=100 ticks ≈ 60s),
  invalidated after state-changing actions and at the start of each flow tick.
  Additional per-tick/per-event native call reductions: `onMenuOptionClicked`
  is gated by `logDebug` (was an unconditional `titan.logf` per click — the
  bot's own synthetic clicks fire this handler); all info-level logs
  (rotation, breaks, login/logout, hops, offer lifecycle, cache recording/
  revisions/reconstruction/dumps) are gated by `logInfo` (was unconditional
  `titan.logf`/`humanLog` calls); `clickWidget` per-click trace logging is
  gated by `logDebug` via a module-level setter (was an unconditional
  `titan.logf` per click — fires on every GE widget click including the
  bot's own synthetic clicks); `breakStep` skips the
  `titan.state.client.localPlayer?.name` read when logged in (checks
  `titan.state.login.isLoggedIn` first — scalar, no handle); the logged-out
  branch uses `bot.currentPlayerName` (set by `initSessionProfile` on login)
  instead of `localPlayer?.name`; GE clerk/booth/logout-door entity queries
  and `titan.state.world.list()` are cached at module level (static entities —
  one query per session, invalidated on hop/login/disable); the overlay was
  stripped to a minimal mode-label + start time (one rect + two text lines, zero
  allocations, zero native reads per frame — the previous Status/TIMERS/cache
  overlay was removed to eliminate per-frame native handle accumulation from
  the render path); `idle-activity/chocolate-dust.ts` and `idle-activity/ultra-compost.ts` helpers (`countInvItem`,
  `findInvItem`, `freeInventorySlots`, `hasIdleActivityItems`) now read from
  the cross-tick inventory snapshot (`getInvSnapshot()`) instead of calling
  `titan.utils.inventory.getAll()` directly (was ~84 native Item handles/tick
  during idle — the root cause of FPS decaying to ~10 after ~1h48m). If FPS
  degradation recurs, check for new per-tick native calls that bypass the
  cross-tick caches (`invalidateGeWidgetCache()` / `invalidateInvCache()`).
- **Rapid FPS collapse to 0 within 2-3 minutes after login (especially after
  short breaks)** — caused by per-frame `Setting.value` reads in `onMainLoop`
  and the overlay render callback. `Setting.value` crosses the JS<->native
  boundary. `onMainLoop` fires at the client's main-loop rate, which is far
  higher on the login/title screen (where no 3D world is rendered, often
  hundreds of FPS) than in-game (30-60 FPS). Reading `this.autoMode.value`
  every frame on the login screen creates native handles at 5-10x the
  in-game rate, exhausting the handle table within 2-3 minutes. The plugin
  caches `autoMode.value`, `showHud.value`, `hopWorlds.value`,
  `idleActivity.value`, `doNotSleep.value`, `logInfo.value`, and
  `logDebug.value` in plain JS fields (`autoModeValue`, `showHudValue`,
  `hopWorldsValue`, `idleActivityValue`, `doNotSleepValue`, `logInfoValue`,
  `logDebugValue`), initialized in `onEnable()` and refreshed in
  `onSettingChanged()`. All per-frame and per-tick paths read the plain
  fields. The mixology plugin's `onMainLoop` reads only plain booleans
  (`this.terminated`, `this.isRunning`) — it never reads `Setting.value` per
  frame, which is why it doesn't have this issue. If FPS collapse recurs,
  check for new `Setting.value` reads inside `onMainLoop`, the overlay
  render callback, `onGameTick`, `autoLoopTick`, `breakStep`, `hopStep`, or
  any other high-frequency callback.
- **Gradual FPS degradation over 4-8+ hours** — caused by slow native
  handle accumulation from per-tick `Setting.value` reads. The per-tick
  paths (`onGameTick` → `breakStep` + `autoLoopTick`) previously read
  `bot.autoMode.value`, `bot.idleActivity?.value`, `bot.doNotSleep?.value`,
  `bot.logInfo.value`, and `bot.logDebug.value` directly — ~16-20 native
  boundary crossings per tick (~100 ticks/min). Over 4-8 hours this
  accumulated ~768k-960k native handles, gradually exhausting the handle
  table. These are now cached in plain JS fields (same pattern as the
  per-frame caches above). If FPS degradation recurs, check for new
  `Setting.value` reads in per-tick paths that bypass the cached fields.
- **Stale `runOnClientTick` callbacks after disable/reload** — `clickWithJitter`
  and `sendKeyWithJitter` defer `interact()`/`sendKey()` to `runOnClientTick`
  callbacks (1-4 client ticks later). QuickJS does NOT automatically unbind
  these on plugin disable/reload — a pending callback from a dead instance
  still fires, calling `titan.state.widgets.find()` and `live.interact()`
  on a dead instance and creating stale native handles. This is the classic
  "callbacks created inside `onGameTick`" reload-leak pattern flagged by the
  Titan client devs. `antiban/click-jitter.ts` now uses a generation counter
  (`clickJitterGeneration`) incremented by `resetClickJitter()` (called from
  `onDisable`). Pending callbacks capture the generation at schedule time and
  bail early if it doesn't match — preventing stale native handle creation.
- **`onMainLoop` calling `wallClockStep` when logged in** — `wallClockStep` is
  all logged-out logic (break transitions, rotation, login step, account
  detection). When logged in, `onGameTick` handles everything. `onMainLoop`
  now skips `wallClockStep` entirely when logged in, using a cached plain-JS
  `cachedIsLoggedIn` field (no per-frame native read) updated in `onEnable`,
  `onGameStateChanged`, and `onGameTick`. This follows the Titan dev
  recommendation to move periodic logic from frame-rate callbacks (`onMainLoop`)
  to `onGameTick`.

---

## Log analysis checklist

When the user posts logs (with no other instructions), run through every item
on this checklist. Report findings concisely; do NOT propose code changes
unless an actual bug is found. Update this checklist whenever behavior changes.

### Per-session flow walkthrough

- Walk through each account session in order: login → collects → aborts →
  revisions → sells/buys placed → break/logout.
- For each abort: identify the stale check that triggered it (reason string),
  verify the revision was applied correctly, verify the re-list happened.
- For each buy/sell placed: verify the price and margin make sense.
- Note any partial-fill handling (partial buy sold, partial sell revised).

### Profitability

- **New completions**: identify any merch history entries added this segment.
  Report item, qty, buy/sell prices, profit, revisions, sell elapsed.
- **Realized profit**: per-account total (from merch history dump) and
  combined across all accounts. Track the trend across segments.
- **Projected profit**: sum of `projProfit` across active cache entries (note
  these are projections, not realized).

### Cache state (from cache dump on logout)

- Build a table of all active entries: item, mode, buy, sell, net, projProfit,
  elapsed, key notes.
- **Revision trajectory**: for items with 3+ revisions, note the margin
  erosion rate and estimate when they'll hit the abandon floor (rev 6) or
  final dump floor (rev 8).
- **Floor-hit tracking**: items at the price floor with floor-hit count
  approaching the abandon threshold (2 for thick-margin, 4 for thin-margin).
- **Stuck items**: long-elapsed 0-progress items not being caught by stale
  checks (e.g. because sessions are too short for stale checks to run).
- **Dump-floor guard**: items at the tax-break-even floor with rev count ≥ 8
  should NOT be aborting until the hold timer expires (90 min for rev 8,
  30 min for rev 9+). After the hold timer, the controlled loss dump fires
  (rev 9+, pricing below tax break-even). Items at rev 9+ at the 80% minimum
  should NOT be aborting. If aborts continue past the minimum, the
  `canReduceControlledLoss` guard may be broken.

### Stale/abort/revision correctness

- **Abort reasons**: every abort should have a clear, valid reason matching
  one of the documented stale checks. Unexplained aborts are a bug.
- **Revision counting**: revCount = `revisedPrices.length - 1` (0-indexed).
  The `revisions=[A -> B -> C]` dump shows prices, not revision numbers —
  6 prices means revCount 5, not 6. Do NOT count prices as revisions.
- **Revision amounts**: verify the reduction matches the revision tier
  (5% for revCount 0-1, 8% for revCount 2-3, 12% for revCount 4-5,
  direct drop to the tax-break-even floor at revCount 6, final dump at revCount 8+).
- **Reconstructed flag**: reconstructed entries should have the flag cleared
  after `recordSellOffer`/`confirmSellOffer`. If reconstructed aborts keep
  firing on re-lists, the flag isn't being cleared. The `reconstructedBuyPrice`
  flag should NOT be cleared on re-list — it survives to skip phantom losses.
  If phantom losses appear for reconstructed items, check that
  `reconstructedBuyPrice` is set and not prematurely cleared.
- **Floor-hit markers**: when a revision can't reduce the price (already at
  floor), the revision count should still advance with a floor-hit marker.
  A floor-hit at revCount 5 will advance the count to 6, causing the next
  revision to drop directly to the tax-break-even floor.

### Break / rotation / hop behavior

- **Break timing**: short breaks should trigger at 50% or 90% ETA checks.
  Verify the break duration is 3-8 min. When the next action ETA is ≤ 60s,
  the bot should log `Staying logged in — next action ETA ...` and remain
  online instead of logging out.
- **Rotation**: verify accounts are cycling correctly. Check for "no eligible
  accounts" polling when all are sleeping.
- **World hops**: did hops fire on schedule? Were any blocked by busy actions
  (should no longer happen — the GE flow gate prevents dispatching mid-flow)?
  Did they reschedule correctly? Check `Hop state restored` on reload.
  If `Hop due but not safe: reason=GE flow in progress` appears, the hop is
  correctly waiting for the active flow to clear.
- **Script timer**: on hot reload, verify `Script timer restored — running
  for N min` appears and the elapsed time is correct.

### Reload / state recovery

- **Cache restoration**: after a reload, verify the cache dump shows the same
  entries (no data loss).
- **Break/hop/rotation state**: verify `Restored break state` and
  `Hop state restored` appear after reload.
- **Mid-flow recovery**: if a reload happened mid-flow (GE open, offer config
  screen, search prompt), verify the startup audit reconciled correctly and
  the bot resumed without getting stuck.
- **Double-reload**: two reloads in quick succession should both recover
  cleanly without corrupting state.

### Native handle / performance

- `slow JS dispatch` frequency: occasional during login is normal (~2000ms).
  Frequent occurrences outside login indicate a problem.
- `auto-disabled after 3 consecutive failures` — critical, native handle
  table exhausted. Report immediately.
- ClickSafety: high `invalid` / `fallback` counts may indicate UI layout
  issues. `rejected` clicks are more concerning.

### Cross-account item overlap

- Multiple accounts are allowed to trade the same item concurrently. The
  buy scan does NOT deduplicate across accounts — each account picks the
  highest-ranked item it can afford. Same-item overlap is expected and
  intentional; flag it only as context for sell-side price competition,
  not as a bug.

### GE tax correctness

- Items selling below 50gp should have `tax=0gp` (exempt).
- Items selling ≥ 50gp should have `tax = floor(sellPrice * 0.02)`.
- Verify `net = sellPrice - tax` in cache dumps.

### Slot utilization

- All 8 slots should be occupied during active trading. Empty slots during
  a session (when inventory has sellable items or buy candidates exist)
  may indicate a scan issue.
- `mode=idle` entries are completed sells awaiting slot reuse — normal.

### Buy freezes

- List active freezes with expiry times and source labels. The diagnostic
  dump shows each freeze as `item [source]: expires in N min (at TIMESTAMP)`.
  Sources: `buy-abort`, `sell-abort`, `loss-cooldown`. After a
  reload, in-memory source labels are unavailable and the source shows as
  `restored`.
- Verify freeze durations escalate correctly:
  - **Buy abort freeze** [`buy-abort`]: progressive freeze based on the
    effective count (buy + sell aborts). 5 min for effective count 1, 10 min
    for count 2, 15/20/25/30 min for counts 3-6. Items with 3+ effective
    aborts are hard-skipped.
  - **Sell abort freeze** [`sell-abort`]: progressive buy freeze applied on
    sell-abort completion (sell offer aborted with <25% progress). Uses the
    same effective count (buy + sell) and the same progressive duration and
    hard-skip threshold as buy aborts. This prevents re-buying items that
    consistently fail to sell at the projected price (e.g. Raw manta ray,
    Dragon dart — items that went through 4-9 sell revision cycles). The
    freeze does NOT prevent the current sell re-list cycle — the item is
    still re-listed at a revised price. The previous standalone sell freeze
    (30 min × sell count, up to 24h) was removed because it overcorrected;
    the current approach is gentler (caps at 30 min, decays after 2h).
  - **Loss-history cooldown** [`loss-cooldown`]: 2h freeze applied on
    startup/account switch for items with a completed loss in merch history
    within the last 6h (`LOSS_HISTORY_LOOKBACK_MS`). The freeze expires at
    `latestLossTime + 2h`. Multiple recent losses for the same item extend
    the freeze by taking the latest loss timestamp. Prevents re-buying items
    confirmed unprofitable (e.g. Amethyst dart, Dragonstone bolts (e)).
  - **Abort-history seeding** [`abort-seed`]: on startup/account switch, sell
    aborts in abort history within the last 24h
    (`HISTORICAL_SELL_ABORT_SEED_LOOKBACK_MS`) are counted and seeded into
    the live `sellCount`/`lastSellAbortAt`. The seeded count feeds into the
    effective count — items with 3+ effective aborts are hard-skipped by the
    hard-skip scan on the next tick. No explicit freeze is applied from the
    seeded count (the hard-skip is the stronger protection for historical
    aborts). The seeded count participates in normal 2h decay. Idempotent:
    only seeds if the historical count exceeds the current live count.
- Both historical protections are applied once per account per session via
  `applyHistoricalProtections()`, which runs early in `autoLoopTick`. The
  log line `Auto: historical protections applied for "X" — N loss cooldown(s),
  M sell-abort seed(s)` confirms they fired.
- Verify frozen items are not being re-bought while frozen.
- Buy-abort, sell-abort, and loss-history freezes do NOT prevent the current
  sell re-list cycle — they only prevent future buys of the item.

### Login / logout flow

- Credential staging: `setUsername`/`setPassword`/`setDisplayName` sequence.
- Login attempts: `Submitted credentials for X (attempt N/10)`.
- Any failed logins or retry storms?
- Logout clicks: should see `text=Logout` followed by state dump.

### Profit display

- The visible `profitDisplay` setting is updated after each completed sale
  and on logout (no log line for this — it's silent). This ensures the
  display stays current when idle activity keeps the bot logged in for long
  periods without a logout. Verify the UI shows the correct profit (user
  must confirm visually).
- **Deduplication**: Accounts are matched by normalized name (whitespace +
  case normalized via `normalizeAccountName` in account-rotation.ts, which
  collapses non-breaking spaces U+00A0 and other Unicode whitespace, trims,
  and lowercases) so that "hc fruitz" and "HC fruitz" — or "hc\u00A0fruitz"
  (non-breaking space, as the OSRS client reports it) and "hc fruitz" (roster)
  — are summed into a single display line instead of appearing twice with
  different totals. `initSessionProfile` canonicalizes `bot.currentPlayerName`
  to the roster's version under this same normalization, preventing future
  divergence at the source. All rotation same-account comparisons
  (`tryImmediateRotation`, break-ended rotation, unexpected-logout rotation)
  use `normalizeAccountName` so a non-breaking-space game name is correctly
  treated as the same account as the roster entry — without this, the bot
  would log out for a break and immediately log back into the same account
  (the same-account guard fails, the break-state lookup misses, and the
  account is always treated as eligible).

### Anomalies

- Anything that doesn't fit a documented pattern. This is the catch-all.
- Common anomaly types: unexpected item selection, price jumps, missing
  cache entries, duplicate profit recordings, flow step skips.

---

## Key constants reference

| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `GE_TAX_PERCENTAGE` | 2 | constants.ts | GE sale tax % |
| `GE_TAX_EXEMPTION_THRESHOLD` | 50 | constants.ts | Items < 50gp exempt |
| `RECONSTRUCTED_SELL_PROFIT_PER_SLOT_HOUR_MIN` | 5000 | auto-loop.ts | Min profit/hr for reconstructed sells |
| `RECONSTRUCTED_SELL_GRACE_PERIOD_MIN` | 5 | auto-loop.ts | Grace period before low-profit guard |
| `RECONSTRUCTED_ETA_CAP_MIN` | 120 | offer-cache.ts | Max ETA for reconstructed entries |
| `RUNTIME_SELL_ETA_CAP_MIN_MIN` | 15 | offer-cache.ts | Min value-aware sell ETA cap (low-profit items) |
| `RUNTIME_SELL_ETA_CAP_MAX_MIN` | 120 | offer-cache.ts | Max value-aware sell ETA cap (high-profit items) |
| `RUNTIME_SELL_ETA_CAP_PROFIT_PER_HOUR_REFERENCE` | 20000 | offer-cache.ts | Profit/hr reference for value-aware cap scaling |
| `SELL_ETA_FLOOR_MIN` | 5 | auto-loop.ts | Min sell ETA for stale checks |
| `BUY_ETA_FLOOR_MIN` | 10 | auto-loop.ts | Min buy ETA for stale checks |
| `F2P_MIN_SLOT_OCCUPATION_MIN` | 45 | auto-loop.ts | F2P min slot occupation (min) before ETA-based buy abort (with swap-out exception) |
| `BUY_ZERO_PROGRESS_THIN_MARGIN_THRESHOLD` | 3 | auto-loop.ts | Profit margin (gp) at/below which 0-fill cap = 125% ETA |
| `THIN_MARGIN_REVISION_THRESHOLD_GP` | 10 | offer-cache.ts | Gross margin below which thin-margin rates apply (now identical to standard) |
| `THIN_MARGIN_REVISION_RATES` | [0.10, 0.10, 0.12, 0.12, 0.15, 0.15] | offer-cache.ts | Same as standard rates (margin floors the reduction anyway) |
| `REVISION_RATES` | [0.10, 0.10, 0.12, 0.12, 0.15, 0.15] | offer-cache.ts | Standard revision rates (gross profit %) |
| `BUY_PROFIT_SCALE_MIN_PROFIT_PER_HOUR` | 20000 | auto-loop.ts | Profit/hr at which buy abort scaling starts (1.0x) |
| `BUY_PROFIT_SCALE_MAX_FACTOR` | 2.5 | auto-loop.ts | Max profit/hr scale factor for buy abort thresholds (floor) |
| `BUY_PROFIT_SCALE_CEILING_MAX_FACTOR` | 1.5 | auto-loop.ts | Max profit/hr scale factor for buy abort ceiling (reduced) |
| `BUY_REPRICE_MAX_COUNT` | 2 | auto-loop.ts | Max buy reprices before normal freeze |
| `BUY_REPRICE_MIN_PROFIT_PER_HOUR` | 100000 | auto-loop.ts | Min profit/hr to qualify for repricing |
| `BUY_REPRICE_MIN_MARGIN_GP` | 10 | auto-loop.ts | Min gross margin (gp) to qualify for repricing |
| `BUY_REPRICE_POST_BUMP_MIN_PROFIT_PER_HOUR` | 50000 | auto-loop.ts | Min post-bump profit/hr (viability check) |
| `BUY_REPRICE_BUY_PRICE_RATIO` | 0.005 | auto-loop.ts | Bump = 0.5% of buy price (capped by margin ratio) |
| `BUY_REPRICE_MARGIN_RATIO` | 0.10 | auto-loop.ts | Bump = 10% of gross margin (capped by buy price ratio) |
| `BASE_FILL_TIME_MIN` | 5 | merchable-items.ts | Base "time to first fill" in non-linear ETA model |
| `SELL_PROGRESS_RECENT_ETA_RATIO` | 0.5 | auto-loop.ts | Half-ETA window for recent progress check |
| `SELL_PROGRESS_EXTENSION_CAP_RATIO` | 2.0 | auto-loop.ts | 2x ETA hard cap for progress extension |
| `RUNTIME_MIN_ABSOLUTE_PROFIT_GP` | 20000 | auto-loop.ts | Min total profit for buy scan |
| `RUNTIME_MIN_EFFECTIVE_VOLUME` | 15 | merchable-items.ts | Min effective volume (units/hr) |
| `MAX_SLOT_BUDGET_MULTIPLIER` | 2.5 | auto-loop.ts | Per-slot budget soft cap |
| `MAX_CONSECUTIVE_FAILURES` | 3 | auto-loop.ts | Termination threshold |
| `GE_OPEN_WALL_CLOCK_COOLDOWN_MS` | 3000 | auto-loop.ts | GE-open click cooldown |
| `COLLECT_WALL_CLOCK_COOLDOWN_MS` | 3000 | auto-loop.ts | Collect click cooldown |
| `MAX_RESULTS` | 100 | determine-flips.mjs | Max items in merchableItems.json |
| `DUMP_FLOOR_HOLD_MIN` | 90 | auto-loop.ts | Hold at tax break-even floor (rev 8) before controlled loss dump |
| `DUMP_FLOOR_CONTROLLED_LOSS_HOLD_MIN` | 30 | auto-loop.ts | Hold between controlled loss re-reductions (rev 9+) |
| `CONTROLLED_LOSS_REVISION_COUNT` | 9 | offer-cache.ts | First revision below tax break-even floor |
| `CONTROLLED_LOSS_REDUCTION_RATE` | 0.03 | offer-cache.ts | 3% of buyPrice per controlled loss revision |
| `CONTROLLED_LOSS_MIN_REDUCTION_GP` | 5 | offer-cache.ts | Minimum controlled loss reduction amount |
| `CONTROLLED_LOSS_MIN_PRICE_RATIO` | 0.80 | offer-cache.ts | Never price below 80% of buyPrice |
| `CONTROLLED_LOSS_MAX_REVISIONS` | 4 | offer-cache.ts | Max controlled loss revisions (rev 9-12) |

---

## Diagnostic dump (on logout / manual button)

The bot dumps full state on every logout and via manual UI buttons:

1. **Offer cache** — all entries with mode, prices, elapsed, revisions, net
   profit, projected profit, ETAs, sell confirmation, partials.
2. **Merch history** — completed cycles with profit, buy/sell prices, quantities,
   revision prices, elapsed times, diagnostic fields.
3. **Abort history** — all aborted offers with reason, category, elapsed, ETA,
   filled qty, price. Capped at 200 per account.
4. **Buy freezes** — active frozen items with source labels (`buy-abort`,
   `loss-cooldown`, or `restored` after reload) and expiry timestamps.

**Profit display**: `updateProfitDisplay` writes the visible `profitDisplay`
setting after each completed sale and on logout — pure JSON parse + string
formatting, no native SDK calls.
Accounts are deduplicated by normalized name (trimmed + lowercased) so that
casing/whitespace differences between the game's `localPlayer.name` and the
roster entry don't cause the same account to appear twice with different totals.

---

## File map (runtime-relevant)

| File | Responsibility |
|------|---------------|
| `grand_exchange/auto-loop.ts` | Main loop, stale checks, abort/sell/buy orchestration |
| `grand_exchange/buy-offer.ts` | BuyOfferFlow state machine |
| `grand_exchange/sell-offer.ts` | SellOfferFlow state machine |
| `grand_exchange/abort-offer.ts` | AbortOfferFlow state machine |
| `grand_exchange/constants.ts` | GE tax, thresholds |
| `grand_exchange/widgets.ts` | GE slot reading, isGeOpen, isMembersWorld, scanSearchResults, scanSearchResultsUnique (early-stop) |
| `grand_exchange/clerk.ts` | GE booth/clerk detection (cached entity queries), openGe, nearGrandExchange |
| `data/offer-cache.ts` | OfferCacheManager, recordBuy/Sell, revise, reconstruct |
| `data/merchable-items.ts` | merchableItems.json reader, runtime evaluation |
| `data/price-history.ts` | priceHistory.json reader, fallback prices |
| `data/merch-history.ts` | Merch cycle recording, profit/loss tracking (hidden setting, duplicate account-key migration) |
| `data/abort-history.ts` | Abort recording with reasons (hidden setting, duplicate account-key migration) |
| `data/daily-profit.ts` | Per-account daily profit, UK midnight rollover (hidden setting, duplicate account-key migration) |
| `antiban/session.ts` | Break logic, rotation, hop state load |
| `antiban/hopper.ts` | World hopping, saveHopState, cached world list |
| `antiban/session-profile.ts` | Sleep/wake/profile generation |
| `antiban/account-rotation.ts` | Multi-account rotation |
| `antiban/login.ts` | Login credential staging |
| `antiban/logout.ts` | Logout click logic, cached logout door |
| `general/lifecycle.ts` | onEnable/terminate, state reset |
| `general/state.ts` | sanityCheckState, resetInFlightActionState |
| `general/state-persist.ts` | Offer cache persistence, OfferCacheEntry type |
| `general/timing.ts` | setAction, canPerformAction, tick throttling |
| `general/dump.ts` | Shared dump helpers, updateProfitDisplay |
| `widgets/bot-overlay.ts` | Minimal HUD overlay (mode label only) |
| `idle-activity/chocolate-dust.ts` | Chocolate Dust idle activity (value 1) |
| `idle-activity/ultra-compost.ts` | Ultra Compost idle activity (value 2) |
| `idle-activity/goat-horn.ts` | Goat Horn Dust idle activity (value 3) |
| `idle-activity/any-activity.ts` | "Any" idle activity mode (value 4) — scans bank for ingredients of all three activities, randomly picks one |
