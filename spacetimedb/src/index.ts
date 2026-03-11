import { schema, t, SenderError } from "spacetimedb/server";
import { Player, GameConfig, Obstacle, BotZombie } from "./schema";

// ─── Constants ─────────────────────────────────────────────────────────────
const HUMAN_SPEED = 200.0;
const ZOMBIE_SPEED = 140.0;
const INFECTION_RADIUS = 40.0;
const TICK_MICROS = 50_000n; // 50ms
const ROUND_RESET_DELAY_MICROS = 10_000_000n; // 10 seconds
const ROUND_DURATION_MICROS = 3n * 60n * 1_000_000n; // 3 minutes
const ZOMBIE_SPEED_BOOST = 270.0;
const ZOMBIE_BOOST_DURATION_MICROS = 3n * 1_000_000n; // 3 seconds
const ZOMBIE_ABILITY_COOLDOWN_MICROS = 15n * 1_000_000n; // 15 seconds
const BASE_MAP_SIZE = 2000.0;
const MIN_PLAYERS_TO_START = 1;
const TICK_DT_SEC = Number(TICK_MICROS) / 1_000_000;

const ROOM_ID_MENU = 0n;
const ROOM_ID_VS_HUMANS = 1n;
const ROOM_ID_VS_BOTS = 2n;
const LOBBY_ROOM_IDS = [ROOM_ID_VS_HUMANS, ROOM_ID_VS_BOTS] as const;

// Room-scoped queries: use index when runtime exposes it, else fall back to iter + filter
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function playersInRoom(ctx: { db: unknown }, roomId: bigint): any[] {
  const table = (ctx.db as { Player: { iter: () => Iterable<{ roomId: bigint }>; player_room_id?: { filter: (id: bigint) => Iterable<unknown> } } }).Player;
  if (table?.player_room_id) return [...table.player_room_id.filter(roomId)];
  return [...table.iter()].filter((p: { roomId: bigint }) => p.roomId === roomId);
}
function obstaclesInRoom(ctx: { db: unknown }, roomId: bigint): ObstacleRow[] {
  const table = (ctx.db as { Obstacle: { iter: () => Iterable<ObstacleRow>; obstacle_room_id?: { filter: (id: bigint) => Iterable<ObstacleRow> }; id: { delete: (id: bigint) => void } } }).Obstacle;
  if (table?.obstacle_room_id) return [...table.obstacle_room_id.filter(roomId)];
  return [...table.iter()].filter((o) => o.roomId === roomId);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function botZombiesInRoom(ctx: { db: unknown }, roomId: bigint): any[] {
  const table = (ctx.db as { BotZombie: { iter: () => Iterable<{ roomId: bigint }>; bot_zombie_room_id?: { filter: (id: bigint) => Iterable<unknown> } } }).BotZombie;
  if (table?.bot_zombie_room_id) return [...table.bot_zombie_room_id.filter(roomId)];
  return [...table.iter()].filter((b: { roomId: bigint }) => b.roomId === roomId);
}

// Vs bots: zombie spawn ramp (deterministic)
const BOT_SPAWN_BASE_INTERVAL_MICROS = 8n * 1_000_000n; // 8 seconds at start
const BOT_SPAWN_MIN_INTERVAL_MICROS = 1_500_000n; // 1.5 seconds min
const BOT_SPAWN_RAMP_MICROS_PER_SEC = 50_000n; // interval decreases by 50ms per real second

function mapSizeForPlayers(count: number): number {
  if (count <= 0) return BASE_MAP_SIZE;
  const size = Math.sqrt(count) * 400;
  return Math.max(BASE_MAP_SIZE, Math.min(size, 8000));
}

function normalizeDir(x: number, y: number): { x: number; y: number } {
  const len = Math.sqrt(x * x + y * y);
  if (len <= 1e-6) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/** Deterministic hash in [0, 1) from a string seed. Reducers must not use Math.random(). */
function deterministicHash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 1e6) / 1e6;
}

// ─── Obstacle constants ─────────────────────────────────────────────────────
const PLAYER_HALF = 16;
const WALL_THICKNESS = 16;
const DOOR_GAP = 40;
const MARGIN = 120;

type ObstacleRow = {
  id: bigint;
  roomId: bigint;
  groupId: bigint;
  x: number;
  y: number;
  width: number;
  height: number;
  obstacleType: string;
};

function collidesWithObstacle(
  obstacles: ObstacleRow[],
  px: number,
  py: number,
  halfSize: number,
): boolean {
  for (const o of obstacles) {
    const obsLeft = o.x - o.width / 2;
    const obsRight = o.x + o.width / 2;
    const obsTop = o.y - o.height / 2;
    const obsBottom = o.y + o.height / 2;
    if (
      px - halfSize < obsRight &&
      px + halfSize > obsLeft &&
      py - halfSize < obsBottom &&
      py + halfSize > obsTop
    ) {
      return true;
    }
  }
  return false;
}

