// ============================================================================
// Humanised delay — single function for injecting anti-ban delays between actions
// ============================================================================
// createDelay(base, triggerChance) returns a tick count to wait before the
// next action. Most of the time it returns the base; when the trigger chance
// fires, it layers in per-account humanisation (jitter, hesitation, outliers,
// jitter amplification) inspired by the mixology bot's anti-ban system.
//
// Usage:
//   setDelayProfileForAccount('accountName');  // once at startup
//   const ticks = createDelay(1, 50);          // 1 tick base, 50% humanise
//
// The profile is deterministic from the account name (same djb2/mulberry32
// pattern as typing-profile.ts), so the same account always gets the same
// behavioural skew.
// ============================================================================

// --- Profile ---------------------------------------------------------------
export interface DelayProfile {
    /** -1 (fast) to +1 (slow). Shifts sampled delays toward min or max. */
    reactionBias: number;
    /** 0-2 ticks of ±noise added to every humanised delay. */
    jitterTicks: number;
    /** 1.5-3.0x. Multiplier applied when hesitation fires (via triggerChance). */
    hesitationMultiplier: number;
    /** 3-8% chance of a delay outlier (long-tail stretch). */
    outlierChance: number;
    /** 1.3-1.8x first-level outlier stretch. */
    outlierMultiplier: number;
    /** 15-25% chance (within an outlier) of a nested further stretch. */
    outlierNestedChance: number;
    /** 1.3-1.5x nested outlier stretch. */
    outlierNestedMultiplier: number;
    /** 0.5-2% chance of a spontaneous longer pause ("looked away"). */
    jitterAmplifyChance: number;
    /** 5-15 ticks minimum for the amplify pause. */
    jitterAmplifyMinTicks: number;
    /** 15-30 ticks maximum for the amplify pause. */
    jitterAmplifyMaxTicks: number;
}

// --- Deterministic PRNG (same pattern as typing-profile.ts) ----------------
const hashString = (str: string): number => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h) >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), t | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
};

const sampleInt = (rng: () => number, min: number, max: number): number =>
    Math.floor(rng() * (max - min + 1)) + min;

const sampleFloat = (rng: () => number, min: number, max: number): number =>
    rng() * (max - min) + min;

// --- Profile generation ----------------------------------------------------
// Ranges inspired by the mixology bot's humanisation layers.
const REACTION_BIAS_MIN = -1;
const REACTION_BIAS_MAX = 1;
const JITTER_TICKS_MIN = 1;
const JITTER_TICKS_MAX = 2;
const HESITATION_MULT_MIN = 1.5;
const HESITATION_MULT_MAX = 3.0;
const OUTLIER_CHANCE_MIN = 0.03;
const OUTLIER_CHANCE_MAX = 0.08;
const OUTLIER_MULT_MIN = 1.3;
const OUTLIER_MULT_MAX = 1.8;
const OUTLIER_NESTED_CHANCE_MIN = 0.15;
const OUTLIER_NESTED_CHANCE_MAX = 0.25;
const OUTLIER_NESTED_MULT_MIN = 1.3;
const OUTLIER_NESTED_MULT_MAX = 1.5;
const AMPLIFY_CHANCE_MIN = 0.005;
const AMPLIFY_CHANCE_MAX = 0.02;
const AMPLIFY_MIN_TICKS_MIN = 5;
const AMPLIFY_MIN_TICKS_MAX = 15;
const AMPLIFY_MAX_TICKS_MIN = 15;
const AMPLIFY_MAX_TICKS_MAX = 30;

export const generateDelayProfile = (accountName: string): DelayProfile => {
    const rng = mulberry32(hashString(accountName));
    return {
        reactionBias: sampleFloat(rng, REACTION_BIAS_MIN, REACTION_BIAS_MAX),
        jitterTicks: sampleInt(rng, JITTER_TICKS_MIN, JITTER_TICKS_MAX),
        hesitationMultiplier: sampleFloat(rng, HESITATION_MULT_MIN, HESITATION_MULT_MAX),
        outlierChance: sampleFloat(rng, OUTLIER_CHANCE_MIN, OUTLIER_CHANCE_MAX),
        outlierMultiplier: sampleFloat(rng, OUTLIER_MULT_MIN, OUTLIER_MULT_MAX),
        outlierNestedChance: sampleFloat(rng, OUTLIER_NESTED_CHANCE_MIN, OUTLIER_NESTED_CHANCE_MAX),
        outlierNestedMultiplier: sampleFloat(rng, OUTLIER_NESTED_MULT_MIN, OUTLIER_NESTED_MULT_MAX),
        jitterAmplifyChance: sampleFloat(rng, AMPLIFY_CHANCE_MIN, AMPLIFY_CHANCE_MAX),
        jitterAmplifyMinTicks: sampleInt(rng, AMPLIFY_MIN_TICKS_MIN, AMPLIFY_MIN_TICKS_MAX),
        jitterAmplifyMaxTicks: sampleInt(rng, AMPLIFY_MAX_TICKS_MIN, AMPLIFY_MAX_TICKS_MAX),
    };
};

// --- Active profile (module-level, same pattern as typing.ts) --------------
let activeProfile: DelayProfile | null = null;

// A runtime PRNG for delay sampling. Seeded fresh each call from Math.random
// so consecutive delays are independent (unlike the profile which is stable).
const roll = (): number => Math.random();

export const setDelayProfile = (profile: DelayProfile): void => {
    activeProfile = profile;
};

