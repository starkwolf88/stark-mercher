/**
 * Titan Client Plugin SDK - TypeScript Definitions
 *
 * Write plugins in TypeScript, compile to JS with tsc or esbuild, and drop
 * the .js file into ~/.titanclient/plugins/ or plugins/ next to the client.
 *
 * # Three shapes of the SDK (SDK 41+)
 *
 *   `titan.queries.*`   membership snapshots of live handles; chainable filters; call-then-iterate.
 *                       Examples: `titan.queries.npcs().nameContains("...").first()`
 *                                 `titan.queries.inventory().id(995).totalQuantity`
 *
 *   `titan.state.*`     subsystem state and actions; no chaining.
 *                       Examples: `titan.state.client.tick`
 *                                 `titan.state.widgets.find(packedId)`
 *                                 `titan.state.world.hop(308)`
 *
 *   `titan.utils.*`     static composition helpers; no setup; just call.
 *                       Examples: `titan.utils.inventory.isFull`
 *                                 `titan.utils.equipment.unequip("Bow")`
 *                                 `titan.utils.dialogue.continueDialogue()`
 *
 * Top-level (`titan.x`) is reserved for free helpers (`log`, `logf`,
 * `addChatMessage`, `runOnClientTick`, `runOnRender`), registration
 * (`Plugin`, `register`, settings), and enums (`MenuAction`, `Skill`,
 * `Prayer`, `Varbits`, `InventoryID`, `EquipmentSlot`, ...).
 *
 * Write plugins by extending titan.Plugin:
 * ```ts
 * class MyPlugin extends titan.Plugin {
 *     id = "my_plugin";
 *     name = "My Plugin";
 *     range = this.intSetting({ key: "range", name: "Range",
 *                               default: 5, min: 1, max: 20 });
 *     world = this.overlay({ layer: titan.OverlayLayer.ABOVE_SCENE, render: () => {
 *         titan.queries.npcs().nameContains("Chicken").forEach(n => {
 *             titan.overlay.entityBox(n, 0xFF00FF00);
 *         });
 *     }});
 *     onGameTick(tick: number) {
 *         const local = titan.state.client.localPlayer;
 *         if (!local) return;
 *         const target = titan.queries.npcs().nameContains("Chicken").nearestTo(local);
 *         target?.interact("Attack");
 *     }
 * }
 * titan.register(new MyPlugin());
 * ```
 */

/// <reference path="./titan-gamevals.d.ts" />

declare namespace titan {

// ---------------------------------------------------------------------------
// Positional types
// ---------------------------------------------------------------------------

interface Tile {
    x: number;
    y: number;
    plane: number;
    /** Owning WorldView id. `-1` means the current WorldView sentinel. SDK 85+. */
    worldViewId?: number;
}
/** RuneLite-style world-space tile coordinate (x, y, plane = z). */
interface WorldPoint {
    x: number;
    y: number;
    z: number;
    /** Owning WorldView id. `0` is top-level, `-1` is current sentinel. SDK 85+. */
    worldViewId?: number;
    /**
     * True when this world tile is inside the scene the client currently has
     * loaded — i.e. when its objects, collision and clickable tiles can be
     * read at all. A tile outside it can be walked TOWARD but never
     * interacted with, so this is the guard to use before clicking a tile,
     * resolving an object, or reading collision.
     *
     * Present on every WorldPoint the SDK returns (it is a getter on their
     * shared prototype, so it never appears in `Object.keys` or
     * `JSON.stringify`). Plain object literals you build yourself carry no
     * derived properties — call `titan.worldPoint.isInScene(point)` for
     * those, which also takes an explicit scene base/size. SDK 117+.
     */
    readonly isInScene?: boolean;
}
/**
 * Sub-tile precision scene-local coordinate. Mirrors `titan::LocalPoint`
 * in [shared/titan/local_point.h](shared/titan/local_point.h). Stored
 * fields `x` / `y` are in 1/128-tile units (the game's internal scene
 * coord system); `sceneX` / `sceneY` are the tile-granularity
 * indices (`x >> 7` / `y >> 7`). Added in SDK 39.
 *
 * Locatable entity wrappers expose this as `localPoint`. JS plugins may
 * also construct one as a plain object literal.
 */
interface LocalPoint {
    /** Sub-tile units (0..sceneSizeX*128). */
    x: number;
    /** Sub-tile units (0..sceneSizeY*128). */
    y: number;
    /** Scene tile index (x >> 7). Optional; computed by callers. */
    sceneX?: number;
    /** Scene tile index (y >> 7). Optional; computed by callers. */
    sceneY?: number;
    /** Owning WorldView id. `-1` means the current WorldView sentinel. SDK 85+. */
    worldViewId?: number;
}
interface ScreenPoint {
    x: number;
    y: number;
}

/**
 * Immutable state of the visible native world map. `viewport*` coordinates
 * are physical screen pixels; `logicalViewport*` coordinates are the game's
 * widget-frame units before `interfaceScale*` and `canvasOrigin*` are applied.
 * The host returns no snapshot unless both viewports are coherent and the
 * generated analyzer field contract, renderer-validated scale, loaded map
 * area, and visible viewport are all available. SDK 113+.
 */
interface WorldMapSnapshot {
    readonly globalCenterX: number;
    readonly globalCenterY: number;
    /** Currently displayed, smoothly interpolated native zoom. */
    readonly currentZoom: number;
    readonly targetZoom: number;
    /** Validated logical widget pixels per world tile; equals currentZoom in v113. */
    readonly pixelsPerTile: number;
    /** Physical viewport used for overlay drawing and clipping. */
    readonly viewportX: number;
    readonly viewportY: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    /** Logical widget-frame viewport used by the native map projection. */
    readonly logicalViewportX: number;
    readonly logicalViewportY: number;
    readonly logicalViewportWidth: number;
    readonly logicalViewportHeight: number;
    readonly interfaceScaleX: number;
    readonly interfaceScaleY: number;
    readonly canvasOriginX: number;
    readonly canvasOriginY: number;
}

/** Read-only native world-map state and projection helpers. SDK 113+. */
interface WorldMapFacade {
    snapshot(): WorldMapSnapshot | null;
    /** Project a global world tile onto the current map viewport. */
    worldToScreen(point: WorldPoint): ScreenPoint | null;
    /** Convert a physical screen pixel into a canonical global plane-0 tile. */
    screenToWorld(point: ScreenPoint): WorldPoint | null;
    /** Convert logical world-map pixels to tiles. */
    pixelsToTiles(pixels: number): number | null;
    /** Convert tiles to logical world-map pixels before interface scaling. */
    tilesToPixels(tiles: number): number | null;
}

type InstanceTemplateChunks = number[][][] & { readonly instanced?: boolean };

/** Status returned by the immutable bulk collision snapshot APIs. SDK 112+. */
enum CollisionSnapshotStatus {
    Unavailable = 0,
    Ready = 1,
    MissingRegion = 2,
    BufferTooSmall = 3,
    InvalidRequest = 4,
}

/** Immutable four-plane 64x64 cached mapsquare collision snapshot. SDK 112+. */
interface CachedCollisionRegion {
    readonly status: CollisionSnapshotStatus;
    readonly regionId: number;
    readonly flagCount: number;
    readonly flags: Int32Array;
    readonly ready: boolean;
    /** Return the flag at [plane][regionX][regionY], or null when unavailable/out of bounds. */
    flag(plane: number, regionX: number, regionY: number): number | null;
}

/** Immutable live-scene collision and canonical instance mapping snapshot. SDK 112+. */
interface LiveCollisionScene {
    readonly status: CollisionSnapshotStatus;
    readonly baseX: number;
    readonly baseY: number;
    readonly width: number;
    readonly height: number;
    readonly worldViewId: number;
    readonly instanced: boolean;
    readonly flagCount: number;
    readonly templateChunks: InstanceTemplateChunks;
    readonly flags: Int32Array;
    readonly ready: boolean;
    /** Return the flag at [plane][sceneX][sceneY], or null when unavailable/out of bounds. */
    flag(plane: number, sceneX: number, sceneY: number): number | null;
}

/** Coordinate domain used to construct a web path. SDK 112+. */
enum WebPathRouteSpace {
    Global = 0,
    CurrentInstance = 1,
}

/** Current state of an asynchronous web-path request. SDK 112+. */
enum WebPathPhase {
    None = 0,
    Queued = 1,
    Running = 2,
    Complete = 3,
    Failed = 4,
    Cancelled = 5,
}

/** Terminal path-generation result. SDK 112+. */
enum WebPathResult {
    None = 0,
    Exact = 1,
    PartialWithinThreeTiles = 2,
    NoPath = 3,
    Timeout = 4,
    Cancelled = 5,
    InvalidRequest = 6,
    NotLoggedIn = 7,
    CollisionUnavailable = 8,
    ProviderUnavailable = 9,
    Busy = 10,
    InternalError = 11,
}

/** Typed edge kind in a generated route. SDK 112+. */
enum WebPathStepKind {
    Walk = 0,
    Transport = 1,
    Teleport = 2,
}

/** Raw option bits accepted by WebPathRequest.options. SDK 112+. */
const WebPathOption: {
    readonly Transports: number;
    readonly Teleports: number;
    readonly EquippedItemTeleports: number;
    readonly MinigameTeleports: number;
    readonly PohRoutes: number;
    readonly Charters: number;
    readonly AvoidWilderness: number;
    readonly Default: number;
};

/**
 * Web-path feature toggles. Omitted fields retain the documented defaults:
 * transports, normal/equipped teleports, POH routes and wilderness avoidance
 * are enabled; minigame teleports and charters are disabled.
 */
interface WebPathOptions {
    transports?: boolean;
    teleports?: boolean;
    equippedItemTeleports?: boolean;
    minigameTeleports?: boolean;
    pohRoutes?: boolean;
    charters?: boolean;
    avoidWilderness?: boolean;
}

/** Read-only asynchronous route-generation request. SDK 112+. */
interface WebPathRequest {
    /** Ignored when useLocalPlayer is true (the default). */
    start?: WorldPoint;
    destination: WorldPoint;
    routeSpace?: WebPathRouteSpace;
    /** Feature toggles, or an explicitly composed WebPathOption bit mask. */
    options?: WebPathOptions | number;
    /** Defaults to 60 seconds and is capped at 10 minutes. */
    timeoutMs?: number;
    /** Snapshot the current local-player point instead of start. Defaults to true. */
    useLocalPlayer?: boolean;
    /** Additional exact points that walking must not enter (maximum 4096). */
    forbiddenTiles?: readonly WorldPoint[];
}

interface WebPathSummary {
    /** Opaque uint64 id; always a bigint to avoid precision loss. */
    readonly requestId: bigint;
    readonly phase: WebPathPhase;
    readonly result: WebPathResult;
    /** Integer cost points; normal walking contributes 5 points per tile. */
    readonly totalCost: number;
    /** Number of retained steps; at most 16,384. */
    readonly stepCount: number;
    readonly exploredNodes: number;
    readonly elapsedMs: number;
    readonly start: WorldPoint;
    readonly requestedDestination: WorldPoint;
    readonly reachedDestination: WorldPoint;
    readonly message: string;
    readonly finished: boolean;
}

interface WebPathStep {
    /** Stable uint64 edge id; always a bigint to avoid precision loss. */
    readonly edgeId: bigint;
    readonly kind: WebPathStepKind;
    readonly subtype: number;
    readonly fromRouteSpace: WebPathRouteSpace;
    readonly toRouteSpace: WebPathRouteSpace;
    /** Integer edge cost points. */
    readonly edgeCost: number;
    /** Integer accumulated cost points. */
    readonly accumulatedCost: number;
    /** Exact instance-copy identity, or -1 for a global endpoint. */
    readonly fromInstanceCopyId: number;
    /** Exact instance-copy identity, or -1 for a global endpoint. */
    readonly toInstanceCopyId: number;
    readonly from: WorldPoint;
    readonly to: WorldPoint;
    readonly name: string;
}

interface WebWalkerFacade {
    /** Queue a route job, or return null when the request cannot be accepted. */
    submit(request: WebPathRequest): bigint | null;
    /** Poll a retained request, or return null for an unknown/unavailable handle. */
    poll(handle: bigint): WebPathSummary | null;
    /** Copy the currently retained typed route steps. */
    copySteps(handle: bigint): WebPathStep[] | null;
    cancel(handle: bigint): boolean;
    /** Release retained job state; handles must not be used after this succeeds. */
    release(handle: bigint): boolean;
    /**
     * UTF-8 JSON action payload for one step of a completed, retained route
     * (internal backend only), or null for unknown requests, out-of-range
     * indices, or hosts before SDK 114.
     */
    stepPayload(handle: bigint, stepIndex: number): string | null;
}

/** Lifecycle phase of a host-driven web-walk session. SDK 114+. */
enum WebWalkPhase {
    None = 0,
    Planning = 1,
    Walking = 2,
    Transiting = 3,
    Arrived = 4,
    Failed = 5,
    Cancelled = 6,
}

/**
 * Options for webWalk.walkTo. Omitted fields keep the defaults: run-energy
 * management on, stamina drinking off, host-driven (automatic) ticking,
 * exact-tile arrival, and no walk duration budget.
 */
interface WebWalkOptions {
    routeSpace?: WebPathRouteSpace;
    /** Route feature toggles, or an explicitly composed WebPathOption bit mask. */
    pathOptions?: WebPathOptions | number;
    /** Route-planning timeout. Defaults to 60 seconds and is capped at 10 minutes. */
    timeoutMs?: number;
    /** Toggle run and manage run energy during the walk. Defaults to true. */
    manageRun?: boolean;
    /** Drink a carried stamina potion below 50% energy. Defaults to false. */
    drinkStamina?: boolean;
    /**
     * Advance only via webWalk.advance() once per game tick instead of the
     * host's own game-tick pump. Defaults to false.
     */
    manualTick?: boolean;
    /** Chebyshev arrival tolerance around the destination; 0 = exact tile. */
    arriveRadius?: number;
    /** Hard budget for the whole walk in game ticks; 0 = unlimited. */
    maxDurationTicks?: number;
    /** Additional exact points that walking must not enter (maximum 4096). */
    forbiddenTiles?: readonly WorldPoint[];
}

/** Immutable status snapshot for a started web-walk session. SDK 114+. */
interface WebWalkStatus {
    /** Opaque uint64 walk id; always a bigint to avoid precision loss. */
    readonly walkId: bigint;
    readonly phase: WebWalkPhase;
    /** Planning failure detail when the underlying route request failed. */
    readonly pathResult: WebPathResult;
    readonly currentStepIndex: number;
    /** Number of retained steps; at most 16,384. */
    readonly stepCount: number;
    readonly ticksActive: number;
    readonly replanCount: number;
    /** Stable code of the follower's most recent decision, for overlays. */
    readonly lastDecision: number;
    readonly destination: WorldPoint;
    readonly currentStepName: string;
    readonly message: string;
    readonly finished: boolean;
}

/**
 * Host-driven web-walk executor over generated routes. Walking is
 * centralized: at most one walk is live per client, and a new start from any
 * plugin instantly cancels the walk in progress. status/cancel/advance may
 * omit the handle to target the current walk, so the common single-driver
 * plugin never touches handles; keeping the returned handle still lets a
 * plugin tell "my walk" apart from a superseding one (a superseded handle
 * polls as Cancelled until released). SDK 114+.
 */
interface WebWalkFacade {
    /** Start walking the local player, or return null when the walk cannot start. */
    walkTo(destination: WorldPoint | Tile, options?: WebWalkOptions): bigint | null;
    walkTo(x: number, y: number, plane: number, options?: WebWalkOptions): bigint | null;
    /**
     * Poll a walk session, or null for an unknown handle. Omitting the
     * handle reads the current walk: the most recently started session,
     * which stays readable through its terminal state until released or
     * evicted; null when no walk has been started.
     */
    status(handle?: bigint): WebWalkStatus | null;
    /** Cancel a walk; omitting the handle cancels the live walk. */
    cancel(handle?: bigint): boolean;
    /** Release retained session state; handles must not be used after this succeeds. */
    release(handle: bigint): boolean;
    /**
     * Advance a manualTick session by one follower tick (the live walk when
     * the handle is omitted). Call once per game tick from the owning
     * plugin's onGameTick. Returns false for unknown, terminal, or
     * auto-ticked sessions.
     */
    advance(handle?: bigint): boolean;
}

interface InstanceConvertible {
    fromLocalInstance(): WorldPoint | null;
    toLocalInstance(): WorldPoint | null;
}

interface MenuActionSpec {
    opcode: number;
    /** Menu-entry identifier: entity id or CC_OP sub-action index. */
    identifier: number;
    param0: number;
    param1: number;
    worldViewId?: number;
    /** Omit both coords to randomize the synthetic click on the active game screen. */
    clickX?: number;
    clickY?: number;
    actionText?: string;
    targetText?: string;
    /** Ignored by MenuOptionClicked.replaceWith(); used by invokeMenuAction(). */
    skipClick?: boolean;
    /** Optional target metadata for native clickbox resolution. */
    targetPlane?: number;
    targetSizeX?: number;
    targetSizeY?: number;
    targetLayer?: number;
    targetEntityPtr?: number | bigint;
    targetPackedId?: number | bigint;
}

/** Magic spell metadata descriptor. Added in SDK 49. */
interface MagicSpellInfo {
    readonly name: string;
    readonly level: number;
    readonly widget: number;
    readonly book: 0 | 1 | 2 | 3;
    readonly members: boolean;
    readonly menuEntryId: number;
}
type MagicSpell = MagicSpellInfo;
interface MagicWidgetTarget {
    readonly packedId: number;
    readonly childIndex?: number;
    /** Retained for parity; Titan synthetic spell-target entries currently ignore it. */
    readonly itemId?: number;
}
type MagicTarget = Item | Npc | Player | GroundItem | TileObject | titan.WidgetState | MagicWidgetTarget;


// ---------------------------------------------------------------------------
// Entity wrappers — fluent methods on live game entities.
// ---------------------------------------------------------------------------

interface ActorSpotAnim {
    readonly slot: number;
    readonly id: number;
    readonly height: number;
    readonly expireCycle: number;
}

type PlayerCompositionStatus =
    | "Unavailable"
    | "Available"
    | "MissingOffsets"
    | "NullPlayer"
    | "NullModel"
    | "NpcTransform"
    | "BadVector"
    | "Unknown";

type PlayerCompositionSlotKind =
    | "Empty"
    | "Item"
    | "NonItem"
    | "UnknownRaw"
    | "Unknown";

interface PlayerCompositionSlot {
    readonly slotIndex: number;
    readonly rawValue: number;
    /** Normalized item id, or -1 when empty/non-item/unknown. */
    readonly itemId: number;
    readonly kind: number;
    readonly kindName: PlayerCompositionSlotKind;
}

interface PlayerComposition {
    readonly status: number;
    readonly statusName: PlayerCompositionStatus;
    readonly available: boolean;
    /** Item raw-value base used for normalization, or -1 when absent. */
    readonly itemIdBase: number;
    /** NPC transform id, or -1 when not transformed/unknown. */
    readonly npcTransformId: number;
    readonly slotCount: number;
    readonly slots: PlayerCompositionSlot[];
    /** Find a slot by `titan.EquipmentSlot` ordinal; returns null when absent. */
    getSlot(slot: number): PlayerCompositionSlot | null;
}

interface ActorBase extends InstanceConvertible {
    readonly hashIndex: number;
    readonly tileX: number;
    readonly tileY: number;
    readonly plane: number;
    readonly worldX: number;
    readonly worldY: number;
    readonly preciseX: number;
    readonly preciseY: number;
    readonly orientation: number;
    readonly animation: number;
    /** Current movement pose id. Offset bundles still call this MovementState. SDK 73+. */
    readonly movementPose: number;
    /** Idle/rest pose id. Offset bundles still call this IdleState. SDK 73+. */
    readonly idlePose: number;
    readonly interactingIndex: number;
    readonly interactingType: number;
    /** Interaction lifecycle phase (0 = active, non-zero = stale, 0xFF = unavailable). SDK v44+. */
    readonly interactingPhase: number;
    readonly entityPtr: number;
    /** Owning WorldView id. `0` is top-level; non-zero ids identify sub WorldViews. SDK 85+. */
    readonly worldViewId: number;
    /** Raw native WorldView pointer for diagnostics. SDK 85+. */
    readonly worldViewPtr: bigint;

    /** Logical/server tile. For actors this is PathQueue[0] when available. */
    readonly tile: Tile;
    /** Logical/server world point. For actors this is PathQueue[0] plus scene base when available. */
    readonly worldPoint: WorldPoint;
    /** Render/interpolated local point from PreciseX/Y. */
    readonly localPoint: LocalPoint;
    /** Valid actor path queue entries as world points in this actor's WorldView. Index 0 is the logical/server tile. SDK 59+. */
    readonly pathQueue: WorldPoint[];
    /** Active actor-attached spot animations. Empty when unavailable or none are active. SDK 76+. */
    readonly currentSpotAnims: ActorSpotAnim[];

