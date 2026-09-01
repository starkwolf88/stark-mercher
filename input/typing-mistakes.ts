// ============================================================================
// Typing mistakes — occasional wrong-key + backspace correction
// ============================================================================
// Real players occasionally mistype while entering item names, quantities, or
// prices in the GE interface, then pause briefly to realise the mistake and
// press backspace to correct it before continuing. This module wraps
// humanType() with a small per-type chance of inserting a wrong character,
// waiting a humanised realisation delay, deleting it, and resuming.
//
// Mistake chances are deterministic per account (same djb2/mulberry32 pattern
// as typing-profile.ts), sampled once per account name into a TypingMistakeProfile:
//   - nameMistakeChance:     0.3-1.0% per item-name typing call
//   - quantityMistakeChance: 0.3-1.0% per quantity typing call
//   - priceMistakeChance:    0.3-1.0% per price typing call
//
// A full buy offer flow (name + quantity + price) therefore has roughly a
// 0.9-3.0% chance of at least one visible mistake. The mistake is always
// corrected before the flow's validation step runs, so the final typed text
// is always correct.
//
// Realisation delay uses createDelay(2, 100, 3) from humanised-delay.ts so it
// integrates with the existing per-account humanisation (reaction bias, jitter,
// rare distraction). This yields 1-3 ticks (0.6-1.8s) normally, with the 0.1%
// distraction event bypassing the cap (12-36s "tabbed out while correcting").
// ============================================================================

import { humanType, setMistakeSequenceActive } from './typing.js';
import { createDelay } from '../antiban/humanised-delay.js';

export type TypingKind = 'name' | 'quantity' | 'price';

export interface TypingMistakeProfile {
    /** 0.3-1.0% chance of a mistake while typing an item name. */
    nameMistakeChance: number;
    /** 0.3-1.0% chance of a mistake while typing a quantity. */
    quantityMistakeChance: number;
    /** 0.3-1.0% chance of a mistake while typing a price. */
    priceMistakeChance: number;
}

// --- Active profile (module-level) -----------------------------------------
let activeProfile: TypingMistakeProfile | null = null;

// --- Debug logging ---------------------------------------------------------
let debugLogFn: ((msg: string) => void) | null = null;

/** Set a debug log callback. When set, mistake events are logged. */
export const setTypingMistakeDebugLog = (fn: ((msg: string) => void) | null): void => {
    debugLogFn = fn;
};

const debugLog = (msg: string): void => {
    if (debugLogFn) debugLogFn(msg);
};

// --- PRNG helpers (deterministic per account) ------------------------------
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

const sampleChance = (rng: () => number, minPct: number, maxPct: number): number =>
    rng() * (maxPct - minPct) + minPct;

// --- Profile generation ----------------------------------------------------

// Each mistake type gets an independent chance in 0.3-1.0%.
// Using a different seed offset per field so they aren't perfectly correlated.
const NAME_CHANCE_MIN = 0.3;
const NAME_CHANCE_MAX = 1.0;
const QTY_CHANCE_MIN = 0.3;
const QTY_CHANCE_MAX = 1.0;
const PRICE_CHANCE_MIN = 0.3;
const PRICE_CHANCE_MAX = 1.0;

export const generateTypingMistakeProfile = (accountName: string): TypingMistakeProfile => {
    const baseSeed = hashString(accountName + ':typing-mistakes');
    const nameRng = mulberry32(baseSeed ^ 0x9e3779b1);
    const qtyRng = mulberry32(baseSeed ^ 0x85ebca6b);
    const priceRng = mulberry32(baseSeed ^ 0xc2b2ae35);
    return {
        nameMistakeChance: sampleChance(nameRng, NAME_CHANCE_MIN, NAME_CHANCE_MAX),
        quantityMistakeChance: sampleChance(qtyRng, QTY_CHANCE_MIN, QTY_CHANCE_MAX),
        priceMistakeChance: sampleChance(priceRng, PRICE_CHANCE_MIN, PRICE_CHANCE_MAX),
    };
};

export const setTypingMistakeProfile = (profile: TypingMistakeProfile): void => {
    activeProfile = profile;
};

export const setTypingMistakeProfileForAccount = (accountName: string): TypingMistakeProfile => {
    const profile = generateTypingMistakeProfile(accountName);
    activeProfile = profile;
    return profile;
};

export const getActiveTypingMistakeProfile = (): TypingMistakeProfile | null => activeProfile;

// --- Wrong-character selection --------------------------------------------

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

const pickWrongChar = (kind: TypingKind): string => {
    if (kind === 'name') {
        return LETTERS[Math.floor(Math.random() * LETTERS.length)];
    }
    return DIGITS[Math.floor(Math.random() * DIGITS.length)];
};

// --- Mistake chance lookup -------------------------------------------------

