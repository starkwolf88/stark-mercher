import type { StarkMercher } from '../stark-mercher.js';
import { resetAutoLoop } from '../grand_exchange/auto-loop.js';
import { resetBreakState, restoreBreakState, initSessionProfile, resetHopState } from '../antiban/session.js';

// onEnable()
export const onEnable = (bot: StarkMercher) => {
    titan.log('SCRIPT START');
    resetState(bot);
};

// resetForResume()
export const resetForResume = (bot: StarkMercher) => {
    resetState(bot);
};

// terminate()
export const terminate = (bot: StarkMercher, reason: string) => {
    if (bot.terminated) return;
    bot.terminated = true;
    bot.isRunning = false;
    bot.statusText = 'Stopped';
    bot.terminationReason = reason;
    titan.logf("[Stark Mercher] Terminated: %s", reason);
};

// resetState()
const resetState = (bot: StarkMercher) => {
    bot.terminated = false;
    bot.terminationReason = '';
    bot.isRunning = false;
    bot.statusText = 'Idle';
    bot.lastActionTick = -1;
    bot.currentAction = null;
    bot.actionStartTime = 0;
    bot.actionDelay = 0;
    bot.lastAction = null;
    bot.lastActionTime = 0;
    bot.startupAuditDone = false;
    // Reset the auto-merch loop state (flows, cache handle, attempted-item sets).
    // The persisted offer cache is NOT cleared here — it survives hot reloads.
    // The cache is re-loaded from the setting on the first autoLoopTick via
    // OfferCacheManager. Note: hidden settings do NOT survive client restarts
    // (Titan's host app does not persist them to disk). On client restart, the
    // cache is empty and must be reconstructed from live GE state (reverse
    // reconciliation in auto-loop.ts Step 2b — TODO).
    // The persisted offer cache is NOT cleared here — it survives restarts
    // and hot reloads. The cache is re-loaded from the setting on the first
    // autoLoopTick via OfferCacheManager.
    resetAutoLoop(bot);
    // Restore break/login state from the persisted setting if a valid saved
    // state exists (e.g. hot reload during a sleep or short break). Otherwise
    // reset to defaults. The persisted session profile is NOT cleared — it
    // survives restarts and is re-loaded on the first tick.
    if (!restoreBreakState(bot)) {
        resetBreakState(bot);
    }
    // Reset hop state (in-memory only; persisted timers are restored separately).
    resetHopState(bot);
    // If the player is already in-world, load the session profile immediately.
    if (titan.state.client.localPlayer?.name) {
        initSessionProfile(bot);
    }
};
