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
// The data is persisted in a hidden plugin setting (JSON-encoded) keyed by
// account name, surviving hot reloads. Includes duplicate account-key
// migration on load: keys differing by invisible whitespace characters
// (e.g. non-breaking space U+00A0 vs regular space) are merged under a
// canonical key (roster match preferred, else first-seen raw key).
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { getRoster } from '../antiban/account-rotation.js';

// --- Types ------------------------------------------------------------------

export type AbortCategory = 'eta' | 'swap' | 'config';

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
    /** Abort category: 'eta' (ETA-based stale), 'swap' (frozen swap-out),
     *  'config' (item removed from merchableItems.json — no longer used but
     *  kept for legacy entries). */
    category: AbortCategory;
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

/** Normalize an account name for duplicate-key detection.
 *  Replaces ALL whitespace characters (including invisible ones like
 *  non-breaking spaces U+00A0) with a regular space, collapses multiples,
 *  trims, and lowercases. */
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
 * raw keys, the aborts arrays are concatenated (preserving all historical
 * entries) and stored under a single canonical key. The canonical key is
 * chosen as:
 *   1. The roster entry whose normalized form matches (preserves the user's
 *      intended casing), or
 *   2. The first-seen raw key (preserves original casing if no roster match).
 *
 * The merged result is written back to the setting only if a merge actually
 * occurred, so subsequent loads are idempotent. Mirrors the merch-history
 * migration so both histories stay consistent.
 */
const migrateDuplicateKeys = (
    bot: StarkMercher,
    all: Record<string, AbortHistoryData>,
): Record<string, AbortHistoryData> => {
    const rawKeys = Object.keys(all);
    if (rawKeys.length < 2) return all;

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
    if (!needsMerge) return all;

    const roster = getRoster(bot);
    const rosterByNorm = new Map<string, string>();
    for (const name of roster) {
        const norm = normalizeAccountKey(name);
        if (norm && !rosterByNorm.has(norm)) rosterByNorm.set(norm, name);
    }

    const merged: Record<string, AbortHistoryData> = {};
    for (const [norm, keys] of groups) {
        if (keys.length === 1) {
            merged[keys[0]] = all[keys[0]];
            continue;
        }
        const canonical = rosterByNorm.get(norm) ?? keys[0];
        const aborts: AbortHistoryEntry[] = [];
        for (const key of keys) {
            const data = all[key];
            if (data && Array.isArray(data.aborts)) aborts.push(...data.aborts);
        }
        const trimmed = aborts.length > MAX_ABORT_HISTORY
            ? aborts.slice(-MAX_ABORT_HISTORY)
            : aborts;
        merged[canonical] = { aborts: trimmed };

        titan.logf(
            '[Stark Mercher] Abort history: merged %d duplicate account keys into "%s" (%d aborts).',
            keys.length, canonical, trimmed.length,
        );
    }

    saveAll(bot, merged);
    return merged;
};

const loadAll = (bot: StarkMercher): Record<string, AbortHistoryData> => {
    const raw = bot.abortHistorySetting.value;
    if (!raw || raw === '{}') return {};
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            const all = parsed as Record<string, AbortHistoryData>;
            return migrateDuplicateKeys(bot, all);
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
    if (all[accountName]) return all[accountName];
    // Normalized fallback (see getMerchHistory for rationale).
    const norm = normalizeAccountKey(accountName);
    for (const [key, data] of Object.entries(all)) {
        if (normalizeAccountKey(key) === norm) return data;
    }
    return EMPTY;
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
    // Use the existing key if one matches under normalization, to avoid
    // re-creating duplicate keys with different invisible whitespace.
    let key = accountName;
    const norm = normalizeAccountKey(accountName);
    for (const existingKey of Object.keys(all)) {
        if (normalizeAccountKey(existingKey) === norm) { key = existingKey; break; }
    }
    const acct = all[key] ?? { aborts: [] };

    acct.aborts.push(entry);
    if (acct.aborts.length > MAX_ABORT_HISTORY) {
        acct.aborts = acct.aborts.slice(-MAX_ABORT_HISTORY);
    }

    all[key] = acct;
    saveAll(bot, all);
};
