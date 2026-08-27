/// <reference path="./titan-plugin-sdk.d.ts" />
import { debug } from './general/debug.js';
import { onEnable, terminate } from './general/lifecycle.js';
import { shouldWait } from './general/timing.js';
import { sanityCheckState } from './general/state.js';

export class StarkMercher extends titan.Plugin {
    id = "stark-mercher";
    name = "Stark Mercher";
    description = "Grand Exchange merching bot.";
    author = "Matt";
    version = "1.0.0";

    terminated = false;
    terminationReason = '';
    isRunning = false;

    // Action throttle state
    lastActionTick = -1;
    actionStartTime = 0;
    actionDelay = 0;
    currentAction: string | null = null;
    lastAction: string | null = null;
    lastActionTime = 0;

    onEnable() { onEnable(this); }
    onDisable() {
        if (this.terminated && this.terminationReason) {
            titan.logf("[Stark Mercher] Stopped: %s", this.terminationReason);
        }
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
            this.currentAction = 'idle';
            this.actionStartTime = tick;
            this.actionDelay = 0;
            this.lastAction = 'idle';
            this.lastActionTime = tick;
        }

        if (!this.isRunning) {
            this.lastActionTick = tick;
            return;
        }

        try {
            gameTick(this, tick);
        } catch (e) {
            terminate(this, `onGameTick error: ${String(e)}`);
        }
        this.lastActionTick = tick;
    };
    onMenuOptionClicked(event: any) {
        debug.widgets(event);
    }
}
titan.register(new StarkMercher());

const gameTick = (bot: StarkMercher, tick: number) => {
    tickLogic(bot, tick);
};

const tickLogic = (bot: StarkMercher, tick: number) => {
    // Auto-correct any state that has outlived the event that set it.
    sanityCheckState(bot, tick);

    // Throttle: block dispatch while the previous action's delay is pending.
    if (shouldWait(bot)) return;

    // Main per-tick action loop goes here.
    // Dispatch at most ONE action per tick, then call setAction(bot, name, delay)
    // so the next tick is blocked until the delay elapses.
};