    readonly isPlayer: boolean;
    readonly isNpc: boolean;
    /** False when a retained live actor handle is not currently present. SDK v88+. */
    readonly exists: boolean;
    /** No pending movement (`movementPose === idlePose`). A stationary actor can still be animating. SDK 73+. */
    readonly isStationary: boolean;

    /** Cast to Player, or null if not a player. */
    toPlayer(): Player | null;
    /** Cast to Npc, or null if not an NPC. */
    toNpc(): Npc | null;

    /** Chebyshev tile distance. */
    distanceTo(other: Tile | ActorBase): number;

    /** RuneLite-style line of sight from this actor's footprint to another locatable or world point. SDK 52+. */
    hasLineOfSight(other: LineOfSightTarget): boolean;
    /** True when this actor's footprint is exactly one orthogonal tile from another footprint/point. SDK 86+. */
    isInMeleeDistance(other: SpatialTarget): boolean;

    /** True when this actor is actively interacting with a target. SDK 54+. */
    isInteracting(): boolean;

    /** Resolve the entity this actor is interacting with, or null. */
    interacting(): Actor | null;
    /** Return a detached plain-object copy of the handle's current fields. SDK v88+. */
    snapshot(): Record<string, unknown>;
    /** Cast `spell` on this actor. */
    castOn(spell: MagicSpell): boolean;
}

interface Player extends ActorBase {
    readonly combatLevel: number;
    readonly isHidden: boolean;
    /** `animation !== -1`. */
    readonly isAnimating: boolean;
    /** Fully idle: `isStationary && !isAnimating`. */
    readonly isIdle: boolean;
    readonly name: string;
    /** Primary overhead icon index, or `-1` when none. SDK 35+. */
    readonly overheadIcon: number;
    /** Skull icon ordinal, or `-1` when not skulled. SDK 35+. */
    readonly skullIcon: number;
    /** True when currently displaying any overhead icon. SDK 35+. */
    isOverheadActive(icon?: number): boolean;
    /** True when `skullIcon >= 0`. SDK 35+. */
    isSkulled(): boolean;
    /** Current headbar fill [0, healthScale], or -1 when no bar. SDK 48+. */
    readonly healthRatio: number;
    /** Max bar width, or -1 when no bar. SDK 48+. */
    readonly healthScale: number;
    /** True when any health bar is active. SDK 48+. */
    readonly hasHealthBar: boolean;
    /** Health as percent [0, 1] or -1 when no bar. SDK 48+. */
    healthPercent(): number;
    /** True when health bar is active and ratio is 0. SDK 48+. */
    isDead(): boolean;
    /** Worn appearance equipment slots read from PlayerModel. SDK 92+. */
    getPlayerComposition(): PlayerComposition;
}

interface Npc extends ActorBase {
    readonly id: number;
    readonly overrideTransform: number;
    readonly sizeX: number;
    readonly sizeY: number;
    /** `animation !== -1`. */
    readonly isAnimating: boolean;
    readonly name: string;
    readonly actions: string[];
    /** Primary overhead icon index for this NPC, or `-1` when none. SDK 35+. */
    readonly overheadIcon: number;
    /** True when a per-instance runtime override is currently set. SDK 35+. */
    readonly hasHeadIconOverride: boolean;

    /** Footprint area anchored at this NPC's south-west world point. */
    toWorldArea(): titan.WorldArea;
    hasAction(action: string): boolean;
    /** Dispatch a named action via this NPC's hash index; returns false when actions does not contain it. */
    interact(action: string): boolean;
    /** True when this NPC is currently displaying any overhead icon. SDK 35+. */
    isOverheadActive(icon?: number): boolean;
    /** Current headbar fill [0, healthScale], or -1 when no bar. SDK 48+. */
    readonly healthRatio: number;
    /** Max bar width, or -1 when no bar. SDK 48+. */
    readonly healthScale: number;
    /** True when any health bar is active. SDK 48+. */
    readonly hasHealthBar: boolean;
    /** Health as percent [0, 1] or -1 when no bar. SDK 48+. */
    healthPercent(): number;
    /** True when health bar is active and ratio is 0. SDK 48+. */
    isDead(): boolean;
}

type Actor = Player | Npc;

/**
 * A scene object (loc). SDK 105+: object handles are live cross-tick -- a
 * cached reference re-resolves its fields against the live tile once per tick
 * (matched on layer + id), so name/actions/worldPoint/animation/entityPtr/...
 * reflect the current state rather than capture-time values. Repeated queries
 * return the same handle for a given slot (identity dedup). Use exists to test
 * whether the loc is still present and snapshot() to freeze a capture-time
 * copy. (The Java SDK has always behaved this way.)
 */
interface TileObject extends InstanceConvertible {
    readonly tileX: number;
    readonly tileY: number;
    readonly plane: number;
    readonly worldViewId: number;
    readonly worldViewPtr: bigint;
    readonly id: number;
    /** Raw Loc* scene pointer, or 0n when the host didn't populate it. */
    readonly entityPtr: bigint;
    readonly sizeX: number;
    readonly sizeY: number;
    readonly type: string;
    readonly name: string;
    /** Raw native scene tag used by loc interaction and clickbox lookup. */
    readonly packedId: bigint;
    /**
     * Scene layer the loc was picked up from:
     *   0 = Wall, 1 = Decor, 2 = Scenery (standing loc), 3 = GroundDecor.
     * `-1` when the host couldn't classify. Native loc picking uses packedId;
     * layer is metadata for filtering/debug display. Populated by SDK v34+.
     */
    readonly layer: number;
    /** Raw 1-byte TypeCode2 value, or -1 when unavailable. */
    readonly sceneTypecode: number;
    /** Derived scene object type/shape (sceneTypecode & 0x1f), or -1. */
    readonly sceneObjectType: number;
    /** Alias for sceneObjectType. */
    readonly shape: number;
    /** Derived orientation ((sceneTypecode >> 6) & 3), or -1. */
    readonly orientation: number;
    /** Active dynamic scenery animation id, or -1 when static/unavailable. SDK 71+. */
    readonly animation: number;
    readonly actions: string[];
    readonly tile: Tile;
    readonly worldPoint: WorldPoint;
    readonly localPoint: LocalPoint;
    /** True while a loc matching this handle (layer + id) still occupies the tile. Flips to false once it despawns or the slot changes id. SDK 105+. */
    readonly exists: boolean;

    hasAction(action: string): boolean;
    /** RuneLite-style line of sight from this object's footprint to another locatable or world point. SDK 52+. */
    hasLineOfSight(other: LineOfSightTarget): boolean;
    /** True when this object's footprint is exactly one orthogonal tile from another footprint/point. SDK 86+. */
    isInMeleeDistance(other: SpatialTarget): boolean;
    /** RuneLite-style dynamic scenery animation id lookup. SDK 71+. */
    getAnimation(): number;
    /** Dispatch against the loc currently occupying this slot; re-resolves first (live handle), so a despawned object is a safe no-op. Returns false when actions does not contain it. */
    interact(action: string): boolean;
    /** Cast `spell` on this object. */
    castOn(spell: MagicSpell): boolean;
    /** Freeze a capture-time copy whose fields never re-resolve. SDK 105+. */
    snapshot(): Record<string, unknown>;
}

/**
 * A ground item stack. SDK 105+: ground-item handles are live cross-tick
 * (like TileObject) -- a cached reference re-resolves against the live tile
 * once per tick (matched on item id), so quantity/name/... track the current
 * stack. Use exists to test presence and snapshot() to freeze a capture-time
 * copy.
 */
interface GroundItem extends InstanceConvertible {
    readonly tileX: number;
    readonly tileY: number;
    readonly plane: number;
    readonly worldViewId: number;
    readonly worldViewPtr: bigint;
    readonly id: number;
    readonly quantity: number;
    /** See titan.GroundItemOwnership. Unknown/unreadable ownership is `0xFFFFFFFF`. */
    readonly ownershipType: number;
    readonly name: string;
    readonly tile: Tile;
    readonly worldPoint: WorldPoint;
    readonly localPoint: LocalPoint;
    /** True while a stack of this item id still lies on the tile. SDK 105+. */
    readonly exists: boolean;

    /** True when this ground item is lootable for the current account mode. */
    canLoot(): boolean;

    /** RuneLite-style line of sight from this item tile to another locatable or world point. SDK 52+. */
    hasLineOfSight(other: LineOfSightTarget): boolean;
    /** True when this item tile is exactly one orthogonal tile from another footprint/point. SDK 86+. */
    isInMeleeDistance(other: SpatialTarget): boolean;

    /** Dispatch a ground-item action (e.g. "Take", "Examine"); re-resolves against the live tile first. */
    interact(action: string): boolean;
    /** Cast `spell` on this ground item. */
    castOn(spell: MagicSpell): boolean;
    /** Freeze a capture-time copy whose fields never re-resolve. SDK 105+. */
    snapshot(): Record<string, unknown>;
}

interface Item {
    readonly slot: number;
    readonly id: number;
    readonly quantity: number;
    readonly name: string;

    /**
     * Dispatch an inventory action (e.g. "Eat", "Bury", "Drop") or a live
     * opcode-43 submenu label. Ordinary actions take precedence when labels
     * collide.
     * Returns true when the action was accepted / queued; inventory or
     * equipment state changes are confirmed later via `onItemContainerChanged`.
     */
    interact(action: string): boolean;

    /**
     * Use this item on another target. Overloaded by the target's
     * runtime shape: inventory items produce the two-packet
     * `WIDGET_TARGET` -> `WIDGET_TARGET_ON_WIDGET` flow (the knife-on-logs
     * case), NPCs select the item then invoke an NPC menu entry,
     * and `TileObject`s select the item then invoke a loc menu entry.
     * Returns `true` when the first selection packet was accepted.
     */
    useOn(target: Item | Npc | TileObject): boolean;
    /** Cast `spell` on this inventory item. */
    castOn(spell: MagicSpell): boolean;
}

interface Projectile extends InstanceConvertible {
    readonly plane: number;
    readonly startX: number;
    readonly startY: number;
    readonly targetX: number;
    readonly targetY: number;
    /** Decoded source actor hash index, or -1 when no actor source is encoded. */
    readonly sourceEntity: number;
    /** Decoded target actor hash index, or -1 when no actor target is encoded. */
    readonly targetEntity: number;
    /** Raw packed signed game source value. */
    readonly rawSourceEntity: number;
    /** Raw packed signed game target value. */
    readonly rawTargetEntity: number;
    /** EntityType.PLAYER / NPC / NONE for sourceEntity. */
    readonly sourceEntityType: number;
    /** EntityType.PLAYER / NPC / NONE for targetEntity. */
    readonly targetEntityType: number;
    readonly spotAnimId: number;
    readonly startTick: number;
    readonly endTick: number;
    readonly sceneX: number;
    readonly height: number;
    readonly sceneY: number;
    readonly tileX: number;
    readonly tileY: number;
    readonly worldX: number;
    readonly worldY: number;
    readonly tile: Tile;
    readonly worldPoint: WorldPoint;
    readonly localPoint: LocalPoint;
    readonly yaw: number;
    readonly pitch: number;
    readonly hasMoved: boolean;

    sourceActor(): ActorBase | null;
    targetActor(): ActorBase | null;

    /** RuneLite-style line of sight from this projectile tile to another locatable or world point. SDK 52+. */
    hasLineOfSight(other: LineOfSightTarget): boolean;
    /** True when this projectile tile is exactly one orthogonal tile from another footprint/point. SDK 86+. */
    isInMeleeDistance(other: SpatialTarget): boolean;
}

interface Sequence {
    readonly ptr: bigint;
    readonly id: number;
    readonly flags: number;
    readonly frameCount: number;
    readonly numFrames: number;
    readonly frameIds: bigint;
    readonly frameIDs: bigint;
    readonly frameLengths: bigint;
    readonly totalDuration: number;
    readonly frameStep: number;
    readonly repeatLimit: number;
}

/**
 * Active map-tile spot animation (RuneLite's `GraphicsObject`). Materialised
 * from `WorldView::GraphicsObjectList` and dispatched through
 * `onGraphicsObject{Spawned,Despawned,Moved}`. SDK 57+.
 */
interface GraphicsObject extends InstanceConvertible {
    readonly spotAnimId: number;
    readonly startCycle: number;
    readonly plane: number;
    readonly height: number;
    readonly preciseX: number;
    readonly preciseY: number;
    readonly sceneX: number;
    readonly sceneY: number;
    readonly tileX: number;
    readonly tileY: number;
    readonly worldX: number;
    readonly worldY: number;
    readonly worldViewId: number;
    readonly worldViewPtr: bigint;
    readonly seqPtr: bigint;
    readonly animationId: number;
    readonly frameCycle: number;
    readonly currentFrame: number;
    readonly loopCount: number;
    readonly totalCycle: number;
    readonly animation: Sequence | null;
    readonly tile: Tile;
    readonly worldPoint: WorldPoint;
    readonly localPoint: LocalPoint;

    /** RuneLite-style line of sight from this graphics object's tile to another locatable or world point. */
    hasLineOfSight(other: LineOfSightTarget): boolean;
    /** True when this graphics object's tile is exactly one orthogonal tile from another footprint/point. SDK 86+. */
    isInMeleeDistance(other: SpatialTarget): boolean;
}

type Locatable = ActorBase | TileObject | GroundItem | Projectile | GraphicsObject;
type SpatialTarget = Locatable | WorldPoint | titan.WorldArea;
type LineOfSightTarget = SpatialTarget;

// ---------------------------------------------------------------------------
// Queries — fluent filtering over collections.
// ---------------------------------------------------------------------------

/**
 * Base query over any collection of entities. Location-independent filters
 * and terminals only — queries over entities that have a tile extend
 * LocatableQuery to unlock `within` / `nearestTo`.
 */
interface Query<T> {
    where(pred: (e: T) => boolean): this;
    when(cond: boolean, fn: (q: this) => void): this;
    /** Sort items using a user-supplied comparator. */
    sortBy(cmp: (a: T, b: T) => number): this;

    count(): number;
    any(): boolean;
    empty(): boolean;
    first(): T | null;
    forEach(fn: (e: T) => void): void;
    toArray(): T[];
}

/** Name filters shared only by entities that expose a name. */
interface NamedQuery<T> extends Query<T> {
    nameContains(needle: string): this;
    nameEquals(name: string): this;
    /** Keep only entries whose name contains any needle in the array
     *  (case-insensitive substring). */
    namesAnyOf(needles: string[]): this;
}

/**
 * Query over locatable entities (things that live on a tile). Adds
 * position-based filtering and nearest-to lookup on top of Query.
 *
 * Both `within` and `nearestTo` accept the same set of origin shapes:
 * - `Tile` / `ActorBase` -- scene-local tile coords (no conversion).
 * - `WorldPoint` -- absolute world coords compared in the point's
 *   owning WorldView.
 * - `LocalPoint` -- sub-tile scene-local coords; round-down via `>> 7`.
 */
interface LocatableQuery<T> extends Query<T> {
    /** Keep only entities owned by the given WorldView id. SDK 85+. */
    worldView(worldViewId: number): this;
    /** Keep only entities owned by the current WorldView. SDK 85+. */
    currentWorldView(): this;
    /** Keep only top-level WorldView entities (`WorldView.TOP_LEVEL`). SDK 85+. */
    topLevelWorldView(): this;
    /** Keep only entities whose absolute world point is inside the area. SDK 100+. */
    within(worldArea: titan.WorldArea): this;
    within(radius: number, origin: Tile | ActorBase | WorldPoint | LocalPoint): this;
    nearestTo(origin: Tile | ActorBase | WorldPoint | LocalPoint): T | null;
    /** Nearest entity to the local player, or null. */
    nearest(): T | null;
    /** Keep only entities on the exact scene tile (or x, y pair). */
    onTile(tile: Tile): this;
    onTile(x: number, y: number): this;
    /** Keep only entities at the exact absolute world coordinate. */
    atWorldPoint(wp: WorldPoint): this;
    /** Sort ascending by Chebyshev tile distance from the origin. */
    sortedByDistanceTo(origin: Tile | ActorBase | WorldPoint | LocalPoint): this;
}

interface NamedLocatableQuery<T> extends LocatableQuery<T>, NamedQuery<T> {}

interface NpcQuery extends NamedLocatableQuery<Npc> {
    id(npcId: number): this;
    ids(...ids: number[]): this;
    /** Keep NPCs exposing at least one supplied action (case-insensitive substring). */
    hasAction(action: string, ...actions: string[]): this;
    /** Keep NPCs with definition combat level >= min. SDK 101+. */
    combatLevelAbove(minLevel: number): this;
    /** Keep NPCs with definition combat level <= max. SDK 101+. */
    combatLevelBelow(maxLevel: number): this;
    /** Keep NPCs within the inclusive definition combat-level range. SDK 101+. */
    combatLevelBetween(low: number, high: number): this;
    /** Exclude exact NPC identities by WorldView and hash index. SDK 101+. */
    exclude(npc: Npc, ...npcs: Npc[]): this;
    /** Keep only NPCs not actively targeted by any other player. */
    notTargetedByOtherPlayers(): this;
    /** Keep only NPCs actively interacting with a specific actor. */
    interactingWith(actor: ActorBase): this;
    /** Keep only NPCs actively interacting with the local player. */
    interactingWithLocal(): this;
    /** Keep only NPCs with no active interaction target. */
    notInteracting(): this;
    /** Keep only NPCs currently playing an animation. */
    isAnimating(): this;
    /** Keep only NPCs not currently animating. */
    notAnimating(): this;
    /** Keep only NPCs playing the exact animation ID. */
    animation(animId: number): this;
    /** Keep only NPCs with no pending movement. SDK 73+. */
    isStationary(): this;
    /** Keep only NPCs with any (or exact) active overhead icon. */
    overheadActive(icon?: number): this;
    /** Keep only NPCs whose overrideTransform matches (morphing NPCs). */
    overrideTransform(transformId: number): this;
    /** Keep only NPCs whose tile footprint equals `s` on both axes. */
    sizeEquals(s: number): this;
    /** Keep only dead NPCs (health bar at 0%). SDK 48+. */
    isDead(): this;
    /** Keep only alive NPCs (no health bar, or ratio > 0). SDK 48+. */
    isAlive(): this;
    /** Keep only NPCs with an active health bar. SDK 48+. */
    withHealthBar(): this;
    /** Keep only NPCs without an active health bar. SDK 48+. */
    noHealthBar(): this;
    /** Keep only NPCs whose health percent is below threshold. SDK 48+. */
    healthPercentBelow(threshold: number): this;
    /** Keep only NPCs whose health percent is above threshold. SDK 48+. */
    healthPercentAbove(threshold: number): this;
}

interface PlayerQuery extends NamedLocatableQuery<Player> {
    /** Keep only players actively interacting with a specific actor. */
    interactingWith(actor: ActorBase): this;
    /** Keep only players actively interacting with the local player. */
    interactingWithLocal(): this;
    /** Keep only players with no active interaction target. */
    notInteracting(): this;
    /** Keep only players currently playing an animation. */
    isAnimating(): this;
    /** Keep only players not currently animating. */
    notAnimating(): this;
    /** Keep only players playing the exact animation ID. */
    animation(animId: number): this;
    /** Keep only players with no pending movement. SDK 73+. */
    isStationary(): this;
    /** Keep only fully idle players (stationary and not animating). */
    isIdle(): this;
    /** Keep only skulled players. */
    isSkulled(): this;
    /** Keep only players with any (or exact) active overhead icon. */
    overheadActive(icon?: number): this;
    /** Keep only players with combat level >= min. */
    combatLevelAbove(min: number): this;
    /** Keep only players with combat level <= max. */
    combatLevelBelow(max: number): this;
    /** Keep only players with combat level in [lo, hi] inclusive. */
    combatLevelBetween(lo: number, hi: number): this;
    excludingSelf(): this;
    /** Keep only dead players (health bar at 0%). SDK 48+. */
    isDead(): this;
    /** Keep only alive players (no health bar, or ratio > 0). SDK 48+. */
    isAlive(): this;
    /** Keep only players with an active health bar. SDK 48+. */
    withHealthBar(): this;
    /** Keep only players without an active health bar. SDK 48+. */
    noHealthBar(): this;
    /** Keep only players whose health percent is below threshold. SDK 48+. */
    healthPercentBelow(threshold: number): this;
    /** Keep only players whose health percent is above threshold. SDK 48+. */
    healthPercentAbove(threshold: number): this;
}

interface ObjectQuery extends NamedLocatableQuery<TileObject> {
    id(locId: number): this;
    ids(...ids: number[]): this;
    /** Keep tile objects exposing at least one supplied action (case-insensitive substring). */
    hasAction(action: string, ...actions: string[]): this;
    ofType(typeName: string): this;
    /** Keep only objects on the given scene layer (0=Wall, 1=Decor, 2=Scenery, 3=GroundDecor). */
    layer(layerId: number): this;
}

interface GroundItemQuery extends NamedLocatableQuery<GroundItem> {
    id(itemId: number): this;
    ids(...ids: number[]): this;
    minQuantity(n: number): this;
    maxQuantity(n: number): this;
    /** Keep only ground items lootable for the current account mode. */
    canLoot(): this;
}

/// Inventory items have no tile — they extend the plain Query only.
interface InventoryQuery extends NamedQuery<Item> {
    id(itemId: number): this;
    ids(...ids: number[]): this;
    /** Keep only items at the exact inventory slot index. */
    slot(idx: number): this;
    /** Keep only items whose slot is in the supplied set. */
    slotsAnyOf(slots: number[]): this;
    /** Keep only items whose slot lies in `[lo, hi]` (inclusive). */
    slotsBetween(lo: number, hi: number): this;
    /** Keep only items with per-slot quantity >= n. */
    minQuantity(n: number): this;
    /** Keep only items with per-slot quantity <= n. */
    maxQuantity(n: number): this;
    /** Keep only items exposing the action in their runtime inventory actions. SDK 100+. */
    hasAction(action: string): this;
    /** Keep only noted item variants. SDK 100+. */
    isNoted(): this;
    /** Remove items whose id matches any in the array. */
    excludeIds(ids: number[]): this;
    /** Remove items whose name matches any needle (CI substring). */
    excludeNames(names: string[]): this;
    readonly totalQuantity: number;
    readonly exists: boolean;
}

interface ProjectileQuery extends LocatableQuery<Projectile> {
    spotAnim(animId: number): this;
    /** Keep only projectiles targeting the given decoded actor hash index. */
    targetingEntity(entityIndex: number): this;
    /** Keep only projectiles from the given decoded actor hash index. */
    fromEntity(entityIndex: number): this;
    /** Keep only projectiles targeting the exact player/NPC actor. */
    targetingActor(actor: ActorBase): this;
    /** Keep only projectiles from the exact player/NPC actor. */
    fromActor(actor: ActorBase): this;
    /** Keep only projectiles that started on or after the given tick. */
    startedAfterTick(tick: number): this;
    /** Keep only projectiles that end on or before the given tick. */
    endsBeforeTick(tick: number): this;
    /** Keep only projectiles active during the given tick. */
    activeDuring(tick: number): this;
}

/** Filterable collection of active map-tile spot animations. SDK 57+. */
interface GraphicsObjectQuery extends LocatableQuery<GraphicsObject> {
    /** Keep only graphics objects with the given spot-anim definition id. */
    spotAnim(animId: number): this;
    /** Keep only graphics objects on the given floor plane. */
    onPlane(plane: number): this;
    /** Keep only graphics objects that started on or after the given tick. */
    startedAfterTick(tick: number): this;
    /** Keep only graphics objects that started on or before the given tick. */
    startedBeforeTick(tick: number): this;
}

// ---------------------------------------------------------------------------
// Sections & settings
// ---------------------------------------------------------------------------

interface SectionOptions {
    /** Display label. Defaults to the key. */
    name?: string;
    /** Tooltip shown on the collapsing header. */
    description?: string;
    /** Render order — lower values appear first. */
    position?: number;
    /** Start collapsed. Defaults to false. */
    closedByDefault?: boolean;
}

interface Section {
    readonly key: string;
    readonly name: string;
    readonly description: string;
    readonly position: number;
    readonly isClosedByDefault: boolean;
}

interface SettingMetaBase {
    /** Owning section (optional). */
    section?: Section;
    /** Render order within the section. */
    position?: number;
    /** Start hidden. Can be flipped at runtime via setting.isHidden = true. */
    hidden?: boolean;
    /** Tooltip shown on the control. */
    tooltip?: string;
}

interface BoolSettingInit extends SettingMetaBase {
    key: string;
    name: string;
    default: boolean;
}
interface IntSettingInit extends SettingMetaBase {
    key: string;
    name: string;
    default: number;
    min: number;
    max: number;
}

