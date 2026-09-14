/// <reference path="./titan-plugin-sdk.d.ts" />
import { debug } from './general/debug.js';
import { onEnable, terminate } from './general/lifecycle.js';
import { shouldWait } from './general/timing.js';
import { sanityCheckState } from './general/state.js';
import { auditGeState, invalidateMembersWorldCache, invalidateGeWidgetCache, invalidateBooleanStateCache, isOfferConfigOpen, isSearchPromptShown, isPricePromptShown, isQuantityPromptShown, isGeOpen, isBankOpen, isInventoryOpen, isWorldSwitcherOpenCached } from './grand_exchange/widgets.js';
import { autoLoopTick, createAutoLoopState, resetAutoLoop, invalidateInvCache, type AutoLoopState } from './grand_exchange/auto-loop.js';
import { sendKeyWithJitter, resetClickJitter } from './antiban/click-jitter.js';
import { ensureInventoryOpen, resetLocalPlayerCache } from './general/helpers.js';
import { breakStep, wallClockStep, resetBreakState, saveBreakState, initSessionProfile, markNightlyBreakFinished, resetHop, forceHop, shouldPauseForHopBoundary, resetLoginSnapshotCache, formatUKTime } from './antiban/session.js';
import { resetLoginState, loginStep, isTitleScreenVisible, resetLoginThrottle } from './antiban/login.js';
import { resetLogoutState } from './antiban/logout.js';
import { hopStep, completeHop, onChatMessage as onHopChatMessage } from './antiban/hopper.js';
import { renderBotOverlay } from './widgets/bot-overlay.js';
import { invalidateNearGeCache, invalidateEntityQueryCache } from './grand_exchange/clerk.js';
import { invalidateRotationCaches } from './antiban/account-rotation.js';
import { invalidateSessionProfileCache } from './antiban/session-profile.js';
import { invalidateLogoutDoorCache } from './antiban/logout.js';
import { invalidateWorldListCache } from './antiban/hopper.js';
import { dumpOfferCache, dumpMerchHistory, dumpAbortHistory, dumpBuyFreezes } from './general/dump.js';
import type { SessionProfile } from './antiban/session-profile.js';

/** Map autoMode value to the short label shown on the overlay. */
const modeLabel = (v: number): string =>
    v === 3 ? 'F2P'
    : v === 2 ? 'Slow'
    : v === 1 ? 'Normal'
    : 'Paused';

export class StarkMercher extends titan.Plugin {
    id = "stark-mercher";
    name = "Stark Mercher";
    description = "Grand Exchange merching bot.";
    author = "Matt";
    version = "1.0.0";

    terminated = false;
    terminationReason = '';
    isRunning = false;

    // --- Overlay HUD ---
    // isHudActive gates the overlay render callback. Set true on enable,
    // false on disable.
    isHudActive = false;
    // Cached plain-JS mirrors of autoMode.value, showHud.value, and
    // hopWorlds.value. Setting.value reads cross the JS<->native boundary;
    // reading them every frame from onMainLoop (which fires at the client's
    // main-loop rate, far higher on the login/title screen where no 3D world
    // is rendered) and from the overlay render callback exhausts the native
    // handle table within a few minutes, dropping FPS to 0 after login.
    // These mirrors are refreshed in onEnable and onSettingChanged, then
    // read as plain fields in the per-frame paths. Matches the mixology
    // plugin's pattern of reading only plain booleans in onMainLoop.
    autoModeValue = 0;
    showHudValue = true;
    hopWorldsValue = true;
    // Additional cached plain-JS mirrors of settings read from per-tick
    // callbacks (onGameTick -> breakStep + autoLoopTick). Each Setting.value
    // read crosses the JS<->native boundary; reading them every tick
    // (~100 ticks/min) gradually exhausts the native handle table over
    // 4-8 hours, causing FPS to drop to 0. Same root cause as the per-frame
    // reads above, just slower accumulation. These mirrors are refreshed
    // in onEnable and onSettingChanged, then read as plain fields in the
    // per-tick paths.
    idleActivityValue = 0;
    doNotSleepValue = false;
    logInfoValue = true;
    logDebugValue = false;
    // statusText is the human-readable top-level action string. Updated by
    // the auto-loop and test flows. No longer displayed on the overlay (the
    // overlay now shows only the mode label); kept for log diagnostics.
    statusText = 'Stopped';
    // overlayStatusText is the single string drawn by the minimal overlay.
    // Updated only in onEnable / onDisable / onSettingChanged — never
    // per-frame. The overlay render callback reads this plain field and
    // draws one rect + one text line, with no allocations or native reads.
    overlayStatusText = 'Stopped';
    // UK-formatted (HH:MM) time when the script first started in this client
    // session. Set once per client session (survives plugin toggles via the
    // module-level sessionStartUKTimeCache). Read by the overlay render
    // callback as a plain-JS string — no per-frame native reads or allocations.
    sessionStartUKTime = '';
    // Cached plain-JS mirror of titan.state.login.isLoggedIn. Updated in
    // onEnable (one native read), onGameStateChanged (on login/logout
    // transitions), and onGameTick (defensive — onGameTick only fires when
    // logged in, so setting it to true there is always correct). Read in
    // onMainLoop (which fires at frame rate) to skip wallClockStep entirely
    // when logged in — wallClockStep is all logged-out logic (break
    // transitions, rotation, login step, account detection) and does
    // nothing useful when logged in. Without this cache, onMainLoop would
    // either call wallClockStep every frame (wasteful function call) or
    // read titan.state.login.isLoggedIn every frame (native scalar read
    // per frame). The cached field avoids both.
    cachedIsLoggedIn = false;
    // Render-loop diagnostic: logs titan.state.client.tick every 30s from
    // onMainLoop. If the tick counter freezes when FPS hits 0, the client's
    // main loop is stalled (native handle exhaustion). If it keeps
    // advancing, the loop is running but slow (GC pressure). Per Titan
    // dev recommendation.
    lastDiagLogMs = 0;
    // Wall-clock timestamp when the script was first enabled (onEnable).
    // Used by the overlay to show a running script timer in the title.
    // Persisted in scriptStartSetting so it survives hot reloads; cleared
    // on terminate() so a manual stop + restart starts a fresh timer.
    scriptStartMs = 0;

    // Action throttle state
    lastActionTick = -1;
    actionStartTime = 0;
    actionDelay = 0;
    currentAction: string | null = null;
    lastAction: string | null = null;
    lastActionTime = 0;
    /** Tracks whether the "Delaying X ticks" debug log has been shown for the
     *  current action. Reset to false in setAction, set to true after logging. */
    delayLogShown = false;

    // --- Startup audit ---
    // On script start (onEnable), we audit the GE state to determine if
    // a buy-offer flow was in progress. If recoverable, we resume it.
    // The audit runs once on the first tick after enable, not every tick.
    startupAuditDone = false;
    // Tracks whether we've logged the title-screen deferral message, to
    // avoid spamming the log every tick while waiting for the title screen
    // to clear.
    startupAuditDeferredLogged = false;

