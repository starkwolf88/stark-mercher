// ============================================================================
// Login dispatcher — SDK staging + credential submission + title click
// ============================================================================
// Adapted from stark-mixology/antiban/login.ts. Handles:
//   1. Staging the account profile via titan.state.login.stageCredentials()
//   2. Submitting credentials via titan.state.login.submitCredentials()
//   3. Clicking the "Click here to play" title screen widget
//   4. Settling 2-5 ticks after login before resuming
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';
import { createDelay } from './humanised-delay.js';
import { getLocalPlayer } from '../general/helpers.js';

const LOGIN_THROTTLE_MS = 1000;
const LOGIN_SUCCESS_LOCKOUT_MS = 8 * 600; // re-check title every 8 ticks (~4.8s)
const TITLE_CLICK_PACKED_ID = 24772680;
const TITLE_CLICK_TEXT = 'Click here to play';

// Post-login settle delay — waits after the title screen disappears before
// resuming the auto-loop. Must be long enough for the world's 3D models to
// load (graph nodes). If too short, the first GE-open click after login lands
// on a leftover UI widget (text=Play) because the clerk/booth graph node is
// still NULL — ClickSafety sanitizes the click and the GE doesn't open,
// wasting ~3s on a retry. 8-12 ticks (4.8-7.2s) base gives enough time for
// the world to render; max cap 18 ticks (10.8s) allows headroom for
// hesitation/outlier humanisation layers.
const POST_LOGIN_RESUME_TICKS_MIN = 8;
const POST_LOGIN_RESUME_TICKS_MAX = 12;
const POST_LOGIN_RESUME_TICKS_MAX_CAP = 18;

const LOGIN_STAGE_THROTTLE_MS = 2000;
const LOGIN_RETRY_INTERVAL_MS = 30 * 1000;
const LOGIN_TOTAL_MAX_ATTEMPTS = 10;
const LOGIN_OVERALL_TIMEOUT_MS = 5 * 60 * 1000;
const STAGED_LOGIN_INDEX = 10;
const STAGED_LOGIN_INDEX_LEGACY = 2;
const GAME_UPDATE_LOGIN_INDEX = 9;
// Index 9 covers both "game update in progress" and "you were signed out".
// We can't distinguish them by message text (the snapshot doesn't expose it),
// so we use exponential backoff: start at 5s, double each retry up to 60s.
// If it's "signed out", the first fast retry succeeds. If it's a game update
// (which can last 30+ min), we back off to avoid hammering the login server.
const INDEX9_RETRY_INITIAL_MS = 5 * 1000;
const INDEX9_RETRY_MAX_MS = 60 * 1000;
const LOGIN_SUBMIT_DELAY_TICKS_MIN = 2;
const LOGIN_SUBMIT_DELAY_TICKS_MAX = 4;

// loginStep is called every game tick (from breakStep) and every second
// (from wallClockStep) while logged out. Each call invokes findTitleWidget
// 2-3 times, creating native WidgetState handles. Throttle the whole step
// to ~3 ticks (1.8s) — login is not time-critical and the internal staging
// (2s) and title-click (1s) throttles already cap the actual work rate.
const LOGIN_STEP_MIN_INTERVAL_MS = 600 * 3;
let lastLoginStepMs = 0;

// Title widget cache — findByText scans every loaded widget's text field
// (~2.7s on the login screen, which has dozens of widget groups). The title
// widget is static once found, so cache the handle and reuse it until it
// goes stale. When not found, throttle findByText to once per 5s to prevent
// back-to-back full scans while the login screen is still loading.
let cachedTitleWidget: titan.WidgetState | null = null;
let titleWidgetMissAtMs = 0;
const TITLE_WIDGET_MISS_THROTTLE_MS = 5000;

/** Invalidates the cached title widget. Called from resetLoginState and
 *  onDisable so stale handles don't survive login state changes. */
export const invalidateTitleWidgetCache = (): void => {
    cachedTitleWidget = null;
    titleWidgetMissAtMs = 0;
};

/** Resets the login-step throttle. Called from onDisable so a toggle off/on
 *  doesn't inherit a stale throttle timestamp from the previous run. */
export const resetLoginThrottle = (): void => {
    lastLoginStepMs = 0;
};

