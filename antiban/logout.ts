// ============================================================================
// Logout dispatcher — 2-step logout (door -> confirm)
// ============================================================================
// Adapted from stark-mixology/antiban/logout.ts. Clicks the logout door/tab,
// waits, then clicks the confirm button. Runs from onMainLoop so it keeps
// clicking even when game ticks are paused on the login screen.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';

const LOGOUT_COOLDOWN_MIN = 20;
const LOGOUT_COOLDOWN_MAX = 30;

const LOGOUT_TAB_PACKED = 35913779;        // logout door/tab (fixed mode)
const LOGOUT_TAB_PACKED_LEGACY = 10551342; // logout door/tab (resizable mode)
const LOGOUT_CONFIRM_PACKED = 4522009;     // "Click here to logout" panel button
const LOGOUT_CLICK_HERE_PACKED = 11927560; // "click here to logout" (non-world-switcher)

const DOOR_LABELS = ['Logout', 'Log out', 'Log Out'];
const CONFIRM_LABELS = ['Click here to logout', 'Logout', 'Log out', 'Log Out'];

function debugLog(bot: StarkMercher, msg: string): void {
    if (bot.logDebug.value) titan.logf('[Stark Mercher] %s', msg);
}

function tryClickLogoutObject(bot: StarkMercher): boolean {
    try {
        const door = titan.queries.objects()
            .hasAction('Log out', 'Log-out', 'Logout', 'Log Out')
            .nearest();
        if (door && door.exists) {
            const actions = door.actions;
            const action = actions.find(a => DOOR_LABELS.includes(a)) || actions[0];
            if (action) {
                const ok = door.interact(action);
                if (ok) {
                    debugLog(bot, `Logout click dispatched on object ${door.name} (action: ${action})`);
                    return true;
                }
            }
        }
    } catch (e) {
        debugLog(bot, `Logout object click failed: ${String(e)}`);
    }
    return false;
}

function tryClickWidget(bot: StarkMercher, packed: number, description: string, ccOpIndex?: number, childSlot?: number): boolean {
    try {
        const widget = titan.state.widgets.find(packed);
        if (widget && widget.visible) {
            const opcode = typeof ccOpIndex === 'number' ? titan.MenuAction.CC_OP : titan.MenuAction.WIDGET_TYPE_1;
            const identifier = typeof ccOpIndex === 'number' ? ccOpIndex : 0;
            const ok = typeof childSlot === 'number' ? widget.interact(opcode, identifier, childSlot) : widget.interact(opcode, identifier);
            if (ok) {
                debugLog(bot, `Logout click dispatched for ${description} (packed ${packed})`);
                return true;
            }
        }
    } catch (e) {
        debugLog(bot, `Logout click failed for ${description}: ${String(e)}`);
    }
    return false;
}

function tryClickText(bot: StarkMercher, labels: string[], description: string, ccOpIndex?: number): boolean {
    for (const label of labels) {
        try {
            const widget = titan.state.widgets.findByText(label);
            if (widget && widget.visible) {
                const opcode = typeof ccOpIndex === 'number' ? titan.MenuAction.CC_OP : titan.MenuAction.WIDGET_TYPE_1;
                const identifier = typeof ccOpIndex === 'number' ? ccOpIndex : 0;
                const ok = widget.interact(opcode, identifier);
                if (ok) {
                    debugLog(bot, `Logout click dispatched for ${description} (text: ${label})`);
                    return true;
                }
            }
        } catch (e) {
            debugLog(bot, `Logout text click failed for ${description} (${label}): ${String(e)}`);
        }
    }
    return false;
}

/** Two-step logout: click the logout tab/door, wait, then click confirm.
 *  Returns true when the player has been logged out (logoutComplete set). */
