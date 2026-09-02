// ============================================================================
// Bot overlay — HUD panel for the Stark Mercher plugin
// ============================================================================
// Draws a panel on screen showing:
//   - Status: top-level action with break/sleep/hop countdowns
//   - Inventory Coins: current coin count, formatted with thousands separators
//   - Daily Profit: total profit since 00:00 UK, with day-rollover handling
//   - TIMERS section:
//     - Session (Day): elapsed since session start (target in parentheses)
//     - Next Hop: countdown to next world hop
//     - Sleep Time: UK-formatted bedtime
//     - Wake Time: UK-formatted wake time (with countdown when sleeping)
//
// The overlay is registered via `this.overlay({ layer: 'AboveWidgets', render })`
// in stark-mercher.ts and renders every frame while `isHudActive` is true.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { formatUKTime } from '../antiban/session.js';
import { isRotationEnabled, getSoonestBreakEndMs } from '../antiban/account-rotation.js';
import { isMerchableDataValid } from '../data/merchable-items.js';

// --- Layout constants ------------------------------------------------------

const PANEL_X = 0;
const PANEL_Y = 0;
const LINE_HEIGHT = 16;
const HORIZONTAL_PADDING = 12;
const RIGHT_PADDING = 10;
const VERTICAL_PADDING = 8;
const KEY_COLUMN = 150;
const CHAR_WIDTH = 8;

const BG_COLOR = 0xCC000000;
const TITLE_COLOR = 0xFF39FF14;
const KEY_COLOR = 0xFFAEC6CF;   // pastel blue (like mixology)
const TEXT_COLOR = 0xFFFFFFFF;
const ORANGE_COLOR = 0xFFF4A460;
const GREEN_COLOR = 0xFF52DD6B;
const RED_COLOR = 0xFFF22E60;
const GREY_COLOR = 0xFF808080;
const PROFIT_POSITIVE_COLOR = 0xFF52DD6B;
const PROFIT_NEGATIVE_COLOR = 0xFFF22E60;
const PROFIT_ZERO_COLOR = 0xFFCCCCCC;

// --- Helpers ---------------------------------------------------------------

const formatGp = (amount: number): string => {
    // Manual thousands separator — Titan's runtime may not support
    // toLocaleString('en-US') locale grouping.
    const neg = amount < 0;
    const abs = Math.abs(Math.floor(amount));
    const s = abs.toString();
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (i > 0 && (s.length - i) % 3 === 0) out += ',';
        out += s[i];
    }
    return neg ? '-' + out : out;
};

const drawText = (x: number, y: number, text: string, color: number = TEXT_COLOR): void => {
    titan.overlay.screenText(x, y, text, color);
};

/** Format seconds as "1d 2h 3m 4s" with leading/trailing zero suppression. */
function fmtHms(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const units = [
        { value: Math.floor(s / 86400), label: 'd' },
        { value: Math.floor((s % 86400) / 3600), label: 'h' },
        { value: Math.floor((s % 3600) / 60), label: 'm' },
        { value: s % 60, label: 's' },
    ];
    let first = units.findIndex(u => u.value > 0);
    if (first < 0) return '0s';
    let last = units.length - 1;
    while (last > first && units[last].value === 0) last--;
    return units.slice(first, last + 1).map(u => `${u.value}${u.label}`).join(' ');
}

/** Format a wall-clock ms duration as a countdown string. */
function fmtCountdownMs(ms: number): string {
    return fmtHms(Math.max(0, Math.ceil(ms / 1000)));
}

// --- Status text -----------------------------------------------------------

/**
 * Returns the human-readable status string for the overlay.
 * Priority:
 *   1. Terminated → "Stopped"
 *   2. Hop in progress → "Hopping" / "Resuming"
 *   3. Break phase with countdown → "Logged Out (Xm Ys)"
 *   4. Break phase (logging_out / logging_in) → transition status
 *   5. Auto mode off → "Manual test mode"
 *   6. bot.statusText (set by the auto-loop or test flows)
 */
