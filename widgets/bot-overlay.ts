// ============================================================================
// Bot overlay — minimal mode-label HUD with start time
// ============================================================================
// Shows two lines:
//   1. The current autoMode label (Paused / Normal / Slow / F2P)
//   2. "Start: HH:MM" — the UK time the script first started this client session
//
// The render callback fires every frame but does the absolute minimum:
// one screenRect (background) + two screenText calls. No arrays,
// no Date.now(), no cache lookups, no native SDK reads. Both text strings are
// plain-JS fields (overlayStatusText, sessionStartUKTime) on the plugin
// instance, updated only in onEnable / onDisable / onSettingChanged — never
// per-frame.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';

const PANEL_X = 0;
const PANEL_Y = 40;
const LINE_HEIGHT = 16;
const HORIZONTAL_PADDING = 12;
const RIGHT_PADDING = 10;
const VERTICAL_PADDING = 8;
const CHAR_WIDTH = 8;

const BG_COLOR = 0xCC000000;
const GREEN_COLOR = 0xFF52DD6B;
const GREY_COLOR = 0xFF808080;
const RED_COLOR = 0xFFF22E60;

export const renderBotOverlay = (bot: StarkMercher): void => {
    const label = bot.overlayStatusText;
    const color = bot.terminated
        ? RED_COLOR
        : bot.autoModeValue === 0
            ? GREY_COLOR
            : GREEN_COLOR;

    const startLine = `Start: ${bot.sessionStartUKTime}`;
    // Panel width is the wider of the two lines.
    const labelWidth = HORIZONTAL_PADDING + label.length * CHAR_WIDTH + RIGHT_PADDING;
    const startWidth = HORIZONTAL_PADDING + startLine.length * CHAR_WIDTH + RIGHT_PADDING;
    const panelWidth = Math.max(labelWidth, startWidth);
    const panelHeight = LINE_HEIGHT * 2 + VERTICAL_PADDING * 2;

    titan.overlay.screenRect(PANEL_X, PANEL_Y, panelWidth, panelHeight, BG_COLOR);
    titan.overlay.screenText(
        PANEL_X + HORIZONTAL_PADDING,
        PANEL_Y + VERTICAL_PADDING,
        label,
        color,
    );
    titan.overlay.screenText(
        PANEL_X + HORIZONTAL_PADDING,
        PANEL_Y + VERTICAL_PADDING + LINE_HEIGHT,
        startLine,
        GREY_COLOR,
    );
};
