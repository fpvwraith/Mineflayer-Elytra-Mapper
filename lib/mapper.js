// Autonomous spawn-mapping loop for the SERVICE bot (ARGUS_TOOLS).
//
// Two-base design (robust against the base bed being griefed near spawn):
//   * FAR base  = a hidden bed (respawn point) + an ender chest of elytras.
//   * LAUNCH base = a platform near the mapping zone with the `spawn` /home set.
//
// The loop: respawn on the far bed -> grab an elytra from the ender chest there
// -> `/home spawn` to the launch base (works because the far base is outside the
// 5k no-/home ring, and it saves burning the elytra on the commute) -> step off
// the platform, deploy the elytra and firework-boost (mineflayer's own elytra
// API - see the flight notes below) -> cruise the zone in long lawnmower sweeps,
// rendering the terrain straight into the PUBLIC community tile pyramid
// (map.argus.tools) -> elytra wears out -> die -> respawn on the far bed ->
// repeat. Losing an elytra per run is expected. If a chest isn't reachable
// where it respawned (e.g. the bed was lost -> world spawn), it /kills to try
// the bed again, and auto-stops with a diagnostic after a few failures.
//
// This writes tiles to LOCAL DISK only (web/public/community-tiles/...), served
// by the local web process - it NEVER fetches argus.tools/map.argus.tools over
// the network, so it can't loop requests back through the Pi's own tunnel (see
// CLAUDE.md's home-network rule).
//
// Deliberately kept OUT of bot-core.js's honeypot flow: the only thing it needs
// from there is a render callback (renderMappingPng, which needs bot-core's
// private sampling closures) and a couple of busy/za gates. Everything else -
// the state machine, flight control, ender-chest withdrawal, gap targeting and
// the slice-into-pyramid step - lives here.
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./json-store.js');

// Persisted on/off intent AND the active mode, so a process restart or an
// overnight 6b6t maintenance bounce doesn't silently leave mapping off (and
// resumes the SAME mode it was running). `start(mode)` writes enabled:true; both
// `!map off` and the 3-failed-runs auto-stop write enabled:false - so this only
// ever reflects "the operator wants mapping running", never a run the code
// deliberately ended. bot-core reads wasEnabled() when the bot lands back on the
// main server and auto-resumes that mode if enabled.
let STATE_FILE = path.join(process.cwd(), 'mapper_state.json'); // default; overridden by deps.stateFile
function persistEnabled(enabled, mode, rotating, rotateSet) {
    try { writeJsonAtomic(STATE_FILE, { enabled, mode: mode || 'spawn', rotating: !!rotating, rotateSet: (Array.isArray(rotateSet) && rotateSet.length) ? rotateSet : null, at: new Date().toISOString() }); } catch (e) { /* non-fatal */ }
}
function wasEnabledPersisted() {
    try {
        const s = readJsonSafe(STATE_FILE, { enabled: false });
        return { enabled: !!s.enabled, mode: s.mode || 'spawn', rotating: !!s.rotating, rotateSet: (Array.isArray(s.rotateSet) && s.rotateSet.length) ? s.rotateSet : null };
    } catch (e) { return { enabled: false, mode: 'spawn', rotating: false, rotateSet: null }; }
}

const MIN_ZOOM = -6;
const MAX_ZOOM = 3;

// --- Mapping modes: `!map on <mode>` --------------------------------------
// 'spawn' = the original +/-SPAWN_RADIUS grid around 0,0. The other eight map a
// corridor ALONG one of the compass highways instead: starting HIGHWAY_START
// blocks out from 0,0 (deliberately skipping the laggy spawn-build cluster) and
// running out to HIGHWAY_END, a HIGHWAY_HALF_WIDTH swath either side of the axis
// line. Same global GRID_STEP lattice as the grid mode, so cell keys and the
// seed-from-disk coverage check stay consistent across modes.
const HIGHWAY_START = 5500;        // begin the corridor OUTSIDE the 5k spawn zone: skips the already-mapped, build-dense inner zone where the parse-error-triggering bad chunks live and where the bot can't /home-recover. Must be >= KEEPOUT_RADIUS so no highway target sits inside the keep-out.
// Highway modes keep the bot OUT of this circle around spawn entirely (steerFlight
// routes around it). 5000 is 6b6t's no-/home ring; +300 margin keeps us clear of
// it and of the spawn-build bad chunks (~4919 out) that corrupt the chunk stream
// and strand the bot. Spawn mode is exempt (its whole job is mapping inside 5k).
const KEEPOUT_RADIUS = 5300;
const HIGHWAY_END = 30000000;      // out to the 30M world border. Cheap now that buildWaypoints walks the axis (~0.27M cells single-lane), not a bounding-box scan. Coverage grows outward and resumes across runs, so one elytra just maps as far as it reaches before breaking.
// Hug the axis: keep only waypoints within HIGHWAY_HALF_WIDTH of the highway
// line (x=0 for north/south, z=0 for east/west). At ±50 on the GRID_STEP=112
// lattice this resolves to just the on-axis lane (the next lattice cell sits 112
// out, past ±50) - so the bot flies one straight pass up the axis instead of
// wandering across a wide corridor and scattering coverage to the side (the bug
// this fixes). The render footprint (2*RENDER_RADIUS+1 = 113 wide) still paints a
// swath either side of the line, so the highway + immediate surroundings get
// mapped. Bump to >=112 for extra parallel lanes if a broader corridor is wanted.
const HIGHWAY_HALF_WIDTH = 50;
// value = [dx, dz] axis direction (z+ is south, z- is north, matching the map).
const MAPPING_MODES = {
    spawn: null, // grid mode (fills through the centre) - special-cased in buildWaypoints
    ring: null,  // AREA fill of the +/-RING_OUTER box MINUS the dodgy centre - special-cased in buildWaypoints; keep-out routing arcs around the hole. This is the "render as much of +/-10k spawn as possible without flying into the centre" mode.
    north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
    ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1]
};
// Ring-fill bounds: cover the +/-RING_OUTER box around spawn but EXCLUDE anything
// inside RING_INNER of 0,0 (the parse-error build cluster - same radius as the
// highway keep-out, the boundary we know is safe to fly). Everything from the
// keep-out edge out to the +/-10k box gets area coverage.
const RING_INNER = 5300;          // = KEEPOUT_RADIUS: don't map inside this (dodgy centre)
const RING_OUTER = 10000;         // +/-10k box edge (corners reach ~14k)

// --- Tunables -------------------------------------------------------------
const SPAWN_RADIUS = 5000;        // "spawn" is +/- 5000 blocks in each axis (per the operator)
const GRID_STEP = 112;            // waypoint spacing; ~= one render footprint (2*RENDER_RADIUS+1=113) so adjacent flight lines' swaths overlap instead of leaving parallel gaps
const MAX_CELL = Math.floor(SPAWN_RADIUS / GRID_STEP) * GRID_STEP; // 4960
// Render radius, passed to the render callback so bot-core and here can't drift.
// Dropped 80 -> 56: at 80 the top-down raycast is 161x161 = 25,921 columns and
// blocks the event loop ~3s per render (confirmed live: render=3119ms) - longer
// than the render interval, so the cadence fix was capped AND a flying bot froze
// for 3s each time. 56 -> 113x113 = 12,769 columns (~half), ~1.3-1.6s, comfortably
// under the interval. Footprint 113 still overlaps at 3s intervals (~100 blocks
// travelled), keeping coverage solid.
const RENDER_RADIUS = 56;         // blocks each side of the bot per render (113x113 columns)
// --- Flight: mineflayer's OWN elytra API + a Meteor-ElytraBoost-equivalent ----
// mineflayer-elytrafly is not used at all. It failed because doInstantFly() sends
// the elytra-deploy while standing on the ground, which is invalid in vanilla
// (mineflayer's own bot.elytraFly() throws "Unable to fly from ground"), and its
// packet omits entityId - so 6b6t rejected it and resynced the bot every time.
//
// Instead, exactly what Meteor's ElytraBoost does, in mineflayer terms:
//   1. leave the ground (walk off the platform edge) so a deploy is legal,
//   2. bot.elytraFly()  -> proper start_elytra_flying packet; the server confirms
//      by setting the entity metadata bit, which mineflayer reflects in
//      bot.entity.elytraFlying,
//   3. bot.fireworkRocketDuration = N while gliding -> prismarine-physics applies
//      the REAL vanilla firework-boost math (no rocket consumed, same as Meteor
//      spawning a client-side FireworkRocketEntity),
//   4. steer by look direction only.
// The resulting trajectory is physically legitimate, so the positions we report
// match what the server expects - which is why this works on a normal client.
// Altitude is held as a GENEROUS BAND, not a target. The firework boost is a
// sawtooth (~0.47 up for ~1.25s, then sag until the next one), so a narrow band
// is narrower than the natural oscillation and the bot fights itself every tick -
// climbing, diving, stalling, never settling. A wide deadband lets it sit in
// PITCH_LEVEL and just fly, correcting only when it genuinely leaves the band.
// Flown HIGH on purpose. Nothing can be built above Y319, so at 360+ there is
// simply nothing to collide with - confirmed live, a bot cruising at Y320 flew
// straight into an obsidian build sitting at build limit. Altitude costs us
// nothing either: the map render raycasts downward from Y320 regardless of how
// high the bot is, so flying higher doesn't degrade coverage at all.
// Behaviour: gentle climb while below MIN, level flight inside the band, nose
// down only if it somehow gets above MAX.
const CRUISE_Y_MIN = 360;
const CRUISE_Y_MAX = 450;
const BOOST_TICKS = 25;           // ~ a flight-1 rocket: 10*(1+1) + a few, per mineflayer's own formula
const BOOST_REFRESH_AT = 3;       // top the boost back up when it has this few ticks left
// Cruise-speed governor. Firework boost otherwise pins the bot near elytra top
// speed (~1.6 b/tick ≈ 33 b/s), which outruns the render pipeline (~2.5s/render)
// and leaves gaps - especially on diagonal headings. We instead hold ~20 b/s so
// a render-every-RENDER_STEP-blocks pass overlaps cleanly. TARGET is in
// blocks/TICK (20 ticks/s), so 1.0 = 20 b/s. GOVERN_BOOST_TICKS is a short nudge
// used at cruise (vs the full BOOST_TICKS kick used to recover from a stall) so
// we hold near the target instead of overshooting back to top speed.
const TARGET_CRUISE_BPT = 1.0;    // ~20 blocks/sec cruise cap
const GOVERN_BOOST_TICKS = 8;     // gentle top-up pulse while cruising under the cap
// Pitch sign: mineflayer's own lookAt does `pitch = atan2(delta.y, groundDist)`,
// so looking at something ABOVE you yields a POSITIVE pitch. Positive = UP.
// Climb SHALLOW. An elytra trades airspeed for altitude, so a steep nose-up
// attitude under boost stalls it outright - confirmed live: at pitch 0.30 the bot
// sat at one spot with vel=(0.04, 0.467, 0), i.e. all thrust going vertical and
// ZERO forward speed, until the stuck-guard killed it. Real elytra+firework climbs
// are shallow and keep the airspeed up.
const PITCH_UP = 0.12;            // gentle climb that preserves forward speed
const PITCH_LEVEL = 0.05;         // very slightly nose-up holds altitude while boosting
const PITCH_DOWN = -0.15;         // nose-down to shed height
// Stall recovery: below this horizontal speed (blocks/tick) while gliding, ignore
// the altitude target and dive to rebuild airspeed - the same thing you'd do on a
// real elytra. Without this the bot can sit hovering until the stuck-guard kills it.
const STALL_SPEED = 0.25;
const PITCH_STALL_RECOVER = -0.35; // decisive nose-down to regain airspeed
// After deploying we must NOT climb immediately: with no horizontal speed yet, a
// steep boosted climb just carries the bot back up onto its own launch platform
// and it lands (confirmed live: GLIDING at Y282 -> "no longer gliding" at Y306,
// the platform's exact height). So fly ~level until clear of the base, building
// speed, and only then climb to cruise.
const DEPART_DIST = 140;          // blocks of horizontal separation from the launch point before climbing
const LAUNCH_TIMEOUT_MS = 12000;  // give up walking off the edge after this
const DEPLOY_CONFIRM_MS = 6000;   // wait this long for the server to confirm elytraFlying
const ARRIVE_DIST = GRID_STEP / 2;// consider a waypoint reached within half a cell
// Render cadence must be fast enough that consecutive renders OVERLAP, or the bot
// literally outruns its own mapping. Measured live: cruise is ~1.6 blocks/tick =
// ~32 blocks/sec, so at the old 6000ms it travelled ~192 blocks between renders
// while each render only covers 161 - leaving a ~30 block unmapped stripe every
// single time. At 3000ms it covers ~96 blocks between renders, giving ~65 blocks
// (40%) of overlap. renderAndSlice's busySlicing guard means that if a render
// ever takes longer than this, calls are simply skipped rather than piling up.
const RENDER_INTERVAL_MS = 2500;  // fallback/min gap between renders (also the ARRIVE render's floor)
// Render by DISTANCE flown, not by wall-clock: render every RENDER_STEP blocks of
// travel so coverage never depends on frame timing or a slow render/slice (a
// timing hiccup used to leave big holes while the bot kept flying). 70 < the
// 113-block footprint, so consecutive footprints overlap even on a 45° diagonal
// heading (70 diagonal = ~50 per axis < the 56-block half-footprint). Paired with
// the ~20 b/s governor, 70 blocks takes ~3.5s - comfortably longer than a render -
// so the pipeline keeps pace and passes come out solid.
const RENDER_STEP = 70;
const HOME_BLOCKED_RADIUS = 5000; // 6b6t blocks /home within 5k of spawn - which is the whole mapping zone. So teleporting back only works from the far death-respawn; within 5k the bot must reach an ender chest on foot (or /kill to reset).
const HOME_RETRY_MS = 45000;      // if a /home hasn't landed us within 5k after this long (it was on cooldown and silently rejected, or mid-warmup), re-issue it. Covers 6b6t's ~15s /home warmup with margin.
const HOME_SETTLE_MS = 18000;     // gotolaunch: wait this long for a /home to actually land (covers 6b6t's ~15s warmup) before treating it as rejected
const HOME_COOLDOWN_MS = 315000;  // ARGUS_TOOLS' /home cooldown is 300s (rank perk); 315s adds margin. Runs cycle faster than this, so between runs /home is usually still cooling down - gotolaunch must WAIT it out at the far base rather than launch from there (the far base has no takeoff edge, which stranded the bot before).
const LAUNCH_SKIP_HOME_DIST = 5000; // skip the /home-to-launch-base hop and launch from here ONLY if we're inside the 5k ring (where /home is blocked anyway). Beyond 5k we can /home, so ALWAYS do - otherwise a mid-flight-restart reconnect at, say, 5.2k would try to launch from that random spot (no platform edge) and 3-strike auto-stop, which is exactly what happened. The real launch base is reached via /home from the far base (hypot >> 5k), so this never affects the normal flow.
const ACQUIRE_MAX_MS = 120000;    // spend up to 2 min trying to find+reach an ender chest (walk to one in render, else wander and keep looking) before giving up and /kill-ing to reset
const PREP_TIMEOUT_MS = 150000;   // hard backstop around the whole acquire step (its own deadline is ACQUIRE_MAX_MS; this only catches a truly hung openContainer)
const FALL_TIMEOUT_MS = 30000;    // if we somehow don't die after the elytra breaks, /kill
const KILL_RETRY_MS = 35000;      // 6b6t's /kill has a ~30s cooldown; pace recovery /kills just above it so they aren't silently rejected. Getting home from a stranding is a patient /kill loop, NOT a failed run.
const MAX_RECOVER_KILLS = 6;      // if this many recovery /kills in a row all leave us stranded inside 5k (no base/chest), the bed is genuinely gone -> auto-stop instead of looping forever
const ROTATION_ORDER = ['north', 'ne', 'east', 'se', 'south', 'sw', 'west', 'nw']; // clockwise; `!map on rotate` cycles through these, one full elytra run each
const ROTATE_MIN_DIST = 12000;    // a run must reach ~this far (straight-line from launch) to count as "reached rough max distance" and trigger a rotate - a full elytra does ~20-30k, a crash/early-death is <10k, so 12k cleanly separates "went the distance" from "died early"; move to the next highway on a full run
const ROTATE_MAX_SHORT_RUNS = 2;  // ...but rotate anyway after this many short (crashed/early) runs on one highway, so a bad spot can't pin the rotation on one direction forever
const MIN_FOUND_FRACTION = 0.04;  // don't bother slicing a render that found almost nothing (mostly unloaded)
const SEED_COVERAGE_FRAC = 0.7;   // seedCoveredFromDisk marks a cell already-covered only if >= this fraction of its render-footprint tiles exist (not just ANY one). Stops a neighbouring highway swath from marking partially-rendered cells "covered" and leaving thin unfilled seams; those partial cells get re-flown instead.
const RECONNECT_GRACE_MS = 6000;  // after a reconfigure/reconnect, ignore flight-failure timers this long (physics is frozen then; see the guard in tick())
const HARD_STALL_MS = 90000;      // backstop: if position is truly frozen this long (not a brief reconnect) - e.g. flying into UNLOADED chunks at the far ring edge, where physicsEnabled goes false and the reconnect-grace guard would otherwise suppress the stuck-guard FOREVER - /kill out of it (seen: frozen 22 min at the +/-10k edge)
const TICK_MS = 500;
// --------------------------------------------------------------------------

