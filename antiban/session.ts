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
import { isPlayerIdle } from '../general/helpers.js';
import { cancelHop } from './hopper.js';
import { loadOfferCache } from '../general/state-persist.js';
import { getMerchHistory } from '../data/merch-history.js';
import { getAbortHistory } from '../data/abort-history.js';
import { isRotationEnabled, selectNextAccount, recordAccountLogout, recordAccountLogin, loadRotationIndex } from './account-rotation.js';

/** Dumps cache, merch history, and buy-freeze state to the log. Called
 *  automatically after each logout so the user can review state without
 *  clicking the log buttons manually. */
const dumpStateOnLogout = (bot: StarkMercher): void => {
    const accountName = bot.currentPlayerName || titan.state.client.localPlayer?.name || '';
    if (!accountName) {
        titan.log('[Stark Mercher] Cannot dump state on logout — no account name.');
        return;
    }

    // --- Offer cache ---
    const cache = loadOfferCache(bot, accountName);
    const cacheKeys = Object.keys(cache);
    if (cacheKeys.length === 0) {
        titan.logf('[Stark Mercher] Offer cache for %s is empty.', accountName);
    } else {
        titan.logf('[Stark Mercher] Offer cache for %s (%d entries):', accountName, cacheKeys.length);
        for (const key of cacheKeys) {
            const e = cache[key];
            const placed = new Date(e.offerPlacedAt).toISOString();
            const revisions = e.revisedPrices.join(' -> ');
            const totalBought = e.totalBought !== undefined ? `, totalBought=${e.totalBought}` : '';
            const firstBought = e.firstBoughtAt !== undefined ? `, firstBought=${new Date(e.firstBoughtAt).toISOString()}` : '';
            const limitReached = e.limitReachedAt !== undefined ? `, limitReachedAt=${new Date(e.limitReachedAt).toISOString()}` : '';
            const sellQty = e.sellQuantity !== undefined ? `, sellQty=${e.sellQuantity}` : '';
            titan.logf('[Stark Mercher]   %s: mode=%s, buy=%d, sell=%d (orig=%d), placed=%s, revisions=[%s]%s%s%s%s',
                key, e.mode, e.buyPrice, e.sellPrice, e.originalSellPrice, placed, revisions,
                totalBought, firstBought, limitReached, sellQty);
        }
        titan.logf('[Stark Mercher] Cache dump complete (%d entries).', cacheKeys.length);
    }

    // --- Merch history ---
    const history = getMerchHistory(bot, accountName);
    if (history.profits.length === 0 && history.losses.length === 0) {
        titan.logf('[Stark Mercher] No merch history for %s.', accountName);
    } else {
        titan.logf('[Stark Mercher] Merch history for %s:', accountName);
        if (history.profits.length > 0) {
            titan.logf('[Stark Mercher] === PROFITS (%d) ===', history.profits.length);
            let totalProfit = 0;
            for (const e of history.profits) {
                const revPrices = e.revisionPrices ? `, revPrices=[${e.revisionPrices.join(',')}]` : '';
                const sellTime = e.sellElapsedMin !== undefined ? `, sellElapsed=${e.sellElapsedMin}min` : '';
                const reqVsActual = e.requestedBuyQty !== undefined ? `, reqBuy=${e.requestedBuyQty}` : '';
                titan.logf('[Stark Mercher]   %s: qty=%d, profit=+%dgp, buy=%d, avgSold=%d, revisions=%d%s%s%s, date=%s',
                    e.item, e.qty, e.profit, e.buy, e.avgSold, e.revisions, reqVsActual, revPrices, sellTime, e.date);
                totalProfit += e.profit;
            }
            titan.logf('[Stark Mercher]   Total profit: +%dgp', totalProfit);
        }
        if (history.losses.length > 0) {
            titan.logf('[Stark Mercher] === LOSSES (%d) ===', history.losses.length);
            let totalLoss = 0;
            for (const e of history.losses) {
                const revPrices = e.revisionPrices ? `, revPrices=[${e.revisionPrices.join(',')}]` : '';
                const sellTime = e.sellElapsedMin !== undefined ? `, sellElapsed=${e.sellElapsedMin}min` : '';
                const reqVsActual = e.requestedBuyQty !== undefined ? `, reqBuy=${e.requestedBuyQty}` : '';
                titan.logf('[Stark Mercher]   %s: qty=%d, loss=%dgp, buy=%d, avgSold=%d, revisions=%d%s%s%s, date=%s',
                    e.item, e.qty, e.profit, e.buy, e.avgSold, e.revisions, reqVsActual, revPrices, sellTime, e.date);
                totalLoss += e.profit;
            }
            titan.logf('[Stark Mercher]   Total loss: %dgp', totalLoss);
        }
        titan.logf('[Stark Mercher] Merch history dump complete.');
    }

    // --- Abort history ---
    const aborts = getAbortHistory(bot, accountName);
    if (aborts.aborts.length === 0) {
        titan.logf('[Stark Mercher] No abort history for %s.', accountName);
    } else {
        titan.logf('[Stark Mercher] Abort history for %s (%d entries):', accountName, aborts.aborts.length);
        for (const a of aborts.aborts) {
            const cat = a.category ?? 'unknown';
            titan.logf('[Stark Mercher]   [%s] %s: %s req=%d filled=%d, elapsed=%s eta=%s, price=%d, reason="%s", date=%s',
                cat, a.item, a.type, a.requestedQty, a.filledQty, a.elapsedMin.toFixed(1) + 'min', a.etaMin.toFixed(1) + 'min', a.price, a.reason, a.date);
        }
        titan.logf('[Stark Mercher] Abort history dump complete.');
    }

    // --- Buy freezes (global, flat format; legacy nested supported for display) ---
    const freezeRaw = bot.buyFreezeSetting.value;
    if (!freezeRaw || freezeRaw === '{}') {
        titan.logf('[Stark Mercher] No buy freezes active.');
    } else {
        try {
            const parsed = JSON.parse(freezeRaw);
            if (!parsed || typeof parsed !== 'object') {
                titan.logf('[Stark Mercher] No buy freezes active.');
                return;
            }
            const now = Date.now();
            // Support both flat ({ item: until }) and legacy nested
            // ({ account: { item: until } }) formats for diagnostics.
            const values = Object.values(parsed);
            const isNested = values.length > 0 && values.every(v => v !== null && typeof v === 'object');
            let flat: Record<string, number>;
            if (isNested) {
                flat = {};
                for (const accountMap of values as Record<string, number>[]) {
                    if (!accountMap || typeof accountMap !== 'object') continue;
                    for (const [name, until] of Object.entries(accountMap)) {
                        if (typeof until !== 'number') continue;
                        const existing = flat[name];
                        if (!existing || until > existing) flat[name] = until;
                    }
                }
            } else {
                flat = parsed as Record<string, number>;
            }
            const items = Object.keys(flat);
            if (items.length === 0) {
                titan.logf('[Stark Mercher] No buy freezes active.');
                return;
            }
            const active = items.filter(name => flat[name] > now);
            const expired = items.length - active.length;
            titan.logf('[Stark Mercher] Buy freezes (%d active, %d expired):', active.length, expired);
            for (const name of active) {
                const until = flat[name];
                const minsLeft = Math.max(0, Math.ceil((until - now) / 60000));
                titan.logf('[Stark Mercher]   %s: expires in %d min (at %s)', name, minsLeft, new Date(until).toISOString());
            }
            titan.logf('[Stark Mercher] Buy freeze dump complete.');
        } catch (e) {
            titan.logf('[Stark Mercher] Failed to parse buy-freeze data: %s', String(e));
        }
    }
};

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

