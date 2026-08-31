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
import { getDailyProfit } from '../data/daily-profit.js';
import { formatUKTime } from '../antiban/session.js';

// --- Layout constants ------------------------------------------------------

const PANEL_X = 50;
const PANEL_Y = 50;
const LINE_HEIGHT = 16;
const HORIZONTAL_PADDING = 12;
const VERTICAL_PADDING = 8;
const KEY_COLUMN = 130;
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

const formatGp = (amount: number): string => amount.toLocaleString('en-US');

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
 *   3. Break phase with countdown → "Sleeping (Xm Ys)" / "Breaking (Xm Ys)"
 *   4. Break phase (logging_out / logging_in) → transition status
 *   5. Auto mode off → "Manual test mode"
 *   6. bot.statusText (set by the auto-loop or test flows)
 */
const getStatusText = (bot: StarkMercher): string => {
    if (bot.terminated) return 'Stopped';
    if (bot.hopInProgress) return 'Hopping';
    if (bot.hopResumeAtMs > 0 && Date.now() < bot.hopResumeAtMs) return 'Resuming';
    if (bot.breakPhase === 'logging_out') return 'Logging out for break...';
    if (bot.breakPhase === 'logged_out') {
        const label = bot.breakType === 'nightly' ? 'Sleeping' : 'Breaking';
        if (bot.breakTargetEndMs > 0) {
            const remainingMs = Math.max(0, bot.breakTargetEndMs - Date.now());
            return `${label} (${fmtCountdownMs(remainingMs)})`;
        }
        return label;
    }
    if (bot.breakPhase === 'logging_in') return 'Logging in...';
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
    const coins = titan.utils.inventory.count(995);
    const playerName = bot.currentPlayerName || titan.state.client.localPlayer?.name || '';
    const dailyProfit = playerName ? getDailyProfit(bot, playerName) : 0;

    const isSleeping = bot.breakPhase === 'logged_out' && bot.breakType === 'nightly';
    const isOnBreak = bot.breakPhase === 'logged_out' && bot.breakType === 'short';

    // --- Status color ---
    let statusColor = TEXT_COLOR;
    if (status === 'Stopped') statusColor = RED_COLOR;
    else if (status === 'Hopping' || status === 'Resuming') statusColor = ORANGE_COLOR;
    else if (isSleeping || status.startsWith('Sleeping')) statusColor = ORANGE_COLOR;
    else if (isOnBreak || status.startsWith('Breaking')) statusColor = ORANGE_COLOR;
    else if (status === 'Idle' || status === 'Manual test mode') statusColor = GREY_COLOR;
    else statusColor = GREEN_COLOR;

    // --- Build lines ---
    const lines: OverlayLine[] = [];

    // Title
    lines.push({ text: '[STARK] Mercher' });

    // Status
    lines.push({ text: 'Status:', key: 'Status:', value: status, valueColor: statusColor });

    // Inventory Coins
    lines.push({ text: 'Inventory Coins:', key: 'Inventory Coins:', value: `${formatGp(coins)} gp` });

    // Daily Profit
    const profitStr = `${dailyProfit >= 0 ? '+' : ''}${formatGp(dailyProfit)} gp`;
    const profitColor = dailyProfit > 0 ? PROFIT_POSITIVE_COLOR
        : dailyProfit < 0 ? PROFIT_NEGATIVE_COLOR
        : PROFIT_ZERO_COLOR;
    lines.push({ text: 'Daily Profit:', key: 'Daily Profit:', value: profitStr, valueColor: profitColor });

    // --- TIMERS section ---
    lines.push({ text: 'TIMERS', isSectionHeader: true });

    // Session (Day)
    if (isSleeping) {
        lines.push({ text: 'Session (Day):', key: 'Session (Day):', value: 'Sleeping', valueColor: ORANGE_COLOR });
    } else if (bot.sessionPlayStartMs > 0) {
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
    } else if (isSleeping) {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Sleeping', valueColor: ORANGE_COLOR });
    } else if (bot.hopInProgress) {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Hopping...', valueColor: ORANGE_COLOR });
    } else if (bot.hopResumeAtMs > 0 && Date.now() < bot.hopResumeAtMs) {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'Resuming...', valueColor: ORANGE_COLOR });
    } else if (bot.breakPhase !== 'none') {
        lines.push({ text: 'Next Hop:', key: 'Next Hop:', value: 'On Break', valueColor: ORANGE_COLOR });
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
        const wakeMs = isSleeping && bot.breakTargetEndMs > 0
            ? bot.breakTargetEndMs
            : sleepMs + (bot.nightlySleepMinutes > 0 ? bot.nightlySleepMinutes * 60000 : 0);
        if (isSleeping) {
            const remainingSec = Math.max(0, Math.ceil((wakeMs - Date.now()) / 1000));
            const wakeStr = remainingSec === 0 ? 'now' : formatUKTime(wakeMs);
            lines.push({ text: 'Sleep Time:', key: 'Sleep Time:', value: 'Sleeping', valueColor: ORANGE_COLOR });
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
    const maxLineLen = Math.max(...lines.map(l => {
        if (l.isSectionHeader) return l.text.length;
        if (l.value === undefined || l.value === '') return l.text.length;
        // key + ": " + value
        return (l.key?.length ?? l.text.length) + 2 + l.value.length;
    }));
    const panelWidth = Math.max(280, maxLineLen * CHAR_WIDTH + HORIZONTAL_PADDING * 2);
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