    // --- Auto-merch loop state ---
    // When autoMode is enabled (Normal or Slow), the bot runs the automated
    // merching loop: collect → stale → sell → buy. When disabled (Paused),
    // the bot idles and only responds to the test buttons.
    autoLoop: AutoLoopState = createAutoLoopState();

    // --- Break / login / logout state ---
    // The mercher takes short logout breaks (2-5 min) when the auto-loop
    // has nothing to do, plus a nightly sleep (4.5-7.5h). Both log the
    // player out; GE offers continue filling while logged out.
    breakPhase: 'none' | 'logging_out' | 'logged_out' | 'logging_in' = 'none';
    breakType: 'none' | 'short' | 'nightly' | 'hour_pause' = 'none';
    breakStartMs = 0;
    breakTargetEndMs = 0;
    nightlyBreakTargetTime = -1;
    nightlySleepMinutes = -1;
    nightlyBreakFinished = -1;
    /** Set by the auto-loop when it has nothing to do — signals that a
     *  short logout break can be taken. */
    loopIdleForBreak = false;
    /** Tick when the auto-loop first became idle. Used to enforce a
     *  randomised tick-based delay before taking a short break. Reset
     *  whenever the auto-loop performs an action. */
    loopIdleSinceTick = -1;
    /** Randomised delay in ticks before a short break triggers after the
     *  bot goes idle. Computed once when the bot first becomes idle:
     *    base 5-20 ticks
     *    + 3 ticks (20% chance)
     *    + 1-10 ticks (10% chance)
     *    + 5-15 ticks (1% chance)
     *  This replaces the old 60-second wall-clock grace period. */
    shortBreakDelayTicks = -1;
    /** ETA-based break duration hint (in minutes), set by the auto-loop
     *  when it goes idle. Represents the minimum remaining time until the
     *  next action on any slot (earlier of completion or stale-abort
     *  threshold). The break system uses this to time the return so the
     *  bot logs back in when there's something to do, instead of sampling
     *  a random 2-5 min duration. -1 = not computed (fall back to random). */
    nextActionEtaMin = -1;
    /** Set to true when a short break starts, cleared when any GE action
     *  happens (collect/sell/buy/abort). When true, the next short break
     *  uses 90% of the remaining ETA instead of 50%, since we already
     *  checked at 50% and found nothing ready. This prevents rapid
     *  login/nothing-to-do/logout cycling when all slots are occupied
     *  with slow-filling offers.
     *  IMPORTANT: This flag is NOT cleared on login, hop, break, or
     *  disconnect transitions — it survives logout/login cycles because
     *  "we already checked at 50% and found nothing" is still true after
     *  a logout. It is cleared only when an actual GE action is performed
     *  (buy/sell/abort/collect/completed-sell) in auto-loop.ts. */
    checkedAtHalfEta = false;
    /** Tick of the last idle diagnostic log (GE slots, stale check, sell/buy
     *  scan, ETA). Throttles the "nothing to do" auto-loop diagnostic to every
     *  ~5 seconds instead of every tick, preventing log spam during idle
     *  periods. -1 = not yet logged. */
    lastIdleDiagTick = -1;
    // Login state
    currentPlayerName = '';
    sessionProfile: SessionProfile | null = null;
    unexpectedLogoutAtMs = 0;
    // --- Multi-account rotation state ---
    // Which index in the roster to check next when selecting an account to
    // log in. Persisted in rotationIndexSetting. Advanced by selectNextAccount()
    // each time an account is selected. -1 = not yet loaded from setting.
    rotationIndex = -1;
    // Throttle for the idle-rotation check in wallClockStep. While waiting
    // for the current account's break to end, we periodically check if
    // another account has become eligible and rotate immediately if so.
    // Timestamp of the last check; 0 = never checked.
    lastIdleRotationCheckMs = 0;
    // Throttle for the logged-in rotation check. While the current account
    // is logged in and performing an idle activity, we periodically check
    // if a DIFFERENT account has become eligible. If so, the idle activity
    // cleans up (banks items) and yields so the break system logs out and
    // rotates to the eligible account. Timestamp of the last check;
    // 0 = never checked.
    lastLoggedInRotationCheckMs = 0;
    // Set by onChatMessage when a GE offer completes ("Grand Exchange:
    // Finished buying/selling X") while an idle activity is active. The
    // idle-activity dispatch checks this flag and yields to GE operations
    // immediately instead of waiting for the ETA-based timer to expire.
    // 0 = no pending completion. Only set when idleActivityPhase !== 'none'
    // so normal GE operations (where completions are handled by the
    // collect/sweep flows) are unaffected.
    geOfferCompletedChatMs = 0;
    // wallClockStep 1-second throttle — onMainLoop fires at frame rate
    // (30-60 FPS), so without throttling wallClockStep makes 90-300 native
    // SDK calls per second (localPlayer, login.state, login.isLoggedIn,
    // widgets.find via loginStep, login.snapshot via loginStep). Over hours
    // this exhausts the native handle table, causing 2000ms+ dispatches,
    // frame anomalies, and 0 FPS. Mirrors the mixology wallClockStep throttle.
    lastWallClockMs = 0;
    // Login FSM fields
    titleNextClickAt = 0;
    titleFirstSeenAtMs = 0;
    titleClickDelayMs = 0;
    postLoginResumeAtMs = -1;
    titleWaitingForGone = false;
    loginSettled = false;
    loginStageNextAttemptAt = 0;
    loginStageDetectedAtMs = 0;
    loginGameUpdateWaitAtMs = 0;
    loginSubmitAttemptTimes: number[] = [];
    loginFirstAttemptAtMs = 0;
    loginTotalSubmitAttempts = 0;
    /** Timestamp until which we wait before the first stageCredentials attempt
     *  on a fresh client launch. The native account profile system needs time
     *  to initialize after client start; calling stageCredentials() before it's
     *  ready returns false indefinitely. Set to now + grace on script start. */
    loginStartupGraceUntil = 0;
    // Logout FSM fields
    logoutStep = 0;
    logoutAttemptCount = 0;
    logoutNextAttemptMs = 0;
    logoutComplete = false;

    // --- Player idle tracking (for hop safe-boundary checks) ---
    consecutiveMovingTicks = 0;
    lastPlayerStationaryTick = 0;

    // --- Session day timer ---
    // Tracks when the current day session started (wall-clock ms). Set lazily
    // when the player is logged in and not on a break. Reset to -1 when a
    // nightly break starts (the day session ends). Used by the overlay to
    // show "Session (Day): elapsed (target)".
    sessionPlayStartMs = -1;

