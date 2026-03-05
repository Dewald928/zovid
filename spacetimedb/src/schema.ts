import { table, t } from 'spacetimedb/server';

export const Player = table(
  {
    name: 'player',
    public: true,
  },
  {
    identity: t.identity().primaryKey(),
    x: t.f64(),
    y: t.f64(),
    dirX: t.f64(),
    dirY: t.f64(),
    isZombie: t.bool(),
    name: t.string(),
    score: t.u64(),
  }
);

export const GameConfig = table(
  {
    name: 'game_config',
    public: true,
  },
  {
    id: t.u64().primaryKey(),
    roundActive: t.bool(),
    roundNumber: t.u64(),
    roundStartMicros: t.u64(),
    roundEndMicros: t.u64(),
    lastTickMicros: t.u64(),
    mapWidth: t.f64(),
    mapHeight: t.f64(),
  }
);

export const Obstacle = table(
  {
    name: 'obstacle',
    public: true,
  },
  {
    id: t.u64().primaryKey().autoInc(),
    groupId: t.u64(),
    x: t.f64(),
    y: t.f64(),
    width: t.f64(),
    height: t.f64(),
    obstacleType: t.string(),
  }
);
