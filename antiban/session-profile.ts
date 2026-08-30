// ============================================================================
// Session profile — per-account break/sleep timing profile
// ============================================================================
// Each account gets its own deterministic profile seeded from the player
// name, persisted in a hidden JSON setting. The profile controls:
//
//   - Nightly sleep duration (3.5–6.5h base, per-account)
//   - Nightly wake time (06:30–07:30 base, per-account)
//   - Wake variance, late-wake chance, weekend late-wake shift
//   - Short logout break duration (2–5 min base + 10%/1% long tail)
//
// The nightly sleep uses a WAKE-FIRST approach: the wake time is sampled
// first, then bedtime = wake − sleep duration. This naturally pushes short
// sleepers to later bedtimes (e.g. a 3.5h sleeper waking at 07:00 goes to
// bed at 03:30) without any special-casing.
//
// Profile generation is deterministic per account name — the same account
// always loads the same profile. The PRNG is seeded from a hash of the
// player name so it is stable across restarts.
// ============================================================================

import type { StarkMercher } from '../stark-mercher.js';

// --- Types ------------------------------------------------------------------

export interface SessionProfile {
    /** Nightly sleep base in minutes (210–390 = 3.5–6.5h). */
    nightlySleepLengthBase: number;
    /** Nightly sleep variance in minutes (15–90, positive-only). */
    nightlySleepLengthVariance: number;
    /** Nightly wake base in minutes from midnight (390–450 = 06:30–07:30). */
    nightlyWakeBase: number;
    /** Nightly wake variance in minutes (15–60, +/-). */
    nightlyWakeVariance: number;
    /** Chance (0–1) of waking later than usual on a given night. */
    nightlyWakeLateChance: number;
    /** Extra minutes added on a late-wake night (30–90). */
    nightlyWakeLateExtraMin: number;
    /** True for ~75% of profiles that wake later on Fri/Sat. */
    nightlyWeekendLate: boolean;
    /** Weekend wake shift in minutes (30–90, added on Fri/Sat for late profiles). */
    nightlyWeekendWakeShift: number;
    /** Short break base minimum in minutes (2). */
    shortBreakBaseMin: number;
    /** Short break base maximum in minutes (5). */
    shortBreakBaseMax: number;
    /** Per-profile variance in minutes added to the base (1). */
    shortBreakVarianceMin: number;
    /** Per-profile variance in minutes added to the base (1). */
    shortBreakVarianceMax: number;
    /** Chance (0–1) of an additional 1–5 min on top of the base (0.10). */
    longTailChance: number;
    /** Long tail additional minimum in minutes (1). */
    longTailMin: number;
    /** Long tail additional maximum in minutes (5). */
    longTailMax: number;
    /** Nested long-tail chance (0–1, applied on top of the first long tail). */
    longTailNestedChance: number;
}

// --- PRNG (deterministic per account name) ----------------------------------

/** Mulberry32 PRNG — fast, deterministic, good distribution. */
function mulberry32(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Hash a string into a 32-bit integer (FNV-1a variant). */
function hashString(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function sampleInt(rng: () => number, min: number, max: number): number {
    return Math.floor(rng() * (max - min + 1)) + min;
}

function sampleBool(rng: () => number, chance: number): boolean {
    return rng() < chance;
}

// --- Profile generation -----------------------------------------------------

export function generateSessionProfile(accountName: string): SessionProfile {
    const rng = mulberry32(hashString(accountName));

    return {
        // Nightly sleep: 3.5–6.5h base (210–390 min), 15–90 min variance
        nightlySleepLengthBase: sampleInt(rng, 210, 390),
        nightlySleepLengthVariance: sampleInt(rng, 15, 90),

        // Nightly wake: 06:30–07:30 base (390–450 min), 15–60 min variance
        nightlyWakeBase: sampleInt(rng, 390, 450),
        nightlyWakeVariance: sampleInt(rng, 15, 60),

        // 10% of nights, wake later by 30–90 min
        nightlyWakeLateChance: 0.10,
        nightlyWakeLateExtraMin: sampleInt(rng, 30, 90),

        // 75% of profiles wake later on Fri/Sat by 30–90 min
        nightlyWeekendLate: sampleBool(rng, 0.75),
        nightlyWeekendWakeShift: sampleInt(rng, 30, 90),

        // Short break: 2–5 min base, 1 min per-profile variance
        shortBreakBaseMin: 2,
        shortBreakBaseMax: 5,
        shortBreakVarianceMin: 1,
        shortBreakVarianceMax: 1,

        // 10% chance of +1–5 min, 1% chance of another +1–5 min
        longTailChance: 0.10,
        longTailMin: 1,
        longTailMax: 5,
        longTailNestedChance: 0.10,
    };
}

// --- Profile persistence ----------------------------------------------------

const PROFILE_KEY_PREFIX = 'sessionProfile:';

/**
 * Loads the session profile for a specific account from the hidden setting.
 * If no profile is saved, generates one from the account name, saves it,
 * and returns it.
 */
export function loadOrCreateSessionProfile(bot: StarkMercher, accountName: string): SessionProfile {
    const raw = bot.sessionProfileSetting.value;
    if (raw && raw !== '{}') {
        try {
            const all = JSON.parse(raw);
            if (all && typeof all === 'object') {
                const key = PROFILE_KEY_PREFIX + accountName;
                const saved = all[key];
                if (saved && typeof saved === 'object' && typeof saved.nightlySleepLengthBase === 'number') {
                    return saved as SessionProfile;
                }
            }
        } catch (e) {
            titan.logf('[Stark Mercher] Failed to parse session profiles: %s', String(e));
        }
    }
    // Generate and persist
    const profile = generateSessionProfile(accountName);
    saveSessionProfile(bot, accountName, profile);
    titan.logf('[Stark Mercher] Generated session profile for %s: sleep=%.1fh, wake=%s, weekendLate=%s',
        accountName,
        profile.nightlySleepLengthBase / 60,
        formatTime(profile.nightlyWakeBase),
        String(profile.nightlyWeekendLate));
    return profile;
}

/**
 * Saves the session profile for a specific account into the hidden setting.
 */
export function saveSessionProfile(bot: StarkMercher, accountName: string, profile: SessionProfile): void {
    try {
        let all: Record<string, unknown> = {};
        const raw = bot.sessionProfileSetting.value;
        if (raw && raw !== '{}') {
            try { all = JSON.parse(raw) ?? {}; } catch { all = {}; }
        }
        all[PROFILE_KEY_PREFIX + accountName] = profile;
        bot.sessionProfileSetting.value = JSON.stringify(all);
    } catch (e) {
        titan.logf('[Stark Mercher] Failed to save session profile: %s', String(e));
    }
}

// --- Helpers ----------------------------------------------------------------

/** Format minutes-since-midnight as HH:MM. */
export function formatTime(minutes: number): string {
    const m = Math.round(minutes) % 1440;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
