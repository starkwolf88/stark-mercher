// ============================================================================
// Session/break state machine — short logout breaks + nightly sleep
// ============================================================================
// The mercher's break pattern is unique:
//
//   - SHORT LOGOUT BREAKS: When the auto-loop has nothing to do (all slots
//     occupied, nothing to collect/sell/buy), the bot logs out for 2–5 min
//     (base) with per-profile variance of ±1 min. 10% chance of +1–5 min,
//     1% chance of another +1–5 min.
//
//   - NIGHTLY SLEEP: Per-account profile with sleep 3.5–6.5h, wake 06:30–
//     07:30 (with variance, late-wake chance, weekend shift). Uses a
//     WAKE-FIRST approach: wake time is sampled first, then bedtime =
//     wake − sleep duration.
//
// Both break types log out the player. GE offers continue filling while
// logged out. After the break duration elapses (wall-clock), the bot logs
// back in via antiban/login.ts and resumes the auto-loop.
//
// breakStep() is called at the top of tickLogic. It returns true when the
// normal auto-loop should be skipped (during logout, while waiting to log
// out, or while waiting to log back in).
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import type { SessionProfile } from './session-profile.js';
import { loadOrCreateSessionProfile, formatTime } from './session-profile.js';
import { logoutForBreak, resetLogoutState } from './logout.js';
import { loginStep, resetLoginState } from './login.js';

const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 1440 * MS_PER_MINUTE;
const FOUR_HOURS_MS = 4 * 60 * MS_PER_MINUTE;

// --- UK time helpers (same as mixology) -------------------------------------

interface UKDateParts {
    weekday: number;   // 0=Sun, 6=Sat
    hour: number;
    minute: number;
    second: number;
}

function getUKOffsetMinutes(d: Date): number {
    // UK uses GMT (UTC+0) in winter, BST (UTC+1) in summer.
    // We compute the offset by comparing the UTC time with the local time
    // of the UK. Since Titan runs on the user's machine, we use the
    // system's UTC offset and the date to determine BST.
    // BST starts: last Sunday of March. Ends: last Sunday of October.
    const year = d.getUTCFullYear();
    // Find last Sunday of March
    let bstStart = new Date(Date.UTC(year, 2, 31));
    while (bstStart.getUTCDay() !== 0) bstStart = new Date(bstStart.getTime() - MS_PER_DAY);
    // Find last Sunday of October
    let bstEnd = new Date(Date.UTC(year, 9, 31));
    while (bstEnd.getUTCDay() !== 0) bstEnd = new Date(bstEnd.getTime() - MS_PER_DAY);
    const bstStartMs = bstStart.getTime();
    const bstEndMs = bstEnd.getTime();
    const nowMs = d.getTime();
    return (nowMs >= bstStartMs && nowMs < bstEndMs) ? 60 : 0;
}

function getUKParts(d: Date = new Date()): UKDateParts {
    const offsetMs = getUKOffsetMinutes(d) * MS_PER_MINUTE;
    const uk = new Date(d.getTime() + offsetMs);
    // JS getUTCDay: 0=Sun, 6=Sat — matches our weekday convention
    return {
        weekday: uk.getUTCDay(),
        hour: uk.getUTCHours(),
        minute: uk.getUTCMinutes(),
        second: uk.getUTCSeconds(),
    };
}

function getUKMidnightMs(ms: number): number {
    const p = getUKParts(new Date(ms));
    const wholeSeconds = Math.floor(ms / 1000) * 1000;
    return wholeSeconds - (p.hour * 60 + p.minute) * MS_PER_MINUTE - p.second * 1000;
}

// --- Break phase ------------------------------------------------------------

export type BreakPhase = 'none' | 'logging_out' | 'logged_out' | 'logging_in';

// --- Short break duration sampling ------------------------------------------

function sampleShortBreakDuration(bot: StarkMercher): number {
    const profile = bot.sessionProfile;
    if (!profile) return sampleInt(2, 5) * MS_PER_MINUTE;

    // Base: 2–5 min + per-profile variance (1 min)
    const base = sampleInt(profile.shortBreakBaseMin, profile.shortBreakBaseMax);
    const variance = sampleInt(profile.shortBreakVarianceMin, profile.shortBreakVarianceMax);
    let total = base + variance;

    // 10% chance of +1–5 min
    if (Math.random() < profile.longTailChance) {
        total += sampleInt(profile.longTailMin, profile.longTailMax);
        // 10% of that 10% (= 1%) chance of another +1–5 min
        if (Math.random() < profile.longTailNestedChance) {
            total += sampleInt(profile.longTailMin, profile.longTailMax);
        }
    }

    return total * MS_PER_MINUTE;
}