const getStatusText = (bot: StarkMercher): string => {
    if (bot.terminated) return 'Stopped';
    if (bot.hopInProgress) return 'Hopping';
    if (bot.hopResumeAtMs > 0 && Date.now() < bot.hopResumeAtMs) return 'Resuming';
    if (bot.breakPhase === 'logging_out') return 'Logging out...';
    if (bot.breakPhase === 'logged_out') {
        // Data validity safeguard — if merchable data is invalid (too few
        // items or stale), show that instead of the normal countdown so
        // the user sees the problem at a glance.
        const dataCheck = isMerchableDataValid();
        if (!dataCheck.valid) {
            return `Data Invalid`;
        }
        // When multi-account rotation is enabled, show the soonest break-end
        // across all accounts — this is the actual wait until the next
        // account becomes eligible, which may be sooner than the current
        // account's own break end.
        if (isRotationEnabled(bot)) {
            const soonestEnd = getSoonestBreakEndMs(bot);
            if (soonestEnd !== Infinity && soonestEnd > Date.now()) {
                const remainingMs = Math.max(0, soonestEnd - Date.now());
                return `Logged Out (${fmtCountdownMs(remainingMs)})`;
            }
            // At least one account is eligible now (soonestEnd <= now) or
            // has no break state (soonestEnd = 0). The rotation poll will
            // pick it up within 10 seconds.
            return 'Logged Out';
        }
        if (bot.breakTargetEndMs > 0) {
            const remainingMs = Math.max(0, bot.breakTargetEndMs - Date.now());
            return `Logged Out (${fmtCountdownMs(remainingMs)})`;
        }
        return 'Logged Out';
    }
    if (bot.breakPhase === 'logging_in') return 'Logging in...';
    // Not in a break phase but logged out (e.g. plugin started while logged
    // out, or unexpected disconnect). Show "Logged Out" with a countdown
    // if we're waiting to re-login.
    if (!titan.state.login.isLoggedIn) {
        if (bot.unexpectedLogoutAtMs > 0) {
            const elapsed = Math.max(0, Date.now() - bot.unexpectedLogoutAtMs);
            const remaining = Math.max(0, 5000 - elapsed);
            if (remaining > 0) return `Logged Out (in ${fmtCountdownMs(remaining)})`;
        }
        return 'Logged Out';
    }
    if (bot.autoMode.value === 0) return 'Manual test mode';
    return bot.statusText || 'Idle';
};

// --- Main render function --------------------------------------------------

interface OverlayLine {
    text: string;
    key?: string;
    value?: string;
    valueColor?: number;
    isSectionHeader?: boolean;
}

