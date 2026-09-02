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
//
// --- Tick-driven state machine ---------------------------------------------
// The mistake sequence is driven by game ticks, NOT setTimeout. The Titan
// plugin runtime does not expose setTimeout/setTimeout, so any use of it
// crashes the plugin with ReferenceError. Instead, the sequence advances via
// tickMistakeSequence(), which is called from isTyping() in typing.ts every
// time the GE flow's waitForTyping step polls typing status (once per tick).
// tickMistakeSequence() uses titan.state.client.tick to advance exactly once
// per game tick, even if isTyping() is called multiple times within the same
// tick.
//
// Phases:
//   phase1_typing        — humanType is typing part1 + wrongChar.
//                         On completion → realise_gap (set tick counter).
//   realise_gap          — count down N ticks (the realisation delay).
//                         When counter hits 0 → press Backspace, enter
//                         post_backspace_gap (set 1-tick counter).
//   post_backspace_gap   — 1-tick pause after Backspace.
//                         When counter hits 0 → start phase2_typing.
//   phase2_typing        — humanType is typing part2.
//                         On completion → deactivate sequence.
//
// A tick-based safety watchdog (MAX_MISTAKE_DURATION_TICKS) force-clears the
// sequence if it hasn't completed within the safety window, so isTyping()
// can return false and the flow can recover via its normal re-attempt/fail
// path.
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

// --- Tick-driven state machine ---------------------------------------------
// The mistake sequence advances once per game tick via tickMistakeSequence(),
// called from isTyping() in typing.ts. This replaces the former setTimeout-
// based scheduling, which crashed because the Titan runtime does not expose
// setTimeout.

type MistakePhase = 'idle' | 'phase1_typing' | 'realise_gap' | 'post_backspace_gap' | 'phase2_typing';

interface MistakeState {
    phase: MistakePhase;
    /** Remaining ticks to count down for the current gap phase. */
    ticksRemaining: number;
    /** The part2 text to type after the backspace correction. */
    part2: string;
    /** Typing opts to pass through to humanType for part2. */
    opts?: { minDelayMs?: number; maxDelayMs?: number };
    /** onDone callback to fire when the full sequence completes. */
    onDone?: (completed: boolean) => void;
    /** Tick number when the sequence started (for the safety watchdog). */
    startTick: number;
    /** Last tick number that tickMistakeSequence() advanced on (dedup). */
    lastAdvanceTick: number;
}

let mistakeState: MistakeState | null = null;

// Safety watchdog: force-clear the sequence if it hasn't completed within
// this many ticks. 14 ticks ≈ 8.4s (was 8000ms in the setTimeout version).
const MAX_MISTAKE_DURATION_TICKS = 14;

// --- Cancel tracking -------------------------------------------------------
// Module-level flag set by cancelTypingMistakeSequence() so any pending
// phase callback bails out at its next check.
let mistakeCancelled = false;

const deactivateMistakeSequence = (): void => {
    mistakeState = null;
    setMistakeSequenceActive(false);
};

/**
 * Advance the tick-driven mistake state machine by one tick.
 * Called from isTyping() in typing.ts. Uses titan.state.client.tick to
 * advance exactly once per game tick (dedup via lastAdvanceTick).
 * Returns true if the sequence is still active after this call.
 */
