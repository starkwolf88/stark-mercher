import { GE_CLERK_IDS, GE_ZONE_CENTER, GE_ZONE_RADIUS, GE_WALK_POINT } from './constants.js';

// findClerk()
// Find the nearest GE clerk NPC. Returns null if none are nearby.
export const findClerk = (): titan.Npc | null =>
    titan.queries.npcs().ids(...GE_CLERK_IDS).nearest();

// findGeBooth()
// Find the nearest "Grand Exchange booth" tile object with the "Exchange"
// action. The GE booths are scenery objects (not NPCs) that open the GE
// interface when clicked. On some worlds the booths may be more accessible
// than the clerks.
// We search within a 20-tile radius, filter by name "Grand Exchange booth"
// (case-insensitive substring), and require the "Exchange" action.
export const findGeBooth = (): titan.TileObject | null =>
    titan.queries.objects(20).nameContains('Grand Exchange').hasAction('Exchange').nearest();

// findExchangePoint()
// Returns the nearest interactable GE access point — either a booth object
// or a clerk NPC. Prefers whichever is closer to the player.
// Returns { type, npc?, obj? } or null if neither is found.
export interface ExchangeAccessPoint {
    type: 'clerk' | 'booth';
    npc: titan.Npc | null;
    obj: titan.TileObject | null;
}

export const findExchangePoint = (): ExchangeAccessPoint | null => {
    const clerk = findClerk();
    const booth = findGeBooth();
    if (!clerk && !booth) return null;
    // If both are available, pick whichever is closer.
    if (clerk && booth) {
        const player = titan.state.client.localPlayer;
        if (player) {
            const clerkDist = Math.abs(clerk.worldX - player.worldX) + Math.abs(clerk.worldY - player.worldY);
            const boothDist = Math.abs(booth.tileX - player.worldX) + Math.abs(booth.tileY - player.worldY);
            if (boothDist < clerkDist) {
                return { type: 'booth', npc: null, obj: booth };
            }
        }
        return { type: 'clerk', npc: clerk, obj: null };
    }
    if (clerk) return { type: 'clerk', npc: clerk, obj: null };
    return { type: 'booth', npc: null, obj: booth };
};

// openGe()
// Talk to the nearest GE clerk or click the nearest GE booth to open the
// exchange interface. Returns true if the interact was accepted.
// Tries the booth first (closer/more reliable), then falls back to the clerk.
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
export const nearGrandExchange = (): boolean => {
    const player = titan.state.client.localPlayer;
    if (!player) return false;
    if (player.plane !== GE_ZONE_CENTER.plane) return false;
    const dx = Math.abs(player.worldX - GE_ZONE_CENTER.x);
    const dy = Math.abs(player.worldY - GE_ZONE_CENTER.y);
    return Math.max(dx, dy) <= GE_ZONE_RADIUS;
};

// walkToGe()
// Walk to the GE area. Returns true if the walk command was accepted.
export const walkToGe = (): boolean =>
    titan.state.walk.toWorld(GE_WALK_POINT.x, GE_WALK_POINT.y, GE_WALK_POINT.plane);
