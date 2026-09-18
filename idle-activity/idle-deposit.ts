// ============================================================================
// Idle Activity — Noted-item deposit helper
// ============================================================================
// When the user leaves manual ingredient buy offers on the GE, the collected
// items arrive in the inventory as NOTED variants — different item IDs from
// the unnoted versions the idle-activity banking code targets. The standard
// `bank.depositAllOfItem(UNNOTED_ID)` call only deposits the unnoted variant,
// so noted ingredients stay in the inventory, occupy slots, and cause
// "you don't have enough inventory space" / stuck conversion loops.
//
// This helper resolves each unnoted ingredient's noted counterpart via
// `titan.state.cache.item(unnotedId)` — checking `noteId` first (the canonical
// "ID of the noted version" field, set on unnoted items) and falling back to
// `linkedId` (the bidirectional note-pair link, set on noted items pointing
// back to the unnoted id). It then deposits BOTH variants. The itemDef lookup
// is cached in a module-level Map so the native call only happens once per
// ingredient on the first banking pass — never per-tick. `depositAllOfItem`
// is a no-op when the item isn't present, so the extra noted calls are safe.
// Stackable items and tools without note pairs return `noteId = -1` and
// `linkedId = -1` → no noted deposit attempted. The resolved id is verified
// to actually be a noted item (`def.noted === true`) before use, so a stale
// or unexpected field value can't cause a wrong-item deposit.
// ============================================================================

/** Cached unnoted → noted item ID resolution. Populated lazily on first use. */
const notedIdCache = new Map<number, number>();

/**
 * Resolve the noted variant item ID for an unnoted ingredient ID.
 * Returns -1 when the item has no note pair (e.g. stackable items, tools).
 * The lookup is cached so the native `itemDef` call only happens once per
 * ingredient per session. Candidate ids from `noteId` and `linkedId` are
 * verified by looking up the candidate's ItemDef and confirming
 * `noted === true` — this guards against stale/unexpected field values
 * causing a wrong-item deposit.
 */
export const resolveNotedId = (unnotedId: number): number => {
    const cached = notedIdCache.get(unnotedId);
    if (cached !== undefined) return cached;
    let notedId = -1;
    try {
        const def = titan.state.cache.item(unnotedId);
        if (def) {
            // `noteId` is the canonical "id of the noted version" field on
            // unnoted items. `linkedId` is the bidirectional note-pair link
            // (set on noted items pointing back to the unnoted id, and
            // sometimes on unnoted items pointing to the noted id). Try
            // both, preferring `noteId`, and verify the candidate is
            // actually a noted item before accepting it.
            const candidates: number[] = [];
            if (def.noteId > 0 && def.noteId !== unnotedId) {
                candidates.push(def.noteId);
            }
            if (def.linkedId > 0 && def.linkedId !== unnotedId) {
                candidates.push(def.linkedId);
            }
            for (const candidate of candidates) {
                try {
                    const candidateDef = titan.state.cache.item(candidate);
                    if (candidateDef && candidateDef.noted) {
                        notedId = candidate;
                        break;
                    }
                } catch {
                    // candidate lookup failed — try the next candidate.
                }
            }
        }
    } catch {
        // itemDef may return null for unknown ids — treat as no note pair.
        notedId = -1;
    }
    notedIdCache.set(unnotedId, notedId);
    return notedId;
};

/**
 * Deposit all of an ingredient (and its noted variant, if any) from the
 * inventory into the bank. Drop-in replacement for `bank.depositAllOfItem`:
 * - Unnoted variant is always deposited (no-op if absent).
 * - Noted variant is deposited only when a note pair exists and differs from
 *   the unnoted id (no-op if absent).
 *
 * Use this in every idle-activity banking/cleanup/depleted deposit site so
 * noted ingredients collected from manual GE offers are also removed.
 */
export const depositItemAndNoted = (
    bank: typeof titan.utils.bank,
    unnotedId: number,
): void => {
    bank.depositAllOfItem(unnotedId);
    const notedId = resolveNotedId(unnotedId);
    if (notedId > 0 && notedId !== unnotedId) {
        bank.depositAllOfItem(notedId);
    }
};

/**
 * Expand a set of unnoted ingredient IDs to also include each item's noted
 * variant. Items collected from manual GE offers arrive noted (different
 * item ID) — ID-based filters (e.g. the sell scan's excluded-sell set) must
 * cover both variants or noted ingredients would be listed for sale.
 * `resolveNotedId` caches its lookups, so this is cheap after the first call.
 */
export const expandWithNotedIds = (ids: ReadonlySet<number>): ReadonlySet<number> => {
    const expanded = new Set<number>(ids);
    for (const id of ids) {
        const notedId = resolveNotedId(id);
        if (notedId > 0 && notedId !== id) expanded.add(notedId);
    }
    return expanded;
};
