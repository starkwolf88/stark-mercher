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
//   - NIGHTLY SLEEP: Per-account profile with sleep 4.5–7.5h, wake 06:30–
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
import { dumpAllState, updateProfitDisplay } from '../general/dump.js';
import { isRotationEnabled, selectNextAccount, recordAccountLogout, recordAccountLogin, loadRotationIndex, getRoster, isAccountSleeping, normalizeAccountName } from './account-rotation.js';
import { invalidateMembersWorldCache, invalidateBooleanStateCache } from '../grand_exchange/widgets.js';
import { invalidateNearGeCache } from '../grand_exchange/clerk.js';
import { setDayBounds } from './humanised-delay.js';

// Login snapshot throttle — titan.state.login.snapshot() creates a native
// handle per call. wallClockStep runs every second; while waiting with no
// eligible rotation account, the snapshot was re-fetched every second.
// Throttle to once per 10 seconds — account detection at the login screen
// does not need sub-second latency (a 9s delay before logging in is fine).
const LOGIN_SNAPSHOT_TTL_MS = 10_000;
let cachedLoginSnapshotName: string | null = null;
let cachedLoginSnapshotMs = 0;

/** Resets the throttled login-snapshot cache. Called from onDisable so a
 *  toggle off/on re-reads the staged account immediately on the next run. */
export const resetLoginSnapshotCache = (): void => {
    cachedLoginSnapshotName = null;
    cachedLoginSnapshotMs = 0;
};

/** Dumps cache, merch history, abort history, and buy-freeze state to the
 *  log. Called automatically after each logout so the user can review state
 *  without clicking the log buttons manually. Also updates the visible
 *  "Profit (all accounts)" setting so the user can see net profit per
 *  account without opening the log. */