  /** Loaded widget handles with retained slot-aware dynamic paths. SDK 64+. */
  interface WidgetQuery extends Query<titan.WidgetState> {
      /** Flat-table matches win over colliding dynamic fallback ids. */
      packedId(id: number): this;
    group(id: number): this;
    /** Filter by packed widget component id. */
    child(id: number): this;
    /** Replace matches with their direct dynamic child at this native slot. */
    slot(index: number): this;
    /** Match widgets containing any supplied text (case-insensitive substring). SDK 101+. */
    textContains(text: string, ...texts: string[]): this;
    textEquals(text: string): this;
    isVisible(): this;
    isHidden(): this;
    type(id: number): this;
    contentType(id: number): this;
    itemId(id: number): this;
    /** Replace matches with their non-null direct dynamic children. */
    children(): this;
    /** True when the host clipped a bounded live traversal. */
    readonly truncated: boolean;
}
interface ColorSettingInit extends SettingMetaBase {
    key: string;
    name: string;
    /** RGB color stored as 0xRRGGBB. */
    default: number;
}
interface ComboChoice {
    value: number;
    label: string;
}
interface ComboSettingInit extends SettingMetaBase {
    key: string;
    name: string;
    default: number;
    choices: ComboChoice[];
}
interface StringSettingInit extends SettingMetaBase {
    key: string;
    name: string;
    default: string;
}

interface ProtectedStringSettingInit extends SettingMetaBase {
    key: string;
    name: string;
    default?: string;
}

interface ButtonSettingInit extends SettingMetaBase {
    key: string;
    name: string;
    /**
     * Invoked when the button is clicked in the config UI. Runs on the game
     * thread (main loop), including at the login screen. Keep it non-blocking.
     */
    onClick: () => void;
}

interface Setting<T> {
    readonly key: string;
    readonly name: string;
    value: T;
    readonly defaultValue: T;
    isHidden: boolean;
    readonly position: number;
    /** Restore the value to defaultValue. */
    reset(): void;
}

// ---------------------------------------------------------------------------
// Events (typed wrappers)
// ---------------------------------------------------------------------------

interface MenuOptionClicked {
    readonly opcode: number;
    /** Menu-entry identifier: entity id or CC_OP sub-action index. */
    readonly identifier: number;
    readonly param0: number;
    readonly param1: number;
    readonly worldViewId: number;
    readonly clickX: number;
    readonly clickY: number;
    readonly actionText: string;
    readonly targetText: string;
    readonly replaced: boolean;
    consumed: boolean;
    /** Shorthand for `consumed = true`. */
    consume(): void;
    /** Replace the DoAction that reaches the game while preserving the original click frame. */
    replaceWith(action: MenuActionSpec): void;
    /** Clear any pending replacement; the original action will run unless consumed. */
    clearReplacement(): void;
}

interface ScriptEvent {
    readonly scriptId: number;
    readonly intArgs: number[];
    readonly intResults: number[];
}

/** Delivered to `onVarbitChanged` when a varbit's resolved value actually
 * changes (no-op SetVarbit writes are filtered by the host). Added in SDK 21. */
interface VarbitChangedEvent {
    /** Varbit type id (index into the VarBitType cache). */
    readonly varbitId: number;
    /** Resolved value of the varbit before the write. */
    readonly oldValue: number;
    /** Resolved value of the varbit after the write. */
    readonly newValue: number;
    /** Current game tick captured at dispatch, or 0 if unavailable. */
    readonly gameTick: number;
}

/** Delivered to `onGameStateChanged` when native Client.GameState changes.
 * Values are `LoginGameState` native client values. Added in SDK 91. */
interface GameStateChangedEvent {
    readonly oldState: titan.LoginGameState;
    readonly newState: titan.LoginGameState;
    readonly tickCount: number;
}

/** Delivered to `onChatMessage` for every native chat line added to the
 * chatbox: server-delivered text, local system messages, and plugin-injected
 * lines via `titan.addChatMessage`. Added in SDK 22. */
interface ChatMessageEvent {
    /** Chat type (0=PUBLIC, 2=SERVER, 3=CLAN, 4=TRADE, 99=BROADCAST, ...). */
    readonly type: number;
    /** Sender display name. Empty on system / server messages. */
    readonly name: string;
    /** Rendered chat text (may contain `<col=...>` tags). */
    readonly message: string;
    /** Sender prefix (clan name for clan chat, empty on most types). */
    readonly sender: string;
    /** Current game tick captured at dispatch, or 0 if unavailable. */
    readonly gameTick: number;
}

/** Discriminates the source of a `SoundPlayedEvent`. */
const enum SoundKind {
    /** Queued JagFX/wave sound effect (combat, spells, NPCs, area sounds). */
    Synth = 0,
    /** MIDI jingle (level-ups, quests, music stings). */
    Jingle = 1,
}

/** Delivered to `onSoundPlayed` when the native client plays a sound. Covers
 * queued synth sound effects (captured at the queue drain) and MIDI jingles
 * (captured at `PlayJingle`); check `kind`. Set `consumed = true` to mark the
 * event handled and stop later sound handlers in the same dispatch. Current
 * playback suppression is global-only; use
 * `titan.state.audio.playbackDisabled = true` to mute sounds. Added in SDK 69. */
interface SoundPlayedEvent {
    /** Source of the sound (synth sound effect or MIDI jingle). */
    readonly kind: SoundKind;
    /** Synth JagFX id or jingle id. */
    readonly soundId: number;
    /** Synth loop count; -1 for jingles. */
    readonly loops: number;
    /** Jingle duration in ms; -1 for synths. */
    readonly durationMs: number;
    /** Synth packed position/range; -1 for jingles. */
    readonly packedPos: number;
    /** Current game tick captured at dispatch, or 0 if unavailable. */
    readonly gameTick: number;
    /** Set to true to mark this sound event consumed for handler ordering. */
    consumed: boolean;
}

/** Delivered to `onHitsplatApplied` when the native client applies a visible
 * hitsplat to a player or NPC. Added in SDK 74; native signature corrected in
 * SDK 76. */
interface HitsplatAppliedEvent {
    /** Resolved actor object, or null if the actor no longer resolves. */
    readonly actor: Actor | null;
    /** Entity type code: titan.ENTITY_TYPE_PLAYER, NPC, or NONE. */
    readonly actorType: number;
    /** Lowercase actor kind: "player", "npc", or "none". */
    readonly kind: "player" | "npc" | "none";
    /** Player hash index for players, NPC id for NPCs, or -1 when unresolved. */
    readonly indexOrId: number;
    /** Resolved actor name, or empty when unresolved. */
    readonly actorName: string;
    /** Native hitsplat type id. */
    readonly type: number;
    /** Damage/value payload. */
    readonly value: number;
    /** Alias for value. */
    readonly damage: number;
    /** Native limit field from the real hitsplat adder. */
    readonly limit: number;
    /** Native delay field. */
    readonly delay: number;
    /** Native cycle field. */
    readonly cycle: number;
    /** Current game tick captured at dispatch, or 0 if unavailable. */
    readonly gameTick: number;
}

/** Delivered to `onActorSpotAnim` when the native client applies an actor-attached
 * spot animation. Clear/removal ids are filtered before dispatch. Added in
 * SDK 76. */
interface ActorSpotAnimEvent {
    /** Resolved actor object, or null if the actor no longer resolves. */
    readonly actor: Actor | null;
    /** Entity type code: titan.ENTITY_TYPE_PLAYER, NPC, or NONE. */
    readonly actorType: number;
    /** Lowercase actor kind: "player", "npc", or "none". */
    readonly kind: "player" | "npc" | "none";
    /** Player hash index for players, NPC id for NPCs, or -1 when unresolved. */
    readonly indexOrId: number;
    /** Resolved actor name, or empty when unresolved. */
    readonly actorName: string;
    /** Native actor spotanim slot. */
    readonly slot: number;
    /** SpotAnim definition id. */
    readonly id: number;
    /** Native spotanim height field. */
    readonly height: number;
    /** Native delay field. */
    readonly delay: number;
    /** Native cycle field. */
    readonly cycle: number;
    /** Current game tick captured at dispatch, or 0 if unavailable. */
    readonly gameTick: number;
}

/** Delivered to `onAnimationChanged` when the native client accepts an actor
 * animation field change. Same-animation resets and rejected native requests
 * are filtered before dispatch. Added in SDK 78. */
interface AnimationChangedEvent {
    /** Resolved actor object, or null if the actor no longer resolves. */
    readonly actor: Actor | null;
    /** Entity type code: titan.ENTITY_TYPE_PLAYER, NPC, or NONE. */
    readonly actorType: number;
    /** Lowercase actor kind: "player", "npc", or "none". */
    readonly kind: "player" | "npc" | "none";
    /** Player hash index for players, NPC id for NPCs, or -1 when unresolved. */
    readonly indexOrId: number;
    /** Resolved actor name, or empty when unresolved. */
    readonly actorName: string;
    /** Previous raw Actor.Animation id. */
    readonly oldAnimation: number;
    /** New raw Actor.Animation id accepted by the native setter. */
    readonly newAnimation: number;
    /** Current game tick captured at dispatch, or 0 if unavailable. */
    readonly gameTick: number;
}

/** Single occupied slot in an item container snapshot. Added in SDK 26. */
interface ItemContainerSlot {
    readonly slot: number;
    readonly id: number;
    readonly quantity: number;
}

/** Single bank slot with item info. Used by `titan.utils.bank` helpers. */
interface BankItemSlot {
    readonly slot: number;
    readonly itemId: number;
    readonly quantity: number;
}

/** Snapshot of a RuneLite-style item container (INVENTORY=93,
 * EQUIPMENT=94, BANK=95). Empty slots are filtered out. Added in SDK 26. */
interface ItemContainerSnapshot {
    readonly containerId: number;
    readonly capacity: number;
    /** Snapshot of every occupied slot as a fresh array (allocates). */
    items(): ItemContainerSlot[];
}

/** Event wrapper for tick-level diff of an item container. Fires whenever
 * a mapped container's slot contents differ from the previous tick's
 * snapshot. Added in SDK 26. */
interface ItemContainerChangedEvent {
    readonly containerId: number;
    readonly capacity: number;
    readonly gameTick: number;
    readonly items: ItemContainerSlot[];
}

/** Runtime ItemDef snapshot (RuneLite Client parity).
 * When `runtimeResolved` is true the fields came from the live game table or
 * native ITEM_DEF_LOOKUP (includes resolved transforms and preserves runtime
 * inventory-action slots, including empty gaps); when false they came from
 * the cache file's raw 5-slot inventory-action array. Added in SDK 26. */
interface ItemComposition {
    readonly id: number;
    readonly name: string;
    readonly stackable: boolean;
    /** Other item id in the note pair; -1 when there is no note pair. */
    readonly linkedNoteId: number;
    /** Inventory-action slots with positional gaps preserved. */
    readonly inventoryActions: string[];
    /** Opcode-43 submenu labels as a fixed 5 x 20 positional matrix. */
    readonly subOps: string[][];
    readonly runtimeResolved: boolean;
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

/**
 * Render-pass selector for overlays. Two values matching the host's two
 * draw passes. RuneLite's `UNDER_WIDGETS` / `ABOVE_MAP` aren't mirrored —
 * the host has no equivalent passes. Available at runtime as
 * `titan.OverlayLayer`.
 */
type OverlayLayer = "AboveScene" | "AboveWidgets";

interface OverlayInit {
    layer?: OverlayLayer;
    render: () => void;
}

// ---------------------------------------------------------------------------
// OverlayPanel (SDK 46) -- structured HUD panels with anchor-based layout,
// Alt-drag repositioning, and full theming. Mirrors RuneLite's OverlayPanel.
// ---------------------------------------------------------------------------

/**
 * Anchor positions for OverlayPanel. Only the values with semantics
 * that free positioning can't replicate are exposed -- corner / canvas
 * anchors are intentionally omitted; users free-position into corners
 * via Alt-drag (panels become Dynamic once moved). Available at runtime
 * as `titan.OverlayAnchor`.
 */
type OverlayAnchor =
    | "Dynamic"
    | "TopCenter"
    | "LeftCenter"
    | "RightCenter"
    | "AboveChatboxRight"
    | "Tooltip";

/**
 * Sticky theming for an OverlayPanel. All fields optional -- omitted
 * fields fall back to library defaults.
 */
interface OverlayPanelStyle {
    /** ARGB background colour (0xAARRGGBB). */
    background?: number;
    /** ARGB border colour. Alpha=0 disables the border. */
    borderColor?: number;
    /** Border thickness in pixels. 0 disables the border. */
    borderThickness?: number;
    /** Corner radius in pixels (0 = sharp corners). */
    cornerRadius?: number;
    /** Horizontal padding inside the panel rect. */
    padHorizontal?: number;
    /** Vertical padding inside the panel rect. */
    padVertical?: number;
    /** Vertical gap between component rows. */
    lineGap?: number;
    /** Default ARGB colour for `title()` calls. */
    titleColor?: number;
    /** Default ARGB colour for `line()` left text. */
    lineLeftColor?: number;
    /** Default ARGB colour for `line()` right text. */
    lineRightColor?: number;
    /** Default ARGB fill colour for `progressBar()`. */
    barFillColor?: number;
    /** Default ARGB background colour for `progressBar()`. */
    barBgColor?: number;
}

/**
 * The panel object passed to `render` in `Plugin.overlayPanel`. Provides
 * builder methods that emit components into the host, plus styling
 * setters that update the panel's sticky style.
 */
interface OverlayPanelInstance {
    /** Append a title row. */
    title(text: string, color?: number): OverlayPanelInstance;
    /** Append a label/value line (right text right-aligned). */
    line(left: string, right?: string, leftColor?: number, rightColor?: number): OverlayPanelInstance;
    /** Append a progress bar with [min..max] range. */
    progressBar(value: number, min: number, max: number,
                fillColor?: number, bgColor?: number): OverlayPanelInstance;
    /** Hard-clamps to [80, 600]. */
    setPreferredWidth(px: number): OverlayPanelInstance;
    /** Replace the panel's sticky style. */
    setStyle(style: OverlayPanelStyle): OverlayPanelInstance;
    setBackgroundColor(argb: number): OverlayPanelInstance;
    setBorderColor(argb: number): OverlayPanelInstance;
    setBorderThickness(px: number): OverlayPanelInstance;
    setCornerRadius(px: number): OverlayPanelInstance;
    setPadding(horizontal: number, vertical: number): OverlayPanelInstance;
    setLineGap(px: number): OverlayPanelInstance;
    setTitleColor(argb: number): OverlayPanelInstance;
    setLineColors(leftArgb: number, rightArgb: number): OverlayPanelInstance;
    setProgressBarColors(fillArgb: number, bgArgb: number): OverlayPanelInstance;
}

interface OverlayPanelInit {
    /** Stable identifier within this plugin (used as the layout key). */
    name: string;
    /** Anchor position. Defaults to "Dynamic". */
    anchor?: OverlayAnchor;
    /** Stack ordering within an anchor group. Lower priority renders first. */
    priority?: number;
    /** Optional starting style. Equivalent to calling `panel.setStyle(...)`. */
    style?: OverlayPanelStyle;
    /** Width hint in pixels. Defaults to 220. */
    preferredWidth?: number;
    /**
     * Per-frame render callback. Receives the panel object so the
     * callback can call `p.title(...)` / `p.line(...)` / etc.
     */
    render: (panel: OverlayPanelInstance) => void;
}

// ---------------------------------------------------------------------------
// Plugin base class (class-based authoring, recommended)
// ---------------------------------------------------------------------------

interface PluginHandle {
    readonly id: string;
    readonly name: string;
    /** True when the host still knows this plugin id. */
    readonly isValid: boolean;
    readonly isEnabled: boolean;
    readonly hasPanel: boolean;
    enable(): boolean;
    disable(): boolean;
    toggle(): boolean;
    /** Direct enable/disable setter. Returns true when accepted by the host. */
    setEnabled(v: boolean): boolean;
}

/** Break Handler command phase shared by all plugin runtimes. SDK 97+. */
type BreakPhase = "NONE" | "PREPARE" | "BREAK_ACTIVE" | "RESUME";

/** Whether the coordinated break stays logged in or confirms logout. SDK 97+. */
type BreakMode = "AFK" | "LOGOUT";

/** Immutable result returned by `titan.breakHandler.poll`. SDK 97+. */
interface BreakCommand {
    readonly available: boolean;
    readonly epoch: bigint;
    readonly phase: BreakPhase;
    readonly mode: BreakMode;
    readonly triggeringOwnerId: string;
}

/**
 * Instance-addressed Break Handler utility. The exact `Plugin` object passed
 * to `titan.register` (or the exact class instance registered by the SDK)
 * must be supplied to every operation, so helpers in a
 * multi-class project can safely retain and forward their owning instance.
 * The host copies stable identity and never retains the JavaScript object.
 * SDK 97+.
 */
interface BreakHandlerUtility {
    /** Register as a configurable schedule owner by default. */
    register(plugin: Plugin, configurable?: boolean): boolean;
    /** Mark a registration active; owners receive a fresh sampled run. */
    start(plugin: Plugin): boolean;
    /** Mark inactive but retain the visible registration and saved settings. */
    stop(plugin: Plugin): boolean;
    /** Stop and remove the live registration. */
    unregister(plugin: Plugin): boolean;
    /** Poll and record the current epoch for a subsequent report. */
    poll(plugin: Plugin): BreakCommand;
    shouldBreak(plugin: Plugin): boolean;
    isBreakActive(plugin: Plugin): boolean;
    shouldResume(plugin: Plugin): boolean;
    /** Acknowledge a safe paused boundary for the last polled epoch. */
    paused(plugin: Plugin): boolean;
    /** Report a bounded preparation deferral for the last polled epoch. */
    defer(plugin: Plugin, retryAfterMs: number, reason: string): boolean;
    /** Report an unrecoverable preparation or resume error. */
    error(plugin: Plugin, code: number, reason: string): boolean;
    /** Report normal operation after start or resume. */
    running(plugin: Plugin): boolean;
}

/**
 * Extend titan.Plugin, declare setting / section / overlay members via the
 * helper methods (this.boolSetting, this.section, this.overlay, ...) and
 * override the lifecycle methods you care about.
 */
class Plugin {
    id: string;
    name: string;
    /**
     * Side panels exposed by this plugin. Each entry becomes its own nav
     * button in the controller's right-hand rail. A plugin may declare
     * several. Replaces the SDK <= 64 singular `hasPanel` / `panelTitle` /
     * `buildPanel` / `onPanelAction` model.
     */
    panels?: PanelDef[];
    readonly isEnabled: boolean;
    /** One-line description shown as a tooltip in the plugin list. */
    description?: string;
    /** Plugin author name. */
    author?: string;
    /** Short version string (e.g. "1.0.0"). */
    version?: string;
    /**
     * Plugin ids that must be available before this plugin is enabled.
     * Dependencies share one namespace across native, JavaScript, and Java.
     */
    dependencies?: string[];
    /** Default enabled state for first install; runtime starts disabled until the controller applies saved/default state. */
    enabled?: boolean;
    // Setting helpers — each returns a Setting<T> that auto-registers.
    boolSetting(init: BoolSettingInit): Setting<boolean>;
    intSetting(init: IntSettingInit): Setting<number>;
    colorSetting(init: ColorSettingInit): Setting<number>;
    comboSetting(init: ComboSettingInit): Setting<number>;
    stringSetting(init: StringSettingInit): Setting<string>;
    protectedStringSetting(init: ProtectedStringSettingInit): Setting<string>;
    /**
     * Value-less action button. `init.onClick` runs on the game thread (main
     * loop, including the login screen) when the button is clicked. Returns a
     * Setting<void> that auto-registers.
     */
    buttonSetting(init: ButtonSettingInit): Setting<void>;

