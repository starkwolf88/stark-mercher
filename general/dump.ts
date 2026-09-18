// ============================================================================
// Shared dump helpers — cache, merch history, abort history, buy freezes
// ============================================================================
// Used by both the auto-dump-on-logout path (antiban/session.ts) and the
// manual "Log Cache Data" / "Log Merch & Abort History" / "Log Buy Freezes"
// buttons (stark-mercher.ts). Extracted to eliminate duplicated dump logic
// and ensure both paths produce identical output.
//
// Titan Shell truncates output at ~200-300 visible characters, so each
// entry is logged on its own line. However, each titan.logf() call crosses
// the JS<->native boundary and creates a native handle — the dumps run on
// EVERY logout (rotation/hop/break), and merch/abort history grows over a
// session, so per-entry logf calls scaled with account count and session
// length (hundreds of handles per dump late in a session) — a measurable
// contributor to the gradual FPS drop in multi-account rotation.
// Lines are now accumulated and flushed in chunks (see flushDumpLines),
// cutting native calls by ~20x while keeping one entry per line.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { loadOfferCache } from './state-persist.js';
import { getMerchHistory, getAllAccountNetProfits } from '../data/merch-history.js';
import { getAbortHistory } from '../data/abort-history.js';
import { getGeTax } from '../grand_exchange/constants.js';
import { getRoster } from '../antiban/account-rotation.js';

// --- Chunked log emission ----------------------------------------------------
// Each titan.logf() crosses the JS<->native boundary and creates a native
// handle. Emitting hundreds of lines per logout dump (one per cache/history
// entry) created hundreds of handles per rotation cycle. We accumulate lines
// and flush them joined by '\n' in chunks of ~1200 chars — one entry per
// line is preserved for readability, but the native call count drops by
// roughly the entries-per-chunk factor (~10-20x).
const DUMP_CHUNK_CHARS = 1200;
const flushDumpLines = (lines: string[]): void => {
    let chunk = '';
    for (const line of lines) {
        if (chunk.length + line.length + 1 > DUMP_CHUNK_CHARS && chunk.length > 0) {
            titan.logf('%s', chunk);
            chunk = '';
        }
        chunk = chunk.length > 0 ? chunk + '\n' + line : line;
    }
    if (chunk.length > 0) titan.logf('%s', chunk);
};

// --- Offer cache dump -------------------------------------------------------

/**
 * Dumps the offer cache for the given account to the log.
 * Each entry is logged on its own line with:
 *   - mode, buy/sell prices (current + original), elapsed since placement
 *   - revision history
 *   - net sell price after GE tax + projected profit per item and total
 *     (for sell entries) — immediately flags active sells that would be a
 *     loss after tax
 *   - cached buy/sell ETAs (for comparing actual elapsed vs predicted)
 *   - sellConfirmed status (for diagnosing false-stale-after-restart)
 *   - partial sales summary (batches + qty sold before current re-list)
 *   - buy-limit tracking (totalBought, firstBoughtAt, limitReachedAt)
 *   - sell quantity (active sell offer size)
 *   - stale-check progress tracking (lastBuyProgress/At, lastSellProgress/At)
 *   - floor-hit count (consecutive revisions at the price floor)
 *   - reconstructed flag (entry created by reverse reconciliation)
 */
