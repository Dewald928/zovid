import { table, t } from 'spacetimedb/server';

export const Player = table(
  {
    name: 'player',
    public: true,
    indexes: [{ name: 'player_room_id', accessor: 'player_room_id', algorithm: 'btree', columns: ['roomId'] }],
  },
  {
    identity: t.identity().primaryKey(),
    roomId: t.u64(),
    x: t.f64(),
    y: t.f64(),
    dirX: t.f64(),
    dirY: t.f64(),
    isZombie: t.bool(),
    isBot: t.bool(),
    name: t.string(),
    score: t.u64(),
    speedBoostUntilMicros: t.u64(),
    abilityCooldownUntilMicros: t.u64(),
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
    lastBotZombieSpawnMicros: t.u64(),
    mapWidth: t.f64(),
    mapHeight: t.f64(),
    roundWinner: t.string().optional(),
    gameMode: t.string().optional(),
  }
);

export const Obstacle = table(
  {
    name: 'obstacle',
    public: true,
    indexes: [{ name: 'obstacle_room_id', accessor: 'obstacle_room_id', algorithm: 'btree', columns: ['roomId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64(),
    groupId: t.u64(),
    x: t.f64(),
    y: t.f64(),
    width: t.f64(),
    height: t.f64(),
    obstacleType: t.string(),
  }
);

export const BotZombie = table(
  {
    name: 'bot_zombie',
    public: true,
    indexes: [{ name: 'bot_zombie_room_id', accessor: 'bot_zombie_room_id', algorithm: 'btree', columns: ['roomId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64(),
    x: t.f64(),
    y: t.f64(),
    dirX: t.f64(),
    dirY: t.f64(),
    speedBoostUntilMicros: t.u64(),
    abilityCooldownUntilMicros: t.u64(),
  }
);