const dumpStateOnLogout = (bot: StarkMercher): void => {
    // Use bot.currentPlayerName instead of titan.state.client.localPlayer?.name
    // — the player is already logged out at this point (localPlayer is null),
    // and currentPlayerName is tracked from the last login. Reading
    // localPlayer here would create a native Player handle on every logout.
    const accountName = bot.currentPlayerName || '';
    if (!accountName) {
        titan.log('[Stark Mercher] Cannot dump state on logout — no account name.');
        return;
    }
    dumpAllState(bot, accountName);
    updateProfitDisplay(bot);
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

// --- Top-of-hour pause ------------------------------------------------------
// The flips script (determine-flips.mjs) fetches fresh price data at the top
// of each hour. The fetch takes a few minutes, during which merchableItems.json
// is being rewritten. To avoid acting on stale or partially-written data, the
// bot pauses all activity from :59 to :05 of every hour (UK time). The
// character logs out at :59 (once the current auto-loop iteration finishes —
// never mid-flow) and logs back in at :05.

/** The hour-pause window starts at minute 59 and ends at minute 5 of the
 *  next hour. So minutes >= 59 OR minutes < 5 are inside the pause window. */
const HOUR_PAUSE_START_MIN = 59;
const HOUR_PAUSE_END_MIN = 5;

/** Returns true if the current UK time is inside the top-of-hour pause
 *  window (minute >= 59 or minute < 5). */
function isInHourPauseWindow(): boolean {
    const p = getUKParts();
    return p.minute >= HOUR_PAUSE_START_MIN || p.minute < HOUR_PAUSE_END_MIN;
}

/** Returns the wall-clock timestamp (ms) of the next :05 UK time — the end
 *  of the current or upcoming hour-pause window. */
function getHourPauseEndMs(): number {
    const now = Date.now();
    const p = getUKParts(new Date(now));
    const midnight = getUKMidnightMs(now);
    // The pause always ends at the next chronological :05 UK time.
    //   minute < 5  → :05 of the CURRENT hour (we're inside the pause window)
    //   minute >= 5 → :05 of the NEXT hour (covers both the in-window start
    //                 at minute >= 59 and the early-start range 57-58, which
    //                 fires when the pause begins within 2 minutes)
    // The previous branch keyed on `minute >= 59`, which left minute 57-58
    // resolving to the current hour's :05 — a past timestamp ~52 min ago,
    // producing negative durations like "-53 min logout" and causing the
    // bot to log straight back in instead of waiting for :05.
    const endHour = p.minute < HOUR_PAUSE_END_MIN ? p.hour : (p.hour + 1) % 24;
    return midnight + endHour * 60 * MS_PER_MINUTE + HOUR_PAUSE_END_MIN * MS_PER_MINUTE;
}

/** Returns the wall-clock timestamp (ms) of the next :59 UK time — the start
 *  of the next hour-pause window. Used to suppress short breaks that would
 *  overlap with an imminent hour-pause. */
function getNextHourPauseStartMs(): number {
    const now = Date.now();
    const p = getUKParts(new Date(now));
    const midnight = getUKMidnightMs(now);
    // If we're before :59 this hour, the next pause starts at :59 this hour.
    // Otherwise (we're inside the pause or past :59), it starts at :59 next hour.
    const startHour = p.minute < HOUR_PAUSE_START_MIN ? p.hour : (p.hour + 1) % 24;
    return midnight + startHour * 60 * MS_PER_MINUTE + HOUR_PAUSE_START_MIN * MS_PER_MINUTE;
}

/** Suppress short breaks that would end after the hour-pause starts, to
 *  avoid login → idle → hour-pause-logout cycling near :59. If the hour-pause
 *  starts within this many ms, skip the short break and just wait. */
const HOUR_PAUSE_SUPPRESS_SHORT_BREAK_MS = 2 * MS_PER_MINUTE;

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

// Maximum logout break duration (in minutes) for short/ETA-based breaks.
// The character should never remain logged out longer than this due to a
// sampled short break — if something happens sooner than expected while
// logged out, this cap ensures the bot returns within 5 minutes. Nightly
// sleep (6–8h) is separate and NOT subject to this cap.
const MAX_LOGOUT_BREAK_MIN = 5;

// Minimum logout break duration (in minutes). Ensures every account stays
// logged out for at least 3 minutes per break — gives GE offers time to fill
// before the bot logs back in and potentially aborts them, and prevents rapid
// account rotation cycling (A → B → A → B with only seconds between).
const MIN_LOGOUT_BREAK_MIN = 3;

function sampleShortBreakDuration(bot: StarkMercher): number {
    const profile = bot.sessionProfile;
    if (!profile) return sampleInt(MIN_LOGOUT_BREAK_MIN, MAX_LOGOUT_BREAK_MIN) * MS_PER_MINUTE;

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

    // Enforce minimum logout break so every account stays logged out for
    // at least 3 minutes — gives GE offers time to fill before the bot
    // logs back in, and prevents rapid rotation cycling.
    if (total < MIN_LOGOUT_BREAK_MIN) {
        total = MIN_LOGOUT_BREAK_MIN;
    }

    // Cap at MAX_LOGOUT_BREAK_MIN so the character never stays logged out
    // longer than 5 minutes due to a sampled short break. Long-tail additions
    // can push the total past 5 min; clamp and trace when clamped.
    if (total > MAX_LOGOUT_BREAK_MIN) {
        if (bot.logInfoValue) titan.logf('[Stark Mercher] Break: sampled short break %d min clamped to %d min cap',
            total, MAX_LOGOUT_BREAK_MIN);
        total = MAX_LOGOUT_BREAK_MIN;
    }

    return total * MS_PER_MINUTE;
}

// --- ETA-based break duration sampling --------------------------------------
// When the auto-loop goes idle with all slots occupied, it computes the
// minimum remaining time until the next action on any slot (earlier of
// completion or stale-abort threshold) and stores it in bot.nextActionEtaMin.
// This function converts that hint into a break duration.
//
// Two-tier strategy to prevent rapid login/nothing-to-do/logout cycling:
//   1. FIRST break (checkedAtHalfEta = false): target 50% of the ETA so the
//      bot can check if anything bought/sold quicker than expected.
//   2. SECOND+ break (checkedAtHalfEta = true): target 90% of the remaining
//      ETA, since we already checked at 50% and found nothing ready. 90%
//      aligns with the buy multi-qty abort threshold (90% of ETA + <50%
//      progress), so the bot logs back in right when aborts start triggering.
//
// Both tiers use ±15% jitter so the return isn't precisely predictable.
// A randomized 1–2 min floor prevents rapid login/nothing-to-do/logout
// cycling when ETAs are short. The 5 min ceiling ensures the character
// never stays logged out longer than 5 minutes — if something happens
// sooner than expected while logged out, the bot returns promptly.
// The two-tier 50%→90% escalation (preserved across logins via
// checkedAtHalfEta) is the primary anti-cycling mechanism: the first
// break targets 50% of ETA, and subsequent breaks target 90% so the
// bot doesn't keep re-checking at short intervals when nothing changed.
// Falls back to sampleShortBreakDuration() when no ETA data is available.
const ETA_BREAK_RATIO_FIRST = 0.5;  // first check: 50% of ETA
const ETA_BREAK_RATIO_SECOND = 0.9; // second+ check: 90% of remaining ETA
const ETA_BREAK_CEILING_MIN = MAX_LOGOUT_BREAK_MIN;
const ETA_BREAK_JITTER = 0.15; // ±15%
// If the next action ETA is within this many minutes, stay logged in
// instead of taking a short break. The bot re-checks every 5-8 ticks
// (~3-5s) so it can act immediately when the offer completes/aborts.
const STAY_LOGGED_IN_ETA_THRESHOLD_MIN = 1.0; // 60 seconds
const STAY_LOGGED_IN_RECHECK_TICKS_MIN = 5;
const STAY_LOGGED_IN_RECHECK_TICKS_MAX = 8;

function sampleEtaBasedBreakDuration(bot: StarkMercher): number {
    const etaMin = bot.nextActionEtaMin;
    if (etaMin <= 0) {
        return sampleShortBreakDuration(bot);
    }

    // Use 90% of remaining ETA if we already checked at 50% and found
    // nothing ready. Otherwise use 50% for the first check.
    const ratio = bot.checkedAtHalfEta ? ETA_BREAK_RATIO_SECOND : ETA_BREAK_RATIO_FIRST;
    const jitterMultiplier = 1 + (Math.random() * 2 - 1) * ETA_BREAK_JITTER;
    let durationMin = etaMin * ratio * jitterMultiplier;

    // Minimum 3-min floor ensures every account stays logged out for at
    // least 3 minutes — gives GE offers time to fill before the bot logs
    // back in and potentially aborts them, and prevents rapid rotation
    // cycling. The two-tier 50%→90% escalation (checkedAtHalfEta, preserved
    // across logins) handles the anti-cycling for medium/long ETAs — the
    // floor only matters when the ETA is so short that both 50% and 90%
    // would underflow it.
    durationMin = Math.max(MIN_LOGOUT_BREAK_MIN, Math.min(ETA_BREAK_CEILING_MIN, durationMin));

    return Math.round(durationMin) * MS_PER_MINUTE;
}

// --- Nightly sleep sampling (wake-first) ------------------------------------

function sampleNightlySleepMinutes(bot: StarkMercher): number {
    const profile = bot.sessionProfile;
    if (!profile) return 360; // 6h default

    // 5% outlier: longer sleep (6–8h = 360–480 min)
    if (Math.random() < 0.05) {
        return sampleInt(360, 480);
    }

    const base = profile.nightlySleepLengthBase;
    const variance = profile.nightlySleepLengthVariance;
    // Cap variance so it can't push past 480 min (8h)
    const effectiveVariance = Math.min(variance, 480 - base);
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
    if (bot.doNotSleepValue) return Infinity;
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

    // Update the diurnal pace day bounds. The waking day ends at the bedtime
    // (targetMs). If we already have a dayStartMs from a prior wake, keep it;
    // otherwise estimate from the previous night's wake time.
    updateDayBoundsFromSchedule(bot, targetMs);

    const bed = new Date(targetMs);
    const wake = new Date(targetMs + sleepMs);
    if (bot.logInfoValue) titan.logf('[Stark Mercher] Scheduled nightly sleep: %s to %s (%d min)',
        bed.toISOString(), wake.toISOString(), sleepMinutes);

    // Persist the schedule immediately so it survives hot reloads.
    // On tab reloads (cache lost), the schedule is re-derived from the
    // per-account session profile — the exact bedtime will differ, which
    // is acceptable.
    saveBreakState(bot);

    return targetMs;
}

function isNightlyBreakDue(bot: StarkMercher): boolean {
    if (bot.doNotSleepValue) return false;
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
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Nightly break: adjusted target back by one day (now in sleep window)');
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

/**
 * Returns the number of minutes until the next nightly sleep target, or
 * `Infinity` if there is no valid future bedtime. Used by the auto-loop buy
 * scan to activate pre-sleep lowball priority during the final 30 minutes
 * before nightly sleep — lowball offers (buy below market, slower fills,
 * higher margins) are better suited for the ~4h unattended sleep window
 * than instant-fill non-lowball offers.
 *
 * Returns `Infinity` (not 0) when:
 * - `doNotSleep` is enabled
 * - the bot is already in a break phase (logging_out / logged_out / logging_in)
 * - no valid bedtime is scheduled (`nightlyBreakTargetTime <= 0`)
 * - the bedtime has already passed (`now >= bedtime`)
 *
 * This ensures a naive `minutesUntilSleep <= PRE_SLEEP_PRIORITY_MINUTES`
 * check in the caller does NOT activate pre-sleep mode for an already-
 * started or invalid nightly schedule.
 */
export function getMinutesUntilNightlySleep(bot: StarkMercher): number {
    if (bot.doNotSleepValue) return Infinity;
    if (bot.breakPhase !== 'none') return Infinity;
    if (bot.nightlyBreakTargetTime <= 0) return Infinity;
    const now = Date.now();
    if (now >= bot.nightlyBreakTargetTime) return Infinity;
    return (bot.nightlyBreakTargetTime - now) / MS_PER_MINUTE;
}

// --- Helpers ----------------------------------------------------------------

function sampleInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function debugLog(bot: StarkMercher, msg: string): void {
    if (bot.logDebugValue) titan.logf('[Stark Mercher] %s', msg);
}

function humanLog(bot: StarkMercher, msg: string, ...args: unknown[]): void {
    if (bot.logInfoValue) titan.logf('[Stark Mercher] ' + msg, ...args);
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
    // Note: we do NOT block login on stale merchable data. The bot may have
    // active GE offers that need management (completed sells to collect,
    // stale offers to abort, inventory to sell). The buy scan in auto-loop.ts
    // checks data validity before placing new buys — so stale data only
    // prevents new buys, not offer management.
    if (!isRotationEnabled(bot)) {
        // Single-account mode — log back into the same account
        return bot.currentPlayerName || bot.lastActiveAccountSetting.value.trim() || null;
    }
    // Multi-account rotation — select next eligible account
    return selectNextAccount(bot);
}

/**
 * After the current account logs out for a break, immediately check if a
 * different account in the roster is eligible to log in right now. If so,
 * transition to logging_in with that account, skipping the break wait.
 * This implements the "next roster account is considered immediately"
 * behaviour: account A logs out → account B logs in right away, rather
 * than waiting for account A's break timer to expire.
 *
 * Returns true if an immediate rotation was triggered (caller should stop
 * processing), false if no other account is eligible (caller should fall
 * through to the normal break-timer wait).
 */
function tryImmediateRotation(bot: StarkMercher): boolean {
    if (!isRotationEnabled(bot)) return false;
    // Only rotate immediately if the current account just logged out for
    // a break (not an unexpected disconnect — those retry the same account).
    if (bot.breakPhase !== 'logged_out') return false;
    // Note: we do NOT block rotation on stale merchable data. The bot may
    // have active GE offers that need management on any account. The buy
    // scan in auto-loop.ts checks data validity before placing new buys.
    const nextAccount = selectNextAccount(bot);
    if (!nextAccount) return false;
    // Only skip the break wait if we're switching to a DIFFERENT account.
    // If the same account is selected, it means no other account is
    // eligible — fall through to the normal break-timer wait.
    // Compare under whitespace + case normalization so a non-breaking-space
    // game name (e.g. "hc\u00A0fruitz") is correctly treated as the same
    // account as the roster entry ("hc fruitz").
    if (normalizeAccountName(nextAccount) === normalizeAccountName(bot.currentPlayerName)) return false;
    // On startup / hot reload, currentPlayerName may be empty (reset by
    // resetBreakState). Fall back to the last active account setting so the
    // log shows the correct previous account instead of an empty string.
    const prevAccount = bot.currentPlayerName || bot.lastActiveAccountSetting.value || '(previous)';
    humanLog(bot, 'Rotation: %s logged out — immediately rotating to %s (skip break wait)',
        prevAccount, nextAccount);
    bot.currentPlayerName = nextAccount;
    bot.sessionProfile = loadOrCreateSessionProfile(bot, nextAccount);
    if (bot.lastActiveAccountSetting.value !== nextAccount) {
        bot.lastActiveAccountSetting.value = nextAccount;
    }
    // Re-sample nightly break for the new account
    bot.nightlyBreakTargetTime = -1;
    bot.nightlySleepMinutes = -1;
    bot.breakPhase = 'logging_in';
    resetLogoutState(bot);
    resetLoginState(bot);
    saveBreakState(bot);
    return true;
}

// --- Public API -------------------------------------------------------------

/** Initialize session profile for the current account. Called on enable / login.
 *
 *  Name canonicalization: The OSRS client's `localPlayer.name` may differ in
 *  casing or trailing whitespace from the roster entry (e.g. "HC fruitz" vs
 *  "hc fruitz"). If we blindly overwrite `currentPlayerName` with the game
 *  name, merch history gets recorded under two separate keys — one from the
 *  login-screen path (roster name) and one from this path (game name) —
 *  causing the profit UI to show the same account twice with different
 *  totals. To prevent this, if the roster contains a name that matches
 *  case-insensitively (after trim), we use the roster's version. This keeps
 *  all history under a single consistent key. */
export function initSessionProfile(bot: StarkMercher): void {
    const playerName = titan.state.client.localPlayer?.name;
    if (!playerName) {
        debugLog(bot, 'initSessionProfile: no player name, skipping');
        return;
    }
    // Canonicalize: prefer the roster's casing/whitespace if the game name
    // matches an entry case-insensitively. This prevents duplicate merch
    // history keys (e.g. "hc fruitz" vs "HC fruitz") that fragment profit
    // tracking and cause the profit UI to show the same account twice.
    const roster = getRoster(bot);
    // Canonicalize: prefer the roster's casing/whitespace if the game name
    // matches an entry under whitespace + case normalization. This prevents
    // duplicate merch history keys (e.g. "hc fruitz" vs "HC fruitz") that
    // fragment profit tracking and cause the profit UI to show the same
    // account twice. Crucially, this also normalizes non-breaking spaces
    // (U+00A0) — the OSRS client's localPlayer.name for "hc fruitz" is often
    // "hc\u00A0fruitz", which without normalization would fail to match the
    // roster entry, leaving bot.currentPlayerName as the non-breaking-space
    // version and breaking rotation same-account checks + break-state lookup.
    const playerNorm = normalizeAccountName(playerName);
    const canonical = roster.find(n => normalizeAccountName(n) === playerNorm) ?? playerName;
    bot.currentPlayerName = canonical;
    bot.sessionProfile = loadOrCreateSessionProfile(bot, canonical);
    // Persist the last active account name so it can be used as a fallback
    // when the login snapshot doesn't have a displayName (e.g. account not
    // staged yet at script start while logged out).
    if (bot.lastActiveAccountSetting.value !== canonical) {
        bot.lastActiveAccountSetting.value = canonical;
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
    bot.lastIdleRotationCheckMs = 0;
    bot.lastWallClockMs = 0;
    // Reset the throttled login-snapshot cache so a fresh enable re-reads the
    // staged account immediately.
    cachedLoginSnapshotMs = 0;
    cachedLoginSnapshotName = null;
    resetLogoutState(bot);
    resetLoginState(bot);
    // Invalidate the cached isMembersWorld() result — the world list may
    // have changed since the last session (e.g. script restarted after a
    // logout, or hot-reloaded on a different world).
    invalidateMembersWorldCache();
    invalidateBooleanStateCache();
    invalidateNearGeCache();
    // Clear the diurnal pace day bounds — they'll be recomputed when the
    // nightly schedule is initialised.
    setDayBounds(0, 0);
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

/** Clear the saved break state, preserving the nightly schedule.
 *  Called when a break fully ends and the bot is back in-world and active.
 *  The nightly bedtime/wake schedule is independent of short/hour breaks
 *  and must survive hot reloads that happen after a successful post-break
 *  login — otherwise the schedule is lost and re-randomized on the next
 *  reload. Saving a minimal state with breakPhase='none' and the schedule
 *  fields allows restoreBreakState to find and restore it on the next hot
 *  reload. */
export function clearBreakState(bot: StarkMercher): void {
    const state: SavedBreakState = {
        breakPhase: 'none',
        breakType: 'none',
        breakStartMs: 0,
        breakTargetEndMs: 0,
        nightlyBreakTargetTime: bot.nightlyBreakTargetTime,
        nightlySleepMinutes: bot.nightlySleepMinutes,
        nightlyBreakFinished: bot.nightlyBreakFinished,
        sessionPlayStartMs: bot.sessionPlayStartMs,
        unexpectedLogoutAtMs: 0,
        savedAt: Date.now(),
    };
    try {
        bot.breakStateSetting.value = JSON.stringify(state);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save break state: %s', String(e));
    }
}

/** Fully wipe the saved break state to '{}', including the nightly schedule.
 *  Used when the nightly sleep window has fully passed (schedule is stale)
 *  or the saved state is corrupt/unparseable. Not used for normal break-end
 *  clearings — those preserve the nightly schedule via clearBreakState(). */
const wipeBreakStateSetting = (bot: StarkMercher): void => {
    if (bot.breakStateSetting.value !== '{}') {
        bot.breakStateSetting.value = '{}';
    }
};

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
        // in a nightly sleep window, the saved break state is stale.
        const now = Date.now();
        if (s.breakPhase === 'logged_out' && s.breakTargetEndMs > 0 && now >= s.breakTargetEndMs) {
            // The break was supposed to end in the past. If it was a nightly
            // sleep, check if we're still within the sleep window.
            if (s.breakType === 'nightly' && s.nightlyBreakTargetTime > 0) {
                const sleepMs = s.nightlySleepMinutes > 0 ? s.nightlySleepMinutes * MS_PER_MINUTE : 0;
                const wakeMs = s.nightlyBreakTargetTime + sleepMs;
                if (now >= wakeMs) {
                    // Sleep window has fully passed — the nightly schedule is
                    // stale. Fully wipe so scheduleNextNightlyBreak re-derives
                    // a fresh schedule for the new day.
                    wipeBreakStateSetting(bot);
                    return false;
                }
            } else {
                // Short/hour break target has passed — the break is over.
                // The nightly schedule is independent of this short break and
                // must be preserved. Restore it and transition to logging_in
                // so the bot logs back in, instead of discarding everything
                // (which would lose the schedule and force a re-randomization).
                bot.breakPhase = 'logging_in';
                bot.breakType = 'none';
                bot.breakStartMs = 0;
                bot.breakTargetEndMs = 0;
                bot.nightlyBreakTargetTime = s.nightlyBreakTargetTime;
                bot.nightlySleepMinutes = s.nightlySleepMinutes;
                bot.nightlyBreakFinished = s.nightlyBreakFinished;
                bot.sessionPlayStartMs = s.sessionPlayStartMs;
                bot.unexpectedLogoutAtMs = 0;
                if (bot.logInfoValue) titan.logf('[Stark Mercher] Restored break state: short break target passed — preserved nightly schedule (bedtime %s), logging in',
                    bot.nightlyBreakTargetTime > 0 ? new Date(bot.nightlyBreakTargetTime).toISOString() : '(none)');
                // Restore diurnal pace day bounds from the nightly schedule.
                if (bot.nightlyBreakTargetTime > 0 && bot.nightlySleepMinutes > 0) {
                    const bedtime = bot.nightlyBreakTargetTime;
                    if (now < bedtime) {
                        const prevWake = bedtime - MS_PER_DAY + bot.nightlySleepMinutes * MS_PER_MINUTE;
                        const fallbackStart = Math.max(prevWake, now - 16 * MS_PER_MINUTE);
                        setDayBounds(fallbackStart, bedtime);
                    }
                }
                // Save the updated state so a subsequent hot reload finds it.
                saveBreakState(bot);
                return true;
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

        if (bot.logInfoValue) titan.logf('[Stark Mercher] Restored break state: phase=%s, type=%s, targetEnd=%s',
            bot.breakPhase, bot.breakType,
            bot.breakTargetEndMs > 0 ? new Date(bot.breakTargetEndMs).toISOString() : '(none)');

        // Restore diurnal pace day bounds from the nightly schedule.
        // If we're in a waking period (not sleeping), set the day end to the
        // next bedtime and estimate the day start from the previous wake.
        if (bot.nightlyBreakTargetTime > 0 && bot.nightlySleepMinutes > 0) {
            const now2 = Date.now();
            const bedtime = bot.nightlyBreakTargetTime;
            const wakeMs = bedtime + bot.nightlySleepMinutes * MS_PER_MINUTE;
            if (now2 < bedtime) {
                // In a waking period — estimate day start from previous wake.
                const prevWake = bedtime - MS_PER_DAY + bot.nightlySleepMinutes * MS_PER_MINUTE;
                const fallbackStart = Math.max(prevWake, now2 - 16 * MS_PER_MINUTE);
                setDayBounds(fallbackStart, bedtime);
            }
        }

        return true;
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to restore break state: %s', String(e));
        wipeBreakStateSetting(bot);
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
    bot.lastHopWasBurst = false;
    bot.inventoryOpenEnsured = false;
}

/** Restore the global hop timer from the hidden setting after a script
 *  reload. Only restores nextHopAtMs and hopCount — the hop is rescheduled
 *  fresh if the persisted timer has already expired (a reload during a
 *  hop-in-progress would have lost the in-progress state anyway). */
export function loadHopState(bot: StarkMercher): boolean {
    try {
        const raw = bot.hopStateSetting.value;
        if (!raw || raw === '{}') return false;
        const state = JSON.parse(raw);
        if (typeof state.nextHopAtMs === 'number' && state.nextHopAtMs > Date.now()) {
            bot.nextHopAtMs = state.nextHopAtMs;
            bot.nextHopStartAtMs = Date.now();
            const remainingMs = state.nextHopAtMs - Date.now();
            const remainingTicks = Math.ceil(remainingMs / 600);
            const tick = titan.state.client.tick;
            bot.nextHopTick = tick + remainingTicks;
            bot.nextHopTargetTicks = remainingTicks;
            bot.nextHopPausedRemainingMs = -1;
            if (typeof state.hopCount === 'number') {
                bot.hopCount = state.hopCount;
            }
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Hop state restored — next hop in %d min',
                Math.round(remainingMs / 60000));
            return true;
        }
    } catch {
        // Corrupted JSON — ignore and let the bot schedule a fresh hop.
    }
    return false;
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
    if (bot.logInfoValue) titan.log('[Stark Mercher] Hop timer reset');
}

/** Force the next hop to become due immediately (button-triggered).
 *  The hop still waits for a safe boundary before dispatching. */
export function forceHop(bot: StarkMercher): void {
    if (bot.hopInProgress) {
        if (bot.logInfoValue) titan.log('[Stark Mercher] Hop already in progress — ignoring force hop');
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
    if (bot.logInfoValue) titan.log('[Stark Mercher] Hop forced — will dispatch at next safe boundary');
}

// --- Safe boundary (for hop dispatch) ----------------------------------------

const SAFE_BOUNDARY_IDLE_BUFFER_TICKS = 2;

/** Returns a reason string if not safe to hop, or null if safe.
 *
 *  A hop is only safe when the player is idle AND every GE flow has fully
 *  ended. A flow (buy/sell/abort) can sit in a between-clicks wait where
 *  the player is visually stationary, but the world switcher will still be
 *  rejected with a "busy action" message because the flow owns the
 *  interaction state. The flow fields are only cleared once the flow's
 *  state machine returns `done`/`failed` and the auto-loop transitions
 *  back to `idle`, so checking them here is the authoritative signal that
 *  the GE is quiescent. `waiting` (all slots occupied, nothing to do) is
 *  treated as safe — no flow is active and the loop is settled. */
export function getSafeBoundaryReason(bot: StarkMercher): string | null {
    if (bot.hopInProgress) return 'hop in progress';
    // Block hops during the post-login settle period. The client is still
    // rendering the world / clearing promo widgets during this window, and
    // the world switcher rejects with "busy action" if we try to hop now.
    // tickLogic runs hopStep before the postLoginResumeAtMs gate, so without
    // this check the hop is dispatched while the client is still settling,
    // gets rejected, and the native hopIngame() sequence continues to spam
    // Logout/World Switcher clicks that interfere with the auto-loop.
    if (bot.postLoginResumeAtMs > 0) return 'post-login settle in progress';
    if (!isPlayerIdle(bot)) return 'player not idle';
    const tick = titan.state.client.tick;
    if (bot.lastPlayerStationaryTick > 0 && tick - bot.lastPlayerStationaryTick < SAFE_BOUNDARY_IDLE_BUFFER_TICKS) {
        return 'player recently idle';
    }
    // GE flow completion gate — hops must wait until every active flow has
    // fully ended. This is a pure in-memory read (no native SDK queries).
    const loop = bot.autoLoop;
    if (loop.activeBuyFlow || loop.activeSellFlow || loop.activeAbortFlow) {
        return 'GE flow in progress';
    }
    if (loop.phase !== 'idle' && loop.phase !== 'waiting') {
        return `GE auto-loop phase is ${loop.phase}`;
    }
    return null;
}

/** True when it's safe to dispatch a world hop. */
export function isAtSafeBoundary(bot: StarkMercher): boolean {
    return getSafeBoundaryReason(bot) === null;
}

/** True when tickLogic should pause NEW actions because a hop or break is
 *  pending and waiting to dispatch.
 *
 *  CRITICAL: This must NOT pause the auto-loop when an active GE flow
 *  (buy/sell/abort) is in progress. A pending hop sets forceHopPending, which
 *  blocks the auto-loop from starting new flows — but if an active flow is
 *  already running, it MUST be allowed to tick to completion. Otherwise the
 *  flow freezes mid-step (e.g. between "Clicking sell on slot 2" and the next
 *  step), the hop can't fire because isAtSafeBoundary sees the active flow,
 *  and the bot deadlocks until a reload. The flow fields are the authoritative
 *  signal that a GE action is in flight; when they're non-null, the auto-loop
 *  defers to the flow and the hop boundary check must let it through. */
export function shouldPauseForHopBoundary(bot: StarkMercher): boolean {
    if (!bot.forceHopPending) return false;
    // A hop is pending — but don't block the auto-loop if a GE flow is
    // active. The flow needs to tick to completion so the hop can fire at
    // the safe boundary. Blocking here would deadlock: the flow can't
    // advance, and the hop can't fire because the flow is still "in
    // progress" from isAtSafeBoundary's perspective.
    const loop = bot.autoLoop;
    if (loop.activeBuyFlow || loop.activeSellFlow || loop.activeAbortFlow) {
        return false;
    }
    return true;
}

/**
 * Main break entry point. Called at the top of tickLogic.
 * Returns true when the normal auto-loop should be skipped.
 */
export function breakStep(bot: StarkMercher, tick: number): boolean {
    if (bot.terminated) return true;

    // Ensure profile is loaded. Check isLoggedIn first (scalar read, no
    // native handle) and only read localPlayer when actually logged in.
    if (!bot.sessionProfile && titan.state.login.isLoggedIn) {
        initSessionProfile(bot);
    }

    const now = Date.now();

    // --- Handle logged-out states ---
    // Check isLoggedIn first (scalar read, no native handle). The logged-out
    // branch below uses bot.currentPlayerName (tracked from the last login)
    // for break/rotation logic — it does NOT read localPlayer?.name, which
    // would create a native Player handle every tick while waiting out a
    // break. The logged-in path below also does not read localPlayer.
    if (!titan.state.login.isLoggedIn) {
    // We're logged out. Check if we're in an active break.
        if (bot.breakPhase === 'logging_out' || bot.breakPhase === 'logged_out') {
            // If Do Not Sleep was toggled ON while logged out for a nightly
            // break, resume immediately so the account can be logged back in.
            if (bot.doNotSleepValue && bot.breakType === 'nightly') {
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
                // Multi-account rotation: immediately check if a different
                // account is eligible to log in right now. If so, skip the
                // break wait and log in the next account.
                if (tryImmediateRotation(bot)) {
                    return true;
                }
            }

            // Check if break duration has elapsed
            if (bot.breakPhase === 'logged_out' && now >= bot.breakTargetEndMs) {
                // Break is over — start logging in.
                // With multi-account rotation, select the next eligible
                // account from the roster instead of logging back into the
                // same account.
                const nextAccount = selectNextAccountForLogin(bot);
                if (nextAccount) {
                    if (normalizeAccountName(nextAccount) !== normalizeAccountName(bot.currentPlayerName)) {
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
                    // No eligible account found — wait and retry.
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
            // If the login FSM is still handling the title screen (detected
            // but not yet clicked, or clicked but waiting for it to disappear),
            // do NOT clear the break state. Clearing it here calls
            // resetLoginState() which wipes titleFirstSeenAtMs, and the
            // "Player is logged in" title guard at the bottom of breakStep
            // never fires. The auto-loop then runs while the "Click here to
            // play" title is still visible and the GE-open click resolves to
            // text=Play. This happens when isWorldReady() returns true on the
            // same tick the title screen appears (common after a reload during
            // login). Let the FSM click the title on a subsequent tick, then
            // the in-world branch below (or the "Player is logged in" guard)
            // will clear the break state once the title is gone and the settle
            // delay is set.
            if (bot.titleFirstSeenAtMs > 0 || bot.titleWaitingForGone) {
                return true;
            }
            // Check if login succeeded
            if (isInWorld()) {
                bot.breakPhase = 'none';
                bot.breakType = 'none';
                bot.loopIdleForBreak = false;
                bot.loopIdleSinceTick = -1;
                bot.shortBreakDelayTicks = -1;
                bot.nextActionEtaMin = -1;
                // Don't call resetLoginState if loginStep just set a settle
                // delay or is waiting for the title screen to disappear.
                // resetLoginState wipes postLoginResumeAtMs to -1, which
                // causes the bot to run to the GE while the "click here to
                // play" title screen is still visible. The post-login settle
                // logic in tickLogic will handle the cleanup when the settle
                // delay elapses (it sets loginSettled=true and clears
                // postLoginResumeAtMs).
                if (bot.postLoginResumeAtMs <= 0) {
                    resetLoginState(bot);
                }
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

        // Unexpected logout — try to log back in.
        // If rotation is enabled, check whether the current account is still
        // eligible (in the roster and not sleeping). If not, rotate to the
        // next eligible account instead of retrying the same (possibly
        // banned/disconnected) account. Without this, an unexpected logout
        // on a banned account would loop forever retrying that account,
        // ignoring the rest of the roster.
        if (bot.unexpectedLogoutAtMs === 0) {
            bot.unexpectedLogoutAtMs = now;
            saveBreakState(bot);
            // Attempt rotation on the first detection of the unexpected logout.
            if (isRotationEnabled(bot)) {
                const roster = getRoster(bot);
                const currentName = bot.currentPlayerName?.trim() || '';
                const currentNorm = normalizeAccountName(currentName);
                const stillInRoster = roster.some(n => normalizeAccountName(n) === currentNorm);
                const sleeping = stillInRoster && isAccountSleeping(bot, currentName);
                if (!stillInRoster || sleeping) {
                    const nextAccount = selectNextAccount(bot);
                    if (nextAccount && normalizeAccountName(nextAccount) !== currentNorm) {
                        humanLog(bot, 'Unexpected logout: %s no longer eligible%s — rotating to %s',
                            currentName || '(unknown)',
                            sleeping ? ' (sleeping)' : ' (not in roster)',
                            nextAccount);
                        bot.currentPlayerName = nextAccount;
                        bot.sessionProfile = loadOrCreateSessionProfile(bot, nextAccount);
                        if (bot.lastActiveAccountSetting.value !== nextAccount) {
                            bot.lastActiveAccountSetting.value = nextAccount;
                        }
                        bot.nightlyBreakTargetTime = -1;
                        bot.nightlySleepMinutes = -1;
                        resetLoginState(bot);
                    } else if (nextAccount && nextAccount === currentName && sleeping) {
                        // Current account is sleeping and no other account is
                        // eligible — don't retry the sleeping account.
                        humanLog(bot, 'Unexpected logout: %s is sleeping and no other account eligible — waiting',
                            currentName);
                        bot.breakPhase = 'logged_out';
                        bot.breakType = 'nightly';
                        bot.breakTargetEndMs = now + 30000;
                        saveBreakState(bot);
                        return true;
                    }
                }
            }
        }
        loginStep(bot);
        return true;
    }

    // --- Player is logged in ---

    // If the login flow is still in progress (title screen detected but not
    // yet clicked, or title clicked but waiting for it to disappear), let
    // loginStep handle it before we clear any state. Without this, on an
    // unexpected-logout login path, isLoggedIn becomes true while the "Click
    // here to play" title is still visible, and the "Player is logged in"
    // section below calls resetLoginState() — wiping titleFirstSeenAtMs
    // before the title is clicked. The auto-loop then runs and dispatches a
    // GE-open click that resolves to text=Play on the title screen.
    if (bot.titleFirstSeenAtMs > 0 || bot.titleWaitingForGone) {
        loginStep(bot);
        return true;
    }

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
            // Preserve post-login settle delay if loginStep set one (via the
            // title-pending guard above). resetLoginState wipes
            // postLoginResumeAtMs and loginSettled, which would unblock the
            // auto-loop before the world is fully rendered.
            const savedResumeAt = bot.postLoginResumeAtMs;
            const savedSettled = bot.loginSettled;
            resetLoginState(bot);
            if (savedResumeAt > 0) {
                bot.postLoginResumeAtMs = savedResumeAt;
                bot.loginSettled = savedSettled;
            }
            clearBreakState(bot);
        }
    }

    // Check if we just logged back in after a break
    if (bot.breakPhase === 'logging_in') {
        // Mirror the logged-out logging_in branch (line 1036): call
        // loginStep before checking isInWorld(). When isLoggedIn
        // transitions to true while the title screen is still visible,
        // the logged-out branch (which always calls loginStep) is
        // skipped, so titleFirstSeenAtMs is never set. The title guard
        // at line 1144 checks titleFirstSeenAtMs but it's 0, so it
        // doesn't fire. Without calling loginStep here, the break
        // state is cleared and resetLoginState() wipes
        // postLoginResumeAtMs, allowing the auto-loop to run while
        // "Click here to play" is still visible — the GE-open click
        // then resolves to text=Play.
        loginStep(bot);
        if (bot.titleFirstSeenAtMs > 0 || bot.titleWaitingForGone) {
            return true;
        }
        if (isInWorld()) {
            bot.breakPhase = 'none';
            bot.breakType = 'none';
            bot.loopIdleForBreak = false;
            bot.loopIdleSinceTick = -1;
            bot.shortBreakDelayTicks = -1;
            bot.nextActionEtaMin = -1;
            // Preserve post-login settle delay if loginStep set one (via the
            // title-pending guard above). resetLoginState wipes
            // postLoginResumeAtMs and loginSettled, which would unblock the
            // auto-loop before the world is fully rendered.
            const savedResumeAt = bot.postLoginResumeAtMs;
            const savedSettled = bot.loginSettled;
            resetLoginState(bot);
            if (savedResumeAt > 0) {
                bot.postLoginResumeAtMs = savedResumeAt;
                bot.loginSettled = savedSettled;
            }
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
    if (bot.doNotSleepValue && bot.breakType === 'nightly' && bot.breakPhase === 'logging_out') {
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

    // --- Check for top-of-hour pause ---
    // The flips script fetches fresh price data at the top of each hour.
    // Between :59 and :05 (UK time), the bot pauses all activity and logs
    // out. This only triggers when the auto-loop has signalled it's idle
    // (loopIdleForBreak = true) — meaning the current auto-loop iteration
    // has finished and no flow is in progress. The bot never logs out
    // mid-flow.
    //
    // The hour-pause triggers immediately (no random delay) because the
    // user wants the account logged out as soon as possible at :59. The
    // break ends at :05, at which point the normal break-end logic logs
    // the account back in.
    //
    // If the bot is idle and the hour-pause starts within 2 minutes, we
    // suppress the short break to avoid login → idle → hour-pause-logout
    // cycling near :59.
    if (bot.breakPhase === 'none' && bot.loopIdleForBreak && bot.autoModeValue !== 0) {
        if (isInHourPauseWindow()) {
            // Inside the pause window — log out immediately.
            const pauseEndMs = getHourPauseEndMs();
            const durationMs = pauseEndMs - now;
            bot.breakPhase = 'logging_out';
            bot.breakType = 'hour_pause';
            bot.breakStartMs = now;
            bot.breakTargetEndMs = pauseEndMs;
            bot.loopIdleForBreak = false;
            bot.loopIdleSinceTick = -1;
            bot.shortBreakDelayTicks = -1;
            bot.nextActionEtaMin = -1;
            resetLogoutState(bot);
            humanLog(bot, 'Top-of-hour pause starting — %d min logout (until :05)',
                Math.round(durationMs / MS_PER_MINUTE));
            // Record per-account break state for multi-character rotation.
            // The hour-pause is exempt from the 10-min minimum break floor —
            // it's time-bounded by the :05 wall clock and shouldn't be
            // extended by the rotation floor.
            if (isRotationEnabled(bot) && bot.currentPlayerName) {
                recordAccountLogout(bot, bot.currentPlayerName, durationMs, false);
            }
            logoutForBreak(bot, 'hour_pause');
            saveBreakState(bot);
            return true;
        }
        // Not in the pause window yet. If the pause starts within 2 minutes,
        // log out immediately for the hour-pause (target end = :05 UK time).
        // This keeps the bot logged out for the full gap + pause window
        // (~7-8 min) instead of sitting idle for 2 min then logging out for
        // 6 min. GE offers keep filling while logged out, so logging out a
        // couple minutes early is strictly better than idling.
        const pauseStartMs = getNextHourPauseStartMs();
        if (pauseStartMs - now <= HOUR_PAUSE_SUPPRESS_SHORT_BREAK_MS) {
            const pauseEndMs = getHourPauseEndMs();
            const durationMs = pauseEndMs - now;
            bot.breakPhase = 'logging_out';
            bot.breakType = 'hour_pause';
            bot.breakStartMs = now;
            bot.breakTargetEndMs = pauseEndMs;
            bot.loopIdleForBreak = false;
            bot.loopIdleSinceTick = -1;
            bot.shortBreakDelayTicks = -1;
            bot.nextActionEtaMin = -1;
            resetLogoutState(bot);
            humanLog(bot, 'Hour-pause starting early — %d min logout (pause in %ds, until :05)',
                Math.round(durationMs / MS_PER_MINUTE),
                Math.round((pauseStartMs - now) / 1000));
            if (isRotationEnabled(bot) && bot.currentPlayerName) {
                recordAccountLogout(bot, bot.currentPlayerName, durationMs, false);
            }
            logoutForBreak(bot, 'hour_pause');
            saveBreakState(bot);
            return true;
        }
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
    if (bot.breakPhase === 'none' && bot.loopIdleForBreak && bot.autoModeValue !== 0) {
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
        // If the next action is imminent (within 60s), stay logged in
        // and re-check shortly instead of logging out for a 3-min break.
        // This prevents rapid login/nothing-to-do/logout cycling when all
        // slots are occupied and an offer is about to complete or hit an
        // abort threshold. The auto-loop recomputes nextActionEtaMin on
        // each idle tick, so we'll catch the action as soon as it's due.
        if (bot.nextActionEtaMin >= 0 && bot.nextActionEtaMin <= STAY_LOGGED_IN_ETA_THRESHOLD_MIN) {
            const recheckTicks = STAY_LOGGED_IN_RECHECK_TICKS_MIN +
                Math.floor(Math.random() * (STAY_LOGGED_IN_RECHECK_TICKS_MAX - STAY_LOGGED_IN_RECHECK_TICKS_MIN + 1));
            humanLog(bot, 'Staying logged in — next action ETA %smin (≤%smin), re-checking in %d ticks',
                bot.nextActionEtaMin.toFixed(1), STAY_LOGGED_IN_ETA_THRESHOLD_MIN.toFixed(0), recheckTicks);
            // Reset the idle timer so we wait recheckTicks before entering
            // this branch again. Do NOT set checkedAtHalfEta — this is not
            // a completed ETA break, just a deferred re-check.
            bot.loopIdleSinceTick = tick;
            bot.shortBreakDelayTicks = recheckTicks;
            return false;
        }
        const wasHalfEtaCheck = !bot.checkedAtHalfEta;
        const duration = sampleEtaBasedBreakDuration(bot);
        bot.breakPhase = 'logging_out';
        bot.breakType = 'short';
        bot.breakStartMs = now;
        bot.breakTargetEndMs = now + duration;
        bot.loopIdleForBreak = false;
        bot.loopIdleSinceTick = -1;
        bot.shortBreakDelayTicks = -1;
        bot.nextActionEtaMin = -1;
        // Mark that we've taken a break. If this was the first (50%) check,
        // the next break will use 90% of the remaining ETA, preventing rapid
        // cycling when all slots are occupied with slow-filling offers.
        bot.checkedAtHalfEta = true;
        resetLogoutState(bot);
        humanLog(bot, 'Short break starting — %d min logout (%s check)',
            Math.round(duration / MS_PER_MINUTE),
            wasHalfEtaCheck ? '50% ETA' : '90% ETA');
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

/** Called from onMainLoop — handles login/logout dispatch while logged out.
 *  onMainLoop fires at frame rate (30-60 FPS); without throttling this makes
 *  90-300 native SDK calls/sec (localPlayer, login.state, login.isLoggedIn,
 *  widgets.find via loginStep, login.snapshot via loginStep), exhausting the
 *  native handle table over hours and causing 0 FPS. The 1-second throttle
 *  mirrors the mixology wallClockStep and reduces native calls to ~3-5/sec. */
export function wallClockStep(bot: StarkMercher): void {
    if (bot.terminated) return;

    const now = Date.now();
    if (now - bot.lastWallClockMs < 1000) return;
    bot.lastWallClockMs = now;

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

    // If logged out and in a break, check if break is over.
    // NOTE: We use titan.state.login.isLoggedIn (scalar read, no native
    // handle) instead of titan.state.client.localPlayer?.name (creates a
    // native Player handle). wallClockStep runs every second from
    // onMainLoop — a localPlayer read here would create ~28,800 native
    // handles over 8 hours, contributing to native handle table exhaustion
    // (FPS gradually drops to 0). The logged-out block below uses
    // bot.currentPlayerName and titan.state.login.snapshot() for account
    // detection, not localPlayer.
    if (!titan.state.login.isLoggedIn) {
        // Transition logging_out → logged_out. This normally happens in
        // breakStep (onGameTick), but onGameTick doesn't fire while logged
        // out, so we must also handle it here in wallClockStep.
        if (bot.breakPhase === 'logging_out' && bot.logoutComplete) {
            bot.breakPhase = 'logged_out';
            debugLog(bot, `Break: logged out, waiting until ${new Date(bot.breakTargetEndMs).toISOString()}`);
            saveBreakState(bot);
            dumpStateOnLogout(bot);
            // Multi-account rotation: immediately check if a different
            // account is eligible to log in right now. If so, skip the
            // break wait and log in the next account. tryImmediateRotation
            // sets breakPhase='logging_in' on success, so the break-timer
            // check below won't fire.
            tryImmediateRotation(bot);
        }

        // While waiting for the current account's break to end, periodically
        // (every 10 seconds) check if a DIFFERENT account has become eligible
        // (its break elapsed or it woke up). If so, rotate immediately instead
        // of wasting time waiting for the current account's longer break.
        // Note: we do NOT block on stale merchable data here — the bot may
        // have active GE offers that need management. The buy scan checks
        // data validity before placing new buys.
        if (bot.breakPhase === 'logged_out' && now < bot.breakTargetEndMs) {
            if (now - bot.lastIdleRotationCheckMs >= 10000) {
                bot.lastIdleRotationCheckMs = now;
                // Multi-account rotation: check if another account is eligible
                if (isRotationEnabled(bot)) {
                    if (tryImmediateRotation(bot)) {
                        // tryImmediateRotation already logs the rotation
                        // ("Rotation: X logged out — immediately rotating to
                        // Y"). No additional log needed here.
                        return;
                    }
                }
            }
        }

        if (bot.breakPhase === 'logged_out' && now >= bot.breakTargetEndMs) {
            // Break is over — select next account for multi-character rotation.
            const nextAccount = selectNextAccountForLogin(bot);
            if (nextAccount) {
                if (normalizeAccountName(nextAccount) !== normalizeAccountName(bot.currentPlayerName)) {
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
                // No eligible account found — wait and retry.
                humanLog(bot, 'Break ended (%s) but no eligible account found — waiting', bot.breakType);
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
        //
        // When multi-account rotation is enabled, the snapshot's displayName
        // (or the lastActiveAccountSetting fallback) is only used if it is in
        // the roster. The native Titan client persists its own last-used
        // account across client restarts, so a fresh tab may have a stale
        // account staged that is not in the roster (e.g. "Avaer98" when the
        // roster is "Cyber4Gras,Ba112"). In that case, we call
        // selectNextAccount() to pick the correct roster account instead.
        if (!bot.currentPlayerName) {
            const rotationEnabled = isRotationEnabled(bot);
            const roster = getRoster(bot);
            // Throttle titan.state.login.snapshot() to once per 10s — it
            // creates a native handle per call and is only needed to detect
            // the staged account at the login screen.
            let snapshotName: string | null;
            if (now - cachedLoginSnapshotMs < LOGIN_SNAPSHOT_TTL_MS) {
                snapshotName = cachedLoginSnapshotName;
            } else {
                const snap = titan.state.login.snapshot();
                snapshotName = snap?.displayName?.trim() || null;
                cachedLoginSnapshotName = snapshotName;
                cachedLoginSnapshotMs = now;
            }
            const lastActive = bot.lastActiveAccountSetting.value.trim() || null;

            // Candidate priority: snapshot displayName, then lastActiveAccount.
            // When rotation is enabled, each candidate must be in the roster.
            // When the roster has a single name (single-account mode), that
            // name is the user's explicit choice and takes priority over a
            // stale lastActiveAccountSetting from a previous account.
            let chosen: string | null = null;
            if (snapshotName && (!rotationEnabled || roster.includes(snapshotName))) {
                chosen = snapshotName;
            } else if (rotationEnabled && lastActive && roster.includes(lastActive)) {
                chosen = lastActive;
            } else if (!rotationEnabled && roster.length === 1) {
                // Single-account mode: use the one roster entry, not a stale
                // lastActive from a different account.
                chosen = roster[0];
            } else if (lastActive && !rotationEnabled && roster.length === 0) {
                // No roster at all — fall back to lastActive.
                chosen = lastActive;
            } else if (rotationEnabled) {
                // Snapshot/lastActive are missing or not in the roster —
                // select the next eligible account from the roster.
                chosen = selectNextAccount(bot);
            }

            if (chosen) {
                if (chosen === snapshotName) {
                    debugLog(bot, `Account selected at login screen: ${chosen}`);
                } else if (chosen === lastActive) {
                    debugLog(bot, `No account in login snapshot — using last active: ${chosen}`);
                } else {
                    debugLog(bot, `Snapshot account ${snapshotName ?? '(none)'} not in roster — selected ${chosen} instead`);
                }
                bot.currentPlayerName = chosen;
                if (bot.lastActiveAccountSetting.value !== chosen) {
                    bot.lastActiveAccountSetting.value = chosen;
                }
                if (!bot.sessionProfile) {
                    bot.sessionProfile = loadOrCreateSessionProfile(bot, chosen);
                }
            }
        }

        if (bot.breakPhase === 'logging_in' || bot.unexpectedLogoutAtMs > 0) {
            if (!bot.hopInProgress) loginStep(bot);
        }
    }
}

/** Mark the nightly break as finished (called when the bot wakes from nightly sleep).
 *  Also initialises the diurnal pace day bounds: the waking day starts now and
 *  ends at the next nightly break target. */
export function markNightlyBreakFinished(bot: StarkMercher): void {
    const wakeMs = bot.nightlyBreakTargetTime + (bot.nightlySleepMinutes * MS_PER_MINUTE);
    bot.nightlyBreakFinished = getUKMidnightMs(wakeMs);
    // Start a fresh waking day for the diurnal pace multiplier.
    // The next bedtime is the next scheduled nightly break target, which
    // scheduleNextNightlyBreak will compute on its next call. For now, use
    // a 16h waking day as a placeholder — it will be corrected when the
    // schedule is recomputed.
    const placeholderEnd = wakeMs + 16 * MS_PER_MINUTE;
    setDayBounds(wakeMs, placeholderEnd);
}

/** Update the diurnal pace day bounds from the current nightly schedule.
 *  Called when scheduleNextNightlyBreak recomputes the bedtime. The day end
 *  is the bedtime (targetMs). The day start is preserved if already set from
 *  a wake event; otherwise estimated from the previous night's wake time. */
function updateDayBoundsFromSchedule(bot: StarkMercher, bedtimeMs: number): void {
    // If we're currently in a sleep window, don't update — the day hasn't
    // started yet. markNightlyBreakFinished will set the start when we wake.
    const now = Date.now();
    const sleepMs = bot.nightlySleepMinutes * MS_PER_MINUTE;
    if (now >= bedtimeMs && now < bedtimeMs + sleepMs) return;

    // If we're past the bedtime but not yet past the wake time, we're sleeping
    // — don't update day bounds.
    if (now >= bedtimeMs) return;

    // We're in a waking period. The day end is the bedtime.
    // For the day start: if the current fatigue is > 0 (day already started),
    // we keep the existing start. Otherwise, estimate from the previous night.
    const prevWakeMs = bedtimeMs - MS_PER_DAY + sleepMs; // rough: yesterday's wake
    // Use the later of (prevWakeMs, now - 16h) as a fallback start, so the
    // fatigue fraction doesn't start at a huge value if we reload mid-day.
    const fallbackStart = Math.max(prevWakeMs, now - 16 * MS_PER_MINUTE);
    setDayBounds(fallbackStart, bedtimeMs);
}

function isInWorld(): boolean {
    return !!titan.state.client.localPlayer && titan.state.login.isWorldReady;
}
