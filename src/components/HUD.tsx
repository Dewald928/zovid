import React from 'react';
import type { Player, GameConfig } from '../module_bindings/types';
import type { Identity } from 'spacetimedb';

interface HUDProps {
  players: Player[];
  config: GameConfig | null;
  localIdentity?: Identity;
}

export function HUD({ players, config, localIdentity }: HUDProps) {
  const humans = players.filter((p) => !p.isZombie);
  const zombies = players.filter((p) => p.isZombie);
  const humanCount = humans.length;
  const zombieCount = zombies.length;

  const localPlayer = localIdentity
    ? players.find((p) => p.identity.toHexString() === localIdentity.toHexString())
    : null;
  const isZombie = localPlayer?.isZombie ?? false;
  const roundActive = config?.roundActive ?? false;

  const nowMicros = BigInt(Date.now()) * 1000n;
  const roundElapsedMs = config?.roundStartMicros
    ? Number(nowMicros - config.roundStartMicros) / 1000
    : 0;
  const roundElapsedSec = Math.max(0, Math.floor(roundElapsedMs / 1000));

  const showScoreboard = !roundActive && humanCount === 0 && zombieCount > 0;
  const sortedByScore = [...players].sort((a, b) => Number(b.score - a.score));

  return (
    <div className="hud">
      <div className="hud-stats">
        <span className="hud-stat">Humans: {humanCount}</span>
        <span className="hud-stat">Zombies: {zombieCount}</span>
        <span className="hud-stat">Round timer: {roundElapsedSec}s</span>
      </div>
      <div className={`hud-role ${isZombie ? 'zombie' : 'human'}`}>
        {isZombie ? 'YOU ARE A ZOMBIE' : 'YOU ARE A HUMAN'}
      </div>
      {showScoreboard && (
        <div className="hud-scoreboard">
          <h2>Round Over - Zombies Win!</h2>
          <p>Next round in 10 seconds...</p>
          <ol className="hud-leaderboard">
            {sortedByScore.slice(0, 10).map((p, i) => (
              <li key={p.identity.toHexString()}>
                {p.name} — {Number(p.score)} infections
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
