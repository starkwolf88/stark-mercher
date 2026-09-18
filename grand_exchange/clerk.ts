import { GE_CLERK_IDS, GE_ZONE_CENTER, GE_ZONE_RADIUS, GE_STAND_TILES } from './constants.js';

// --- Entity query cache ----------------------------------------------------
// GE clerks (NPCs) and GE booths (scenery objects) are static — they never
// despawn, move, or change. The only event that invalidates them is a world
// hop or login/logout transition (the scene reloads). Caching the toArray()
// results eliminates per-call native handle creation from
// titan.queries.npcs().currentWorldView().ids(...).toArray() and
// titan.queries.objects(20).currentWorldView().nameContains(...).hasAction(...).toArray().
// .currentWorldView() scopes the query to the active WorldView — unscoped
// queries can span multiple loaded WorldViews with stale/ghost copies.
//
// SDK 105+ guarantees object handles are live cross-tick — a cached reference
// re-resolves its fields against the live tile once per tick, so the cached
// handles stay valid and track the current state automatically.
//
// Invalidated via invalidateEntityQueryCache() on: hop completion,
// onGameStateChanged (login/logout/hop), tick counter reset, and onDisable.
let cachedClerks: titan.Npc[] | null = null;
let cachedBooths: titan.TileObject[] | null = null;

/** Invalidates the cached GE clerk/booth entity arrays. Call on hop
 *  completion, onGameStateChanged (login/logout/hop), tick counter reset,
 *  and onDisable so the next findExchangePoint/findClerk/findGeBooth call
 *  re-queries the live scene. */
export const invalidateEntityQueryCache = (): void => {
    cachedClerks = null;
    cachedBooths = null;
};

/** Returns the cached GE clerk NPC array, populating it from a single
 *  titan.queries.npcs().currentWorldView().ids(...).toArray() call on
 *  first access. */
const getClerks = (): titan.Npc[] => {
    if (cachedClerks) return cachedClerks;
    cachedClerks = titan.queries.npcs().currentWorldView().ids(...GE_CLERK_IDS).toArray();
    return cachedClerks;
};

/** Returns the cached GE booth object array, populating it from a single
 *  titan.queries.objects(20).currentWorldView().nameContains(...).hasAction(...).toArray()
 *  call on first access. */
const getBooths = (): titan.TileObject[] => {
    if (cachedBooths) return cachedBooths;
    cachedBooths = titan.queries.objects(20).currentWorldView().nameContains('Grand Exchange').hasAction('Exchange').toArray();
    return cachedBooths;
};

// findClerk()
// Find the nearest GE clerk NPC. Returns null if none are nearby.
// Reads from the cached clerk array (re-queries only on hop/login/disable).
export const findClerk = (): titan.Npc | null => {
    const clerks = getClerks();
    if (clerks.length === 0) return null;
    const player = titan.state.client.localPlayer;
    if (!player) return clerks[0];
    let nearest: titan.Npc | null = null;
    let nearestDist = Infinity;
    for (const c of clerks) {
        const d = Math.abs(c.worldX - player.worldX) + Math.abs(c.worldY - player.worldY);
        if (d < nearestDist) { nearestDist = d; nearest = c; }
    }
    return nearest;
};

// findGeBooth()
// Find the nearest "Grand Exchange booth" tile object with the "Exchange"
// action. The GE booths are scenery objects (not NPCs) that open the GE
// interface when clicked. On some worlds the booths may be more accessible
// than the clerks.
// Reads from the cached booth array (re-queries only on hop/login/disable).
export const findGeBooth = (): titan.TileObject | null => {
    const booths = getBooths();
    if (booths.length === 0) return null;
    const player = titan.state.client.localPlayer;
    if (!player) return booths[0];
    let nearest: titan.TileObject | null = null;
    let nearestDist = Infinity;
    for (const b of booths) {
        const d = Math.abs(b.tileX - player.worldX) + Math.abs(b.tileY - player.worldY);
        if (d < nearestDist) { nearestDist = d; nearest = b; }
    }
    return nearest;
};

// findExchangePoint()
// Returns an interactable GE access point — either a booth object or a clerk
// NPC. 90% of the time picks the nearest; 10% of the time picks a random
// different one so the bot doesn't always interact with the same clerk/booth.
// Returns { type, npc?, obj? } or null if neither is found.
// Reads from the cached clerk/booth arrays (re-queries only on hop/login/disable).
export interface ExchangeAccessPoint {
    type: 'clerk' | 'booth';
    npc: titan.Npc | null;
    obj: titan.TileObject | null;
}

/** Chance of picking a random exchange point instead of the nearest. */
const RANDOM_EXCHANGE_POINT_CHANCE = 0.10;

