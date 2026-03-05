import { schema, t, SenderError } from 'spacetimedb/server';
import { Player, GameConfig } from './schema';

// ─── Constants ─────────────────────────────────────────────────────────────
const HUMAN_SPEED = 200.0;
const ZOMBIE_SPEED = 140.0;
const INFECTION_RADIUS = 40.0;
const TICK_MICROS = 50_000n; // 50ms
const ROUND_RESET_DELAY_MICROS = 10_000_000n; // 10 seconds
const BASE_MAP_SIZE = 2000.0;
const MIN_PLAYERS_TO_START = 1;
const TICK_DT_SEC = Number(TICK_MICROS) / 1_000_000;

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

const spacetimedb = schema({ Player, GameConfig });
export default spacetimedb;

// ─── tick: game loop (call from client every ~50ms; server throttles to 50ms) ─
export const tick = spacetimedb.reducer((ctx) => {
  const config = ctx.db.GameConfig.id.find(0n);
  if (!config) return;

  const now = ctx.timestamp.microsSinceUnixEpoch;

  // Round reset after delay (replaces scheduled RoundResetJob)
  if (!config.roundActive && config.roundEndMicros > 0n && now - config.roundEndMicros >= ROUND_RESET_DELAY_MICROS) {
    const players = [...ctx.db.Player.iter()];
    if (players.length === 0) {
      ctx.db.GameConfig.id.update({
        ...config,
        roundEndMicros: 0n,
        lastTickMicros: now,
      });
      return;
    }
    const mapW = config.mapWidth;
    const mapH = config.mapHeight;
    const firstIdx = Number(config.roundNumber % BigInt(players.length));
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const seed = `${config.roundNumber}-${i}-${p.identity.toHexString()}`;
      const x = deterministicHash(seed) * (mapW - 100) + 50;
      const y = deterministicHash(seed + 'y') * (mapH - 100) + 50;
      ctx.db.Player.identity.update({
        ...p,
        x,
        y,
        dirX: 0,
        dirY: 0,
        isZombie: i === firstIdx,
      });
    }
    ctx.db.GameConfig.id.update({
      ...config,
      roundActive: true,
      roundNumber: config.roundNumber + 1n,
      roundStartMicros: now,
      roundEndMicros: 0n,
      lastTickMicros: now,
    });
    return;
  }

  // Throttle: only run game logic every TICK_MICROS
  if (now - config.lastTickMicros < TICK_MICROS) return;

  ctx.db.GameConfig.id.update({ ...config, lastTickMicros: now });

  if (!config.roundActive) {
    // If roundEndMicros > 0, we're in the post-round delay — wait for reset logic above
    if (config.roundEndMicros > 0n) return;
    const players = [...ctx.db.Player.iter()];
    if (players.length >= MIN_PLAYERS_TO_START) {
      ctx.db.GameConfig.id.update({
        ...config,
        roundActive: true,
        roundNumber: config.roundNumber + 1n,
        roundStartMicros: now,
        lastTickMicros: now,
      });
    }
    return;
  }

  const cfg = ctx.db.GameConfig.id.find(0n)!;
  const mapW = cfg.mapWidth;
  const mapH = cfg.mapHeight;

  // Move all players
  for (const p of ctx.db.Player.iter()) {
    const { x: dx, y: dy } = normalizeDir(p.dirX, p.dirY);
    const speed = p.isZombie ? ZOMBIE_SPEED : HUMAN_SPEED;
    let nx = p.x + dx * speed * TICK_DT_SEC;
    let ny = p.y + dy * speed * TICK_DT_SEC;
    nx = Math.max(0, Math.min(mapW, nx));
    ny = Math.max(0, Math.min(mapH, ny));
    ctx.db.Player.identity.update({ ...p, x: nx, y: ny });
  }

  // Infection
  const players = [...ctx.db.Player.iter()];
  const zombies = players.filter((p) => p.isZombie);
  const humans = players.filter((p) => !p.isZombie);
  const infectedThisTick = new Set<string>();

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

  // Round end when 0 humans (but only if there are 2+ players — solo player can free-roam)
  const allPlayers = [...ctx.db.Player.iter()];
  const humansLeft = allPlayers.filter((p) => !p.isZombie);
  if (humansLeft.length === 0 && allPlayers.length >= 2) {
    ctx.db.GameConfig.id.update({
      ...cfg,
      roundActive: false,
      roundEndMicros: now,
    });
  }
});

// ─── Reducers ─────────────────────────────────────────────────────────────
export const set_input = spacetimedb.reducer(
  { dirX: t.f64(), dirY: t.f64() },
  (ctx, { dirX, dirY }) => {
    const player = ctx.db.Player.identity.find(ctx.sender);
    if (!player) return;
    const { x, y } = normalizeDir(dirX, dirY);
    ctx.db.Player.identity.update({ ...player, dirX: x, dirY: y });
  }
);

export const set_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const player = ctx.db.Player.identity.find(ctx.sender);
  if (!player) throw new SenderError('Not in game');
  const trimmed = (name ?? '').trim().slice(0, 32);
  ctx.db.Player.identity.update({ ...player, name: trimmed || 'Player' });
});

// ─── Init ─────────────────────────────────────────────────────────────────
export const init = spacetimedb.init((ctx) => {
  if (!ctx.db.GameConfig.id.find(0n)) {
    ctx.db.GameConfig.insert({
      id: 0n,
      roundActive: false,
      roundNumber: 0n,
      roundStartMicros: 0n,
      roundEndMicros: 0n,
      lastTickMicros: 0n,
      mapWidth: BASE_MAP_SIZE,
      mapHeight: BASE_MAP_SIZE,
    });
  }
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────
export const onConnect = spacetimedb.clientConnected((ctx) => {
  const existing = ctx.db.Player.identity.find(ctx.sender);
  if (existing) {
    ctx.db.Player.identity.update({ ...existing, x: existing.x, y: existing.y });
    return;
  }

  const config = ctx.db.GameConfig.id.find(0n) ?? null;
  const mapW = config?.mapWidth ?? BASE_MAP_SIZE;
  const mapH = config?.mapHeight ?? BASE_MAP_SIZE;
  const seed = ctx.sender.toHexString();
  const x = deterministicHash(seed) * (mapW - 100) + 50;
  const y = deterministicHash(seed + 'y') * (mapH - 100) + 50;

  const players = [...ctx.db.Player.iter()];
  const isFirst = players.length === 0;

  ctx.db.Player.insert({
    identity: ctx.sender,
    x,
    y,
    dirX: 0,
    dirY: 0,
    isZombie: isFirst,
    name: 'Player',
    score: 0n,
  });

  const count = [...ctx.db.Player.iter()].length;
  const newSize = mapSizeForPlayers(count);
  if (config) {
    ctx.db.GameConfig.id.update({
      ...config,
      mapWidth: newSize,
      mapHeight: newSize,
    });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const player = ctx.db.Player.identity.find(ctx.sender);
  if (!player) return;

  ctx.db.Player.identity.delete(ctx.sender);

  const players = [...ctx.db.Player.iter()];
  const zombies = players.filter((p) => p.isZombie);
  const config = ctx.db.GameConfig.id.find(0n);
  if (config && zombies.length === 0 && players.length > 0) {
    const idx = Number(config.roundNumber % BigInt(players.length));
    const newZombie = players[idx];
    ctx.db.Player.identity.update({ ...newZombie, isZombie: true });
  }

  if (config && players.length > 0) {
    const newSize = mapSizeForPlayers(players.length - 1);
    ctx.db.GameConfig.id.update({ ...config, mapWidth: newSize, mapHeight: newSize });
  }
});