// --- Nightly sleep sampling (wake-first) ------------------------------------

function sampleNightlySleepMinutes(bot: StarkMercher): number {
    const profile = bot.sessionProfile;
    if (!profile) return 300; // 5h default

    // 5% outlier: longer sleep (5–7h = 300–420 min)
    if (Math.random() < 0.05) {
        return sampleInt(300, 420);
    }

    const base = profile.nightlySleepLengthBase;
    const variance = profile.nightlySleepLengthVariance;
    // Cap variance so it can't push past 420 min (7h)
    const effectiveVariance = Math.min(variance, 420 - base);
    return base + sampleInt(0, Math.max(0, effectiveVariance));
}

function sampleNightlyWakeMinutes(bot: StarkMercher, weekday: number): number {
    const profile = bot.sessionProfile;
    if (!profile) return 420; // 07:00 default

    // Base wake time + variance
    let wake = profile.nightlyWakeBase + sampleInt(-profile.nightlyWakeVariance, profile.nightlyWakeVariance);

    // 10% chance of late wake
    if (Math.random() < profile.nightlyWakeLateChance) {
        wake += sampleInt(30, profile.nightlyWakeLateExtraMin);
    }

    // Weekend shift (Fri=5, Sat=6) for late-weekend profiles
    const isWeekend = weekday === 5 || weekday === 6;
    if (isWeekend && profile.nightlyWeekendLate) {
        wake += profile.nightlyWeekendWakeShift;
    }

    return wake % 1440;
}

// --- Nightly break scheduling -----------------------------------------------

function scheduleNextNightlyBreak(bot: StarkMercher): number {
    const profile = bot.sessionProfile;
    if (!profile) return Infinity;

    const p = getUKParts();
    const nowMs = Date.now();
    const sleepMinutes = sampleNightlySleepMinutes(bot);
    const wakeMinutes = sampleNightlyWakeMinutes(bot, p.weekday);

    const midnight = nowMs - (p.hour * 60 + p.minute) * MS_PER_MINUTE - p.second * 1000;
    const todayWake = midnight + wakeMinutes * MS_PER_MINUTE;
    const todayBed = todayWake - sleepMinutes * MS_PER_MINUTE; // may be negative = yesterday
    const sleepMs = sleepMinutes * MS_PER_MINUTE;

    // Determine the target bedtime
    let targetMs: number;

    // Check if we're currently inside a sleep window
    const finishedToday = bot.nightlyBreakFinished === midnight;
    const yesterdayMidnight = midnight - MS_PER_DAY;
    const finishedYesterday = bot.nightlyBreakFinished === yesterdayMidnight;

    if (!finishedYesterday && nowMs >= todayBed && nowMs < todayBed + sleepMs) {
        // Inside last night's sleep window (bedtime was yesterday/today, wake is today)
        targetMs = todayBed;
    } else if (!finishedToday && nowMs >= todayBed && nowMs < todayBed + sleepMs) {
        // Inside tonight's sleep window
        targetMs = todayBed;
    } else if (nowMs < todayBed) {
        // Bedtime later today
        targetMs = todayBed;
    } else {
        // Tonight's sleep has finished; schedule tomorrow
        targetMs = todayBed + MS_PER_DAY;
    }

    bot.nightlyBreakTargetTime = targetMs;
    bot.nightlySleepMinutes = sleepMinutes;

    const bed = new Date(targetMs);
    const wake = new Date(targetMs + sleepMs);
    titan.logf('[Stark Mercher] Scheduled nightly sleep: %s to %s (%d min)',
        bed.toISOString(), wake.toISOString(), sleepMinutes);
    return targetMs;
}