export const dumpOfferCache = (bot: StarkMercher, accountName: string): void => {
    const cache = loadOfferCache(bot, accountName);
    const keys = Object.keys(cache);
    if (keys.length === 0) {
        titan.logf('[Stark Mercher] Offer cache for %s is empty.', accountName);
        return;
    }
    const lines: string[] = [`[Stark Mercher] Offer cache for ${accountName} (${keys.length} entries):`];
    const now = Date.now();
    for (const key of keys) {
        const e = cache[key];
        const elapsedMin = ((now - e.offerPlacedAt) / 60000).toFixed(1);
        const revisions = e.revisedPrices.join(' -> ');

        // Net profit projection for sell entries (after 2% GE tax).
        // Immediately flags active sells that would be a loss after tax.
        let netProj = '';
        if (e.mode === 'sell' && e.sellPrice > 0) {
            const tax = getGeTax(e.sellPrice);
            const net = e.sellPrice - tax;
            const profitPerItem = net - e.buyPrice;
            const qty = e.sellQuantity ?? 0;
            const totalProj = profitPerItem * qty;
            const sign = profitPerItem >= 0 ? '+' : '';
            netProj = `, net=${net}gp (tax=${tax}gp), projProfit=${sign}${profitPerItem}gp/item (${sign}${totalProj}gp total)`;
        }

        // Cached ETAs for comparing actual elapsed vs predicted.
        const buyEta = e.purchaseEtaMinutes !== undefined ? `, buyEta=${e.purchaseEtaMinutes.toFixed(1)}min` : '';
        const sellEta = e.saleEtaMinutes !== undefined ? `, sellEta=${e.saleEtaMinutes.toFixed(1)}min` : '';

        // sellConfirmed status — for diagnosing false-stale-after-restart.
        // undefined (legacy entries) is treated as confirmed.
        const confirmed = e.sellConfirmed === false ? ', confirmed=no' : '';

        // Partial sales summary — how much actually sold before the current
        // re-list, without dumping every entry (keeps it concise).
        let partials = '';
        if (e.partialSales && e.partialSales.length > 0) {
            const partialQty = e.partialSales.reduce((s, p) => s + p.qty, 0);
            partials = `, partials=${e.partialSales.length} batch${e.partialSales.length === 1 ? '' : 'es'}, ${partialQty} sold`;
        }

        const totalBought = e.totalBought !== undefined ? `, totalBought=${e.totalBought}` : '';
        const firstBought = e.firstBoughtAt !== undefined ? `, firstBought=${new Date(e.firstBoughtAt).toISOString()}` : '';
        const limitReached = e.limitReachedAt !== undefined ? `, limitReached=${new Date(e.limitReachedAt).toISOString()}` : '';
        const sellQty = e.sellQuantity !== undefined ? `, sellQty=${e.sellQuantity}` : '';

        // Stale-check progress tracking — shows the last observed fill
        // progress and when it last changed. Useful for diagnosing offers
        // that appear stuck (no progress for a long time) vs offers that
        // are slowly filling. These fields are mutated by the stale-check
        // loop every tick when progress changes.
        const buyProgress = e.lastBuyProgress !== undefined ? `, buyProgress=${(e.lastBuyProgress * 100).toFixed(1)}%` : '';
        const buyProgressAt = e.lastBuyProgressAt !== undefined ? ` @ ${new Date(e.lastBuyProgressAt).toISOString()}` : '';
        const sellProgress = e.lastSellProgress !== undefined ? `, sellProgress=${(e.lastSellProgress * 100).toFixed(1)}%` : '';
        const sellProgressAt = e.lastSellProgressAt !== undefined ? ` @ ${new Date(e.lastSellProgressAt).toISOString()}` : '';

        // Floor-hit count — how many consecutive revisions couldn't reduce
        // the price because it was already at the floor. After 2 (thick
        // margin) or 4 (thin margin) consecutive floor-hits, the item
        // abandons early. Useful for diagnosing items stuck cycling at the
        // floor price.
        const floorHits = e.floorHitCount !== undefined && e.floorHitCount > 0 ? `, floorHits=${e.floorHitCount}` : '';

        // Reconstructed flag — true if this entry was created by reverse
        // reconciliation (cache loss after client restart) rather than a
        // normal offer placement. Reconstructed sells are subject to the
        // reconstructed profit guard (immediate abort if zero/negative
        // profit, or low profit/hr after 5-min grace). The flag is cleared
        // by recordSellOffer/confirmSellOffer/fixModeMismatch.
        const reconstructed = e.reconstructed ? ', reconstructed' : '';

        lines.push(`[Stark Mercher]   ${key}: mode=${e.mode}, buy=${e.buyPrice}, sell=${e.sellPrice} (orig=${e.originalSellPrice}), elapsed=${elapsedMin}min, revisions=[${revisions}]${netProj}${buyEta}${sellEta}${confirmed}${partials}${totalBought}${firstBought}${limitReached}${sellQty}${buyProgress}${buyProgressAt}${sellProgress}${sellProgressAt}${floorHits}${reconstructed}`);
    }
    lines.push(`[Stark Mercher] Cache dump complete (${keys.length} entries).`);
    flushDumpLines(lines);
};

