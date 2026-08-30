// ============================================================================
// Click jitter — defers interact()/sendKey() to a client tick with reaction-time
// jitter so clicks don't land on exact game-tick boundaries (0/600/1200ms).
// ============================================================================
// Inspired by mixology's antiban/click-jitter.ts. The core idea:
// - Game ticks fire at 600ms intervals. If every click fires synchronously from
//   onGameTick(), every click timestamp is a multiple of 600ms — a detectable
//   periodicity signal over long sessions.
// - Client ticks fire at ~20ms intervals. Deferring the click to a client tick
//   with 0-N client ticks of reaction jitter moves the click off the 600ms
//   boundary: a click dispatched on game tick 100 might fire at 100.0, 100.04,
//   100.08, or 100.12 seconds instead of always exactly 100.0.
//
// Usage:
//   setClickJitterProfile(profile);  // once at startup (or use the delay profile)
//   clickWithJitter(() => widget.interact(57, 1), { reason: 'click buy slot' });
//   sendKeyWithJitter(() => titan.keyboard.sendKey(Key.Enter), { reason: 'submit search' });
//
// The profile is deterministic per account (same pattern as humanised-delay.ts).
// ============================================================================

import type { DelayProfile } from './humanised-delay.js';

export interface ClickJitterProfile {
    /** 0-4 client ticks of reaction-time jitter before each click. */
    reactionJitterClientTicks: number;
    /** 3-10% chance of a second click shortly after the first (for safe/idempotent targets). */
    doubleClickChance: number;
}

// --- Active profile (module-level) -----------------------------------------
let activeProfile: ClickJitterProfile | null = null;

const defaultProfile: ClickJitterProfile = {
    reactionJitterClientTicks: 2,
    doubleClickChance: 5,
};

export const setClickJitterProfile = (profile: ClickJitterProfile): void => {
    activeProfile = profile;
};

/**
 * Generate a click-jitter profile from a DelayProfile.
 * Uses the delay profile's reactionBias to derive the reaction jitter range
 * so a "fast" account gets less jitter and a "slow" account gets more.
 */
export const generateClickJitterProfile = (delayProfile: DelayProfile): ClickJitterProfile => {
    // reactionBias -1 (fast) → 1 client tick, +1 (slow) → 4 client ticks.
    const base = Math.round(2 + delayProfile.reactionBias * 1.5); // 0-4
    const reactionJitterClientTicks = Math.max(1, Math.min(4, base));
    // Double-click chance: 3-10%, derived from the delay profile's jitterTicks.
    const doubleClickChance = 3 + (delayProfile.jitterTicks / 2) * 3.5; // 3-10%
    return {
        reactionJitterClientTicks,
        doubleClickChance: Math.max(3, Math.min(10, doubleClickChance)),
    };
};

const getProfile = (): ClickJitterProfile => activeProfile ?? defaultProfile;

// --- PRNG ------------------------------------------------------------------
const roll = (): number => Math.random();
const sampleInt = (min: number, max: number): number =>
    Math.floor(roll() * (max - min + 1)) + min;

// --- Client tick scheduling ------------------------------------------------
/** Schedule a callback to run after a number of client ticks (~20ms each). */
function scheduleClientTick(cb: () => void, ticks: number): void {
    if (ticks <= 0) {
        titan.runOnClientTick(cb);
        return;
    }
    let remaining = ticks;
    const step = () => {
        remaining--;
        if (remaining <= 0) {
            cb();
        } else {
            titan.runOnClientTick(step);
        }
    };
    titan.runOnClientTick(step);
}

// --- Debug logging ---------------------------------------------------------
let debugLogFn: ((msg: string) => void) | null = null;

/** Set a debug log callback. When set, click/key dispatches are logged. */
export const setClickJitterDebugLog = (fn: ((msg: string) => void) | null): void => {
    debugLogFn = fn;
};

const debugLog = (msg: string): void => {
    if (debugLogFn) debugLogFn(msg);
};

// --- clickWithJitter() -----------------------------------------------------
export interface ClickWithJitterOptions {
    /** Allow a second click shortly after the first for safe, idempotent targets. */
    doubleClick?: boolean;
    /** Called if the first click was accepted (returned true). */
    onAccepted?: () => void;
    /** Called if the first click was not accepted (returned false or threw). */
    onRejected?: () => void;
    /** Short label for the debug log. */
    reason?: string;
}

/**
 * Dispatch an interact with human reaction-time jitter.
 * Fire-and-forget — callers should use onAccepted/onRejected callbacks
 * instead of relying on a synchronous return value.
 */
export function clickWithJitter(
    fn: () => boolean,
    options: ClickWithJitterOptions = {}
): void {
    const profile = getProfile();
    const jitter = sampleInt(0, Math.max(0, profile.reactionJitterClientTicks));

    const fire = () => {
        debugLog(`Click fired: ${options.reason || 'unknown'} (jitter=${jitter}ct)`);
        let ok: boolean;
        try {
            ok = fn();
        } catch (e) {
            // interact() can throw when the widget handle is stale or the
            // action is no longer available. Without this catch, the exception
            // is swallowed by the client tick handler and neither callback fires.
            debugLog(`Click threw for ${options.reason || 'unknown'}: ${String(e)}`);
            ok = false;
        }
        if (ok) {
            if (options.onAccepted) options.onAccepted();

            if (options.doubleClick && roll() * 100 < profile.doubleClickChance) {
                const doubleDelay = sampleInt(1, Math.max(1, profile.reactionJitterClientTicks));
                scheduleClientTick(() => {
                    try { fn(); } catch (e) { /* ignore double-click failure */ }
                }, doubleDelay);
            }
        } else {
            if (options.onRejected) options.onRejected();
        }
    };

    // Always defer to a client tick — never fire synchronously from onGameTick.
    scheduleClientTick(fire, jitter);
}

// --- sendKeyWithJitter() ---------------------------------------------------
export interface SendKeyWithJitterOptions {
    /** Short label for the debug log. */
    reason?: string;
    /** Called with the result (true/false) after the key is sent. */
    onResult?: (ok: boolean) => void;
}

/**
 * Dispatch a keyboard sendKey with human reaction-time jitter.
 * Keyboard timing is less detectable than mouse clicks (no position data),
 * but a human doesn't press Enter/Escape at the exact same millisecond after
 * a game state change every time. This applies the same reaction-jitter and
 * defers to a client tick so the key is not sent synchronously from the
 * game-tick thread. Fire-and-forget.
 */
export function sendKeyWithJitter(
    fn: () => boolean,
    options: SendKeyWithJitterOptions = {}
): void {
    const profile = getProfile();
    const jitter = sampleInt(0, Math.max(0, profile.reactionJitterClientTicks));

    const fire = () => {
        debugLog(`Key fired: ${options.reason || 'unknown'} (jitter=${jitter}ct)`);
        let ok: boolean;
        try {
            ok = fn();
        } catch (e) {
            debugLog(`Key threw for ${options.reason || 'unknown'}: ${String(e)}`);
            ok = false;
        }
        if (options.onResult) options.onResult(ok);
    };

    scheduleClientTick(fire, jitter);
}
