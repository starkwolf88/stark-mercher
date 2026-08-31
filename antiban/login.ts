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

const LOGIN_THROTTLE_MS = 1000;
const LOGIN_SUCCESS_LOCKOUT_MS = 5 * 600; // re-check title every 5 ticks (~3s)
const TITLE_CLICK_PACKED_ID = 24772680;
const TITLE_CLICK_TEXT = 'Click here to play';

const POST_LOGIN_RESUME_TICKS_MIN = 2;
const POST_LOGIN_RESUME_TICKS_MAX = 5;

const LOGIN_STAGE_THROTTLE_MS = 2000;
const LOGIN_RETRY_INTERVAL_MS = 30 * 1000;
const LOGIN_TOTAL_MAX_ATTEMPTS = 10;
const LOGIN_OVERALL_TIMEOUT_MS = 5 * 60 * 1000;
const STAGED_LOGIN_INDEX = 10;
const STAGED_LOGIN_INDEX_LEGACY = 2;
const GAME_UPDATE_LOGIN_INDEX = 9;
const GAME_UPDATE_RETRY_MIN_MS = 30 * 1000;
const GAME_UPDATE_RETRY_MAX_MS = 60 * 1000;
const LOGIN_SUBMIT_DELAY_TICKS_MIN = 2;
const LOGIN_SUBMIT_DELAY_TICKS_MAX = 4;

function debugLog(bot: StarkMercher, msg: string, ...args: unknown[]): void {
    if (bot.logDebug.value) titan.logf('[Stark Mercher] ' + msg, ...args);
}

function humanLog(bot: StarkMercher, msg: string, ...args: unknown[]): void {
    titan.logf('[Stark Mercher] ' + msg, ...args);
}

function sampleInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isInWorld(): boolean {
    return !!titan.state.client.localPlayer && titan.state.login.isWorldReady;
}

function findTitleWidget(bot: StarkMercher): titan.WidgetState | null {
    const byId = titan.state.widgets.find(TITLE_CLICK_PACKED_ID);
    if (byId && byId.exists && byId.visible) return byId;
    try {
        const byText = titan.state.widgets.findByText(TITLE_CLICK_TEXT);
        if (byText && byText.exists && byText.visible) return byText;
    } catch (e) {
        // findByText not supported on this host
    }
    return null;
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
            const settleTicks = createDelay(POST_LOGIN_RESUME_TICKS_MIN, 50);
            bot.postLoginResumeAtMs = now + (settleTicks * 600);
            bot.titleWaitingForGone = false;
            bot.loginSettled = true;
            resetLoginState(bot);
            humanLog(bot, 'In-world with stale title widget; resuming in %d ticks', settleTicks);
            return true;
        }
    }

    if (!titleExists) {
        if (isInWorld() && !bot.loginSettled) {
            debugLog(bot, 'Title screen gone; player in-world; settling');
            const settleTicks = createDelay(POST_LOGIN_RESUME_TICKS_MIN, 50);
            bot.postLoginResumeAtMs = now + (settleTicks * 600);
            bot.titleWaitingForGone = false;
            bot.loginSettled = true;
            resetLoginState(bot);
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

    const clicked = titleW.interact(titan.MenuAction.CC_OP, 1);
    if (!clicked) {
        debugLog(bot, 'Title widget interact returned false; will retry');
        bot.titleNextClickAt = now + LOGIN_THROTTLE_MS;
        return false;
    }

    bot.titleWaitingForGone = true;
    bot.titleNextClickAt = now + LOGIN_SUCCESS_LOCKOUT_MS;
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

    // Game update in progress
    if (snap.loginIndex === GAME_UPDATE_LOGIN_INDEX) {
        if (bot.loginGameUpdateWaitAtMs <= 0) {
            bot.loginGameUpdateWaitAtMs = now;
            bot.loginFirstAttemptAtMs = 0;
            const retryMs = sampleInt(GAME_UPDATE_RETRY_MIN_MS, GAME_UPDATE_RETRY_MAX_MS);
            bot.loginStageNextAttemptAt = now + retryMs;
            humanLog(bot, 'Game update in progress (loginIndex=9); retrying login in %ds', Math.round(retryMs / 1000));
        } else if (now >= bot.loginStageNextAttemptAt) {
            bot.loginFirstAttemptAtMs = 0;
            const retryMs = sampleInt(GAME_UPDATE_RETRY_MIN_MS, GAME_UPDATE_RETRY_MAX_MS);
            bot.loginStageNextAttemptAt = now + retryMs;
            debugLog(bot, 'Game update still in progress; retrying login in %ds', Math.round(retryMs / 1000));
        }
        return true;
    }

    if (bot.loginGameUpdateWaitAtMs > 0) {
        debugLog(bot, 'Game update finished (loginIndex=%d); resuming login flow', snap.loginIndex);
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

    // First detection of staged profile — wait before submitting
    if (isStaged && bot.loginSubmitAttemptTimes.length === 0 && bot.loginStageDetectedAtMs <= 0) {
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
        const ok = titan.state.login.stageCredentials(characterName);
        bot.loginStageNextAttemptAt = now + LOGIN_STAGE_THROTTLE_MS;
        if (ok) debugLog(bot, 'Staged profile credentials for %s', characterName);
        else debugLog(bot, 'stageCredentials(%s) returned false; will retry', characterName);
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
    const w = findTitleWidget(bot);
    const titleExists = w && w.exists;

    if (bot.loginSettled && titleExists) {
        resetLoginState(bot);
    }

    if (tryStageAndSubmitLogin(bot)) return;

    if (bot.titleWaitingForGone) {
        if (!titleExists) {
            if (isInWorld()) {
                const settleTicks = createDelay(POST_LOGIN_RESUME_TICKS_MIN, 50);
                bot.postLoginResumeAtMs = Date.now() + (settleTicks * 600);
                bot.titleWaitingForGone = false;
                bot.loginSettled = true;
                resetLoginState(bot);
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
    bot.postLoginResumeAtMs = -1;
    bot.titleWaitingForGone = false;
    bot.loginSettled = false;
    bot.loginStageNextAttemptAt = 0;
    bot.loginStageDetectedAtMs = 0;
    bot.loginGameUpdateWaitAtMs = 0;
    bot.loginSubmitAttemptTimes = [];
    bot.loginFirstAttemptAtMs = 0;
    bot.loginTotalSubmitAttempts = 0;
}
