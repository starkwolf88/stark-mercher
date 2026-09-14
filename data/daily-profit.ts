// ============================================================================
// Daily profit tracking — persisted per-account, resets at midnight
// ============================================================================
// Tracks total profit (in gp) made since 00:00 of the current day (UK/local).
// Profit is recorded each time a sell offer is confirmed 100% completed in
// the auto-loop's collect step. The data is persisted in a hidden plugin
// setting (JSON-encoded) so it survives hot reloads. Includes duplicate
// account-key migration on load.
//
// Day rollover is handled by comparing the stored `dayStartedAt` timestamp
// to the current day's midnight. If they differ (new day), the profit is
// reset. This handles the case where the script is stopped before midnight
// and started at any point the next day.
//
// Usage:
//   import { addDailyProfit, getDailyProfit, resetDailyProfit } from '../data/daily-profit.js';
//   addDailyProfit(bot, 'PlayerName', 54000);  // add 54k profit
//   const profit = getDailyProfit(bot, 'PlayerName');  // 54000
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { getRoster } from '../antiban/account-rotation.js';

// --- Types -----------------------------------------------------------------

export interface DailyProfitEntry {
    /** Epoch ms at 00:00 (start) of the day this profit belongs to. */
    dayStartedAt: number;
    /** Total profit in gp accumulated since dayStartedAt. */
    profit: number;
}

export interface DailyProfitState {
    [accountName: string]: DailyProfitEntry;
}

// --- Day helpers -----------------------------------------------------------

/**
 * Returns the epoch ms of midnight (00:00) at the start of the given
 * timestamp's day, using UK-local time. We use UK time for consistency
 * with the session/break system (which also uses UK-local calendar
 * handling inherited from Mixology).
 */
export const getDayStartMs = (now: number): number => {
    // Use UTC midnight as the day boundary. The Titan plugin runtime does
    // not expose `Intl`, so we can't use timezone-aware formatting. UTC
    // is fine here because we only compare dayStartedAt values for
    // equality (same day vs. a different day) — the exact wall-clock
    // boundary doesn't matter as long as it's consistent.
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
};

// --- Load / Save -----------------------------------------------------------

const normalizeAccountKey = (name: string): string => {
    if (!name) return '';
    return name
        .replace(/[\s\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]+/g, ' ')
        .trim()
        .toLowerCase();
};

/**
 * Merges duplicate account keys that are equivalent under trimming + casing
 * (e.g. "HC fruitz" and "hc fruitz"). For each normalized name with multiple
 * raw keys, the daily-profit entries are combined: if multiple keys have
 * entries for the same dayStartedAt, their profits are summed; otherwise the
 * most recent dayStartedAt entry wins (daily profit only tracks the current
 * day, so older entries are stale). The merged result is stored under a
 * single canonical key (roster match preferred, else first-seen raw key) and
 * written back only if a merge occurred. Mirrors the merch/abort-history
 * migrations so all three account-keyed stores stay consistent.
 */
const migrateDuplicateKeys = (
    bot: StarkMercher,
    state: DailyProfitState,
): DailyProfitState => {
    const rawKeys = Object.keys(state);
    if (rawKeys.length < 2) return state;

    const groups = new Map<string, string[]>();
    for (const key of rawKeys) {
        const norm = normalizeAccountKey(key);
        if (!norm) continue;
        const arr = groups.get(norm);
        if (arr) arr.push(key);
        else groups.set(norm, [key]);
    }

    let needsMerge = false;
    for (const arr of groups.values()) {
        if (arr.length > 1) { needsMerge = true; break; }
    }
    if (!needsMerge) return state;

    const roster = getRoster(bot);
    const rosterByNorm = new Map<string, string>();
    for (const name of roster) {
        const norm = normalizeAccountKey(name);
        if (norm && !rosterByNorm.has(norm)) rosterByNorm.set(norm, name);
    }

    const merged: DailyProfitState = {};
    for (const [norm, keys] of groups) {
        if (keys.length === 1) {
            merged[keys[0]] = state[keys[0]];
            continue;
        }
        const canonical = rosterByNorm.get(norm) ?? keys[0];
        // Sum profits for the same dayStartedAt; keep the most recent
        // dayStartedAt if entries span different days.
        const byDay = new Map<number, number>();
        for (const key of keys) {
            const entry = state[key];
            if (!entry) continue;
            const existing = byDay.get(entry.dayStartedAt);
            if (existing !== undefined) {
                byDay.set(entry.dayStartedAt, existing + entry.profit);
            } else {
                byDay.set(entry.dayStartedAt, entry.profit);
            }
        }
        // Pick the most recent dayStartedAt (largest value = latest day).
        let bestDay = -1;
        let bestProfit = 0;
        for (const [day, profit] of byDay) {
            if (day > bestDay) { bestDay = day; bestProfit = profit; }
        }
        merged[canonical] = { dayStartedAt: bestDay, profit: bestProfit };

        titan.logf(
            '[Stark Mercher] Daily profit: merged %d duplicate account keys into "%s" (dayStartedAt=%s, profit=%d).',
            keys.length, canonical, String(bestDay), bestProfit,
        );
    }

    saveState(bot, merged);
    return merged;
};

