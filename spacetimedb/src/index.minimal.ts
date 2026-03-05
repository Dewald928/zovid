/**
 * Minimal module (no scheduled tables) to test if publish works.
 * To test: temporarily rename index.ts to index.full.ts and this file to index.ts, then publish.
 */
import { schema, t, SenderError } from 'spacetimedb/server';
import { Player, GameConfig } from './schema';

const BASE_MAP_SIZE = 2000.0;

function deterministicHash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return (Math.abs(h) % 1e6) / 1e6;
}

const spacetimedb = schema({ Player, GameConfig });
export default spacetimedb;

export const set_input = spacetimedb.reducer(
  { dirX: t.f64(), dirY: t.f64() },
  (ctx, { dirX, dirY }) => {
    const player = ctx.db.Player.identity.find(ctx.sender);
    if (!player) return;
    const len = Math.sqrt(dirX * dirX + dirY * dirY) || 1e-6;
    ctx.db.Player.identity.update({
      ...player,
      dirX: dirX / len,
      dirY: dirY / len,
    });
  }
);

export const set_name = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  const player = ctx.db.Player.identity.find(ctx.sender);
  if (!player) throw new SenderError('Not in game');
  ctx.db.Player.identity.update({ ...player, name: (name ?? '').trim().slice(0, 32) || 'Player' });
});

export const init = spacetimedb.init((ctx) => {
  if (!ctx.db.GameConfig.id.find(0n)) {
    ctx.db.GameConfig.insert({
      id: 0n,
      roundActive: false,
      roundNumber: 0n,
      roundStartMicros: 0n,
      mapWidth: BASE_MAP_SIZE,
      mapHeight: BASE_MAP_SIZE,
    });
  }
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  if (ctx.db.Player.identity.find(ctx.sender)) return;
  const config = ctx.db.GameConfig.id.find(0n);
  const mapW = config?.mapWidth ?? BASE_MAP_SIZE;
  const mapH = config?.mapHeight ?? BASE_MAP_SIZE;
  const seed = ctx.sender.toHexString();
  ctx.db.Player.insert({
    identity: ctx.sender,
    x: deterministicHash(seed) * (mapW - 100) + 50,
    y: deterministicHash(seed + 'y') * (mapH - 100) + 50,
    dirX: 0,
    dirY: 0,
    isZombie: [...ctx.db.Player.iter()].length === 0,
    name: 'Player',
    score: 0n,
  });
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  ctx.db.Player.identity.delete(ctx.sender);
});
