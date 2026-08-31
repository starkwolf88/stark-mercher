// ============================================================================
// Merch history — persisted record of completed merch cycles
// ============================================================================
// When a merch cycle completes (all units sold), a summary entry is recorded
// here. Profits and losses are stored separately so the user can review
// successful and unsuccessful merches independently.
//
// Each entry captures:
//   - item name
//   - total quantity sold
//   - total profit or loss (in gp)
//   - timestamp of the last batch sold (readable ISO string)
//   - buy price per item
//   - weighted average sell price across all price revisions
//   - number of price revisions before the cycle completed
//
// The data is persisted in a hidden plugin setting (JSON-encoded) keyed by
// account name, surviving client restarts and plugin reloads.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';

// --- Types ------------------------------------------------------------------

export interface MerchHistoryEntry {
    item: string;
    qty: number;
    /** Total profit (positive) or loss (negative) in gp. */
    profit: number;
    /** ISO timestamp of the last batch sold. */
    date: string;
    /** Buy price per item. */
    buy: number;
    /** Weighted average sell price across all partial sales. */
    avgSold: number;
    /** Number of price revisions before the cycle completed. */
    revisions: number;
}

export interface MerchHistoryData {
    profits: MerchHistoryEntry[];
    losses: MerchHistoryEntry[];
}

// --- Load / Save ------------------------------------------------------------

const EMPTY: MerchHistoryData = { profits: [], losses: [] };

const loadAll = (bot: StarkMercher): Record<string, MerchHistoryData> => {
    const raw = bot.merchHistorySetting.value;
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed as Record<string, MerchHistoryData>;
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse merch history: %s', String(e));
    }
    return {};
};

const saveAll = (bot: StarkMercher, all: Record<string, MerchHistoryData>): void => {
    try {
        bot.merchHistorySetting.value = JSON.stringify(all);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save merch history: %s', String(e));
    }
};

// --- Public API -------------------------------------------------------------

/** Returns the merch history for the given account (or empty if none). */
export const getMerchHistory = (bot: StarkMercher, accountName: string): MerchHistoryData => {
    if (!accountName) return EMPTY;
    const all = loadAll(bot);
    return all[accountName] ?? EMPTY;
};

/**
 * Records a completed merch cycle. If profit > 0, adds to profits; if < 0,
 * adds to losses. If profit === 0, does nothing.
 *
 * @param bot       The plugin instance.
 * @param account   The account name.
 * @param entry     The summary entry (without the profit/loss classification).
 * @param totalProfit  The net profit (positive) or loss (negative) in gp.
 */
export const recordMerchCycle = (
    bot: StarkMercher,
    accountName: string,
    entry: Omit<MerchHistoryEntry, 'profit'>,
    totalProfit: number,
): void => {
    if (!accountName || totalProfit === 0) return;

    const fullEntry: MerchHistoryEntry = { ...entry, profit: totalProfit };
    const all = loadAll(bot);
    const acct = all[accountName] ?? { profits: [], losses: [] };

    if (totalProfit > 0) {
        acct.profits.push(fullEntry);
    } else {
        acct.losses.push(fullEntry);
    }

    all[accountName] = acct;
    saveAll(bot, all);
};
