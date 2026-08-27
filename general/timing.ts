import type { StarkMercher } from '../stark-mercher.js';

// setAction()
// Records the current action and the tick at which it started, plus a
// humanized delay that blocks the next dispatch until it elapses.
export const setAction = (bot: StarkMercher, action: string, delayTicks: number) => {
    bot.currentAction = action;
    bot.actionStartTime = titan.state.client.tick;
    bot.actionDelay = Math.max(0, delayTicks);
    bot.lastAction = action;
    bot.lastActionTime = titan.state.client.tick;
};

// canPerformAction()
// Returns true when the previous action's delay has elapsed. If the client
// tick counter went backwards (disconnect/relogin), resets the action state
// so the bot never locks forever on a negative ticksSinceAction.
export const canPerformAction = (bot: StarkMercher): boolean => {
    if (bot.currentAction === null) return true;
    const ticksSinceAction = titan.state.client.tick - bot.actionStartTime;
    if (ticksSinceAction < 0) {
        bot.currentAction = 'idle';
        bot.actionStartTime = titan.state.client.tick;
        bot.actionDelay = 0;
        bot.lastAction = 'idle';
        bot.lastActionTime = titan.state.client.tick;
        return true;
    }
    if (ticksSinceAction >= bot.actionDelay) {
        if (bot.currentAction !== 'idle') bot.currentAction = 'idle';
        return true;
    }
    return false;
};

// shouldWait()
// Returns true while the previous action's delay is still pending.
export const shouldWait = (bot: StarkMercher): boolean => !canPerformAction(bot);