/** Format a UTC timestamp as HH:MM in UK local time (with DST). */
export function formatUKTime(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '-';
    const p = getUKParts(new Date(ms));
    const hour = p.hour.toString().padStart(2, '0');
    const minute = p.minute.toString().padStart(2, '0');
    return `${hour}:${minute}`;
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

// --- ETA-based break duration sampling --------------------------------------
// When the auto-loop goes idle with all slots occupied, it computes the
// minimum remaining time until the next action on any slot (earlier of
// completion or stale-abort threshold) and stores it in bot.nextActionEtaMin.
// This function converts that hint into a break duration. We target 50% of
// the ETA so the bot can check if anything bought/sold quicker than expected,
// with ±15% jitter so the return isn't precisely predictable. A randomized
// 1–2 min floor prevents anti-ban-unfriendly very short breaks; the 10 min
// ceiling ensures we return promptly if items buy quicker than expected.
// Falls back to sampleShortBreakDuration() when no ETA data is available.
const ETA_BREAK_RATIO = 0.5; // return at 50% of ETA
const ETA_BREAK_CEILING_MIN = 10;
const ETA_BREAK_JITTER = 0.15; // ±15%

function sampleEtaBasedBreakDuration(bot: StarkMercher): number {
    const etaMin = bot.nextActionEtaMin;
    if (etaMin <= 0) {
        return sampleShortBreakDuration(bot);
    }

    // Target 50% of the ETA so we can check for early completions.
    // Apply ±15% jitter so we don't return at a precisely predictable time.
    const jitterMultiplier = 1 + (Math.random() * 2 - 1) * ETA_BREAK_JITTER;
    let durationMin = etaMin * ETA_BREAK_RATIO * jitterMultiplier;

    // Randomized 1–2 min floor prevents anti-ban-unfriendly very short breaks.
    const floorMin = sampleInt(1, 2);
    durationMin = Math.max(floorMin, Math.min(ETA_BREAK_CEILING_MIN, durationMin));

    return Math.round(durationMin) * MS_PER_MINUTE;
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
    if (bot.doNotSleep?.value) return Infinity;
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
    if (bot.doNotSleep?.value) return false;
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

// --- Multi-character rotation helpers ---------------------------------------

/**
 * Select the next account to log in after a break ends.
 * When rotation is enabled (roster has 2+ names), delegates to
 * selectNextAccount() which iterates the roster checking sleep/break
 * eligibility. When rotation is disabled, returns the current account
 * name (same-account relogin — the original behavior).
 */
function selectNextAccountForLogin(bot: StarkMercher): string | null {
    if (!isRotationEnabled(bot)) {
        // Single-account mode — log back into the same account
        return bot.currentPlayerName || bot.lastActiveAccountSetting.value.trim() || null;
    }
    // Multi-account rotation — select next eligible account
    return selectNextAccount(bot);
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
    // Persist the last active account name so it can be used as a fallback
    // when the login snapshot doesn't have a displayName (e.g. account not
    // staged yet at script start while logged out).
    if (bot.lastActiveAccountSetting.value !== playerName) {
        bot.lastActiveAccountSetting.value = playerName;
    }
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
    bot.loopIdleSinceTick = -1;
    bot.shortBreakDelayTicks = -1;
    bot.nextActionEtaMin = -1;
    bot.sessionPlayStartMs = -1;
    bot.currentPlayerName = '';
    bot.sessionProfile = null;
    bot.unexpectedLogoutAtMs = 0;
    resetLogoutState(bot);
    resetLoginState(bot);
}

// --- Break state persistence -------------------------------------------------
// The break state (phase, target end time, nightly schedule, session start,
// unexpected logout timestamp) is persisted in a hidden JSON setting so it
// survives plugin restarts and hot reloads. Without this, a hot reload during
// a sleep or short break would reset the countdown and the bot would either
// log in immediately or show a wrong timer.

interface SavedBreakState {
    breakPhase: string;
    breakType: string;
    breakStartMs: number;
    breakTargetEndMs: number;
    nightlyBreakTargetTime: number;
    nightlySleepMinutes: number;
    nightlyBreakFinished: number;
    sessionPlayStartMs: number;
    unexpectedLogoutAtMs: number;
    savedAt: number;
}

/** Save the current break state to the hidden setting. Called at every
 *  break phase transition and when an unexpected logout is detected. */
export function saveBreakState(bot: StarkMercher): void {
    const state: SavedBreakState = {
        breakPhase: bot.breakPhase,
        breakType: bot.breakType,
        breakStartMs: bot.breakStartMs,
        breakTargetEndMs: bot.breakTargetEndMs,
        nightlyBreakTargetTime: bot.nightlyBreakTargetTime,
        nightlySleepMinutes: bot.nightlySleepMinutes,
        nightlyBreakFinished: bot.nightlyBreakFinished,
        sessionPlayStartMs: bot.sessionPlayStartMs,
        unexpectedLogoutAtMs: bot.unexpectedLogoutAtMs,
        savedAt: Date.now(),
    };
    try {
        bot.breakStateSetting.value = JSON.stringify(state);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save break state: %s', String(e));
    }
}

/** Clear the saved break state. Called when a break fully ends and the bot
 *  is back in-world and active. */
export function clearBreakState(bot: StarkMercher): void {
    if (bot.breakStateSetting.value !== '{}') {
        bot.breakStateSetting.value = '{}';
    }
}

/** Restore break state from the hidden setting. Called on enable / hot reload.
 *  If a valid saved state exists, restores it and returns true. Otherwise
 *  returns false (caller should call resetBreakState). */
export function restoreBreakState(bot: StarkMercher): boolean {
    const raw = bot.breakStateSetting.value;
    if (!raw || raw === '{}') return false;
    try {
        const s = JSON.parse(raw) as SavedBreakState;
        if (!s || typeof s.breakPhase !== 'string') return false;

        // Validate: if the break target has already passed and we're not
        // in a nightly sleep window, the saved state is stale — discard it.
        const now = Date.now();
        if (s.breakPhase === 'logged_out' && s.breakTargetEndMs > 0 && now >= s.breakTargetEndMs) {
            // The break was supposed to end in the past. If it was a nightly
            // sleep, check if we're still within the sleep window.
            if (s.breakType === 'nightly' && s.nightlyBreakTargetTime > 0) {
                const sleepMs = s.nightlySleepMinutes > 0 ? s.nightlySleepMinutes * MS_PER_MINUTE : 0;
                const wakeMs = s.nightlyBreakTargetTime + sleepMs;
                if (now >= wakeMs) {
                    // Sleep window has fully passed — discard.
                    clearBreakState(bot);
                    return false;
                }
            } else {
                // Short break target has passed — discard.
                clearBreakState(bot);
                return false;
            }
        }

        bot.breakPhase = s.breakPhase as typeof bot.breakPhase;
        bot.breakType = s.breakType as typeof bot.breakType;
        bot.breakStartMs = s.breakStartMs;
        bot.breakTargetEndMs = s.breakTargetEndMs;
        bot.nightlyBreakTargetTime = s.nightlyBreakTargetTime;
        bot.nightlySleepMinutes = s.nightlySleepMinutes;
        bot.nightlyBreakFinished = s.nightlyBreakFinished;
        bot.sessionPlayStartMs = s.sessionPlayStartMs;
        bot.unexpectedLogoutAtMs = s.unexpectedLogoutAtMs;

        // If we were in a logging_out phase, we're now logged out (the
        // plugin restarted), so transition to logged_out directly.
        if (bot.breakPhase === 'logging_out') {
            bot.breakPhase = 'logged_out';
            bot.logoutComplete = true;
        }

        titan.logf('[Stark Mercher] Restored break state: phase=%s, type=%s, targetEnd=%s',
            bot.breakPhase, bot.breakType,
            bot.breakTargetEndMs > 0 ? new Date(bot.breakTargetEndMs).toISOString() : '(none)');
        return true;
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to restore break state: %s', String(e));
        clearBreakState(bot);
        return false;
    }
}

/** Reset hop state (in-memory). Called on enable. Persisted timers are
 *  restored separately by loadHopState. */
export function resetHopState(bot: StarkMercher): void {
    bot.nextHopTick = -1;
    bot.nextHopAtMs = -1;
    bot.nextHopStartAtMs = -1;
    bot.nextHopTargetTicks = -1;
    bot.nextHopPausedRemainingMs = -1;
    bot.hopResumeAtMs = -1;
    bot.lastHopTick = -1;
    bot.lastHopMs = -1;
    bot.hopInProgress = false;
    bot.hopSawLoggedOut = false;
    bot.hopToWorldId = -1;
    bot.hopCooldownTick = -1;
    bot.hopCooldownTicks = Math.floor(Math.random() * 11) + 25;
    bot.forceHopPending = false;
    bot.hopJustCompleted = false;
    bot.hopJustCompletedAtMs = -1;
}

/** Reset the hop timer (button-triggered). Clears the scheduled next hop. */
export function resetHop(bot: StarkMercher): void {
    bot.nextHopAtMs = -1;
    bot.nextHopStartAtMs = -1;
    bot.nextHopTick = -1;
    bot.nextHopTargetTicks = -1;
    bot.nextHopPausedRemainingMs = -1;
    bot.hopCooldownTick = -1;
    bot.forceHopPending = false;
    titan.log('[Stark Mercher] Hop timer reset');
}

/** Force the next hop to become due immediately (button-triggered).
 *  The hop still waits for a safe boundary before dispatching. */
export function forceHop(bot: StarkMercher): void {
    if (bot.hopInProgress) {
        titan.log('[Stark Mercher] Hop already in progress — ignoring force hop');
        return;
    }
    const now = Date.now();
    const tick = titan.state.client.tick;
    bot.nextHopAtMs = now;
    bot.nextHopStartAtMs = now;
    bot.nextHopTick = tick;
    bot.nextHopTargetTicks = 0;
    bot.nextHopPausedRemainingMs = -1;
    bot.hopCooldownTick = -1;
    bot.forceHopPending = true;
    titan.log('[Stark Mercher] Hop forced — will dispatch at next safe boundary');
}

// --- Safe boundary (for hop dispatch) ----------------------------------------

const SAFE_BOUNDARY_IDLE_BUFFER_TICKS = 2;

/** Returns a reason string if not safe to hop, or null if safe. */
export function getSafeBoundaryReason(bot: StarkMercher): string | null {
    if (bot.hopInProgress) return 'hop in progress';
    if (!isPlayerIdle(bot)) return 'player not idle';
    const tick = titan.state.client.tick;
    if (bot.lastPlayerStationaryTick > 0 && tick - bot.lastPlayerStationaryTick < SAFE_BOUNDARY_IDLE_BUFFER_TICKS) {
        return 'player recently idle';
    }
    return null;
}

/** True when it's safe to dispatch a world hop. */
export function isAtSafeBoundary(bot: StarkMercher): boolean {
    return getSafeBoundaryReason(bot) === null;
}

/** True when tickLogic should pause new actions because a hop or break is
 *  pending and waiting to dispatch. */
export function shouldPauseForHopBoundary(bot: StarkMercher): boolean {
    if (bot.forceHopPending) return true;
    return false;
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
            // If Do Not Sleep was toggled ON while logged out for a nightly
            // break, resume immediately so the account can be logged back in.
            if (bot.doNotSleep?.value && bot.breakType === 'nightly') {
                humanLog(bot, 'Do Not Sleep enabled; aborting nightly break early');
                bot.breakPhase = 'logging_in';
                resetLogoutState(bot);
                resetLoginState(bot);
                saveBreakState(bot);
                loginStep(bot);
                return true;
            }
            // Logout complete — transition to logged_out
            if (bot.logoutComplete) {
                bot.breakPhase = 'logged_out';
                debugLog(bot, `Break: logged out, waiting until ${new Date(bot.breakTargetEndMs).toISOString()}`);
                saveBreakState(bot);
                dumpStateOnLogout(bot);
            }

            // Check if break duration has elapsed
            if (bot.breakPhase === 'logged_out' && now >= bot.breakTargetEndMs) {
                // Break is over — start logging in.
                // With multi-account rotation, select the next eligible
                // account from the roster instead of logging back into the
                // same account.
                const nextAccount = selectNextAccountForLogin(bot);
                if (nextAccount) {
                    if (nextAccount !== bot.currentPlayerName) {
                        humanLog(bot, 'Break ended (%s) — rotating to account %s', bot.breakType, nextAccount);
                        bot.currentPlayerName = nextAccount;
                        bot.sessionProfile = loadOrCreateSessionProfile(bot, nextAccount);
                        if (bot.lastActiveAccountSetting.value !== nextAccount) {
                            bot.lastActiveAccountSetting.value = nextAccount;
                        }
                        // Re-sample nightly break for the new account
                        bot.nightlyBreakTargetTime = -1;
                        bot.nightlySleepMinutes = -1;
                    } else {
                        humanLog(bot, 'Break ended (%s), logging back in', bot.breakType);
                    }
                } else {
                    humanLog(bot, 'Break ended (%s) but no eligible account found — waiting', bot.breakType);
                    // Don't transition to logging_in yet; stay logged_out
                    // and retry on the next tick. Push breakTargetEndMs
                    // forward by 30 seconds to avoid spamming the log.
                    bot.breakTargetEndMs = now + 30000;
                    saveBreakState(bot);
                    return true;
                }
                bot.breakPhase = 'logging_in';
                resetLogoutState(bot);
                resetLoginState(bot);
                saveBreakState(bot);
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
                bot.loopIdleSinceTick = -1;
                bot.shortBreakDelayTicks = -1;
                bot.nextActionEtaMin = -1;
                resetLoginState(bot);
                bot.autoLoop.needsPostLoginCleanup = true;
                humanLog(bot, 'Logged back in, resuming auto-loop');
                // Clear per-account break state on successful login
                if (isRotationEnabled(bot) && bot.currentPlayerName) {
                    recordAccountLogin(bot, bot.currentPlayerName);
                }
                clearBreakState(bot);
            }
            return true;
        }

        // Unexpected logout — try to log back in
        if (bot.unexpectedLogoutAtMs === 0) {
            bot.unexpectedLogoutAtMs = now;
            saveBreakState(bot);
        }
        loginStep(bot);
        return true;
    }

    // --- Player is logged in ---

    // If the persisted break state says we're logged out but the player is
    // actually in-world (e.g. script restarted while logged in during a
    // break, or the user logged in manually), the break is over — clear it.
    if (bot.breakPhase === 'logged_out' && isInWorld()) {
        humanLog(bot, 'Break state was logged_out but player is in-world — clearing stale break state');
        bot.breakPhase = 'none';
        bot.breakType = 'none';
        bot.loopIdleForBreak = false;
        bot.loopIdleSinceTick = -1;
        bot.shortBreakDelayTicks = -1;
        bot.nextActionEtaMin = -1;
        bot.unexpectedLogoutAtMs = 0;
        resetLoginState(bot);
        clearBreakState(bot);
    }

    // Clear unexpected logout
    if (bot.unexpectedLogoutAtMs > 0) {
        bot.unexpectedLogoutAtMs = 0;
        // If we were in a logging_in phase, clear it
        if (bot.breakPhase === 'logging_in') {
            bot.breakPhase = 'none';
            bot.breakType = 'none';
            bot.loopIdleForBreak = false;
            bot.loopIdleSinceTick = -1;
            bot.shortBreakDelayTicks = -1;
            bot.nextActionEtaMin = -1;
            resetLoginState(bot);
            clearBreakState(bot);
        }
    }

    // Check if we just logged back in after a break
    if (bot.breakPhase === 'logging_in') {
        if (isInWorld()) {
            bot.breakPhase = 'none';
            bot.breakType = 'none';
            bot.loopIdleForBreak = false;
            bot.loopIdleSinceTick = -1;
            bot.shortBreakDelayTicks = -1;
            bot.nextActionEtaMin = -1;
            resetLoginState(bot);
            bot.autoLoop.needsPostLoginCleanup = true;
            humanLog(bot, 'Logged back in, resuming auto-loop');
            // Clear per-account break state on successful login
            if (isRotationEnabled(bot) && bot.currentPlayerName) {
                recordAccountLogin(bot, bot.currentPlayerName);
            }
            clearBreakState(bot);
        }
        return true;
    }

    // --- Lazy init sessionPlayStartMs ---
    // Set when the player is logged in, not on a break, and the timer hasn't
    // been started yet. This handles post-wake and post-enable.
    if (bot.breakPhase === 'none' && bot.sessionPlayStartMs < 0) {
        bot.sessionPlayStartMs = now;
    }

    // If Do Not Sleep was toggled ON while a nightly break is being prepared
    // (logging_out phase), abort it so the bot continues playing.
    if (bot.doNotSleep?.value && bot.breakType === 'nightly' && bot.breakPhase === 'logging_out') {
        humanLog(bot, 'Do Not Sleep enabled; aborting nightly break');
        bot.breakPhase = 'none';
        bot.breakType = 'none';
        bot.breakStartMs = 0;
        bot.breakTargetEndMs = 0;
        bot.loopIdleForBreak = false;
        bot.loopIdleSinceTick = -1;
        bot.shortBreakDelayTicks = -1;
        bot.nextActionEtaMin = -1;
        bot.nightlyBreakTargetTime = -1;
        bot.nightlySleepMinutes = -1;
        resetLogoutState(bot);
        clearBreakState(bot);
    }

    // --- Check for nightly break ---
    if (isNightlyBreakDue(bot)) {
        if (bot.breakPhase === 'none') {
            // Start nightly break — end the day session
            bot.sessionPlayStartMs = -1;
            bot.breakPhase = 'logging_out';
            bot.breakType = 'nightly';
            bot.breakStartMs = now;
            bot.breakTargetEndMs = bot.nightlyBreakTargetTime + (bot.nightlySleepMinutes * MS_PER_MINUTE);
            bot.loopIdleForBreak = false;
            bot.loopIdleSinceTick = -1;
            bot.shortBreakDelayTicks = -1;
            bot.nextActionEtaMin = -1;
            resetLogoutState(bot);
            const wakeTime = new Date(bot.breakTargetEndMs);
            humanLog(bot, 'Nightly sleep starting — wake at %s (%d min sleep)',
                wakeTime.toISOString(), bot.nightlySleepMinutes);
            // Record per-account break state for multi-character rotation.
            // The duration is the full sleep duration — the account won't
            // be selected again until its wake time.
            if (isRotationEnabled(bot) && bot.currentPlayerName) {
                const sleepDurationMs = bot.nightlySleepMinutes * MS_PER_MINUTE;
                recordAccountLogout(bot, bot.currentPlayerName, sleepDurationMs);
            }
            saveBreakState(bot);
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
    //   4. The bot has been idle for a randomised tick delay:
    //        base 5-20 ticks
    //        + 3 ticks (20% chance)
    //        + 1-10 ticks (10% chance)
    //        + 5-15 ticks (1% chance)
    //      The delay is computed once when the bot first becomes idle and
    //      stored in shortBreakDelayTicks. This prevents logging out
    //      immediately while adding humanised randomness to the timing.
    if (bot.breakPhase === 'none' && bot.loopIdleForBreak && bot.autoMode.value === 1) {
        if (bot.loopIdleSinceTick < 0) {
            bot.loopIdleSinceTick = tick;
            // Compute the randomised delay once.
            let delay = 5 + Math.floor(Math.random() * 16); // 5-20 ticks
            if (Math.random() < 0.20) delay += 3;             // +3 ticks (20%)
            if (Math.random() < 0.10) delay += 1 + Math.floor(Math.random() * 10); // +1-10 (10%)
            if (Math.random() < 0.01) delay += 5 + Math.floor(Math.random() * 11); // +5-15 (1%)
            bot.shortBreakDelayTicks = delay;
            humanLog(bot, 'Idle — short break in %d ticks', delay);
        }
        const elapsed = tick - bot.loopIdleSinceTick;
        if (elapsed < bot.shortBreakDelayTicks) {
            return false;
        }
        const duration = sampleEtaBasedBreakDuration(bot);
        bot.breakPhase = 'logging_out';
        bot.breakType = 'short';
        bot.breakStartMs = now;
        bot.breakTargetEndMs = now + duration;
        bot.loopIdleForBreak = false;
        bot.loopIdleSinceTick = -1;
        bot.shortBreakDelayTicks = -1;
        bot.nextActionEtaMin = -1;
        resetLogoutState(bot);
        humanLog(bot, 'Short break starting — %d min logout', Math.round(duration / MS_PER_MINUTE));
        // Record per-account break state for multi-character rotation.
        // The duration is the ETA-based minimum break for this account.
        if (isRotationEnabled(bot) && bot.currentPlayerName) {
            recordAccountLogout(bot, bot.currentPlayerName, duration);
        }
        logoutForBreak(bot, 'short');
        saveBreakState(bot);
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

    // Detect a disconnect during a world hop. A normal hop transitions
    // through HoppingWorld (45), not LoginScreen (10). If the client is on
    // the login screen while a hop is in progress, the connection was lost.
    // onGameTick (which runs hopStep's 45s timeout) does not fire on the
    // login screen, so without this check the bot would stay stuck with
    // hopInProgress=true forever, blocking loginStep() from running.
    // 10 seconds is enough for any brief transition; a real disconnect will
    // be clearly past that.
    if (bot.hopInProgress &&
        titan.state.login.state === titan.LoginGameState.LoginScreen &&
        bot.lastHopMs > 0 && now - bot.lastHopMs > 10000) {
        cancelHop(bot, titan.state.client.tick, 'Disconnect during world hop (login screen detected); cancelling hop to allow auto-login');
    }

    // If logged out and in a break, check if break is over
    if (!playerName || !titan.state.login.isLoggedIn) {
        // Transition logging_out → logged_out. This normally happens in
        // breakStep (onGameTick), but onGameTick doesn't fire while logged
        // out, so we must also handle it here in wallClockStep.
        if (bot.breakPhase === 'logging_out' && bot.logoutComplete) {
            bot.breakPhase = 'logged_out';
            debugLog(bot, `Break: logged out, waiting until ${new Date(bot.breakTargetEndMs).toISOString()}`);
            saveBreakState(bot);
            dumpStateOnLogout(bot);
        }

        if (bot.breakPhase === 'logged_out' && now >= bot.breakTargetEndMs) {
            // Break is over — select next account for multi-character rotation.
            const nextAccount = selectNextAccountForLogin(bot);
            if (nextAccount) {
                if (nextAccount !== bot.currentPlayerName) {
                    humanLog(bot, 'Break ended (%s) — rotating to account %s', bot.breakType, nextAccount);
                    bot.currentPlayerName = nextAccount;
                    bot.sessionProfile = loadOrCreateSessionProfile(bot, nextAccount);
                    if (bot.lastActiveAccountSetting.value !== nextAccount) {
                        bot.lastActiveAccountSetting.value = nextAccount;
                    }
                    // Re-sample nightly break for the new account
                    bot.nightlyBreakTargetTime = -1;
                    bot.nightlySleepMinutes = -1;
                } else {
                    humanLog(bot, 'Break ended (%s), logging back in', bot.breakType);
                }
                bot.breakPhase = 'logging_in';
                resetLogoutState(bot);
                resetLoginState(bot);
                saveBreakState(bot);
            } else {
                // No eligible account — wait and retry
                if (bot.breakTargetEndMs <= now) {
                    bot.breakTargetEndMs = now + 30000;
                    saveBreakState(bot);
                }
            }
        }

        if (bot.breakPhase === 'logging_out') {
            logoutForBreak(bot, bot.breakType, true);
        }

        // Not in a break but logged out — initialise the unexpected-logout
        // timer if it hasn't been set yet (e.g. script started while logged
        // out). After 5 seconds, loginStep will be called to log back in.
        // Skip if a world hop is in progress (the hop disconnect detection
        // above handles cancelling a stuck hop before allowing login).
        if (bot.breakPhase === 'none' && !bot.hopInProgress && bot.unexpectedLogoutAtMs === 0) {
            bot.unexpectedLogoutAtMs = now;
            humanLog(bot, 'Logged out (not a break) — attempting login');
            saveBreakState(bot);
        }

        // Detect the selected account at the login screen. The login
        // snapshot's displayName is available before the player is logged
        // in, so we can set currentPlayerName and load the session profile
        // before loginStep tries to stage credentials. Without this,
        // tryStageAndSubmitLogin fails with "no character name found".
        // Fallback: if the snapshot has no displayName (e.g. account not
        // staged yet), use the last active account from the hidden setting.
        if (!bot.currentPlayerName) {
            const snap = titan.state.login.snapshot();
            const accountName = snap?.displayName?.trim() || null;
            if (accountName) {
                debugLog(bot, `Account selected at login screen: ${accountName}`);
                bot.currentPlayerName = accountName;
                if (bot.lastActiveAccountSetting.value !== accountName) {
                    bot.lastActiveAccountSetting.value = accountName;
                }
                if (!bot.sessionProfile) {
                    bot.sessionProfile = loadOrCreateSessionProfile(bot, accountName);
                }
            } else {
                // No displayName in snapshot — try the last active account.
                const lastActive = bot.lastActiveAccountSetting.value.trim();
                if (lastActive) {
                    debugLog(bot, `No account in login snapshot — using last active: ${lastActive}`);
                    bot.currentPlayerName = lastActive;
                    if (!bot.sessionProfile) {
                        bot.sessionProfile = loadOrCreateSessionProfile(bot, lastActive);
                    }
                }
            }
        }

        if (bot.breakPhase === 'logging_in' || bot.unexpectedLogoutAtMs > 0) {
            if (!bot.hopInProgress) loginStep(bot);
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
