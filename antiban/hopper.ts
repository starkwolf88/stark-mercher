// ============================================================================
// World hopper — scheduled world hopping for anti-ban
// ============================================================================
// Adapted from stark-mixology's hopper. The bot hops to a random safe members
// world on a bimodal/burst interval (2–150 min). The hop timer is global (not
// per-account) — it is shared across account rotations and persisted to the
// hidden hopState setting so script reloads don't reset the schedule.
// Hopping pauses the auto-loop while the hop is in progress and for a short
// resume delay after.
//
// The hopper is simpler than mixology's: no stations, no levers, no batch
// tracking. The safe boundary only checks that the player is idle (not
// animating/moving) and has been idle for at least 2 ticks.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { sampleInt } from './session-profile.js';
import { isAtSafeBoundary, getSafeBoundaryReason } from './session.js';
import { invalidateMembersWorldCache, isGeOpen, isBankOpen, invalidateBooleanStateCache } from '../grand_exchange/widgets.js';
import { invalidateNearGeCache, invalidateEntityQueryCache } from '../grand_exchange/clerk.js';
import { invalidateLogoutDoorCache } from './logout.js';
import { resetInFlightActionState } from '../general/state.js';
import { resetLoginState } from './login.js';
import { sendKeyWithJitter } from './click-jitter.js';
import { getLocalPlayer } from '../general/helpers.js';

const TICKS_PER_MINUTE = 100;
const HOP_MAX_WAIT_MS = 45000;

// --- World list cache -------------------------------------------------------
// titan.state.world.list() returns the in-game world list (array of WorldInfo).
// The list only changes on a world hop or login/logout transition (the client
// re-fetches the list from the server). Caching it eliminates the per-call
// native array allocation in pickWorld(), which fires when a hop is due.
//
// Invalidated via invalidateWorldListCache() on: hop completion,
// onGameStateChanged (login/logout/hop), tick counter reset, and onDisable.
let cachedWorldList: titan.World[] | null = null;

/** Invalidates the cached world list. Call on hop completion,
 *  onGameStateChanged (login/logout/hop), tick counter reset, and onDisable
 *  so the next pickWorld call re-fetches the live list. */
export const invalidateWorldListCache = (): void => {
    cachedWorldList = null;
};

/** Returns the cached world list, populating it from a single
 *  titan.state.world.list() call on first access. */
const getWorldList = (): titan.World[] | null => {
    if (cachedWorldList) return cachedWorldList;
    cachedWorldList = titan.state.world.list();
    return cachedWorldList;
};

const HOP_REGION_ANY = 0;
const HOP_REGION_UK = 1;
const HOP_REGION_GERMANY = 2;
const HOP_REGION_US = 3;

const UNSAFE_ACTIVITY_SUBSTRINGS = [
    'f2p', 'free-to-play', 'free to play',
    'pvp', 'pvp arena',
    'deadman', 'dmm',
    'high risk',
    'speedrunning', 'speedrun',
    'skill total', 'total level', 'total world',
    'tournament', 'tourney',
    'beta', 'alpha',
    'fresh start', 'league', 'leagues',
    'special',
    'legacy',
];

function activityIsSafe(activity: string): boolean {
    const a = (activity || '').toLowerCase();
    return !UNSAFE_ACTIVITY_SUBSTRINGS.some(s => a.includes(s));
}

function regionMatches(region: string, setting: number): boolean {
    if (setting === HOP_REGION_ANY) return true;
    const r = (region || '').toLowerCase();
    switch (setting) {
        case HOP_REGION_UK:
            return r.includes('united kingdom') || r.includes('uk') || r.includes('britain') || r.includes('gb') || r.includes('great britain');
        case HOP_REGION_GERMANY:
            return r.includes('germany') || r.includes('de') || r.includes('deutschland');
        case HOP_REGION_US:
            return r.includes('united states') || r.includes('usa') || r.includes('us') || r.includes('america');
        default:
            return true;
    }
}

function isWorldSafe(world: any, meta: any, f2pMode: boolean): { safe: boolean; reason?: string } {
    // F2P mode (autoMode === 3) must hop to F2P worlds; members accounts
    // hop to members worlds. Hopping to a world the account can't access
    // leaves the client stuck on the login screen after the hop.
    if (f2pMode) {
        if (world.isMembers) return { safe: false, reason: 'members world (F2P mode)' };
    } else {
        if (!world.isMembers) return { safe: false, reason: 'not members (F2P)' };
    }
    if (world.isBeta) return { safe: false, reason: 'beta world' };
    if (!meta) return { safe: false, reason: 'no metadata' };
    if (meta.population < 0) return { safe: false, reason: 'population unknown' };
    if (!activityIsSafe(meta.activity)) return { safe: false, reason: `unsafe activity: ${meta.activity}` };
    return { safe: true };
}