function isNightlyBreakDue(bot: StarkMercher): boolean {
    const profile = bot.sessionProfile;
    if (!profile) return false;

    if (bot.nightlyBreakTargetTime < 0) {
        scheduleNextNightlyBreak(bot);
    }
    if (bot.nightlySleepMinutes <= 0) {
        bot.nightlySleepMinutes = sampleNightlySleepMinutes(bot);
    }

    const now = Date.now();
    const sleepMs = bot.nightlySleepMinutes * MS_PER_MINUTE;

    // If the stored target is in the future, check if we're actually inside
    // the previous night's sleep window.
    if (now < bot.nightlyBreakTargetTime) {
        const yesterdayTarget = bot.nightlyBreakTargetTime - MS_PER_DAY;
        const yesterdayMidnight = getUKMidnightMs(yesterdayTarget);
        if (bot.nightlyBreakFinished === yesterdayMidnight) {
            return false; // already woke from that sleep
        }
        if (now >= yesterdayTarget && now < yesterdayTarget + sleepMs) {
            bot.nightlyBreakTargetTime = yesterdayTarget;
            titan.logf('[Stark Mercher] Nightly break: adjusted target back by one day (now in sleep window)');
        } else {
            return false; // not due yet
        }
    }

    const wakeTime = bot.nightlyBreakTargetTime + sleepMs;
    if (now < wakeTime) return true; // still within sleep window

    // Sleep window has passed; schedule next night
    scheduleNextNightlyBreak(bot);
    return false;
}

// --- Helpers ----------------------------------------------------------------

function sampleInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function debugLog(bot: StarkMercher, msg: string): void {
    if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg);
}

function humanLog(bot: StarkMercher, msg: string, ...args: unknown[]): void {
    titan.logf('[Stark Mercher] ' + msg, ...args);
}

// --- Public API -------------------------------------------------------------

/** Initialize session profile for the current account. Called on enable / login. */
export function initSessionProfile(bot: StarkMercher): void {
    const playerName = titan.state.client.localPlayer?.name;
    if (!playerName) {
        debugLog(bot, 'initSessionProfile: no player name, skipping');
        return;
    }
    bot.currentPlayerName = playerName;
    bot.sessionProfile = loadOrCreateSessionProfile(bot, playerName);
}

/** Reset all break/login state. Called on enable. */
export function resetBreakState(bot: StarkMercher): void {
    bot.breakPhase = 'none';
    bot.breakType = 'none';
    bot.breakStartMs = 0;
    bot.breakTargetEndMs = 0;
    bot.nightlyBreakTargetTime = -1;
    bot.nightlySleepMinutes = -1;
    bot.nightlyBreakFinished = -1;
    bot.loopIdleForBreak = false;
    bot.currentPlayerName = '';
    bot.sessionProfile = null;
    bot.unexpectedLogoutAtMs = 0;
    resetLogoutState(bot);
    resetLoginState(bot);
}

/**
 * Main break entry point. Called at the top of tickLogic.
 * Returns true when the normal auto-loop should be skipped.
 */
