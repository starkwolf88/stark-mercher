import type { StarkMercher } from '../stark-mercher.js';
import { invalidateGeWidgetCache, invalidateBooleanStateCache } from '../grand_exchange/widgets.js';
import { invalidateInvCache } from '../grand_exchange/auto-loop.js';
import { invalidateNearGeCache } from '../grand_exchange/clerk.js';

function debugLog(bot: StarkMercher, msg: string): void {
    if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg);
}

// sanityCheckState()
// Auto-corrects stale state each tick. Add per-field corrections here as
// state is introduced to the plugin. These are cheap, per-tick invariants
// that catch state values which outlive the event that set them — the most
// common source of production bugs.
export const sanityCheckState = (bot: StarkMercher, tick: number) => {
    const loop = bot.autoLoop;

    // abortSlotInfo should be null when no abort flow is active. The abort
    // completion path clears it, but a defensive check catches edge cases
    // (e.g. tick-counter reset clearing the flow but not the slot info).
    if (!loop.activeAbortFlow && loop.abortSlotInfo !== null) {
        debugLog(bot, `sanityCheck: clearing stale abortSlotInfo (no active abort flow)`);
        loop.abortSlotInfo = null;
    }

    // Phase should match the active flow. If the flow is gone but the phase
    // still indicates an in-progress operation, reset to idle. This catches
    // cases where a flow was cleared (e.g. by tick-counter reset) without
    // resetting the phase.
    if (!loop.activeBuyFlow && loop.phase === 'buying') {
        debugLog(bot, `sanityCheck: resetting phase 'buying' -> 'idle' (no active buy flow)`);
        loop.phase = 'idle';
    }
    if (!loop.activeSellFlow && loop.phase === 'selling') {
        debugLog(bot, `sanityCheck: resetting phase 'selling' -> 'idle' (no active sell flow)`);
        loop.phase = 'idle';
    }
    if (!loop.activeAbortFlow && loop.phase === 'aborting') {
        debugLog(bot, `sanityCheck: resetting phase 'aborting' -> 'idle' (no active abort flow)`);
        loop.phase = 'idle';
    }

    // logoutComplete should be false when not in a break. The break/login
    // recovery paths clear it, but a defensive check catches cases where the
    // bot transitions out of a break without clearing the flag.
    if (bot.breakPhase === 'none' && bot.logoutComplete) {
        debugLog(bot, `sanityCheck: clearing stale logoutComplete (breakPhase=none)`);
        bot.logoutComplete = false;
    }
};

// resetInFlightActionState()
// Called on hop/break/login transitions. Clears any in-flight auto-loop flows
// and test flows so the bot does not carry stale tick-based state across the
// transition. The offer cache (persisted in a hidden setting) is NOT cleared —
// it survives hops and reloads.
export const resetInFlightActionState = (bot: StarkMercher): void => {
    // Invalidate cross-tick caches — widget and inventory state from before
    // the transition (hop/break/login) is no longer valid.
    invalidateGeWidgetCache();
    invalidateBooleanStateCache();
    invalidateNearGeCache();
    invalidateInvCache();
    // Clear in-flight auto-loop flows (they hold tick-based step state that
    // becomes stale after a world hop or break).
    bot.autoLoop.activeBuyFlow = null;
    bot.autoLoop.activeSellFlow = null;
    bot.autoLoop.activeAbortFlow = null;
    bot.autoLoop.abortSlotInfo = null;
    bot.autoLoop.phase = 'idle';
    bot.autoLoop.sellAttemptedItems.clear();
    bot.autoLoop.buyAttemptedItems.clear();
    // Re-run cache reconciliation and post-login cleanup after transitions
    // so the bot re-validates its cache state against the live GE after a
    // hop or break.
    bot.autoLoop.cacheReconciled = false;
    bot.autoLoop.cacheReconstructed = false;
    bot.autoLoop.needsPostLoginCleanup = true;
    // Clear idle-for-break flags — they reflect the auto-loop's idle state
    // which is no longer valid after a hop/break/login transition. Without
    // this, the break system could take a short break immediately after a
    // hop based on stale idle state from before the hop.
    bot.loopIdleForBreak = false;
    bot.loopIdleSinceTick = -1;
    bot.shortBreakDelayTicks = -1;
    bot.nextActionEtaMin = -1;
    bot.lastIdleDiagTick = -1;
    // Reset idle activity tick throttle — the tick counter resets on hop/
    // break/login, so idleActivityLastTick (tick-based) is stale. Reset to
    // -1 to allow immediate action. The phase/sub-step are preserved so
    // the activity continues from where it left off (e.g. if mid-converting,
    // the bars are still in inventory after the transition).
    bot.autoLoop.idleActivityLastTick = -1;
    // Clear any pending GE-completion chat flag — it's transient and
    // shouldn't survive across hop/break/login transitions.
    bot.geOfferCompletedChatMs = 0;
    // NOTE: checkedAtHalfEta is intentionally NOT reset here. It represents
    // "we already checked at 50% ETA and found nothing ready" — this
    // knowledge survives login/logout/hop transitions. Clearing it here
    // would wipe the 90% escalation memory on every login, causing every
    // break to be a 50% check and producing rapid login/nothing-to-do/
    // logout cycling. It is cleared only when an actual GE action is
    // performed (buy/sell/abort/collect/revision) in auto-loop.ts.
    // Reset action throttle
    bot.currentAction = null;
    bot.actionStartTime = 0;
    bot.actionDelay = 0;
    bot.lastAction = null;
    bot.lastActionTime = 0;
};