    // Section helper — auto-registers.
    section(key: string, name: string, opts?: SectionOptions): Section;

    // Overlay helper — auto-registers. Multiple allowed per plugin.
    overlay(init: OverlayInit): OverlayInit;

    /**
     * OverlayPanel helper -- auto-registers a structured HUD panel with
     * anchor-based layout and Alt-drag repositioning. Multiple allowed
     * per plugin. Returns the panel instance so styling setters can be
     * chained onto the registration call. Added in SDK 46.
     */
    overlayPanel(init: OverlayPanelInit): OverlayPanelInstance;

    // Lifecycle hooks — override as needed.
    onEnable?(): void;
    onDisable?(): void;
    onClientTick?(): void;
    /**
     * Fired once per outer client MAIN_LOOP iteration, including title/login
     * screens. Static definition-cache reads are always available. Check
     * `titan.state.login.isWorldReady` before live client, entity, widget,
     * scene, or projection queries. SDK 118+.
     */
    onMainLoop?(): void;
    onGameTick?(tick: number): void;
    onSettingChanged?(key: string): void;

    onMenuOptionClicked?(event: MenuOptionClicked): void;
    onScriptFired?(event: ScriptEvent): void;
    /** Fired when a varbit's resolved value actually changes. Added in SDK 21. */
    onVarbitChanged?(event: VarbitChangedEvent): void;
    /** Fired when native Client.GameState changes. Added in SDK 91. */
    onGameStateChanged?(event: GameStateChangedEvent): void;
    /** Fired for every chat line added to the chatbox (server + local + injected). Added in SDK 22. */
    onChatMessage?(event: ChatMessageEvent): void;
    /** Fired when the native client plays a sound (synth effect or jingle; see
     * `event.kind`). Set `event.consumed = true` to stop later sound handlers;
     * use `titan.state.audio.playbackDisabled` for playback suppression. Added
     * in SDK 69. */
    onSoundPlayed?(event: SoundPlayedEvent): void;
    /** Fired when a visible hitsplat is applied to a resolved actor. Added in SDK 74. */
    onHitsplatApplied?(event: HitsplatAppliedEvent): void;
    /** Fired when an actor-attached spot animation is applied. Added in SDK 76. */
    onActorSpotAnim?(event: ActorSpotAnimEvent): void;
    /** Fired when an actor animation field actually changes. Added in SDK 78. */
    onAnimationChanged?(event: AnimationChangedEvent): void;
    /** Fired when a mapped item container's slot contents differ from the
     * previous tick. Detection is tick-level diff. Added in SDK 26. */
    onItemContainerChanged?(event: ItemContainerChangedEvent): void;

    onNpcSpawned?(npc: Npc): void;
    onNpcDespawned?(npc: Npc): void;
    onPlayerSpawned?(player: Player): void;
    onPlayerDespawned?(player: Player): void;
    onTileObjectSpawned?(obj: TileObject): void;
    onTileObjectDespawned?(obj: TileObject): void;
    onProjectileSpawned?(proj: Projectile): void;
    onProjectileDespawned?(proj: Projectile): void;
    onProjectileMoved?(proj: Projectile): void;
    onGraphicsObjectSpawned?(g: GraphicsObject): void;
    onGraphicsObjectDespawned?(g: GraphicsObject): void;
    onGraphicsObjectMoved?(g: GraphicsObject): void;
}

// ---------------------------------------------------------------------------
// Panel builder
// ---------------------------------------------------------------------------

/**
 * One side panel definition. Supply via `panels` on a Plugin. A plugin
 * may declare multiple panels; each gets its own nav button in the controller
 * side rail.
 */
interface PanelDef {
    /** Stable per-plugin id used to route panel content and actions. */
    id: string;
    /** Display title shown on the nav button tooltip / header. */
    title: string;
    /**
     * Optional icon spec for the nav button. Use `awesome:gear`,
     * `lucide:house`, `phosphor:gear:bold`, or a raw Font Awesome glyph
     * such as "\uf013". Unprefixed strings are treated as Font Awesome.
     * Ignored when `image` is set.
     */
    icon?: string;
    /**
     * Optional icon tint as ARGB (0xAARRGGBB). Applies to Font Awesome,
     * Lucide, Phosphor, and letter fallback icons. Ignored when `image` is set.
     */
    iconColor?: number;
    /**
     * Optional custom image icon as a base64-encoded PNG (RuneLite-style).
     * A `data:image/png;base64,` prefix is allowed. Takes precedence over
     * `icon`.
     */
    image?: string;
    /** Build the panel's contents (called whenever the panel is visible). */
    build(panel: Panel): void;
    /** Handle a control interaction inside this panel. */
    onAction?(actionId: number, value: SettingValue): void;
}

type PanelTone = number;

type PanelButtonStyle = number;

type PanelInputFlags = number;

interface Panel {
    text(s: string): Panel;
    wrapped(s: string): Panel;
    disabled(s: string): Panel;
    bullet(s: string): Panel;
    colored(s: string, color: number): Panel;
    status(s: string, tone?: PanelTone): Panel;
    label(label: string, value: string): Panel;
    /** Inline "(?)" marker revealing 	ext as a tooltip on hover. */
    help(text: string): Panel;
    /** Compact colored status pill; sits inline (use after label().sameLine()). */
    badge(text: string, tone?: PanelTone): Panel;

    separator(): Panel;
    separatorText(s: string): Panel;
    section(s: string): Panel;
    spacing(): Panel;
    sameLine(offset?: number, spacing?: number): Panel;
    newLine(): Panel;
    indent(width?: number): Panel;
    unindent(width?: number): Panel;
    dummy(w: number, h: number): Panel;

    button(label: string, actionId: number): Panel;
    button(label: string, actionId: number, style: PanelButtonStyle, width?: number, height?: number): Panel;
    smallButton(label: string, actionId: number): Panel;
    smallButton(label: string, actionId: number, style: PanelButtonStyle): Panel;
    primaryButton(label: string, actionId: number, width?: number, height?: number): Panel;
    secondaryButton(label: string, actionId: number, width?: number, height?: number): Panel;
    dangerButton(label: string, actionId: number, width?: number, height?: number): Panel;
    selectable(label: string, actionId: number, selected?: boolean): Panel;
    checkbox(label: string, actionId: number, value: boolean): Panel;
    sliderInt(label: string, actionId: number, value: number, min: number, max: number): Panel;
    sliderFloat(label: string, actionId: number, value: number, min: number, max: number): Panel;
    inputText(label: string, actionId: number, value: string): Panel;
    inputText(label: string, actionId: number, value: string, flags: PanelInputFlags): Panel;
    inputText(label: string, actionId: number, submitActionId: number, value: string): Panel;
    inputText(label: string, actionId: number, submitActionId: number, value: string, flags: PanelInputFlags): Panel;
    inputPassword(label: string, actionId: number, value: string): Panel;
    inputPassword(label: string, actionId: number, submitActionId: number, value: string): Panel;
    /**
     * Dropdown selector. items are the option labels; selectedIndex is the
     * current selection. Fires ctionId with the chosen index when changed.
     */
    combo(label: string, actionId: number, items: string[], selectedIndex: number): Panel;

    /**
     * Grey-out and disable everything until the matching endDisabled().
     * Pass disabled=false to leave the block enabled. Always pair the calls.
     */
    beginDisabled(disabled?: boolean): Panel;
    endDisabled(): Panel;

    progress(fraction: number, overlay?: string): Panel;
    collapsing(label: string): Panel;
    beginCollapsible(label: string, defaultOpen?: boolean): Panel;
    endCollapsible(): Panel;
    treeNode(label: string): Panel;
    treePop(): Panel;
    beginTable(id: string, columns: number, flags?: number): Panel;
    endTable(): Panel;
    tableNextRow(): Panel;
    tableNextColumn(): Panel;
    tableSetupColumn(label: string, flags?: number, width?: number): Panel;
    tableHeadersRow(): Panel;

    /**
     * Tab bar. Emit one or more beginTabItem(label)/endTabItem() blocks between
     * beginTabBar()/endTabBar(). Only the selected tab's contents are rendered,
     * so emit every tab's body unconditionally (do not branch on selection).
     */
    beginTabBar(id: string): Panel;
    endTabBar(): Panel;
    beginTabItem(label: string): Panel;
    endTabItem(): Panel;

    tooltip(t: string): Panel;

    /** Group / child-region containers. `childFlags` is a mask of PanelChildFlag. */
    beginGroup(): Panel;
    endGroup(): Panel;
    beginChild(id: string, childFlags?: number, width?: number, height?: number): Panel;
    endChild(): Panel;
    /** Framed, padded, auto-height "card" container. Pair with endCard(). */
    beginCard(id: string): Panel;
    endCard(): Panel;
    /** Center/right-align a same-line run of buttons. `align` is a PanelAlign. */
    beginAlign(align: PanelAlign): Panel;
    endAlign(): Panel;

    push(type: number, text: string): PanelElement;
}

/** Horizontal alignment for Panel.beginAlign(). */
const enum PanelAlign {
    left = 0,
    center = 1,
    right = 2,
}

/** Child-region flags for Panel.beginChild() (combine with bitwise OR). */
const enum PanelChildFlag {
    border = 1,
    padding = 2,
    autoResizeY = 4,
    frame = 8,
}

interface SettingValue {
    type: "boolean" | "integer" | "string";
    boolValue?: boolean;
    intValue?: number;
    stringValue?: string;
}

interface PanelElement {
    type: number;
    text?: string;
    textSecondary?: string;
    color?: number;
    actionId?: number;
    intVal?: number;
    intVal2?: number;
    intVal3?: number;
    floatVal?: number;
    floatVal2?: number;
    floatVal3?: number;
    widthVal?: number;
    heightVal?: number;
    boolVal?: boolean;
}

// ---------------------------------------------------------------------------
// titan global namespace — fluent facades and helper catalogs.
// ---------------------------------------------------------------------------

    // Entity-type constants used by projectile and actor event payloads.
    const ENTITY_TYPE_NPC: number;
    const ENTITY_TYPE_PLAYER: number;
    const ENTITY_TYPE_NONE: number;

    /** WorldView id constants. SDK 85+. */
    const WorldView: {
        readonly CURRENT: -1;
        readonly TOP_LEVEL: 0;
    };

    /**
     * Render-pass selector for `Plugin.overlay({ layer: ... })`. Two
     * values matching the host's draw passes (`ABOVE_SCENE` /
     * `ABOVE_WIDGETS`). RuneLite's `UNDER_WIDGETS` / `ABOVE_MAP` are
     * intentionally not mirrored — the host has no equivalent passes.
     */
    const OverlayLayer: {
        readonly ABOVE_SCENE: "AboveScene";
        readonly ABOVE_WIDGETS: "AboveWidgets";
    };

    const PanelTone: {
        readonly neutral: 0;
        readonly accent: 1;
        readonly success: 2;
        readonly warning: 3;
        readonly danger: 4;
        readonly info: 5;
    };

    const PanelButtonStyle: {
        readonly normal: 0;
        readonly primary: 1;
        readonly secondary: 2;
        readonly danger: 3;
        readonly ghost: 4;
    };

    const PanelInputFlags: {
        readonly none: 0;
        readonly password: 1;
        readonly multiline: 2;
    };

    /**
     * Anchor positions for `Plugin.overlayPanel({ anchor: ... })`.
     * Minimal semantic set -- corner anchors are intentionally omitted
     * because users free-position into those areas via Alt-drag.
     * Added in SDK 46.
     */
    const OverlayAnchor: {
        readonly Dynamic:           "Dynamic";
        readonly TopCenter:         "TopCenter";
        readonly LeftCenter:        "LeftCenter";
        readonly RightCenter:       "RightCenter";
        readonly AboveChatboxRight: "AboveChatboxRight";
        readonly Tooltip:           "Tooltip";
    };

    /**
     * Axis-aligned rectangle in absolute world-tile space. Mirrors
     * `titan::WorldArea` in
     * [shared/titan/world_area.h](shared/titan/world_area.h). Pure JS
     * class — methods are arithmetic over `x` / `y` / `width` /
     * `height` / `plane`, so no host call is needed. Construct with
     * `new titan.WorldArea(x, y, w, h, plane)`. Added in SDK 39.
     */
    class WorldArea {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly plane: number;

        constructor(x: number, y: number, width: number, height: number, plane: number);

        /** Plane-aware containment test. */
        contains(p: WorldPoint): boolean;
        /** Plane-ignoring containment test. */
        contains2D(p: WorldPoint): boolean;
        /** South-west-corner-anchored centre tile of this area. */
        center(): WorldPoint;
        /**
         * Chebyshev distance from the closest edge of this area to `p`.
         * Returns `Number.MAX_SAFE_INTEGER` when planes differ.
         */
        distanceTo(p: WorldPoint): number;
        /** True when this area is exactly one orthogonal tile from another footprint/point. SDK 86+. */
        isInMeleeDistance(other: SpatialTarget): boolean;
        /** RuneLite-style line of sight from this area to another area, locatable, or world point. SDK 52+. */
        hasLineOfSight(other: LineOfSightTarget): boolean;
    }

    namespace worldView {
        const CURRENT: -1;
        const TOP_LEVEL: 0;
        /** Active/current WorldView pointer, or null when unavailable. SDK 81+. */
        function current(): bigint | null;
        /** WorldView pointer for a specific WorldView id, or null when unavailable. SDK 81+. */
        function get(id: number): bigint | null;
        /** Top-level/default WorldView pointer. SDK 81+. */
        function topLevel(): bigint | null;
    }

    namespace worldPoint {
        /** Active instance template chunks as [plane][chunkX][chunkY], or null when unavailable. SDK 81+. */
        function getInstanceTemplateChunks(): InstanceTemplateChunks | null;
        /** Convert a local-instance WorldPoint to its source-world point. SDK 81+. */
        function fromLocalInstance(point: WorldPoint): WorldPoint | null;
        /** Convert a source-world WorldPoint into the current local instance. SDK 81+. */
        function toLocalInstance(point: WorldPoint): WorldPoint | null;
        /** Literal-safe RuneLite-style orthogonal melee adjacency check for two world/locatable targets. SDK 86+. */
        function isInMeleeDistance(a: SpatialTarget, b: SpatialTarget): boolean;
        /**
         * True when the world tile is inside the scene the client currently
         * has loaded — i.e. when its objects, collision and clickable tiles
         * can be read at all. A tile outside it can be walked TOWARD but
         * never interacted with, so this is the guard to use before clicking
         * a tile, resolving an object, or reading collision. Tested against
         * the current WorldView's scene. Pass an explicit base/size to test
         * against a snapshot you already hold. SDK 117+.
         */
        function isInScene(point: WorldPoint, baseX?: number, baseY?: number,
                           sceneSizeX?: number, sceneSizeY?: number): boolean;
    }

    /** Read-only asynchronous cost-based web-path generation. SDK 112+. */
    const webWalker: WebWalkerFacade;

    /** Host-driven web-walk executor over generated routes. SDK 114+. */
    const webWalk: WebWalkFacade;

    // --- Geometry helpers (SDK 39) ---
    // Mirror the inline methods on `titan::WorldPos` in C++. Operate
    // over plain `WorldPoint` interface values returned from entity
    // wrappers. Plane-aware where relevant.

    /** RuneLite-style 6-bit-by-6-bit region id: `((x >> 6) << 8) | (y >> 6)`. */
    function regionId(p: WorldPoint): number;
    /** X coordinate within the 64x64 region (`x & 63`). */
    function regionX(p: WorldPoint): number;
    /** Y coordinate within the 64x64 region (`y & 63`). */
    function regionY(p: WorldPoint): number;
    /**
     * Chebyshev distance between two world points or scene tiles.
     * Returns `Number.MAX_SAFE_INTEGER` when planes differ for
     * `WorldPoint` arguments.
     */
    function distance(a: WorldPoint | Tile, b: WorldPoint | Tile): number;

    // Class-based registration.
    function register(plugin: Plugin): void;

    /** Cross-runtime coordinated break utility. SDK 97+. */
    const breakHandler: BreakHandlerUtility;

    // Logging.
    function log(message: string): void;
    /**
     * printf-style one-line log. Supports `%s %d %i %f %x %%`. Missing
     * arguments are left as the raw specifier.
     * @example titan.logf("hp=%d tick=%d", hp, tick);
     */
    function logf(fmt: string, ...args: unknown[]): void;

    /**
     * Query factories — each returns a freshly materialised, chainable
     * query over live game state. Each domain exposes relevant filters, such
     * as `.nameContains(...)`, `.within(...)`, or widget `.textContains(...)`.
     * Consume with terminals such as `.first()`, `.forEach(...)`,
     * `.toArray()`, `.count()`, and `.any()`.
     */
    namespace queries {
        function npcs(): NpcQuery;
        function players(): PlayerQuery;
        function objects(radius?: number): ObjectQuery;
        function groundItems(radius?: number): GroundItemQuery;
        function inventory(): InventoryQuery;
        function projectiles(): ProjectileQuery;
        /** Active map-tile spot animations (GraphicsObject). SDK 57+. */
        function graphicsObjects(): GraphicsObjectQuery;
        /** Loaded widgets plus recursively reachable dynamic descendants. SDK 64+. */
        function widgets(groupId?: number): WidgetQuery;
    }