// --- Merch history dump -----------------------------------------------------

/**
 * Dumps merch history (profits and losses) for the given account.
 * Each entry shows: item, qty, profit/loss, buy price, avg sold price,
 * revision count, requested vs actual bought qty, revision prices,
 * and sell elapsed time.
 */
export const dumpMerchHistory = (bot: StarkMercher, accountName: string): void => {
    const history = getMerchHistory(bot, accountName);
    if (history.profits.length === 0 && history.losses.length === 0) {
        titan.logf('[Stark Mercher] No merch history for %s.', accountName);
        return;
    }
    const lines: string[] = [`[Stark Mercher] Merch history for ${accountName}:`];
    if (history.profits.length > 0) {
        lines.push(`[Stark Mercher] === PROFITS (${history.profits.length}) ===`);
        let totalProfit = 0;
        for (const e of history.profits) {
            const revPrices = e.revisionPrices ? `, revPrices=[${e.revisionPrices.join(',')}]` : '';
            const sellTime = e.sellElapsedMin !== undefined ? `, sellElapsed=${e.sellElapsedMin}min` : '';
            const reqVsActual = e.requestedBuyQty !== undefined ? `, reqBuy=${e.requestedBuyQty}` : '';
            lines.push(`[Stark Mercher]   ${e.item}: qty=${e.qty}, profit=+${e.profit}gp, buy=${e.buy}, avgSold=${e.avgSold}, revisions=${e.revisions}${reqVsActual}${revPrices}${sellTime}, date=${e.date}`);
            totalProfit += e.profit;
        }
        lines.push(`[Stark Mercher]   Total profit: +${totalProfit}gp`);
    }
    if (history.losses.length > 0) {
        lines.push(`[Stark Mercher] === LOSSES (${history.losses.length}) ===`);
        let totalLoss = 0;
        for (const e of history.losses) {
            const revPrices = e.revisionPrices ? `, revPrices=[${e.revisionPrices.join(',')}]` : '';
            const sellTime = e.sellElapsedMin !== undefined ? `, sellElapsed=${e.sellElapsedMin}min` : '';
            const reqVsActual = e.requestedBuyQty !== undefined ? `, reqBuy=${e.requestedBuyQty}` : '';
            lines.push(`[Stark Mercher]   ${e.item}: qty=${e.qty}, loss=${e.profit}gp, buy=${e.buy}, avgSold=${e.avgSold}, revisions=${e.revisions}${reqVsActual}${revPrices}${sellTime}, date=${e.date}`);
            totalLoss += e.profit;
        }
        lines.push(`[Stark Mercher]   Total loss: ${totalLoss}gp`);
    }
    lines.push('[Stark Mercher] Merch history dump complete.');
    flushDumpLines(lines);
};

// --- Abort history dump -----------------------------------------------------

/**
 * Dumps abort history for the given account.
 * Each entry shows: category, item, type (buy/sell), requested vs filled qty,
 * elapsed vs ETA, price, reason, and date.
 */
export const dumpAbortHistory = (bot: StarkMercher, accountName: string): void => {
    const aborts = getAbortHistory(bot, accountName);
    if (aborts.aborts.length === 0) {
        titan.logf('[Stark Mercher] No abort history for %s.', accountName);
        return;
    }
    const lines: string[] = [`[Stark Mercher] Abort history for ${accountName} (${aborts.aborts.length} entries):`];
    for (const a of aborts.aborts) {
        const cat = a.category ?? 'unknown';
        lines.push(`[Stark Mercher]   [${cat}] ${a.item}: ${a.type} req=${a.requestedQty} filled=${a.filledQty}, elapsed=${a.elapsedMin.toFixed(1)}min eta=${a.etaMin.toFixed(1)}min, price=${a.price}, reason="${a.reason}", date=${a.date}`);
    }
    lines.push('[Stark Mercher] Abort history dump complete.');
    flushDumpLines(lines);
};

// --- Buy freeze dump --------------------------------------------------------

