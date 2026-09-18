import type { StarkMercher } from '../stark-mercher.js';
import { resetAutoLoop, invalidateInvCache } from '../grand_exchange/auto-loop.js';
import { invalidateGeWidgetCache } from '../grand_exchange/widgets.js';
import { resetBreakState, restoreBreakState, initSessionProfile, resetHopState, loadHopState } from '../antiban/session.js';
import { loadRotationIndex } from '../antiban/account-rotation.js';
import { getLocalPlayer } from './helpers.js';

// onEnable()
export const onEnable = (bot: StarkMercher) => {
    titan.log('SCRIPT START');
    resetState(bot);
    // Log the current mode and idle activity so log analysis can identify
    // the configuration without the user needing to state it each time.
    const modeLabel = bot.autoMode.value === 3 ? 'F2P'
        : bot.autoMode.value === 2 ? 'Slow'
        : bot.autoMode.value === 1 ? 'Normal'
        : 'Paused';
    const idleLabel = bot.idleActivity.value === 1 ? 'Chocolate Dust'
        : bot.idleActivity.value === 2 ? 'Ultra Compost'
        : bot.idleActivity.value === 3 ? 'Goat Horn Dust'
        : bot.idleActivity.value === 4 ? 'Any'
        : 'None';
    if (bot.logInfoValue) titan.logf('[Stark Mercher] Mode: %s | Idle Activity: %s', modeLabel, idleLabel);
};

// resetForResume()
export const resetForResume = (bot: StarkMercher) => {
    resetState(bot);
};

// terminate()
export const terminate = (bot: StarkMercher, reason: string) => {
    if (bot.terminated) return;
    bot.terminated = true;
    bot.isRunning = false;
    bot.statusText = 'Stopped';
    bot.terminationReason = reason;
    // Clear the persisted script start timestamp so a manual stop + restart
    // starts a fresh overlay timer instead of continuing the old one.
    bot.scriptStartSetting.value = '0';
    titan.logf("[Stark Mercher] Terminated: %s", reason);
};

// resetState()
const resetState = (bot: StarkMercher) => {
    bot.terminated = false;
    bot.terminationReason = '';
    bot.isRunning = false;
    bot.statusText = 'Idle';
    // Restore the script start timestamp from the hidden setting so the
    // overlay timer survives hot reloads. On a fresh start (empty setting,
    // e.g. client restart or first enable) we stamp Date.now() and persist
    // it. terminate() clears the setting so a manual stop + restart starts
    // a fresh timer.
    {
        const saved = bot.scriptStartSetting.value;
        const parsed = parseInt(saved, 10);
        if (parsed > 0) {
            bot.scriptStartMs = parsed;
            const elapsedMin = Math.floor((Date.now() - parsed) / 60000);
            if (bot.logInfoValue) titan.logf('[Stark Mercher] Script timer restored — running for %d min', elapsedMin);
        } else {
            bot.scriptStartMs = Date.now();
            bot.scriptStartSetting.value = String(bot.scriptStartMs);
            // Fresh client tab — hidden settings (merch history, daily
            // profit) do NOT persist across client restarts, so the
            // profitDisplaySetting (a visible setting, which DOES persist)
            // is stale. Clear it so the user doesn't see profit from a
            // previous session until the next logout refreshes it.
            bot.profitDisplaySetting.value = '';
        }
    }
    bot.lastActionTick = -1;
    bot.currentAction = null;
    bot.actionStartTime = 0;
    bot.actionDelay = 0;
    bot.lastAction = null;
    bot.lastActionTime = 0;
    bot.startupAuditDone = false;
    // Reset the auto-merch loop state (flows, cache handle, attempted-item sets).
    // The persisted offer cache is NOT cleared here — it survives hot reloads.
    // The cache is re-loaded from the setting on the first autoLoopTick via
    // OfferCacheManager. Note: hidden settings do NOT survive client restarts
    // (Titan's host app does not persist them to disk). On client restart, the
    // cache is empty and must be reconstructed from live GE state (reverse
    // reconciliation in auto-loop.ts Step 2b — TODO).
    // The persisted offer cache is NOT cleared here — it survives restarts
    // and hot reloads. The cache is re-loaded from the setting on the first
    // autoLoopTick via OfferCacheManager.
    resetAutoLoop(bot);
    // Invalidate the cross-tick widget and inventory caches. resetBreakState
    // (called below) invalidates the members-world, boolean-state, and
    // near-GE caches, but does NOT invalidate the GE widget or inventory
    // caches. On a toggle off/on (where the JS module is not re-evaluated),
    // stale native handles from the previous run would persist in these
    // caches alongside new handles created by the next run, gradually
    // exhausting the native handle table.
    invalidateGeWidgetCache();
    invalidateInvCache();
    // Restore break/login state from the persisted setting if a valid saved
    // state exists (e.g. hot reload during a sleep or short break). Otherwise
    // reset to defaults. The persisted session profile is NOT cleared — it
    // survives restarts and is re-loaded on the first tick.
    if (!restoreBreakState(bot)) {
        resetBreakState(bot);
    }
    // Reset hop state (in-memory only; persisted timers are restored separately).
    resetHopState(bot);
    // Restore the global hop timer from the hidden setting so reloads
    // don't reset the hop schedule. The timer is global (not per-account)
    // since account rotation means only one account is active at a time.
    loadHopState(bot);
    // Set a startup grace period before the first stageCredentials attempt.
    // On a fresh client launch, the native account profile system needs time
    // to initialize; calling stageCredentials() before it's ready returns
    // false indefinitely, causing an infinite retry loop. The grace period
    // only matters on the first attempt — once staging succeeds, the native
    // system is ready and subsequent retries use the normal 2s throttle.
    bot.loginStartupGraceUntil = Date.now() + 3_000;
    // Load the rotation index from the hidden setting (for multi-character
    // rotation). -1 = not yet loaded; loadRotationIndex returns 0 if unset.
    bot.rotationIndex = loadRotationIndex(bot);
    // If the player is already in-world, load the session profile immediately.
    if (getLocalPlayer()?.name) {
        initSessionProfile(bot);
    }
};