function debugLog(bot: StarkMercher, msg: string, ...args: unknown[]): void {
    if (bot.logDebugValue) titan.logf('[Stark Mercher] ' + msg, ...args);
}

function humanLog(bot: StarkMercher, msg: string, ...args: unknown[]): void {
    if (bot.logInfoValue) titan.logf('[Stark Mercher] ' + msg, ...args);
}

function sampleInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isInWorld(): boolean {
    return !!getLocalPlayer() && titan.state.login.isWorldReady;
}

function findTitleWidget(bot: StarkMercher): titan.WidgetState | null {
    // Cached handle — check liveness without a new native lookup
    if (cachedTitleWidget) {
        try {
            if (cachedTitleWidget.exists && cachedTitleWidget.visible) {
                return cachedTitleWidget;
            }
        } catch { /* stale handle */ }
        cachedTitleWidget = null;
    }
    // Fast path: direct packed-ID lookup (1 native call)
    const byId = titan.state.widgets.find(TITLE_CLICK_PACKED_ID);
    if (byId && byId.exists && byId.visible) {
        cachedTitleWidget = byId;
        titleWidgetMissAtMs = 0;
        return byId;
    }
    // Slow path: findByText scans all widgets (~2.7s on the login screen).
    // Throttle to once per 5s when the widget isn't found to prevent
    // back-to-back full scans while the login screen is still loading.
    const now = Date.now();
    if (now - titleWidgetMissAtMs < TITLE_WIDGET_MISS_THROTTLE_MS) {
        return null;
    }
    try {
        const byText = titan.state.widgets.findByText(TITLE_CLICK_TEXT);
        if (byText && byText.exists && byText.visible) {
            cachedTitleWidget = byText;
            titleWidgetMissAtMs = 0;
            return byText;
        }
    } catch (e) {
        // findByText not supported on this host
    }
    titleWidgetMissAtMs = now;
    return null;
}

// Exported title-screen predicate — single targeted widget lookup (no loops,
// no toArray()). Used by runStartupAudit() to defer the GE audit while the
// title screen is visible, so the audit doesn't log a misleading "closed"
// state or attempt GE actions before the player is in-world.
export function isTitleScreenVisible(_bot: StarkMercher): boolean {
    return findTitleWidget(_bot) !== null;
}

function tryClickTitle(bot: StarkMercher): boolean {
    const now = Date.now();
    const w = findTitleWidget(bot);
    const titleExists = w && w.exists;
    const titleVisible = w && w.visible;

    if (titleExists && isInWorld()) {
        if (titleVisible) {
            // Fall through to click
        } else {
            // Stale title widget — settle via humanised delay.
            // Store as wall-clock timestamp (not setAction) because the
            // tick counter resets on first tick after login, which would
            // wipe the action delay.
            const settleTicks = createDelay(POST_LOGIN_RESUME_TICKS_MIN, POST_LOGIN_RESUME_TICKS_MAX, POST_LOGIN_RESUME_TICKS_MAX_CAP);
            // Reset login state BEFORE setting settle values, otherwise
            // resetLoginState wipes postLoginResumeAtMs/loginSettled.
            resetLoginState(bot);
            bot.postLoginResumeAtMs = now + (settleTicks * 600);
            bot.titleWaitingForGone = false;
            bot.loginSettled = true;
            humanLog(bot, 'In-world with stale title widget; resuming in %d ticks', settleTicks);
            return true;
        }
    }

    if (!titleExists) {
        if (isInWorld() && !bot.loginSettled) {
            debugLog(bot, 'Title screen gone; player in-world; settling');
            const settleTicks = createDelay(POST_LOGIN_RESUME_TICKS_MIN, POST_LOGIN_RESUME_TICKS_MAX, POST_LOGIN_RESUME_TICKS_MAX_CAP);
            // Reset login state BEFORE setting settle values, otherwise
            // resetLoginState wipes postLoginResumeAtMs/loginSettled.
            resetLoginState(bot);
            bot.postLoginResumeAtMs = now + (settleTicks * 600);
            bot.titleWaitingForGone = false;
            bot.loginSettled = true;
            humanLog(bot, 'Title screen gone; resuming in %d ticks', settleTicks);
        }
        return false;
    }

    if (now < bot.titleNextClickAt) return false;

    const titleW = findTitleWidget(bot);
    if (!titleW || !titleW.visible) {
        debugLog(bot, 'Title widget not visible; will retry');
        bot.titleNextClickAt = now + LOGIN_THROTTLE_MS;
        return false;
    }

    // Humanised reaction delay — wait before clicking the title widget
    // the first time it's seen. A human doesn't click instantly when the
    // "Click here to play" screen appears; they have a reaction time.
    if (bot.titleFirstSeenAtMs <= 0) {
        const delayTicks = createDelay(2, 50, 8);
        bot.titleFirstSeenAtMs = now;
        bot.titleClickDelayMs = delayTicks * 600;
        debugLog(bot, 'Title screen visible; waiting %d ticks (%dms) before clicking', delayTicks, bot.titleClickDelayMs);
        return false;
    }
    if (now < bot.titleFirstSeenAtMs + bot.titleClickDelayMs) {
        return false; // still within the reaction delay
    }

    const clicked = titleW.interact(titan.MenuAction.CC_OP, 1);
    if (!clicked) {
        debugLog(bot, 'Title widget interact returned false; will retry');
        bot.titleNextClickAt = now + LOGIN_THROTTLE_MS;
        return false;
    }

    bot.titleWaitingForGone = true;
    bot.titleNextClickAt = now + LOGIN_SUCCESS_LOCKOUT_MS;
    bot.titleFirstSeenAtMs = 0; // clear so a retry gets a fresh delay
    bot.postLoginResumeAtMs = Number.MAX_SAFE_INTEGER;
    humanLog(bot, 'Clicked title screen "Click here to play"');
    return true;
}