function insertObstacle(
  ctx: {
    db: {
      Obstacle: {
        insert: (row: {
          id: bigint;
          roomId: bigint;
          groupId: bigint;
          x: number;
          y: number;
          width: number;
          height: number;
          obstacleType: string;
        }) => void;
      };
    };
  },
  roomId: bigint,
  groupId: bigint,
  x: number,
  y: number,
  width: number,
  height: number,
  obstacleType: string,
): void {
  ctx.db.Obstacle.insert({
    id: 0n,
    roomId,
    groupId,
    x,
    y,
    width,
    height,
    obstacleType,
  });
}

function generateBuilding(
  ctx: {
    db: {
      Obstacle: {
        insert: (row: {
          id: bigint;
          roomId: bigint;
          groupId: bigint;
          x: number;
          y: number;
          width: number;
          height: number;
          obstacleType: string;
        }) => void;
      };
    };
  },
  roomId: bigint,
  roundNum: bigint,
  index: number,
  mapW: number,
  mapH: number,
): void {
  const seedBase = `building-${roundNum}-${index}`;
  const cx = MARGIN + deterministicHash(seedBase) * (mapW - 2 * MARGIN);
  const cy = MARGIN + deterministicHash(seedBase + "y") * (mapH - 2 * MARGIN);
  const w = 160 + deterministicHash(seedBase + "w") * 80;
  const h = 120 + deterministicHash(seedBase + "h") * 80;
  const halfW = w / 2;
  const halfH = h / 2;
  const t = WALL_THICKNESS;
  const gap = DOOR_GAP;
  const groupId = BigInt(1000 + index);

  // Top wall: two segments with gap in middle
  const topLeftSegW = halfW - gap / 2;
  const topRightSegW = halfW - gap / 2;
  insertObstacle(
    ctx,
    roomId,
    groupId,
    cx - halfW + topLeftSegW / 2,
    cy - halfH - t / 2,
    topLeftSegW,
    t,
    "building_wall",
  );
  insertObstacle(
    ctx,
    roomId,
    groupId,
    cx + halfW - topRightSegW / 2,
    cy - halfH - t / 2,
    topRightSegW,
    t,
    "building_wall",
  );

  // Bottom wall
  insertObstacle(
    ctx,
    roomId,
    groupId,
    cx - halfW + topLeftSegW / 2,
    cy + halfH + t / 2,
    topLeftSegW,
    t,
    "building_wall",
  );
  insertObstacle(
    ctx,
    roomId,
    groupId,
    cx + halfW - topRightSegW / 2,
    cy + halfH + t / 2,
    topRightSegW,
    t,
    "building_wall",
  );

  // Left wall: two segments with gap
  const leftGapTop = halfH - gap / 2;
  const leftGapBottom = halfH + gap / 2;
  const leftTopSegH = leftGapTop;
  const leftBottomSegH = h - leftGapBottom;
  insertObstacle(
    ctx,
    roomId,
    groupId,
    cx - halfW - t / 2,
    cy - halfH + leftTopSegH / 2,
    t,
    leftTopSegH,
    "building_wall",
  );
  insertObstacle(
    ctx,
    roomId,
    groupId,
    cx - halfW - t / 2,
    cy + halfH - leftBottomSegH / 2,
    t,
    leftBottomSegH,
    "building_wall",
  );

  // Right wall
  insertObstacle(
    ctx,
    roomId,
    groupId,
    cx + halfW + t / 2,
    cy - halfH + leftTopSegH / 2,
    t,
    leftTopSegH,
    "building_wall",
  );
  insertObstacle(
    ctx,
    roomId,
    groupId,
    cx + halfW + t / 2,
    cy + halfH - leftBottomSegH / 2,
    t,
    leftBottomSegH,
    "building_wall",
  );

  // Internal divider(s): 1 or 2 walls with gap
  const divCount = deterministicHash(seedBase + "div") < 0.5 ? 1 : 2;
  for (let d = 0; d < divCount; d++) {
    const vert = deterministicHash(seedBase + `div-${d}`) < 0.5;
    const gapPos = deterministicHash(seedBase + `divgap-${d}`);
    if (vert) {
      const divX = cx - halfW + (w * (0.3 + 0.4 * d)) / divCount;
      const segH = halfH * gapPos * 0.8;
      insertObstacle(
        ctx,
        roomId,
        groupId,
        divX,
        cy - halfH + segH / 2,
        t,
        segH,
        "building_wall",
      );
      insertObstacle(
        ctx,
        roomId,
        groupId,
        divX,
        cy + halfH - segH / 2,
        t,
        segH,
        "building_wall",
      );
    } else {
      const divY = cy - halfH + (h * (0.35 + 0.3 * d)) / divCount;
      const segW = halfW * gapPos * 0.8;
      insertObstacle(
        ctx,
        roomId,
        groupId,
        cx - halfW + segW / 2,
        divY,
        segW,
        t,
        "building_wall",
      );
      insertObstacle(
        ctx,
        roomId,
        groupId,
        cx + halfW - (halfW - segW) / 2,
        divY,
        halfW - segW,
        t,
        "building_wall",
      );
    }
  }
}

