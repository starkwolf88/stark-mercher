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
// Diagnostic fields (added for overnight profit analysis):
//   - requestedBuyQty: what the bot tried to buy (vs qty = what actually sold)
//   - actualBoughtQty: what was actually bought (may differ from sold if some
//     are still in inventory or were lost to a sell abort)
//   - buyAbortReason: null if the buy completed naturally, or the stale
//     reason string if the buy was aborted (partial fill)
//   - buyElapsedMin: minutes the buy offer was active
//   - buyEtaMin: original cached ETA for the buy (for comparing actual vs
//     expected)
//   - revisionPrices: array of actual sell prices at each revision (not just
//     the count) — shows whether prices eroded gradually or were dumped
//   - sellElapsedMin: minutes the sell offer(s) was active total
//
// The data is persisted in a hidden plugin setting (JSON-encoded) keyed by
// account name, surviving hot reloads. Includes duplicate account-key
// migration on load: keys differing by invisible whitespace characters
// (e.g. non-breaking space U+00A0 vs regular space) are merged under a
// canonical key (roster match preferred, else first-seen raw key).
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { getRoster } from '../antiban/account-rotation.js';

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
    /** What the bot tried to buy (vs qty = what actually sold). */
    requestedBuyQty?: number;
    /** What was actually bought (may differ from sold if some remain in inv). */
    actualBoughtQty?: number;
    /** null if buy completed naturally, or the stale reason if aborted. */
    buyAbortReason?: string | null;
    /** Minutes the buy offer was active. */
    buyElapsedMin?: number;
    /** Original cached ETA for the buy (minutes). */
    buyEtaMin?: number;
    /** Array of actual sell prices at each revision (first = original). */
    revisionPrices?: number[];
    /** Minutes the sell offer(s) was active total. */
    sellElapsedMin?: number;
}

export interface MerchHistoryData {
    profits: MerchHistoryEntry[];
    losses: MerchHistoryEntry[];
}

// --- Load / Save ------------------------------------------------------------

const EMPTY: MerchHistoryData = { profits: [], losses: [] };

/** Maximum number of entries to keep per category (profits/losses) per
 *  account. Older entries are trimmed when the cap is exceeded. */
const MAX_HISTORY_PER_CATEGORY = 200;

/** Normalize an account name for duplicate-key detection.
 *  Replaces ALL whitespace characters (including invisible ones like
 *  non-breaking spaces U+00A0, zero-width spaces, ideographic spaces, etc.)
 *  with a regular space, collapses multiple spaces to one, trims, and
 *  lowercases. This catches "hc\u00A0fruitz" vs "hc fruitz" which look
 *  identical visually but are different JSON keys. */
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
 * raw keys, the profits and losses arrays are concatenated (preserving all
 * historical entries) and stored under a single canonical key. The canonical
 * key is chosen as:
 *   1. The roster entry whose normalized form matches (preserves the user's
 *      intended casing), or
 *   2. The first-seen raw key (preserves original casing if no roster match).
 *
 * The merged result is written back to the setting only if a merge actually
 * occurred, so subsequent loads are idempotent and don't re-write.
 *
 * This runs inside loadAll() so every read path (display, accounting, dump)
 * sees the merged history. The migration is one-shot per stale snapshot.
 */
