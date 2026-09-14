import type { StarkMercher } from '../stark-mercher.js';
import { isInventoryOpen } from '../grand_exchange/widgets.js';

/** True when the local player is stationary. The engine's p.isIdle flag is
 *  intentionally ignored because it can remain false after an action. The
 *  p.isAnimating flag is also observed to stay true for long cosmetic emotes,
 *  so we only use it as a short grace check: if the player has been stationary
 *  for more than a few ticks we consider them idle regardless of animation. */
const IDLE_ANIMATION_GRACE_TICKS = 5;
const MOVEMENT_STREAK = 3;

// Per-tick localPlayer cache — titan.state.client.localPlayer creates a
// native Player handle on every read. isPlayerIdle() is called multiple
// times per game tick by break/hop/safe-boundary logic, so cache the
// handle for the duration of a single tick. Cleared on tick counter reset.
let cachedLocalPlayer: titan.Player | null = null;
let cachedLocalPlayerTick = -1;

const getLocalPlayer = (): titan.Player | null => {
    const tick = titan.state.client.tick;
    if (tick === cachedLocalPlayerTick) return cachedLocalPlayer;
    if (tick < cachedLocalPlayerTick) cachedLocalPlayerTick = -1;
    cachedLocalPlayer = titan.state.client.localPlayer ?? null;
    cachedLocalPlayerTick = tick;
    return cachedLocalPlayer;
};

/** Releases the cached local-player handle. Called from onDisable so native
 *  Player handles don't persist across a toggle off/on (the JS module is not
 *  re-evaluated on toggle, so module-level state survives otherwise). */
export const resetLocalPlayerCache = (): void => {
    cachedLocalPlayer = null;
    cachedLocalPlayerTick = -1;
};

export function isPlayerIdle(bot: StarkMercher): boolean {
    const p = getLocalPlayer();
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
 * fields. Only uses "k" when the value is an exact multiple of 1000 (no
 * decimal needed — the GE input does not accept decimal "k" notation like
 * "1.8k"):
 *   18000 → "18k", 180000 → "180k", 1000 → "1k"
 *   1800 → "1800" (not a clean thousand, keep as-is)
 *   1251 → "1251", 100 → "100"
 * This shortens the number of keystrokes for humanised typing.
 */
export function formatGeInput(n: number): string {
    if (n >= 1000 && n % 1000 === 0) {
        // Exact thousands: 18000 → "18k", 1000 → "1k"
        return `${n / 1000}k`;
    }
    return String(n);
}

/** Packed widget id for the OSRS inventory tab button (group 161, child 62). */
const INVENTORY_TAB_PACKED = (161 << 16) | 62; // 10551358

/** Click the inventory tab widget if it is not already visible. Returns true
 *  when a click was attempted. Adapted from stark-mixology. */
export function ensureInventoryOpen(bot: StarkMercher): boolean {
    if (!titan.state.login.isLoggedIn || !titan.state.login.isWorldReady) return false;
    if (isInventoryOpen()) return false;
    const widget = titan.state.widgets.find(INVENTORY_TAB_PACKED);
    if (widget && widget.visible) {
        if (bot.logDebugValue) titan.log('[Stark Mercher] Inventory not open, clicking inventory tab');
        widget.interact(titan.MenuAction.CC_OP, 1, -1);
        return true;
    }
    return false;
}

/** Packed widget id for the OSRS world switcher root (group 69, child 0). */
const WORLD_SWITCHER_PACKED = (69 << 16) | 0;

/** True when the OSRS world switcher full-screen interface is open. */
export function isWorldSwitcherOpen(): boolean {
    try {
        const w = titan.state.widgets.find(WORLD_SWITCHER_PACKED);
        return !!(w && w.exists && w.visible);
    } catch {
        return false;
    }
}