function generateRuin(
  ctx: {
    db: {
      Obstacle: {
        insert: (row: {
          id: bigint;
          roomId: bigint;
          groupId: bigint;
          x: number;
          y: number;
          width: number;
          height: number;
          obstacleType: string;
        }) => void;
      };
    };
  },
  roomId: bigint,
  roundNum: bigint,
  index: number,
  mapW: number,
  mapH: number,
): void {
  const seedBase = `ruin-${roundNum}-${index}`;
  const baseX = MARGIN + deterministicHash(seedBase) * (mapW - 2 * MARGIN);
  const baseY =
    MARGIN + deterministicHash(seedBase + "y") * (mapH - 2 * MARGIN);
  const orient = Math.floor(deterministicHash(seedBase + "o") * 3);
  const groupId = BigInt(2000 + index);
  const numFrags = 3 + Math.floor(deterministicHash(seedBase + "n") * 4);
  const isHoriz = orient === 0;
  const len = 80 + deterministicHash(seedBase + "len") * 100;
  let pos = 0;
  for (let i = 0; i < numFrags && pos < len; i++) {
    const gap = 15 + deterministicHash(seedBase + `g-${i}`) * 15;
    pos += gap;
    const segLen = 30 + deterministicHash(seedBase + `l-${i}`) * 50;
    const segW = 12 + deterministicHash(seedBase + `w-${i}`) * 8;
    const perp = (deterministicHash(seedBase + `p-${i}`) - 0.5) * 24;
    const cx = baseX + (isHoriz ? pos + segLen / 2 : perp);
    const cy = baseY + (isHoriz ? perp : pos + segLen / 2);
    insertObstacle(
      ctx,
      roomId,
      groupId,
      cx,
      cy,
      isHoriz ? segLen : segW,
      isHoriz ? segW : segLen,
      "ruin",
    );
    pos += segLen;
  }
}

function generateTrees(
  ctx: {
    db: {
      Obstacle: {
        insert: (row: {
          id: bigint;
          roomId: bigint;
          groupId: bigint;
          x: number;
          y: number;
          width: number;
          height: number;
          obstacleType: string;
        }) => void;
      };
    };
  },
  roomId: bigint,
  roundNum: bigint,
  startIndex: number,
  count: number,
  mapW: number,
  mapH: number,
): void {
  for (let i = 0; i < count; i++) {
    const seed = `tree-${roundNum}-${startIndex + i}`;
    const x = MARGIN + deterministicHash(seed) * (mapW - 2 * MARGIN);
    const y = MARGIN + deterministicHash(seed + "y") * (mapH - 2 * MARGIN);
    const size = 24 + deterministicHash(seed + "s") * 12;
    insertObstacle(ctx, roomId, 0n, x, y, size, size, "tree");
  }
}

function generateAllObstacles(
  ctx: { db: unknown },
  roomId: bigint,
  roundNum: bigint,
  mapW: number,
  mapH: number,
): void {
  const db = ctx.db as { Obstacle: { id: { delete: (id: bigint) => void } } };
  for (const o of obstaclesInRoom(ctx, roomId)) {
    db.Obstacle.id.delete(o.id);
  }
  const area = mapW * mapH;
  const numBuildings = Math.max(
    12,
    Math.min(18, Math.floor((area / 1e6) * 4.5)),
  );
  const numRuins = Math.max(30, Math.min(45, Math.floor((area / 1e6) * 9)));
  const numTrees = Math.max(90, Math.min(150, Math.floor((area / 1e6) * 36)));
  const ctxWithObstacle = ctx as { db: { Obstacle: { insert: (row: unknown) => void } } };
  for (let b = 0; b < numBuildings; b++)
    generateBuilding(ctxWithObstacle, roomId, roundNum, b, mapW, mapH);
  for (let r = 0; r < numRuins; r++)
    generateRuin(ctxWithObstacle, roomId, roundNum, r, mapW, mapH);
  generateTrees(ctxWithObstacle, roomId, roundNum, 0, numTrees, mapW, mapH);
}

const spacetimedb = schema({ Player, GameConfig, Obstacle, BotZombie });
export default spacetimedb;

// ─── ping: no-op procedure for client connection RTT measurement ─
export const ping = spacetimedb.procedure(t.unit(), () => ({}));