const migrateDuplicateKeys = (
    bot: StarkMercher,
    all: Record<string, MerchHistoryData>,
): Record<string, MerchHistoryData> => {
    const rawKeys = Object.keys(all);
    if (rawKeys.length < 2) return all;

    // Group raw keys by normalized name.
    const groups = new Map<string, string[]>();
    for (const key of rawKeys) {
        const norm = normalizeAccountKey(key);
        if (!norm) continue; // skip empty/whitespace-only keys
        const arr = groups.get(norm);
        if (arr) arr.push(key);
        else groups.set(norm, [key]);
    }

    // Only proceed if at least one normalized name has 2+ raw keys.
    let needsMerge = false;
    for (const arr of groups.values()) {
        if (arr.length > 1) { needsMerge = true; break; }
    }
    if (!needsMerge) return all;

    // Build roster lookup (normalized -> original roster casing).
    const roster = getRoster(bot);
    const rosterByNorm = new Map<string, string>();
    for (const name of roster) {
        const norm = normalizeAccountKey(name);
        if (norm && !rosterByNorm.has(norm)) rosterByNorm.set(norm, name);
    }

    const merged: Record<string, MerchHistoryData> = {};
    for (const [norm, keys] of groups) {
        if (keys.length === 1) {
            // No duplicates for this normalized name — keep as-is.
            merged[keys[0]] = all[keys[0]];
            continue;
        }
        // Pick canonical key: roster match preferred, else first-seen raw key.
        const canonical = rosterByNorm.get(norm) ?? keys[0];

        // Concatenate profits and losses across all duplicate keys, preserving
        // all historical entries. Order: by raw-key insertion order, then by
        // entry order within each key. This keeps chronological order roughly
        // intact (older snapshots tend to have earlier keys).
        const profits: MerchHistoryEntry[] = [];
        const losses: MerchHistoryEntry[] = [];
        for (const key of keys) {
            const data = all[key];
            if (!data) continue;
            if (Array.isArray(data.profits)) profits.push(...data.profits);
            if (Array.isArray(data.losses)) losses.push(...data.losses);
        }
        // Trim to cap per category (oldest entries dropped).
        const trimmedProfits = profits.length > MAX_HISTORY_PER_CATEGORY
            ? profits.slice(-MAX_HISTORY_PER_CATEGORY)
            : profits;
        const trimmedLosses = losses.length > MAX_HISTORY_PER_CATEGORY
            ? losses.slice(-MAX_HISTORY_PER_CATEGORY)
            : losses;
        merged[canonical] = { profits: trimmedProfits, losses: trimmedLosses };

        titan.logf(
            '[Stark Mercher] Merch history: merged %d duplicate account keys into "%s" (%d profits, %d losses).',
            keys.length, canonical, trimmedProfits.length, trimmedLosses.length,
        );
    }

    // Persist the migrated snapshot.
    saveAll(bot, merged);
    return merged;
};

const loadAll = (bot: StarkMercher): Record<string, MerchHistoryData> => {
    const raw = bot.merchHistorySetting.value;
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            const all = parsed as Record<string, MerchHistoryData>;
            return migrateDuplicateKeys(bot, all);
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
    if (all[accountName]) return all[accountName];
    // Fallback: normalized lookup in case the caller's casing/whitespace
    // differs from the canonical key (e.g. game name vs roster name before
    // initSessionProfile canonicalizes). This is a defensive measure —
    // initSessionProfile normally canonicalizes currentPlayerName to the
    // roster version, which matches the migration's canonical key.
    const norm = normalizeAccountKey(accountName);
    for (const [key, data] of Object.entries(all)) {
        if (normalizeAccountKey(key) === norm) return data;
    }
    return EMPTY;
};

/**
 * Returns the net profit (profits + losses, losses are negative) for a
 * single account, computed from the full merch history. Pure JSON parse +
 * arithmetic — no native SDK calls, safe to run at any time.
 */
export const getAccountNetProfit = (bot: StarkMercher, accountName: string): number => {
    if (!accountName) return 0;
    const history = getMerchHistory(bot, accountName);
    let net = 0;
    for (const e of history.profits) net += e.profit;
    for (const e of history.losses) net += e.profit; // losses are negative
    return net;
};

/**
 * Returns a map of accountName -> net profit for every account that has
 * merch history. Pure JSON parse + arithmetic — no native SDK calls.
 */
export const getAllAccountNetProfits = (bot: StarkMercher): Record<string, number> => {
    const all = loadAll(bot);
    const result: Record<string, number> = {};
    for (const accountName of Object.keys(all)) {
        const history = all[accountName];
        if (!history) continue;
        let net = 0;
        for (const e of history.profits) net += e.profit;
        for (const e of history.losses) net += e.profit;
        result[accountName] = net;
    }
    return result;
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
    // Use the existing key if one matches under normalization, to avoid
    // re-creating duplicate keys with different invisible whitespace.
    let key = accountName;
    const norm = normalizeAccountKey(accountName);
    for (const existingKey of Object.keys(all)) {
        if (normalizeAccountKey(existingKey) === norm) { key = existingKey; break; }
    }
    const acct = all[key] ?? { profits: [], losses: [] };

    if (totalProfit > 0) {
        acct.profits.push(fullEntry);
        // Trim oldest entries if over the cap.
        if (acct.profits.length > MAX_HISTORY_PER_CATEGORY) {
            acct.profits = acct.profits.slice(-MAX_HISTORY_PER_CATEGORY);
        }
    } else {
        acct.losses.push(fullEntry);
        if (acct.losses.length > MAX_HISTORY_PER_CATEGORY) {
            acct.losses = acct.losses.slice(-MAX_HISTORY_PER_CATEGORY);
        }
    }

    all[key] = acct;
    saveAll(bot, all);
};
