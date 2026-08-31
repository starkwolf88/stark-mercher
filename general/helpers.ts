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

/** Format a quantity compactly: 18000 → "18k", 25000 → "25k", 1000000 → "1M". */
export function formatQty(n: number): string {
    if (n >= 1_000_000) {
        const m = n / 1_000_000;
        return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
    }
    if (n >= 1000) {
        const k = n / 1000;
        return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
    }
    return String(n);
}

/** Format a gp amount compactly: 102 → "102", 100000 → "100k", 1500000 → "1.5M". */
export function formatGpShort(n: number): string {
    return formatQty(n);
}

/**
 * Formats a number using OSRS GE "k" notation for typing into quantity/price
 * fields. Only uses "k" when the result is exact (no rounding needed):
 *   18000 → "18k", 1800 → "1.8k", 180000 → "180k"
 *   1251 → "1251" (not a clean k value, keep as-is)
 *   1000 → "1k", 100 → "100"
 * This shortens the number of keystrokes for humanised typing.
 */
export function formatGeInput(n: number): string {
    if (n >= 1000 && n % 1000 === 0) {
        // Exact thousands: 18000 → "18k", 1000 → "1k"
        return `${n / 1000}k`;
    }
    if (n >= 1000 && n % 100 === 0) {
        // Exact hundreds (divisible by 100): 1800 → "1.8k", 2500 → "2.5k"
        const k = n / 1000;
        return `${k.toFixed(1)}k`;
    }
    return String(n);
}
