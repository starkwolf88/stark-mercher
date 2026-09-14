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

// Throttle for the "no eligible accounts found" log. selectNextAccount can be
// called multiple times in the same tick (once from the break-step logout
// path, once from wallClockStep's 10s poll), producing duplicate messages.
// Only log once every 10 seconds.
let lastNoEligibleLogMs = 0;
const NO_ELIGIBLE_LOG_INTERVAL_MS = 10_000;

// --- Parsed-JSON caches -----------------------------------------------------
// The rotation functions (selectNextAccount, getSoonestBreakEndMs,
// getNextAccountName, isRotationDueForLoggedIn) iterate the roster and call
// getRoster + getAccountBreakState per account. Each reads a Setting.value
// (crossing the JS<->native boundary) and JSON.parses the result. With N
// accounts, a single selectNextAccount call does 1 + N×2 native reads; the
// overlay calls getSoonestBreakEndMs + getNextAccountName + isRotationEnabled
// every 2 seconds (3 + N×4 reads). Over 8 hours with 5 accounts that's
// ~331k native boundary crossings just for rotation — a major contributor
// to FPS degradation in multi-account mode.
//
// The parsed JSON is cached at module level. The cache is invalidated:
//   1. On writes (saveAccountBreakState, clearAccountBreakState) — the
//      writer updates the cache in place after persisting, so the next read
//      sees the new value without a native read + parse.
//   2. On onSettingChanged for the roster key (user edited the roster).
//   3. On onDisable (toggle off/on does not re-evaluate the module).
let cachedRoster: string[] | null = null;
let cachedBreakStates: Record<string, AccountBreakState> | null = null;

/** Invalidates all rotation caches. Called from onDisable and onSettingChanged
 *  for the roster key. */
export const invalidateRotationCaches = (): void => {
    cachedRoster = null;
    cachedBreakStates = null;
};

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
 * Normalize an account name for comparison/keying: collapses all whitespace
 * (including non-breaking spaces U+00A0 and other Unicode whitespace) to a
 * single regular space, trims, and lowercases.
 *
 * The OSRS client's `localPlayer.name` can contain non-breaking spaces
 * (e.g. "hc\u00A0fruitz") while the roster uses regular spaces ("hc fruitz").
 * Without normalization the same account appears as two different keys,
 * breaking break-state lookup and same-account rotation checks. This mirrors
 * the `normalizeAccountKey` helper in data/daily-profit.ts.
 */