export const tickMistakeSequence = (): boolean => {
    if (!mistakeState) return false;
    if (mistakeCancelled) {
        deactivateMistakeSequence();
        return false;
    }

    const currentTick = titan.state.client.tick;
    // Dedup: only advance once per game tick.
    if (mistakeState.lastAdvanceTick === currentTick) {
        return true; // still active, just already advanced this tick
    }
    mistakeState.lastAdvanceTick = currentTick;

    // Safety watchdog: force-clear if the sequence has run too long.
    const elapsedTicks = currentTick - mistakeState.startTick;
    if (elapsedTicks >= MAX_MISTAKE_DURATION_TICKS) {
        debugLog(`Typing mistake: safety watchdog fired after ${elapsedTicks}t — sequence stuck, force-clearing`);
        mistakeCancelled = true;
        const cb = mistakeState.onDone;
        deactivateMistakeSequence();
        if (cb) cb(false);
        return false;
    }

    // Advance gap phases (typing phases are driven by humanType's onDone,
    // not by tick counting).
    if (mistakeState.phase === 'realise_gap' || mistakeState.phase === 'post_backspace_gap') {
        mistakeState.ticksRemaining--;
        if (mistakeState.ticksRemaining <= 0) {
            if (mistakeState.phase === 'realise_gap') {
                // Phase 3: press Backspace to delete the wrong character.
                try {
                    titan.keyboard.sendKey(titan.keyboard.Key.Backspace);
                } catch (e) {
                    // If backspace fails, abort the sequence — the validation
                    // step will catch any wrong text and Escape out.
                    debugLog('Typing mistake: backspace failed, aborting sequence');
                    mistakeCancelled = true;
                    const cb = mistakeState.onDone;
                    deactivateMistakeSequence();
                    if (cb) cb(false);
                    return false;
                }
                debugLog('Typing mistake: backspace sent, resuming in 1t');
                // Phase 4: 1-tick gap after backspace before resuming typing.
                mistakeState.phase = 'post_backspace_gap';
                mistakeState.ticksRemaining = 1;
            } else {
                // post_backspace_gap finished — Phase 5: type part2.
                mistakeState.phase = 'phase2_typing';
                const part2 = mistakeState.part2;
                const opts = mistakeState.opts;
                const started = humanType(part2, opts, (completed2) => {
                    if (mistakeCancelled) {
                        deactivateMistakeSequence();
                        return;
                    }
                    const cb = mistakeState?.onDone;
                    deactivateMistakeSequence();
                    if (cb) cb(completed2);
                });
                if (!started) {
                    // humanType couldn't start — clear the flag and let the
                    // caller retry on the next tick.
                    debugLog('Typing mistake: humanType could not start part2, aborting');
                    mistakeCancelled = true;
                    const cb = mistakeState.onDone;
                    deactivateMistakeSequence();
                    if (cb) cb(false);
                    return false;
                }
            }
        }
    }

    return true;
};

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

    mistakeCancelled = false;
    mistakeState = {
        phase: 'phase1_typing',
        ticksRemaining: 0,
        part2,
        opts,
        onDone,
        startTick: titan.state.client.tick,
        lastAdvanceTick: -1,
    };

    const startPhase1 = (): boolean => {
        return humanType(phase1Text, opts, (completed1) => {
            if (!completed1 || mistakeCancelled) {
                // Part1 was cancelled (e.g. user closed the prompt) or the
                // sequence was cancelled externally. Abort.
                const cb = mistakeState?.onDone;
                deactivateMistakeSequence();
                if (cb) cb(false);
                return;
            }
            // Phase 2: humanised realisation delay before pressing backspace.
            // createDelay(2, 100, 3) → 1-3 ticks normally, 0.1% distraction
            // bypasses the cap (12-36s "tabbed out").
            const realiseTicks = createDelay(2, 100, 3);
            debugLog(`Typing mistake: realising in ${realiseTicks}t (${realiseTicks * TICK_MS}ms)`);
            if (mistakeState) {
                mistakeState.phase = 'realise_gap';
                mistakeState.ticksRemaining = realiseTicks;
            }
        });
    };

    const started = startPhase1();
    if (!started) {
        // humanType couldn't start the first phase — clear the flag so
        // isTyping() doesn't hang. The caller will retry on the next tick.
        deactivateMistakeSequence();
    }
    return started;
};

export const cancelTypingMistakeSequence = (): void => {
    mistakeCancelled = true;
    deactivateMistakeSequence();
};
