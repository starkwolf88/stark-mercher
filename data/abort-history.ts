// ============================================================================
// Abort history — persisted record of aborted offers
// ============================================================================
// When a buy or sell offer is aborted (stale, no longer merchable, frozen
// swap-out), a summary entry is recorded here. This is separate from merch
// history because aborted offers — especially 0-fill buys — leave no trace
// in merch history but represent wasted time and slot occupancy that
// directly explains low overnight profit.
//
// Each entry captures:
//   - item name
//   - offer type ('buy' or 'sell')
//   - requested quantity (what the bot tried to buy/sell)
//   - bought/sold quantity (what actually filled before the abort)
//   - abort reason (the stale reason string, or 'frozen swap-out')
//   - elapsed minutes the offer was active before abort
//   - original cached ETA in minutes (for comparing actual vs expected)
//   - buy price per item (for buy offers) or sell price (for sell offers)
//   - ISO timestamp of the abort
//
// The data is persisted in a visible plugin setting (JSON-encoded) keyed by
// account name, surviving hot reloads. The setting is visible for manual
// backup across client restarts (copy the JSON out before closing the
// client, paste it back in after restarting).
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';

// --- Types ------------------------------------------------------------------

export interface AbortHistoryEntry {
    /** Item name. */
    item: string;
    /** Offer type: 'buy' or 'sell'. */
    type: 'buy' | 'sell';
    /** Quantity the bot requested in the offer. */
    requestedQty: number;
    /** Quantity that actually filled before the abort (0 for no-fill aborts). */
    filledQty: number;
    /** Abort reason string (stale reason, 'frozen swap-out', etc.). */
    reason: string;
    /** Minutes the offer was active before the abort was triggered. */
    elapsedMin: number;
    /** Original cached ETA in minutes (for comparing actual vs expected). */
    etaMin: number;
    /** Buy price per item (for buy offers) or sell price (for sell offers). */
    price: number;
    /** ISO timestamp of the abort. */
    date: string;
}

export interface AbortHistoryData {
    aborts: AbortHistoryEntry[];
}

// --- Load / Save ------------------------------------------------------------

const EMPTY: AbortHistoryData = { aborts: [] };

/** Maximum number of abort entries to keep per account. Older entries are
 *  trimmed when the cap is exceeded. */
const MAX_ABORT_HISTORY = 200;

const loadAll = (bot: StarkMercher): Record<string, AbortHistoryData> => {
    const raw = bot.abortHistorySetting.value;
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed as Record<string, AbortHistoryData>;
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse abort history: %s', String(e));
    }
    return {};
};

const saveAll = (bot: StarkMercher, all: Record<string, AbortHistoryData>): void => {
    try {
        bot.abortHistorySetting.value = JSON.stringify(all);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save abort history: %s', String(e));
    }
};

// --- Public API -------------------------------------------------------------

/** Returns the abort history for the given account (or empty if none). */
export const getAbortHistory = (bot: StarkMercher, accountName: string): AbortHistoryData => {
    if (!accountName) return EMPTY;
    const all = loadAll(bot);
    return all[accountName] ?? EMPTY;
};

/**
 * Records an aborted offer. Adds the entry to the account's abort history,
 * trimming the oldest entries if over the cap.
 *
 * @param bot          The plugin instance.
 * @param accountName  The account name.
 * @param entry        The abort entry to record.
 */
export const recordAbort = (
    bot: StarkMercher,
    accountName: string,
    entry: AbortHistoryEntry,
): void => {
    if (!accountName) return;

    const all = loadAll(bot);
    const acct = all[accountName] ?? { aborts: [] };

    acct.aborts.push(entry);
    if (acct.aborts.length > MAX_ABORT_HISTORY) {
        acct.aborts = acct.aborts.slice(-MAX_ABORT_HISTORY);
    }

    all[accountName] = acct;
    saveAll(bot, all);
};