export function breakStep(bot: StarkMercher, tick: number): boolean {
    if (bot.terminated) return true;

    // Ensure profile is loaded
    if (!bot.sessionProfile && titan.state.client.localPlayer?.name) {
        initSessionProfile(bot);
    }

    const now = Date.now();
    const playerName = titan.state.client.localPlayer?.name;

    // --- Handle logged-out states ---
    if (!playerName || !titan.state.login.isLoggedIn) {
        // We're logged out. Check if we're in an active break.
        if (bot.breakPhase === 'logging_out' || bot.breakPhase === 'logged_out') {
            // Logout complete — transition to logged_out
            if (bot.logoutComplete) {
                bot.breakPhase = 'logged_out';
                debugLog(bot, `Break: logged out, waiting until ${new Date(bot.breakTargetEndMs).toISOString()}`);
            }

            // Check if break duration has elapsed
            if (bot.breakPhase === 'logged_out' && now >= bot.breakTargetEndMs) {
                // Break is over — start logging in
                bot.breakPhase = 'logging_in';
                resetLogoutState(bot);
                resetLoginState(bot);
                humanLog(bot, 'Break ended (%s), logging back in', bot.breakType);
            }

            // If still waiting, just return true (skip auto-loop)
            if (bot.breakPhase === 'logging_out') {
                // Still trying to log out — dispatch logout
                logoutForBreak(bot, bot.breakType);
            }
            return true;
        }

        // Not in a break but logged out — could be unexpected logout
        if (bot.breakPhase === 'logging_in') {
            // Trying to log back in after a break
            loginStep(bot);
            // Check if login succeeded
            if (isInWorld()) {
                bot.breakPhase = 'none';
                bot.breakType = 'none';
                bot.loopIdleForBreak = false;
                resetLoginState(bot);
                humanLog(bot, 'Logged back in, resuming auto-loop');
            }
            return true;
        }

        // Unexpected logout — try to log back in
        if (bot.unexpectedLogoutAtMs === 0) {
            bot.unexpectedLogoutAtMs = now;
        }
        // After 5 seconds, start trying to log in
        if (now - bot.unexpectedLogoutAtMs > 5000) {
            loginStep(bot);
        }
        return true;
    }

    // --- Player is logged in ---

    // Clear unexpected logout
    if (bot.unexpectedLogoutAtMs > 0) {
        bot.unexpectedLogoutAtMs = 0;
        // If we were in a logging_in phase, clear it
        if (bot.breakPhase === 'logging_in') {
            bot.breakPhase = 'none';
            bot.breakType = 'none';
            bot.loopIdleForBreak = false;
            resetLoginState(bot);
        }
    }

    // Check if we just logged back in after a break
    if (bot.breakPhase === 'logging_in') {
        if (isInWorld()) {
            bot.breakPhase = 'none';
            bot.breakType = 'none';
            bot.loopIdleForBreak = false;
            resetLoginState(bot);
            humanLog(bot, 'Logged back in, resuming auto-loop');
        }
        return true;
    }

    // --- Check for nightly break ---
    if (isNightlyBreakDue(bot)) {
        if (bot.breakPhase === 'none') {
            // Start nightly break
            bot.breakPhase = 'logging_out';
            bot.breakType = 'nightly';
            bot.breakStartMs = now;
            bot.breakTargetEndMs = bot.nightlyBreakTargetTime + (bot.nightlySleepMinutes * MS_PER_MINUTE);
            bot.loopIdleForBreak = false;
            resetLogoutState(bot);
            const wakeTime = new Date(bot.breakTargetEndMs);
            humanLog(bot, 'Nightly sleep starting — wake at %s (%d min sleep)',
                wakeTime.toISOString(), bot.nightlySleepMinutes);
        }
        // While logging out, dispatch logout
        if (bot.breakPhase === 'logging_out') {
            logoutForBreak(bot, 'nightly');
        }
        return true;
    }

    // --- Check for short logout break ---
    // Only take a short break if:
    //   1. We're not already in a break
    //   2. The auto-loop has signalled it's idle (nothing to do)
    //   3. Auto mode is enabled
    if (bot.breakPhase === 'none' && bot.loopIdleForBreak && bot.autoMode.value === 1) {
        const duration = sampleShortBreakDuration(bot);
        bot.breakPhase = 'logging_out';
        bot.breakType = 'short';
        bot.breakStartMs = now;
        bot.breakTargetEndMs = now + duration;
        bot.loopIdleForBreak = false;
        resetLogoutState(bot);
        humanLog(bot, 'Short break starting — %d min logout', Math.round(duration / MS_PER_MINUTE));
        logoutForBreak(bot, 'short');
        return true;
    }

    // If we're in a logging_out phase but still logged in, keep trying
    if (bot.breakPhase === 'logging_out') {
        logoutForBreak(bot, bot.breakType);
        return true;
    }

    return false;
}

/** Called from onMainLoop — handles login/logout dispatch while logged out. */
export function wallClockStep(bot: StarkMercher): void {
    if (bot.terminated) return;

    const now = Date.now();
    const playerName = titan.state.client.localPlayer?.name;

    // If logged out and in a break, check if break is over
    if (!playerName || !titan.state.login.isLoggedIn) {
        if (bot.breakPhase === 'logged_out' && now >= bot.breakTargetEndMs) {
            bot.breakPhase = 'logging_in';
            resetLogoutState(bot);
            resetLoginState(bot);
            humanLog(bot, 'Break ended (%s), logging back in', bot.breakType);
        }

        if (bot.breakPhase === 'logging_out') {
            logoutForBreak(bot, bot.breakType, true);
        }

        if (bot.breakPhase === 'logging_in' || (bot.unexpectedLogoutAtMs > 0 && now - bot.unexpectedLogoutAtMs > 5000)) {
            loginStep(bot);
        }
    }
}

/** Mark the nightly break as finished (called when the bot wakes from nightly sleep). */
export function markNightlyBreakFinished(bot: StarkMercher): void {
    const wakeMs = bot.nightlyBreakTargetTime + (bot.nightlySleepMinutes * MS_PER_MINUTE);
    bot.nightlyBreakFinished = getUKMidnightMs(wakeMs);
}

function isInWorld(): boolean {
    return !!titan.state.client.localPlayer && titan.state.login.isWorldReady;
}
