/// <reference path="./titan-plugin-sdk.d.ts" />
import { debug } from './general/debug.js';
import { onEnable, terminate } from './general/lifecycle.js';
import { shouldWait } from './general/timing.js';
import { sanityCheckState } from './general/state.js';
import { auditGeState } from './grand_exchange/widgets.js';
import { autoLoopTick, createAutoLoopState, resetAutoLoop, type AutoLoopState } from './grand_exchange/auto-loop.js';
import { breakStep, wallClockStep, resetBreakState, saveBreakState, initSessionProfile, markNightlyBreakFinished, resetHop, forceHop, shouldPauseForHopBoundary } from './antiban/session.js';
import { resetLoginState, loginStep } from './antiban/login.js';
import { resetLogoutState } from './antiban/logout.js';
import { hopStep, completeHop, onChatMessage as onHopChatMessage } from './antiban/hopper.js';
import { renderBotOverlay } from './widgets/bot-overlay.js';
import { loadOfferCache } from './general/state-persist.js';
import { getMerchHistory } from './data/merch-history.js';
import { getAbortHistory } from './data/abort-history.js';
import { getDailyProfit } from './data/daily-profit.js';
import type { SessionProfile } from './antiban/session-profile.js';

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
    // statusText is the human-readable top-level action string shown in the
    // overlay's Status field. Updated by the auto-loop and test flows.
    statusText = 'Stopped';

    // --- Cached values for overlay (avoid per-frame native queries) ---
    // The overlay renders every frame (30-60 FPS). Calling
    // titan.utils.inventory.count(995) or getDailyProfit() every frame
    // creates native query handles that accumulate and exhaust the finite
    // handle table over hours, causing FPS to drop to 0. These fields are
    // refreshed by the auto-loop (which already reads the coin count) and
    // by a fallback timer in onGameTick when the auto-loop isn't running.
    // -1 = not yet cached (overlay shows '-' until first refresh).
    cachedCoinCount = -1;
    cachedDailyProfit = 0;
    cachedDailyProfitAccount = '';
    /** Tick of the last overlay cache refresh. Used by the fallback timer
     *  in onGameTick to refresh every 30 ticks when the auto-loop isn't
     *  running (e.g. Paused mode, logged out, GE not open). */
    lastOverlayCacheRefreshTick = -999;

    // Action throttle state
    lastActionTick = -1;
    actionStartTime = 0;
    actionDelay = 0;
    currentAction: string | null = null;
    lastAction: string | null = null;
    lastActionTime = 0;

    // --- Startup audit ---
    // On script start (onEnable), we audit the GE state to determine if
    // a buy-offer flow was in progress. If recoverable, we resume it.
    // The audit runs once on the first tick after enable, not every tick.
    startupAuditDone = false;

    // --- Auto-merch loop state ---
    // When autoMode is enabled (Auto Merch), the bot runs the automated
    // merching loop: collect → stale → sell → buy. When disabled (Manual
    // Test), the bot idles and only responds to the test buttons.
    autoLoop: AutoLoopState = createAutoLoopState();

    // --- Break / login / logout state ---
    // The mercher takes short logout breaks (2-5 min) when the auto-loop
    // has nothing to do, plus a nightly sleep (3.5-6.5h). Both log the
    // player out; GE offers continue filling while logged out.
    breakPhase: 'none' | 'logging_out' | 'logged_out' | 'logging_in' = 'none';
    breakType: 'none' | 'short' | 'nightly' = 'none';
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
     *  with slow-filling offers. */
    checkedAtHalfEta = false;
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

    // --- Hidden session profile setting ---
    // Stores per-account session profiles as JSON (sleep/wake/break timing).
    // Keyed by "sessionProfile:<accountName>".
    sessionProfileSetting: titan.Setting<string> = this.stringSetting({
        key: 'sessionProfile',
        name: 'Session profile (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Offer cache setting (visible for manual backup) ---
    // Stores the per-account offer cache as JSON. Survives hot reloads
    // (plugin off/on within the same client session) but NOT client
    // restarts — Titan's host app does not persist hidden settings to
    // plugin_settings.json, and plugin-side .value writes are not marked
    // dirty for disk persistence. On client restart, the cache is empty
    // and must be reconstructed from live GE state (reverse reconciliation
    // in auto-loop.ts Step 2b). Hidden because the Titan settings UI truncates
    // string fields at 4095 chars and manual backup via the settings panel is
    // unreliable for larger caches.
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
    // Same persistence limitation as offerCacheSetting — hot reload only.
    dailyProfitSetting: titan.Setting<string> = this.stringSetting({
        key: 'dailyProfit',
        name: 'Daily profit (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Hidden hop state setting ---
    // Stores per-account hop timer state as JSON (nextHopAtMs, hopCount, etc.).
    // Same persistence limitation as offerCacheSetting — hot reload only.
    hopStateSetting: titan.Setting<string> = this.stringSetting({
        key: 'hopState',
        name: 'Hop state (hidden)',
        default: '{}',
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

    // --- Hidden merch history setting ---
    // Stores per-account merch history (profits and losses) as JSON.
    // Each entry records item, qty, profit/loss, date, buy price, avg sold
    // price, and revision count for a completed merch cycle.
    // Same persistence limitation as offerCacheSetting — hot reload only.
    // Hidden because the Titan settings UI truncates string fields at 4095
    // chars, and merch history exceeds that at ~60 entries — the UI field
    // can't display or edit the full value, so manual backup via the
    // settings panel doesn't work for this setting.
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

    // --- Abort history setting (hidden) ---
    // Stores per-account abort history as JSON. Each entry records an
    // aborted buy or sell offer: item, type, requested/filled qty, reason,
    // category ('eta', 'swap', or 'config'), elapsed minutes, original ETA,
    // price, and timestamp. This is the key diagnostic for low overnight
    // profit — aborted 0-fill buys represent wasted time and slot occupancy
    // that merch history doesn't capture.
    // Same persistence limitation as offerCacheSetting — hot reload only.
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
    // The overlay renders every frame while isHudActive is true. It draws
    // the Status, Inventory Coins, and Daily Profit fields.
    hud = this.overlay({
        layer: 'AboveWidgets',
        render: () => {
            if (!this.isHudActive) return;
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
                titan.log('[Stark Mercher] End Logout clicked — break timer forwarded to now, logging back in next tick.');
            } else {
                titan.logf('[Stark Mercher] End Logout clicked — not in a break (phase=%s), nothing to do.', this.breakPhase);
            }
        },
    });

    // --- Paused / Auto Merch mode toggle ---
    // 0 = Paused (no script logic runs at all — no login, breaks, hops, or
    //   merching. The overlay still renders so the user can switch modes.)
    // 1 = Auto Merch (run the full automated merching loop: login, breaks,
    //   hops, GE actions.)
    // Persists across hot reloads. New clients default to Paused so the bot
    // doesn't start merching until the user explicitly switches to Auto Merch.
    autoMode: titan.Setting<number> = this.comboSetting({
        key: 'autoMode',
        name: 'Mode',
        default: 0,
        choices: [
            { value: 0, label: 'Paused' },
            { value: 1, label: 'Auto Merch' },
        ],
    });

    // --- Log cache data button ---
    // Click to dump the current account's offer cache to the log. Useful for
    // debugging cached buy/sell prices, revision history, and buy-limit state.
    logCacheData: titan.Setting<void> = this.buttonSetting({
        key: 'logCacheData',
        name: 'Log Cache Data',
        position: -1,
        onClick: () => {
            const accountName = this.currentPlayerName || titan.state.client.localPlayer?.name || '';
            if (!accountName) {
                titan.log('[Stark Mercher] Cannot log cache — no account name available.');
                return;
            }
            const cache = loadOfferCache(this, accountName);
            const keys = Object.keys(cache);
            if (keys.length === 0) {
                titan.logf('[Stark Mercher] Offer cache for %s is empty.', accountName);
                return;
            }
            titan.logf('[Stark Mercher] Offer cache for %s (%d entries):', accountName, keys.length);
            for (const key of keys) {
                const e = cache[key];
                const placed = new Date(e.offerPlacedAt).toISOString();
                const revisions = e.revisedPrices.join(' -> ');
                const totalBought = e.totalBought !== undefined ? `, totalBought=${e.totalBought}` : '';
                const firstBought = e.firstBoughtAt !== undefined ? `, firstBought=${new Date(e.firstBoughtAt).toISOString()}` : '';
                const limitReached = e.limitReachedAt !== undefined ? `, limitReachedAt=${new Date(e.limitReachedAt).toISOString()}` : '';
                const sellQty = e.sellQuantity !== undefined ? `, sellQty=${e.sellQuantity}` : '';
                titan.logf('[Stark Mercher]   %s: mode=%s, buy=%d, sell=%d (orig=%d), placed=%s, revisions=[%s]%s%s%s%s',
                    key, e.mode, e.buyPrice, e.sellPrice, e.originalSellPrice, placed, revisions,
                    totalBought, firstBought, limitReached, sellQty);
            }
            titan.logf('[Stark Mercher] Cache dump complete (%d entries).', keys.length);
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
            const accountName = this.currentPlayerName || titan.state.client.localPlayer?.name || '';
            if (!accountName) {
                titan.log('[Stark Mercher] Cannot log history — no account name available.');
                return;
            }
            const history = getMerchHistory(this, accountName);
            if (history.profits.length === 0 && history.losses.length === 0) {
                titan.logf('[Stark Mercher] No merch history for %s.', accountName);
            } else {
                titan.logf('[Stark Mercher] Merch history for %s:', accountName);
                if (history.profits.length > 0) {
                    titan.logf('[Stark Mercher] === PROFITS (%d) ===', history.profits.length);
                    let totalProfit = 0;
                    for (const e of history.profits) {
                        const revPrices = e.revisionPrices ? `, revPrices=[${e.revisionPrices.join(',')}]` : '';
                        const sellTime = e.sellElapsedMin !== undefined ? `, sellElapsed=${e.sellElapsedMin}min` : '';
                        const reqVsActual = e.requestedBuyQty !== undefined ? `, reqBuy=${e.requestedBuyQty}` : '';
                        titan.logf('[Stark Mercher]   %s: qty=%d, profit=+%dgp, buy=%d, avgSold=%d, revisions=%d%s%s%s, date=%s',
                            e.item, e.qty, e.profit, e.buy, e.avgSold, e.revisions, reqVsActual, revPrices, sellTime, e.date);
                        totalProfit += e.profit;
                    }
                    titan.logf('[Stark Mercher]   Total profit: +%dgp', totalProfit);
                }
                if (history.losses.length > 0) {
                    titan.logf('[Stark Mercher] === LOSSES (%d) ===', history.losses.length);
                    let totalLoss = 0;
                    for (const e of history.losses) {
                        const revPrices = e.revisionPrices ? `, revPrices=[${e.revisionPrices.join(',')}]` : '';
                        const sellTime = e.sellElapsedMin !== undefined ? `, sellElapsed=${e.sellElapsedMin}min` : '';
                        const reqVsActual = e.requestedBuyQty !== undefined ? `, reqBuy=${e.requestedBuyQty}` : '';
                        titan.logf('[Stark Mercher]   %s: qty=%d, loss=%dgp, buy=%d, avgSold=%d, revisions=%d%s%s%s, date=%s',
                            e.item, e.qty, e.profit, e.buy, e.avgSold, e.revisions, reqVsActual, revPrices, sellTime, e.date);
                        totalLoss += e.profit;
                    }
                    titan.logf('[Stark Mercher]   Total loss: %dgp', totalLoss);
                }
                titan.logf('[Stark Mercher] Merch history dump complete.');
            }
            // Abort history
            const aborts = getAbortHistory(this, accountName);
            if (aborts.aborts.length === 0) {
                titan.logf('[Stark Mercher] No abort history for %s.', accountName);
            } else {
                titan.logf('[Stark Mercher] Abort history for %s (%d entries):', accountName, aborts.aborts.length);
                for (const a of aborts.aborts) {
                    const cat = a.category ?? 'unknown';
                    titan.logf('[Stark Mercher]   [%s] %s: %s req=%d filled=%d, elapsed=%s eta=%s, price=%d, reason="%s", date=%s',
                        cat, a.item, a.type, a.requestedQty, a.filledQty, a.elapsedMin.toFixed(1) + 'min', a.etaMin.toFixed(1) + 'min', a.price, a.reason, a.date);
                }
                titan.logf('[Stark Mercher] Abort history dump complete.');
            }
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
            const raw = this.buyFreezeSetting.value;
            if (!raw || raw === '{}') {
                titan.logf('[Stark Mercher] No buy freezes active.');
                return;
            }
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                titan.logf('[Stark Mercher] Failed to parse buy-freeze data: %s', String(e));
                return;
            }
            if (!parsed || typeof parsed !== 'object') {
                titan.logf('[Stark Mercher] No buy freezes active.');
                return;
            }
            const now = Date.now();
            // Support both flat ({ item: until }) and legacy nested
            // ({ account: { item: until } }) formats for diagnostics.
            const values = Object.values(parsed);
            const isNested = values.length > 0 && values.every(v => v !== null && typeof v === 'object');
            let flat: Record<string, number>;
            if (isNested) {
                // Flatten legacy nested format for display.
                flat = {};
                for (const accountMap of values as Record<string, number>[]) {
                    if (!accountMap || typeof accountMap !== 'object') continue;
                    for (const [name, until] of Object.entries(accountMap)) {
                        if (typeof until !== 'number') continue;
                        const existing = flat[name];
                        if (!existing || until > existing) flat[name] = until;
                    }
                }
            } else {
                flat = parsed as Record<string, number>;
            }
            const items = Object.keys(flat);
            if (items.length === 0) {
                titan.logf('[Stark Mercher] No buy freezes active.');
                return;
            }
            const active = items.filter(name => flat[name] > now);
            const expired = items.length - active.length;
            titan.logf('[Stark Mercher] Buy freezes (%d active, %d expired):', active.length, expired);
            for (const name of active) {
                const until = flat[name];
                const minsLeft = Math.max(0, Math.ceil((until - now) / 60000));
                titan.logf('[Stark Mercher]   %s: expires in %d min (at %s)', name, minsLeft, new Date(until).toISOString());
            }
            titan.logf('[Stark Mercher] Buy freeze dump complete.');
        },
    });

    // --- Debug logging toggle ---
    logDebug: titan.Setting<boolean> = this.boolSetting({
        key: 'logDebug',
        name: 'Debug logging',
        default: false,
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
    // when in Auto Merch mode (Paused mode returns before the audit runs).
    // Audits the GE state and logs active slots for visibility. If a GE
    // sub-screen (offer config / search / price prompt) is open, the auto-loop
    // will close it with Escape on the next tick.
    runStartupAudit() {
        const audit = auditGeState();
        titan.logf('[Stark Mercher] Startup audit: screen=%s, geOpen=%s, slots=%s',
            audit.screen, audit.geOpen, audit.slots.map(s => s.type).join(','));

        if (!audit.geOpen) {
            // GE not open — nothing to resume. Idle.
            return;
        }

        // Check if any slot has an active offer — log it for visibility.
        for (let i = 0; i < audit.slots.length; i++) {
            const s = audit.slots[i];
            if (s.type === 'buy' || s.type === 'sell') {
                titan.logf('[Stark Mercher] Slot %d: %s %s (qty %d, %s)',
                    i + 1, s.type, s.itemName ?? 'unknown', s.itemQuantity, s.priceText ?? 'no price');
            }
        }

        // If a GE sub-screen is open (offer config / search / price prompt),
        // the auto-loop will close it with Escape on the next tick. No flow
        // resume is attempted — the auto-loop reconciles from cache state.
        if (audit.screen === 'offer_config' || audit.screen === 'search_prompt' || audit.screen === 'price_prompt') {
            titan.log('[Stark Mercher] Startup audit: GE sub-screen open — auto-loop will close it');
        }
    }

    onEnable() {
        onEnable(this);
        this.isHudActive = true;
        this.statusText = this.autoMode.value === 0 ? 'Paused' : 'Idle';
    }
    onDisable() {
        this.isHudActive = false;
        this.statusText = 'Stopped';
        if (this.terminated && this.terminationReason) {
            titan.logf("[Stark Mercher] Stopped: %s", this.terminationReason);
        }
    }
    onSettingChanged(key: string) {
        // When Mode is switched, update the status text and re-run the startup
        // audit on the next tick so the auto-loop reconciles from current GE
        // state (the audit is skipped while Paused, so switching to Auto Merch
        // needs it to run).
        if (key === 'autoMode') {
            if (this.autoMode.value === 0) {
                this.statusText = 'Paused';
                titan.log('[Stark Mercher] Mode switched to Paused — all script logic stopped.');
            } else {
                this.statusText = 'Idle';
                this.startupAuditDone = false;
                titan.log('[Stark Mercher] Mode switched to Auto Merch — resuming on next tick.');
            }
        }
        // When Do Not Sleep is toggled ON, clear any pre-sampled nightly break
        // planning so the next break is sampled as a short break, not a
        // nightly break with a stale duration. The breakStep() and logged-out
        // paths in session.ts also check doNotSleep to abort an already-started
        // nightly break.
        if (key === 'doNotSleep' && this.doNotSleep?.value) {
            this.nightlyBreakTargetTime = -1;
            this.nightlySleepMinutes = -1;
        }
    }
    onMenuOptionClicked = (event: titan.MenuOptionClicked) => {
        titan.logf("[Stark Mercher] Click: opcode=%d id=%d p0=%d p1=%d text=%s",
            event.opcode, event.identifier, event.param0, event.param1, event.actionText);
    }
    onGameTick = (tick: number) => {
        if (this.terminated) return;

        // --- Overlay cache refresh (fallback) ---
        // The overlay reads bot.cachedCoinCount and bot.cachedDailyProfit
        // instead of calling titan.utils.inventory.count(995) and
        // getDailyProfit() every frame (which exhausts native handles over
        // hours). The auto-loop refreshes these when it runs, but when it's
        // not running (Paused mode, logged out, GE not open, action delay
        // pending), we refresh here every 30 ticks (~18 seconds) as a
        // fallback. This is at most 1 native query per 18 seconds, not per
        // frame — negligible handle creation.
        if (tick - this.lastOverlayCacheRefreshTick >= 30) {
            this.lastOverlayCacheRefreshTick = tick;
            this.cachedCoinCount = titan.utils.inventory.count(995);
            const playerName = this.currentPlayerName || titan.state.client.localPlayer?.name || '';
            if (playerName) {
                if (this.cachedDailyProfitAccount !== playerName) {
                    this.cachedDailyProfitAccount = playerName;
                }
                this.cachedDailyProfit = getDailyProfit(this, playerName);
            }
        }

        // Paused mode: no script logic runs at all. The overlay still renders
        // (it's a separate render callback) so the user can see the status and
        // switch to Auto Merch.
        if (this.autoMode.value === 0) return;
        // Duplicate-tick guard: the SDK can fire onGameTick more than once
        // per tick in some edge cases.
        if (this.lastActionTick === tick) return;

        // Client tick counter went backwards (disconnect/relogin/world hop
        // that involved a logout/login cycle). Reset stale action state so
        // canPerformAction doesn't lock forever on a negative ticksSinceAction.
        if (this.lastActionTick > tick && this.lastActionTick !== -1) {
            titan.log('[Stark Mercher] Tick counter reset — resetting stale action state');
            this.currentAction = 'idle';
            this.actionStartTime = tick;
            this.actionDelay = 0;
            this.lastAction = 'idle';
            this.lastActionTime = tick;
            // Re-run the startup audit since the flow may have been interrupted.
            this.startupAuditDone = false;
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
            this.checkedAtHalfEta = false;
        }

        // --- Startup audit ---
        // On the first tick after enable (or after a tick-reset), audit the
        // GE state to determine if a buy-offer flow was in progress. If the
        // audit finds a recoverable state, resume the flow.
        if (!this.startupAuditDone) {
            this.startupAuditDone = true;
            this.runStartupAudit();
        }

        // Run the auto-merch tick logic. (Only reached in Auto Merch mode —
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
        if (this.autoMode.value === 0) return;
        try {
            wallClockStep(this);
        } catch (e) {
            titan.logf('[Stark Mercher] onMainLoop error: %s', String(e));
        }
    };

    // onGameStateChanged — detect unexpected logouts, nightly wake, and hop completion.
    // Skipped in Paused mode — no logout detection, no nightly wake, no hop completion.
    onGameStateChanged = (event: titan.GameStateChangedEvent) => {
        if (this.terminated) return;
        if (this.autoMode.value === 0) return;
        // Detect unexpected logout (not a bot-initiated break)
        if (event.newState !== titan.LoginGameState.LoggedIn &&
            event.newState !== titan.LoginGameState.HoppingWorld &&
            this.breakPhase === 'none') {
            if (this.unexpectedLogoutAtMs === 0) {
                this.unexpectedLogoutAtMs = Date.now();
                titan.logf('[Stark Mercher] Unexpected logout detected (gameState=%s)', String(event.newState));
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
        if (this.autoMode.value === 0) return;
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
        titan.log('[Stark Mercher] Post-login settle complete — resuming');
    }

    // Pause new actions while a hop or break is pending (waiting for a safe
    // boundary to dispatch). This prevents starting a new GE flow right
    // before a hop is about to fire.
    if (shouldPauseForHopBoundary(bot)) return;

    // Throttle: block dispatch while the previous action's delay is pending.
    if (shouldWait(bot)) return;

    // --- Auto-merch loop ---
    // Run the automated merching loop. The loop handles: GE-open check,
    // collect, stale offers, selling, and buying. (Pausing is handled by the
    // early return at the top of onGameTick, so we only get here in Auto Merch.)
    autoLoopTick(bot, tick);
};
