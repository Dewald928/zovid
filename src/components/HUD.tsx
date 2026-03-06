import React, { useState, useEffect, useRef } from 'react';
import type { Player, GameConfig } from '../module_bindings/types';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';
import { DonationPanel } from './DonationPanel';

const ROUND_RESET_DELAY_MICROS = 10_000_000n; // 10 seconds

interface HUDProps {
  players: Player[];
  config: GameConfig | null;
  localIdentity?: Identity;
  connection: DbConnection | null;
}

export function HUD({ players, config, localIdentity, connection }: HUDProps) {
  const [tick, setTick] = useState(0);
  const [nameInput, setNameInput] = useState('');
  const [nameError, setNameError] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const humans = players.filter((p) => !p.isZombie);
  const zombies = players.filter((p) => p.isZombie);
  const humanCount = humans.length;
  const zombieCount = zombies.length;

  const localPlayer = localIdentity
    ? players.find((p) => p.identity.toHexString() === localIdentity.toHexString())
    : null;
  const isZombie = localPlayer?.isZombie ?? false;
  const currentName = localPlayer?.name ?? 'Player';
  const roundActive = config?.roundActive ?? false;

  const nowMicros = BigInt(Date.now()) * 1000n;
  const roundElapsedMs = config?.roundStartMicros
    ? Number(nowMicros - config.roundStartMicros) / 1000
    : 0;
  const roundElapsedSec = Math.max(0, Math.floor(roundElapsedMs / 1000));

  const showScoreboard = !roundActive && humanCount === 0 && zombieCount > 0;
  const sortedByScore = [...players].sort((a, b) => Number(b.score - a.score));

  const nextRoundMicros =
    config?.roundEndMicros != null && config.roundEndMicros > 0n
      ? config.roundEndMicros + ROUND_RESET_DELAY_MICROS
      : 0n;
  const remainingMicros = nextRoundMicros > 0n ? nextRoundMicros - nowMicros : 0n;
  const countdownSec = Math.max(0, Math.ceil(Number(remainingMicros) / 1_000_000));

  useEffect(() => {
    if (!showScoreboard || countdownSec <= 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [showScoreboard, countdownSec]);

  const handleStartEditing = () => {
    setNameInput(currentName === 'Player' ? '' : currentName);
    setNameError('');
    setIsEditingName(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSubmitName = () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setIsEditingName(false);
      return;
    }
    const taken = players.some(
      (p) =>
        localIdentity &&
        p.identity.toHexString() !== localIdentity.toHexString() &&
        p.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (taken) {
      setNameError('Name already taken');
      return;
    }
    if (connection) {
      connection.reducers.setName({ name: trimmed });
    }
    setNameError('');
    setIsEditingName(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') handleSubmitName();
    if (e.key === 'Escape') setIsEditingName(false);
  };

  return (
    <div className="hud">
      <div className="hud-stats">
        <span className="hud-stat">Humans: {humanCount}</span>
        <span className="hud-stat">Zombies: {zombieCount}</span>
        <span className="hud-stat">Round timer: {roundElapsedSec}s</span>
      </div>
      <div className={`hud-role ${isZombie ? 'zombie' : 'human'}`}>
        {isZombie ? (
          <>
            YOU ARE A ZOMBIE
            <span className="hud-role-tagline">Eat humans!</span>
          </>
        ) : (
          <>
            YOU ARE A HUMAN
            <span className="hud-role-tagline">Run! Don't turn green</span>
          </>
        )}
      </div>

      <div className="hud-name">
        {isEditingName ? (
          <div className="hud-name-form">
            <input
              ref={inputRef}
              className="hud-name-input"
              type="text"
              maxLength={32}
              value={nameInput}
              onChange={(e) => { setNameInput(e.target.value); setNameError(''); }}
              onKeyDown={handleKeyDown}
              placeholder="Enter your name..."
            />
            <button className="hud-name-btn" onClick={handleSubmitName}>Set</button>
            <button className="hud-name-btn hud-name-cancel" onClick={() => setIsEditingName(false)}>Cancel</button>
            {nameError && <div className="hud-name-error">{nameError}</div>}
          </div>
        ) : (
          <button className="hud-name-display" onClick={handleStartEditing}>
            {currentName} <span className="hud-name-edit-icon">&#9998;</span>
          </button>
        )}
      </div>

      {showScoreboard && (
        <div className="hud-scoreboard">
          <h2>Round Over - Zombies Win!</h2>
          <p>Next round in {countdownSec} seconds...</p>
          <ol className="hud-leaderboard">
            {sortedByScore.slice(0, 10).map((p) => (
              <li key={p.identity.toHexString()}>
                {p.name} — {Number(p.score)} infections
              </li>
            ))}
          </ol>
        </div>
      )}

      <DonationPanel />
    </div>
  );
}