    /**
     * Subsystem state and actions. Each member is a const object that
     * reads (and sometimes writes) a single subsystem. Plugin authors
     * dot into these — no chaining, no factories.
     */
    namespace state {
        const client: {
            readonly tick: number;
            readonly plane: number;
            readonly playerCount: number;
            /** Scene base X in absolute world tile coordinates. */
            readonly baseX: number;
            /** Scene base Y in absolute world tile coordinates. */
            readonly baseY: number;
            /** Active/current WorldView id. SDK 84+. */
            readonly currentWorldViewId: number;
            /** Top-level scene base X in absolute world tile coordinates. SDK 84+. */
            readonly topLevelBaseX: number;
            /** Top-level scene base Y in absolute world tile coordinates. SDK 84+. */
            readonly topLevelBaseY: number;
            /** Top-level WorldView plane. SDK 84+. */
            readonly topLevelPlane: number;
            /** Top-level loaded scene width in tiles. SDK 84+. */
            readonly topLevelSceneSizeX: number;
            /** Top-level loaded scene height in tiles. SDK 84+. */
            readonly topLevelSceneSizeY: number;
            /** Local player's projected tile in the top-level WorldView. SDK 85+. */
            readonly topLevelLocalPlayerTileX: number;
            /** Local player's projected tile in the top-level WorldView. SDK 85+. */
            readonly topLevelLocalPlayerTileY: number;
            /** Projected local-player plane in the top-level WorldView. SDK 85+. */
            readonly topLevelLocalPlayerPlane: number;
            /** True when the top-level local-player projection is available. SDK 85+. */
            readonly topLevelLocalPlayerTileValid: boolean;
            /** Loaded scene width in tiles. SDK 52+. */
            readonly sceneSizeX: number;
            /** Loaded scene height in tiles. SDK 52+. */
            readonly sceneSizeY: number;
            readonly loggedIn: boolean;
            /** Run energy (0-10000). Divide by 100 for the orb percentage. */
            readonly runEnergy: number;
            /** Player weight in kg (signed; negative with weight-reducing gear). */
            readonly weight: number;
            /** Raw account type varbit (`titan.Varbits.ACCOUNT_TYPE`). */
            readonly accountType: number;
            /** True for ironman account modes, including group variants. */
            readonly isIronman: boolean;
            /** Alias for `isIronman`. */
            readonly isIronMan: boolean;
            /** True for GIM / HCGIM / UGIM account modes. */
            readonly isGroupIronman: boolean;
            /** Alias for `isGroupIronman`. */
            readonly isGroupIronMan: boolean;
            readonly localPlayer: Player | null;
            /** True when the active client scene uses non-identity instance templates. SDK 86+. */
            isInInstance(): boolean;
            /** Active instance template chunks as [plane][chunkX][chunkY], or null when unavailable. SDK 86+. */
            getInstanceTemplateChunks(): InstanceTemplateChunks | null;
            /** Active minimap red-flag destination in scene-local precise coords. SDK 82+. */
            getLocalDestinationLocation(): LocalPoint | null;
            /** Active minimap red-flag destination in world coords. SDK 82+. */
            getWorldDestinationLocation(): WorldPoint | null;
            /**
             * Dispatch a fully-specified menu-action entry. Mirrors
             * `titan::ClientFacade::invokeMenuAction(...)` in C++.
             * Omitted click coordinates are randomized on the active
             * game screen.
             * Set `skipClick = true` to suppress the synthetic click phase
             * in both packet and WndProc modes. The DoAction still fires
             * directly, but the player does not move toward the click target.
             */
            invokeMenuAction(action: MenuActionSpec): boolean;
        };

        const camera: {
            readonly yaw: number;
            readonly pitch: number;
            readonly zoom: number;
            readonly isValid: boolean;
            readonly viewportW: number;
            readonly viewportH: number;
            /** World-space camera X position (sub-tile units). Added in SDK 39. */
            readonly posX: number;
            /** World-space camera Y position (sub-tile units). Added in SDK 39. */
            readonly posY: number;
            /** World-space camera Z (height) position. Added in SDK 39. */
            readonly posZ: number;
            /**
             * Live UI-frame -> physical interface-scale factor plus canvas
             * origin, derived from the game's canvas coordinate transform
             * (`physical = widget * scale + canvasOrigin`). `scaleX`/`scaleY`
             * are 1.0 at 100% in-game interface scaling, ~1.5 at 150%, ~2.0 at
             * 200%; independent of Windows display scaling. `isValid` is false
             * (and the fields fall back to identity) when the host predates
             * SDK 109 or the analyzer didn't detect the transform. Use this to
             * scale a plugin's own fixed-pixel geometry so it lines up with the
             * host-positioned widget overlays. Added in SDK 109.
             */
            interfaceScale(): {
                scaleX: number;
                scaleY: number;
                canvasOriginX: number;
                canvasOriginY: number;
                isValid: boolean;
            };
            /** Horizontal interface-scale factor (1.0 when unavailable). SDK 109. */
            readonly interfaceScaleX: number;
            /** Vertical interface-scale factor (1.0 when unavailable). SDK 109. */
            readonly interfaceScaleY: number;
        };

        /** Visible native world-map display state and transforms. SDK 113+. */
        const worldMap: WorldMapFacade;

        /** Entity hiding (render-function overrides). */
        const hider: {
            players: boolean;
            npcs: boolean;
            self: boolean;
            scene: boolean;
        };

        /** Global sound playback suppression. When true, the sound hooks
         * still fire `onSoundPlayed` but skip the native playback call (synth
         * entries are dropped from the queue; jingles are not played).
         * Added in SDK 69. */
        const audio: {
            playbackDisabled: boolean;
        };
    }

    // Cache definition lookups.
    interface ItemDef {
        id: number;
        name: string;
        isMembers: boolean;
        stackable: boolean;
        noted: boolean;
        noteId: number;
        /** Other item id in the note pair; -1 when there is no note pair. */
        linkedId: number;
        inventoryActions: string[];
        groundActions: string[];
        /** Raw opcode-43 submenu labels. Always 5 parent slots by 20 submenu
         * slots; empty strings preserve positional gaps. Added in SDK 106. */
        subOps: string[][];
    }
    interface NpcDef {
        id: number;
        name: string;
        combatLevel: number;
        size: number;
        actions: string[];
        transformVarbit: number;
        transformVarp: number;
        transformDefault: number;
    }
    interface ObjDef {
        id: number;
        name: string;
        actions: string[];
        sizeX: number;
        sizeY: number;
        blocksMovement: boolean;
        transformVarbit: number;
        transformVarp: number;
        transformDefault: number;
    }
    interface VarbitDef {
        id: number;
        varpIndex: number;
        lowBit: number;
        highBit: number;
        /**
         * Where the `{varpIndex, lowBit, highBit}` triple came from.
         * Current hosts return `"disk"` for `titan.state.cache.varbit(id)`:
         * the definition comes from Titan-owned JS5 cache data and does not
         * walk the game's live VarBitType cache.
         * `"live"` and `"native"` remain part of the union for older hosts
         * and diagnostic/native comparison flows.
         * Added in SDK 58.
         */
        source: 'live' | 'native' | 'disk';
    }
    namespace state {
        const cache: {
            item(id: number): ItemDef | null;
            npc(id: number): NpcDef | null;
            obj(id: number): ObjDef | null;
            varbit(id: number): VarbitDef | null;
        };

        /**
         * Raw var reads. Skill / prayer queries live on
         * `titan.state.skills` / `titan.state.prayers` (SDK 39+).
         *
         * `varbit(id)` uses Titan-owned JS5 cache definitions plus a direct
         * varp read. It does not call native GET_VARBIT and does not walk the
         * game's live VarBitType cache, so it is safe from render/plugin
         * threads. Returns `-1` when the cache definition or parent varp is
         * unavailable.
         */
        const vars: {
            varbit(id: number): number;
            varp(id: number): number;
            /** Read a client-side integer variable, or null when unavailable. */
            varClientInt(id: number): number | null;
            /** Queue a client-side integer write for the next client tick. */
            setVarClientInt(id: number, value: number): boolean;
            /** Read a client-side string variable, or null when unavailable. */
            varClientString(id: number): string | null;
            /** Queue a client-side string write for the next client tick. */
            setVarClientString(id: number, value: string): boolean;
            /** Read an optional 64-bit client-side variable without precision loss. */
            varClientLong(id: number): bigint | null;
            /** Queue an optional 64-bit client-side write for the next client tick. */
            setVarClientLong(id: number, value: bigint): boolean;
        };

        /**
         * Skill levels and experience. Mirrors `titan::state::skills()`
         * in C++. Pass `titan.Skill.*` ordinals, PascalCase aliases, or
         * raw integer ordinals in the range 0..23.
         */
        const skills: {
            /** Current (boosted) level after temporary modifiers. */
            boosted(skill: number): number;
            /** Base level before any boost / drain. */
            real(skill: number): number;
            /** Total experience for the skill. */
            experience(skill: number): number;
        };

        /**
         * Active-prayer queries. Mirrors `titan::state::prayers()` in
         * C++. Pass `titan.Prayer.*` ordinals (added in SDK 39) or raw
         * ints.
         */
        const prayers: {
            isActive(prayer: number): boolean;
        };
    }

    // CS2 script runner + quest state.
    interface Cs2Result {
        success: boolean;
        ints: number[];
    }
    namespace state {
        const script: {
            run(scriptId: number, intArgs?: number[]): Cs2Result | null;
            runAndGetInt(scriptId: number, intArgs?: number[]): number | null;
            questState(questId: number): number;
        };
    }

    /**
     * Static composition helpers. Each utility namespace is a flat
     * collection of pure functions / accessors built on top of
     * `titan.state.*` and `titan.queries.*`. No chaining, no setup —
     * just call.
     */
    namespace utils {
        /**
         * Inventory state, query, and action helpers. Composes
         * `titan.queries.inventory()` and `titan.state.widgets.find(...)`.
         * Added in SDK 41.
         */
        const inventory: {
            /** True when the inventory tab widget is currently visible. */
            readonly isOpen: boolean;
            /** True when every inventory slot is occupied. */
            readonly isFull: boolean;
            /** True when no inventory slot is occupied. */
            readonly isEmpty: boolean;
            /** Number of occupied slots. */
            readonly size: number;
            /** Number of empty slots (`28 - size`). */
            readonly emptySlots: number;
            /** Standard inventory capacity (28). */
            readonly capacity: number;
            /** Snapshot every occupied slot. */
            getAll(): Item[];
            /** First slot whose item id matches @p query (number) or
             *  whose display name contains @p query (case-insensitive
             *  substring when string). Returns null when no match. */
            find(query: number | string): Item | null;
            /** Item occupying @p slot (0..27), or null when empty. */
            getSlot(slot: number): Item | null;
            /** Every slot whose item id appears in @p ids. Order
             *  matches slot index, not @p ids. */
            getByIds(ids: number[]): Item[];
            /** Every slot whose display name contains any needle in
             *  @p names (case-insensitive substring). */
            getByNames(names: string[]): Item[];
            /** True when @p query occupies a slot. When @p query is a
             *  number and @p minQty is provided, requires combined
             *  quantity ≥ @p minQty (useful for stackables). */
            contains(query: number | string, minQty?: number): boolean;
            /** Combined quantity of slots whose id matches the
             *  argument; pass an array to sum across multiple ids. */
            count(idOrIds: number | number[]): number;
            /** True when ANY entry in @p arr (mixed ids / names) is
             *  in the inventory. */
            containsAny(arr: Array<number | string>): boolean;
            /** True when EVERY entry in @p arr (mixed ids / names) is
             *  in the inventory. */
            containsAll(arr: Array<number | string>): boolean;
            /** Drop the first slot matching @p query (item id when
             *  number, name substring when string). */
            drop(query: number | string): boolean;
        };

        /**
         * Dialogue / continue-prompt / quest-scroll helpers. Mirrors
         * `titan::utils::Dialogue::*` from
         * [shared/titan/utils/dialogue.h](shared/titan/utils/dialogue.h).
         * Added in SDK 39.
         */
        const dialogue: {
        /**
         * Click the active "click here to continue" widget (level-up,
         * NPC dialogue continue, minigame dialog, tutorial-island
         * prompt, ...). @returns true when a continue widget was found
         * and the click was queued.
         */
        continueDialogue(): boolean;
        /** True when a continue prompt or a multi-option dialog is visible. */
        readonly inDialogue: boolean;
        /** Click the "Make" button when the make-X interface is open. */
        continueMake(): boolean;
        /** True when the quest-completion scroll is visible. */
        readonly isQuestCompletionOpen: boolean;
        /** Click the close button on the quest-completion scroll. */
        closeQuestCompletion(): boolean;
        /**
         * Packed widget id of the active continue prompt, or 0 when
         * no continue widget is up.
         */
        readonly continueWidgetPackedId: number;
        /**
         * @returns true when the multi-option dialog is visible and at
         *          least one option contains any of `needles` (case-
         *          insensitive substring).
         */
        hasOption(needles: string[]): boolean;
        /**
         * Click the first dialog option whose text matches any of
         * `needles` (case-insensitive substring). Tries needles in
         * order; the first matching option wins.
         * @returns true when a matching option was clicked.
         */
        selectOption(needles: string[]): boolean;
        /**
         * Convenience: click a matching dialog option if one is up,
         * otherwise advance a continue widget. Mirrors RuneLite's
         * `handleDialogue(String...)` helper.
         */
        handleDialogue(needles: string[]): boolean;
        };

        /**
         * Combat-orb helpers: special-attack toggle + auto-retaliate.
         * Mirrors `titan::utils::Combat::*` from
         * [shared/titan/utils/combat.h](shared/titan/utils/combat.h).
         * Added in SDK 39.
         */
        const combat: {
            /**
             * Click the special-attack orb through the normal synthetic click path.
             * `skipMovement` is retained for compatibility and does not suppress clicks.
             */
            enableSpecialAttack(skipMovement?: boolean): boolean;
            /** Special-attack energy as a percentage (0..100). */
            readonly specialAttackPercentage: number;
            /** True when the special-attack toggle is currently armed. */
            readonly isSpecialAttackEnabled: boolean;
            /** True when auto-retaliate is currently enabled. */
            readonly isAutoRetaliateEnabled: boolean;
            /** Toggle auto-retaliate. No-op (returns true) when already in the requested state. */
            setAutoRetaliate(enabled: boolean): boolean;
        };

        /**
         * Prayer active-state and toggle helpers. Mirrors
         * `titan::utils::Prayers::*` from
         * [shared/titan/utils/prayers.h](shared/titan/utils/prayers.h).
         *
         * Pass a `titan.Prayer.*` ordinal. Action methods return true when
         * the requested action was accepted or no action was needed; confirm
         * queued state changes through `isActive`.
         */
        const prayers: {
            /** True when the prayer's active-state varbit is set. */
            isActive(prayer: number): boolean;
            /** Queue a click on the prayer's widget. */
            toggle(prayer: number): boolean;
            /** Set the prayer to the requested state, avoiding redundant clicks. */
            setActive(prayer: number, enabled: boolean): boolean;
            /** Enable the prayer, avoiding a redundant click when already active. */
            enable(prayer: number): boolean;
            /** Disable the prayer, avoiding a redundant click when already inactive. */
            disable(prayer: number): boolean;
        };

        /** Mouse and click-point helpers for action dispatch. */
        const mouse: {
            /** Resolve the screen click point Titan would use for a menu action, or null if off-screen/unresolvable. */
            resolveActionClickPoint(action: MenuActionSpec): ScreenPoint | null;
        };

        /**
         * Magic spell metadata and action helpers. Bare spell selection/casts
         * use widget interaction for WIDGET_TARGET; indexed casts default to
         * CC_OP. Targeted casts select the spell, then schedule the target
         * action on the next client tick. Widget targets use widget interact;
         * entity/world target entries resolve target click points natively.
         */
        const magic: {
            readonly SpellBook: { readonly Standard: 0; readonly Ancient: 1; readonly Lunar: 2; readonly Necromancy: 3; };
            readonly Standard: {
                readonly HOME_TELEPORT: MagicSpell;
                readonly VARROCK_TELEPORT: MagicSpell;
                readonly LUMBRIDGE_TELEPORT: MagicSpell;
                readonly FALADOR_TELEPORT: MagicSpell;
                readonly TELEPORT_TO_HOUSE: MagicSpell;
                readonly CAMELOT_TELEPORT: MagicSpell;
                readonly ARDOUGNE_TELEPORT: MagicSpell;
                readonly WATCHTOWER_TELEPORT: MagicSpell;
                readonly TROLLHEIM_TELEPORT: MagicSpell;
                readonly TELEPORT_TO_APE_ATOLL: MagicSpell;
                readonly TELEPORT_TO_KOUREND: MagicSpell;
                readonly TELEOTHER_LUMBRIDGE: MagicSpell;
                readonly TELEOTHER_FALADOR: MagicSpell;
                readonly TELEPORT_TO_BOUNTY_TARGET: MagicSpell;
                readonly TELEOTHER_CAMELOT: MagicSpell;
                readonly WIND_STRIKE: MagicSpell;
                readonly WATER_STRIKE: MagicSpell;
                readonly EARTH_STRIKE: MagicSpell;
                readonly FIRE_STRIKE: MagicSpell;
                readonly WIND_BOLT: MagicSpell;
                readonly WATER_BOLT: MagicSpell;
                readonly EARTH_BOLT: MagicSpell;
                readonly FIRE_BOLT: MagicSpell;
                readonly WIND_BLAST: MagicSpell;
                readonly WATER_BLAST: MagicSpell;
                readonly EARTH_BLAST: MagicSpell;
                readonly FIRE_BLAST: MagicSpell;
                readonly WIND_WAVE: MagicSpell;
                readonly WATER_WAVE: MagicSpell;
                readonly EARTH_WAVE: MagicSpell;
                readonly FIRE_WAVE: MagicSpell;
                readonly WIND_SURGE: MagicSpell;
                readonly WATER_SURGE: MagicSpell;
                readonly EARTH_SURGE: MagicSpell;
                readonly FIRE_SURGE: MagicSpell;
                readonly SARADOMIN_STRIKE: MagicSpell;
                readonly CLAWS_OF_GUTHIX: MagicSpell;
                readonly FLAMES_OF_ZAMORAK: MagicSpell;
                readonly CRUMBLE_UNDEAD: MagicSpell;
                readonly IBAN_BLAST: MagicSpell;
                readonly MAGIC_DART: MagicSpell;
                readonly CONFUSE: MagicSpell;
                readonly WEAKEN: MagicSpell;
                readonly CURSE: MagicSpell;
                readonly BIND: MagicSpell;
                readonly SNARE: MagicSpell;
                readonly VULNERABILITY: MagicSpell;
                readonly ENFEEBLE: MagicSpell;
                readonly ENTANGLE: MagicSpell;
                readonly STUN: MagicSpell;
                readonly TELE_BLOCK: MagicSpell;
                readonly CHARGE: MagicSpell;
                readonly BONES_TO_BANANAS: MagicSpell;
                readonly LOW_LEVEL_ALCHEMY: MagicSpell;
                readonly SUPERHEAT_ITEM: MagicSpell;
                readonly HIGH_LEVEL_ALCHEMY: MagicSpell;
                readonly BONES_TO_PEACHES: MagicSpell;
                readonly LVL_1_ENCHANT: MagicSpell;
                readonly LVL_2_ENCHANT: MagicSpell;
                readonly LVL_3_ENCHANT: MagicSpell;
                readonly CHARGE_WATER_ORB: MagicSpell;
                readonly LVL_4_ENCHANT: MagicSpell;
                readonly CHARGE_EARTH_ORB: MagicSpell;
                readonly CHARGE_FIRE_ORB: MagicSpell;
                readonly CHARGE_AIR_ORB: MagicSpell;
                readonly LVL_5_ENCHANT: MagicSpell;
                readonly LVL_6_ENCHANT: MagicSpell;
                readonly LVL_7_ENCHANT: MagicSpell;
                readonly TELEKINETIC_GRAB: MagicSpell;
            };
            readonly Ancient: {
                readonly EDGEVILLE_HOME_TELEPORT: MagicSpell;
                readonly PADDEWWA_TELEPORT: MagicSpell;
                readonly SENNTISTEN_TELEPORT: MagicSpell;
                readonly KHARYRLL_TELEPORT: MagicSpell;
                readonly LASSAR_TELEPORT: MagicSpell;
                readonly DAREEYAK_TELEPORT: MagicSpell;
                readonly CARRALLANGER_TELEPORT: MagicSpell;
                readonly BOUNTY_TARGET_TELEPORT: MagicSpell;
                readonly ANNAKARL_TELEPORT: MagicSpell;
                readonly GHORROCK_TELEPORT: MagicSpell;
                readonly SMOKE_RUSH: MagicSpell;
                readonly SHADOW_RUSH: MagicSpell;
                readonly BLOOD_RUSH: MagicSpell;
                readonly ICE_RUSH: MagicSpell;
                readonly SMOKE_BURST: MagicSpell;
                readonly SHADOW_BURST: MagicSpell;
                readonly BLOOD_BURST: MagicSpell;
                readonly ICE_BURST: MagicSpell;
                readonly SMOKE_BLITZ: MagicSpell;
                readonly SHADOW_BLITZ: MagicSpell;
                readonly BLOOD_BLITZ: MagicSpell;
                readonly ICE_BLITZ: MagicSpell;
                readonly SMOKE_BARRAGE: MagicSpell;
                readonly SHADOW_BARRAGE: MagicSpell;
                readonly BLOOD_BARRAGE: MagicSpell;
                readonly ICE_BARRAGE: MagicSpell;
            };
            readonly Lunar: {
                readonly LUNAR_HOME_TELEPORT: MagicSpell;
                readonly MOONCLAN_TELEPORT: MagicSpell;
                readonly TELE_GROUP_MOONCLAN: MagicSpell;
                readonly OURANIA_TELEPORT: MagicSpell;
                readonly WATERBIRTH_TELEPORT: MagicSpell;
                readonly TELE_GROUP_WATERBIRTH: MagicSpell;
                readonly BARBARIAN_TELEPORT: MagicSpell;
                readonly TELE_GROUP_BARBARIAN: MagicSpell;
                readonly KHAZARD_TELEPORT: MagicSpell;
                readonly TELE_GROUP_KHAZARD: MagicSpell;
                readonly FISHING_GUILD_TELEPORT: MagicSpell;
                readonly TELE_GROUP_FISHING_GUILD: MagicSpell;
                readonly CATHERBY_TELEPORT: MagicSpell;
                readonly TELE_GROUP_CATHERBY: MagicSpell;
                readonly ICE_PLATEAU_TELEPORT: MagicSpell;
                readonly TELE_GROUP_ICE_PLATEAU: MagicSpell;
                readonly MONSTER_EXAMINE: MagicSpell;
                readonly CURE_OTHER: MagicSpell;
                readonly CURE_ME: MagicSpell;
                readonly CURE_GROUP: MagicSpell;
                readonly STAT_SPY: MagicSpell;
                readonly DREAM: MagicSpell;
                readonly STAT_RESTORE_POT_SHARE: MagicSpell;
                readonly BOOST_POTION_SHARE: MagicSpell;
                readonly ENERGY_TRANSFER: MagicSpell;
                readonly HEAL_OTHER: MagicSpell;
                readonly VENGEANCE_OTHER: MagicSpell;
                readonly VENGEANCE: MagicSpell;
                readonly HEAL_GROUP: MagicSpell;
                readonly BAKE_PIE: MagicSpell;
                readonly GEOMANCY: MagicSpell;
                readonly CURE_PLANT: MagicSpell;
                readonly NPC_CONTACT: MagicSpell;
                readonly HUMIDIFY: MagicSpell;
                readonly HUNTER_KIT: MagicSpell;
                readonly SPIN_FLAX: MagicSpell;
                readonly SUPERGLASS_MAKE: MagicSpell;
                readonly TAN_LEATHER: MagicSpell;
                readonly STRING_JEWELLERY: MagicSpell;
                readonly MAGIC_IMBUE: MagicSpell;
                readonly FERTILE_SOIL: MagicSpell;
                readonly PLANK_MAKE: MagicSpell;
                readonly RECHARGE_DRAGONSTONE: MagicSpell;
                readonly SPELLBOOK_SWAP: MagicSpell;
            };
            readonly Necromancy: {
                readonly ARCEUUS_HOME_TELEPORT: MagicSpell;
                readonly ARCEUUS_LIBRARY_TELEPORT: MagicSpell;
                readonly DRAYNOR_MANOR_TELEPORT: MagicSpell;
                readonly BATTLEFRONT_TELEPORT: MagicSpell;
                readonly MIND_ALTAR_TELEPORT: MagicSpell;
                readonly RESPAWN_TELEPORT: MagicSpell;
                readonly SALVE_GRAVEYARD_TELEPORT: MagicSpell;
                readonly FENKENSTRAINS_CASTLE_TELEPORT: MagicSpell;
                readonly WEST_ARDOUGNE_TELEPORT: MagicSpell;
                readonly HARMONY_ISLAND_TELEPORT: MagicSpell;
                readonly CEMETERY_TELEPORT: MagicSpell;
                readonly BARROWS_TELEPORT: MagicSpell;
                readonly APE_ATOLL_TELEPORT: MagicSpell;
                readonly GHOSTLY_GRASP: MagicSpell;
                readonly SKELETAL_GRASP: MagicSpell;
                readonly UNDEAD_GRASP: MagicSpell;
                readonly INFERIOR_DEMONBANE: MagicSpell;
                readonly SUPERIOR_DEMONBANE: MagicSpell;
                readonly DARK_DEMONBANE: MagicSpell;
                readonly LESSER_CORRUPTION: MagicSpell;
                readonly GREATER_CORRUPTION: MagicSpell;
                readonly RESURRECT_LESSER_GHOST: MagicSpell;
                readonly RESURRECT_LESSER_SKELETON: MagicSpell;
                readonly RESURRECT_LESSER_ZOMBIE: MagicSpell;
                readonly RESURRECT_SUPERIOR_GHOST: MagicSpell;
                readonly RESURRECT_SUPERIOR_SKELETON: MagicSpell;
                readonly RESURRECT_SUPERIOR_ZOMBIE: MagicSpell;
                readonly RESURRECT_GREATER_GHOST: MagicSpell;
                readonly RESURRECT_GREATER_SKELETON: MagicSpell;
                readonly RESURRECT_GREATER_ZOMBIE: MagicSpell;
                readonly DARK_LURE: MagicSpell;
                readonly MARK_OF_DARKNESS: MagicSpell;
                readonly WARD_OF_ARCEUUS: MagicSpell;
                readonly BASIC_REANIMATION: MagicSpell;
                readonly ADEPT_REANIMATION: MagicSpell;
                readonly EXPERT_REANIMATION: MagicSpell;
                readonly MASTER_REANIMATION: MagicSpell;
                readonly DEMONIC_OFFERING: MagicSpell;
                readonly SINISTER_OFFERING: MagicSpell;
                readonly SHADOW_VEIL: MagicSpell;
                readonly VILE_VIGOUR: MagicSpell;
                readonly DEGRIME: MagicSpell;
                readonly RESURRECT_CROPS: MagicSpell;
                readonly DEATH_CHARGE: MagicSpell;
            };
            info(spell: MagicSpell): MagicSpellInfo;
            readonly currentSpellBook: 0 | 1 | 2 | 3;
            readonly isAutoCasting: boolean;
            lastHomeTeleportUsage(): Date;
            readonly isHomeTeleportOnCooldown: boolean;
            canCast(spell: MagicSpell): boolean;
            select(spell: MagicSpell): boolean;
            cast(spell: MagicSpell): boolean;
            cast(spell: MagicSpell, actionIndex: number): boolean;
            cast(spell: MagicSpell, actionIndex: number, opcode: number): boolean;
            castOn(spell: MagicSpell, target: MagicTarget): boolean;
        };
    }