// ─── tick: game loop (call from client every ~50ms; server throttles to 50ms) ─
export const tick = spacetimedb.reducer((ctx) => {
  const now = ctx.timestamp.microsSinceUnixEpoch;

  for (const roomId of LOBBY_ROOM_IDS) {
    const config = ctx.db.GameConfig.id.find(roomId);
    if (!config) continue;

    // Round reset after delay (replaces scheduled RoundResetJob)
    if (
      !config.roundActive &&
      config.roundEndMicros > 0n &&
      now - config.roundEndMicros >= ROUND_RESET_DELAY_MICROS
    ) {
      const players = playersInRoom(ctx, roomId);
      if (players.length === 0) {
        ctx.db.GameConfig.id.update({
          ...config,
          roundEndMicros: 0n,
          lastTickMicros: now,
        });
        continue;
      }
      const mapW = config.mapWidth;
      const mapH = config.mapHeight;
      const newRound = config.roundNumber + 1n;
      const vsBots = config.gameMode === "vs_bots";
      if (vsBots) {
        for (const bz of botZombiesInRoom(ctx, roomId)) {
          ctx.db.BotZombie.id.delete(bz.id);
        }
      }
      generateAllObstacles(ctx, roomId, newRound, mapW, mapH);
      const obstacles = obstaclesInRoom(ctx, roomId);
      const firstIdx = vsBots ? -1 : Number(newRound % BigInt(players.length));
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        const seed = `${newRound}-${i}-${p.identity.toHexString()}`;
        let x = deterministicHash(seed) * (mapW - 100) + 50;
        let y = deterministicHash(seed + "y") * (mapH - 100) + 50;
        const nudge = 48;
        while (collidesWithObstacle(obstacles, x, y, PLAYER_HALF)) {
          x = Math.max(
            50,
            Math.min(mapW - 50, x + (i % 2 === 0 ? nudge : -nudge)),
          );
          y = Math.max(
            50,
            Math.min(mapH - 50, y + (i % 3 === 0 ? nudge : -nudge)),
          );
        }
        ctx.db.Player.identity.update({
          ...p,
          x,
          y,
          dirX: 0,
          dirY: 0,
          isZombie: vsBots ? false : i === firstIdx,
          isBot: false,
          score: 0n,
          speedBoostUntilMicros: 0n,
          abilityCooldownUntilMicros: 0n,
        });
      }
      ctx.db.GameConfig.id.update({
        ...config,
        roundActive: true,
        roundNumber: newRound,
        roundStartMicros: now,
        roundEndMicros: 0n,
        lastTickMicros: now,
        lastBotZombieSpawnMicros: vsBots ? now : config.lastBotZombieSpawnMicros,
        roundWinner: undefined,
      });
      continue;
    }

    // Throttle: only run game logic every TICK_MICROS
    if (now - config.lastTickMicros < TICK_MICROS) continue;

    ctx.db.GameConfig.id.update({ ...config, lastTickMicros: now });

    if (!config.roundActive) {
      // If roundEndMicros > 0, we're in the post-round delay — wait for reset logic above
      if (config.roundEndMicros > 0n) continue;
      if (config.gameMode !== "vs_humans" && config.gameMode !== "vs_bots") continue;
      const players = playersInRoom(ctx, roomId);
      const vsBots = config.gameMode === "vs_bots";
      const minPlayers = vsBots ? 1 : MIN_PLAYERS_TO_START;
      if (players.length >= minPlayers) {
        const newRoundNum = config.roundNumber + 1n;
        generateAllObstacles(ctx, roomId, newRoundNum, config.mapWidth, config.mapHeight);
        for (const p of players) {
          ctx.db.Player.identity.update({
            ...p,
            ...(vsBots ? { isZombie: false, isBot: false } : {}),
            score: 0n,
            speedBoostUntilMicros: 0n,
            abilityCooldownUntilMicros: 0n,
          });
        }
        ctx.db.GameConfig.id.update({
          ...config,
          roundActive: true,
          roundNumber: newRoundNum,
          roundStartMicros: now,
          lastTickMicros: now,
          lastBotZombieSpawnMicros: vsBots ? now : config.lastBotZombieSpawnMicros,
          roundWinner: undefined,
        });
      }
      continue;
    }

    const cfg = ctx.db.GameConfig.id.find(roomId)!;
    const mapW = cfg.mapWidth;
    const mapH = cfg.mapHeight;
    const obstacles = obstaclesInRoom(ctx, roomId);
    const vsBots = cfg.gameMode === "vs_bots";

  if (vsBots) {
    // Spawn ramp: insert BotZombie when interval elapsed; pick position far from humans
    const elapsedMicros = now - cfg.roundStartMicros;
    const elapsedSec = Number(elapsedMicros) / 1_000_000;
    const rampDecrease = BigInt(Math.floor(elapsedSec * Number(BOT_SPAWN_RAMP_MICROS_PER_SEC)));
    const intervalMicros =
      BOT_SPAWN_BASE_INTERVAL_MICROS - rampDecrease < BOT_SPAWN_MIN_INTERVAL_MICROS
        ? BOT_SPAWN_MIN_INTERVAL_MICROS
        : BOT_SPAWN_BASE_INTERVAL_MICROS - rampDecrease;
    if (now - cfg.lastBotZombieSpawnMicros >= intervalMicros) {
      const botCount = botZombiesInRoom(ctx, roomId).length;
      const humansForSpawn = playersInRoom(ctx, roomId).filter((p) => !p.isZombie);
      const margin = 80;
      const seedBase = `botspawn-${cfg.roundStartMicros}-${botCount}`;
      const numCandidates = 16;
      let bestX = margin + deterministicHash(seedBase) * (mapW - 2 * margin);
      let bestY = margin + deterministicHash(seedBase + "y") * (mapH - 2 * margin);
      let bestMinD2 = 0;
      for (let i = 0; i < numCandidates; i++) {
        const seed = `${seedBase}-${i}`;
        const x = margin + deterministicHash(seed) * (mapW - 2 * margin);
        const y = margin + deterministicHash(seed + "y") * (mapH - 2 * margin);
        if (collidesWithObstacle(obstacles, x, y, PLAYER_HALF)) continue;
        let minD2 = Infinity;
        if (humansForSpawn.length > 0) {
          for (const h of humansForSpawn) {
            const d2 = (h.x - x) ** 2 + (h.y - y) ** 2;
            if (d2 < minD2) minD2 = d2;
          }
        } else {
          const cx = mapW / 2;
          const cy = mapH / 2;
          minD2 = (cx - x) ** 2 + (cy - y) ** 2;
        }
        if (minD2 > bestMinD2) {
          bestMinD2 = minD2;
          bestX = x;
          bestY = y;
        }
      }
      if (!collidesWithObstacle(obstacles, bestX, bestY, PLAYER_HALF)) {
        ctx.db.BotZombie.insert({
          id: 0n,
          roomId,
          x: bestX,
          y: bestY,
          dirX: 0,
          dirY: 0,
          speedBoostUntilMicros: 0n,
          abilityCooldownUntilMicros: 0n,
        });
        ctx.db.GameConfig.id.update({
          ...cfg,
          lastBotZombieSpawnMicros: now,
        });
      }
    }
    }

    // AI: set direction toward nearest human for bot zombies (vs_bots only)
    const allPlayersSnap = playersInRoom(ctx, roomId);
    const humansSnap = allPlayersSnap.filter((p) => !p.isZombie);
    if (vsBots && humansSnap.length > 0) {
      for (const p of allPlayersSnap) {
        if (p.isZombie && p.isBot) {
        let bestD2 = Infinity;
        let hx = 0;
        let hy = 0;
        for (const h of humansSnap) {
          const d2 = (h.x - p.x) ** 2 + (h.y - p.y) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            hx = h.x;
            hy = h.y;
          }
        }
        const dx = hx - p.x;
        const dy = hy - p.y;
        const { x: ndx, y: ndy } = normalizeDir(dx, dy);
        ctx.db.Player.identity.update({ ...p, dirX: ndx, dirY: ndy });
        }
      }
      for (const bz of botZombiesInRoom(ctx, roomId)) {
      let bestD2 = Infinity;
      let hx = 0;
      let hy = 0;
      for (const h of humansSnap) {
        const d2 = (h.x - bz.x) ** 2 + (h.y - bz.y) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          hx = h.x;
          hy = h.y;
        }
      }
      const dx = hx - bz.x;
      const dy = hy - bz.y;
      const { x: ndx, y: ndy } = normalizeDir(dx, dy);
      ctx.db.BotZombie.id.update({ ...bz, dirX: ndx, dirY: ndy });
      }
    }

    // Move all players (with obstacle collision and axis-sliding)
    const cfgAfterSpawn = ctx.db.GameConfig.id.find(roomId)!;
    for (const p of playersInRoom(ctx, roomId)) {
    const { x: dx, y: dy } = normalizeDir(p.dirX, p.dirY);
    const zombieSpeed =
      p.isZombie && now < p.speedBoostUntilMicros
        ? ZOMBIE_SPEED_BOOST
        : ZOMBIE_SPEED;
    const speed = p.isZombie ? zombieSpeed : HUMAN_SPEED;
    let nx = p.x + dx * speed * TICK_DT_SEC;
    let ny = p.y + dy * speed * TICK_DT_SEC;
    nx = Math.max(0, Math.min(mapW, nx));
    ny = Math.max(0, Math.min(mapH, ny));
    if (collidesWithObstacle(obstacles, nx, ny, PLAYER_HALF)) {
      const tryX = collidesWithObstacle(obstacles, nx, p.y, PLAYER_HALF);
      const tryY = collidesWithObstacle(obstacles, p.x, ny, PLAYER_HALF);
      if (!tryX) {
        ny = p.y;
      } else if (!tryY) {
        nx = p.x;
      } else {
        nx = p.x;
        ny = p.y;
      }
    }
    ctx.db.Player.identity.update({ ...p, x: nx, y: ny });
    }

    // Move BotZombies (vs_bots)
    if (vsBots) {
      for (const bz of botZombiesInRoom(ctx, roomId)) {
      const { x: dx, y: dy } = normalizeDir(bz.dirX, bz.dirY);
      const speed = ZOMBIE_SPEED;
      let nx = bz.x + dx * speed * TICK_DT_SEC;
      let ny = bz.y + dy * speed * TICK_DT_SEC;
      nx = Math.max(0, Math.min(mapW, nx));
      ny = Math.max(0, Math.min(mapH, ny));
      if (collidesWithObstacle(obstacles, nx, ny, PLAYER_HALF)) {
        const tryX = collidesWithObstacle(obstacles, nx, bz.y, PLAYER_HALF);
        const tryY = collidesWithObstacle(obstacles, bz.x, ny, PLAYER_HALF);
        if (!tryX) {
          ny = bz.y;
        } else if (!tryY) {
          nx = bz.x;
        } else {
          nx = bz.x;
          ny = bz.y;
        }
      }
      ctx.db.BotZombie.id.update({ ...bz, x: nx, y: ny });
      }
    }

    // Infection
    const players = playersInRoom(ctx, roomId);
    const zombies = players.filter((p) => p.isZombie);
    const humans = players.filter((p) => !p.isZombie);
    const infectedThisTick = new Set<string>();

    if (vsBots) {
      const botZombies = botZombiesInRoom(ctx, roomId);
    for (const z of zombies) {
      let infectedCount = 0;
      for (const h of humans) {
        const key = h.identity.toHexString();
        if (infectedThisTick.has(key)) continue;
        if (Math.hypot(h.x - z.x, h.y - z.y) < INFECTION_RADIUS) {
          ctx.db.Player.identity.update({ ...h, isZombie: true, isBot: true });
          infectedThisTick.add(key);
          infectedCount++;
        }
      }
      if (infectedCount > 0) {
        const currentZ = ctx.db.Player.identity.find(z.identity)!;
        ctx.db.Player.identity.update({
          ...currentZ,
          score: currentZ.score + BigInt(infectedCount),
        });
      }
    }
    for (const z of botZombies) {
      for (const h of humans) {
        const key = h.identity.toHexString();
        if (infectedThisTick.has(key)) continue;
        if (Math.hypot(h.x - z.x, h.y - z.y) < INFECTION_RADIUS) {
          ctx.db.Player.identity.update({ ...h, isZombie: true, isBot: true });
          infectedThisTick.add(key);
        }
      }
    }
  } else {
    for (const z of zombies) {
      let infectedCount = 0;
      for (const h of humans) {
        const key = h.identity.toHexString();
        if (infectedThisTick.has(key)) continue;
        if (Math.hypot(h.x - z.x, h.y - z.y) < INFECTION_RADIUS) {
          ctx.db.Player.identity.update({ ...h, isZombie: true });
          infectedThisTick.add(key);
          infectedCount++;
        }
      }
      if (infectedCount > 0) {
        const currentZ = ctx.db.Player.identity.find(z.identity)!;
        ctx.db.Player.identity.update({
          ...currentZ,
          score: currentZ.score + BigInt(infectedCount),
        });
      }
    }
    }

    // Round end: timer expiry (humans win) or 0 humans (zombies win)
    const allPlayersFinal = playersInRoom(ctx, roomId);
    const humansLeft = allPlayersFinal.filter((p) => !p.isZombie);
    const timerExpired = now - cfgAfterSpawn.roundStartMicros >= ROUND_DURATION_MICROS;

    if (timerExpired && humansLeft.length >= 1) {
      ctx.db.GameConfig.id.update({
        ...cfgAfterSpawn,
        roundActive: false,
        roundEndMicros: now,
        roundWinner: "humans",
      });
    } else if (humansLeft.length === 0) {
      const zombiesWin =
        !vsBots ? allPlayersFinal.length >= 2 : true;
      if (zombiesWin) {
        ctx.db.GameConfig.id.update({
          ...cfgAfterSpawn,
          roundActive: false,
          roundEndMicros: now,
          roundWinner: "zombies",
        });
      }
    }
  }
});

