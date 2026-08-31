// ============================================================================
// Daily profit tracking — persisted per-account, resets at midnight
// ============================================================================
// Tracks total profit (in gp) made since 00:00 of the current day (UK/local).
// Profit is recorded each time a sell offer is confirmed 100% completed in
// the auto-loop's collect step. The data is persisted in a hidden plugin
// setting (JSON-encoded) so it survives client restarts and plugin reloads.
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
    const d = new Date(now);
    // Use Europe/London timezone via Intl to handle BST/GMT correctly.
    const ukDateStr = d.toLocaleString('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
    const [year, month, day] = ukDateStr.split('/').map(Number);
    // Construct a Date at UTC midnight for that UK calendar day. This is
    // an approximation — the actual UTC offset varies with BST, but since
    // we only compare dayStartedAt values for equality (same day vs. a
    // different day), the exact offset doesn't matter as long as it's
    // consistent within the same day.
    return Date.UTC(year, month - 1, day, 0, 0, 0);
};

// --- Load / Save -----------------------------------------------------------

const loadState = (bot: StarkMercher): DailyProfitState => {
    const raw = bot.dailyProfitSetting.value;
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed as DailyProfitState;
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

/**
 * Returns the current day's profit for the given account, or 0 if no data
 * exists for today. Automatically resets if the stored data is from a
 * previous day (day rollover detection).
 */
export const getDailyProfit = (bot: StarkMercher, accountName: string): number => {
    const state = loadState(bot);
    const entry = state[accountName];
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
    const existing = state[accountName];
    if (existing && existing.dayStartedAt === todayStart) {
        existing.profit += amount;
    } else {
        // New day or first entry — start fresh.
        state[accountName] = { dayStartedAt: todayStart, profit: amount };
    }
    saveState(bot, state);
};

/**
 * Resets the daily profit for the given account to 0 for the current day.
 * Mainly used for manual reset or testing.
 */
export const resetDailyProfit = (bot: StarkMercher, accountName: string): void => {
    if (!accountName) return;
    const state = loadState(bot);
    const todayStart = getDayStartMs(Date.now());
    state[accountName] = { dayStartedAt: todayStart, profit: 0 };
    saveState(bot, state);
};