const chanceForKind = (kind: TypingKind): number => {
    if (!activeProfile) return 0;
    if (kind === 'name') return activeProfile.nameMistakeChance;
    if (kind === 'quantity') return activeProfile.quantityMistakeChance;
    return activeProfile.priceMistakeChance;
};

// --- Tick → ms conversion --------------------------------------------------
// Game ticks are ~600ms. createDelay returns tick counts.
const TICK_MS = 600;

// --- typeStringWithMistake() ------------------------------------------------
// Wraps humanType() with an occasional wrong-character + backspace correction.
// Returns true if typing was started (either plain or with-mistake).
// onDone fires with true when the full text has been typed (and any mistake
// corrected), or false if cancelled.
export const typeStringWithMistake = (
    text: string,
    kind: TypingKind,
    opts?: { minDelayMs?: number; maxDelayMs?: number },
    onDone?: (completed: boolean) => void,
): boolean => {
    if (!text) {
        if (onDone) onDone(true);
        return true;
    }

    const chance = chanceForKind(kind);
    const rollMistake = Math.random() * 100;

    // No mistake — delegate directly to humanType.
    if (rollMistake >= chance) {
        return humanType(text, opts, onDone);
    }

    // Mistake fires. Pick a split point in [1, text.length-1] so we type at
    // least one correct character before the wrong one, and have at least one
    // character remaining after the wrong one to retype. This avoids the
    // degenerate cases of mistake-at-start (looks like a fresh typo) and
    // mistake-at-end (no recovery needed).
    const splitMin = 1;
    const splitMax = Math.max(1, text.length - 1);
    const split = Math.floor(Math.random() * (splitMax - splitMin + 1)) + splitMin;
    const part1 = text.slice(0, split);
    const part2 = text.slice(split);
    const wrongChar = pickWrongChar(kind);

    // Mark the mistake sequence as active so isTyping() returns true while
    // we're in the realisation/correction gap (between part1's completion and
    // part2's start). The flow's waitForTyping step polls isTyping() and must
    // not advance until the entire sequence is done.
    setMistakeSequenceActive(true);
    debugLog(`Typing mistake: typed '${wrongChar}' after '${part1}' (${kind}), correcting shortly`);

    // Phase 1: type part1 + wrongChar via humanType.
    const phase1Text = part1 + wrongChar;

    const startPhase1 = (): boolean => {
        return humanType(phase1Text, opts, (completed1) => {
            if (!completed1 || mistakeCancelled) {
                // Part1 was cancelled (e.g. user closed the prompt) or the
                // sequence was cancelled externally. Abort.
                setMistakeSequenceActive(false);
                if (onDone) onDone(false);
                return;
            }
            // Phase 2: humanised realisation delay before pressing backspace.
            // createDelay(2, 100, 3) → 1-3 ticks normally, 0.1% distraction
            // bypasses the cap (12-36s "tabbed out").
            const realiseTicks = createDelay(2, 100, 3);
            const realiseMs = realiseTicks * TICK_MS;
            debugLog(`Typing mistake: realising in ${realiseTicks}t (${realiseMs}ms)`);

            setTimeout(() => {
                if (mistakeCancelled) {
                    setMistakeSequenceActive(false);
                    if (onDone) onDone(false);
                    return;
                }
                // Phase 3: press Backspace to delete the wrong character.
                try {
                    titan.keyboard.sendKey(titan.keyboard.Key.Backspace);
                } catch (e) {
                    // If backspace fails, abort the sequence — the validation
                    // step will catch any wrong text and Escape out.
                    setMistakeSequenceActive(false);
                    if (onDone) onDone(false);
                    return;
                }
                debugLog('Typing mistake: backspace sent, resuming in 1t');

                // Phase 4: 1-tick gap after backspace before resuming typing.
                setTimeout(() => {
                    if (mistakeCancelled) {
                        setMistakeSequenceActive(false);
                        if (onDone) onDone(false);
                        return;
                    }
                    // Phase 5: type the remaining part2 via humanType.
                    const started = humanType(part2, opts, (completed2) => {
                        setMistakeSequenceActive(false);
                        if (onDone) onDone(completed2);
                    });
                    if (!started) {
                        // humanType couldn't start (e.g. another typing in
                        // progress). Clear the flag and let the caller retry.
                        setMistakeSequenceActive(false);
                        if (onDone) onDone(false);
                    }
                }, TICK_MS);
            }, realiseMs);
        });
    };

    mistakeCancelled = false;
    const started = startPhase1();
    if (!started) {
        // humanType couldn't start the first phase — clear the flag so
        // isTyping() doesn't hang. The caller will retry on the next tick.
        setMistakeSequenceActive(false);
    }
    return started;
};

// --- Cancel tracking -------------------------------------------------------
// Module-level flag set by cancelTypingMistakeSequence() so any pending
// setTimeout chain in an active mistake sequence bails out at the next check.
let mistakeCancelled = false;

export const cancelTypingMistakeSequence = (): void => {
    mistakeCancelled = true;
    setMistakeSequenceActive(false);
};
