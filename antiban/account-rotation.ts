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
// Per-account break state (lastLogoutAtMs + minBreakDurationMs +
// lastLoginAtMs) is cached in a hidden JSON setting keyed by account name.
// This lets the bot know "has this account's minimum break lapsed?" and
// "how long has it been since this account last logged in?".
//
// Selection is time-based, not order-based: among all eligible accounts,
// the one whose break ends soonest is selected. If multiple accounts are
// eligible simultaneously (their break ends have all lapsed to now), the
// one that hasn't logged in for the longest (oldest lastLoginAtMs) wins —
// this prevents starvation of accounts that are always later in the roster.
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
    /** When this account last successfully logged in (wall-clock ms).
     *  Used as a tiebreaker when multiple accounts are eligible
     *  simultaneously — the one with the oldest lastLoginAtMs (longest
     *  since last login) is selected to prevent starvation. 0 = never
     *  logged in (highest priority). */
    lastLoginAtMs: number;
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
                    // lastLoginAtMs is optional for backward compat with
                    // state saved before this field existed.
                    return {
                        lastLogoutAtMs: saved.lastLogoutAtMs,
                        minBreakDurationMs: saved.minBreakDurationMs,
                        lastLoginAtMs: typeof saved.lastLoginAtMs === 'number' ? saved.lastLoginAtMs : 0,
                    };
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
 *
 * Selection is time-based, not order-based:
 *   1. Gather all non-sleeping accounts.
 *   2. Filter to eligible accounts (breakEndMs <= now, or no break state).
 *   3. Among eligible accounts, pick the one with the oldest lastLoginAtMs
 *      (longest since last login). Accounts that have never logged in
 *      (lastLoginAtMs = 0) get highest priority.
 *
 * The "soonest break end" criterion is handled by the caller: the 10-second
 * periodic poll and getSoonestBreakEndMs() ensure the bot checks for
 * eligibility at the right time. When the poll fires and multiple accounts
 * are eligible (their breaks ended within the same poll interval), the
 * lastLoginAtMs tiebreaker decides — this prevents starvation of accounts
 * whose breaks consistently end a few seconds after another account's.
 *
 * Returns null if no account is eligible (all sleeping or all on break).
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
    let bestName: string | null = null;
    let bestLastLoginAtMs = Infinity;

    for (const name of roster) {
        // Skip sleeping accounts
        if (isAccountSleeping(bot, name)) continue;

        const breakState = getAccountBreakState(bot, name);
        const breakEndMs = breakState
            ? breakState.lastLogoutAtMs + breakState.minBreakDurationMs
            : 0; // no break state → eligible now (breakEndMs = 0)
        const lastLoginAtMs = breakState?.lastLoginAtMs ?? 0;

        // Skip if break hasn't lapsed
        if (breakEndMs > now) continue;

        // This account is eligible. Pick it if it has an older lastLoginAtMs
        // (longest since last login — prevents starvation).
        if (bestName === null || lastLoginAtMs < bestLastLoginAtMs) {
            bestName = name;
            bestLastLoginAtMs = lastLoginAtMs;
        }
    }

    if (bestName) {
        titan.logf('[Stark Mercher] Rotation: selected account %s (last login %s)',
            bestName,
            bestLastLoginAtMs > 0 ? new Date(bestLastLoginAtMs).toISOString() : 'never');
        return bestName;
    }

    titan.logf('[Stark Mercher] Rotation: no eligible accounts found (all sleeping or on break)');
    return null;
}

/**
 * Compute the soonest break-end time across all non-sleeping roster accounts.
 * Returns the minimum breakEndMs (lastLogoutAtMs + minBreakDurationMs) among
 * all non-sleeping accounts. Accounts with no break state contribute 0
 * (eligible now). Returns Infinity if the roster is empty or all accounts
 * are sleeping.
 *
 * Used by the overlay to show the actual wait time until the next account
 * becomes eligible, rather than the current account's break end.
 */
export function getSoonestBreakEndMs(bot: StarkMercher): number {
    const roster = getRoster(bot);
    if (roster.length === 0) return Infinity;
    let soonest = Infinity;
    for (const name of roster) {
        if (isAccountSleeping(bot, name)) continue;
        const breakState = getAccountBreakState(bot, name);
        const breakEndMs = breakState
            ? breakState.lastLogoutAtMs + breakState.minBreakDurationMs
            : 0;
        if (breakEndMs < soonest) soonest = breakEndMs;
    }
    return soonest;
}

/**
 * Returns the name of the account that will log in next, for overlay display.
 *
 * If any account is eligible now (break lapsed), returns the one with the
 * oldest lastLoginAtMs (same as selectNextAccount). If none are eligible,
 * returns the one with the soonest breakEndMs (the next to become eligible).
 * Returns null if the roster is empty or all accounts are sleeping.
 */
export function getNextAccountName(bot: StarkMercher): string | null {
    const roster = getRoster(bot);
    if (roster.length === 0) return null;
    if (roster.length === 1) return roster[0];

    const now = Date.now();
    let eligibleBest: string | null = null;
    let eligibleBestLastLoginAtMs = Infinity;
    let waitingBest: string | null = null;
    let waitingBestBreakEndMs = Infinity;

    for (const name of roster) {
        if (isAccountSleeping(bot, name)) continue;
        const breakState = getAccountBreakState(bot, name);
        const breakEndMs = breakState
            ? breakState.lastLogoutAtMs + breakState.minBreakDurationMs
            : 0;
        const lastLoginAtMs = breakState?.lastLoginAtMs ?? 0;

        if (breakEndMs <= now) {
            // Eligible — pick oldest lastLoginAtMs
            if (eligibleBest === null || lastLoginAtMs < eligibleBestLastLoginAtMs) {
                eligibleBest = name;
                eligibleBestLastLoginAtMs = lastLoginAtMs;
            }
        } else {
            // Not yet eligible — track soonest break end
            if (waitingBest === null || breakEndMs < waitingBestBreakEndMs) {
                waitingBest = name;
                waitingBestBreakEndMs = breakEndMs;
            }
        }
    }

    // Prefer eligible accounts; fall back to the soonest break end
    return eligibleBest ?? waitingBest;
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
// The rotation index is no longer used for selection (selection is now
// time-based), but the setting is kept for backward compatibility and
// potential future use.

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
 * Preserves lastLoginAtMs from any existing state so the tiebreaker
 * still works across multiple logout/login cycles.
 */
export function recordAccountLogout(bot: StarkMercher, accountName: string, breakDurationMs: number): void {
    if (!accountName) return;
    const existing = getAccountBreakState(bot, accountName);
    const state: AccountBreakState = {
        lastLogoutAtMs: Date.now(),
        minBreakDurationMs: breakDurationMs,
        lastLoginAtMs: existing?.lastLoginAtMs ?? 0,
    };
    saveAccountBreakState(bot, accountName, state);
    titan.logf('[Stark Mercher] Rotation: recorded logout for %s (min break %d min)',
        accountName, Math.round(breakDurationMs / 60000));
}

/**
 * Record a successful login for an account. Instead of clearing the break
 * state entirely, we keep the entry but reset the break fields and update
 * lastLoginAtMs to now. This preserves the login timestamp for the
 * tiebreaker in future selection calls.
 */
export function recordAccountLogin(bot: StarkMercher, accountName: string): void {
    if (!accountName) return;
    const state: AccountBreakState = {
        lastLogoutAtMs: 0,
        minBreakDurationMs: 0,
        lastLoginAtMs: Date.now(),
    };
    saveAccountBreakState(bot, accountName, state);
}