// ─── Reducers ─────────────────────────────────────────────────────────────
export const set_input = spacetimedb.reducer(
  { dirX: t.f64(), dirY: t.f64() },
  (ctx, { dirX, dirY }) => {
    const player = ctx.db.Player.identity.find(ctx.sender);
    if (!player || player.isBot || player.roomId === ROOM_ID_MENU) return;
    const { x, y } = normalizeDir(dirX, dirY);
    ctx.db.Player.identity.update({ ...player, dirX: x, dirY: y });
  },
);

export const use_zombie_ability = spacetimedb.reducer((ctx) => {
  const player = ctx.db.Player.identity.find(ctx.sender);
  if (!player || !player.isZombie) return;
  const config = ctx.db.GameConfig.id.find(player.roomId);
  if (!config?.roundActive) return;
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (now <= player.abilityCooldownUntilMicros) return;
  ctx.db.Player.identity.update({
    ...player,
    speedBoostUntilMicros: now + ZOMBIE_BOOST_DURATION_MICROS,
    abilityCooldownUntilMicros: now + ZOMBIE_ABILITY_COOLDOWN_MICROS,
  });
});

export const set_name = spacetimedb.reducer(
  { name: t.string() },
  (ctx, { name }) => {
    const player = ctx.db.Player.identity.find(ctx.sender);
    if (!player) throw new SenderError("Not in game");
    const trimmed = (name ?? "").trim().slice(0, 32);
    const finalName = trimmed || "Player";

    for (const other of playersInRoom(ctx, player.roomId)) {
      if (
        other.identity.toHexString() !== ctx.sender.toHexString() &&
        other.name.toLowerCase() === finalName.toLowerCase()
      ) {
        throw new SenderError("Name already taken");
      }
    }

    ctx.db.Player.identity.update({ ...player, name: finalName });
  },
);