function tryStageAndSubmitLogin(bot: StarkMercher): boolean {
    const now = Date.now();
    const snap = titan.state.login.snapshot();
    if (!snap || snap.gameState !== titan.LoginGameState.LoginScreen) {
        return false;
    }

    // Index 9 — "game update in progress" OR "you were signed out".
    // The snapshot doesn't expose the message text, so we can't distinguish
    // them. We use exponential backoff (5s → 10s → 20s → 40s → 60s cap) and
    // re-stage credentials on each retry. If it's "signed out", the first
    // fast retry succeeds. If it's a game update, we back off to avoid
    // hammering the login server for 30+ minutes.
    // loginGameUpdateWaitAtMs is repurposed as the last retry delay (ms).
    if (snap.loginIndex === GAME_UPDATE_LOGIN_INDEX) {
        if (bot.loginGameUpdateWaitAtMs <= 0) {
            // First detection — start with the initial delay.
            bot.loginGameUpdateWaitAtMs = INDEX9_RETRY_INITIAL_MS;
            bot.loginFirstAttemptAtMs = 0;
            bot.loginStageNextAttemptAt = now + INDEX9_RETRY_INITIAL_MS;
            humanLog(bot, 'Login screen message (loginIndex=9); retrying in %ds', Math.round(INDEX9_RETRY_INITIAL_MS / 1000));
        } else if (now >= bot.loginStageNextAttemptAt) {
            bot.loginFirstAttemptAtMs = 0;
            // Re-stage credentials on each retry — handles "signed out" where
            // the credential fields were cleared.
            const characterName = bot.currentPlayerName?.trim() || '';
            if (characterName) {
                titan.state.login.stageCredentials(characterName);
            }
            // Exponential backoff: double the last delay, capped at max.
            const lastDelay = bot.loginGameUpdateWaitAtMs;
            const retryMs = Math.min(INDEX9_RETRY_MAX_MS, lastDelay * 2);
            bot.loginGameUpdateWaitAtMs = retryMs;
            bot.loginStageNextAttemptAt = now + retryMs;
            debugLog(bot, 'Login screen message persists (loginIndex=9); re-staged %s, retrying in %ds',
                characterName || '(no name)', Math.round(retryMs / 1000));
        }
        return true;
    }

    if (bot.loginGameUpdateWaitAtMs > 0) {
        debugLog(bot, 'Login screen message cleared (loginIndex=%d); resuming login flow', snap.loginIndex);
        bot.loginGameUpdateWaitAtMs = 0;
        bot.loginStageNextAttemptAt = 0;
    }

    // Overall timeout
    if (bot.loginFirstAttemptAtMs > 0 && now - bot.loginFirstAttemptAtMs > LOGIN_OVERALL_TIMEOUT_MS) {
        bot.terminated = true;
        bot.terminationReason = `Failed to log in within ${LOGIN_OVERALL_TIMEOUT_MS / 1000}s`;
        titan.logf('[Stark Mercher] %s', bot.terminationReason);
        return false;
    }

    const characterName = bot.currentPlayerName?.trim() || '';
    const isStaged = snap.loginIndex === STAGED_LOGIN_INDEX || snap.loginIndex === STAGED_LOGIN_INDEX_LEGACY;

    // Retry: re-stage if still on login screen after submit
    if (isStaged && bot.loginSubmitAttemptTimes.length > 0 && now >= bot.loginStageNextAttemptAt) {
        if (bot.loginTotalSubmitAttempts >= LOGIN_TOTAL_MAX_ATTEMPTS) {
            bot.terminated = true;
            bot.terminationReason = `Failed to log in after ${LOGIN_TOTAL_MAX_ATTEMPTS} attempts`;
            titan.logf('[Stark Mercher] %s', bot.terminationReason);
            return false;
        }
        humanLog(bot, 'Login retry: re-staging credentials (attempt %d/%d)',
            bot.loginTotalSubmitAttempts + 1, LOGIN_TOTAL_MAX_ATTEMPTS);
        titan.state.login.stageCredentials(characterName);
        bot.loginSubmitAttemptTimes = [];
        bot.loginStageDetectedAtMs = now;
        bot.titleWaitingForGone = false;
        const waitTicks = sampleInt(LOGIN_SUBMIT_DELAY_TICKS_MIN, LOGIN_SUBMIT_DELAY_TICKS_MAX);
        bot.loginStageNextAttemptAt = now + (waitTicks * 600);
        return true;
    }

    // Already staged and submitted — let tryClickTitle handle the title
    if (isStaged && (bot.titleWaitingForGone || bot.loginSubmitAttemptTimes.length > 0)) {
        return false;
    }

    // First detection of staged profile — re-stage with the current account
    // name to ensure the staged profile matches bot.currentPlayerName. After
    // account rotation, the OSRS client may still have the PREVIOUS account's
    // profile staged (loginIndex=10). Without re-staging, submitCredentials()
    // would log in as the previous account, not the newly selected one.
    // Re-staging the same account (no rotation) is harmless.
    if (isStaged && bot.loginSubmitAttemptTimes.length === 0 && bot.loginStageDetectedAtMs <= 0) {
        if (characterName) {
            titan.state.login.stageCredentials(characterName);
            debugLog(bot, 'Re-staged profile credentials for %s (loginIndex=%d)', characterName, snap.loginIndex);
        }
        bot.loginStageDetectedAtMs = now;
        const waitTicks = sampleInt(LOGIN_SUBMIT_DELAY_TICKS_MIN, LOGIN_SUBMIT_DELAY_TICKS_MAX);
        bot.loginStageNextAttemptAt = now + (waitTicks * 600);
        debugLog(bot, 'Staged profile detected (loginIndex=%d); waiting %d ticks before submitting', snap.loginIndex, waitTicks);
        return true;
    }

    if (now < bot.loginStageNextAttemptAt) return false;

    if (!characterName) {
        bot.terminated = true;
        bot.terminationReason = 'Cannot auto-login: no character name found to stage profile credentials';
        titan.logf('[Stark Mercher] %s', bot.terminationReason);
        return false;
    }

    if (bot.loginFirstAttemptAtMs <= 0) {
        bot.loginFirstAttemptAtMs = now;
    }

    if (!isStaged) {
        // Startup grace period: on a fresh client launch, the native account
        // profile system may not be ready yet. stageCredentials() returns
        // false until the profile resolver initializes. Wait for the grace
        // period before attempting the first stage, then use a longer
        // throttle (5s) until staging succeeds — the 2s default causes a
        // rapid retry loop that never catches the profile system becoming
        // ready.
        if (now < bot.loginStartupGraceUntil) {
            const remaining = Math.ceil((bot.loginStartupGraceUntil - now) / 1000);
            debugLog(bot, `Waiting ${remaining}s for native login system before first stage attempt (loginIndex=${snap.loginIndex})`);
            bot.loginStageNextAttemptAt = bot.loginStartupGraceUntil;
            return true;
        }
        const ok = titan.state.login.stageCredentials(characterName);
        // Use a longer throttle (5s) when staging fails so we don't hammer
        // the native profile resolver. Once it succeeds, the normal 2s
        // throttle applies for any subsequent re-stage needs.
        bot.loginStageNextAttemptAt = now + (ok ? LOGIN_STAGE_THROTTLE_MS : 5000);
        if (ok) {
            debugLog(bot, 'Staged profile credentials for %s', characterName);
            // Clear the grace period — the native system is ready now.
            bot.loginStartupGraceUntil = 0;
        } else {
            debugLog(bot, `stageCredentials(${characterName}) returned false (loginIndex=${snap.loginIndex}); will retry in 5s`);
        }
        return true;
    }

    // Submit credentials
    const submitted = titan.state.login.submitCredentials();
    bot.loginStageNextAttemptAt = now + LOGIN_RETRY_INTERVAL_MS;
    bot.loginSubmitAttemptTimes.push(now);
    bot.loginTotalSubmitAttempts++;

    if (submitted) {
        humanLog(bot, 'Submitted credentials for %s (attempt %d/%d)',
            characterName, bot.loginTotalSubmitAttempts, LOGIN_TOTAL_MAX_ATTEMPTS);
    } else {
        debugLog(bot, 'submitCredentials() returned false; will retry (attempt %d/%d)',
            bot.loginTotalSubmitAttempts, LOGIN_TOTAL_MAX_ATTEMPTS);
    }
    return true;
}