export function normalizeAccountName(name: string): string {
    if (!name) return '';
    return name
        .replace(/[\s\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Parse the accountRoster setting into an array of trimmed account names.
 * Returns [] if the setting is empty or contains no valid names.
 */
export function getRoster(bot: StarkMercher): string[] {
    if (cachedRoster) return cachedRoster;
    const raw = bot.accountRosterSetting.value.trim();
    if (!raw) {
        cachedRoster = [];
        return cachedRoster;
    }
    cachedRoster = raw
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0);
    return cachedRoster;
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
    if (!cachedBreakStates) {
        try {
            const raw = bot.accountBreakStateSetting.value;
            if (raw && raw !== '{}') {
                const all = JSON.parse(raw);
                if (all && typeof all === 'object') {
                    cachedBreakStates = all as Record<string, AccountBreakState>;
                } else {
                    cachedBreakStates = {};
                }
            } else {
                cachedBreakStates = {};
            }
        } catch (e) {
            titan.logf('[Stark Mercher] Failed to parse account break states: %s', String(e));
            cachedBreakStates = {};
        }
    }
    const saved = cachedBreakStates[accountName];
    if (saved && typeof saved === 'object' &&
        typeof saved.lastLogoutAtMs === 'number' &&
        typeof saved.minBreakDurationMs === 'number') {
        return {
            lastLogoutAtMs: saved.lastLogoutAtMs,
            minBreakDurationMs: saved.minBreakDurationMs,
            lastLoginAtMs: typeof saved.lastLoginAtMs === 'number' ? saved.lastLoginAtMs : 0,
        };
    }
    return null;
}

/**
 * Save the break state for a specific account into the hidden setting.
 */
export function saveAccountBreakState(bot: StarkMercher, accountName: string, state: AccountBreakState): void {
    try {
        // Ensure the cache is populated so we can update it in place.
        if (!cachedBreakStates) {
            getAccountBreakState(bot, accountName); // populates cachedBreakStates
        }
        if (cachedBreakStates) {
            cachedBreakStates[accountName] = state;
        }
        bot.accountBreakStateSetting.value = JSON.stringify(cachedBreakStates ?? { [accountName]: state });
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save account break state: %s', String(e));
    }
}

/**
 * Clear the break state for a specific account (e.g. after successful login).
 */
export function clearAccountBreakState(bot: StarkMercher, accountName: string): void {
    try {
        if (!cachedBreakStates) {
            getAccountBreakState(bot, accountName); // populates cachedBreakStates
        }
        if (cachedBreakStates && cachedBreakStates[accountName]) {
            delete cachedBreakStates[accountName];
            bot.accountBreakStateSetting.value = JSON.stringify(cachedBreakStates);
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
    if (bot.doNotSleepValue) return false;

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
        if (bot.logInfoValue) titan.logf('[Stark Mercher] Rotation: selected account %s (last login %s)',
            bestName,
            bestLastLoginAtMs > 0 ? new Date(bestLastLoginAtMs).toISOString() : 'never');
        return bestName;
    }

    const nowMs = Date.now();
    if (nowMs - lastNoEligibleLogMs >= NO_ELIGIBLE_LOG_INTERVAL_MS) {
        lastNoEligibleLogMs = nowMs;
        if (bot.logInfoValue) titan.logf('[Stark Mercher] Rotation: no eligible accounts found (all sleeping or on break)');
    }
    return null;
}

/**
 * Check whether a DIFFERENT account is eligible for login right now, while
 * the current account is logged in (e.g. performing an idle activity).
 *
 * Returns the name of the eligible different account, or null if:
 *   - Rotation is disabled (roster < 2)
 *   - No other account is eligible (all sleeping or on break)
 *   - Only the current account is eligible (same-account relogin)
 *
 * This is the "rotation over idle activity" trigger: when the current
 * account is doing an idle activity (chocolate dust, ultra compost, goat
 * horn) and another account's break lapses, the current account should
 * clean up (bank items) and log out so the eligible account can log in.
 * Without this check, the current account keeps grinding the idle
 * activity until its own nightly break, leaving the eligible account
 * waiting.
 *
 * The caller is responsible for throttling — this function iterates the
 * roster and parses the break-state JSON setting per account, so it
 * should not be called every tick. A 10-second throttle on
 * bot.lastLoggedInRotationCheckMs matches the existing wallClockStep
 * rotation poll.
 */
export function isRotationDueForLoggedIn(bot: StarkMercher): string | null {
    if (!isRotationEnabled(bot)) return null;
    const nextAccount = selectNextAccount(bot);
    if (!nextAccount) return null;
    // Only signal rotation if a DIFFERENT account is eligible. If the
    // same account is selected, no other account is ready — stay on the
    // current idle activity.
    if (normalizeAccountName(nextAccount) === normalizeAccountName(bot.currentPlayerName)) {
        return null;
    }
    return nextAccount;
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
 *
 * Enforces a minimum 10-minute break duration so that account rotation
 * doesn't cycle accounts too quickly. Nightly sleep durations (4.5-7.5h)
 * are well above this floor and are unaffected. The hour-pause break
 * (6 min, :59→:05) is exempt via enforceMinBreak=false so it keeps its
 * own shorter duration — the hour-pause is time-bounded by the :05 wall
 * clock and shouldn't be extended by the rotation floor.
 */
const MIN_ACCOUNT_BREAK_MS = 10 * 60 * 1000; // 10 minutes
export function recordAccountLogout(
    bot: StarkMercher,
    accountName: string,
    breakDurationMs: number,
    enforceMinBreak: boolean = true,
): void {
    if (!accountName) return;
    // Enforce minimum break duration so accounts don't get re-selected
    // too quickly during rotation. The hour-pause opts out.
    const effectiveBreakMs = enforceMinBreak
        ? Math.max(breakDurationMs, MIN_ACCOUNT_BREAK_MS)
        : breakDurationMs;
    const existing = getAccountBreakState(bot, accountName);
    const state: AccountBreakState = {
        lastLogoutAtMs: Date.now(),
        minBreakDurationMs: effectiveBreakMs,
        lastLoginAtMs: existing?.lastLoginAtMs ?? 0,
    };
    saveAccountBreakState(bot, accountName, state);
    if (bot.logInfoValue) titan.logf('[Stark Mercher] Rotation: recorded logout for %s (min break %d min%s)',
        accountName, Math.round(effectiveBreakMs / 60000),
        effectiveBreakMs > breakDurationMs ? ' [clamped to 10 min min]' : '');
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