function modeToRoomId(mode: string): bigint | null {
  if (mode === "vs_humans") return ROOM_ID_VS_HUMANS;
  if (mode === "vs_bots") return ROOM_ID_VS_BOTS;
  return null;
}

// ─── join_room: enter vs_humans or vs_bots lobby ────────────────────────────
export const join_room = spacetimedb.reducer(
  { mode: t.string() },
  (ctx, { mode }) => {
    if (mode !== "vs_humans" && mode !== "vs_bots") {
      throw new SenderError("mode must be vs_humans or vs_bots");
    }
    const roomId = modeToRoomId(mode)!;
    const player = ctx.db.Player.identity.find(ctx.sender);
    if (!player || player.roomId === roomId) return;

    const oldRoomId = player.roomId;
    if (oldRoomId === ROOM_ID_VS_HUMANS || oldRoomId === ROOM_ID_VS_BOTS) {
      const oldRoomPlayers = playersInRoom(ctx, oldRoomId);
      const newCount = oldRoomPlayers.length - 1;
      const oldConfig = ctx.db.GameConfig.id.find(oldRoomId);
      if (oldConfig && newCount >= 0) {
        const newSize = mapSizeForPlayers(newCount);
        ctx.db.GameConfig.id.update({
          ...oldConfig,
          mapWidth: newSize,
          mapHeight: newSize,
        });
      }
    }

    const config = ctx.db.GameConfig.id.find(roomId);
    if (!config) return;

    const mapW = config.mapWidth;
    const mapH = config.mapHeight;
    const seed = `${roomId}-${ctx.sender.toHexString()}`;
    const x = deterministicHash(seed) * (mapW - 100) + 50;
    const y = deterministicHash(seed + "y") * (mapH - 100) + 50;

    const roomPlayers = playersInRoom(ctx, roomId);
    const isFirstInRoom = roomPlayers.length === 0;
    const vsBots = config.gameMode === "vs_bots";
    const spawnAsZombie = vsBots ? false : isFirstInRoom;

    ctx.db.Player.identity.update({
      ...player,
      roomId,
      x,
      y,
      dirX: 0,
      dirY: 0,
      isZombie: spawnAsZombie,
      isBot: false,
      score: 0n,
      speedBoostUntilMicros: 0n,
      abilityCooldownUntilMicros: 0n,
    });

    const countInRoom = roomPlayers.length + 1;
    const newSize = mapSizeForPlayers(countInRoom);
    ctx.db.GameConfig.id.update({
      ...config,
      mapWidth: newSize,
      mapHeight: newSize,
    });

    if (mode === "vs_bots" && !config.roundActive && config.roundEndMicros === 0n) {
      const now = ctx.timestamp.microsSinceUnixEpoch;
      const newRoundNum = config.roundNumber + 1n;
      generateAllObstacles(ctx, roomId, newRoundNum, config.mapWidth, config.mapHeight);
      const updatedPlayers = playersInRoom(ctx, roomId);
      for (const p of updatedPlayers) {
        ctx.db.Player.identity.update({
          ...p,
          isZombie: false,
          isBot: false,
          score: 0n,
          speedBoostUntilMicros: 0n,
          abilityCooldownUntilMicros: 0n,
        });
      }
      const updatedConfig = ctx.db.GameConfig.id.find(roomId)!;
      ctx.db.GameConfig.id.update({
        ...updatedConfig,
        gameMode: "vs_bots",
        roundActive: true,
        roundNumber: newRoundNum,
        roundStartMicros: now,
        roundEndMicros: 0n,
        lastTickMicros: now,
        lastBotZombieSpawnMicros: now,
        roundWinner: undefined,
      });
    }
  },
);