/** Called from onMainLoop when the player is logged out. */
export function loginStep(bot: StarkMercher): void {
    const now = Date.now();
    if (now - lastLoginStepMs < LOGIN_STEP_MIN_INTERVAL_MS) return;
    lastLoginStepMs = now;
    const w = findTitleWidget(bot);
    const titleExists = w && w.exists;

    if (bot.loginSettled && titleExists) {
        resetLoginState(bot);
    }

    if (tryStageAndSubmitLogin(bot)) return;

    if (bot.titleWaitingForGone) {
        if (!titleExists) {
            if (isInWorld()) {
                const settleTicks = createDelay(POST_LOGIN_RESUME_TICKS_MIN, POST_LOGIN_RESUME_TICKS_MAX, POST_LOGIN_RESUME_TICKS_MAX_CAP);
                // Reset login state BEFORE setting settle values, otherwise
                // resetLoginState wipes postLoginResumeAtMs/loginSettled.
                resetLoginState(bot);
                bot.postLoginResumeAtMs = Date.now() + (settleTicks * 600);
                bot.titleWaitingForGone = false;
                bot.loginSettled = true;
                humanLog(bot, 'Title screen gone; resuming in %d ticks', settleTicks);
            }
            return;
        }
        const now = Date.now();
        if (now >= bot.titleNextClickAt) {
            debugLog(bot, 'Title screen still present after accepted click; retrying');
            bot.titleWaitingForGone = false;
        } else {
            return;
        }
    }

    tryClickTitle(bot);
}

/** Reset login state (called on enable, break start, break end). */
export function resetLoginState(bot: StarkMercher): void {
    bot.titleNextClickAt = 0;
    bot.titleFirstSeenAtMs = 0;
    bot.titleClickDelayMs = 0;
    bot.postLoginResumeAtMs = -1;
    bot.titleWaitingForGone = false;
    bot.loginSettled = false;
    bot.loginStageNextAttemptAt = 0;
    bot.loginStageDetectedAtMs = 0;
    bot.loginGameUpdateWaitAtMs = 0;
    bot.loginSubmitAttemptTimes = [];
    bot.loginFirstAttemptAtMs = 0;
    bot.loginTotalSubmitAttempts = 0;
    // Allow the next loginStep to run immediately after a reset.
    invalidateTitleWidgetCache();
    lastLoginStepMs = 0;
}
