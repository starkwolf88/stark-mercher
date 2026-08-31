import type { StarkMercher } from '../stark-mercher.js';

/** True when the local player is stationary. The engine's p.isIdle flag is
 *  intentionally ignored because it can remain false after an action. The
 *  p.isAnimating flag is also observed to stay true for long cosmetic emotes,
 *  so we only use it as a short grace check: if the player has been stationary
 *  for more than a few ticks we consider them idle regardless of animation. */
const IDLE_ANIMATION_GRACE_TICKS = 5;
const MOVEMENT_STREAK = 3;

export function isPlayerIdle(bot: StarkMercher): boolean {
    const p = titan.state.client.localPlayer;
    if (!p) return true;

    const tick = titan.state.client.tick;
    const isMoving = p.isStationary === false;
    if (isMoving) {
        bot.consecutiveMovingTicks = (bot.consecutiveMovingTicks || 0) + 1;
        if (bot.consecutiveMovingTicks >= MOVEMENT_STREAK) {
            bot.lastPlayerStationaryTick = 0;
        }
        return false;
    }

    bot.consecutiveMovingTicks = 0;
    if (bot.lastPlayerStationaryTick === 0) {
        bot.lastPlayerStationaryTick = tick;
    }
    const stationaryFor = tick - bot.lastPlayerStationaryTick;
    const isAnimating = p.isAnimating === true;

    return !isAnimating || stationaryFor >= IDLE_ANIMATION_GRACE_TICKS;
}