function debugLog(bot: StarkMercher, fmt: string, ...args: any[]): void {
    if (bot.logDebugValue) titan.logf('[Stark Mercher] ' + fmt, ...args);
}

function humanLog(bot: StarkMercher, fmt: string, ...args: any[]): void {
    if (bot.logInfoValue) titan.logf('[Stark Mercher] ' + fmt, ...args);
}

/** Pick a safe, live world in the chosen region. */
function pickWorld(bot: StarkMercher): number | null {
    const current = titan.state.world.current();
    const list = getWorldList();
    if (!list || list.length === 0) {
        debugLog(bot, 'No in-game world list available for hopping');
        return null;
    }

    const meta = titan.state.world.metadata() || [];
    const metaById = new Map<number, any>(meta.map((m: any) => [m.id, m]));
    const regionSetting = bot.hopRegion?.value ?? 0;
    const f2pMode = bot.autoModeValue === 3;

    const candidates: number[] = [];
    for (const world of list) {
        if (world.id === current) continue;
        const m = metaById.get(world.id);
        const safe = isWorldSafe(world, m, f2pMode);
        if (!safe.safe) continue;
        if (!m) continue;
        if (!regionMatches(m.region, regionSetting)) continue;
        candidates.push(world.id);
    }

    if (candidates.length === 0) {
        debugLog(bot, 'No candidate worlds available for hopping');
        return null;
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const pickMeta = metaById.get(pick);
    humanLog(bot, 'Hopping to world %d (region=%s, activity=%s, population=%d)',
        pick, pickMeta?.region || 'unknown', pickMeta?.activity || 'unknown', pickMeta?.population ?? -1);
    return pick;
}

/** Sample a hop interval in minutes using a bimodal/burst distribution.
 *  Global (not per-account) — the hop timer is shared across account
 *  rotations.
 *
 *  Distribution:
 *    - 70% "normal":  15–60 min (routine hop)
 *    - 20% "burst":   2–8 min  (annoyed, hopping again soon)
 *    - 10% "long":    60–150 min (settled in, not hopping for a while)
 *
 *  After a burst hop, the next interval has a 50% chance of being another
 *  burst, simulating the human pattern of hopping 2–3 times in quick
 *  succession (e.g. crowded world → hop → still bad → hop again → fine).
 *  This replaces the old flat 5–45 min uniform distribution, which produced
 *  a statistically uniform hop pattern that doesn't match any human reason
 *  for hopping. */
function sampleHopInterval(wasBurst: boolean): number {
    const r = Math.random();
    // If the previous hop was a burst, 50% chance of another burst
    if (wasBurst && r < 0.50) {
        return sampleInt(Math.random, 2, 8);
    }
    if (r < 0.20) {
        return sampleInt(Math.random, 2, 8);   // burst
    }
    if (r < 0.90) {
        return sampleInt(Math.random, 15, 60); // normal
    }
    return sampleInt(Math.random, 60, 150);    // long
}

/** Persist the global hop timer to the hidden setting so it survives
 *  script reloads. Called whenever nextHopAtMs or hopCount changes. */
function saveHopState(bot: StarkMercher): void {
    try {
        const state = {
            nextHopAtMs: bot.nextHopAtMs,
            hopCount: bot.hopCount,
        };
        bot.hopStateSetting.value = JSON.stringify(state);
    } catch {
        // Setting write failures are non-fatal — the in-memory timer
        // still works; we just lose reload persistence.
    }
}

function sampleHopCooldown(bot: StarkMercher): number {
    const h = bot.sessionProfile?.hopping;
    if (h && h.cooldownMinTicks > 0 && h.cooldownMaxTicks > 0) {
        return sampleInt(Math.random, h.cooldownMinTicks, h.cooldownMaxTicks);
    }
    return sampleInt(Math.random, 25, 35);
}

function sampleHopResumeMs(bot: StarkMercher): number {
    const h = bot.sessionProfile?.hopping;
    if (h && h.resumeMinMs > 0 && h.resumeMaxMs > 0) {
        return sampleInt(Math.random, h.resumeMinMs, h.resumeMaxMs);
    }
    return sampleInt(Math.random, 3000, 5000);
}

function scheduleNextHop(bot: StarkMercher, tick: number): void {
    if (!bot.sessionProfile) {
        bot.nextHopTick = -1;
        bot.nextHopAtMs = -1;
        bot.nextHopStartAtMs = -1;
        bot.nextHopTargetTicks = -1;
        return;
    }
    const minutes = sampleHopInterval(bot.lastHopWasBurst);
    // Track whether this scheduled interval is a burst, so the next
    // sampleHopInterval call can bias toward another burst.
    bot.lastHopWasBurst = minutes <= 8;
    const now = Date.now();
    bot.nextHopTick = tick + minutes * TICKS_PER_MINUTE;
    bot.nextHopAtMs = now + minutes * 60000;
    bot.nextHopStartAtMs = now;
    bot.nextHopTargetTicks = minutes * TICKS_PER_MINUTE;
    bot.nextHopPausedRemainingMs = -1;
    bot.hopInProgress = false;
    bot.hopSawLoggedOut = false;
    bot.forceHopPending = false;
    saveHopState(bot);
    debugLog(bot, 'Next world hop scheduled for tick %d (%d minutes from now)%s',
        bot.nextHopTick, minutes, bot.lastHopWasBurst ? ' [burst]' : '');
}

/** Complete a world hop that has already been dispatched. */
export function completeHop(bot: StarkMercher, tick: number): void {
    if (!bot.hopInProgress) return;

    const gameState = titan.state.login.state;
    const isLoggedIn = titan.state.login.isLoggedIn;
    const isWorldReady = titan.state.login.isWorldReady;

    if (gameState !== titan.LoginGameState.LoggedIn || !isLoggedIn || !isWorldReady) {
        bot.hopSawLoggedOut = true;
        return;
    }

    if (!bot.hopSawLoggedOut) return;

    const currentWorld = titan.state.world.current();
    if ((currentWorld !== null && currentWorld !== bot.hopToWorldId) || !getLocalPlayer()) {
        return;
    }

    bot.hopInProgress = false;
    bot.hopSawLoggedOut = false;
    bot.forceHopPending = false;
    bot.hopToWorldId = -1;
    bot.lastHopTick = -1;
    bot.lastHopMs = -1;
    bot.hopCooldownTick = tick;
    bot.hopCooldownTicks = sampleHopCooldown(bot);
    scheduleNextHop(bot, tick);
    const resumeMs = sampleHopResumeMs(bot);
    bot.hopResumeAtMs = Date.now() + resumeMs;
    resetLoginState(bot);
    resetInFlightActionState(bot);
    bot.inventoryOpenEnsured = false;
    bot.hopJustCompleted = true;
    bot.hopJustCompletedAtMs = Date.now();
    // Invalidate the cached isMembersWorld() result — the world may have
    // changed (e.g. hopped from a members to F2P world or vice versa).
    invalidateMembersWorldCache();
    invalidateBooleanStateCache();
    invalidateNearGeCache();
    // Invalidate the cached entity queries (GE clerks, GE booths, logout
    // door) and the cached world list — the scene reloaded on the hop.
    invalidateEntityQueryCache();
    invalidateLogoutDoorCache();
    invalidateWorldListCache();
    bot.hopCount++;
    saveHopState(bot);
    humanLog(bot, 'World hop completed, waiting %d ms before resuming', resumeMs);
}

export function cancelHop(bot: StarkMercher, tick: number, reason: string): void {
    bot.hopInProgress = false;
    bot.hopSawLoggedOut = false;
    bot.forceHopPending = false;
    bot.hopToWorldId = -1;
    bot.lastHopTick = -1;
    bot.lastHopMs = -1;
    bot.hopCooldownTick = tick;
    bot.hopCooldownTicks = sampleHopCooldown(bot);
    bot.nextHopTick = tick + bot.hopCooldownTicks;
    bot.nextHopAtMs = Date.now() + bot.hopCooldownTicks * 600;
    // Safety net: the native hopIngame() call is fire-and-forget — it may
    // still be executing its door/world-switcher click sequence after we
    // cancel on the JS side (e.g. when the world switcher is blocked by a
    // busy action). Pausing the auto-loop for 3s prevents it from
    // immediately trying to open the GE while those lingering native clicks
    // are still landing, which caused click spam in logs (door + world
    // switcher clicks interleaved with GE-open clicks).
    bot.hopResumeAtMs = Date.now() + 3000;
    saveHopState(bot);
    humanLog(bot, '%s; next hop in %d ticks', reason, bot.hopCooldownTicks);
}

function stripTags(text: string): string {
    return text.replace(/<[^>]+>/g, '');
}

/** Chat listener for the world hopper. */
export function onChatMessage(bot: StarkMercher, event: titan.ChatMessageEvent): void {
    if (!bot.hopInProgress) return;
    const text = stripTags(event.message || '').toLowerCase();
    if (text.includes('finish what you\'re doing') && text.includes('world switcher')) {
        cancelHop(bot, titan.state.client.tick, 'World switcher blocked by a busy action; giving up this hop');
    }
}

/**
 * Called once per tick from tickLogic. Returns true when a hop is in progress
 * or being dispatched, and the normal action loop should be skipped.
 */
export function hopStep(bot: StarkMercher, tick: number): boolean {
    if (!bot.hopWorlds || (!bot.hopWorldsValue && !bot.forceHopPending)) return false;
    if (bot.breakPhase !== 'none') return false;
    if (!bot.sessionProfile) return false;

    const scheduledHopDue = !bot.hopInProgress && bot.nextHopAtMs >= 0 && Date.now() >= bot.nextHopAtMs;
    if (scheduledHopDue) {
        bot.forceHopPending = true;
    }

    if (bot.hopCooldownTick > 0 && tick - bot.hopCooldownTick < bot.hopCooldownTicks) {
        return false;
    }

    if (bot.hopInProgress) {
        const hopElapsedMs = bot.lastHopMs > 0 ? Date.now() - bot.lastHopMs : 0;
        if (hopElapsedMs > HOP_MAX_WAIT_MS) {
            cancelHop(bot, tick, `World hop timed out after ${Math.round(hopElapsedMs / 1000)}s; giving up this hop and resuming`);
            return false;
        }

        const gameState = titan.state.login.state;
        const isLoggedIn = titan.state.login.isLoggedIn;
        const isWorldReady = titan.state.login.isWorldReady;

        if (gameState !== titan.LoginGameState.LoggedIn || !isLoggedIn || !isWorldReady) {
            bot.hopSawLoggedOut = true;
            debugLog(bot, 'Waiting for world hop to complete (state=%d, isLoggedIn=%s, isWorldReady=%s, sawLogout=%s)',
                gameState, isLoggedIn, isWorldReady, bot.hopSawLoggedOut);
            return true;
        }

        if (!bot.hopSawLoggedOut) {
            debugLog(bot, 'World hop dispatched, waiting for client to leave current world (state=%d)', gameState);
            return true;
        }

        completeHop(bot, tick);
        return true;
    }

    if (!titan.state.login.isLoggedIn || !titan.state.login.isWorldReady) {
        return false;
    }

    if (bot.nextHopAtMs < 0) {
        scheduleNextHop(bot, tick);
        return false;
    }

    if (Date.now() < bot.nextHopAtMs) return false;
    if (!isAtSafeBoundary(bot)) {
        const reason = getSafeBoundaryReason(bot);
        if (reason && tick % 10 === 0) {
            debugLog(bot, 'Hop due but not safe: reason=%s', reason);
        }
        return false;
    }

    // Close GE interface before hopping — the world switcher is blocked by
    // a "busy action" if the GE interface is open, causing the hop to fail
    // and the native hopIngame() sequence to spam door/world-switcher clicks
    // that conflict with the auto-loop. Escape is a safe synchronous close.
    if (isGeOpen()) {
        if (tick % 5 === 0) debugLog(bot, 'Hop safe but GE is open; closing with Escape');
        sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Escape), { reason: 'close GE for hop' });
        return true;
    }

    // Close bank interface before hopping — same reason as GE above.
    if (isBankOpen()) {
        if (tick % 5 === 0) debugLog(bot, 'Hop safe but bank is open; closing with Escape');
        sendKeyWithJitter(() => titan.keyboard.sendKey(titan.keyboard.Key.Escape), { reason: 'close bank for hop' });
        return true;
    }

    const worldId = pickWorld(bot);
    if (!worldId) {
        debugLog(bot, 'Hop safe but no candidate world found; scheduling retry in %d ticks', bot.hopCooldownTicks);
        bot.forceHopPending = false;
        bot.hopCooldownTick = tick;
        bot.hopCooldownTicks = sampleHopCooldown(bot);
        const cooldownMs = bot.hopCooldownTicks * 600;
        bot.nextHopTick = tick + bot.hopCooldownTicks;
        bot.nextHopAtMs = Date.now() + cooldownMs;
        saveHopState(bot);
        return false;
    }

    const accepted = titan.state.world.hopIngame(worldId);
    if (!accepted) {
        humanLog(bot, 'World hop to %d was not accepted; rescheduling next hop and resuming', worldId);
        bot.forceHopPending = false;
        bot.hopInProgress = false;
        bot.hopSawLoggedOut = false;
        bot.hopToWorldId = -1;
        scheduleNextHop(bot, tick);
        return false;
    }

    bot.hopToWorldId = worldId;
    bot.hopInProgress = true;
    bot.hopSawLoggedOut = false;
    bot.lastHopTick = tick;
    bot.lastHopMs = Date.now();
    bot.hopCooldownTick = tick;
    humanLog(bot, 'World hop dispatched to %d', worldId);
    return true;
}
