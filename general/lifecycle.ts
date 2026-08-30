import type { StarkMercher } from '../stark-mercher.js';
import { resetAutoLoop } from '../grand_exchange/auto-loop.js';
import { resetBreakState, initSessionProfile } from '../antiban/session.js';

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
    bot.terminationReason = reason;
    titan.logf("[Stark Mercher] Terminated: %s", reason);
};

// resetState()
const resetState = (bot: StarkMercher) => {
    bot.terminated = false;
    bot.terminationReason = '';
    bot.isRunning = false;
    bot.lastActionTick = -1;
    bot.currentAction = null;
    bot.actionStartTime = 0;
    bot.actionDelay = 0;
    bot.lastAction = null;
    bot.lastActionTime = 0;
    bot.buyOfferTest = null;
    bot.buyTestRequested = false;
    bot.abortOfferTest = null;
    bot.abortTestRequested = false;
    bot.sellOfferTest = null;
    bot.sellTestRequested = false;
    bot.startupAuditDone = false;
    // Reset the auto-merch loop state (flows, cache handle, attempted-item sets).
    // The persisted offer cache (hidden setting) is NOT cleared here — it
    // survives restarts and hot reloads. The cache is re-loaded from the
    // hidden setting on the first autoLoopTick via OfferCacheManager.
    resetAutoLoop(bot);
    // Reset break/login/logout state. The persisted session profile (hidden
    // setting) is NOT cleared — it survives restarts. The profile is re-loaded
    // on the first tick when the player name is available.
    resetBreakState(bot);
    // If the player is already in-world, load the session profile immediately.
    if (titan.state.client.localPlayer?.name) {
        initSessionProfile(bot);
    }
};