    /**
     * Equipment slot ordinals matching RuneLite's
     * `EquipmentInventorySlot`. Values are stable engine semantics --
     * the slot index inside the EQUIPMENT `ItemContainer`. Added in
     * SDK 40.
     */
    const EquipmentSlot: {
        readonly HEAD: 0;
        readonly CAPE: 1;
        readonly AMULET: 2;
        readonly WEAPON: 3;
        readonly BODY: 4;
        readonly SHIELD: 5;
        readonly ARMS: 6;
        readonly LEGS: 7;
        readonly HAIR: 8;
        readonly GLOVES: 9;
        readonly BOOTS: 10;
        readonly JAW: 11;
        readonly RING: 12;
        readonly AMMO: 13;
    };

    /**
     * One occupied equipment slot. `slot` is a `titan.EquipmentSlot`
     * ordinal; `name` is the in-game display label (varbit / varp
     * transforms applied when the runtime ItemDef path is available).
     * Added in SDK 40.
     */
    interface EquippedItem {
        readonly slot: number;     // titan.EquipmentSlot ordinal
        readonly id: number;
        readonly quantity: number;
        readonly name: string;
        /** True when this entry is a real, equipped item (id > 0). */
        readonly isValid: boolean;
    }

    namespace utils {
        /**
         * Equipment query + unequip helpers. Mirrors
         * `titan::utils::Equipment::*` from
         * [shared/titan/utils/equipment.h](shared/titan/utils/equipment.h).
         * Reads compose `titan.state.itemContainer(EQUIPMENT)`;
         * `unequip*` fires a synthetic CC_OP click against the worn-
         * items slot widget with the same "Remove" menu-action shape
         * RuneLite uses for worn-item slots.
         *
         * Numeric arguments to `find` / `contains` / `unequip` are
         * treated as **item ids**; pass a `titan.EquipmentSlot` value
         * through `getSlot` / `unequipSlot` when targeting a specific
         * slot. This disambiguates ids that happen to land in
         * `[0, 13]`.
         *
         * Added in SDK 40.
         */
        const equipment: {
            /** Snapshot every occupied equipment slot. Empty when the
             *  EQUIPMENT container isn't populated on this revision. */
            getAll(): EquippedItem[];
            /** First equipped item matching @p query (item id when
             *  number, case-insensitive name substring when string).
             *  Returns null when no match. */
            find(query: number | string): EquippedItem | null;
            /** The item occupying the given `titan.EquipmentSlot`
             *  ordinal, or null when empty. */
            getSlot(slot: number): EquippedItem | null;
            /** Every equipped item whose id appears in @p ids. */
            getByIds(ids: number[]): EquippedItem[];
            /** Every equipped item whose display name contains any
             *  needle in @p names (case-insensitive substring). */
            getByNames(names: string[]): EquippedItem[];
            /** True when @p query is currently equipped. When @p query
             *  is a number and @p minQuantity is provided, requires the
             *  slot to hold at least that many charges (useful for
             *  ammo). */
            contains(query: number | string, minQuantity?: number): boolean;
            /** Combined quantity of every equipped slot whose id matches
             *  the argument. Pass an array to sum across multiple ids. */
            count(idOrIds: number | number[]): number;
            /** True when ANY entry in the array (mixed ids / names) is
             *  equipped. */
            containsAny(arr: Array<number | string>): boolean;
            /** True when EVERY entry in the array (mixed ids / names) is
             *  equipped. */
            containsAll(arr: Array<number | string>): boolean;
            /** Unequip the item identified by @p query. Numbers are
             *  item ids; strings are case-insensitive name substrings.
             *  Returns true when the remove action was accepted / queued;
             *  confirm the state change via `onItemContainerChanged`. */
            unequip(query: number | string): boolean;
            /** Unequip the item occupying the given `titan.EquipmentSlot`
             *  ordinal. No-op (returns false) when the slot is empty or
             *  has no clickable widget (ARMS / HAIR / JAW). A true return
             *  means the remove action was accepted / queued. */
            unequipSlot(slot: number): boolean;
        };

        /**
         * Bank state, query, and action helpers. Mirrors
         * `titan::utils::Bank::*` from
         * [shared/titan/utils/bank.h](shared/titan/utils/bank.h).
         * Added in SDK 44.
         */
        const bank: {
            /** True when the bank interface is open. */
            readonly isOpen: boolean;
            /** True when the GE inventory overlay is open. */
            readonly isGeOpen: boolean;
            /** True when a search/amount dialog is open (Withdraw-X). */
            readonly isSearchOpen: boolean;
            /** True when bank is in noted withdrawal mode. */
            readonly isNotedMode: boolean;
            /** Currently selected bank tab index. */
            readonly bankTab: number;
            /** True when main (all items) tab is selected. */
            readonly isMainTabOpen: boolean;
            /** True when the bank PIN prompt is visible. */
            readonly isPinVisible: boolean;
            /** Index (0-3) of the currently requested PIN digit, or -1. */
            readonly pinRequestedDigitIndex: number;

            /** Close the bank interface. */
            close(): boolean;
            /** Set noted/unnoted withdrawal mode. */
            setNotedMode(noted: boolean): boolean;
            /** Check if bank contains item by id or name, with optional minimum quantity. */
            contains(idOrName: number | string, minQty?: number): boolean;
            /** Count items in bank by id or name. */
            count(idOrName: number | string): number;
            /** Find first matching bank slot by id or name. */
            find(idOrName: number | string): BankItemSlot | null;
            /** Deposit entire inventory. */
            depositAll(): boolean;
            /** Deposit all equipped items. */
            depositEquipment(): boolean;
            /** Deposit all of item at a specific inventory slot. */
            depositAllOfSlot(slot: number): boolean;
            /** Deposit one of item at a specific inventory slot. */
            depositOneOfSlot(slot: number): boolean;
            /** Deposit all of an item by item ID. */
            depositAllOfItem(itemId: number): boolean;
            /** Deposit one of an item by item ID. */
            depositOneOfItem(itemId: number): boolean;
            /** Deposit all items except those with the given ids. */
            depositAllExcept(keepIds: number[]): boolean;
            /** Withdraw one of item by id. */
            withdrawItem(itemId: number): boolean;
            /** Withdraw all of item by id. */
            withdrawAllItem(itemId: number): boolean;
            /** Withdraw specific amount of item. */
            withdrawItemAmount(itemId: number, amount: number): boolean;
            /** Open nearest bank. */
            open(): boolean;
            /** Check if a bank is nearby. */
            isNearBank(distance?: number): boolean;
        };
    }

    // Widgets.
    interface WidgetState {
        /** Packed widget id `(groupId << 16) | childId`. Populated by the host. */
        packedId: number;
        /** Dynamic parent packed id for `children(...)` handles; 0 otherwise. SDK v63+. */
        dynamicParentPackedId: number;
        /** Native dynamic-child slot for `children(...)` handles; -1 otherwise. SDK v63+. */
        dynamicChildSlot: number;
        /** Root flat widget used to resolve this handle's retained path. SDK v64+. */
        rootPackedId: number;
        /** Native dynamic-child slots beneath `rootPackedId`. SDK v64+. */
        dynamicPath: number[];
        screenX: number;
        screenY: number;
        width: number;
        height: number;
        relativeX: number;
        relativeY: number;
        scrollX: number;
        scrollY: number;
        type: number;
        contentType: number;
        /** Primary native sprite id, or -1 when absent/unavailable. SDK v110+. */
        spriteId: number;
        opacity: number;
        itemId: number;
        itemQuantity: number;
        parentId: number;
        hidden: boolean;
        selfHidden: boolean;
        visible: boolean;
        text: string;
        /** False when a retained live widget handle is not currently present. SDK v88+. */
        exists: boolean;
        /** Return a detached plain-object copy of the widget's current fields. SDK v88+. */
        snapshot(): Record<string, unknown>;
        /**
         * Replace this widget's live display text. SDK v51+.
         * Dynamic handles automatically route through their retained
         * root-plus-slot path. SDK v64+.
         * Returns false when the host is unavailable, the widget is missing,
         * or `text` is longer than 256 UTF-8 bytes. Older offset bundles
         * retain the inline-only limit of 22 bytes.
         */
        setText(text: string): boolean;
        /**
         * Dispatch a widget-family DoAction against this exact widget. With
         * two arguments the handle itself is targeted. A third argument
         * selects one exact direct dynamic child beneath it. SDK v64+.
         *
         * @param opcode   MenuAction opcode (57 = CC_OP, 1007 = CC_OP_LOW,
         *                 39..43 = WIDGET_FIRST..FIFTH_OPTION, 25 =
         *                 WIDGET_TARGET, 2 = WIDGET_TARGET_ON_GAME_OBJECT,
         *                 8 = WIDGET_TARGET_ON_NPC, 15 = WIDGET_TARGET_ON_PLAYER,
         *                 58 = WIDGET_TARGET_ON_WIDGET).
         * @param identifier Menu-entry identifier -- the CC_OP sub-action
         *                   index, 0 for non-CC_OP opcodes. This is not a
         *                   widget packed id.
         * @param childSlot Optional direct dynamic-child slot beneath this
         *                  handle.
         * @returns true when the action was accepted / queued. Widget-driven
         *          game state changes are confirmed later by events such as
         *          `onItemContainerChanged`.
         */
        interact(opcode: number, identifier: number, childSlot?: number): boolean;
        /** Cast `spell` on this widget. */
        castOn(spell: MagicSpell): boolean;
    }
    namespace state {
        const widgets: {
            find(packedId: number): WidgetState | null;
            /**
             * Enumerate dynamic children of the widget at
             * `parentPackedId` (SDK v38+). Returns one `WidgetState`
             * per native slot ordered by slot index. Empty placeholders are
             * preserved so indexes cannot drift. Each returned snapshot
             * remembers its parent and slot for `child.setText(...)` and
             * `child.interact(opcode, identifier)`.
             *
             * Returns an empty array when the parent is missing, has no
             * dynamic children, or the host is pre-SDK-38.
             */
            children(parentPackedId: number): WidgetState[];
            pack(group: number, child: number): number;
            /**
             * Dispatch a widget-family DoAction (CC_OP,
             * WIDGET_*_OPTION, WIDGET_TARGET, WIDGET_TARGET_ON_WIDGET,
             * ...).
             *
             * @param opcode   MenuAction opcode (57 = CC_OP, 1007 = CC_OP_LOW,
             *                 39..43 = WIDGET_FIRST..FIFTH_OPTION, 25 =
             *                 WIDGET_TARGET, 2 = WIDGET_TARGET_ON_GAME_OBJECT,
             *                 8 = WIDGET_TARGET_ON_NPC, 15 = WIDGET_TARGET_ON_PLAYER,
             *                 58 = WIDGET_TARGET_ON_WIDGET).
             * @param identifier Menu-entry identifier -- the CC_OP
             *                   sub-action index, 0 for non-CC_OP opcodes.
             *                   This is not a widget packed id.
             * @param param0   Dynamic-child slot on the target widget,
             *                 or -1 for "whole widget / no slot".
             * @param param1   Packed widget id: `(group << 16) | child`.
             * @returns true when the action was accepted / queued. Widget-
             *          driven game state changes are confirmed later by
             *          events such as `onItemContainerChanged`.
             */
            interact(opcode: number, identifier: number,
                     param0: number, param1: number): boolean;
            /**
             * Replace a live widget's display text. SDK v51+.
             * Returns false when the widget is missing or `text` is longer
             * than 256 UTF-8 bytes. Older offset bundles retain the
             * inline-only limit of 22 bytes.
             */
            setText(packedId: number, text: string): boolean;
            /**
             * Replace an exact dynamic child's display text. SDK v63+.
             * Invalid, missing, or null slots fail closed without touching
             * the parent widget.
             */
            setText(parentPackedId: number, slot: number, text: string): boolean;
            /**
             * First widget whose *primary* display text contains
             * `query` (case-sensitive substring). SDK v39+ /
             * `HostApi::getWidgetByText`. Returns `null` when no match
             * or on pre-v39 hosts.
             */
            findByText(query: string): WidgetState | null;
        };

        /** Idle-timer subsystem. */
        const idle: {
            readonly remaining: number;
            reset(): void;
        };
    }

    // Login / account switch (Super Profiles port).
    enum LoginGameState {
        Unknown = -1,
        LoginScreen = 10,
        LoginAuthenticator = 11,
        LoggingIn = 20,
        LoggedIn = 30,
        HoppingWorld = 45,
    }

    interface LoginSnapshot {
        loginIndex: number;
        gameState: LoginGameState;
        /** 0 = username, 1 = password, -1 = unknown. */
        fieldToggle: number;
        oauthSwitchAvailable: boolean;
        credentialSetAvailable: boolean;
        displayNameAvailable: boolean;
        username: string;
        displayName: string;
    }

    namespace state {
        const login: {
            /** Current snapshot, or null when the analyzer did not detect the login flow. */
            snapshot(): LoginSnapshot | null;
            readonly state: LoginGameState;
            readonly index: number;
            /** True once the local player is available in-world. */
            readonly isWorldReady: boolean;
            /** True when native gameState is `LoginGameState.LoggedIn`. */
            readonly isLoggedIn: boolean;

            setUsername(username: string): void;
            setPassword(password: string): void;
            setAuthenticator(code: string): void;
            setIndex(loginIndex: number): void;
            setDisplayName(displayName: string): void;
            setOAuth2Credentials(accessToken: string, refreshToken: string): void;
            setGameSessionCredentials(sessionId: string, characterId: string): void;

            /** Composite equivalent of RuneLite's ReflectionMethods.setCharacter. */
            setCharacter(displayName: string, characterId: string, sessionId: string): void;
            /** Clear every Jagex token and flip back to the standard login screen. */
            resetCharacter(): void;
            /** Resolve an exact Account Profiles label and queue its credentials. */
            stageCredentials(profileName: string): boolean;
            /** Hold Enter through one login-screen MainLoop update, then release it. */
            submitCredentials(): boolean;
        };

        /** Walking facade. */
        const walk: {
            toScene(sceneX: number, sceneY: number): boolean;
            toWorld(worldX: number, worldY: number, plane: number): boolean;
            to(tile: Tile | WorldPoint): boolean;
        };