export const setDelayProfileForAccount = (accountName: string): DelayProfile => {
    const profile = generateDelayProfile(accountName);
    activeProfile = profile;
    return profile;
};

export const getActiveDelayProfile = (): DelayProfile | null => activeProfile;

// --- createDelay() ---------------------------------------------------------
// base:        guaranteed minimum delay in ticks (clamped to >= 1).
// triggerChance: 0-100, % chance that hesitation/outlier/amplify layers fire.
// max:          optional ceiling — clips the final delay after all layers
//               EXCEPT the rare distraction event (which bypasses max).
//
// Structure:
//   ALWAYS applies (independent of triggerChance):
//     1. Reaction bias — ±2 ticks based on account speed profile
//     2. Jitter — ±0-2 ticks of noise on every call
//   ONLY when triggerChance fires:
//     3. Hesitation — 1.5-3x multiplier ("paused to think")
//     4. Outlier — 3-8% chance of 1.3-1.8x (nested 1.3-1.5x)
//     5. Amplify — 0.5-2% chance of +5-30 ticks ("looked away")
//   RARE (independent of everything, bypasses max):
//     6. Distraction — 0.1% chance of +20-60 ticks (12-36s "tabbed out")
//        Fires roughly once per ~1000 delay calls (~once per hour of active
//        play). This breaks any hard ceiling pattern that would otherwise
//        make the delay distribution look artificial over long sessions.
//
// This ensures every step has micro-variance (never identical consecutive
// delays) while the heavier "human paused" effects fire at the trigger rate.
// Use max to cap mechanical steps so triggered delays don't exceed 3-6 ticks.
export const createDelay = (base: number, triggerChance: number, max?: number): number => {
    // Clamp base to minimum 1 — never return 0 or negative.
    const b = Math.max(1, Math.floor(base));

    // If no profile is loaded, use a lightweight default profile so the
    // function still works (e.g. during development without a player name).
    const p = activeProfile ?? defaultProfile;

    let delay = b;

    // --- ALWAYS: micro-variance layers (independent of triggerChance) ---

    // 1. Reaction bias — shift the base up or down based on the account's
    //    inherent speed. A bias of +0.8 moves ~80% toward a +2 tick extension;
    //    -0.8 keeps it near the base. Never goes below 1.
    const biasShift = Math.round(p.reactionBias * 2); // -2 to +2 ticks
    delay = Math.max(1, delay + biasShift);

    // 2. Jitter — small ±noise to prevent identical consecutive delays.
    //    Always applies so every step has micro-variance.
    if (p.jitterTicks > 0) {
        const jitter = sampleInt(roll2rng, -p.jitterTicks, p.jitterTicks);
        delay = Math.max(1, delay + jitter);
    }

    // --- TRIGGERED: heavier humanisation layers (only if triggerChance fires) ---

    if (roll() * 100 <= triggerChance) {
        // 3. Hesitation — stretch the delay by the profile's hesitation multiplier.
        //    This is the main "human paused to think" effect.
        delay = Math.max(1, Math.round(delay * p.hesitationMultiplier));

        // 4. Delay outlier — long-tail stretch (inspired by applyDelayOutlier).
        //    3-8% chance of multiplying by 1.3-1.8x, with a nested 15-25% chance
        //    of a further 1.3-1.5x (total up to ~2.7x).
        if (roll() < p.outlierChance) {
            delay = Math.round(delay * p.outlierMultiplier);
            if (roll() < p.outlierNestedChance) {
                delay = Math.round(delay * p.outlierNestedMultiplier);
            }
        }

        // 5. Jitter amplification — spontaneous longer pause (inspired by
        //    getJitterAmplification). 0.5-2% chance of adding 5-30 extra ticks,
        //    simulating "looked away from the screen for a moment."
        if (roll() < p.jitterAmplifyChance) {
            const amplify = sampleInt(roll2rng, p.jitterAmplifyMinTicks, p.jitterAmplifyMaxTicks);
            delay += amplify;
        }
    }

    // --- RARE: distraction event (bypasses max) ---
    // 0.1% chance per call of a 20-60 tick (12-36s) pause, simulating
    // "tabbed out to check something." This fires independently of
    // triggerChance and is NOT clipped by max, ensuring the delay
    // distribution has an unbounded long tail that no hard ceiling
    // could produce. Over ~1000 calls (roughly an hour of active play),
    // this fires ~1 time.
    let distracted = false;
    if (roll() < 0.001) {
        const distraction = sampleInt(roll2rng, 20, 60);
        delay += distraction;
        distracted = true;
    }

    // Final clamp — never below 1, and clip to max if provided.
    // The distraction event bypasses the max cap so the long tail
    // is preserved even on mechanical steps with low max values.
    const result = Math.max(1, delay);
    if (distracted) return result;
    return (max !== undefined && max > 0) ? Math.min(result, max) : result;
};

// Helper: wrap Math.random in the sampleInt signature (sampleInt expects an
// rng function). We reuse Math.random directly for independence between calls.
const roll2rng = Math.random;

// Default profile used when no account profile is set (e.g. development).
const defaultProfile: DelayProfile = {
    reactionBias: 0,
    jitterTicks: 1,
    hesitationMultiplier: 2.0,
    outlierChance: 0.05,
    outlierMultiplier: 1.5,
    outlierNestedChance: 0.20,
    outlierNestedMultiplier: 1.5,
    jitterAmplifyChance: 0.01,
    jitterAmplifyMinTicks: 10,
    jitterAmplifyMaxTicks: 20,
};