export function logoutForBreak(bot: StarkMercher, reason: string = 'break', silent: boolean = false): void {
    const now = Date.now();
    const playerName = titan.state.client.localPlayer?.name;

    if (now < bot.logoutNextAttemptMs) return;

    // If the GE interface is open, close it first so the logout tab is accessible.
    // The GE window can block the logout door widget.
    // We don't close the bank here since the mercher doesn't use the bank yet.

    if (!playerName) {
        // Already logged out (or name not yet loaded).
        bot.logoutStep = 2;
        bot.logoutComplete = true;
        return;
    }

    if (bot.logoutStep === 2) {
        // Confirmation click was sent; give the client a moment to log out,
        // then re-open the door if it is still logged in.
        bot.logoutStep = 0;
        bot.logoutNextAttemptMs = now + 1000;
        return;
    }

    if (bot.logoutStep === 1) {
        if (tryClickText(bot, CONFIRM_LABELS, 'logout confirm', 1)) {
            bot.logoutStep = 2;
            bot.logoutNextAttemptMs = now + 5000;
            return;
        }
        if (tryClickWidget(bot, LOGOUT_CONFIRM_PACKED, 'logout confirm (world switcher)', 1)) {
            bot.logoutStep = 2;
            bot.logoutNextAttemptMs = now + 5000;
            return;
        }
        if (tryClickWidget(bot, LOGOUT_CLICK_HERE_PACKED, 'logout confirm (menu)', 1, -1)) {
            bot.logoutStep = 2;
            bot.logoutNextAttemptMs = now + 5000;
            return;
        }
        // Confirm not visible; retry door
        if (silent) debugLog(bot, 'Logout confirm not visible, retrying door');
        else titan.logf('[Stark Mercher] Logout confirm not visible, retrying door');
        bot.logoutStep = 0;
        bot.logoutNextAttemptMs = now + 1000;
        return;
    }

    // Step 0: click the logout door/tab.
    if (bot.logoutAttemptCount >= 5) {
        if (silent) debugLog(bot, 'Logout failed after 5 attempts; terminating script');
        else titan.logf('[Stark Mercher] Logout failed after 5 attempts; terminating script');
        bot.terminated = true;
        return;
    }
    bot.logoutAttemptCount++;

    if (tryClickLogoutObject(bot)) {
        bot.logoutStep = 1;
        bot.logoutNextAttemptMs = now + 2000;
        return;
    }

    if (tryClickWidget(bot, LOGOUT_TAB_PACKED, 'logout door', 1)) {
        bot.logoutStep = 1;
        bot.logoutNextAttemptMs = now + 2000;
        return;
    }

    if (tryClickWidget(bot, LOGOUT_TAB_PACKED_LEGACY, 'logout door (legacy)', 1)) {
        bot.logoutStep = 1;
        bot.logoutNextAttemptMs = now + 2000;
        return;
    }

    if (tryClickText(bot, DOOR_LABELS, 'logout door', 1)) {
        bot.logoutStep = 1;
        bot.logoutNextAttemptMs = now + 2000;
        return;
    }

    if (tryClickWidget(bot, LOGOUT_CLICK_HERE_PACKED, 'logout click here', 1, -1)) {
        bot.logoutStep = 1;
        bot.logoutNextAttemptMs = now + 2000;
        return;
    }

    if (silent) debugLog(bot, `Could not find logout door for ${reason}; will retry`);
    else titan.logf('[Stark Mercher] Could not find logout door for %s; will retry', reason);
    bot.logoutNextAttemptMs = now + (LOGOUT_COOLDOWN_MIN + Math.floor(Math.random() * (LOGOUT_COOLDOWN_MAX - LOGOUT_COOLDOWN_MIN + 1))) * 1000;
}

/** Reset logout state (called on enable / break start / break end). */
export function resetLogoutState(bot: StarkMercher): void {
    bot.logoutStep = 0;
    bot.logoutAttemptCount = 0;
    bot.logoutNextAttemptMs = 0;
    bot.logoutComplete = false;
}
