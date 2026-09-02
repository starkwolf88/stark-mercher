// ============================================================================
// Account rotation — multi-character roster management
// ============================================================================
// Manages rotation through a roster of accounts. Each account runs the full
// auto-merch loop until it goes idle (all slots occupied, nothing to do),
// then logs out. Instead of logging back into the same account, the bot
// selects the next eligible account from the roster.
//
// An account is eligible for login when:
//   1. It is outside its nightly sleep window (checked via its SessionProfile)
//   2. Its minimum break duration has lapsed since it last logged out
//
// Per-account break state (lastLogoutAtMs + minBreakDurationMs) is cached in
// a hidden JSON setting keyed by account name. This lets the bot know "has
// this account's minimum break lapsed?" when the rotation reaches it.
//
// The rotation index is persisted so it survives hot reloads. Each time we
// select an account, the index advances past it (modulo roster length).
//
// When the roster is empty or has a single name, the bot behaves exactly as
// it does today — no rotation, same account relogin.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import type { SessionProfile } from './session-profile.js';
import { loadOrCreateSessionProfile } from './session-profile.js';

// --- Types ------------------------------------------------------------------

export interface AccountBreakState {
    /** When this account last logged out (wall-clock ms). */
    lastLogoutAtMs: number;
    /** Minimum break duration in ms — the account won't be logged back in
     *  until this much time has elapsed since lastLogoutAtMs. */
    minBreakDurationMs: number;
}

// --- Roster parsing ---------------------------------------------------------

/**
 * Parse the accountRoster setting into an array of trimmed account names.
 * Returns [] if the setting is empty or contains no valid names.
 */
export function getRoster(bot: StarkMercher): string[] {
    const raw = bot.accountRosterSetting.value.trim();
    if (!raw) return [];
    return raw
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0);
}

/**
 * Returns true if multi-account rotation is active (roster has 2+ names).
 */
export function isRotationEnabled(bot: StarkMercher): boolean {
    return getRoster(bot).length >= 2;
}

// --- Per-account break state cache ------------------------------------------

/**
 * Load the break state for a specific account from the hidden setting.
 * Returns null if no break state is stored for this account.
 */