export const renderBotOverlay = (bot: StarkMercher): void => {
    const status = getStatusText(bot);
    // Read cached values instead of calling titan.utils.inventory.count(995)
    // and getDailyProfit() every frame. Per-frame native queries exhaust the
    // finite native handle table over hours, causing FPS to drop to 0.
    // The cache is refreshed by the auto-loop and by a fallback timer in
    // onGameTick (every 30 ticks when the auto-loop isn't running).
    const coins = bot.cachedCoinCount;
    const playerName = bot.currentPlayerName || titan.state.client.localPlayer?.name || '';
    const dailyProfit = (playerName && bot.cachedDailyProfitAccount === playerName)
        ? bot.cachedDailyProfit
        : 0;

    const isLoggedOut = bot.breakPhase === 'logged_out';

    // --- Status color ---
    let statusColor = TEXT_COLOR;
    if (status === 'Stopped') statusColor = RED_COLOR;
    else if (status === 'Hopping' || status === 'Resuming') statusColor = ORANGE_COLOR;
    else if (isLoggedOut || status.startsWith('Logged Out') || status === 'Logging out...' || status === 'Logging in...') statusColor = ORANGE_COLOR;
    else if (status === 'Idle' || status === 'Manual test mode') statusColor = GREY_COLOR;
    else statusColor = GREEN_COLOR;

    // --- Build lines ---
    const lines: OverlayLine[] = [];

    // Title
    lines.push({ text: '[STARK] Mercher' });

    // Status
    lines.push({ text: 'Status:', key: 'Status:', value: status, valueColor: statusColor });

    // Delay — live countdown of the current action's delay
    let delayStr = '-';
    let delayColor = GREY_COLOR;
    if (bot.currentAction && bot.currentAction !== 'idle' && bot.actionDelay > 0) {
        const tick = titan.state.client.tick;
        const elapsed = tick - bot.actionStartTime;
        const remaining = bot.actionDelay - elapsed;
        if (remaining > 0) {
            delayStr = `${remaining}t (${(remaining * 0.6).toFixed(1)}s)`;
            delayColor = TEXT_COLOR;
        }
    }
    lines.push({ text: 'Delay:', key: 'Delay:', value: delayStr, valueColor: delayColor });

    // Inventory Coins
    const coinStr = coins >= 0 ? `${formatGp(coins)} gp` : '-';
    lines.push({ text: 'Inventory Coins:', key: 'Inventory Coins:', value: coinStr, valueColor: coins >= 0 ? TEXT_COLOR : GREY_COLOR });

    // Daily Profit
    const profitStr = `${dailyProfit >= 0 ? '+' : ''}${formatGp(dailyProfit)} gp`;
    const profitColor = dailyProfit > 0 ? PROFIT_POSITIVE_COLOR
        : dailyProfit < 0 ? PROFIT_NEGATIVE_COLOR
        : PROFIT_ZERO_COLOR;
    lines.push({ text: 'Daily Profit:', key: 'Daily Profit:', value: profitStr, valueColor: profitColor });

    // --- TIMERS section ---
    lines.push({ text: 'TIMERS', isSectionHeader: true });

    // Session (Day) — continuous elapsed timer, keeps running while logged out
    if (bot.sessionPlayStartMs > 0) {
        const dayMs = Math.max(0, Date.now() - bot.sessionPlayStartMs);
        const dayStr = fmtHms(Math.floor(dayMs / 1000));
        if (bot.nightlyBreakTargetTime > 0) {
            const targetMs = Math.max(0, bot.nightlyBreakTargetTime - bot.sessionPlayStartMs);
            const targetStr = fmtHms(Math.floor(targetMs / 1000));
            lines.push({ text: `Session (Day): ${dayStr} (${targetStr})`, key: 'Session (Day):', value: `${dayStr} (${targetStr})` });
        } else {
            lines.push({ text: `Session (Day): ${dayStr}`, key: 'Session (Day):', value: dayStr });
        }
    } else {
        lines.push({ text: 'Session (Day):', key: 'Session (Day):', value: '-', valueColor: GREY_COLOR });
    }

    // Next Hop
    if (!bot.hopWorlds || !bot.hopWorlds.value) {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Disabled', valueColor: RED_COLOR });
    } else if (isLoggedOut) {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Logged Out', valueColor: ORANGE_COLOR });
    } else if (bot.hopInProgress) {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Hopping...', valueColor: ORANGE_COLOR });
    } else if (bot.hopResumeAtMs > 0 && Date.now() < bot.hopResumeAtMs) {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Resuming...', valueColor: ORANGE_COLOR });
    } else if (bot.breakPhase !== 'none') {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Logged Out', valueColor: ORANGE_COLOR });
    } else if (bot.nextHopAtMs > 0) {
        const remainingMs = Math.max(0, bot.nextHopAtMs - Date.now());
        if (remainingMs <= 0) {
            lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Waiting to Hop...', valueColor: ORANGE_COLOR });
        } else {
            lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: fmtCountdownMs(remainingMs) });
        }
    } else {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: '-', valueColor: GREY_COLOR });
    }

    // Sleep Time + Wake Time
    if (bot.nightlyBreakTargetTime > 0) {
        const sleepMs = bot.nightlyBreakTargetTime;
        const wakeMs = isLoggedOut && bot.breakType === 'nightly' && bot.breakTargetEndMs > 0
            ? bot.breakTargetEndMs
            : sleepMs + (bot.nightlySleepMinutes > 0 ? bot.nightlySleepMinutes * 60000 : 0);
        if (isLoggedOut && bot.breakType === 'nightly') {
            const remainingSec = Math.max(0, Math.ceil((wakeMs - Date.now()) / 1000));
            const wakeStr = remainingSec === 0 ? 'now' : formatUKTime(wakeMs);
            lines.push({ text: 'Sleep Time:', key: 'Sleep Time:', value: 'Logged Out', valueColor: ORANGE_COLOR });
            lines.push({ text: `Wake Time: ${wakeStr} (in ${fmtHms(remainingSec)})`, key: 'Wake Time:', value: `${wakeStr} (in ${fmtHms(remainingSec)})`, valueColor: ORANGE_COLOR });
        } else {
            lines.push({ text: `Sleep Time: ${formatUKTime(sleepMs)}`, key: 'Sleep Time:', value: formatUKTime(sleepMs) });
            lines.push({ text: `Wake Time: ${formatUKTime(wakeMs)}`, key: 'Wake Time:', value: formatUKTime(wakeMs) });
        }
    } else {
        lines.push({ text: 'Sleep Time:', key: 'Sleep Time:', value: '-', valueColor: GREY_COLOR });
        lines.push({ text: 'Wake Time:', key: 'Wake Time:', value: '-', valueColor: GREY_COLOR });
    }

    // --- Compute panel dimensions ---
    // Width is based on actual render positions: keys start at HORIZONTAL_PADDING,
    // values start at HORIZONTAL_PADDING + KEY_COLUMN. The panel must be wide
    // enough for the longest key (in case it overflows KEY_COLUMN) AND for the
    // value column + longest value.
    const valueX = PANEL_X + HORIZONTAL_PADDING + KEY_COLUMN;
    let panelWidth = 0;
    for (const l of lines) {
        if (l.isSectionHeader) {
            panelWidth = Math.max(panelWidth, HORIZONTAL_PADDING + l.text.length * CHAR_WIDTH + RIGHT_PADDING);
        } else if (l.value === undefined || l.value === '') {
            const keyLen = (l.key ?? l.text).length;
            panelWidth = Math.max(panelWidth, HORIZONTAL_PADDING + keyLen * CHAR_WIDTH + RIGHT_PADDING);
        } else {
            // Value is drawn at valueX; key is drawn at HORIZONTAL_PADDING.
            // Width must fit both the key (in case it's wider than KEY_COLUMN)
            // and the value column.
            const keyLen = (l.key ?? l.text.split(':')[0] + ':').length;
            const keyRight = HORIZONTAL_PADDING + keyLen * CHAR_WIDTH;
            const valueRight = valueX + l.value.length * CHAR_WIDTH;
            panelWidth = Math.max(panelWidth, Math.max(keyRight, valueRight) + RIGHT_PADDING);
        }
    }
    const panelHeight = lines.length * LINE_HEIGHT + VERTICAL_PADDING * 2;

    // Draw background panel.
    titan.overlay.screenRect(PANEL_X, PANEL_Y, panelWidth, panelHeight, BG_COLOR);

    // Draw each line.
    for (let i = 0; i < lines.length; i++) {
        const y = PANEL_Y + VERTICAL_PADDING + i * LINE_HEIGHT;
        const line = lines[i];

        if (i === 0) {
            // Title
            drawText(PANEL_X + HORIZONTAL_PADDING, y, line.text, TITLE_COLOR);
            continue;
        }

        if (line.isSectionHeader) {
            drawText(PANEL_X + HORIZONTAL_PADDING, y, line.text, TITLE_COLOR);
            continue;
        }

        // Key (label) column.
        const key = line.key ?? line.text.split(':')[0] + ':';
        drawText(PANEL_X + HORIZONTAL_PADDING, y, key, KEY_COLOR);
        // Value column.
        if (line.value !== undefined && line.value !== '') {
            const valueX = PANEL_X + HORIZONTAL_PADDING + KEY_COLUMN;
            drawText(valueX, y, line.value, line.valueColor ?? TEXT_COLOR);
        }
    }
};
