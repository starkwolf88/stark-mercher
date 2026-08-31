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
import { breakStep, wallClockStep, resetBreakState, initSessionProfile, markNightlyBreakFinished, resetHop, forceHop, shouldPauseForHopBoundary } from './antiban/session.js';
import { resetLoginState } from './antiban/login.js';
import { resetLogoutState } from './antiban/logout.js';
import { hopStep, completeHop, onChatMessage as onHopChatMessage } from './antiban/hopper.js';
import { renderBotOverlay } from './widgets/bot-overlay.js';
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
    // Login state
    currentPlayerName = '';
    sessionProfile: SessionProfile | null = null;
    unexpectedLogoutAtMs = 0;
    // Login FSM fields
    titleNextClickAt = 0;
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
        if (audit.screen === 'offer_config' || audit.screen === 'search_prompt' || audit.screen === 'price_prompt') {
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
        titan.log(`Tick: ${tick}`);
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
            this.autoLoop.phase = 'idle';
            this.autoLoop.sellAttemptedItems.clear();
            this.autoLoop.buyAttemptedItems.clear();
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