const loadState = (bot: StarkMercher): DailyProfitState => {
    const raw = bot.dailyProfitSetting.value;
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            const state = parsed as DailyProfitState;
            return migrateDuplicateKeys(bot, state);
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse daily profit state: %s', String(e));
    }
    return {};
};

const saveState = (bot: StarkMercher, state: DailyProfitState): void => {
    try {
        bot.dailyProfitSetting.value = JSON.stringify(state);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save daily profit state: %s', String(e));
    }
};

// --- Public API ------------------------------------------------------------

/** Normalized-key fallback lookup. If the exact key isn't found, searches
 *  for a key that matches after trim + lowercase. Returns the entry or
 *  undefined. Defensive measure — initSessionProfile normally canonicalizes
 *  currentPlayerName to the roster version, which matches the migration's
 *  canonical key. */
const findNormalized = (state: DailyProfitState, accountName: string): DailyProfitEntry | undefined => {
    const norm = normalizeAccountKey(accountName);
    for (const [key, entry] of Object.entries(state)) {
        if (normalizeAccountKey(key) === norm) return entry;
    }
    return undefined;
};

/**
 * Returns the current day's profit for the given account, or 0 if no data
 * exists for today. Automatically resets if the stored data is from a
 * previous day (day rollover detection).
 */
export const getDailyProfit = (bot: StarkMercher, accountName: string): number => {
    const state = loadState(bot);
    const entry = state[accountName] ?? findNormalized(state, accountName);
    if (!entry) return 0;
    const todayStart = getDayStartMs(Date.now());
    if (entry.dayStartedAt !== todayStart) {
        // Day rollover — reset to 0 for the new day.
        return 0;
    }
    return entry.profit;
};

/**
 * Adds `amount` gp to the current day's profit for the given account.
 * Handles day rollover: if the stored data is from a previous day, the
 * profit is reset to `amount` (the first profit of the new day).
 */
export const addDailyProfit = (bot: StarkMercher, accountName: string, amount: number): void => {
    if (!accountName || amount === 0) return;
    const state = loadState(bot);
    const todayStart = getDayStartMs(Date.now());
    // Use the existing key if one matches under normalization, to avoid
    // re-creating duplicate keys with different invisible whitespace.
    let key = accountName;
    if (!state[key]) {
        const norm = normalizeAccountKey(accountName);
        for (const existingKey of Object.keys(state)) {
            if (normalizeAccountKey(existingKey) === norm) { key = existingKey; break; }
        }
    }
    const existing = state[key];
    if (existing && existing.dayStartedAt === todayStart) {
        existing.profit += amount;
    } else {
        // New day or first entry — start fresh.
        state[key] = { dayStartedAt: todayStart, profit: amount };
    }
    saveState(bot, state);
    if (bot.logDebugValue) {
        titan.logf('[Stark Mercher] Daily profit: stored %dgp for %s (dayStartedAt=%s, total=%d)',
            amount, accountName, String(todayStart), state[key].profit);
    }
};

/**
 * Resets the daily profit for the given account to 0 for the current day.
 * Mainly used for manual reset or testing.
 */
export const resetDailyProfit = (bot: StarkMercher, accountName: string): void => {
    if (!accountName) return;
    const state = loadState(bot);
    const todayStart = getDayStartMs(Date.now());
    // Use the existing key if one matches under normalization.
    let key = accountName;
    if (!state[key]) {
        const norm = normalizeAccountKey(accountName);
        for (const existingKey of Object.keys(state)) {
            if (normalizeAccountKey(existingKey) === norm) { key = existingKey; break; }
        }
    }
    state[key] = { dayStartedAt: todayStart, profit: 0 };
    saveState(bot, state);
};