        /**
         * Per-tile collision map reads, one-tile step blocking, and immutable
         * bulk cache/live-scene snapshots. SDK v39+; snapshots are SDK 112+.
         * Mirrors
         * `titan::state::collisions()` / `<titan/collision.h>`.
         */
        const collisions: {
            flag(plane: number, tileX: number, tileY: number): number;
            isBlocked(plane: number, x: number, y: number, dx: number, dy: number): boolean;
            /** Copy all four planes of a 64x64 mapsquare. */
            cachedRegion(regionId: number): CachedCollisionRegion | null;
            /** Copy the full loaded scene and its instance-template mapping. */
            currentScene(): LiveCollisionScene | null;
            readonly Flag: {
                readonly WALL_SE_CORNER: number;
                readonly WALL_SOUTH: number;
                readonly WALL_SW_CORNER: number;
                readonly WALL_WEST: number;
                readonly WALL_NW_CORNER: number;
                readonly WALL_NORTH: number;
                readonly WALL_NE_CORNER: number;
                readonly WALL_EAST: number;
                readonly BLOCK_FLOOR: number;
                readonly BLOCK_FLOOR_DECORATION: number;
                readonly BLOCK_OBJECT: number;
                readonly BLOCK_FULL: number;
                readonly BLOCK_MOVE: number;
                readonly BLOCKED_WEST: number;
                readonly BLOCKED_EAST: number;
                readonly BLOCKED_SOUTH: number;
                readonly BLOCKED_NORTH: number;
                readonly BLOCKED_SW: number;
                readonly BLOCKED_SE: number;
                readonly BLOCKED_NW: number;
                readonly BLOCKED_NE: number;
            };
        };
    }

    /** Account/login facade; alias of `titan.state.login`. */
    const login: typeof state.login;

    // Plugin manager.
    const plugins: {
        all(): PluginHandle[];
        /** Return a handle for `id`, regardless of whether the host knows it.
         *  Call `.isValid` on the result if you need to distinguish. */
        get(id: string): PluginHandle;
        /** Like `get` but returns `null` for unknown ids. */
        find(id: string): PluginHandle | null;
        readonly self: PluginHandle & (() => PluginHandle);
    };

    // Overlay draw API -- call from inside Overlay::render callbacks.
    const overlay: {
        tileQuad(tileX: number, tileY: number, plane: number,
                 fillColor: number, outlineColor: number): void;
        tileRegion(minTileX: number, minTileY: number, maxTileX: number, maxTileY: number,
                   plane: number, fillColor: number, outlineColor: number): void;
        tileQuadInWorldView(worldViewId: number, tileX: number, tileY: number, plane: number,
                            fillColor: number, outlineColor: number): void;
        tileRegionInWorldView(worldViewId: number,
                              minTileX: number, minTileY: number,
                              maxTileX: number, maxTileY: number,
                              plane: number, fillColor: number, outlineColor: number): void;
        worldTileRegionInWorldView(worldViewId: number,
                                   minWorldX: number, minWorldY: number,
                                   maxWorldX: number, maxWorldY: number,
                                   plane: number, fillColor: number,
                                   outlineColor: number): void;
        entityBox(entity: Npc | Player, color: number, height?: number): void;
        entityBoxAt(preciseX: number, preciseY: number, plane: number,
                    tileSize: number, height: number, color: number): void;
        /**
         * Draw the accurate world-space AABB clickbox around an entity. Reads
         * the per-entity AABB from the game's scene-graph cache and projects
         * the 8 corners through W2S; silent no-op when the analyzer did not
         * detect the GraphNode / AABB offsets on this revision, or on
         * pre-SDK-33 hosts.
         *
         * @param outline ARGB colour (0xAARRGGBB) for the 12 edges (0 hides edges).
         * @param fill    Optional ARGB colour (0xAARRGGBB) for the 6 faces (0 hides fills).
         */
        entityClickbox(entity: Npc | Player, outline: number, fill?: number): void;
        /**
         * Raw entry for plugins that already hold the entity pointer and
         * its typecode. Passing `typecode = 0` skips typecode-keyed lookup
         * and falls back to the host's world-keyed fallback cache.
         */
        entityClickboxRaw(entityPtr: number | bigint, typecode: number | bigint,
                          outline: number, fill?: number): void;
        /** Tile-object (wall, decor, standing loc, ground decor) equivalent. */
        tileObjectClickbox(obj: TileObject, outline: number, fill?: number): void;
        tileObjectClickboxRaw(locPtr: number | bigint, typecode: number | bigint,
                              outline: number, fill?: number): void;
        /**
         * Draw the 2D convex hull of an entity's projected AABB corners --
         * a clean closed silhouette. Same data source as entityClickbox
         * but reduced to the outer outline. Recommended "highlight this
         * entity" primitive. Future SDK versions may upgrade the source
         * to real model vertices.
         */
        entityHull(entity: Npc | Player, outline: number, fill?: number): void;
        entityHullRaw(entityPtr: number | bigint, typecode: number | bigint,
                      outline: number, fill?: number): void;
        tileObjectHull(obj: TileObject, outline: number, fill?: number): void;
        tileObjectHullRaw(locPtr: number | bigint, typecode: number | bigint,
                          outline: number, fill?: number): void;
        textAtWorld(worldX: number, worldY: number, worldZ: number,
                    text: string, color: number, centered?: boolean): void;
        textAtWorldInWorldView(worldViewId: number,
                               preciseX: number, worldY: number, preciseY: number,
                               plane: number, text: string, color: number,
                               centered?: boolean): void;
        textAtWorldTileInWorldView(worldViewId: number,
                                   worldTileX: number, worldY: number, worldTileY: number,
                                   plane: number, text: string, color: number,
                                   centered?: boolean): void;
        screenText(x: number, y: number, text: string, color: number): void;
        screenRect(x: number, y: number, w: number, h: number, color: number): void;
        screenLine(x1: number, y1: number, x2: number, y2: number,
                   color: number, thickness?: number): void;
        worldToScreen(worldX: number, worldY: number, worldZ: number): ScreenPoint | null;
        worldToScreenInWorldView(worldViewId: number,
                                 preciseX: number, worldY: number,
                                 preciseY: number, plane: number): ScreenPoint | null;
        tileToScreen(tileX: number, tileY: number, plane: number,
                     heightOffset?: number): ScreenPoint | null;
        tileHeight(preciseX: number, preciseY: number, plane: number): number;
        tileHeightInWorldView(worldViewId: number,
                              preciseX: number, preciseY: number,
                              plane: number): number;
        worldTileHeightInWorldView(worldViewId: number,
                                   worldTileX: number, worldTileY: number,
                                   plane: number): number;
    };

    // Frame-phase schedulers.
    function runOnClientTick(cb: () => void): void;
    function runOnRender(cb: () => void): void;

    // Chat injection (SDK 22). `name` and `sender` accept empty strings.
    // No packet is sent -- the line appears only on this client.
    function addChatMessage(type: number, name: string, message: string, sender: string): void;

    /** Fluent chat facade; also see the free function `titan.addChatMessage`. */
    const chat: {
        /** Inject a line into the local chatbox. */
        add(type: number, name: string, message: string, sender?: string): void;
        /** Convenience: post a SERVER-type system line (no sender). */
        system(message: string): void;
        /** Convenience: post a PUBLIC-type line attributed to `name`. */
        say(name: string, message: string): void;
    };

    /**
     * Game-internal keyboard injection (SDK 42+). Synthetic
     * `WM_KEYDOWN` / `WM_CHAR` / `WM_KEYUP` messages are dispatched
     * directly to the game's registered WndProc on the message-pump
     * thread. The injected events take the same path as a hardware
     * keystroke -- UI updates, server packets, listener callbacks,
     * and hotkey bindings all fire normally -- without crossing the
     * kernel LL-hook boundary, so anti-cheat detection of injected
     * input does not apply.
     *
     * Functions return `false` when the underlying offsets are not
     * available on the running revision. Calls are queued onto the
     * Win32 message-pump thread automatically when invoked from any
     * other thread.
     *
     * Example:
     * ```ts
     * titan.keyboard.sendString("hello");
     * titan.keyboard.sendKey(titan.keyboard.Key.Enter);
     * titan.keyboard.sendKey(titan.keyboard.Key.Tab,
     *                        titan.keyboard.Mod.Shift);
     * ```
     *
     * Notes:
     *  - The "always-focused" hook in the client makes injection work
     *    even when the game window is in the background; users who
     *    rely on focus-loss pause behaviour can disable it from the
     *    controller's Settings tab.
     *  - All keys in `Key` (including F-keys, arrows, and page
     *    navigation) deliver real Win32 VK codes, so the game's own
     *    VK->internal translation handles them; no calibration
     *    needed.
     */
    const keyboard: {
        /**
         * Type a string. Each printable character is delivered as
         * `WM_CHAR` to the game's WndProc; `\n`/`\r`/`\b`/`\t` are
         * escalated to a press+release of the matching control
         * key so e.g. submitting a chat message still works.
         */
        sendString(text: string): boolean;
        /**
         * Press AND release a single key, optionally bracketed by
         * a modifier (Shift / Ctrl / Alt). `mods` is a bitmask
         * built from `titan.keyboard.Mod` constants.
         */
        sendKey(key: number, mods?: number): boolean;
        /** Symbolic keys -- pass to `sendKey`. */
        readonly Key: {
            readonly Enter: 0;
            readonly Escape: 1;
            readonly Backspace: 2;
            readonly Delete: 3;
            readonly Tab: 4;
            readonly Space: 5;
            readonly Home: 6;
            readonly End: 7;
            readonly PageUp: 8;
            readonly PageDown: 9;
            readonly Insert: 10;
            readonly ArrowUp: 11;
            readonly ArrowDown: 12;
            readonly ArrowLeft: 13;
            readonly ArrowRight: 14;
            readonly F1: 15;
            readonly F2: 16;
            readonly F3: 17;
            readonly F4: 18;
            readonly F5: 19;
            readonly F6: 20;
            readonly F7: 21;
            readonly F8: 22;
            readonly F9: 23;
            readonly F10: 24;
            readonly F11: 25;
            readonly F12: 26;
            readonly Shift: 27;
            readonly Control: 28;
            readonly Alt: 29;
        };
        /** Modifier bitmask -- pass to `sendKey`'s second arg. */
        readonly Mod: {
            readonly Shift: 1;
            readonly Ctrl: 2;
            readonly Alt: 4;
        };

        /**
         * Type a string with human-like inter-character delays
         * (SDK 43+). Each character is dispatched on a separate
         * pump-thread drain cycle, spread across real time.
         *
         * If a type operation is already in progress, the old one
         * is cancelled (its callback fires with `false`) before
         * the new one starts.
         *
         * @param text The string to type.
         * @param opts Optional timing / callback-phase config.
         * @param onDone Optional completion callback. `true` when
         *   all characters were typed, `false` if cancelled.
         * @returns `true` when the typing operation was started.
         */
        typeString(
            text: string,
            opts?: {
                minDelayMs?: number;
                maxDelayMs?: number;
                /** Which thread the callback runs on. */
                callbackPhase?: "pump" | "clientTick" | "preGameLoop";
            },
            onDone?: (completed: boolean) => void,
        ): boolean;

        /** Cancel any in-progress `typeString`. Its callback fires
         *  with `false`. */
        cancelTypeString(): void;

        /** `true` while a `typeString` operation is in progress. */
        isTyping(): boolean;

        /** Callback-phase constants for `typeString` opts. */
        readonly CallbackPhase: {
            readonly Pump: "pump";
            readonly ClientTick: "clientTick";
            readonly PreGameLoop: "preGameLoop";
        };
    };

    /**
     * Chat message type ordinals. Names and values match RuneLite's
     * `ChatMessageType` enum (see
     * https://github.com/runelite/runelite/blob/master/runelite-api/src/main/java/net/runelite/api/ChatMessageType.java).
     * Pass one of these to `titan.addChatMessage(type, ...)` or compare
     * against `ChatMessageEvent.type` in `onChatMessage`.
     */
    const ChatMessageType: {
        readonly GAMEMESSAGE: 0;
        readonly MODCHAT: 1;
        readonly PUBLICCHAT: 2;
        readonly PRIVATECHAT: 3;
        readonly ENGINE: 4;
        readonly LOGINLOGOUTNOTIFICATION: 5;
        readonly PRIVATECHATOUT: 6;
        readonly MODPRIVATECHAT: 7;
        readonly FRIENDSCHAT: 9;
        readonly FRIENDSCHATNOTIFICATION: 11;
        readonly TRADE_SENT: 12;
        readonly BROADCAST: 14;
        readonly SNAPSHOTFEEDBACK: 26;
        readonly ITEM_EXAMINE: 27;
        readonly NPC_EXAMINE: 28;
        readonly OBJECT_EXAMINE: 29;
        readonly FRIENDNOTIFICATION: 30;
        readonly IGNORENOTIFICATION: 31;
        readonly CLAN_CHAT: 41;
        readonly CLAN_MESSAGE: 43;
        readonly CLAN_GUEST_CHAT: 44;
        readonly CLAN_GUEST_MESSAGE: 46;
        readonly AUTOTYPER: 90;
        readonly MODAUTOTYPER: 91;
        readonly CONSOLE: 99;
        readonly TRADEREQ: 101;
        readonly TRADE: 102;
        readonly CHALREQ_TRADE: 103;
        readonly CHALREQ_FRIENDSCHAT: 104;
        readonly SPAM: 105;
        readonly PLAYERRELATED: 106;
        readonly TENSECTIMEOUT: 107;
        readonly WELCOME: 108;
        readonly CLAN_CREATION_INVITATION: 109;
        readonly CHALREQ_CLANCHAT: 110;
        readonly CLAN_GIM_FORM_GROUP: 111;
        readonly CLAN_GIM_GROUP_WITH: 112;
        readonly DIALOG: 114;
        readonly MESBOX: 115;
        readonly NPC_SAY: 116;
        readonly DIDYOUKNOW: 117;
        readonly LEVELUPMESSAGE: 118;
    };

    /**
     * Well-known item-container ids. Pass one of these (or a raw int) to
     * `titan.state.itemContainer()`. Matches RuneLite's `InventoryID`.
     * Added in SDK 26.
     */
    const InventoryID: {
        readonly INVENTORY: 93;
        readonly EQUIPMENT: 94;
        readonly BANK: 95;
    };

    namespace state {
        /**
         * Read a snapshot of the requested container. Returns null when the
         * native cache has no matching entry or its analyzer-provided layout
         * fails validation. Added in SDK 26; export capacity raised to 2,048
         * occupied entries in SDK 111.
         */
        function itemContainer(id: number): ItemContainerSnapshot | null;

        /**
         * Resolve the RUNTIME ItemDef for the given id. Game-thread calls may
         * invoke the native resolver on a live-table miss. Off-thread calls
         * emit a rate-limited warning, check the live table without invoking
         * native code, then fall back to raw cache metadata when absent (check
         * `runtimeResolved`). Returns null when neither source contains the id.
         * Added in SDK 26.
         */
        function itemDef(id: number): ItemComposition | null;
    }

    /**
     * Snapshot of a single world entry. Mirrors the native `GameWorld`
     * struct fields the analyzer detects at runtime. `string0` /
     * `string1` carry the two eastl::basic_string fields on the entry;
     * which one is "activity" vs "location" varies by revision and the
     * SDK doesn't guess. Added in SDK 28.
     */
    interface World {
        readonly id: number;
        readonly flags: number;     // bit 0 = members, bit 16 = beta
        readonly isMembers: boolean;
        readonly isBeta: boolean;
        readonly string0: string;
        readonly string1: string;
    }

    /**
     * SLR-backed world metadata from Jagex's official world list. Unlike
     * `World`, these fields have stable meanings and include the measured
     * ping cache. Added in SDK 83.
     */
    interface WorldMetadata {
        readonly id: number;
        readonly flags: number;     // bit 0 = members, bit 16 = beta
        readonly isMembers: boolean;
        readonly isBeta: boolean;
        readonly host: string;
        readonly activity: string;
        readonly location: number;
        readonly population: number;
        readonly pingMs: number;
        readonly region: string;
    }

    namespace state {
        namespace world {
            /**
             * Live current-world id from the game singleton. Returns
             * null when the analyzer did not emit
             * `CURRENT_WORLD_OFFSET` on the loaded revision. Added in
             * SDK 28.
             */
            function current(): number | null;

            /**
             * Full snapshot of the native world list. Returns an empty
             * array when the analyzer did not emit the list globals or
             * GameWorld field offsets. Even when this is empty,
             * `hopByListIndex()` may still work. Added in SDK 28.
             */
            function list(): World[];

            /**
             * SLR-backed world metadata from Jagex's official world list.
             * Returns the last good snapshot; pings are -1 while unknown.
             * Added in SDK 83.
             */
            function metadata(): WorldMetadata[];

            /**
             * Force an asynchronous SLR metadata refresh and ping probe
             * queue. Added in SDK 83.
             */
            function refreshMetadata(): boolean;

            /**
             * Dispatch a **title-screen** hop to a specific world id.
             * Calls native `changeWorld` synchronously on the game
             * thread's main loop. Returns true iff the id was found in
             * the live list and the hop function is available. Use
             * this only when the player is NOT logged in -- see
             * `hopIngame` for the logged-in path. Plugins should
             * debounce hops (server boots rapid hoppers). Added in
             * SDK 28.
             */
            function hop(id: number): boolean;

            /**
             * Lower-tier title-screen variant: hop by position in the
             * native m_list. Works when the full list snapshot is
             * unavailable. Added in SDK 28.
             */
            function hopByListIndex(idx: number): boolean;

            /**
             * Dispatch an **in-game** hop via the native 3x CC_OP
             * footer sequence (opens logout tab, opens switcher,
             * selects world, confirms). Progresses asynchronously
             * across several client ticks; the return value is
             * "accepted?" -- true when the request was queued, false
             * when the state machine is already busy, the world id
             * isn't in the live list, or the analyzer data needed to
             * drive the widget clicks is missing. Use this when
             * `state.login.isLoggedIn` returns true. Added in SDK 31.
             */
            function hopIngame(id: number): boolean;
        }
    }

    // ---- Removed flat free-function spellings ----
    //
    // SDK 41 dropped the flat `titan.getNpcs()` / `titan.containsInventoryItem`
    // / etc. spellings entirely. Use the namespaced equivalents:
    //
    //   - `titan.queries.npcs() / players() / objects() / groundItems() /
    //     inventory() / projectiles()` for entity enumeration.
    //   - `titan.state.client / camera / widgets / skills / prayers / vars /
    //     script / walk / idle / login / hider / audio / cache / collisions /
    //     itemContainer / itemDef / world.*` for subsystem state.
    //   - `titan.utils.inventory / equipment / combat / dialogue / mouse` for
    //     composition helpers.
    //   - `titan.overlay.*` for rendering primitives.
    //   - `titan.state.client.invokeMenuAction(...)` for raw menu
    //     dispatch.

    /**
     * RuneLite-aligned `MenuAction` opcode ids (DoAction). Matches
     * `titan::MenuAction::Id` in `shared/titan/menu_action.h`.
     */
    const MenuAction: {
        readonly ITEM_USE_ON_GAME_OBJECT: 1;
        readonly WIDGET_TARGET_ON_GAME_OBJECT: 2;
        readonly ITEM_USE_ON_NPC: 7;
        readonly WIDGET_TARGET_ON_NPC: 8;
        readonly ITEM_USE_ON_PLAYER: 14;
        readonly WIDGET_TARGET_ON_PLAYER: 15;
        readonly ITEM_USE_ON_GROUND_ITEM: 16;
        readonly WIDGET_TARGET_ON_GROUND_ITEM: 17;
        readonly WALK: 23;
        readonly WIDGET_TYPE_1: 24;
        readonly WIDGET_TARGET: 25;
        readonly WIDGET_CLOSE: 26;
        readonly WIDGET_TYPE_4: 28;
        readonly WIDGET_TYPE_5: 29;
        readonly WIDGET_CONTINUE: 30;
        readonly WALK_HERE: 31;
        readonly WIDGET_USE_ON_ITEM: 32;
        readonly ITEM_USE: 38;
        readonly CC_OP: 57;
        readonly WIDGET_TARGET_ON_WIDGET: 58;
        readonly CANCEL: 1006;
        readonly CC_OP_LOW_PRIORITY: 1007;
    };

    /** Raw ClientObj ownership type for ground items. */
    const GroundItemOwnership: {
        readonly NONE: 0;
        readonly SELF_PLAYER: 1;
        readonly OTHER_PLAYER: 2;
        readonly GROUP_IRONMAN: 3;
    };

    /** Well-known CS2 script IDs. */
    const ScriptID: {
        readonly QUEST_STATUS_GET: 4029;
        readonly UPDATE_SCROLLBAR: 72;
        readonly BUILD_CHATBOX: 216;
        readonly CHAT_SEND: 5517;
        readonly CHAT_TEXT_INPUT_REBUILD: 222;
        readonly MESSAGE_LAYER_CLOSE: 299;
        readonly MESSAGE_LAYER_OPEN: 677;
        readonly CAMERA_DO_ZOOM: 42;
        readonly XPDROP_DISABLED: 2091;
        readonly TOPLEVEL_REDRAW: 907;
        readonly BANKMAIN_BUILD: 277;
        readonly BANKMAIN_SEARCH_TOGGLE: 281;
        readonly BANKMAIN_SEARCH_REFRESH: 283;
        readonly GE_OFFERS_SETUP_BUILD: 779;
        readonly GE_ITEM_SEARCH: 752;
        readonly COMBAT_INTERFACE_SETUP: 7593;
        readonly HP_HUD_UPDATE: 2103;
        readonly PRAYER_UPDATEBUTTON: 463;
        readonly PRAYER_REDRAW: 547;
        readonly ORBS_UPDATE_RUNENERGY: 447;
        readonly INVENTORY_DRAWITEM: 6011;
        readonly FRIENDS_UPDATE: 631;
        readonly IGNORE_UPDATE: 630;
        readonly PVP_WIDGET_BUILDER: 388;
        readonly XPDROPS_SETDROPSIZE: 996;
        readonly WIKI_ICON_UPDATE: 3306;
        readonly QUEST_UPDATE_LINECOUNT: 2523;
        readonly WORLDMAP_LOADMAP: 1712;
        readonly COLLECTION_DRAW_LIST: 2731;
    };

