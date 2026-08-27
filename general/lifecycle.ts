import type { StarkMercher } from '../stark-mercher.js';

// onEnable()
export const onEnable = (bot: StarkMercher) => {
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
};