export function getAccountBreakState(bot: StarkMercher, accountName: string): AccountBreakState | null {
    try {
        const raw = bot.accountBreakStateSetting.value;
        if (raw && raw !== '{}') {
            const all = JSON.parse(raw);
            if (all && typeof all === 'object') {
                const saved = all[accountName];
                if (saved && typeof saved === 'object' &&
                    typeof saved.lastLogoutAtMs === 'number' &&
                    typeof saved.minBreakDurationMs === 'number') {
                    return saved as AccountBreakState;
                }
            }
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse account break states: %s', String(e));
    }
    return null;
}

/**
 * Save the break state for a specific account into the hidden setting.
 */
export function saveAccountBreakState(bot: StarkMercher, accountName: string, state: AccountBreakState): void {
    try {
        let all: Record<string, unknown> = {};
        const raw = bot.accountBreakStateSetting.value;
        if (raw && raw !== '{}') {
            try { all = JSON.parse(raw) ?? {}; } catch { all = {}; }
        }
        all[accountName] = state;
        bot.accountBreakStateSetting.value = JSON.stringify(all);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save account break state: %s', String(e));
    }
}

/**
 * Clear the break state for a specific account (e.g. after successful login).
 */
export function clearAccountBreakState(bot: StarkMercher, accountName: string): void {
    try {
        const raw = bot.accountBreakStateSetting.value;
        if (raw && raw !== '{}') {
            const all = JSON.parse(raw);
            if (all && typeof all === 'object' && all[accountName]) {
                delete all[accountName];
                bot.accountBreakStateSetting.value = JSON.stringify(all);
            }
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to clear account break state: %s', String(e));
    }
}

// --- Sleep window check -----------------------------------------------------

/**
 * Check if an account is currently within its nightly sleep window.
 * Uses the account's SessionProfile to compute today's bedtime and wake time.
 * Returns true if the account should be sleeping now.
 */
export function isAccountSleeping(bot: StarkMercher, accountName: string): boolean {
    if (bot.doNotSleep?.value) return false;

    const profile = loadOrCreateSessionProfile(bot, accountName);
    if (!profile) return false;

    // Compute today's bedtime and wake time from the profile.
    // We use the profile's base values (without random sampling) for the
    // sleep-window check — the actual nightly break duration is sampled
    // when the break triggers, but the window boundaries are determined
    // by the profile's base sleep length and wake time.
    const sleepMinutes = profile.nightlySleepLengthBase;
    const wakeMinutes = profile.nightlyWakeBase;

    const now = Date.now();
    const nowDate = new Date(now);
    const offsetMs = getUKOffsetMinutes(nowDate) * 60000;
    const uk = new Date(now + offsetMs);
    const ukMidnight = now - (uk.getUTCHours() * 60 + uk.getUTCMinutes()) * 60000 - uk.getUTCSeconds() * 1000;

    const todayWake = ukMidnight + wakeMinutes * 60000;
    const todayBed = todayWake - sleepMinutes * 60000; // may be negative = yesterday

    // The sleep window is [bedtime, wake time). If bedtime is before midnight
    // (e.g. 02:00 for a 07:00 wake + 5h sleep), the window spans midnight.
    if (todayBed < ukMidnight) {
        // Window spans midnight: [todayBed, todayWake) or [yesterdayBed, todayWake)
        // Check if we're in either portion
        if (now >= todayBed && now < todayWake) return true;
        // Also check yesterday's window (if we're before today's bedtime)
        const yesterdayBed = todayBed - 86400000;
        if (now >= yesterdayBed && now < todayWake - 86400000) {
            // This would mean we're before midnight but in yesterday's sleep window
            // Actually this case is covered by todayBed < ukMidnight check above
        }
        // Check if we're in the early-morning portion of a window that started yesterday
        const yesterdayWake = todayWake - 86400000;
        const yesterdayBed2 = yesterdayWake - sleepMinutes * 60000;
        if (now >= yesterdayBed2 && now < yesterdayWake) return true;
    } else {
        // Window is entirely within today: [todayBed, todayWake)
        if (now >= todayBed && now < todayWake) return true;
        // Also check yesterday's window (which extends into today)
        const yesterdayBed = todayBed - 86400000;
        const yesterdayWake = todayWake - 86400000;
        if (now >= yesterdayBed && now < yesterdayWake) return true;
    }

    return false;
}

// UK offset helper (duplicated from session.ts to avoid circular imports)
function getUKOffsetMinutes(d: Date): number {
    const year = d.getUTCFullYear();
    let bstStart = new Date(Date.UTC(year, 2, 31));
    while (bstStart.getUTCDay() !== 0) bstStart = new Date(bstStart.getTime() - 86400000);
    let bstEnd = new Date(Date.UTC(year, 9, 31));
    while (bstEnd.getUTCDay() !== 0) bstEnd = new Date(bstEnd.getTime() - 86400000);
    const bstStartMs = bstStart.getTime();
    const bstEndMs = bstEnd.getTime();
    const nowMs = d.getTime();
    return (nowMs >= bstStartMs && nowMs < bstEndMs) ? 60 : 0;
}

// --- Account selection ------------------------------------------------------

/**
 * Select the next eligible account from the roster.
 * Starting from the current rotationIndex, iterates through the roster
 * (wrapping around) and returns the first account that:
 *   1. Is not currently sleeping (outside its nightly sleep window)
 *   2. Has no break state, OR its minimum break has lapsed
 *
 * Returns null if no account is eligible (all sleeping or all on break).
 * The rotationIndex is advanced to the selected account's position + 1
 * (so the next call starts after the one we just selected).
 */
export function selectNextAccount(bot: StarkMercher): string | null {
    const roster = getRoster(bot);
    if (roster.length === 0) return null;
    if (roster.length === 1) {
        // Single account — just check if it's eligible
        const name = roster[0];
        if (isAccountEligible(bot, name)) return name;
        return null;
    }

    const now = Date.now();
    const startIndex = bot.rotationIndex % roster.length;

    for (let i = 0; i < roster.length; i++) {
        const idx = (startIndex + i) % roster.length;
        const name = roster[idx];

        if (isAccountEligible(bot, name)) {
            // Advance rotation index past this account
            bot.rotationIndex = (idx + 1) % roster.length;
            saveRotationIndex(bot, bot.rotationIndex);
            titan.logf('[Stark Mercher] Rotation: selected account %s (index %d)', name, idx);
            return name;
        }
    }

    titan.logf('[Stark Mercher] Rotation: no eligible accounts found (all sleeping or on break)');
    return null;
}

/**
 * Check if an account is eligible for login:
 *   1. Not sleeping (outside nightly sleep window)
 *   2. Break state has lapsed (or no break state exists)
 */
function isAccountEligible(bot: StarkMercher, accountName: string): boolean {
    // Check sleep window
    if (isAccountSleeping(bot, accountName)) {
        return false;
    }

    // Check break state
    const breakState = getAccountBreakState(bot, accountName);
    if (breakState) {
        const now = Date.now();
        const breakEndMs = breakState.lastLogoutAtMs + breakState.minBreakDurationMs;
        if (now < breakEndMs) {
            return false; // minimum break hasn't lapsed
        }
    }

    return true;
}

// --- Rotation index persistence ---------------------------------------------

export function loadRotationIndex(bot: StarkMercher): number {
    try {
        const raw = bot.rotationIndexSetting.value.trim();
        if (raw) {
            const idx = parseInt(raw, 10);
            if (Number.isFinite(idx) && idx >= 0) return idx;
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse rotation index: %s', String(e));
    }
    return 0;
}

export function saveRotationIndex(bot: StarkMercher, index: number): void {
    bot.rotationIndexSetting.value = String(index);
}

// --- Break state recording --------------------------------------------------

/**
 * Record break state for an account when it logs out.
 * Called from the break system when a short or nightly break starts.
 */
export function recordAccountLogout(bot: StarkMercher, accountName: string, breakDurationMs: number): void {
    if (!accountName) return;
    const state: AccountBreakState = {
        lastLogoutAtMs: Date.now(),
        minBreakDurationMs: breakDurationMs,
    };
    saveAccountBreakState(bot, accountName, state);
    titan.logf('[Stark Mercher] Rotation: recorded logout for %s (min break %d min)',
        accountName, Math.round(breakDurationMs / 60000));
}

/**
 * Clear break state for an account when it successfully logs in.
 */
export function recordAccountLogin(bot: StarkMercher, accountName: string): void {
    if (!accountName) return;
    clearAccountBreakState(bot, accountName);
}