/**
 * Dumps buy-freeze state to the log. Shows active and expired freeze counts,
 * and for each active freeze: item name, source label, minutes remaining,
 * and expiry time. Supports both flat ({ item: until }) and legacy nested
 * ({ account: { item: until } }) formats. Source labels (buy-abort,
 * sell-abort, loss-cooldown, abort-seed) are read from the in-memory
 * `buyFreezeSources` map — not available after a reload (shown as 'restored').
 */
export const dumpBuyFreezes = (bot: StarkMercher): void => {
    const freezeRaw = bot.buyFreezeSetting.value;
    if (!freezeRaw || freezeRaw === '{}') {
        titan.logf('[Stark Mercher] No buy freezes active.');
        return;
    }
    try {
        const parsed = JSON.parse(freezeRaw);
        if (!parsed || typeof parsed !== 'object') {
            titan.logf('[Stark Mercher] No buy freezes active.');
            return;
        }
        const now = Date.now();
        // Support both flat ({ item: until }) and legacy nested
        // ({ account: { item: until } }) formats for diagnostics.
        const values = Object.values(parsed);
        const isNested = values.length > 0 && values.every(v => v !== null && typeof v === 'object');
        let flat: Record<string, number>;
        if (isNested) {
            flat = {};
            for (const accountMap of values as Record<string, number>[]) {
                if (!accountMap || typeof accountMap !== 'object') continue;
                for (const [name, until] of Object.entries(accountMap)) {
                    if (typeof until !== 'number') continue;
                    const existing = flat[name];
                    if (!existing || until > existing) flat[name] = until;
                }
            }
        } else {
            flat = parsed as Record<string, number>;
        }
        const items = Object.keys(flat);
        if (items.length === 0) {
            titan.logf('[Stark Mercher] No buy freezes active.');
            return;
        }
        // Source labels from in-memory map (diagnostic only, not persisted).
        const sources = bot.autoLoop?.buyFreezeSources;
        const active = items.filter(name => flat[name] > now);
        const expired = items.length - active.length;
        const lines: string[] = [`[Stark Mercher] Buy freezes (${active.length} active, ${expired} expired):`];
        for (const name of active) {
            const until = flat[name];
            const minsLeft = Math.max(0, Math.ceil((until - now) / 60000));
            const source = sources?.get(name) ?? 'restored';
            lines.push(`[Stark Mercher]   ${name} [${source}]: expires in ${minsLeft} min (at ${new Date(until).toISOString()})`);
        }
        lines.push('[Stark Mercher] Buy freeze dump complete.');
        flushDumpLines(lines);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to parse buy-freeze data: %s', String(e));
    }
};

// --- Per-account profit dump (logout summary) ------------------------------

/**
 * Logs each character's current net profit, one line per character.
 * Called after the freeze dump during the automatic logout state dump.
 * Roster accounts appear first (in roster order), then any accounts with
 * merch history that aren't in the roster. Accounts are deduplicated by
 * normalized name (trimmed + lowercased) so casing/whitespace differences
 * don't cause the same account to appear twice.
 *
 * Pure JSON parse + arithmetic — no native SDK calls, no widget queries.
 */
export const dumpAccountProfits = (bot: StarkMercher): void => {
    try {
        const profits = getAllAccountNetProfits(bot);
        const roster = getRoster(bot);
        const seen = new Set<string>(); // normalized names already emitted
        const lines: string[] = [];
        // Roster accounts first, in roster order.
        for (const name of roster) {
            const norm = normalizeAccountName(name);
            if (seen.has(norm)) continue;
            seen.add(norm);
            let net = 0;
            for (const [key, val] of Object.entries(profits)) {
                if (normalizeAccountName(key) === norm) net += val;
            }
            lines.push(`[Stark Mercher]   ${name}: ${formatGp(net)}`);
        }
        // Any accounts with history not in the roster.
        for (const name of Object.keys(profits)) {
            const norm = normalizeAccountName(name);
            if (seen.has(norm)) continue;
            seen.add(norm);
            let net = 0;
            for (const [key, val] of Object.entries(profits)) {
                if (normalizeAccountName(key) === norm) net += val;
            }
            lines.push(`[Stark Mercher]   ${name}: ${formatGp(net)}`);
        }
        if (lines.length === 0) {
            titan.logf('[Stark Mercher] No account profit data available.');
            return;
        }
        titan.logf('[Stark Mercher] Account profits (%d accounts):', lines.length);
        flushDumpLines(lines);
        titan.logf('[Stark Mercher] Account profit dump complete.');
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to dump account profits: %s', String(e));
    }
};