    // --- World hop state ---
    // Adapted from stark-mixology. The bot hops to a random safe members world
    // at a profile-scheduled interval. Hopping pauses the auto-loop while the
    // hop is in progress and for a short resume delay afterwards.
    nextHopTick = -1;
    nextHopAtMs = -1;
    nextHopStartAtMs = -1;
    nextHopTargetTicks = -1;
    nextHopPausedRemainingMs = -1;
    hopResumeAtMs = -1;
    lastHopTick = -1;
    lastHopMs = -1;
    hopInProgress = false;
    hopSawLoggedOut = false;
    hopToWorldId = -1;
    hopCooldownTick = -1;
    hopCooldownTicks = 30;
    forceHopPending = false;
    hopJustCompleted = false;
    hopJustCompletedAtMs = -1;
    hopCount = 0;
    /** Tracks whether the inventory tab has been confirmed open after the
     *  most recent hop or login. Reset to false in completeHop() and on
     *  post-login settle so the inventory-open guard runs once per
     *  transition. The world switcher can stay open after hopIngame()
     *  completes; without this guard the auto-loop would try to interact
     *  with widgets while the switcher is still visible. */
    inventoryOpenEnsured = false;
    /** True if the most recent hop was a "burst" hop (short interval). The
     *  next interval is more likely to also be short, simulating the human
     *  pattern of hopping 2-3 times in quick succession when annoyed. */
    lastHopWasBurst = false;

