import { GE_CLERK_IDS, GE_ZONE_CENTER, GE_ZONE_RADIUS, GE_WALK_POINT } from './constants.js';

// findClerk()
// Find the nearest GE clerk NPC. Returns null if none are nearby.
export const findClerk = (): titan.Npc | null =>
    titan.queries.npcs().ids(...GE_CLERK_IDS).nearest();

// openGe()
// Talk to the nearest GE clerk to open the exchange interface.
// Returns true if the interact was accepted.
export const openGe = (): boolean => {
    const clerk = findClerk();
    if (!clerk) return false;
    return clerk.interact('Exchange');
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