function createSpawnMapper(deps) {
    // deps: { getBot, sendLog, Vec3, renderMappingPng, saveTile, loadCoveredCells,
    //         canRun, stateFile, mapConfig }
    const { getBot, sendLog, Vec3, renderMappingPng, saveTile, loadCoveredCells } = deps;
    if (deps.stateFile) STATE_FILE = deps.stateFile;
    const HOME_NAME = (deps.mapConfig && deps.mapConfig.homeName) || 'spawn';

    let active = false;            // operator toggle (!map on/off)
    let state = 'idle';
    let stateSince = Date.now();
    let lastHomeAt = 0;            // timestamp of the last SUCCESSFUL /home teleport - drives the cooldown wait in gotolaunch
    let cooldownWaitLoggedAt = 0;  // rate-limits the "waiting for /home cooldown" log
    let teleportSentAt = 0;        // when the current /home attempt was issued (0 = none pending)
    let lastRenderAt = 0;
    let lastRenderPos = null; // world {x,z} of the last successful render - drives distance-based rendering
    const covered = new Set();     // "x,z" keys of grid cells already mapped this session
    let currentTargetPt = null;    // the cell we're currently flying to
    let mappingMode = 'spawn';     // 'spawn' grid, or a highway direction (see MAPPING_MODES) - set by start(mode)
    // Lawnmower/boustrophedon path state. Lanes run ALONG sweepAxis, step one
    // GRID_STEP swath sideways between lanes, and reverse direction each lane.
    // laneIndex maps each lane (its stepping-axis coord) to that lane's sorted
    // along-axis cell coords, so pickTarget can commit to a full straight pass to a
    // lane's far end with a cheap lookup instead of re-deriving a wandering
    // corridor from the live velocity heading. See pickTarget.
    let sweepAxis = 'z';
    let sweepDir = 1;
    let laneIndex = new Map();
    let waypoints = buildWaypoints(mappingMode);
    rebuildLaneIndex();

    // Seed `covered` from tiles that ALREADY exist on disk, so a fresh process
    // life doesn't treat ground the permanent map already has as brand new.
    // There's no persistence for `covered` itself (unlike spawn_mapper_state.json's
    // enabled flag) - without this, every restart re-sweeps the WHOLE +/-5000
    // zone from scratch even where the tile pyramid already has full coverage.
    // Confirmed real: karl restarted 40 times in one session (6b6t churn +
    // deploys), each throwing away all in-memory progress while the actually-
    // rendered tiles stayed intact on disk the whole time.
    //
    // One-time bulk directory walk at construction (not per-tick, not one fs
    // call per waypoint) of the finest zoom (MAX_ZOOM, 32 blocks/tile) - cheap
    // even for thousands of existing tiles. For each waypoint, checks every
    // z=MAX_ZOOM tile overlapping a RENDER_RADIUS box around it (the same
    // radius markCoveredAround uses at runtime) against that in-memory Set -
    // no further disk I/O per waypoint, just Set.has() lookups. This is a
    // coarse proxy (tile-file-exists, not pixel-perfect), matching the same
    // "good enough" spirit as markCoveredAround's own runtime distance check -
    // a little harmless over-skipping (a tile exists but is mostly transparent)
    // is a fine trade for eliminating the much bigger problem of needlessly
    // re-flying whole already-covered regions after every restart.
    function seedCoveredFromDisk() {
        // Seed `covered` from tiles already saved to disk (the output manifest) so a
        // restart doesn't re-fly ground already mapped. Mark a waypoint covered if any
        // saved tile centre is within RENDER_RADIUS of it.
        let cells = [];
        try { cells = (typeof loadCoveredCells === 'function' && loadCoveredCells()) || []; }
        catch (e) { console.log(`[mapper] seedCoveredFromDisk failed (non-fatal): ${e.message}`); return; }
        if (!cells.length) return;
        let seeded = 0;
        for (const w of waypoints) {
            if (covered.has(cellKey(w))) continue;
            for (const c of cells) {
                if (Math.hypot(w.x - c.x, w.z - c.z) <= RENDER_RADIUS) { covered.add(cellKey(w)); seeded++; break; }
            }
        }
        console.log(`[mapper] seeded ${seeded}/${waypoints.length} waypoints as already-covered (mode ${mappingMode}), from ${cells.length} saved tiles.`);
    }
    // NB: seeding happens in start(mode) now, once the mode's waypoints are built
    // (not at construction) - so it seeds the corridor actually being flown.
    let cellsMappedThisSession = 0;
    let tilesWrittenThisSession = 0;
    let lastError = null;
    let tickTimer = null;
    let busySlicing = false;
    let outOfElytras = false;      // set when a SUCCESSFULLY-OPENED ender chest had no elytra (global inventory empty) - a definite "restock needed", distinct from a busy/lobby/transfer failure
    let prepStep = null;           // sub-state within 'prep'
    let flightStarted = false;     // elytrafly.start() called for the current run
    let launchPos = null;          // where the glide actually began (for the departure phase)
    let gotoFromPos = null;        // position when /home-to-launch-base was issued (to detect the teleport landed)
    let launchAttemptAt = 0;       // when the current launch attempt began (timeout anchor, survives launch<->deploy bouncing)
    let ascendStartY = 0;          // bot Y when the current ascent began (for a start-relative stuck check)
    let stuckAnchor = null;        // last position where the bot was making progress (for the mapping stuck guard)
    let stuckAnchorAt = 0;
    let hardStallPos = null;       // last position the bot ACTUALLY moved from (NOT reset by the reconnect-grace guard) - drives the HARD_STALL_MS backstop
    let hardStallAt = 0;
    let ascentTraced = {};         // one-shot ascent diagnostics per attempt
    let flightLog = [];            // black-box recorder for the current launch attempt (see recordFlightSample)
    const FLIGHT_LOG_MAX = 400;    // ~3.3 min at TICK_MS=500 - comfortably covers one whole attempt
    let lastReconfigureAt = 0;     // set by the hook below - lets a dump show "was this a server resync?"
    let reconfigureHookedClient = null;

    // Purely observational: also listens for the same proxy-transfer signal
    // bot-core.js already reacts to (start_configuration/finish_configuration),
    // just to timestamp it into our own trace - so a flight-log dump can show
    // whether a failure lines up with a server-side resync or not, instead of
    // guessing. Attached once per underlying client (survives bot reconnects by
    // re-checking bot._client identity each tick).
    function ensureReconfigureHook(bot) {
        if (!bot || !bot._client || reconfigureHookedClient === bot._client) return;
        reconfigureHookedClient = bot._client;
        bot._client.on('start_configuration', () => {
            lastReconfigureAt = Date.now();
            console.log('[mapper][trace] *** server start_configuration (proxy transfer) ***');
        });
    }

    // ---- black-box flight recorder -----------------------------------------
    // Records ONE sample per tick, always to console (pm2 log - cheap, and lets
    // a full trajectory be pulled after the fact), covering every field needed
    // to settle "what actually happened": position, velocity, onGround, the
    // server-reflected gliding flag, boost ticks remaining, distance travelled
    // from the launch point, look angles, and the actual block at the bot's feet
    // (so "onGround" can be checked against a REAL block, not just the flag).
    function recordFlightSample(tag) {
        const bot = getBot();
        if (!bot || !bot.entity) return;
        try {
            const e = bot.entity;
            const dist = launchPos ? Math.hypot(e.position.x - launchPos.x, e.position.z - launchPos.z) : null;
            let feetBlock = '?';
            try { const b = bot.blockAt(e.position.offset(0, -1, 0)); feetBlock = b ? b.name : 'air/unloaded'; } catch (err) {}
            const sample = {
                t: Date.now(), tag, state,
                x: +e.position.x.toFixed(2), y: +e.position.y.toFixed(2), z: +e.position.z.toFixed(2),
                vx: +e.velocity.x.toFixed(3), vy: +e.velocity.y.toFixed(3), vz: +e.velocity.z.toFixed(3),
                onGround: e.onGround, gliding: !!e.elytraFlying, elytra: hasElytraEquipped(),
                boost: bot.fireworkRocketDuration || 0,
                yaw: +e.yaw.toFixed(2), pitch: +e.pitch.toFixed(2),
                dist: dist !== null ? Math.round(dist) : null,
                feetBlock,
                sinceReconfigureMs: lastReconfigureAt ? Date.now() - lastReconfigureAt : null
            };
            sample.health = typeof bot.health === 'number' ? bot.health : null; // fall/terrain damage would show up here BEFORE a death event fires
            flightLog.push(sample);
            if (flightLog.length > FLIGHT_LOG_MAX) flightLog.shift();
            const horiz = Math.hypot(sample.vx, sample.vz).toFixed(2); // airspeed: the number that reveals a stall at a glance
            console.log(`[mapper][trace] ${tag} state=${state} pos=${sample.x},${sample.y},${sample.z} onGround=${sample.onGround} gliding=${sample.gliding} elytra=${sample.elytra} boost=${sample.boost} vel=${sample.vx},${sample.vy},${sample.vz} speed=${horiz} pitch=${sample.pitch} feet=${sample.feetBlock} dist=${sample.dist} health=${sample.health} sinceReconfig=${sample.sinceReconfigureMs}`);
        } catch (err) {
            // Was silently swallowed before - that's exactly how a real bug goes
            // invisible (e.g. entity briefly null right around a death). Log it.
            console.log(`[mapper][trace] recordFlightSample(${tag}) threw: ${err.message}`);
        }
    }

    // Dumps the last N samples to Discord as a compact table - called whenever
    // a flight attempt ends in a way worth explaining, so the operator sees the
    // actual trajectory instead of a two-line before/after summary.
    function dumpFlightLog(reason, count = 16) {
        if (flightLog.length === 0) { sendLog(`🔬 [mapper] flight trace (${reason}): no samples recorded.`); return; }
        const recent = flightLog.slice(-count);
        const t0 = recent[0].t;
        const header = 't(s)  Y      onGrnd gliding boost vX,vY,vZ              hp  dist  feet';
        const lines = recent.map(s =>
            `${((s.t - t0) / 1000).toFixed(1).padStart(4)}  ${s.y.toFixed(1).padStart(6)} ${String(s.onGround).padEnd(6)} ${String(s.gliding).padEnd(7)} ${String(s.boost).padStart(5)} ${(s.vx + ',' + s.vy + ',' + s.vz).padEnd(20)} ${String(s.health).padStart(3)} ${String(s.dist).padStart(5)}  ${s.feetBlock}`
        );
        sendLog(`🔬 [mapper] FLIGHT TRACE (${reason}), last ${recent.length} ticks:\n\`\`\`\n${header}\n${lines.join('\n')}\n\`\`\``);
    }

    // NOTE: do NOT send elytrafly's sendStartStopPacket() ourselves. It's a
    // TOGGLE (forceStop() uses the very same packet to STOP flight), so sending
    // it after the plugin's own doInstantFly() has already deployed just switches
    // the elytra back off. Use the plugin as documented: equip an elytra, call
    // start(), then steer with setControlState + yaw. Nothing else.

    // Why an ascent isn't climbing: is elytrafly still attached (its physicsTick
    // handler present), is the elytra still on, is any upward velocity actually
    // being applied, and are we stuck on the ground?
    function traceAscent(tag) {
        const bot = getBot();
        const p = botPos();
        try {
            sendLog(`🗺️ [mapper] ${tag}: Y=${p ? p.y.toFixed(1) : '?'} onGround=${bot.entity.onGround} velY=${bot.entity.velocity.y.toFixed(3)} gliding=${isGliding()} boost=${bot.fireworkRocketDuration || 0} elytra=${hasElytraEquipped()} physics=${bot.physicsEnabled}`);
        } catch (e) {}
    }
    let runFailures = 0;           // consecutive runs that grabbed/tried but never reached 'mapping'
    let recoverKills = 0;          // consecutive recovery /kills that ACTUALLY killed us and still left us stranded (bounded by MAX_RECOVER_KILLS)
    let awaitingRecoverDeath = false; // a recovery /kill was sent but hasn't produced a death yet. If it never does - server restarting/booting, stuck in the queue, or cooldown-rejected - it's a NO-OP and must NOT count toward the bed-gone limit (counting no-op /kills during a server restart false-trips "the bed is gone").
    let lastKillAt = 0;            // timestamp of the last recovery /kill, to pace retries above the ~30s cooldown
    let recoverLoggedAt = 0;       // rate-limits the "waiting out /kill cooldown" log
    let rotating = false;          // 'rotate' mode: cycle through rotateSet, advancing to the next highway on each full-distance elytra run
    let rotateSet = ROTATION_ORDER.slice(); // the highways the rotation cycles through (default all 8; can be a custom subset/order, e.g. nw,ne,north,east,west to skip the arc-heavy far side)
    let runMaxDist = 0;            // max straight-line distance-from-launch reached this run (drives the rotate/stay decision)
    let shortRunsThisHighway = 0;  // consecutive sub-ROTATE_MIN_DIST runs on the current highway (rotate anyway once this hits ROTATE_MAX_SHORT_RUNS)
    const MAX_RUN_FAILURES = 3;    // auto-stop after this many, so a broken takeoff can't burn every elytra unattended

    // A run that got as far as taking an elytra but never actually started
    // mapping (bad takeoff, prep failure, etc.). Trips the whole loop OFF after
    // a few in a row rather than looping forever wasting elytras.
    function noteRunFailure(reason) {
        runFailures++;
        sendLog(`🗺️ [mapper] run failed (${reason}) [${runFailures}/${MAX_RUN_FAILURES}].`);
        if (runFailures >= MAX_RUN_FAILURES) {
            // Report where it actually is + the LAST failure reason, and only guess
            // at causes we can actually distinguish - do NOT blindly claim "bed lost"
            // just because we're inside 5k (that inference was wrong repeatedly: the
            // bot was really in the LOBBY, or had died-and-respawned fine but a proxy
            // transfer relocated it). Let the operator read the real reason.
            const pos = botPos();
            let diag = '';
            if (pos) {
                const d = Math.round(Math.hypot(pos.x, pos.z));
                const chest = findNearestEnderChest();
                const where = d <= HOME_BLOCKED_RADIUS
                    ? `INSIDE the 5k zone (can't /home out from here; if this is the lobby/spawn, a server transfer likely dropped it here mid-cycle)`
                    : `outside 5k`;
                diag = ` Stuck at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} (${d} from spawn, ${where}).` +
                    ` Last failure: ${reason}.` +
                    ` Nearest ender chest: ${chest ? `${chest.x},${chest.y},${chest.z}` : 'NONE in render'}.`;
            }
            sendLog(`🛑 [mapper] auto-stopped after ${MAX_RUN_FAILURES} failed runs.${diag} \`!map on <mode>\` to resume once it's back at the far base with elytras.`);
            stop();
        }
    }

    function setState(s) {
        if (s !== state) { state = s; stateSince = Date.now(); }
    }
    function inState(ms) { return Date.now() - stateSince >= ms; }

    // Waypoints on a GRID_STEP lattice covering +/- MAX_CELL, ordered nearest-
    // to-spawn first so coverage grows outward from 0,0 (what the operator
    // wants). Phase 4 will additionally skip cells already covered on the map.
    function buildWaypoints(mode) {
        const dir = MAPPING_MODES[mode];
        const pts = [];
        if (mode.startsWith('box:')) {
            // User-defined rectangle: "box:x1,z1,x2,z2" (two opposite corners). Grid-fill
            // the whole box on the GRID_STEP lattice, ordered from the box centre outward.
            // No centre hole and no keep-out (see steerFlight/pickTarget) - if the user
            // asks for a box over spawn, map it; the parse-skip handles any bad chunks.
            const nums = mode.slice(4).split(',').map(Number);
            if (nums.length === 4 && nums.every(Number.isFinite)) {
                const [ax, az, bx, bz] = nums;
                const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
                const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
                const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
                const gx0 = Math.floor(minX / GRID_STEP) * GRID_STEP, gx1 = Math.ceil(maxX / GRID_STEP) * GRID_STEP;
                const gz0 = Math.floor(minZ / GRID_STEP) * GRID_STEP, gz1 = Math.ceil(maxZ / GRID_STEP) * GRID_STEP;
                const cellsX = Math.floor((gx1 - gx0) / GRID_STEP) + 1, cellsZ = Math.floor((gz1 - gz0) / GRID_STEP) + 1;
                if (cellsX * cellsZ > 500000) {
                    console.log(`[mapper] box too large (${cellsX * cellsZ} cells > 500k) - refusing to build. Use a smaller box (each side <= ~80k).`);
                    return pts; // empty
                }
                for (let x = gx0; x <= gx1; x += GRID_STEP)
                    for (let z = gz0; z <= gz1; z += GRID_STEP)
                        pts.push({ x, z, d2: (x - cx) * (x - cx) + (z - cz) * (z - cz) });
                pts.sort((a, b) => a.d2 - b.d2);
            }
            return pts;
        }
        if (mode === 'ring' || mode.startsWith('ring-')) {
            // Area-fill the +/-RING_OUTER box, skipping the centre hole (< RING_INNER
            // of 0,0). `ring` = the whole ring; `ring-nw|ne|se|sw` = just that box-
            // quadrant - map ONE quadrant from a /home placed in it, so every run
            // launches straight into fresh ground instead of re-flying covered ring
            // to reach the far side. Ordered nearest-to-0,0 first. Non-'spawn' mode,
            // so steerFlight keep-out routing arcs around the centre hole.
            const quad = mode.startsWith('ring-') ? mode.slice(5) : null;
            const inQuad = (x, z) =>
                !quad ? true :
                quad === 'nw' ? (x <= 0 && z <= 0) :
                quad === 'ne' ? (x > 0 && z <= 0) :
                quad === 'se' ? (x > 0 && z > 0) :
                quad === 'sw' ? (x <= 0 && z > 0) : true;
            for (let x = -RING_OUTER; x <= RING_OUTER; x += GRID_STEP)
                for (let z = -RING_OUTER; z <= RING_OUTER; z += GRID_STEP) {
                    const d2 = x * x + z * z;
                    if (d2 < RING_INNER * RING_INNER) continue; // skip the dodgy centre
                    if (!inQuad(x, z)) continue;
                    pts.push({ x, z, d2 });
                }
            pts.sort((a, b) => a.d2 - b.d2);
            return pts;
        }
        if (!dir) {
            // 'spawn' grid mode (default): the full +/-MAX_CELL lattice, ordered
            // nearest-to-0,0 first so coverage grows outward from spawn.
            for (let x = -MAX_CELL; x <= MAX_CELL; x += GRID_STEP)
                for (let z = -MAX_CELL; z <= MAX_CELL; z += GRID_STEP)
                    pts.push({ x, z, d2: x * x + z * z });
            pts.sort((a, b) => a.d2 - b.d2);
            return pts;
        }
        // Highway mode: WALK along the axis (O(length), not O(area)). The old
        // full-bounding-box scan was ~(2*END/GRID_STEP)^2 iterations - fine at 30k
        // (~0.29M) but ~8.6e10 at the 30M world border, which would hang for ages.
        // Walking the line is ~END/GRID_STEP iterations (~0.27M even at 30M), so
        // the corridor can extend to the world border cheaply. Cells are snapped
        // to the GRID_STEP lattice (so cellKeys/seed-from-disk stay consistent)
        // and deduped; HIGHWAY_HALF_WIDTH>=GRID_STEP adds parallel lanes each side.
        const len = Math.hypot(dir[0], dir[1]);
        const ux = dir[0] / len, uz = dir[1] / len;     // unit vector along the axis
        const perpX = -uz, perpZ = ux;                  // unit vector perpendicular
        const lanes = Math.floor(HIGHWAY_HALF_WIDTH / GRID_STEP); // 0 => single on-axis lane
        const firstAlong = Math.ceil(HIGHWAY_START / GRID_STEP) * GRID_STEP;
        const seen = new Set();
        for (let along = firstAlong; along <= HIGHWAY_END; along += GRID_STEP) {
            for (let l = -lanes; l <= lanes; l++) {
                const off = l * GRID_STEP;
                const x = Math.round((ux * along + perpX * off) / GRID_STEP) * GRID_STEP;
                const z = Math.round((uz * along + perpZ * off) / GRID_STEP) * GRID_STEP;
                const key = `${x},${z}`;
                if (seen.has(key)) continue;            // diagonal snapping can repeat a cell
                seen.add(key);
                pts.push({ x, z, d2: x * x + z * z });  // sort key = distance from origin (grows outward)
            }
        }
        pts.sort((a, b) => a.d2 - b.d2);
        return pts;
    }

    function cellKey(p) { return `${p.x},${p.z}`; }

    // ---- Path planning: axis-aligned boustrophedon (lawnmower) --------------
    // sweepAxisFor picks which world axis a lane runs along for a mode; rebuildLaneIndex
    // buckets every waypoint into its lane (keyed by the stepping-axis coord) with
    // along-axis coords sorted, so a full straight pass to a lane's far end is a
    // cheap lookup. Called after every `waypoints = buildWaypoints(...)`.
    function sweepAxisFor(mode) {
        if (mode.startsWith('box:')) {
            // Run lanes along the box's LONGER side (fewer, longer passes = fewer turns).
            const n = mode.slice(4).split(',').map(Number);
            if (n.length === 4 && n.every(Number.isFinite)) {
                const wx = Math.abs(n[2] - n[0]), wz = Math.abs(n[3] - n[1]);
                return wz >= wx ? 'z' : 'x';
            }
        }
        return 'z'; // N/S lanes stepping in X - good for the (roughly square) spawn box & quadrants
    }
    function rebuildLaneIndex() {
        sweepAxis = sweepAxisFor(mappingMode);
        sweepDir = 1;
        laneIndex = new Map();
        const AX = sweepAxis, BX = sweepAxis === 'z' ? 'x' : 'z';
        for (const w of waypoints) {
            const bk = w[BX];
            let arr = laneIndex.get(bk);
            if (!arr) { arr = []; laneIndex.set(bk, arr); }
            arr.push(w[AX]);
        }
        for (const arr of laneIndex.values()) arr.sort((p, q) => p - q);
    }

    // LAUNCH-heading picker (the original velocity-heading picker, kept ONLY for
    // takeoff). The 'launch' state walks off the platform toward whatever cell this
    // returns - the toward-0,0/nearest heading the mapper always launched on. Keeping
    // takeoff on this instead of the boustrophedon picker below is what stops the
    // routing from ever aiming the walk-off into a platform wall as the area fills in.
    function pickLaunchTarget() {
        const pos = botPos();
        if (!pos) return null;
        const bot = getBot();
        const v = bot && bot.entity && bot.entity.velocity;
        const vh = v ? Math.hypot(v.x, v.z) : 0;
        let hx, hz;
        if (vh > 0.3) { hx = v.x / vh; hz = v.z / vh; }
        else { const l = Math.hypot(pos.x, pos.z) || 1; hx = -pos.x / l; hz = -pos.z / l; }
        let sweep = null, sweepProj = -Infinity;
        let nearest = null, nearestD = Infinity;
        for (const w of waypoints) {
            if (covered.has(cellKey(w))) continue;
            const dx = w.x - pos.x, dz = w.z - pos.z;
            const d = Math.hypot(dx, dz);
            if (d < nearestD) { nearestD = d; nearest = w; }
            const proj = dx * hx + dz * hz;
            const perp = Math.abs(dx * -hz + dz * hx);
            if (proj > 30 && perp <= GRID_STEP && proj > sweepProj) { sweepProj = proj; sweep = w; }
        }
        if (!nearest) { covered.clear(); return null; }
        if (mappingMode !== 'spawn' && !mappingMode.startsWith('ring') && !mappingMode.startsWith('box:')) return nearest;
        return sweep || nearest;
    }

    // Nearest not-yet-covered cell to the bot - used for HIGHWAY modes, which are a
    // single on-axis corridor: "nearest uncovered" already IS a straight pass, and
    // it enters the corridor at its NEAR end (arcing around spawn via the keep-out)
    // rather than beelining to the far cell and cutting diagonally across spawn.
    // Deliberately NOT "next in a list sorted from 0,0": the base sits OUTSIDE the
    // 5k zone, so a spawn-ordered list would always aim ~5k away and never advance.
    function pickNearestUncovered(pos) {
        let nearest = null, nearestD = Infinity;
        for (const w of waypoints) {
            if (covered.has(cellKey(w))) continue;
            const d = Math.hypot(w.x - pos.x, w.z - pos.z);
            if (d < nearestD) { nearestD = d; nearest = w; }
        }
        if (!nearest) { covered.clear(); return null; } // whole corridor done - fresh pass next tick
        return nearest;
    }

    // AREA fill (spawn / ring / quadrant / box): a real boustrophedon. The old
    // planner chased "the farthest uncovered cell within a corridor of the CURRENT
    // velocity heading" - but the heading drifts, so lanes wandered diagonally,
    // weren't spaced a clean swath apart, and after each pass it fell back to the
    // nearest cell (often re-crossing covered ground at ~8 b/s of turns vs ~33 b/s
    // straight cruise). This commits to axis-aligned lanes: fly a lane to the far
    // end of its contiguous uncovered run, then step to the ADJACENT lane and
    // reverse - parallel passes exactly one render-swath apart, almost no
    // backtracking, and a clean lane resume after a mid-pass death.
    function pickTarget() {
        const pos = botPos();
        if (!pos) return null;
        const areaMode = (mappingMode === 'spawn' || mappingMode.startsWith('ring') || mappingMode.startsWith('box:'));
        if (!areaMode) return pickNearestUncovered(pos);

        const AX = sweepAxis, BX = sweepAxis === 'z' ? 'x' : 'z';
        const aPos = pos[AX], bPos = pos[BX];
        const mk = (bv, av) => (sweepAxis === 'z' ? { x: bv, z: av } : { x: av, z: bv });
        const uncoveredInLane = (bv) => {
            const arr = laneIndex.get(bv);
            if (!arr) return null;
            const out = [];
            for (const av of arr) if (!covered.has(cellKey(mk(bv, av)))) out.push(av);
            return out.length ? out : null;
        };

        // 1) CONTINUE the current lane. If the bot is on (within a swath of) a
        //    lattice lane that still has uncovered cells ahead in sweepDir, fly to
        //    the far end of that contiguous uncovered run - one long straight pass.
        //    (Chiefly matters when resuming a lane after a death mid-pass.)
        let laneB = null, laneDb = Infinity;
        for (const bv of laneIndex.keys()) { const db = Math.abs(bv - bPos); if (db < laneDb) { laneDb = db; laneB = bv; } }
        if (laneB !== null && laneDb <= GRID_STEP) {
            const unc = uncoveredInLane(laneB); // sorted ACTUAL along-axis coords (may be offset from 0)
            if (unc) {
                if (sweepDir > 0) {
                    let i = 0;
                    while (i < unc.length && unc[i] < aPos - ARRIVE_DIST) i++; // first uncovered cell ahead
                    if (i < unc.length) {
                        let j = i;
                        while (j + 1 < unc.length && unc[j + 1] - unc[j] === GRID_STEP) j++; // extend through the contiguous run
                        return mk(laneB, unc[j]); // far end of the contiguous uncovered run - one long straight pass
                    }
                } else {
                    let i = unc.length - 1;
                    while (i >= 0 && unc[i] > aPos + ARRIVE_DIST) i--;
                    if (i >= 0) {
                        let j = i;
                        while (j - 1 >= 0 && unc[j] - unc[j - 1] === GRID_STEP) j--;
                        return mk(laneB, unc[j]);
                    }
                }
            }
        }

        // 2) ADVANCE to the next lane: the nearest stepping-lane that still has
        //    uncovered cells. Enter at the end nearest the bot and sweep away.
        let bestB = null, bestDb = Infinity;
        for (const bv of laneIndex.keys()) {
            if (!uncoveredInLane(bv)) continue;
            const db = Math.abs(bv - bPos);
            if (db < bestDb) { bestDb = db; bestB = bv; }
        }
        if (bestB === null) { covered.clear(); return null; } // whole zone done - fresh pass next tick

        const unc = uncoveredInLane(bestB);
        const lo = unc[0], hi = unc[unc.length - 1];
        const nearEnd = Math.abs(lo - aPos) <= Math.abs(hi - aPos) ? lo : hi;
        sweepDir = nearEnd === hi ? -1 : 1;      // next pass sweeps AWAY from the end we enter at
        // Enter the lane at its NEAR end; step 1 next tick flies the full straight
        // pass to the far end. Entering first (rather than beelining to the far
        // end from the previous lane's far corner) keeps every pass axis-aligned,
        // so its render swath fully covers the lane instead of slanting across it
        // and leaving strips that need a costly revisit.
        return mk(bestB, nearEnd);
    }

    // Everything within one render footprint of a render we just made is covered.
    function markCoveredAround(cx, cz) {
        for (const w of waypoints) {
            if (covered.has(cellKey(w))) continue;
            if (Math.hypot(w.x - cx, w.z - cz) <= RENDER_RADIUS) covered.add(cellKey(w));
        }
    }

    function dist2D(a, b) {
        const dx = a.x - b.x, dz = a.z - b.z;
        return Math.sqrt(dx * dx + dz * dz);
    }

    function botPos() {
        const bot = getBot();
        return bot && bot.entity ? bot.entity.position : null;
    }

    function hasElytraEquipped() {
        const bot = getBot();
        try {
            const slot = bot.getEquipmentDestSlot('torso'); // torso armor slot in the player inventory window
            const item = bot.inventory.slots[slot];
            return !!(item && item.name === 'elytra');
        } catch (e) { return false; }
    }

    // Rough remaining-flight-time estimate (seconds) from the equipped elytra's
    // durability, for the "I'm out mapping right now, ~Xm left" reply bot-core
    // sends when a kit whisper lands mid-flight. Elytra loses 1 durability per
    // second of flight (max 432). In 1.20.1 the elytra is NOT an ArmorItem, so
    // Unbreaking uses the tool formula (1/(L+1) chance to consume a point), i.e.
    // ~(L+1)x effective life - so Unbreaking III (the fleet's elytras) ~= 4x,
    // ~1728s / ~29min from full. Reads the actual enchant level off the item so
    // an un-enchanted or differently-enchanted elytra still estimates sanely.
    // Returns whole seconds, or null if there's no readable equipped elytra.
    function estimateSecondsLeft() {
        const bot = getBot();
        try {
            const slot = bot.getEquipmentDestSlot('torso');
            const item = bot.inventory.slots[slot];
            if (!item || item.name !== 'elytra') return null;
            const maxD = item.maxDurability || 432;
            const used = (typeof item.durabilityUsed === 'number') ? item.durabilityUsed : 0;
            const remaining = Math.max(0, maxD - used);
            let unb = 0;
            try {
                const e = (item.enchants || []).find(en => en && typeof en.name === 'string' && en.name.includes('unbreaking'));
                if (e && Number.isFinite(e.lvl)) unb = e.lvl;
            } catch (_) {}
            return Math.round(remaining * (unb + 1)); // ~1 dura/sec of flight, x (L+1) for Unbreaking
        } catch (e) { return null; }
    }

    // Is the bot actually gliding? prismarine-physics tracks the same state the
    // server does (needs elytraEquipped && !onGround), so this is a real answer.
    function isGliding() {
        const bot = getBot();
        try { return !!(bot && bot.entity && bot.entity.elytraFlying); } catch (e) { return false; }
    }

    function clearFlight() {
        const bot = getBot();
        try { if (bot) bot.clearControlStates(); } catch (e) {}
        flightStarted = false;
        stuckAnchor = null;
        launchPos = null;
    }

    // Meteor's ElytraBoost, in mineflayer terms: keep a firework boost running.
    // prismarine-physics only honours it while genuinely gliding (it zeroes the
    // duration otherwise), so this can never produce impossible movement.
    function topUpBoost() {
        const bot = getBot();
        try {
            if (!bot || !isGliding()) return;
            const v = bot.entity.velocity;
            const pos = botPos();
            const horizSpeed = Math.hypot(v.x, v.z);
            // Below the cruise band, DON'T govern - the bot needs full boost to
            // climb. Climbing at PITCH_UP bleeds airspeed, and if the governor
            // caps speed at 20 b/s the climb starves: speed falls to a stall, the
            // dive-recovery gives back the altitude just gained, and it never
            // reaches the safe band (confirmed live on the north run: it topped
            // out at Y317, stall-cycled Y263-317, then wedged on a build at Y307).
            // So power-climb full-throttle until in-band, THEN govern to ~20 b/s.
            const climbing = pos && pos.y < CRUISE_Y_MIN;
            if (!climbing && horizSpeed >= TARGET_CRUISE_BPT) return; // in-band governor: coast
            if ((bot.fireworkRocketDuration || 0) <= BOOST_REFRESH_AT) {
                // Full kick while climbing or recovering a stall; gentle pulse only
                // for in-band cruise so we settle near the cap instead of overshooting.
                bot.fireworkRocketDuration = (climbing || horizSpeed < STALL_SPEED) ? BOOST_TICKS : GOVERN_BOOST_TICKS;
            }
        } catch (e) {}
    }

    function angleDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

    // Keep-out routing (highway modes only): return an effective steering point
    // that never sends the bot through the KEEPOUT_RADIUS circle around spawn. If
    // the straight pos->target segment stays clear of the circle, steer direct;
    // if it would cut through, steer along the tangent to the circle on whichever
    // side is closer to the target, so the bot ARCS AROUND spawn instead of
    // crossing the build-dense, bad-chunk, no-/home inner zone. Recomputed every
    // tick, so it hugs the circle smoothly and goes direct once the path clears.
    // If it somehow ends up inside the circle (a bad respawn/reconnect), it steers
    // radially outward to escape.
    function routeAroundKeepout(pos, target) {
        const R = KEEPOUT_RADIUS;
        const dpo = Math.hypot(pos.x, pos.z);            // bot -> spawn
        if (dpo <= R) {                                  // inside the ring: get out, radially
            const l = dpo || 1;
            return { x: pos.x / l * (R + 300), z: pos.z / l * (R + 300) };
        }
        const dx = target.x - pos.x, dz = target.z - pos.z;
        const segLen2 = dx * dx + dz * dz;
        let closest;
        if (segLen2 < 1e-6) closest = dpo;
        else {
            let t = -(pos.x * dx + pos.z * dz) / segLen2; // project spawn onto the segment
            t = Math.max(0, Math.min(1, t));
            closest = Math.hypot(pos.x + t * dx, pos.z + t * dz);
        }
        if (closest >= R) return target;                 // direct path is clear of the ring
        // Direct path clips the ring -> aim along the tangent nearer the target.
        const angPO = Math.atan2(0 - pos.z, 0 - pos.x);  // toward spawn
        const alpha = Math.asin(Math.min(1, R / dpo));   // tangent half-angle
        const angPT = Math.atan2(dz, dx);                // toward target
        const tang = Math.abs(angleDiff(angPO + alpha, angPT)) < Math.abs(angleDiff(angPO - alpha, angPT))
            ? angPO + alpha : angPO - alpha;
        return { x: pos.x + Math.cos(tang) * 500, z: pos.z + Math.sin(tang) * 500 };
    }

    // Steer powered flight: yaw at the target, pitch by altitude error. Under a
    // firework boost the player accelerates along its look vector, so pitch IS
    // the altitude control - no velocity is ever written by hand.
    function steerFlight(target) {
        const bot = getBot();
        const pos = botPos();
        if (!bot || !pos || !target) return;
        try {
            // Highways route around the spawn keep-out zone; spawn mode maps inside it.
            const steerPt = (mappingMode === 'spawn' || mappingMode.startsWith('box:')) ? target : routeAroundKeepout(pos, target);
            const yaw = Math.atan2(-(steerPt.x - pos.x), -(steerPt.z - pos.z));
            // Departure: nose DOWN and unboosted until clear of the launch
            // platform - a normal glide dive builds speed and takes us away from
            // and below the base. Climbing (or boosting) this close just arcs the
            // bot back up onto the platform, which is exactly what kept happening.
            const clearOfBase = !launchPos || Math.hypot(pos.x - launchPos.x, pos.z - launchPos.z) >= DEPART_DIST;
            // Stall check first: if we've lost our airspeed, nothing else matters -
            // dive to get it back before worrying about the altitude target.
            const v = bot.entity.velocity;
            const horizSpeed = Math.hypot(v.x, v.z);
            const stalled = horizSpeed < STALL_SPEED;
            const pitch = stalled ? PITCH_STALL_RECOVER
                        : !clearOfBase ? PITCH_DOWN
                        : pos.y < CRUISE_Y_MIN ? PITCH_UP
                        : pos.y > CRUISE_Y_MAX ? PITCH_DOWN
                        : PITCH_LEVEL;
            bot.look(yaw, pitch, false);
        } catch (e) {}
    }

    // ---- ender chest + elytra --------------------------------------------
    function findNearestEnderChest() {
        const bot = getBot();
        try {
            const id = bot.registry.blocksByName.ender_chest && bot.registry.blocksByName.ender_chest.id;
            if (id == null) return null;
            const found = bot.findBlocks({ matching: [id], maxDistance: 128, count: 1 });
            return found && found.length ? found[0] : null;
        } catch (e) { return null; }
    }

    // Best-effort walk toward a block until within interaction reach, without
    // walking off an edge (no pathfinder). Ender chest contents are global, so
    // ANY reachable ender chest works - ideally the operator keeps one within a
    // few blocks of the spawn home so this barely has to move.
    async function approachBlock(targetVec, reach, maxMs) {
        const bot = getBot();
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            const p = botPos();
            if (!p || p.distanceTo(targetVec) <= reach) break;
            try {
                bot.lookAt(targetVec.offset(0.5, 0.5, 0.5), true);
                // Edge safety: only step if there's solid ground just ahead (at
                // our feet level or one below), so we don't stroll off a skybase.
                const dir = targetVec.minus(p); dir.y = 0;
                const len = Math.hypot(dir.x, dir.z) || 1;
                const ahead = p.offset(dir.x / len, 0, dir.z / len);
                const f1 = bot.blockAt(ahead.offset(0, -1, 0));
                const f2 = bot.blockAt(ahead.offset(0, -2, 0));
                const f3 = bot.blockAt(ahead.offset(0, -3, 0));
                const isSolid = (b) => !!(b && b.boundingBox === 'block');
                // Only refuse to step for a genuine DEEP drop that's fully loaded
                // (3+ blocks of air ahead). A 1-block step-down (f2/f3 solid) or a
                // not-yet-loaded block (f1 null) is fine to walk into - the old
                // check was too trigger-happy and stalled the bot ~10 blocks short.
                const deepDrop = f1 && !isSolid(f1) && !isSolid(f2) && !isSolid(f3);
                if (deepDrop) { bot.setControlState('forward', false); break; }
                bot.setControlState('forward', true);
            } catch (e) {}
            await new Promise(r => setTimeout(r, 400));
        }
        try { bot.setControlState('forward', false); } catch (e) {}
    }

    // Open an ender chest block, withdraw 1 elytra and equip it. Returns true
    // only if an elytra ends up on the bot's torso.
    async function openAndGrabElytra(block) {
        const bot = getBot();
        let win;
        try { win = await bot.openContainer(block); }
        catch (e) { lastError = `couldn't open ender chest: ${e.message}`; return false; }
        let elytra, remaining, hasShulker;
        try {
            const items = win.containerItems ? win.containerItems() : win.items();
            elytra = items.find(it => it && it.name === 'elytra');
            remaining = items.filter(it => it && it.name === 'elytra').reduce((n, it) => n + it.count, 0);
            hasShulker = items.some(it => it && it.name && it.name.endsWith('shulker_box'));
            if (elytra) await win.withdraw(elytra.type, elytra.metadata, 1);
            try { await win.close(); } catch (e) {}
        } catch (e) {
            try { await win.close(); } catch (e2) {}
            lastError = `elytra withdraw failed: ${e.message}`;
            return false;
        }
        if (!elytra) {
            // No LOOSE elytra. If the chest holds shulkers (of elytras), crack one
            // open for an elytra (verified working via !elytradance). Only when there
            // are neither loose elytras NOR shulkers is the global stock truly out.
            if (hasShulker) return await grabElytraViaShulker(block);
            lastError = 'no elytra or shulker in this ender chest'; outOfElytras = true; return false;
        }
        sendLog(`🗺️ [mapper] Withdrew 1 elytra (~${remaining - 1} left in ender chest).`);
        try {
            const inv = bot.inventory.items().find(it => it && it.name === 'elytra');
            if (!inv) { lastError = 'elytra not in inventory after withdraw'; return false; }
            await bot.equip(inv, 'torso');
        } catch (e) { lastError = `elytra equip failed: ${e.message}`; return false; }
        return hasElytraEquipped();
    }

    // ---- shulker-of-elytras support --------------------------------------
    // The ender chest is only 27 slots = 27 loose elytras. To scale autonomy,
    // elytras can be stored as SHULKER BOXES (27 each) instead. A shulker can't
    // be opened while it sits inside a container, so the ONLY way to reach the
    // elytras in one is to withdraw it, PLACE it as a block, open it, take an
    // elytra, break it (it drops as an item WITH its remaining contents), pick
    // it back up, and return it to the ender chest. This does that for ONE
    // elytra per call. Deliberately step-by-step with a log per stage: block
    // place/break on anarchy is fiddly and each stage fails differently, so a
    // failure must say WHICH stage.

    // A clear floor tile beside the bot to set a block on: a horizontal
    // neighbour whose foot-level block is air, with a solid block just below
    // (we place on that block's top face) and air above (so the shulker lid can
    // open). Returns { refBlock, faceVec, placePos } or null if boxed in.
    function findPlacementSpot() {
        const bot = getBot();
        const p = botPos();
        if (!p) return null;
        const feet = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
        const isAir = (b) => b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air');
        const isSolid = (b) => !!(b && b.boundingBox === 'block');
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const at = feet.offset(dx, 0, dz);       // where the shulker goes (foot level)
            const below = at.offset(0, -1, 0);       // floor we place against
            const above = at.offset(0, 1, 0);        // must be air for the lid
            if (isAir(bot.blockAt(at)) && isAir(bot.blockAt(above)) && isSolid(bot.blockAt(below))) {
                return { refBlock: bot.blockAt(below), faceVec: new Vec3(0, 1, 0), placePos: at };
            }
        }
        return null;
    }

    async function tryReturnShulkerToEnder(enderChestBlock, name) {
        const bot = getBot();
        try {
            const item = bot.inventory.items().find(it => it && it.name === name);
            if (!item) return false;
            const win = await bot.openContainer(enderChestBlock);
            await win.deposit(item.type, item.metadata, item.count);
            try { await win.close(); } catch (e) {}
            sendLog(`🗺️ [mapper] returned the shulker to the ender chest.`);
            return true;
        } catch (e) { lastError = `return shulker to ender failed: ${e.message}`; return false; }
    }

    // Walk onto the dropped item so the server auto-collects it (same as a player
    // picking it up), then wait until it's actually in inventory. Rather than
    // trusting the placement spot (the drop can bounce/slide a block or two off
    // it - which is exactly how a shulker got lost), home in on the ACTUAL
    // dropped-item entity each pass and stand on it.
    async function collectNearbyItem(pos, name, maxMs) {
        const bot = getBot();
        const deadline = Date.now() + maxMs;
        const spot = new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5);
        while (Date.now() < deadline) {
            if (bot.inventory.items().some(it => it && it.name === name)) return true;
            let dest = spot;
            try {
                // Match dropped items by e.name ONLY - prismarine-entity's `objectType`
                // getter THROWS for non-object entities, which crashed the predicate
                // (and rejected the whole dance) when any mob/player was nearby. Guard
                // each entity too so one bad entity can't blow up nearestEntity.
                const drop = bot.nearestEntity(e => { try { return !!(e && e.name === 'item' && e.position && bot.entity && e.position.distanceTo(bot.entity.position) < 12); } catch (_) { return false; } });
                if (drop && drop.position) dest = drop.position;
            } catch (e) {}
            try { await approachBlock(dest, 0.4, 1500); } catch (e) {}
            await new Promise(r => setTimeout(r, 300));
        }
        return bot.inventory.items().some(it => it && it.name === name);
    }

    async function grabElytraViaShulker(enderChestBlock) {
        const bot = getBot();

        // 1) Take one shulker box out of the ender chest.
        let shulkerName;
        try {
            const win = await bot.openContainer(enderChestBlock);
            const items = win.containerItems ? win.containerItems() : win.items();
            const shulker = items.find(it => it && it.name && it.name.endsWith('shulker_box'));
            if (!shulker) { try { await win.close(); } catch (e) {} lastError = 'no elytra AND no shulker in ender chest'; outOfElytras = true; return false; }
            shulkerName = shulker.name;
            await win.withdraw(shulker.type, shulker.metadata, 1);
            try { await win.close(); } catch (e) {}
            sendLog(`🗺️ [mapper] no loose elytra - taking a ${shulkerName} out to crack open.`);
        } catch (e) { lastError = `shulker withdraw failed: ${e.message}`; return false; }

        const shulkerInv = bot.inventory.items().find(it => it && it.name === shulkerName);
        if (!shulkerInv) { lastError = 'shulker not in inventory after withdraw'; return false; }

        // 2) Find a clear floor tile beside the bot and place the shulker on it.
        const spot = findPlacementSpot();
        if (!spot) { lastError = 'no clear floor tile beside the bot to place the shulker'; await tryReturnShulkerToEnder(enderChestBlock, shulkerName); return false; }
        try {
            await bot.equip(shulkerInv, 'hand');
            await bot.lookAt(spot.placePos.offset(0.5, 0.5, 0.5), true);
            await bot.placeBlock(spot.refBlock, spot.faceVec);
            await new Promise(r => setTimeout(r, 300));
        } catch (e) { lastError = `shulker place failed: ${e.message}`; await tryReturnShulkerToEnder(enderChestBlock, shulkerName); return false; }

        let placedBlock = bot.blockAt(spot.placePos);
        if (!placedBlock || !(placedBlock.name && placedBlock.name.endsWith('shulker_box'))) {
            lastError = `shulker didn't appear at ${spot.placePos.x},${spot.placePos.y},${spot.placePos.z} after place`;
            await tryReturnShulkerToEnder(enderChestBlock, shulkerName); // may still be in hand if place silently failed
            return false;
        }
        sendLog(`🗺️ [mapper] placed shulker at ${spot.placePos.x},${spot.placePos.y},${spot.placePos.z} - opening for an elytra.`);

        // 3) Open the placed shulker, take one elytra, equip it.
        let tookElytra = false, shulkerLeftEmpty = false;
        try {
            const sc = await bot.openContainer(placedBlock);
            const sitems = sc.containerItems ? sc.containerItems() : sc.items();
            const ely = sitems.find(it => it && it.name === 'elytra');
            const elyCount = sitems.filter(it => it && it.name === 'elytra').reduce((n, it) => n + it.count, 0);
            const nonElytra = sitems.filter(it => it && it.name !== 'elytra').length;
            if (ely) {
                await sc.withdraw(ely.type, ely.metadata, 1);
                tookElytra = true;
                shulkerLeftEmpty = (elyCount - 1) <= 0 && nonElytra === 0;
            } else {
                lastError = 'placed shulker had no elytra inside';
                shulkerLeftEmpty = (nonElytra === 0); // a fully-empty dud - toss it so a retry doesn't re-grab the same one
            }
            try { await sc.close(); } catch (e) {}
        } catch (e) { lastError = `open placed shulker failed: ${e.message}`; }

        if (tookElytra) {
            try {
                const invEly = bot.inventory.items().find(it => it && it.name === 'elytra');
                if (invEly) await bot.equip(invEly, 'torso');
            } catch (e) { lastError = `elytra equip failed: ${e.message}`; }
        }

        // 4) Break the placed shulker; it drops as an item with its remaining contents.
        try {
            placedBlock = bot.blockAt(spot.placePos);
            if (placedBlock && placedBlock.name && placedBlock.name.endsWith('shulker_box')) {
                await bot.dig(placedBlock);
            }
        } catch (e) { lastError = `shulker dig failed: ${e.message}`; }

        // 5) Collect the dropped shulker.
        await collectNearbyItem(spot.placePos, shulkerName, 15000);

        // 6) Put the shulker back in the ender chest (or toss it if it's now empty).
        const recovered = bot.inventory.items().find(it => it && it.name === shulkerName);
        if (recovered) {
            if (shulkerLeftEmpty) {
                try { await bot.toss(recovered.type, recovered.metadata, recovered.count); sendLog(`🗺️ [mapper] shulker was emptied of elytras - tossed it.`); } catch (e) { await tryReturnShulkerToEnder(enderChestBlock, shulkerName); }
            } else {
                await tryReturnShulkerToEnder(enderChestBlock, shulkerName);
            }
        } else {
            sendLog(`⚠️ [mapper] couldn't recover the dropped shulker at ${spot.placePos.x},${spot.placePos.y},${spot.placePos.z} - it may be lost. Check the base.`);
        }

        return hasElytraEquipped();
    }

    // Manual one-shot test of the shulker dance (wired to `!elytradance`), so we
    // can watch the place->take->break->pickup->store cycle work ONCE before it's
    // ever put in the autonomous acquire path. Runs at the nearest ender chest.
    async function testShulkerDance() {
        const bot = getBot();
        if (!bot || !bot.entity) return 'bot not ready';
        if (!bot.hp || !bot.hp.isOnMainServer) return 'not on the main server yet';
        const chestVec = findNearestEnderChest();
        if (!chestVec) return 'no ender chest within 128 blocks - get the bot to the base first';
        if (botPos() && botPos().distanceTo(chestVec) > 3.5) await approachBlock(chestVec, 3.0, 15000);
        const block = bot.blockAt(chestVec);
        if (!block || block.name !== 'ender_chest' || (botPos() && botPos().distanceTo(chestVec) > 4)) return 'ender chest not reachable';
        const hadElytra = hasElytraEquipped();
        const ok = await grabElytraViaShulker(block);
        if (ok) return `shulker dance OK - elytra equipped${hadElytra ? ' (note: it already had one on)' : ''}`;
        return `shulker dance FAILED at: ${lastError || 'unknown'}`;
    }

    // Edge-safe stroll toward a random point ~20 blocks away, to explore the
    // platform on foot looking for an ender chest (reuses approachBlock's own
    // don't-walk-off-a-skybase logic). Only used when no chest is reachable yet.
    async function wanderStep() {
        const p = botPos();
        if (!p) return;
        const ang = Math.random() * Math.PI * 2;
        const target = new Vec3(p.x + Math.cos(ang) * 20, p.y, p.z + Math.sin(ang) * 20);
        await approachBlock(target, 2.0, 4000);
    }

    // Get an elytra equipped, within 5k of spawn where /home is unavailable. Try
    // to reach any ender chest in render; if none is reachable, wander and keep
    // looking. Gives up after ACQUIRE_MAX_MS (caller then /kills to reset). Any
    // ender chest works - contents are global.
    async function acquireElytra() {
        const bot = getBot();
        // Already wearing one (e.g. the last run failed to take off and never
        // consumed it)? Don't withdraw a second - that silently burned an elytra
        // per failed takeoff.
        if (hasElytraEquipped()) { console.log('[mapper] already wearing an elytra - skipping the chest.'); return true; }
        outOfElytras = false;
        const deadline = Date.now() + ACQUIRE_MAX_MS;
        let announced = false;
        while (active && Date.now() < deadline) {
            if (!bot || !bot.entity) return false;
            const chestVec = findNearestEnderChest();
            if (chestVec) {
                if (!announced) {
                    const p0 = botPos();
                    sendLog(`🗺️ [mapper] ender chest at ${chestVec.x},${chestVec.y},${chestVec.z} (${p0 ? Math.round(p0.distanceTo(chestVec)) : '?'} away) - approaching.`);
                    announced = true;
                }
                if (botPos() && botPos().distanceTo(chestVec) > 3.0) await approachBlock(chestVec, 3.0, 15000);
                const block = bot.blockAt(chestVec);
                if (block && block.name === 'ender_chest' && botPos() && botPos().distanceTo(chestVec) <= 4) {
                    if (await openAndGrabElytra(block)) return true;
                    // Chest opened but empty of elytras: ender chests are global, so
                    // EVERY chest is empty too - no point wandering to another. Bail
                    // now so the caller reports a clean "out of elytras" instead of
                    // burning the whole 2-min search + 3 strikes.
                    if (outOfElytras) return false;
                }
                // Reachable-looking but couldn't get to/open it - wander off and
                // re-search (maybe a closer/clearer one, or a better approach).
            }
            await wanderStep();
        }
        lastError = lastError || 'no reachable ender chest within 2 min';
        return false;
    }

    // ---- render + slice ---------------------------------------------------
    async function renderAndSlice() {
        if (busySlicing) return;
        const bot = getBot();
        if (!bot || !bot.entity) return;
        busySlicing = true;
        const tStart = Date.now();
        try {
            const r = renderMappingPng(bot, RENDER_RADIUS); // { pngBuffer, centerX, centerZ, radius, span, found, total }
            const tRender = Date.now() - tStart;
            if (!r || r.found < r.total * MIN_FOUND_FRACTION) {
                // Worth seeing: a skip means chunks weren't loaded there, which is
                // a coverage hole we'd otherwise never hear about.
                console.log(`[mapper][render] SKIPPED (only ${r ? ((r.found / r.total) * 100).toFixed(0) : '0'}% of columns found - chunks not loaded) after ${tRender}ms`);
                return;
            }
            saveTile(r); // write the PNG tile + manifest entry (see lib/output.js)
            tilesWrittenThisSession++;
            markCoveredAround(r.centerX, r.centerZ); // don't re-target what this render just covered
            lastRenderAt = Date.now();
            lastRenderPos = { x: r.centerX, z: r.centerZ }; // anchor for the next distance-based render
            console.log(`[mapper][render] ${((r.found / r.total) * 100).toFixed(0)}% filled, saved tile @ ${r.centerX},${r.centerZ}, render=${tRender}ms`);
        } catch (e) {
            lastError = `render/save failed: ${e.message}`;
        } finally {
            busySlicing = false;
        }
    }


    // ---- the main tick ----------------------------------------------------
    async function tick() {
        if (!active) return;
        const bot = getBot();
        if (!bot || !bot.entity || !bot.hp || !bot.hp.isOnMainServer) return; // not ready / in lobby - wait

        ensureReconfigureHook(bot);
        const inFlightState = (state === 'launch' || state === 'deploy' || state === 'mapping' || state === 'falling');
        if (inFlightState) {
            recordFlightSample(state);
        }

        // Hard-stall backstop - MUST run before the reconnect-grace guard below,
        // which suppresses the stuck-guard while physics is frozen. That's right for
        // a brief reconnect, but a PERSISTENT freeze (flying into unloaded chunks at
        // the far ring edge - physicsEnabled goes false and stays false) would
        // otherwise wedge us forever (seen: 22 min frozen at the +/-10k edge). Track
        // the last position we ACTUALLY moved from (its own anchor, not reset by the
        // grace guard); if it hasn't moved for HARD_STALL_MS while airborne on the
        // main server with no recent transfer, /kill out and mark that cell covered
        // so we don't retarget straight back into the same freeze.
        if (inFlightState) {
            const hp = botPos();
            if (hp) {
                if (!hardStallPos || Math.hypot(hp.x - hardStallPos.x, hp.z - hardStallPos.z) > 10) {
                    hardStallPos = { x: hp.x, z: hp.z }; hardStallAt = Date.now();
                } else if (Date.now() - hardStallAt > HARD_STALL_MS &&
                           (!lastReconfigureAt || Date.now() - lastReconfigureAt > HARD_STALL_MS)) {
                    sendLog(`🗺️ [mapper] HARD STALL - frozen ${Math.round((Date.now() - hardStallAt) / 1000)}s at ${Math.round(hp.x)},${Math.round(hp.z)} (unloaded/frozen physics) - /kill to reset, skipping that cell.`);
                    markCoveredAround(hp.x, hp.z); // don't retarget the frozen cell into the same freeze
                    hardStallPos = null; hardStallAt = 0;
                    try { bot.hp.expectedDeath = true; bot.chat('/kill'); } catch (e) {}
                    setState('falling'); // onDeath -> acquire -> relaunch
                    return;
                }
            }
        }

        // Reconnect/transfer resilience. On a proxy transfer OR a reconnect
        // (e.g. after one of karl's chunk-parse errors), 6b6t freezes our physics
        // during the reconfigure handshake - position can't change for several
        // seconds. That used to make the time-based failure guards misfire: the
        // stuck-guard saw "no progress", the launch/deploy timeouts elapsed, and a
        // brief connection blip would kill the run and count toward the 3-strike
        // auto-stop (confirmed: the "stall-trap" trace was just frozen physics,
        // identical velocity every tick). So while physics is frozen or a
        // reconfigure just happened, do NO flight logic and keep every failure
        // timer pinned to now - the guards then measure only genuine, stable
        // in-flight time. A tight parse-error loop just waits here instead of
        // burning elytras; a one-off blip is ridden out and mapping continues.
        if (inFlightState && (!bot.physicsEnabled || (lastReconfigureAt && Date.now() - lastReconfigureAt < RECONNECT_GRACE_MS))) {
            const p = botPos();
            if (p) { stuckAnchor = { x: p.x, z: p.z }; stuckAnchorAt = Date.now(); }
            launchAttemptAt = Date.now();
            stateSince = Date.now(); // keeps inState()-based timeouts (deploy-confirm, fall) from counting the freeze
            return;
        }

        // Pause entirely while the operator has the bot paused, or a real
        // delivery/personal-TP is in flight (bot-core owns those).
        if (typeof deps.canRun === 'function' && !deps.canRun()) {
            if (state === 'mapping' || state === 'launch' || state === 'deploy' || state === 'gotolaunch') { clearFlight(); setState('idle'); }
            return;
        }

        switch (state) {
            case 'idle': {
                // The normal loop starts here after every death: the bot respawns
                // on its bed AT the base, where the ender chest is - so just go
                // grab an elytra. No teleport, no cooldown.
                setState('acquire');
                prepStep = 'start';
                teleportSentAt = 0;
                break;
            }

            case 'acquire': {
                if (prepStep === 'start') {
                    // We're back at the base (bed respawn), right next to BOTH the
                    // elytra ender chest and the kit chest. Before burning a fresh
                    // elytra commuting out, hand off any kit deliveries that piled
                    // up while we were flying (a whisper mid-flight gets queued by
                    // bot-core rather than bounced). bot-core delivers ONE now if it
                    // can without idling on the 7-min /tpa cooldown; the rest go out
                    // on later returns (the map run covers the cooldown). Gated to
                    // the far base (outside the 5k spawn ring) so a stray acquire
                    // elsewhere never TPAs a player to the wrong place.
                    const dp = botPos();
                    const atBase = dp && Math.hypot(dp.x, dp.z) > 5000;
                    // Stranded inside the 5k zone (e.g. a server restart dropped us at
                    // world spawn)? No base or ender chest exists in here, so don't
                    // waste ACQUIRE_MAX_MS wandering - hand straight to 'recover', the
                    // patient /kill-home loop. (This is what made restarts auto-stop:
                    // three 2-min searches at spawn tripped the strike limit before the
                    // cooldown-gated /kill could land us home.)
                    if (dp && !atBase && !findNearestEnderChest()) {
                        setState('recover'); prepStep = null; teleportSentAt = 0;
                        return;
                    }
                    // (standalone build: no kit-delivery drain here - pure mapping)
                    prepStep = 'acquiring';
                    acquireElytra().then(ok => {
                        if (!active) return;
                        prepStep = null;
                        if (ok) { recoverKills = 0; awaitingRecoverDeath = false; setState('gotolaunch'); teleportSentAt = 0; return; }
                        // Chest opened but genuinely empty of elytras (global stock
                        // out): stop cleanly with a plain restock message - don't burn
                        // 3 strikes or /kill-loop, since retrying can't produce an
                        // elytra that isn't there.
                        if (outOfElytras) {
                            sendLog(`🪫 [mapper] Out of elytras - the ender chest is empty. Restock it with elytras, then \`!map on ${mappingMode}\` to resume.`);
                            stop();
                            return;
                        }
                        // No reachable ender chest => we're not at a base. This is NOT
                        // a failed run (no elytra was wasted) - hand to 'recover', the
                        // patient /kill-home loop, which has its own bounded safety
                        // (MAX_RECOVER_KILLS) if the bed is truly gone.
                        setState('recover');
                        teleportSentAt = 0;
                    }).catch(e => {
                        // Never let an acquire/dance error become an unhandled rejection
                        // (that logged giant stack traces and left prepStep stuck until
                        // PREP_TIMEOUT). Reset and let recovery take over.
                        lastError = `acquire threw: ${e && e.message}`;
                        prepStep = null;
                        if (active) { setState('recover'); teleportSentAt = 0; }
                    });
                    return;
                }
                if (inState(PREP_TIMEOUT_MS)) { setState('recover'); prepStep = null; teleportSentAt = 0; } // hung openContainer - recover (patient /kill loop, bounded by MAX_RECOVER_KILLS) rather than a strike
                break;
            }

            // Only reached when the bot ISN'T at the base (bed respawn failed, or
            // the operator started it somewhere odd). Get back to the base, where
            // the bed + ender chest are, then re-acquire.
            case 'recover': {
                const pos = botPos();
                if (!pos) return;
                // The ONLY elytra source is the ender chest at the RESPAWN base (bed),
                // reached by dying (/kill), not /home. Getting home from a stranding is
                // a PATIENT /kill loop, NOT a failed run: 6b6t's /kill has a ~30s
                // cooldown, so spamming it just gets each one silently rejected (which
                // is exactly what burned the old 2-min-search + 3-strike path and made
                // it auto-stop right before the /kill that would've worked). Send one
                // /kill, then wait out KILL_RETRY_MS before the next. A successful /kill
                // -> death -> onDeath -> 'acquire' (which, landing at the far base,
                // grabs an elytra and resets recoverKills). Only if MAX_RECOVER_KILLS
                // in a row all leave us stranded inside 5k (bed genuinely gone, deaths
                // land at world spawn) do we auto-stop - so a lost bed can't loop.
                const sinceKill = lastKillAt ? Date.now() - lastKillAt : Infinity;
                if (sinceKill < KILL_RETRY_MS) {
                    if (Date.now() - recoverLoggedAt > 15000) {
                        recoverLoggedAt = Date.now();
                        sendLog(`🗺️ [mapper] stranded at ${Math.round(pos.x)},${Math.round(pos.z)} - waiting out the ~30s /kill cooldown, then retrying to respawn on the bed.`);
                    }
                    return; // stay in 'recover', wait out the cooldown
                }
                // The previous recovery /kill produced NO death within the window - the
                // server is restarting/booting, we're stuck in the queue, or it was
                // cooldown-rejected. That /kill never actually tested the bed, so DON'T
                // count it toward the bed-gone limit; just retry patiently. (A real /kill
                // death is near-instant, so >KILL_RETRY_MS with no death = a genuine
                // no-op - onDeath would have cleared this flag.)
                if (awaitingRecoverDeath) {
                    if (Date.now() - recoverLoggedAt > 15000) {
                        recoverLoggedAt = Date.now();
                        sendLog(`🗺️ [mapper] /kill didn't take at ${Math.round(pos.x)},${Math.round(pos.z)} (server restarting / in queue / on cooldown) - retrying, NOT counting toward the bed-gone limit.`);
                    }
                    try { bot.hp.expectedDeath = true; bot.chat('/kill'); } catch (e) {}
                    lastKillAt = Date.now();
                    return;
                }
                // A REAL death+failed-acquire cycle (onDeath cleared awaitingRecoverDeath),
                // or the first attempt: only these count toward the bed-gone limit.
                if (recoverKills >= MAX_RECOVER_KILLS) {
                    const d = Math.round(Math.hypot(pos.x, pos.z));
                    const why = d <= HOME_BLOCKED_RADIUS
                        ? `the far bed looks genuinely gone - ${recoverKills} real deaths all landed at world spawn (${Math.round(pos.x)},${Math.round(pos.z)}). Re-sleep the bed at the far base`
                        : `I'm at the far base (${Math.round(pos.x)},${Math.round(pos.z)}) but still can't get an elytra - the ender chest may be missing, unopenable, or empty. Check the base`;
                    sendLog(`🛑 [mapper] auto-stopped after ${recoverKills} recovery deaths: ${why}, then \`!map on ${mappingMode}\`.`);
                    stop();
                    return;
                }
                recoverKills++;
                sendLog(`🗺️ [mapper] no elytra reachable at ${Math.round(pos.x)},${Math.round(pos.z)} - /kill to respawn on the bed (attempt ${recoverKills}/${MAX_RECOVER_KILLS}).`);
                try { bot.hp.expectedDeath = true; bot.chat('/kill'); } catch (e) {}
                lastKillAt = Date.now();
                awaitingRecoverDeath = true; // must SEE a death before the next attempt counts
                // Stay in 'recover': a successful /kill -> onDeath -> 'acquire'; a
                // cooldown-rejected one (no death) is retried by the guard above once
                // KILL_RETRY_MS elapses.
                break;
            }

            // Elytra secured at the (safe, far) respawn base - now /home spawn to
            // the launch base near the mapping zone, so the elytra isn't burned
            // commuting. /home is allowed because the respawn base is outside the
            // 5k no-/home ring. We confirm the teleport actually moved us (a /home
            // on cooldown is silently rejected) before handing off to launch.
            case 'gotolaunch': {
                if (!hasElytraEquipped()) { setState('acquire'); prepStep = 'start'; return; } // lost it somehow - restart
                const pos = botPos();
                if (!pos) return;
                // Already near the mapping zone (single-base setup, where the bed
                // and launch platform are the same near-spawn base)? Skip /home and
                // launch straight from here - no point teleporting to ~where we
                // already are and burning the /home cooldown. Only /home when we
                // respawned genuinely far out (dedicated far base).
                if (Math.hypot(pos.x, pos.z) <= LAUNCH_SKIP_HOME_DIST) { setState('launch'); return; }

                // A /home is already in flight - has it actually landed us at the
                // launch base yet?
                if (teleportSentAt) {
                    const moved = gotoFromPos ? Math.hypot(pos.x - gotoFromPos.x, pos.z - gotoFromPos.z) : 0;
                    if (moved > 200) {                       // teleport succeeded
                        lastHomeAt = Date.now();             // start the cooldown clock from the SUCCESS
                        teleportSentAt = 0;
                        setState('launch');
                        return;
                    }
                    if (Date.now() - teleportSentAt >= HOME_SETTLE_MS) {
                        // Didn't move within the warmup window => /home was silently
                        // rejected (still on cooldown). Do NOT fall through to launch:
                        // the far base has no takeoff edge, so launching here just
                        // fails 3x and auto-stops (the bug we hit). Reset and wait out
                        // the cooldown, then gotolaunch re-issues /home below.
                        teleportSentAt = 0;
                        lastHomeAt = Date.now();             // assume the server cooldown restarts ~now; wait a full window before retrying
                        cooldownWaitLoggedAt = 0;
                        sendLog(`🗺️ [mapper] /home spawn didn't land (still on cooldown) - holding at the far base until it's ready, then retrying.`);
                    }
                    return;
                }

                // No /home pending. Respect the /home cooldown before (re)issuing -
                // firing it while on cooldown is the silent-reject that stranded us.
                const sinceHome = lastHomeAt ? Date.now() - lastHomeAt : Infinity;
                if (sinceHome < HOME_COOLDOWN_MS) {
                    if (Date.now() - cooldownWaitLoggedAt > 60000) { // one line/min so the operator sees why it's idle
                        cooldownWaitLoggedAt = Date.now();
                        sendLog(`🗺️ [mapper] waiting ~${Math.ceil((HOME_COOLDOWN_MS - sinceHome) / 1000)}s for the /home cooldown before commuting to the launch base.`);
                    }
                    return;
                }
                gotoFromPos = { x: pos.x, z: pos.z };
                try { bot.chat(`/home ${HOME_NAME}`); } catch (e) {}
                teleportSentAt = Date.now();
                sendLog(`🗺️ [mapper] elytra secured at ${Math.round(pos.x)},${Math.round(pos.z)} - /home ${HOME_NAME} to the launch base.`);
                break;
            }

            // Walk off the platform edge. A deploy is only legal once we're off
            // the ground (bot.elytraFly() throws "Unable to fly from ground"), so
            // this step is mandatory - it's the bit we were missing all along.
            case 'launch': {
                if (!hasElytraEquipped()) { setState('acquire'); prepStep = 'start'; return; }
                const pos = botPos();
                if (!pos) return;
                if (!flightStarted) {
                    ascendStartY = pos.y;
                    flightStarted = true;
                    launchAttemptAt = Date.now(); // anchors the launch timeout to the ATTEMPT, so bouncing launch<->deploy can't reset it forever
                    ascentTraced = {};
                    flightLog = []; // fresh recorder for this attempt
                    let feet = '?';
                    try { const b = bot.blockAt(pos.offset(0, -1, 0)); feet = b ? b.name : '?'; } catch (e) {}
                    sendLog(`🗺️ [mapper] launching: walking off the edge at Y${Math.round(pos.y)} (standing on ${feet}) to get airborne.`);
                }
                // Only hand over to 'deploy' once we're GENUINELY falling, not on
                // the single !onGround tick you get stepping down a ledge - that
                // premature switch left the bot sitting in 'deploy' back on solid
                // ground, where a deploy is illegal, until it timed out.
                if (!bot.entity.onGround && bot.entity.velocity.y < -0.15) {
                    try { bot.clearControlStates(); } catch (e) {}
                    lastError = null; // don't carry a stale message into deploy's failure text
                    setState('deploy');
                    return;
                }
                // Walk off toward the LAUNCH heading (pickLaunchTarget), NOT the
                // boustrophedon mapping target - keeps takeoff on the known-good
                // heading so the routing can never aim the walk-off into a platform wall.
                try {
                    const t = pickLaunchTarget();
                    if (t) {
                        const yaw = Math.atan2(-(t.x - pos.x), -(t.z - pos.z));
                        bot.look(yaw, 0, false);
                    }
                    bot.setControlState('forward', true);
                    bot.setControlState('sprint', true);
                } catch (e) {}
                if (launchAttemptAt && Date.now() - launchAttemptAt >= LAUNCH_TIMEOUT_MS) {
                    try { bot.clearControlStates(); } catch (e) {}
                    clearFlight(); setState('idle');
                    noteRunFailure('never left the platform edge (is the launch platform enclosed?)');
                }
                break;
            }

            // Airborne: send the real deploy and wait for the SERVER to confirm
            // gliding (mineflayer sets entity.elytraFlying from entity metadata).
            case 'deploy': {
                if (!hasElytraEquipped()) { setState('falling'); return; }
                // Back on solid ground before the deploy took? An elytra deploy is
                // illegal from the ground, so waiting here is pointless - go back
                // to walking off the edge instead of timing out and failing.
                if (bot.entity.onGround && !isGliding()) {
                    setState('launch');
                    return;
                }
                if (isGliding()) {
                    runFailures = 0; // a run that actually got flying resets the streak
                    topUpBoost();
                    const p = botPos();
                    launchPos = p ? { x: p.x, z: p.z } : null; // departure reference
                    runMaxDist = 0; // fresh run - start tracking how far this elytra gets (drives rotation)
                    sendLog(`🗺️ [mapper] GLIDING at Y${p ? Math.round(p.y) : '?'} - boost engaged, mapping (${covered.size}/${waypoints.length} cells covered).`);
                    setState('mapping');
                    return;
                }
                // (Re)send the deploy while airborne, retrying rather than firing
                // once - a momentary onGround flicker as we clear the edge would
                // otherwise make elytraFly() throw and never be retried.
                if (!bot.entity.onGround && Date.now() - (ascentTraced.lastDeployAt || 0) > 800) {
                    ascentTraced.lastDeployAt = Date.now();
                    bot.elytraFly()
                        .then(() => {
                            console.log('[mapper] elytraFly() sent.');
                            // mineflayer only flips entity.elytraFlying from server
                            // ENTITY METADATA, which the server broadcasts about
                            // other entities and may never echo back for our own
                            // player - in which case we'd wait forever and fall to
                            // our death every run. A vanilla client also sets its
                            // own gliding state locally, and prismarine-physics
                            // re-validates it every tick (clearing it unless
                            // elytraEquipped && !onGround && !levitation), so this
                            // cannot produce impossible movement.
                            try { if (bot.entity) bot.entity.elytraFlying = true; } catch (e) {}
                        })
                        .catch(e => { lastError = `elytraFly: ${e.message}`; console.log(`[mapper] elytraFly() rejected: ${e.message}`); });
                }
                if (!ascentTraced.t2 && inState(2000)) { ascentTraced.t2 = true; traceAscent('deploy 2s'); }
                if (inState(DEPLOY_CONFIRM_MS)) {
                    dumpFlightLog('deploy never confirmed');
                    clearFlight(); setState('falling'); // never engaged - ride it down and retry
                    noteRunFailure(`deploy not confirmed by server (${lastError || 'no elytraFlying flag'})`);
                }
                break;
            }

            case 'mapping': {
                if (!hasElytraEquipped()) {
                    sendLog(`🗺️ [mapper] elytra broke - falling. (${cellsMappedThisSession} cells, ${tilesWrittenThisSession} tiles this run, reached ~${Math.round(runMaxDist)} blocks)`);
                    // Rotation is advanced in onDeath now (fires for ANY run-ending
                    // death - clean break OR a transfer/fall kill) so a churny server
                    // can't pin us on one highway. Don't rotate here too (double-count).
                    try { bot.hp.expectedDeath = true; } catch (e) {} // it's a deliberate fall-to-death, don't fire the "died unexpectedly" alert
                    setState('falling');
                    return;
                }
                const pos = botPos();
                if (!pos) return;

                // Glide ended. Don't theorize - report exactly what's true right
                // now, plus the WHOLE recorded trajectory, so this is settled by
                // data instead of guesswork (a "GLIDING" / "no longer gliding"
                // pair alone is NOT proof of what happened in between).
                if (!isGliding()) {
                    const onG = !!(bot.entity && bot.entity.onGround);
                    const stillHas = hasElytraEquipped();
                    const travelled = launchPos ? Math.hypot(pos.x - launchPos.x, pos.z - launchPos.z) : 0;
                    let feet = '?';
                    try { const b = bot.blockAt(pos.offset(0, -1, 0)); feet = b ? b.name : 'air/unloaded'; } catch (e) {}
                    const sinceReconfig = lastReconfigureAt ? Date.now() - lastReconfigureAt : null;
                    sendLog(`🗺️ [mapper] glide ended at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} after ${Math.round(travelled)} blocks - onGround=${onG}, standing on "${feet}", elytra=${stillHas}, last server reconfigure ${sinceReconfig === null ? 'never' : sinceReconfig + 'ms ago'}.`);
                    dumpFlightLog('glide ended');
                    // Landed safely and still holding the elytra? Just relaunch.
                    // Do NOT fall through to 'falling' - that /kills after 30s, and
                    // dying DROPS the elytra. That bug burned the entire stock.
                    if (stillHas && onG) {
                        noteRunFailure(`landed after only ${Math.round(travelled)} blocks`);
                        if (!active) return;
                        clearFlight();
                        setState('launch');
                        return;
                    }
                    setState('falling'); // elytra actually gone / genuinely airborne
                    return;
                }
                // Don't boost until we're clear of the base: boosting right next to
                // the platform is what arcs the bot back up onto it.
                if (!launchPos || Math.hypot(pos.x - launchPos.x, pos.z - launchPos.z) >= DEPART_DIST) topUpBoost();
                if (launchPos) runMaxDist = Math.max(runMaxDist, Math.hypot(pos.x - launchPos.x, pos.z - launchPos.z)); // track how far this elytra got, for the rotate decision

                // Re-pick if there's no target, OR if the (now longer-lived) lane
                // target has since been covered - e.g. the diagonal transit-in leg
                // painted part of a lane we were about to fly, so don't waste a pass
                // re-covering it.
                if (!currentTargetPt || covered.has(cellKey(currentTargetPt))) currentTargetPt = pickTarget();
                const target = currentTargetPt;
                if (!target) return; // no uncovered cell right now (fresh pass starts next tick)
                steerFlight(target);
                // Distance-based render: fire once we've moved RENDER_STEP blocks
                // from the last successful render. NO wall-clock floor - the
                // busySlicing guard already prevents overlapping slices, so the
                // real spacing is max(RENDER_STEP, render_duration x speed). The old
                // `>= RENDER_INTERVAL_MS` floor STACKED on top of the ~3s render
                // (floor timer starts at completion), making cycles ~5.5s => ~130+
                // blocks apart at cruise, past the 113 footprint => the stripe gaps.
                // Dropping it lets renders fire every ~70 blocks (< footprint) so
                // passes overlap.
                const movedEnough = !lastRenderPos || dist2D(pos, lastRenderPos) >= RENDER_STEP;
                if (movedEnough) { renderAndSlice(); }
                if (dist2D(pos, target) <= ARRIVE_DIST) {
                    renderAndSlice();
                    covered.add(cellKey(target));
                    cellsMappedThisSession++;
                    currentTargetPt = pickTarget();
                }
                // Stuck guard: if we make no real horizontal progress for a while
                // (jammed against a build, elytrafly stalled, etc.), /kill to reset
                // rather than sit there until the elytra runs out doing nothing.
                if (!stuckAnchor || Math.hypot(pos.x - stuckAnchor.x, pos.z - stuckAnchor.z) > 12) {
                    stuckAnchor = { x: pos.x, z: pos.z }; stuckAnchorAt = Date.now();
                } else if (Date.now() - stuckAnchorAt > 25000) {
                    sendLog(`🗺️ [mapper] no progress for 25s at ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)} - resetting the run.`);
                    dumpFlightLog('stuck / no progress');
                    try { bot.hp.expectedDeath = true; bot.chat('/kill'); } catch (e) {}
                    stuckAnchor = null;
                    setState('falling');
                }
                break;
            }

            case 'falling': {
                // Landed safely somewhere (a build, terrain, anything) still
                // wearing a working elytra? Just relaunch from here - /killing
                // would throw away a perfectly good elytra for nothing. Confirmed
                // live: the bot clipped an obsidian build at Y320, glided to a
                // stop ON it with the elytra intact, and was about to /kill.
                if (bot.entity && bot.entity.onGround && hasElytraEquipped()) {
                    const p = botPos();
                    sendLog(`🗺️ [mapper] down safely at ${p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?'} with the elytra intact - relaunching instead of dying.`);
                    clearFlight();
                    setState('launch');
                    return;
                }
                try { bot.hp.expectedDeath = true; } catch (e) {} // deliberate fall/kill - suppress the unexpected-death alert
                clearFlight();
                // Let fall damage finish the job. onDeath() moves us on; this
                // just backstops the rare "survived the fall" case.
                if (inState(FALL_TIMEOUT_MS)) {
                    try { bot.chat('/kill'); } catch (e) {}
                    setState('acquire'); prepStep = 'start'; teleportSentAt = 0;
                }
                break;
            }
        }
    }

    // ---- lifecycle hooks (called from bot-core's own events) --------------
    function onDeath() {
        if (!active) return;
        // ANY death that happens mid-flight (fall damage, flying into terrain,
        // suffocation, anything NOT already explained by the mapping state's own
        // "elytra broke"/"glide ended" checks) used to vanish here with zero
        // diagnostics - onDeath just did cleanup silently. Dump whatever the
        // recorder captured in the seconds before, unconditionally, so a hard
        // death is never a black box.
        if (state === 'launch' || state === 'deploy' || state === 'mapping' || state === 'falling') {
            sendLog(`☠️ [mapper] DIED while in state '${state}' - dumping the flight trace leading up to it.`);
            dumpFlightLog('DIED', 30);
            // A flight run just ended - a clean elytra-break OR a transfer/fall kill.
            // Advance the rotation HERE, not only on a clean break, so a churny server
            // (transfer-deaths before the elytra wears out) can't pin the rotation on
            // one highway all night. maybeRotateHighway decides rotate-vs-stay from
            // runMaxDist + the short-run cap. Delivery/recover /kills land here with a
            // non-flight state, so they don't rotate.
            if (rotating) maybeRotateHighway();
            runMaxDist = 0; // fresh for the next run (also reset at GLIDING); avoids a launch-death reusing the prior run's distance
        }
        // Every death (worn-out elytra, a /kill reset, or anything else) puts the
        // bot back on its bed AT the base, where the ender chest is - so the next
        // step is simply to grab another elytra. No teleport, no /home cooldown.
        clearFlight();
        currentTargetPt = null; // re-pick the nearest uncovered cell from the base
        awaitingRecoverDeath = false; // a death actually happened - a pending recovery /kill landed (so it counts / lets acquire run)
        setState('acquire');
        prepStep = 'start';
        teleportSentAt = 0;
    }
    function onSpawn() {
        // Nothing special needed - the tick's 'acquire' state picks up as soon as
        // the bot is back on the main server. Kept as a hook for clarity/future.
    }

    // Rotate to the next highway in ROTATION_ORDER, but only once a run has gone
    // the distance (an elytra does ~20-30k; no point re-flying the same inner
    // stretch). A short run (crash/transfer) stays on the current highway to
    // finish it - unless it keeps failing, in which case rotate anyway so a bad
    // spot can't pin us. Called at the elytra-break in the mapping state.
    function maybeRotateHighway() {
        const full = runMaxDist >= ROTATE_MIN_DIST;
        if (full) shortRunsThisHighway = 0; else shortRunsThisHighway++;
        if (!full && shortRunsThisHighway < ROTATE_MAX_SHORT_RUNS) {
            sendLog(`🔁 [mapper] ${mappingMode} run only reached ~${Math.round(runMaxDist)} blocks (<${ROTATE_MIN_DIST}) - retrying ${mappingMode} (${shortRunsThisHighway}/${ROTATE_MAX_SHORT_RUNS}) before rotating.`);
            return;
        }
        const order = (rotateSet && rotateSet.length) ? rotateSet : ROTATION_ORDER;
        const idx = order.indexOf(mappingMode);
        const next = order[(idx + 1) % order.length]; // idx -1 (current highway not in the set) -> start at the set's front
        sendLog(`🔄 [mapper] rotating ${mappingMode} -> ${next} highway (run reached ~${Math.round(runMaxDist)} blocks). Set: ${order.join('>')}.`);
        mappingMode = next;
        waypoints = buildWaypoints(next);
        rebuildLaneIndex();
        covered.clear();
        currentTargetPt = null;
        seedCoveredFromDisk();
        shortRunsThisHighway = 0;
        persistEnabled(true, mappingMode, true, rotateSet); // survive a restart mid-rotation on the right highway + set
    }

    function start(mode, opts) {
        if (active) return 'already running';
        mode = (mode || 'spawn').toLowerCase();
        if (mode === 'rotate') {
            // Cycle through rotateSet, one full elytra run each. A fresh explicit
            // cue (opts.rotateSet, e.g. from `!map on rotate nw,ne,north,east,west`)
            // starts at the front of the given set; a bare resume continues the
            // persisted highway + set. Invalid direction names are dropped; an
            // empty result falls back to all 8.
            rotating = true;
            const persisted = wasEnabledPersisted();
            const clean = (arr) => (arr || []).map(s => String(s).toLowerCase().trim()).filter(d => ROTATION_ORDER.includes(d));
            const fromOpts = opts && Array.isArray(opts.rotateSet) ? clean(opts.rotateSet) : null;
            if (fromOpts && fromOpts.length) {
                rotateSet = fromOpts;
                mappingMode = rotateSet[0]; // explicit cue -> begin at the front
            } else {
                rotateSet = (persisted.rotateSet && clean(persisted.rotateSet).length) ? clean(persisted.rotateSet) : ROTATION_ORDER.slice();
                mappingMode = rotateSet.includes(persisted.mode) ? persisted.mode : rotateSet[0]; // resume where we were
            }
        } else {
            if (!mode.startsWith('ring') && !mode.startsWith('box:') && !(mode in MAPPING_MODES)) return `unknown mode "${mode}" (valid: ${Object.keys(MAPPING_MODES).join(', ')}, ring-nw|ne|se|sw, box:x1,z1,x2,z2, rotate)`;
            rotating = false;
            mappingMode = mode;
        }
        // Rebuild the target set for this mode and re-seed coverage from disk, so
        // switching spawn<->a highway (or resuming one) targets the right corridor
        // and doesn't re-fly ground the map already has.
        waypoints = buildWaypoints(mappingMode);
        rebuildLaneIndex();
        covered.clear();
        currentTargetPt = null;
        seedCoveredFromDisk();
        active = true;
        persistEnabled(true, mappingMode, rotating, rotating ? rotateSet : null); // survive a restart - see STATE_FILE note up top
        cellsMappedThisSession = 0;
        tilesWrittenThisSession = 0;
        runFailures = 0;    // fresh start - don't carry a prior run's strike/recovery counters
        recoverKills = 0;
        awaitingRecoverDeath = false;
        lastKillAt = 0;
        shortRunsThisHighway = 0;
        runMaxDist = 0;
        lastError = null;
        flightStarted = false;
        setState('idle');
        if (!tickTimer) tickTimer = setInterval(() => { tick().catch(e => { lastError = e.message; }); }, TICK_MS);
        return rotating ? `started (rotate ${rotateSet.join('>')}, beginning on ${mappingMode})` : `started (${mappingMode})`;
    }
    function stop() {
        if (!active) return 'already stopped';
        // clearFlight() only clears CONTROL STATES (sprint/forward) - it does not
        // and cannot cut the bot's existing glide (elytraFlying is server/physics
        // state, not a control) or its remaining boost. And once active=false, the
        // tick loop's own `if (!active) return` means NOTHING further runs for
        // this bot - no more steering, no more boost top-ups, no more trace
        // recording, and onDeath()'s own `if (!active) return` means even a death
        // afterward goes completely unlogged. So a mid-air !map off leaves the
        // bot gliding un-piloted until it lands or the elytra breaks, with silence
        // where a trace/death log would normally be - say so up front, otherwise
        // every mid-flight stop looks like an unexplained crash later.
        const wasFlying = (state === 'launch' || state === 'deploy' || state === 'mapping' || state === 'falling');
        const pos = botPos();
        active = false;
        persistEnabled(false, mappingMode, rotating, rotating ? rotateSet : null); // operator (or auto-stop) ended it - don't auto-resume after a restart
        clearFlight();
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } // stop the 500ms loop entirely (it already no-ops on !active; start() recreates it) - no reason to keep firing while stopped
        setState('idle');
        if (wasFlying) {
            sendLog(`🗺️ [mapper] Stopped mid-flight${pos ? ` at Y${Math.round(pos.y)}` : ''} - the bot will keep gliding un-steered on its last heading until it lands or the elytra breaks. That's expected (not a crash), and nothing further will be logged for it since the mapper is now off.`);
        }
        return 'stopped';
    }
    function isActive() { return active; }
    function isBusyFlying() { return active && (state === 'gotolaunch' || state === 'launch' || state === 'deploy' || state === 'mapping' || state === 'falling'); }
    function status() {
        const pos = botPos();
        return {
            active, state, mode: mappingMode, rotating, rotateSet: rotating ? rotateSet : null,
            pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
            covered: covered.size, waypoints: waypoints.length,
            target: currentTargetPt ? `${currentTargetPt.x},${currentTargetPt.z}` : null,
            cellsThisSession: cellsMappedThisSession,
            tilesThisSession: tilesWrittenThisSession,
            elytra: hasElytraEquipped(),
            lastError
        };
    }

    return { start, stop, isActive, isBusyFlying, estimateSecondsLeft, testShulkerDance, onDeath, onSpawn, status, wasEnabled: wasEnabledPersisted };
}

module.exports = { createSpawnMapper };