    // --- Hidden session profile setting ---
    // Stores per-account session profiles as JSON (sleep/wake/break timing).
    // Keyed by "sessionProfile:<accountName>".
    sessionProfileSetting: titan.Setting<string> = this.stringSetting({
        key: 'sessionProfile',
        name: 'Session profile (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Offer cache setting (hidden) ---
    // Stores the per-account offer cache as JSON. Hidden because the Titan
    // settings UI truncates string fields at 4095 chars, making the field
    // uneditable for large caches. The full value is read/written correctly
    // by the plugin via .value. Includes duplicate account-key migration on
    // load (keys differing by invisible whitespace characters like
    // non-breaking spaces are merged under a canonical key).
    offerCacheSetting: titan.Setting<string> = this.stringSetting({
        key: 'offerCache',
        name: 'Offer cache (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Daily profit setting (hidden) ---
    // Stores per-account daily profit as JSON. Keyed by account name.
    // Each entry has { dayStartedAt, profit }. Day rollover is handled by
    // comparing dayStartedAt to the current day's midnight on read/write.
    // Includes duplicate account-key migration on load.
    dailyProfitSetting: titan.Setting<string> = this.stringSetting({
        key: 'dailyProfit',
        name: 'Daily profit (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Hidden hop state setting ---
    // Stores the global hop timer state as JSON (nextHopAtMs, hopCount).
    // The hop timer is global (not per-account) since account rotation
    // means only one account is active at a time. Restored on script reload
    // by loadHopState() in lifecycle.ts.
    hopStateSetting: titan.Setting<string> = this.stringSetting({
        key: 'hopState',
        name: 'Hop state (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Hidden script start timestamp setting ---
    // Stores the wall-clock timestamp (ms) when the script was first enabled
    // so the overlay's running timer survives hot reloads. On hot reload,
    // resetState() restores scriptStartMs from this setting instead of
    // resetting to Date.now(). On terminate() the setting is cleared so a
    // manual stop + restart starts a fresh timer. Same persistence
    // limitation as offerCacheSetting — hot reload only, not client restart.
    scriptStartSetting: titan.Setting<string> = this.stringSetting({
        key: 'scriptStart',
        name: 'Script start timestamp (hidden)',
        default: '0',
        hidden: true,
    });

    // --- Hidden last active account setting ---
    // Stores the last active account name. Used as a fallback when the
    // login snapshot doesn't have a displayName (e.g. account not staged
    // yet at script start). Same persistence limitation as
    // offerCacheSetting — hot reload only.
    lastActiveAccountSetting: titan.Setting<string> = this.stringSetting({
        key: 'lastActiveAccount',
        name: 'Last active account (hidden)',
        default: '',
        hidden: true,
    });

    // --- Hidden break state setting ---
    // Stores the current break/login state as JSON so it survives plugin
    // restarts and hot reloads. Includes breakPhase, breakType, breakTargetEndMs,
    // nightly sleep schedule, session start, and unexpected logout timestamp.
    // Restored on enable so the overlay shows the correct countdown and the
    // bot knows to continue sleeping / wait for login.
    // Same persistence limitation as offerCacheSetting — hot reload only.
    breakStateSetting: titan.Setting<string> = this.stringSetting({
        key: 'breakState',
        name: 'Break state (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Merch history setting (hidden) ---
    // Stores per-account merch history (profits and losses) as JSON.
    // Each entry records item, qty, profit/loss, date, buy price, avg sold
    // price, and revision count for a completed merch cycle.
    // Hidden because the Titan settings UI truncates string fields at 4095
    // chars. Includes duplicate account-key migration on load.
    merchHistorySetting: titan.Setting<string> = this.stringSetting({
        key: 'merchHistory',
        name: 'Merch history (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Buy-freeze setting (hidden) ---
    // Stores the global buy-freeze state as JSON. A flat map of lowercase
    // item name -> freeze-until timestamp (ms). Freezes are global (not
    // account-keyed) because they represent a market/item-level signal —
    // an item that isn't buying at the offered price on one account is
    // unlikely to buy at that price on another account either. Survives
    // hot reloads so a buy freeze applied after aborting a stale buy offer
    // is not lost on plugin toggle.
    // Same persistence limitation as offerCacheSetting — hot reload only.
    // Legacy nested format ({ account: { item: until } }) is migrated to
    // flat on first load by loadBuyFreeze() in auto-loop.ts.
    buyFreezeSetting: titan.Setting<string> = this.stringSetting({
        key: 'buyFreeze',
        name: 'Buy freeze (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Item abort count setting (hidden) ---
    // Tracks how many times each item has had a buy offer aborted for ETA
    // reasons recently. Used to progressively increase the freeze duration
    // and eventually hard-skip items that consistently don't fill at the
    // offered price. Format: { "itemname": { count: N, lastAbortAt: ms } }.
    // Counts decay after ITEM_ABORT_COUNT_RESET_MS (1 hour) of no aborts.
    // Global (not account-keyed) — same rationale as buyFreezeSetting.
    itemAbortCountSetting: titan.Setting<string> = this.stringSetting({
        key: 'itemAbortCount',
        name: 'Item abort count (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Abort history setting (hidden) ---
    // Stores per-account abort history as JSON. Each entry records an
    // aborted buy or sell offer: item, type, requested/filled qty, reason,
    // category ('eta', 'swap', or 'config'), elapsed minutes, original ETA,
    // price, and timestamp. This is the key diagnostic for low overnight
    // profit — aborted 0-fill buys represent wasted time and slot occupancy
    // that merch history doesn't capture.
    // Hidden. Includes duplicate account-key migration on load.
    abortHistorySetting: titan.Setting<string> = this.stringSetting({
        key: 'abortHistory',
        name: 'Abort history (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Account roster setting (visible) ---
    // Comma-separated list of character names to rotate through. When 2+
    // names are listed, the bot rotates between accounts: each account runs
    // the full auto-merch loop until idle, logs out, and the next eligible
    // account logs in. Each account's sleep/wake schedule comes from its
    // own SessionProfile. When empty or a single name, the bot behaves as
    // a single-account bot (no rotation).
    accountRosterSetting: titan.Setting<string> = this.stringSetting({
        key: 'accountRoster',
        name: 'Account Roster',
        default: '',
        tooltip: 'Comma-separated character names to rotate through. Each account runs until idle, then the next eligible account logs in. Leave empty for single-account mode.',
        position: -1,
    });

    // --- Profit display setting (visible, read-only) ---
    // Shows each account's net profit (sum of all completed merch cycles'
    // profits minus losses) as a human-readable string. Updated after each
    // completed sale (via updateProfitDisplay() in general/dump.ts) and on
    // logout — never per-tick, so there is no performance impact. This
    // ensures the display stays current when idle activity keeps the bot
    // logged in for long periods without a logout. The setting is written
    // by the bot and read by the user; editing it has no effect (the bot
    // overwrites it on the next completed sale or logout). Format:
    // "Name1: +1,234gp, Name2: -567gp".
    profitDisplaySetting: titan.Setting<string> = this.stringSetting({
        key: 'profitDisplay',
        name: 'Profit (all accounts)',
        default: '',
        tooltip: 'Net profit per account (profits minus losses across all completed merch cycles). Updated automatically on each logout.',
        position: -0.5,
    });

    // --- Hidden rotation index setting ---
    // Stores the current rotation index (which account in the roster to
    // check next). Persisted so it survives hot reloads. Same persistence
    // limitation as offerCacheSetting — hot reload only.
    rotationIndexSetting: titan.Setting<string> = this.stringSetting({
        key: 'rotationIndex',
        name: 'Rotation index (hidden)',
        default: '0',
        hidden: true,
    });

    // --- Hidden account break state setting ---
    // Stores per-account break state as JSON: { accountName: { lastLogoutAtMs,
    // minBreakDurationMs } }. Used by the rotation system to determine if an
    // account's minimum break has lapsed before logging it back in. Same
    // persistence limitation as offerCacheSetting — hot reload only.
    accountBreakStateSetting: titan.Setting<string> = this.stringSetting({
        key: 'accountBreakState',
        name: 'Account break state (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Overlay HUD registration ---
    // Minimal overlay: draws one rect + one text line showing the current
    // autoMode label (Paused / Normal / Slow / F2P). The render callback
    // fires every frame but does no allocations, no Date.now(), no native
    // SDK reads — it reads the plain-JS overlayStatusText field (updated
    // only in onEnable / onDisable / onSettingChanged) and makes two
    // overlay draw calls. The showHud toggle lets the user hide the HUD
    // without disabling the plugin; the render callback returns early
    // when showHudValue is false.
    hud = this.overlay({
        layer: 'AboveWidgets',
        render: () => {
            if (!this.isHudActive || !this.showHudValue) return;
            renderBotOverlay(this);
        },
    });

    // --- End Logout button ---
    // Forwards the break timer to 0s so the bot logs back in immediately
    // instead of waiting for the break to end naturally. Useful for
    // manually resuming during a short break or nightly sleep.
    endLogout: titan.Setting<void> = this.buttonSetting({
        key: 'endLogout',
        name: 'End Logout',
        position: 0,
        tooltip: 'Forwards the break timer to 0s — logs back in immediately.',
        onClick: () => {
            if (this.breakPhase === 'logged_out' || this.breakPhase === 'logging_out') {
                this.breakTargetEndMs = Date.now();
                saveBreakState(this);
                if (this.logInfoValue) titan.log('[Stark Mercher] End Logout clicked — break timer forwarded to now, logging back in next tick.');
            } else {
                if (this.logInfoValue) titan.logf('[Stark Mercher] End Logout clicked — not in a break (phase=%s), nothing to do.', this.breakPhase);
            }
        },
    });

    // --- Paused / Normal / Slow / F2P mode toggle ---
    // 0 = Paused (no script logic runs at all — no login, breaks, hops, or
    //   merching. The overlay still renders so the user can switch modes.)
    // 1 = Normal (run the full automated merching loop: login, breaks,
    //   hops, GE actions. Buy scan uses the default non-lowball-first
    //   tier order.)
    // 2 = Slow (same loop as Normal, but the buy scan prefers lowball
    //   items with ~30-60 minute buy ETAs ahead of the normal tier order.
    //   Login/logout/break/rotation/hop timing is unchanged — only buy-
    //   offer item selection is affected.)
    // 3 = F2P (same loop as Normal, but reads f2pMerchableItems.json
    //   instead of merchableItems.json. Uses a curated list of high-volume
    //   F2P items with a fixed 1gp margin. Runtime thresholds are relaxed
    //   so thin-margin items pass. Slot count still uses isMembersWorld()
    //   — 3 slots on F2P worlds, 8 on P2P.)
    // Persists across hot reloads. New clients default to Paused so the bot
    // doesn't start merching until the user explicitly switches to Normal,
    // Slow, or F2P.
    autoMode: titan.Setting<number> = this.comboSetting({
        key: 'autoMode',
        name: 'Mode',
        default: 0,
        choices: [
            { value: 0, label: 'Paused' },
            { value: 1, label: 'Normal' },
            { value: 2, label: 'Slow' },
            { value: 3, label: 'F2P' },
        ],
    });

    // --- Idle Activity dropdown ---
    // When the bot has no GE actions to process and would normally log out
    // for a short break, it instead performs an idle activity to stay logged
    // in productively. The bot banks any idle-activity items and resumes GE
    // mode as soon as the next GE action is due. If the bank runs out of
    // idle-activity items, the bot resumes normal logout behavior.
    // 0 = None (normal logout-on-idle behavior)
    // 1 = Chocolate Dust (grind chocolate bars into chocolate dust with a knife)
    // 2 = Ultra Compost (use volcanic ash on supercompost to make ultracompost)
    // 3 = Goat Horn Dust (grind desert goat horns into goat horn dust with a pestle and mortar)
    // 4 = Any (search the bank for ingredients of all three activities and randomly pick one)
    idleActivity: titan.Setting<number> = this.comboSetting({
        key: 'idleActivity',
        name: 'Idle Activity',
        default: 0,
        choices: [
            { value: 0, label: 'None' },
            { value: 1, label: 'Chocolate Dust' },
            { value: 2, label: 'Ultra Compost' },
            { value: 3, label: 'Goat Horn Dust' },
            { value: 4, label: 'Any' },
        ],
    });

    // --- Log cache data button ---
    // Click to dump the current account's offer cache to the log. Shows
    // cached buy/sell prices, revision history, buy-limit state, net profit
    // projection after GE tax, cached ETAs, sell confirmation status,
    // partial sales summary, and elapsed time since placement.
    logCacheData: titan.Setting<void> = this.buttonSetting({
        key: 'logCacheData',
        name: 'Log Cache Data',
        position: -1,
        onClick: () => {
            const accountName = this.currentPlayerName || '';
            if (!accountName) {
                titan.log('[Stark Mercher] Cannot log cache — no account name available.');
                return;
            }
            dumpOfferCache(this, accountName);
        },
    });

    // --- Log merch history button ---
    // Click to dump the merch history (profits and losses) and abort history
    // to the log. Shows completed merch cycles with item, qty, profit/loss,
    // avg sell price, buy price, revision count, revision prices, sell
    // elapsed time, and requested vs actual bought qty. Also shows aborted
    // offers with reason, elapsed vs ETA, and fill rate.
    logMerchHistory: titan.Setting<void> = this.buttonSetting({
        key: 'logMerchHistory',
        name: 'Log Merch & Abort History',
        position: -1,
        onClick: () => {
            const accountName = this.currentPlayerName || '';
            if (!accountName) {
                titan.log('[Stark Mercher] Cannot log history — no account name available.');
                return;
            }
            dumpMerchHistory(this, accountName);
            dumpAbortHistory(this, accountName);
        },
    });

    // --- Log buy freezes button ---
    // Click to dump the current buy-freeze state to the log. Shows which
    // items are frozen from buying, when each freeze expires, and how many
    // minutes remain. Useful for verifying freezes are applied after stale
    // buy aborts and that they expire correctly.
    logBuyFreezes: titan.Setting<void> = this.buttonSetting({
        key: 'logBuyFreezes',
        name: 'Log Buy Freezes',
        position: -1,
        onClick: () => {
            dumpBuyFreezes(this);
        },
    });

    // --- Overlay HUD toggle ---
    showHud: titan.Setting<boolean> = this.boolSetting({
        key: 'showHud',
        name: 'Show HUD',
        default: true,
        tooltip: 'Toggle the on-screen overlay panel. Disable to test if the overlay is causing FPS drops.',
    });

    // --- Debug logging toggle ---
    logDebug: titan.Setting<boolean> = this.boolSetting({
        key: 'logDebug',
        name: 'Debug logging',
        default: false,
    });

    // --- Info logging toggle ---
    // Important, uncommon events: account rotation, break start/end, login/logout,
    // world hops, offer placement/failure, cache reconciliation, item freezing,
    // repricing, startup audit, mode switched, termination. When off, only errors
    // and manual button-triggered dumps are logged. When on, these events are
    // logged regardless of the Debug logging toggle.
    logInfo: titan.Setting<boolean> = this.boolSetting({
        key: 'logInfo',
        name: 'Info logging',
        default: true,
    });

    // --- World hop settings ---
    hopWorlds: titan.Setting<boolean> = this.boolSetting({
        key: 'hopWorlds',
        name: 'Hop Worlds',
        default: true,
        tooltip: 'When disabled, the bot will not perform world hops.',
        position: -1,
    });

    // --- Do Not Sleep setting ---
    // When enabled, the bot will never take a nightly sleep break. Short
    // breaks still occur. Useful for 24/7 test accounts.
    doNotSleep: titan.Setting<boolean> = this.boolSetting({
        key: 'doNotSleep',
        name: 'Do Not Sleep',
        default: false,
        tooltip: 'When enabled, the bot will never take a nightly sleep break. Short breaks still occur. Useful for 24/7 test accounts.',
        position: -1,
    });

    hopRegion: titan.Setting<number> = this.comboSetting({
        key: 'hopRegion',
        name: 'Hop Region',
        default: 0,
        tooltip: 'Restrict world hops to a specific region. Any uses all safe members worlds.',
        position: -1,
        choices: [
            { value: 0, label: 'Any' },
            { value: 1, label: 'UK' },
            { value: 2, label: 'Germany' },
            { value: 3, label: 'US' },
        ],
    });

    resetHop: titan.Setting<void> = this.buttonSetting({
        key: 'resetHop',
        name: 'Reset Hop',
        position: -1,
        onClick: () => { resetHop(this); },
    });

    forceHop: titan.Setting<void> = this.buttonSetting({
        key: 'forceHop',
        name: 'Force Hop',
        position: -1,
        tooltip: 'Forces the next hop to become due. The hop still waits for a safe boundary.',
        onClick: () => { forceHop(this); },
    });

    // runStartupAudit()
    // Called on the first tick after enable (or after a tick-reset), but only
    // when in Normal or Slow mode (Paused mode returns before the audit runs).
    // Audits the GE state and logs active slots for visibility. If a GE
    // sub-screen (offer config / search / quantity / price prompt) is open
    // after a hot-reload, sends a one-time Escape to close it — the auto-loop
    // then reopens the GE and starts fresh flows. This is simpler and more
    // robust than reconstructing in-flight flow state from cache entries,
    // which was prone to stuck loops when the post-Escape widget state didn't
    // match the reconstructed flow's expectations.
    runStartupAudit() {
        const audit = auditGeState();
        if (this.logInfoValue) titan.logf('[Stark Mercher] Startup audit: screen=%s, geOpen=%s, slots=%s',
            audit.screen, audit.geOpen, audit.slots.map(s => s.type).join(','));

        if (!audit.geOpen) {
            // GE not open — nothing to resume. Idle.
            return;
        }

        // Check if any slot has an active offer — log it for visibility.
        for (let i = 0; i < audit.slots.length; i++) {
            const s = audit.slots[i];
            if (s.type === 'buy' || s.type === 'sell') {
                if (this.logInfoValue) titan.logf('[Stark Mercher] Slot %d: %s %s (qty %d, %s)',
                    i + 1, s.type, s.itemName ?? 'unknown', s.itemQuantity, s.priceText ?? 'no price');
            }
        }

        // If a GE sub-screen is open (offer config / search / quantity /
        // price prompt), send a one-time Escape to close it. The auto-loop
        // will then reopen the GE and start fresh flows. Interrupted buys
        // lost nothing (no items spent); interrupted sells still have their
        // items in inventory (the sell scan re-lists them); already-placed
        // offers in GE slots are unaffected.
        if (isOfferConfigOpen() || isSearchPromptShown() || isQuantityPromptShown() || isPricePromptShown()) {
            if (this.logInfoValue) titan.log('[Stark Mercher] Startup audit: GE sub-screen open — sending Escape to close (auto-loop will start fresh)');
            sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Escape), { reason: 'startup close GE sub-screen' });
        }
    }

    onEnable() {
        onEnable(this);
        this.isHudActive = true;
        // Cache the setting values so per-frame callbacks (onMainLoop, overlay
        // render) read plain JS fields instead of crossing the JS<->native
        // boundary via Setting.value every frame.
        this.autoModeValue = this.autoMode.value;
        this.showHudValue = this.showHud.value;
        this.hopWorldsValue = this.hopWorlds.value;
        this.idleActivityValue = this.idleActivity?.value ?? 0;
        this.doNotSleepValue = !!this.doNotSleep?.value;
        this.logInfoValue = !!this.logInfo.value;
        this.logDebugValue = !!this.logDebug.value;
        this.statusText = this.autoModeValue === 0 ? 'Paused' : 'Idle';
        this.overlayStatusText = modeLabel(this.autoModeValue);
        // Derive the UK-formatted start time from scriptStartMs, which is
        // already persisted via scriptStartSetting (hidden, hot-reload only).
        // This survives hot reloads (setting persists → same time) and resets
        // on full client restart (hidden setting doesn't persist → fresh time)
        // and on terminate() (setting cleared → fresh time). formatUKTime is
        // pure JS — one call per onEnable is negligible.
        this.sessionStartUKTime = formatUKTime(this.scriptStartMs);
        // Cache the login state so onMainLoop (frame-rate) can skip wallClockStep
        // entirely when logged in without reading titan.state.login.isLoggedIn
        // every frame. One native scalar read on enable is negligible.
        this.cachedIsLoggedIn = titan.state.login.isLoggedIn;
    }
    onDisable() {
        this.isHudActive = false;
        this.statusText = 'Stopped';
        this.overlayStatusText = 'Stopped';
        if (this.terminated && this.terminationReason) {
            if (this.logInfoValue) titan.logf("[Stark Mercher] Stopped: %s", this.terminationReason);
        }
        // Release native handles held in module-level caches. The JS module
        // is NOT re-evaluated on a toggle off/on (only on hot reload), so
        // module-level state — including cached native WidgetState/Item/Player
        // handles — survives the toggle. Without invalidation here, stale
        // handles from the previous run accumulate alongside new handles
        // created by the next onEnable, gradually exhausting the finite
        // native handle table over many toggle cycles.
        invalidateGeWidgetCache();
        invalidateInvCache();
        invalidateBooleanStateCache();
        invalidateMembersWorldCache();
        invalidateNearGeCache();
        // Invalidate the cached entity queries (GE clerks, GE booths, logout
        // door) and the cached world list — the scene may change on the next
        // enable (e.g. after a hop or login on a different world).
        invalidateEntityQueryCache();
        invalidateLogoutDoorCache();
        invalidateWorldListCache();
        // Reset module-level throttles and caches so the next onEnable starts
        // fresh — no stale throttle timestamps, no stale login snapshots,
        // no retained local-player handle.
        resetLoginThrottle();
        resetLoginSnapshotCache();
        resetClickJitter();
        resetLocalPlayerCache();
        // Invalidate the rotation and session-profile caches so the next
        // onEnable re-reads the settings fresh (the JS module is not
        // re-evaluated on toggle, so cached parsed-JSON survives otherwise).
        invalidateRotationCaches();
        invalidateSessionProfileCache();
    }
    onSettingChanged(key: string) {
        // Keep the per-frame cached mirrors in sync with the underlying
        // settings. Both autoMode and showHud are read from high-frequency
        // callbacks (onMainLoop, overlay render); the cached plain fields
        // avoid crossing the JS<->native boundary via Setting.value every
        // frame.
        if (key === 'autoMode') {
            this.autoModeValue = this.autoMode.value;
            this.overlayStatusText = modeLabel(this.autoModeValue);
        } else if (key === 'showHud') {
            this.showHudValue = this.showHud.value;
        } else if (key === 'hopWorlds') {
            this.hopWorldsValue = this.hopWorlds.value;
        } else if (key === 'idleActivity') {
            this.idleActivityValue = this.idleActivity?.value ?? 0;
        } else if (key === 'doNotSleep') {
            this.doNotSleepValue = !!this.doNotSleep?.value;
        } else if (key === 'logInfo') {
            this.logInfoValue = !!this.logInfo.value;
        } else if (key === 'logDebug') {
            this.logDebugValue = !!this.logDebug.value;
        }
        // When Mode is switched, update the status text and re-run the startup
        // audit on the next tick so the auto-loop reconciles from current GE
        // state (the audit is skipped while Paused, so switching to Normal or
        // Slow needs it to run).
        if (key === 'autoMode') {
            if (this.autoModeValue === 0) {
                this.statusText = 'Paused';
                if (this.logInfoValue) titan.log('[Stark Mercher] Mode switched to Paused — all script logic stopped.');
            } else {
                this.statusText = 'Idle';
                this.startupAuditDone = false;
                this.startupAuditDeferredLogged = false;
                const modeLabel = this.autoModeValue === 3 ? 'F2P' : this.autoModeValue === 2 ? 'Slow' : 'Normal';
                if (this.logInfoValue) titan.logf('[Stark Mercher] Mode switched to %s — resuming on next tick.', modeLabel);
            }
        }
        // When Do Not Sleep is toggled ON, clear any pre-sampled nightly break
        // planning so the next break is sampled as a short break, not a
        // nightly break with a stale duration. The breakStep() and logged-out
        // paths in session.ts also check doNotSleep to abort an already-started
        // nightly break.
        if (key === 'doNotSleep' && this.doNotSleepValue) {
            this.nightlyBreakTargetTime = -1;
            this.nightlySleepMinutes = -1;
        }
        // Invalidate the roster cache when the user edits the roster setting.
        // The break-state and session-profile caches are invalidated on writes
        // (save/clear) and on onDisable, so they don't need onSettingChanged.
        if (key === 'accountRoster') {
            invalidateRotationCaches();
        }
    }
    onMenuOptionClicked = (event: titan.MenuOptionClicked) => {
        // Diagnostic-only click logging. Gated by terminated/autoMode/logDebug
        // to avoid an unconditional titan.logf native call per click — the
        // bot's own synthetic clicks (interact()) fire this handler too, so
        // during active merching this would otherwise emit dozens of native
        // log calls per minute. Mixology has no equivalent handler.
        if (this.terminated) return;
        if (this.autoModeValue === 0) return;
        if (!this.logDebugValue) return;
        titan.logf("[Stark Mercher] Click: opcode=%d id=%d p0=%d p1=%d text=%s",
            event.opcode, event.identifier, event.param0, event.param1, event.actionText);
    }
    onGameTick = (tick: number) => {
        if (this.terminated) return;

        // onGameTick only fires when logged in — defensively cache the login
        // state so onMainLoop can skip wallClockStep without a per-frame
        // native read. onGameStateChanged also sets this, but this covers
        // the case where the plugin starts while already logged in (no
        // state change event fires).
        this.cachedIsLoggedIn = true;

        // Paused mode: no script logic runs at all. The overlay still renders
        // (it's a separate render callback) so the user can see the status and
        // switch to Normal or Slow.
        if (this.autoModeValue === 0) return;
        // Duplicate-tick guard: the SDK can fire onGameTick more than once
        // per tick in some edge cases.
        if (this.lastActionTick === tick) return;

        // Client tick counter went backwards (disconnect/relogin/world hop
        // that involved a logout/login cycle). Reset stale action state so
        // canPerformAction doesn't lock forever on a negative ticksSinceAction.
        if (this.lastActionTick > tick && this.lastActionTick !== -1) {
            if (this.logInfoValue) titan.log('[Stark Mercher] Tick counter reset — resetting stale action state');
            this.currentAction = 'idle';
            this.actionStartTime = tick;
            this.actionDelay = 0;
            this.lastAction = 'idle';
            this.lastActionTime = tick;
            // Re-run the startup audit since the flow may have been interrupted.
            this.startupAuditDone = false;
            this.startupAuditDeferredLogged = false;
            // Clear any in-flight auto-loop flows (they hold tick-based state
            // that is now stale). The cache handle is preserved — it reads
            // from the hidden setting which is not tick-based.
            this.autoLoop.activeBuyFlow = null;
            this.autoLoop.activeSellFlow = null;
            this.autoLoop.activeAbortFlow = null;
            this.autoLoop.abortSlotInfo = null;
            this.autoLoop.phase = 'idle';
            this.autoLoop.sellAttemptedItems.clear();
            this.autoLoop.buyAttemptedItems.clear();
            this.autoLoop.cacheReconciled = false;
            this.autoLoop.needsPostLoginCleanup = true;
            // Reset the GE-open wall-clock cooldown so the first GE-open
            // click after a tick reset goes through immediately.
            this.autoLoop.lastGeOpenDispatchMs = 0;
            // Reset the collect wall-clock cooldown for the same reason.
            this.autoLoop.lastCollectDispatchMs = 0;
            // Clear idle-for-break flags — the auto-loop's idle state from
            // before the disconnect is no longer valid.
            this.loopIdleForBreak = false;
            this.loopIdleSinceTick = -1;
            this.shortBreakDelayTicks = -1;
            this.nextActionEtaMin = -1;
            this.lastIdleDiagTick = -1;
            // NOTE: checkedAtHalfEta is NOT reset here — it survives
            // disconnects (see resetInFlightActionState in state.ts).
            // Invalidate cross-tick caches — the tick counter reset means
            // all cached widget/inventory state is from a previous session.
            invalidateGeWidgetCache();
            invalidateInvCache();
            // Invalidate the cached entity queries and world list — the
            // scene reloaded on the disconnect/relogin/world hop.
            invalidateEntityQueryCache();
            invalidateLogoutDoorCache();
            invalidateWorldListCache();
        }

        // --- Startup audit ---
        // On the first tick after enable (or after a tick-reset), audit the
        // GE state to determine if a buy-offer flow was in progress. If the
        // audit finds a recoverable state, resume the flow.
        // Defer the audit if the player is on the title screen or settling
        // after login — the GE state is not meaningful until the player is
        // in-world. We check the title widget directly (via isTitleScreenVisible)
        // because the login FSM may not have set titleFirstSeenAtMs yet on the
        // very first tick after a reload. We also check the login FSM state
        // variables (titleWaitingForGone, postLoginResumeAtMs) for the settle
        // phase after the title click. The audit runs on the first tick after
        // all of these clear.
        if (!this.startupAuditDone) {
            if (isTitleScreenVisible(this) || this.titleWaitingForGone || this.postLoginResumeAtMs > 0) {
                // Player is on title screen or settling — defer audit to next tick.
                // Logged only once to avoid spam.
                if (!this.startupAuditDeferredLogged) {
                    this.startupAuditDeferredLogged = true;
                    if (this.logInfoValue) titan.log('[Stark Mercher] Startup audit deferred — title screen / login settle in progress');
                }
            } else {
                this.startupAuditDone = true;
                this.runStartupAudit();
            }
        }

        // Run the auto-merch tick logic. (Only reached in Normal or Slow mode —
        // Paused mode returns at the top of onGameTick.)
        try {
            gameTick(this, tick);
        } catch (e) {
            terminate(this, `onGameTick error: ${String(e)}`);
        }
        this.lastActionTick = tick;
    };

    // onMainLoop fires even on login/title screens — this is where we
    // dispatch login/logout while the player is logged out. Skipped entirely
    // in Paused mode (no login, no break timer, no logout).
    onMainLoop = () => {
        if (this.terminated) return;
        if (this.autoModeValue === 0) return;
        try {
            // Render-loop diagnostic (per Titan dev recommendation): log the
            // client tick every 30s. If the tick freezes when FPS hits 0, the
            // client's main loop is stalled (native handle exhaustion). If it
            // keeps advancing, the loop is running but slow (GC pressure).
            // Date.now() is pure JS (no native call); the tick read is one
            // native call per 30s — negligible.
            const now = Date.now();
            if (this.logInfoValue && now - this.lastDiagLogMs >= 30000) {
                this.lastDiagLogMs = now;
                titan.logf('[Stark Mercher] diag: clientTick=%d', titan.state.client.tick);
            }
            // wallClockStep is all logged-out logic (break transitions, rotation,
            // login step, account detection). When logged in, onGameTick handles
            // everything — skip the function call entirely. Uses the cached
            // plain-JS cachedIsLoggedIn field (no per-frame native read) updated
            // in onEnable, onGameStateChanged, and onGameTick.
            if (!this.cachedIsLoggedIn) {
                wallClockStep(this);
            }
        } catch (e) {
            titan.logf('[Stark Mercher] onMainLoop error: %s', String(e));
        }
    };

    // onGameStateChanged — detect unexpected logouts, nightly wake, and hop completion.
    // Skipped in Paused mode — no logout detection, no nightly wake, no hop completion.
    onGameStateChanged = (event: titan.GameStateChangedEvent) => {
        if (this.terminated) return;
        if (this.autoModeValue === 0) return;
        // Cache the login state so onMainLoop can skip wallClockStep when
        // logged in without a per-frame native read.
        this.cachedIsLoggedIn = event.newState === titan.LoginGameState.LoggedIn;
        // Invalidate the cached isMembersWorld() result on any login state
        // change — covers hop, break logout/login, unexpected logout/login,
        // and account rotation. The world may have changed (or the player
        // may be on a different world after logging back in).
        invalidateMembersWorldCache();
        // Invalidate cross-tick caches on any login state change — covers
        // hop, break logout/login, unexpected logout/login, and account
        // rotation. Widget and inventory state from the previous world/session
        // is no longer valid.
        invalidateGeWidgetCache();
        invalidateBooleanStateCache();
        invalidateInvCache();
        // Invalidate the cached entity queries (GE clerks, GE booths, logout
        // door) and the cached world list — the scene reloaded on the login
        // state change (hop, break logout/login, unexpected logout/login,
        // account rotation).
        invalidateEntityQueryCache();
        invalidateLogoutDoorCache();
        invalidateWorldListCache();
        // Detect unexpected logout (not a bot-initiated break)
        if (event.newState !== titan.LoginGameState.LoggedIn &&
            event.newState !== titan.LoginGameState.HoppingWorld &&
            this.breakPhase === 'none') {
            if (this.unexpectedLogoutAtMs === 0) {
                this.unexpectedLogoutAtMs = Date.now();
                if (this.logInfoValue) titan.logf('[Stark Mercher] Unexpected logout detected (gameState=%s)', String(event.newState));
                saveBreakState(this);
            }
        }
        // When logged back in after a nightly break, mark it as finished
        if (event.newState === titan.LoginGameState.LoggedIn && this.breakType === 'nightly') {
            markNightlyBreakFinished(this);
        }
        // Drive hop completion from game state changes too
        if (this.hopInProgress) {
            if (event.newState !== titan.LoginGameState.LoggedIn) {
                this.hopSawLoggedOut = true;
            }
            completeHop(this, titan.state.client.tick);
        }
    };

    // onChatMessage — listen for world switcher rejection messages.
    // Skipped in Paused mode.
    onChatMessage = (event: titan.ChatMessageEvent) => {
        if (this.terminated) return;
        if (this.autoModeValue === 0) return;
        // Strip tags unconditionally so the GE completion check below can
        // run regardless of the logDebug setting. The debug log also uses
        // this stripped text.
        const stripped = (event.message || '').replace(/<[^>]+>/g, '');
        if (this.logDebugValue) {
            titan.logf("[Stark Mercher] Chat: type=%d name=%s msg=%s",
                event.type, event.name || '', stripped);
        }
        // Detect GE offer completions while an idle activity is active.
        // "Grand Exchange: Finished buying X" / "Finished selling X" fires
        // as a game message (type 0, empty name). When the bot is grinding
        // an idle activity, the ETA-based timer may not have expired yet,
        // but the bot should yield to GE operations immediately so it can
        // collect, sell, and place new offers without delay. The
        // idleActivityPhase guard prevents stale flags during normal GE
        // operation (where completions are handled by the collect/sweep
        // flows).
        if (this.autoLoop.idleActivityPhase !== 'none'
            && stripped.startsWith('Grand Exchange: Finished')) {
            this.geOfferCompletedChatMs = Date.now();
        }
        onHopChatMessage(this, event);
    };
}
titan.register(new StarkMercher());

const gameTick = (bot: StarkMercher, tick: number) => {
    tickLogic(bot, tick);
};

const tickLogic = (bot: StarkMercher, tick: number) => {
    // Auto-correct any state that has outlived the event that set it.
    sanityCheckState(bot, tick);

    // Break/login/logout handling — returns true when the normal auto-loop
    // should be skipped (during logout, while waiting to log out, or while
    // waiting to log back in). Manual test buttons still run below when
    // breakStep returns false.
    if (breakStep(bot, tick)) return;

    // World hop handling — returns true when a hop is in progress or being
    // dispatched, pausing the auto-loop. Also drives hop completion.
    if (hopStep(bot, tick)) return;

    // Post-hop resume delay — wait a few seconds after arriving in the new
    // world before resuming the auto-loop, so the client has time to settle.
    if (bot.hopResumeAtMs > 0 && Date.now() < bot.hopResumeAtMs) return;
    if (bot.hopResumeAtMs > 0 && Date.now() >= bot.hopResumeAtMs) {
        bot.hopResumeAtMs = -1;
    }

    // Post-login settle delay — after the title screen disappears, login.ts
    // sets postLoginResumeAtMs to now + createDelay(2, 50) ticks. This blocks
    // tickLogic until the humanised settle delay elapses, giving the client
    // time to render the world and clear any promo/overlay widgets. Uses a
    // wall-clock timestamp (not setAction) because the tick counter resets
    // on the first tick after login, which would wipe an action-based delay.
    //
    // After the title click, postLoginResumeAtMs is set to MAX_SAFE_INTEGER
    // to block until the title screen disappears. loginStep() (called from
    // breakStep while logged out) detects the title disappearing and sets
    // the real settle timestamp. But after an unexpected logout, breakStep
    // stops calling loginStep once the player is in-world. So we call
    // loginStep here to ensure the title disappearance is detected.
    if (bot.postLoginResumeAtMs > 0) {
        if (Date.now() < bot.postLoginResumeAtMs) {
            // Still waiting. If we're waiting for the title screen to
            // disappear, call loginStep to check and set the real settle.
            if (bot.titleWaitingForGone) {
                loginStep(bot);
            }
            return;
        }
        bot.postLoginResumeAtMs = -1;
        bot.loginSettled = true;
        bot.autoLoop.needsPostLoginCleanup = true;
        // Reset failure counters — the login transition can cause false
        // strikes (e.g. GE not openable while the world is still loading).
        bot.autoLoop.failureCounters = {};
        bot.inventoryOpenEnsured = false;
        if (bot.logInfoValue) titan.log('[Stark Mercher] Post-login settle complete — resuming');
    }

    // After a hop or login, make sure the inventory tab is open before
    // running the auto-loop. The world switcher can stay open after
    // hopIngame() completes, and interacting with widgets (GE slots,
    // inventory items) while it is still visible can trigger native null
    // exceptions that auto-disable the plugin. Adapted from stark-mixology.
    //
    // CRITICAL: do NOT send Escape or click the inventory tab while the
    // GE or bank interface is open. Escape closes both, and clicking the
    // inventory tab also closes the GE. Both interfaces have their own
    // inventory view, so neither action is needed while they are open.
    if (!bot.hopInProgress) {
        if (isGeOpen() || isBankOpen()) {
            // GE or bank has its own inventory view — nothing to do.
            bot.inventoryOpenEnsured = true;
        } else if (isWorldSwitcherOpenCached()) {
            if (tick % 5 === 0) {
                if (bot.logDebugValue) titan.log('[Stark Mercher] World switcher still open after hop; closing with Escape');
            }
            sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Escape), { reason: 'close world switcher' });
            return;
        } else {
            // Send Escape once before opening the inventory to close any
            // lingering full-screen interface. Gated on !inventoryOpenEnsured
            // so it only fires once per hop/login.
            if (!bot.inventoryOpenEnsured && !isInventoryOpen()) {
                sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Escape), { reason: 'open inventory (escape)' });
            }
            const opened = ensureInventoryOpen(bot);
            if (opened) {
                bot.inventoryOpenEnsured = true;
                // Skip the rest of this tick so the inventory click is
                // separated from any action.
                return;
            }
            if (isInventoryOpen()) {
                bot.inventoryOpenEnsured = true;
            }
        }
    }

    // Pause new actions while a hop or break is pending (waiting for a safe
    // boundary to dispatch). This prevents starting a new GE flow right
    // before a hop is about to fire.
    if (shouldPauseForHopBoundary(bot)) return;

    // Throttle: block dispatch while the previous action's delay is pending.
    if (shouldWait(bot)) {
        // Log "Delaying X ticks" once per action (when debug logging is on).
        // This helps evaluate humanisation delays from logs — without it, only
        // the total delay is logged at setAction time, and you can't tell
        // whether the bot is actually waiting through it or stuck.
        if (!bot.delayLogShown && bot.logDebugValue && bot.currentAction && bot.currentAction !== 'idle') {
            const ticksSinceAction = tick - bot.actionStartTime;
            const remaining = Math.max(0, bot.actionDelay - ticksSinceAction);
            if (remaining > 0) {
                titan.logf('[Stark Mercher] Delaying %dt (%s, %dt elapsed of %dt)',
                    remaining, bot.currentAction, ticksSinceAction, bot.actionDelay);
            }
            bot.delayLogShown = true;
        }
        return;
    }

    // --- Auto-merch loop ---
    // Run the automated merching loop. The loop handles: GE-open check,
    // collect, stale offers, selling, and buying. (Pausing is handled by the
    // early return at the top of onGameTick, so we only get here in Normal or Slow.)
    autoLoopTick(bot, tick);
};