// --- Combined dump (cache + merch history + abort history + freezes) --------

/**
 * Dumps all diagnostic state to the log: offer cache, merch history,
 * abort history, and buy freezes. Called automatically after each logout
 * and available via the manual log buttons.
 */
export const dumpAllState = (bot: StarkMercher, accountName: string): void => {
    dumpOfferCache(bot, accountName);
    dumpMerchHistory(bot, accountName);
    dumpAbortHistory(bot, accountName);
    dumpBuyFreezes(bot);
    dumpAccountProfits(bot);
};

// --- Profit display updater -------------------------------------------------

/**
 * Formats a gp amount with thousands separators (commas). Avoids Intl
 * (not available in the Titan plugin runtime).
 */
const formatGp = (amount: number): string => {
    const sign = amount >= 0 ? '+' : '-';
    const abs = Math.abs(amount);
    // Manual thousands separator — insert commas from the right.
    const str = String(abs);
    let formatted = '';
    for (let i = 0; i < str.length; i++) {
        if (i > 0 && (str.length - i) % 3 === 0) formatted += ',';
        formatted += str[i];
    }
    return sign + formatted + 'gp';
};

/**
 * Normalizes an account name for deduplication: trimmed and lowercased.
 * The OSRS client may return a display name with different casing or
 * trailing whitespace than the roster entry (e.g. "HC fruitz" vs "hc fruitz"),
 * causing merch history to be recorded under two separate keys that both
 * display as the same account. Normalization collapses these into one entry.
 */
const normalizeAccountName = (name: string): string => {
    if (!name) return '';
    return name
        .replace(/[\s\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]+/g, ' ')
        .trim()
        .toLowerCase();
};

/**
 * Updates the visible "Profit (all accounts)" setting with each account's
 * net profit. Called after each completed sale (from the auto-loop's
 * completed-sell sweep) and on logout from dumpStateOnLogout — never per-tick.
 *
 * Account order: roster accounts first (in roster order), then any accounts
 * with merch history that aren't in the roster (e.g. removed from rotation).
 * Accounts with zero net profit are included so the user sees the full picture.
 *
 * Deduplication: accounts are matched by normalized name (trimmed + lowercased)
 * so that "hc fruitz" and "HC fruitz" — which may arise when the game's
 * localPlayer.name differs in casing/whitespace from the roster entry — are
 * summed into a single display line instead of appearing twice.
 *
 * Pure JSON parse + string formatting — no native SDK calls, no widget
 * queries, no performance impact.
 */
export const updateProfitDisplay = (bot: StarkMercher): void => {
    try {
        const profits = getAllAccountNetProfits(bot);
        const roster = getRoster(bot);
        // Map normalized name -> summed net profit. If the same account was
        // recorded under two keys (e.g. "hc fruitz" and "HC fruitz"), their
        // profits are combined.
        const seen = new Set<string>(); // normalized names already emitted
        const parts: string[] = [];
        // Roster accounts first, in roster order.
        for (const name of roster) {
            const norm = normalizeAccountName(name);
            if (seen.has(norm)) continue;
            seen.add(norm);
            // Sum all profit keys that normalize to this roster name.
            let net = 0;
            for (const [key, val] of Object.entries(profits)) {
                if (normalizeAccountName(key) === norm) net += val;
            }
            parts.push(`${name}: ${formatGp(net)}`);
        }
        // Any accounts with history not in the roster.
        for (const name of Object.keys(profits)) {
            const norm = normalizeAccountName(name);
            if (seen.has(norm)) continue;
            seen.add(norm);
            // Sum all profit keys that normalize to this name.
            let net = 0;
            for (const [key, val] of Object.entries(profits)) {
                if (normalizeAccountName(key) === norm) net += val;
            }
            parts.push(`${name}: ${formatGp(net)}`);
        }
        const display = parts.join(', ');
        if (bot.profitDisplaySetting.value !== display) {
            bot.profitDisplaySetting.value = display;
        }
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to update profit display: %s', String(e));
    }
};