    /**
     * Skill ordinals matching the game's internal stat array. Mirrors
     * `titan::Skill` in [shared/titan/skill.h](shared/titan/skill.h).
     * Uppercase members are canonical; PascalCase aliases mirror them for JS.
     * Pass to `titan.state.skills.boosted/real/experience(...)`. Added in SDK 39.
     */
    const Skill: {
        readonly ATTACK: 0;
        readonly Attack: 0;
        readonly DEFENCE: 1;
        readonly Defence: 1;
        readonly STRENGTH: 2;
        readonly Strength: 2;
        readonly HITPOINTS: 3;
        readonly Hitpoints: 3;
        readonly RANGED: 4;
        readonly Ranged: 4;
        readonly PRAYER: 5;
        readonly Prayer: 5;
        readonly MAGIC: 6;
        readonly Magic: 6;
        readonly COOKING: 7;
        readonly Cooking: 7;
        readonly WOODCUTTING: 8;
        readonly Woodcutting: 8;
        readonly FLETCHING: 9;
        readonly Fletching: 9;
        readonly FISHING: 10;
        readonly Fishing: 10;
        readonly FIREMAKING: 11;
        readonly Firemaking: 11;
        readonly CRAFTING: 12;
        readonly Crafting: 12;
        readonly SMITHING: 13;
        readonly Smithing: 13;
        readonly MINING: 14;
        readonly Mining: 14;
        readonly HERBLORE: 15;
        readonly Herblore: 15;
        readonly AGILITY: 16;
        readonly Agility: 16;
        readonly THIEVING: 17;
        readonly Thieving: 17;
        readonly SLAYER: 18;
        readonly Slayer: 18;
        readonly FARMING: 19;
        readonly Farming: 19;
        readonly RUNECRAFT: 20;
        readonly Runecraft: 20;
        readonly HUNTER: 21;
        readonly Hunter: 21;
        readonly CONSTRUCTION: 22;
        readonly Construction: 22;
        readonly SAILING: 23;
        readonly Sailing: 23;
    };

    /**
     * Prayer ordinals (standard book + Ruinous Powers). Mirrors
     * `titan::Prayer` in [shared/titan/prayer.h](shared/titan/prayer.h).
     * Pass to `titan.state.prayers.isActive(...)`. Added in SDK 39.
     */
    const Prayer: {
        readonly THICK_SKIN: 0;
        readonly BURST_OF_STRENGTH: 1;
        readonly CLARITY_OF_THOUGHT: 2;
        readonly SHARP_EYE: 3;
        readonly MYSTIC_WILL: 4;
        readonly ROCK_SKIN: 5;
        readonly SUPERHUMAN_STRENGTH: 6;
        readonly IMPROVED_REFLEXES: 7;
        readonly RAPID_RESTORE: 8;
        readonly RAPID_HEAL: 9;
        readonly PROTECT_ITEM: 10;
        readonly HAWK_EYE: 11;
        readonly MYSTIC_LORE: 12;
        readonly STEEL_SKIN: 13;
        readonly ULTIMATE_STRENGTH: 14;
        readonly INCREDIBLE_REFLEXES: 15;
        readonly PROTECT_FROM_MAGIC: 16;
        readonly PROTECT_FROM_MISSILES: 17;
        readonly PROTECT_FROM_MELEE: 18;
        readonly EAGLE_EYE: 19;
        readonly MYSTIC_MIGHT: 20;
        readonly RETRIBUTION: 21;
        readonly REDEMPTION: 22;
        readonly SMITE: 23;
        readonly CHIVALRY: 24;
        readonly DEADEYE: 25;
        readonly MYSTIC_VIGOUR: 26;
        readonly PIETY: 27;
        readonly PRESERVE: 28;
        readonly RIGOUR: 29;
        readonly AUGURY: 30;
        readonly RP_REJUVENATION: 31;
        readonly RP_ANCIENT_STRENGTH: 32;
        readonly RP_ANCIENT_SIGHT: 33;
        readonly RP_ANCIENT_WILL: 34;
        readonly RP_PROTECT_ITEM: 35;
        readonly RP_RUINOUS_GRACE: 36;
        readonly RP_DAMPEN_MAGIC: 37;
        readonly RP_DAMPEN_RANGED: 38;
        readonly RP_DAMPEN_MELEE: 39;
        readonly RP_TRINITAS: 40;
        readonly RP_BERSERKER: 41;
        readonly RP_PURGE: 42;
        readonly RP_METABOLISE: 43;
        readonly RP_REBUKE: 44;
        readonly RP_VINDICATION: 45;
        readonly RP_DECIMATE: 46;
        readonly RP_ANNIHILATE: 47;
        readonly RP_VAPORISE: 48;
        readonly RP_FUMUS_VOW: 49;
        readonly RP_UMBRA_VOW: 50;
        readonly RP_CRUORS_VOW: 51;
        readonly RP_GLACIES_VOW: 52;
        readonly RP_WRATH: 53;
        readonly RP_INTENSIFY: 54;
    };

    /**
     * Overhead prayer/curse icon ordinals. Mirrors `titan::HeadIcon` in
     * [shared/titan/head_icon.h](shared/titan/head_icon.h). Added in SDK 39.
     */
    const HeadIcon: {
        readonly MELEE: 0;
        readonly RANGED: 1;
        readonly MAGIC: 2;
        readonly RETRIBUTION: 3;
        readonly SMITE: 4;
        readonly REDEMPTION: 5;
        readonly RANGE_MAGE: 6;
        readonly RANGE_MELEE: 7;
        readonly MAGE_MELEE: 8;
        readonly RANGE_MAGE_MELEE: 9;
        readonly WRATH: 10;
        readonly SOUL_SPLIT: 11;
        readonly DEFLECT_MELEE: 12;
        readonly DEFLECT_RANGE: 13;
        readonly DEFLECT_MAGE: 14;
    };

    /**
     * VarPlayer (varp) indices for common player state. Mirrors
     * `titan::VarPlayerID::*` in
     * [shared/titan/var_player.h](shared/titan/var_player.h). Pass to
     * `titan.state.vars.varp(...)`. Added in SDK 39.
     */
    const VarPlayerID: {
        readonly ATTACK_STYLE: 43;
        readonly SPECIAL_ATTACK: 301;
        readonly SPECIAL_ATTACK_ENABLED: 300;
        readonly RUN_ENABLED: 173;
        readonly POISON: 102;
        readonly AUTO_RETALIATE: 172;
        readonly DISEASE: 456;
        readonly WEIGHT: 451;
        readonly HP_HUD_1: 3209;
        readonly HP_HUD_2: 3210;
        readonly PRAYER_POINTS: 2382;
        readonly LAST_HOME_TELEPORT: 892;
        /** Return the catalog identifier, or null when unnamed. */
        nameOf(id: number): string | null;
    };

    /**
     * Client-side integer variable ids. Mirrors RuneLite's `VarClientInt`
     * catalog and `titan::VarClientInt::*` in
     * [shared/titan/var_client_int.h](shared/titan/var_client_int.h).
     * Added in SDK 61.
     */
    const VarClientInt: {
        readonly TOOLTIP_TIMEOUT: 1;
        readonly TOOLTIP_VISIBLE: 2;
        readonly INPUT_TYPE: 5;
        readonly BANK_SCROLL: 51;
        readonly CAMERA_ZOOM_FIXED_VIEWPORT: 73;
        readonly CAMERA_ZOOM_RESIZABLE_VIEWPORT: 74;
        readonly MEMBERSHIP_STATUS: 103;
        readonly INVENTORY_TAB: 171;
        readonly BLOCK_KEYPRESS: 187;
        readonly WORLD_MAP_SEARCH_FOCUSED: 190;
        /** Return the compatibility-catalog identifier, or null when unnamed. */
        nameOf(id: number): string | null;
    };

    /**
     * Client-side string variable ids. Mirrors RuneLite's `VarClientStr`
     * catalog and `titan::VarClientStr::*` in
     * [shared/titan/var_client_str.h](shared/titan/var_client_str.h).
     * Added in SDK 61.
     */
    const VarClientStr: {
        readonly CHATBOX_TYPED_TEXT: 335;
        readonly INPUT_TEXT: 359;
        readonly PRIVATE_MESSAGE_TARGET: 360;
        readonly RECENT_FRIENDS_CHAT: 362;
        readonly NOTIFICATION_TOP_TEXT: 387;
        readonly NOTIFICATION_BOTTOM_TEXT: 388;
        /** Return the compatibility-catalog identifier, or null when unnamed. */
        nameOf(id: number): string | null;
    };

    /**
     * Named varbit ids. Mirrors `titan::Varbits::*` in
     * [shared/titan/varbits.h](shared/titan/varbits.h). Pass to
     * `titan.state.vars.varbit(...)`. Added in SDK 39.
     */
    const Varbits: {
        readonly QUICK_PRAYER: 4103;
        readonly PRAYER_THICK_SKIN: 4104;
        readonly PRAYER_BURST_OF_STRENGTH: 4105;
        readonly PRAYER_CLARITY_OF_THOUGHT: 4106;
        readonly PRAYER_SHARP_EYE: 4122;
        readonly PRAYER_MYSTIC_WILL: 4123;
        readonly PRAYER_ROCK_SKIN: 4107;
        readonly PRAYER_SUPERHUMAN_STRENGTH: 4108;
        readonly PRAYER_IMPROVED_REFLEXES: 4109;
        readonly PRAYER_RAPID_RESTORE: 4110;
        readonly PRAYER_RAPID_HEAL: 4111;
        readonly PRAYER_PROTECT_ITEM: 4112;
        readonly PRAYER_HAWK_EYE: 4124;
        readonly PRAYER_MYSTIC_LORE: 4125;
        readonly PRAYER_STEEL_SKIN: 4113;
        readonly PRAYER_ULTIMATE_STRENGTH: 4114;
        readonly PRAYER_INCREDIBLE_REFLEXES: 4115;
        readonly PRAYER_PROTECT_FROM_MAGIC: 4116;
        readonly PRAYER_PROTECT_FROM_MISSILES: 4117;
        readonly PRAYER_PROTECT_FROM_MELEE: 4118;
        readonly PRAYER_EAGLE_EYE: 4126;
        readonly PRAYER_MYSTIC_MIGHT: 4127;
        readonly PRAYER_RETRIBUTION: 4119;
        readonly PRAYER_REDEMPTION: 4120;
        readonly PRAYER_SMITE: 4121;
        readonly PRAYER_CHIVALRY: 4128;
        readonly PRAYER_PIETY: 4129;
        readonly PRAYER_PRESERVE: 5466;
        readonly PRAYER_RIGOUR: 5464;
        readonly PRAYER_AUGURY: 5465;
        readonly PRAYER_DEADEYE: 16090;
        readonly PRAYER_MYSTIC_VIGOUR: 16091;
        readonly PRAYER_RP_REJUVENATION: 14840;
        readonly PRAYER_RP_ANCIENT_STRENGTH: 14829;
        readonly PRAYER_RP_ANCIENT_SIGHT: 14830;
        readonly PRAYER_RP_ANCIENT_WILL: 14831;
        readonly PRAYER_RP_PROTECT_ITEM: 14966;
        readonly PRAYER_RP_RUINOUS_GRACE: 14841;
        readonly PRAYER_RP_DAMPEN_MAGIC: 14964;
        readonly PRAYER_RP_DAMPEN_RANGED: 14963;
        readonly PRAYER_RP_DAMPEN_MELEE: 14962;
        readonly PRAYER_RP_TRINITAS: 14832;
        readonly PRAYER_RP_BERSERKER: 14844;
        readonly PRAYER_RP_PURGE: 14839;
        readonly PRAYER_RP_METABOLISE: 14843;
        readonly PRAYER_RP_REBUKE: 14850;
        readonly PRAYER_RP_VINDICATION: 14851;
        readonly PRAYER_RP_DECIMATE: 14833;
        readonly PRAYER_RP_ANNIHILATE: 14834;
        readonly PRAYER_RP_VAPORISE: 14835;
        readonly PRAYER_RP_FUMUS_VOW: 14845;
        readonly PRAYER_RP_UMBRA_VOW: 14847;
        readonly PRAYER_RP_CRUORS_VOW: 14846;
        readonly PRAYER_RP_GLACIES_VOW: 14848;
        readonly PRAYER_RP_WRATH: 14842;
        readonly PRAYER_RP_INTENSIFY: 14965;
        readonly PRAYERBOOK: 14826;
        readonly SPELLBOOK: 4070;
        readonly SPELLBOOK_SUBMENU: 9730;
        readonly RUN_SLOWED_DEPLETION_ACTIVE: 25;
        readonly STAMINA_EFFECT: 24;
        readonly ANTIFIRE: 3981;
        readonly SUPER_ANTIFIRE: 6101;
        readonly MAGIC_IMBUE: 5438;
        readonly VENGEANCE_ACTIVE: 2450;
        readonly VENGEANCE_COOLDOWN: 2451;
        readonly IMBUED_HEART_COOLDOWN: 5361;
        readonly RING_OF_ENDURANCE_EFFECT: 10385;
        readonly DIVINE_SUPER_ATTACK: 8429;
        readonly DIVINE_SUPER_STRENGTH: 8430;
        readonly DIVINE_SUPER_DEFENCE: 8431;
        readonly DIVINE_RANGING: 8432;
        readonly DIVINE_MAGIC: 8433;
        readonly DIVINE_SUPER_COMBAT: 13663;
        readonly DIVINE_BASTION: 13664;
        readonly DIVINE_BATTLEMAGE: 13665;
        readonly DEATH_CHARGE: 12411;
        readonly DEATH_CHARGE_COOLDOWN: 12138;
        readonly RESURRECT_THRALL: 12413;
        readonly SHADOW_VEIL: 12414;
        readonly SHADOW_VEIL_COOLDOWN: 12291;
        readonly NMZ_OVERLOAD_REFRESHES_REMAINING: 3955;
        readonly COX_OVERLOAD_REFRESHES_REMAINING: 5418;
        readonly MULTICOMBAT_AREA: 4605;
        readonly IN_WILDERNESS: 5963;
        readonly PVP_SPEC_ORB: 8121;
        readonly ACCOUNT_TYPE: 1777;
        readonly EQUIPPED_WEAPON_TYPE: 357;
        readonly BOSS_HEALTH_CURRENT: 6099;
        readonly BOSS_HEALTH_MAXIMUM: 6100;
        readonly BOSS_HEALTH_OVERLAY: 12389;
        readonly SLAYER_POINTS: 4068;
        readonly SLAYER_TASK_STREAK: 4069;
        readonly SLAYER_TASK_BOSS: 4723;
        readonly SUPERIOR_ENABLED: 5362;
        readonly IN_RAID: 5432;
        readonly RAID_STATE: 5425;
        readonly RAID_TOTAL_POINTS: 5431;
        readonly THEATRE_OF_BLOOD: 6440;
        readonly TOA_RAID_LEVEL: 14380;
        readonly TOA_RAID_DAMAGE: 14325;
        readonly BANK_REARRANGE_MODE: 3959;
        readonly CURRENT_BANK_TAB: 4150;
        readonly BANK_QUANTITY_TYPE: 6590;
        readonly BANK_LEAVEPLACEHOLDERS: 3755;
        readonly DIARY_ARDOUGNE_EASY: 4458;
        readonly DIARY_ARDOUGNE_MEDIUM: 4459;
        readonly DIARY_ARDOUGNE_HARD: 4460;
        readonly DIARY_ARDOUGNE_ELITE: 4461;
        readonly DIARY_DESERT_EASY: 4483;
        readonly DIARY_DESERT_MEDIUM: 4484;
        readonly DIARY_DESERT_HARD: 4485;
        readonly DIARY_DESERT_ELITE: 4486;
        readonly DIARY_FALADOR_EASY: 4462;
        readonly DIARY_FALADOR_MEDIUM: 4463;
        readonly DIARY_FALADOR_HARD: 4464;
        readonly DIARY_FALADOR_ELITE: 4465;
        readonly DIARY_VARROCK_EASY: 4479;
        readonly DIARY_VARROCK_MEDIUM: 4480;
        readonly DIARY_VARROCK_HARD: 4481;
        readonly DIARY_VARROCK_ELITE: 4482;
        readonly DIARY_LUMBRIDGE_EASY: 4495;
        readonly DIARY_LUMBRIDGE_MEDIUM: 4496;
        readonly DIARY_LUMBRIDGE_HARD: 4497;
        readonly DIARY_LUMBRIDGE_ELITE: 4498;
        readonly DIARY_MORYTANIA_EASY: 4487;
        readonly DIARY_MORYTANIA_MEDIUM: 4488;
        readonly DIARY_MORYTANIA_HARD: 4489;
        readonly DIARY_MORYTANIA_ELITE: 4490;
        readonly DIARY_KANDARIN_EASY: 4475;
        readonly DIARY_KANDARIN_MEDIUM: 4476;
        readonly DIARY_KANDARIN_HARD: 4477;
        readonly DIARY_KANDARIN_ELITE: 4478;
        readonly DIARY_FREMENNIK_EASY: 4491;
        readonly DIARY_FREMENNIK_MEDIUM: 4492;
        readonly DIARY_FREMENNIK_HARD: 4493;
        readonly DIARY_FREMENNIK_ELITE: 4494;
        readonly DIARY_WILDERNESS_EASY: 4466;
        readonly DIARY_WILDERNESS_MEDIUM: 4467;
        readonly DIARY_WILDERNESS_HARD: 4468;
        readonly DIARY_WILDERNESS_ELITE: 4469;
        readonly DIARY_WESTERN_EASY: 4471;
        readonly DIARY_WESTERN_MEDIUM: 4472;
        readonly DIARY_WESTERN_HARD: 4473;
        readonly DIARY_WESTERN_ELITE: 4474;
        readonly DIARY_KARAMJA_EASY: 3578;
        readonly DIARY_KARAMJA_MEDIUM: 3599;
        readonly DIARY_KARAMJA_HARD: 3611;
        readonly DIARY_KARAMJA_ELITE: 4566;
        readonly DIARY_KOUREND_EASY: 7925;
        readonly DIARY_KOUREND_MEDIUM: 7926;
        readonly DIARY_KOUREND_HARD: 7927;
        readonly DIARY_KOUREND_ELITE: 7928;
        readonly TELEBLOCK: 4163;
        readonly NMZ_ABSORPTION: 3956;
        readonly NMZ_POINTS: 3949;
        readonly DRAGONFIRE_SHIELD_COOLDOWN: 6539;
        readonly MENAPHITE_REMEDY: 14448;
        readonly BUFF_STAT_BOOST: 14344;
        readonly COLOSSEUM_DOOM: 9801;
        readonly TRANSPARENT_CHATBOX: 4608;
        readonly SIDE_PANELS: 4607;
        readonly EXPERIENCE_TRACKER_POSITION: 4692;
    };

    const QuestID: {
        readonly COOKS_ASSISTANT: 17;
        readonly DRAGON_SLAYER_I: 31;
        readonly DRAGON_SLAYER_II: 32;
        readonly RECIPE_FOR_DISASTER: 117;
        readonly MONKEY_MADNESS_I: 95;
        readonly MONKEY_MADNESS_II: 96;
        readonly DESERT_TREASURE_I: 27;
        readonly DESERT_TREASURE_II: 2343;
        readonly SONG_OF_THE_ELVES: 137;
        readonly SINS_OF_THE_FATHER: 134;
        readonly A_NIGHT_AT_THE_THEATRE: 104;
        readonly PRIEST_IN_PERIL: 111;
        readonly LEGENDS_QUEST: 85;
        readonly REGICIDE: 119;
        readonly UNDERGROUND_PASS: 154;
        readonly WATERFALL_QUEST: 158;
        readonly LUNAR_DIPLOMACY: 88;
        readonly DREAM_MENTOR: 33;
        readonly THE_FREMENNIK_EXILES: 55;
        readonly MAKING_FRIENDS_WITH_MY_ARM: 91;
        readonly BONE_VOYAGE: 11;
        readonly X_MARKS_THE_SPOT: 162;
        readonly WHILE_GUTHIX_SLEEPS: 3467;
        readonly DEFENDER_OF_VARROCK: 3466;
        readonly THE_FINAL_DAWN: 5189;
    };

}