export const findExchangePoint = (): ExchangeAccessPoint | null => {
    // Read from cached arrays — no per-call native queries.
    const clerks = getClerks();
    const booths = getBooths();
    if (clerks.length === 0 && booths.length === 0) return null;

    const player = titan.state.client.localPlayer;
    const dist = (x: number, y: number): number =>
        player ? Math.abs(x - player.worldX) + Math.abs(y - player.worldY) : Infinity;

    // 10% chance: pick a random clerk or booth (not necessarily the nearest).
    if (Math.random() < RANDOM_EXCHANGE_POINT_CHANCE) {
        const all: ExchangeAccessPoint[] = [
            ...clerks.map(n => ({ type: 'clerk' as const, npc: n, obj: null })),
            ...booths.map(o => ({ type: 'booth' as const, npc: null, obj: o })),
        ];
        if (all.length > 0) {
            return all[Math.floor(Math.random() * all.length)];
        }
    }

    // 90%: pick the nearest. Find closest clerk and closest booth separately.
    let nearestClerk: titan.Npc | null = null;
    let nearestClerkDist = Infinity;
    for (const c of clerks) {
        const d = dist(c.worldX, c.worldY);
        if (d < nearestClerkDist) { nearestClerkDist = d; nearestClerk = c; }
    }
    let nearestBooth: titan.TileObject | null = null;
    let nearestBoothDist = Infinity;
    for (const b of booths) {
        const d = dist(b.tileX, b.tileY);
        if (d < nearestBoothDist) { nearestBoothDist = d; nearestBooth = b; }
    }
    if (nearestClerk && nearestBooth) {
        return nearestBoothDist < nearestClerkDist
            ? { type: 'booth', npc: null, obj: nearestBooth }
            : { type: 'clerk', npc: nearestClerk, obj: null };
    }
    if (nearestClerk) return { type: 'clerk', npc: nearestClerk, obj: null };
    if (nearestBooth) return { type: 'booth', npc: null, obj: nearestBooth };
    return null;
};

// openGe()
// Talk to a GE clerk or click a GE booth to open the exchange interface.
// Uses findExchangePoint() which picks the nearest 90% of the time and a
// random different one 10% of the time. Returns true if the interact was
// accepted.
export const openGe = (): boolean => {
    const point = findExchangePoint();
    if (!point) return false;
    if (point.type === 'booth' && point.obj) {
        return point.obj.interact('Exchange');
    }
    if (point.type === 'clerk' && point.npc) {
        return point.npc.interact('Exchange');
    }
    return false;
};

// nearGrandExchange()
// Returns true if the local player is within GE_ZONE_RADIUS of the GE center.
// Cached (10-tick TTL) — titan.state.client.localPlayer creates a native
// Player handle on every read, and nearGrandExchange() is called every tick
// while the GE is not open (the common case during idle monitoring). The
// cache reduces handle creation by 10x. Invalidated on hop/login via
// invalidateNearGeCache().

let cachedNearGe: boolean | null = null;
let nearGeCacheBaseTick = -1;
const NEAR_GE_CACHE_TTL_TICKS = 10;

export const invalidateNearGeCache = (): void => {
    cachedNearGe = null;
    nearGeCacheBaseTick = -1;
};

export const nearGrandExchange = (): boolean => {
    const tick = titan.state.client.tick;
    if (nearGeCacheBaseTick < 0 || tick < nearGeCacheBaseTick || tick - nearGeCacheBaseTick >= NEAR_GE_CACHE_TTL_TICKS) {
        cachedNearGe = null;
        nearGeCacheBaseTick = tick;
    }
    if (cachedNearGe !== null) return cachedNearGe;
    const player = titan.state.client.localPlayer;
    if (!player) {
        cachedNearGe = false;
        return false;
    }
    if (player.plane !== GE_ZONE_CENTER.plane) {
        cachedNearGe = false;
        return false;
    }
    const dx = Math.abs(player.worldX - GE_ZONE_CENTER.x);
    const dy = Math.abs(player.worldY - GE_ZONE_CENTER.y);
    cachedNearGe = Math.max(dx, dy) <= GE_ZONE_RADIUS;
    return cachedNearGe;
};

// walkToGe()
// Walk to the GE area, picking a random stand tile from GE_STAND_TILES so
// the bot doesn't always stand on the same tile. Returns true if the walk
// command was accepted.
export const walkToGe = (): boolean => {
    const tile = GE_STAND_TILES[Math.floor(Math.random() * GE_STAND_TILES.length)];
    return titan.state.walk.toWorld(tile.x, tile.y, tile.plane);
};
