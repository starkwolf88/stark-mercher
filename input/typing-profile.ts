// ============================================================================
// Per-account typing profile
// ============================================================================
// Generates a deterministic typing profile from an account name so the same
// account always gets the same baseline keystroke speed. Uses the same
// djb2 hash + mulberry32 PRNG pattern as the mixology humanisation profile.
//
// Human typing model:
//   - Each person has a consistent baseline keystroke interval (fast ~90ms,
//     average ~140ms, slow ~200ms). This stays stable within a session.
//   - Small per-key jitter (±15-25ms) around the baseline from reaction
//     noise and finger travel distance.
//   - The SDK's typeString randomizes uniformly within [min, max] per char,
//     so we pass a NARROW range: [baseline - jitter, baseline + jitter].
//
// This produces consistent typing with small natural variance, not the
// wide random swings you'd get from a broad 80-250ms range.
// ============================================================================

export interface TypingProfile {
    /** Per-account baseline keystroke interval in ms. */
    baselineMs: number;
    /** Per-key jitter in ms (applied as ±jitter around baseline). */
    jitterMs: number;
}

// djb2-ish string hash — deterministic per account name.
const hashString = (str: string): number => {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h) >>> 0;
};

// Small, fast, seedable PRNG. Returns numbers in [0, 1).
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

// --- Sampling ranges -------------------------------------------------------
// Baseline: 90-180ms covers fast to slow typists.
// Jitter: 15-25ms is small natural per-key variance.
const BASELINE_MIN_MS = 90;
const BASELINE_MAX_MS = 180;
const JITTER_MIN_MS = 15;
const JITTER_MAX_MS = 25;

// generateTypingProfile()
// Generate a deterministic typing profile from an account name.
// The same name always produces the same baseline and jitter.
export const generateTypingProfile = (accountName: string): TypingProfile => {
    const seed = hashString(accountName);
    const rng = mulberry32(seed);
    return {
        baselineMs: sampleInt(rng, BASELINE_MIN_MS, BASELINE_MAX_MS),
        jitterMs: sampleInt(rng, JITTER_MIN_MS, JITTER_MAX_MS),
    };
};

// getTypingRange()
// Returns the narrow [min, max] delay range for a typing profile.
// This is what gets passed to the SDK's typeString.
export const getTypingRange = (profile: TypingProfile): { minDelayMs: number; maxDelayMs: number } => ({
    minDelayMs: profile.baselineMs - profile.jitterMs,
    maxDelayMs: profile.baselineMs + profile.jitterMs,
});