// ─── leave_room: return to menu ────────────────────────────────────────────
export const leave_room = spacetimedb.reducer((ctx) => {
  const player = ctx.db.Player.identity.find(ctx.sender);
  if (!player || player.roomId === ROOM_ID_MENU) return;

  const oldRoomId = player.roomId;
  ctx.db.Player.identity.update({
    ...player,
    roomId: ROOM_ID_MENU,
    x: deterministicHash(ctx.sender.toHexString()) * (BASE_MAP_SIZE - 100) + 50,
    y: deterministicHash(ctx.sender.toHexString() + "y") * (BASE_MAP_SIZE - 100) + 50,
    dirX: 0,
    dirY: 0,
    isZombie: false,
    isBot: false,
    score: 0n,
    speedBoostUntilMicros: 0n,
    abilityCooldownUntilMicros: 0n,
  });

  if (oldRoomId !== ROOM_ID_VS_HUMANS && oldRoomId !== ROOM_ID_VS_BOTS) return;
  const remaining = playersInRoom(ctx, oldRoomId);
  const config = ctx.db.GameConfig.id.find(oldRoomId);
  if (!config) return;

  if (remaining.length === 0) {
    for (const bz of botZombiesInRoom(ctx, oldRoomId)) {
      ctx.db.BotZombie.id.delete(bz.id);
    }
    ctx.db.GameConfig.id.update({
      ...config,
      gameMode: config.gameMode,
      roundActive: false,
      roundEndMicros: 0n,
      lastBotZombieSpawnMicros: 0n,
      roundWinner: undefined,
    });
  } else {
    const newSize = mapSizeForPlayers(remaining.length);
    ctx.db.GameConfig.id.update({
      ...config,
      mapWidth: newSize,
      mapHeight: newSize,
    });
    const zombies = remaining.filter((p) => p.isZombie);
    if (config.gameMode !== "vs_bots" && zombies.length === 0) {
      const idx = Number(config.roundNumber % BigInt(remaining.length));
      const newZombie = remaining[idx];
      ctx.db.Player.identity.update({ ...newZombie, isZombie: true });
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────
export const init = spacetimedb.init((ctx) => {
  if (!ctx.db.GameConfig.id.find(ROOM_ID_VS_HUMANS)) {
    ctx.db.GameConfig.insert({
      id: ROOM_ID_VS_HUMANS,
      roundActive: false,
      roundNumber: 0n,
      roundStartMicros: 0n,
      roundEndMicros: 0n,
      lastTickMicros: 0n,
      lastBotZombieSpawnMicros: 0n,
      mapWidth: BASE_MAP_SIZE,
      mapHeight: BASE_MAP_SIZE,
      roundWinner: undefined,
      gameMode: "vs_humans",
    });
  }
  if (!ctx.db.GameConfig.id.find(ROOM_ID_VS_BOTS)) {
    ctx.db.GameConfig.insert({
      id: ROOM_ID_VS_BOTS,
      roundActive: false,
      roundNumber: 0n,
      roundStartMicros: 0n,
      roundEndMicros: 0n,
      lastTickMicros: 0n,
      lastBotZombieSpawnMicros: 0n,
      mapWidth: BASE_MAP_SIZE,
      mapHeight: BASE_MAP_SIZE,
      roundWinner: undefined,
      gameMode: "vs_bots",
    });
  }
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────
export const onConnect = spacetimedb.clientConnected((ctx) => {
  const existing = ctx.db.Player.identity.find(ctx.sender);
  if (existing) {
    ctx.db.Player.identity.update({
      ...existing,
      x: existing.x,
      y: existing.y,
    });
    return;
  }

  const seed = ctx.sender.toHexString();
  const x = deterministicHash(seed) * (BASE_MAP_SIZE - 100) + 50;
  const y = deterministicHash(seed + "y") * (BASE_MAP_SIZE - 100) + 50;

  ctx.db.Player.insert({
    identity: ctx.sender,
    roomId: ROOM_ID_MENU,
    x,
    y,
    dirX: 0,
    dirY: 0,
    isZombie: false,
    isBot: false,
    name: "Player",
    score: 0n,
    speedBoostUntilMicros: 0n,
    abilityCooldownUntilMicros: 0n,
  });
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const player = ctx.db.Player.identity.find(ctx.sender);
  if (!player) return;

  const roomId = player.roomId;
  ctx.db.Player.identity.delete(ctx.sender);

  if (roomId !== ROOM_ID_VS_HUMANS && roomId !== ROOM_ID_VS_BOTS) return;

  const players = playersInRoom(ctx, roomId);
  const zombies = players.filter((p) => p.isZombie);
  const config = ctx.db.GameConfig.id.find(roomId);
  if (!config) return;

  if (players.length === 0) {
    for (const bz of botZombiesInRoom(ctx, roomId)) {
      ctx.db.BotZombie.id.delete(bz.id);
    }
    ctx.db.GameConfig.id.update({
      ...config,
      gameMode: config.gameMode,
      roundActive: false,
      roundEndMicros: 0n,
      lastBotZombieSpawnMicros: 0n,
      roundWinner: undefined,
    });
  } else {
    const newSize = mapSizeForPlayers(players.length);
    ctx.db.GameConfig.id.update({
      ...config,
      mapWidth: newSize,
      mapHeight: newSize,
    });
    if (
      config.gameMode !== "vs_bots" &&
      zombies.length === 0
    ) {
      const idx = Number(config.roundNumber % BigInt(players.length));
      const newZombie = players[idx];
      ctx.db.Player.identity.update({ ...newZombie, isZombie: true });
    }
  }
});
