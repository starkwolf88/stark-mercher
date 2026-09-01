/// <reference path="./titan-plugin-sdk.d.ts" />
import { debug } from './general/debug.js';
import { onEnable, terminate } from './general/lifecycle.js';
import { setAction, shouldWait } from './general/timing.js';
import { sanityCheckState } from './general/state.js';
import { BuyOfferFlow, AbortOfferFlow, SellOfferFlow } from './grand_exchange/index.js';
import { getOfferSlotStateWithProgress, offerSlotCount, auditGeState } from './grand_exchange/widgets.js';
import { setDelayProfileForAccount, createDelay, getActiveDelayProfile } from './antiban/humanised-delay.js';
import { setClickJitterProfile, generateClickJitterProfile, setClickJitterDebugLog } from './antiban/click-jitter.js';
import { autoLoopTick, createAutoLoopState, resetAutoLoop, type AutoLoopState } from './grand_exchange/auto-loop.js';
import { breakStep, wallClockStep, resetBreakState, saveBreakState, initSessionProfile, markNightlyBreakFinished, resetHop, forceHop, shouldPauseForHopBoundary } from './antiban/session.js';
import { resetLoginState, loginStep } from './antiban/login.js';
import { resetLogoutState } from './antiban/logout.js';
import { hopStep, completeHop, onChatMessage as onHopChatMessage } from './antiban/hopper.js';
import { renderBotOverlay } from './widgets/bot-overlay.js';
import { loadOfferCache } from './general/state-persist.js';
import { getMerchHistory } from './data/merch-history.js';
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

    // Action throttle state
    lastActionTick = -1;
    actionStartTime = 0;
    actionDelay = 0;
    currentAction: string | null = null;
    lastAction: string | null = null;
    lastActionTime = 0;

    // --- One-shot buy-offer test ---
    // Click "Run Buy Test" in the config UI to start a single buy offer
    // using the configured test item/qty/price. The bot idles by default;
    // the button sets buyTestRequested, the flow starts on the next tick,
    // and the bot returns to idle when the flow finishes.
    buyOfferTest: BuyOfferFlow | null = null;
    buyTestRequested = false;

    // --- One-shot abort-offer test ---
    // Click "Run Abort Test" to abort the offer in the configured slot.
    // The bot idles by default; the button sets abortTestRequested, the
    // flow starts on the next tick, and the bot returns to idle when done.
    abortOfferTest: AbortOfferFlow | null = null;
    abortTestRequested = false;

    // --- One-shot sell-offer test ---
    // Click "Run Sell Test" to place a sell offer using the configured
    // test item/qty/price. The bot idles by default; the button sets
    // sellTestRequested, the flow starts on the next tick, and the bot
    // returns to idle when done.
    sellOfferTest: SellOfferFlow | null = null;
    sellTestRequested = false;

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
    // Login state
    currentPlayerName = '';
    sessionProfile: SessionProfile | null = null;
    unexpectedLogoutAtMs = 0;
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

    // --- Hidden offer cache setting ---
    // Stores the per-account offer cache as JSON (mixology-style hidden
    // setting persistence). Survives client restarts and plugin reloads.
    offerCacheSetting: titan.Setting<string> = this.stringSetting({
        key: 'offerCache',
        name: 'Offer cache (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Hidden daily profit setting ---
    // Stores per-account daily profit as JSON. Keyed by account name.
    // Each entry has { dayStartedAt, profit }. Day rollover is handled by
    // comparing dayStartedAt to the current day's midnight on read/write.
    dailyProfitSetting: titan.Setting<string> = this.stringSetting({
        key: 'dailyProfit',
        name: 'Daily profit (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Hidden hop state setting ---
    // Stores per-account hop timer state as JSON (nextHopAtMs, hopCount, etc.).
    // Survives client restarts and plugin reloads.
    hopStateSetting: titan.Setting<string> = this.stringSetting({
        key: 'hopState',
        name: 'Hop state (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Hidden last active account setting ---
    // Stores the last active account name. Used as a fallback when the
    // login snapshot doesn't have a displayName (e.g. account not staged
    // yet at script start). Survives client restarts and plugin reloads.
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
    merchHistorySetting: titan.Setting<string> = this.stringSetting({
        key: 'merchHistory',
        name: 'Merch history (hidden)',
        default: '{}',
        hidden: true,
    });

    // --- Hidden buy-freeze setting ---
    // Stores per-account buy-freeze state as JSON. Keyed by account name,
    // each value is a map of lowercase item name -> freeze-until timestamp
    // (ms). Survives client restarts and plugin reloads so a buy freeze
    // applied after aborting a stale buy offer is not lost on hot reload.
    buyFreezeSetting: titan.Setting<string> = this.stringSetting({
        key: 'buyFreeze',
        name: 'Buy freeze (hidden)',
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

    // --- Auto / Manual mode toggle ---
    // 0 = Manual Test (idle, respond to test buttons only)
    // 1 = Auto Merch (run the automated merching loop)
    autoMode: titan.Setting<number> = this.comboSetting({
        key: 'autoMode',
        name: 'Mode',
        default: 0,
        choices: [
            { value: 0, label: 'Manual Test' },
            { value: 1, label: 'Auto Merch' },
        ],
    });

    runBuyTest: titan.Setting<void> = this.buttonSetting({
        key: 'runBuyTest',
        name: 'Run Buy Test',
        position: -1,
        onClick: () => {
            if (this.buyOfferTest) {
                titan.log('[Stark Mercher] Buy test already in progress.');
                return;
            }
            this.buyTestRequested = true;
            titan.log('[Stark Mercher] Buy test requested — starting next tick.');
        },
    });

    // --- Abort test button ---
    // Click to abort the offer in the configured slot (1-8).
    runAbortTest: titan.Setting<void> = this.buttonSetting({
        key: 'runAbortTest',
        name: 'Run Abort Test',
        position: -1,
        onClick: () => {
            if (this.abortOfferTest) {
                titan.log('[Stark Mercher] Abort test already in progress.');
                return;
            }
            this.abortTestRequested = true;
            titan.log('[Stark Mercher] Abort test requested — starting next tick.');
        },
    });

    // --- Abort slot setting ---
    // Which slot (1-8) to abort.
    abortSlot: titan.Setting<string> = this.stringSetting({
        key: 'abortSlot',
        name: 'Abort slot (1-8)',
        default: '1',
    });

    // --- Sell test button ---
    // Click to place a sell offer using the configured test item/qty/price.
    runSellTest: titan.Setting<void> = this.buttonSetting({
        key: 'runSellTest',
        name: 'Run Sell Test',
        position: -1,
        onClick: () => {
            if (this.sellOfferTest) {
                titan.log('[Stark Mercher] Sell test already in progress.');
                return;
            }
            this.sellTestRequested = true;
            titan.log('[Stark Mercher] Sell test requested — starting next tick.');
        },
    });

    // --- Sell test parameters ---
    // Reuses the same item name, quantity, and price settings as the buy test.
    // The item must be in the inventory for the sell flow to work.

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
    // Click to dump the merch history (profits and losses) to the log.
    // Shows completed merch cycles with item, qty, profit/loss, avg sell
    // price, buy price, and revision count.
    logMerchHistory: titan.Setting<void> = this.buttonSetting({
        key: 'logMerchHistory',
        name: 'Log Merch History',
        position: -1,
        onClick: () => {
            const accountName = this.currentPlayerName || titan.state.client.localPlayer?.name || '';
            if (!accountName) {
                titan.log('[Stark Mercher] Cannot log merch history — no account name available.');
                return;
            }
            const history = getMerchHistory(this, accountName);
            if (history.profits.length === 0 && history.losses.length === 0) {
                titan.logf('[Stark Mercher] No merch history for %s.', accountName);
                return;
            }
            titan.logf('[Stark Mercher] Merch history for %s:', accountName);
            if (history.profits.length > 0) {
                titan.logf('[Stark Mercher] === PROFITS (%d) ===', history.profits.length);
                let totalProfit = 0;
                for (const e of history.profits) {
                    titan.logf('[Stark Mercher]   %s: qty=%d, profit=+%dgp, buy=%d, avgSold=%d, revisions=%d, date=%s',
                        e.item, e.qty, e.profit, e.buy, e.avgSold, e.revisions, e.date);
                    totalProfit += e.profit;
                }
                titan.logf('[Stark Mercher]   Total profit: +%dgp', totalProfit);
            }
            if (history.losses.length > 0) {
                titan.logf('[Stark Mercher] === LOSSES (%d) ===', history.losses.length);
                let totalLoss = 0;
                for (const e of history.losses) {
                    titan.logf('[Stark Mercher]   %s: qty=%d, loss=%dgp, buy=%d, avgSold=%d, revisions=%d, date=%s',
                        e.item, e.qty, e.profit, e.buy, e.avgSold, e.revisions, e.date);
                    totalLoss += e.profit;
                }
                titan.logf('[Stark Mercher]   Total loss: %dgp', totalLoss);
            }
            titan.logf('[Stark Mercher] Merch history dump complete.');
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
            const accountName = this.currentPlayerName || titan.state.client.localPlayer?.name || '';
            if (!accountName) {
                titan.log('[Stark Mercher] Cannot log buy freezes — no account name available.');
                return;
            }
            const raw = this.buyFreezeSetting.value;
            if (!raw || raw === '{}') {
                titan.logf('[Stark Mercher] No buy freezes for any account.');
                return;
            }
            let all: Record<string, Record<string, number>>;
            try {
                all = JSON.parse(raw);
            } catch (e) {
                titan.logf('[Stark Mercher] Failed to parse buy-freeze data: %s', String(e));
                return;
            }
            const accountNames = Object.keys(all);
            if (accountNames.length === 0) {
                titan.logf('[Stark Mercher] No buy freezes for any account.');
                return;
            }
            for (const acct of accountNames) {
                const freezes = all[acct];
                const items = Object.keys(freezes);
                if (items.length === 0) {
                    titan.logf('[Stark Mercher] Buy freezes for %s: none active.', acct);
                    continue;
                }
                const now = Date.now();
                const active = items.filter(name => freezes[name] > now);
                const expired = items.length - active.length;
                titan.logf('[Stark Mercher] Buy freezes for %s (%d active, %d expired):', acct, active.length, expired);
                for (const name of active) {
                    const until = freezes[name];
                    const minsLeft = Math.max(0, Math.ceil((until - now) / 60000));
                    titan.logf('[Stark Mercher]   %s: expires in %d min (at %s)', name, minsLeft, new Date(until).toISOString());
                }
            }
            titan.logf('[Stark Mercher] Buy freeze dump complete.');
        },
    });

    // --- Configurable test parameters ---
    testItemName: titan.Setting<string> = this.stringSetting({
        key: 'testItemName',
        name: 'Test item name',
        default: 'Air rune',
    });
    testItemQty: titan.Setting<string> = this.stringSetting({
        key: 'testItemQty',
        name: 'Test quantity',
        default: '2',
    });
    testItemPrice: titan.Setting<string> = this.stringSetting({
        key: 'testItemPrice',
        name: 'Test price (each)',
        default: '5',
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

    // --- Slot check buttons (1-8) ---
    // Each button logs the full state of that GE offer slot.
    checkSlot1: titan.Setting<void> = this.buttonSetting({
        key: 'checkSlot1', name: 'Check Slot 1', position: -1,
        onClick: () => this.logSlotState(0),
    });
    checkSlot2: titan.Setting<void> = this.buttonSetting({
        key: 'checkSlot2', name: 'Check Slot 2', position: -1,
        onClick: () => this.logSlotState(1),
    });
    checkSlot3: titan.Setting<void> = this.buttonSetting({
        key: 'checkSlot3', name: 'Check Slot 3', position: -1,
        onClick: () => this.logSlotState(2),
    });
    checkSlot4: titan.Setting<void> = this.buttonSetting({
        key: 'checkSlot4', name: 'Check Slot 4', position: -1,
        onClick: () => this.logSlotState(3),
    });
    checkSlot5: titan.Setting<void> = this.buttonSetting({
        key: 'checkSlot5', name: 'Check Slot 5', position: -1,
        onClick: () => this.logSlotState(4),
    });
    checkSlot6: titan.Setting<void> = this.buttonSetting({
        key: 'checkSlot6', name: 'Check Slot 6', position: -1,
        onClick: () => this.logSlotState(5),
    });
    checkSlot7: titan.Setting<void> = this.buttonSetting({
        key: 'checkSlot7', name: 'Check Slot 7', position: -1,
        onClick: () => this.logSlotState(6),
    });
    checkSlot8: titan.Setting<void> = this.buttonSetting({
        key: 'checkSlot8', name: 'Check Slot 8', position: -1,
        onClick: () => this.logSlotState(7),
    });

    logSlotState(index: number) {
        const max = offerSlotCount();
        if (index >= max) {
            titan.logf('[Stark Mercher] Slot %d: not available on this world (max %d slots)', index + 1, max);
            return;
        }
        const s = getOfferSlotStateWithProgress(index);
        if (s.type === 'empty') {
            titan.logf('[Stark Mercher] Slot %d: Empty', index + 1);
            return;
        }
        titan.logf('[Stark Mercher] Slot %d: %s | %s | qty %d | %s | %s | %d%%',
            index + 1,
            s.type,
            s.itemName ?? 'unknown item',
            s.itemQuantity,
            s.priceText ?? 'no price',
            s.status,
            Math.round(s.progress * 100),
        );
    }

    // runStartupAudit()
    // Called on the first tick after enable (or after a tick-reset). Audits
    // the GE state to determine if a buy-offer flow was in progress. If the
    // audit finds a recoverable state and the user has test parameters set,
    // it resumes the flow from the correct step.
    runStartupAudit() {
        const audit = auditGeState();
        titan.logf('[Stark Mercher] Startup audit: screen=%s, geOpen=%s, slots=%s',
            audit.screen, audit.geOpen, audit.slots.map(s => s.type).join(','));

        if (!audit.geOpen) {
            // GE not open — nothing to resume. Idle.
            return;
        }

        // Check if any slot has an active buy offer — log it for visibility.
        for (let i = 0; i < audit.slots.length; i++) {
            const s = audit.slots[i];
            if (s.type === 'buy' || s.type === 'sell') {
                titan.logf('[Stark Mercher] Slot %d: %s %s (qty %d, %s)',
                    i + 1, s.type, s.itemName ?? 'unknown', s.itemQuantity, s.priceText ?? 'no price');
            }
        }

        // If we're on the offer config screen or search/price prompt, try to
        // resume a buy-offer flow using the configured test parameters.
        // In Auto Merch mode, the item being bought came from merchableItems.json,
        // not the test settings — resuming with test parameters would place the
        // wrong offer. Instead, skip the resume and let the auto-loop close the
        // sub-screen with Escape on the next tick.
        if (audit.screen === 'offer_config' || audit.screen === 'search_prompt' || audit.screen === 'price_prompt') {
            if (this.autoMode.value === 1) {
                titan.log('[Stark Mercher] Startup audit: GE sub-screen open in Auto Merch mode — skipping resume (auto-loop will close it)');
                return;
            }
            const itemName = this.testItemName.value.trim();
            const quantity = parseInt(this.testItemQty.value, 10);
            const price = parseInt(this.testItemPrice.value, 10);
            if (!itemName || !Number.isFinite(quantity) || quantity < 1 || !Number.isFinite(price) || price < 1) {
                titan.log('[Stark Mercher] Startup audit: GE config screen open but test parameters invalid — idling');
                return;
            }
            titan.logf('[Stark Mercher] Startup audit: resuming buy-offer flow for %ix %s @ %igp', quantity, itemName, price);
            // Generate delay/jitter profiles for humanised timing.
            const playerName = titan.state.client.localPlayer?.name;
            if (playerName) setDelayProfileForAccount(playerName);
            const delayProfile = getActiveDelayProfile();
            if (delayProfile) setClickJitterProfile(generateClickJitterProfile(delayProfile));
            setClickJitterDebugLog((msg: string) => { if (this.logDebug.value) titan.logf('[Stark Mercher] %s', msg); });
            const flow = new BuyOfferFlow({
                itemName, quantity, price,
                delayFn: createDelay,
                debugLog: (msg: string) => { if (this.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
            });
            flow.resumeFromState(audit);
            if (flow.status === 'in_progress') {
                this.buyOfferTest = flow;
            } else if (flow.status === 'done') {
                titan.log('[Stark Mercher] Startup audit: offer already placed — nothing to resume');
            } else if (flow.status === 'failed') {
                titan.logf('[Stark Mercher] Startup audit: resume failed — %s', flow.error);
            }
        }
    }

    onEnable() {
        onEnable(this);
        this.isHudActive = true;
        this.statusText = 'Idle';
    }
    onDisable() {
        this.isHudActive = false;
        this.statusText = 'Stopped';
        if (this.terminated && this.terminationReason) {
            titan.logf("[Stark Mercher] Stopped: %s", this.terminationReason);
        }
    }
    onMenuOptionClicked = (event: titan.MenuOptionClicked) => {
        titan.logf("[Stark Mercher] Click: opcode=%d id=%d p0=%d p1=%d text=%s",
            event.opcode, event.identifier, event.param0, event.param1, event.actionText);
    }
    onGameTick = (tick: number) => {
        if (this.terminated) return;
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
            // Clear idle-for-break flags — the auto-loop's idle state from
            // before the disconnect is no longer valid.
            this.loopIdleForBreak = false;
            this.loopIdleSinceTick = -1;
            this.shortBreakDelayTicks = -1;
            this.nextActionEtaMin = -1;
        }

        // --- Startup audit ---
        // On the first tick after enable (or after a tick-reset), audit the
        // GE state to determine if a buy-offer flow was in progress. If the
        // audit finds a recoverable state, resume the flow.
        if (!this.startupAuditDone) {
            this.startupAuditDone = true;
            this.runStartupAudit();
        }

        // Always tick so the buy-test button works without toggling isRunning.
        // When idle (no request, no active flow) tickLogic just returns.
        try {
            gameTick(this, tick);
        } catch (e) {
            terminate(this, `onGameTick error: ${String(e)}`);
        }
        this.lastActionTick = tick;
    };

    // onMainLoop fires even on login/title screens — this is where we
    // dispatch login/logout while the player is logged out.
    onMainLoop = () => {
        if (this.terminated) return;
        try {
            wallClockStep(this);
        } catch (e) {
            titan.logf('[Stark Mercher] onMainLoop error: %s', String(e));
        }
    };

    // onGameStateChanged — detect unexpected logouts, nightly wake, and hop completion
    onGameStateChanged = (event: titan.GameStateChangedEvent) => {
        if (this.terminated) return;
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

    // onChatMessage — listen for world switcher rejection messages
    onChatMessage = (event: titan.ChatMessageEvent) => {
        if (this.terminated) return;
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

    // --- One-shot buy-offer test (button-triggered) ---
    // Idle by default. When "Run Buy Test" is clicked, buyTestRequested is
    // set and the flow starts on the next ready tick. When the flow finishes
    // the bot returns to idle — click the button again to run another.
    if (bot.buyOfferTest) {
        const flow = bot.buyOfferTest;
        if (flow.status === 'in_progress') {
            bot.statusText = `Buy test: ${flow.itemName} - x${flow.quantity} - ${flow.price}gp each`;
            if (flow.tick()) {
                setAction(bot, 'buy_offer', flow.lastDelay); // humanised delay from the flow
            }
            return;
        }
        if (flow.status === 'done') {
            titan.log('[Stark Mercher] Buy-offer test complete — back to idle.');
        } else if (flow.status === 'failed') {
            titan.logf('[Stark Mercher] Buy-offer test failed: %s', flow.error);
        }
        bot.buyOfferTest = null;
        bot.statusText = 'Idle';
        return;
    }

    // --- One-shot abort-offer test (button-triggered) ---
    // Click "Run Abort Test" to abort the offer in the configured slot.
    // The flow handles: click into slot → abort → wait → back → collect.
    if (bot.abortOfferTest) {
        const abortFlow = bot.abortOfferTest;
        if (abortFlow.status === 'in_progress') {
            bot.statusText = `Abort test: slot ${abortFlow.slotIndex + 1}`;
            if (abortFlow.tick()) {
                setAction(bot, 'abort_offer', abortFlow.lastDelay);
            }
            return;
        }
        if (abortFlow.status === 'done') {
            titan.log('[Stark Mercher] Abort-offer test complete — back to idle.');
        } else if (abortFlow.status === 'failed') {
            titan.logf('[Stark Mercher] Abort-offer test failed: %s', abortFlow.error);
        }
        bot.abortOfferTest = null;
        bot.statusText = 'Idle';
        return;
    }

    // --- One-shot sell-offer test (button-triggered) ---
    // Click "Run Sell Test" to place a sell offer using the configured
    // test item/qty/price. The item must be in the inventory.
    if (bot.sellOfferTest) {
        const sellFlow = bot.sellOfferTest;
        if (sellFlow.status === 'in_progress') {
            bot.statusText = `Sell test: ${sellFlow.itemName} - x${sellFlow.quantity} - ${sellFlow.price}gp each`;
            if (sellFlow.tick()) {
                setAction(bot, 'sell_offer', sellFlow.lastDelay);
            }
            return;
        }
        if (sellFlow.status === 'done') {
            titan.log('[Stark Mercher] Sell-offer test complete — back to idle.');
        } else if (sellFlow.status === 'failed') {
            titan.logf('[Stark Mercher] Sell-offer test failed: %s', sellFlow.error);
        }
        bot.sellOfferTest = null;
        bot.statusText = 'Idle';
        return;
    }

    // --- Start new flows if requested ---
    // Only one flow can be active at a time. Check all request flags.

    if (bot.buyTestRequested) {
        bot.buyTestRequested = false;
        const itemName = bot.testItemName.value.trim();
        const quantity = parseInt(bot.testItemQty.value, 10);
        const price = parseInt(bot.testItemPrice.value, 10);
        if (!itemName) {
            titan.log('[Stark Mercher] Test item name is empty — set it in the config UI first.');
            return;
        }
        if (!Number.isFinite(quantity) || quantity < 1) {
            titan.logf('[Stark Mercher] Test quantity invalid ("%s") — must be a positive integer.', bot.testItemQty.value);
            return;
        }
        if (!Number.isFinite(price) || price < 1) {
            titan.logf('[Stark Mercher] Test price invalid ("%s") — must be a positive integer.', bot.testItemPrice.value);
            return;
        }
        // Generate the per-account delay profile from the player name so
        // humanised delays are deterministic per account.
        const playerName = titan.state.client.localPlayer?.name;
        if (playerName) setDelayProfileForAccount(playerName);
        // Generate the click-jitter profile from the delay profile so click
        // timing is also deterministic per account.
        const delayProfile = getActiveDelayProfile();
        if (delayProfile) setClickJitterProfile(generateClickJitterProfile(delayProfile));
        // Route click-jitter debug logs through the same UI toggle.
        setClickJitterDebugLog((msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); });
        bot.buyOfferTest = new BuyOfferFlow({
            itemName, quantity, price,
            delayFn: createDelay,
            debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
        });
        titan.logf('[Stark Mercher] Starting buy-offer test: %ix %s @ %igp', quantity, itemName, price);
        return;
    }

    if (bot.abortTestRequested) {
        bot.abortTestRequested = false;
        const slotNum = parseInt(bot.abortSlot.value, 10);
        if (!Number.isFinite(slotNum) || slotNum < 1 || slotNum > 8) {
            titan.logf('[Stark Mercher] Abort slot invalid ("%s") — must be 1-8.', bot.abortSlot.value);
            return;
        }
        // Generate the per-account delay profile from the player name so
        // humanised delays are deterministic per account.
        const playerName = titan.state.client.localPlayer?.name;
        if (playerName) setDelayProfileForAccount(playerName);
        const delayProfile = getActiveDelayProfile();
        if (delayProfile) setClickJitterProfile(generateClickJitterProfile(delayProfile));
        setClickJitterDebugLog((msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); });
        bot.abortOfferTest = new AbortOfferFlow({
            slotIndex: slotNum - 1, // 1-based UI to 0-based index
            delayFn: createDelay,
            debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
        });
        titan.logf('[Stark Mercher] Starting abort-offer test on slot %d', slotNum);
        return;
    }

    if (bot.sellTestRequested) {
        bot.sellTestRequested = false;
        const itemName = bot.testItemName.value.trim();
        const quantity = parseInt(bot.testItemQty.value, 10);
        const price = parseInt(bot.testItemPrice.value, 10);
        if (!itemName) {
            titan.log('[Stark Mercher] Sell item name is empty — set it in the config UI first.');
            return;
        }
        if (!Number.isFinite(quantity) || quantity < 1) {
            titan.logf('[Stark Mercher] Sell quantity invalid ("%s") — must be a positive integer.', bot.testItemQty.value);
            return;
        }
        if (!Number.isFinite(price) || price < 1) {
            titan.logf('[Stark Mercher] Sell price invalid ("%s") — must be a positive integer.', bot.testItemPrice.value);
            return;
        }
        const playerName = titan.state.client.localPlayer?.name;
        if (playerName) setDelayProfileForAccount(playerName);
        const delayProfile = getActiveDelayProfile();
        if (delayProfile) setClickJitterProfile(generateClickJitterProfile(delayProfile));
        setClickJitterDebugLog((msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); });
        bot.sellOfferTest = new SellOfferFlow({
            itemName, quantity, price,
            delayFn: createDelay,
            debugLog: (msg: string) => { if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg); },
        });
        titan.logf('[Stark Mercher] Starting sell-offer test: %ix %s @ %igp', quantity, itemName, price);
        return;
    }

    // --- Auto-merch loop ---
    // When autoMode is enabled (Auto Merch) and no manual test is active,
    // run the automated merching loop. The loop handles: GE-open check,
    // collect, stale offers, selling, and buying.
    if (bot.autoMode.value === 1) {
        autoLoopTick(bot, tick);
        return;
    }

    // Idle — no active flows and no requests.
};
