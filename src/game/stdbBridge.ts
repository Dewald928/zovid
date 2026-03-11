import type { Player, GameConfig, Obstacle, BotZombie } from '../module_bindings/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _conn: any = null;

export function setConnection(conn: typeof _conn): void {
  _conn = conn;
}

export function getConnection(): typeof _conn {
  return _conn;
}

export interface GameState {
  players: Player[];
  config: GameConfig | null;
  obstacles: Obstacle[];
  botZombies: BotZombie[];
}

let _gameState: GameState = { players: [], config: null, obstacles: [], botZombies: [] };

export function setGameState(state: GameState): void {
  _gameState = state;
}

export function getGameState(): GameState {
  return _gameState;
}

let _localIdentityHex: string | null = null;

export function setLocalIdentity(hex: string | null): void {
  _localIdentityHex = hex;
}

export function getLocalIdentity(): string | null {
  return _localIdentityHex;
}
