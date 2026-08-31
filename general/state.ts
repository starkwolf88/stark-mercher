import type { StarkMercher } from '../stark-mercher.js';

// sanityCheckState()
// Auto-corrects stale state each tick. Add per-field corrections here as
// state is introduced to the plugin.
export const sanityCheckState = (bot: StarkMercher, tick: number) => {
    // stub
};

// resetInFlightActionState()
// Called on hop/break/login transitions. Clears any in-flight auto-loop flows
// and test flows so the bot does not carry stale tick-based state across the
// transition. The offer cache (persisted in a hidden setting) is NOT cleared —
// it survives hops and reloads.
export const resetInFlightActionState = (bot: StarkMercher): void => {
    // Clear in-flight auto-loop flows (they hold tick-based step state that
    // becomes stale after a world hop or break).
    bot.autoLoop.activeBuyFlow = null;
    bot.autoLoop.activeSellFlow = null;
    bot.autoLoop.activeAbortFlow = null;
    bot.autoLoop.phase = 'idle';
    bot.autoLoop.sellAttemptedItems.clear();
    bot.autoLoop.buyAttemptedItems.clear();
    // Clear manual test flows
    bot.buyOfferTest = null;
    bot.buyTestRequested = false;
    bot.abortOfferTest = null;
    bot.abortTestRequested = false;
    bot.sellOfferTest = null;
    bot.sellTestRequested = false;
    // Reset action throttle
    bot.currentAction = null;
    bot.actionStartTime = 0;
    bot.actionDelay = 0;
    bot.lastAction = null;
    bot.lastActionTime = 0;
};
