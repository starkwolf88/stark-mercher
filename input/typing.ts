// ============================================================================
// Humanlike typing
// ============================================================================
// Wraps titan.keyboard.typeString() with realistic per-character delays
// derived from a per-account typing profile.
//
// The SDK's typeString dispatches each character on a separate pump-thread
// drain cycle, spread across real time with randomization within the
// min/max range. By passing a NARROW range centered on the account's
// baseline keystroke speed (baseline ± jitter), each key lands close to
// the account's consistent typing speed with only small natural variance.
// ============================================================================

import { generateTypingProfile, getTypingRange, type TypingProfile } from './typing-profile.js';

// Active typing profile. Set via setTypingProfile() when the account is
// known, or generated on first use from the account name.
let activeProfile: TypingProfile | null = null;

// setTypingProfile()
// Set the active typing profile directly (e.g., loaded from persistence).
export const setTypingProfile = (profile: TypingProfile): void => {
    activeProfile = profile;
};

// setTypingProfileForAccount()
// Generate and set the active typing profile from an account name.
// The same name always produces the same baseline and jitter.
export const setTypingProfileForAccount = (accountName: string): TypingProfile => {
    const profile = generateTypingProfile(accountName);
    activeProfile = profile;
    return profile;
};

// getActiveTypingProfile()
// Returns the active typing profile, or null if none is set.
export const getActiveTypingProfile = (): TypingProfile | null => activeProfile;

// humanType()
// Type a string with humanlike per-character delays from the active
// typing profile. If no profile is set, falls back to a default range.
// Returns true if the typing operation was started.
// onDone fires with true when all characters were typed, false if cancelled.
export const humanType = (
    text: string,
    opts?: { minDelayMs?: number; maxDelayMs?: number },
    onDone?: (completed: boolean) => void,
): boolean => {
    let minDelay: number;
    let maxDelay: number;
    if (opts && opts.minDelayMs !== undefined && opts.maxDelayMs !== undefined) {
        // Explicit override — use it directly.
        minDelay = opts.minDelayMs;
        maxDelay = opts.maxDelayMs;
    } else if (activeProfile) {
        // Use the narrow range from the per-account profile.
        const range = getTypingRange(activeProfile);
        minDelay = range.minDelayMs;
        maxDelay = range.maxDelayMs;
    } else {
        // Fallback: no profile set. Use a conservative average range.
        minDelay = 110;
        maxDelay = 170;
    }
    return titan.keyboard.typeString(
        text,
        { minDelayMs: minDelay, maxDelayMs: maxDelay },
        onDone,
    );
};

// isTyping()
// Returns true while a humanType operation is in progress.
export const isTyping = (): boolean => titan.keyboard.isTyping();

// cancelTyping()
// Cancel any in-progress humanType operation. The onDone callback fires
// with false.
export const cancelTyping = (): void => titan.keyboard.cancelTypeString();
