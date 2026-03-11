import React, { useState, useEffect, useRef } from "react";
import type { Player, GameConfig, BotZombie } from "../module_bindings/types";
import type { Identity } from "spacetimedb";
import type { DbConnection } from "../module_bindings";
import { DonationPanel } from "./DonationPanel";

const ROUND_RESET_DELAY_MICROS = 10_000_000n; // 10 seconds
const ROUND_DURATION_MICROS = 3n * 60n * 1_000_000n; // 3 minutes

const BOOST_DURATION_MS = 3_000;
const COOLDOWN_DURATION_MS = 15_000;
const CHARGE_DURATION_MS = COOLDOWN_DURATION_MS - BOOST_DURATION_MS; // 12s

interface HUDProps {
  players: Player[];
  config: GameConfig | null;
  botZombies?: BotZombie[];
  localIdentity?: Identity;
  connection: DbConnection | null;
  pingMs?: number | null;
  voiceEnabled?: boolean;
  onVoiceToggle?: () => void;
  onLeaveRoom?: () => void;
}

/** Fire this from anywhere that calls useZombieAbility so the HUD bar animates immediately. */
export const BOOST_ACTIVATED_EVENT = "zovid-boost-activated";
export function fireBoostActivated() {
  window.dispatchEvent(new Event(BOOST_ACTIVATED_EVENT));
}

/**
 * Drives the ability bar from a single activation timestamp.
 * Listens for the 'zovid-boost-activated' custom event so ANY trigger
 * (HUD button, Space key, touch zone) starts the animation.
 *
 * Timeline after activation at T:
 *   T → T+3s   : deplete 1→0  (boosting)
 *   T+3s → T+15s: charge  0→1  (cooldown)
 *   T+15s+      : full, ready
 */
function useAbilityBar(active: boolean) {
  const [fill, setFill] = useState(1);
  const [isBoosting, setIsBoosting] = useState(false);
  const [isReady, setIsReady] = useState(true);
  const activatedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const onActivated = () => {
      activatedAtRef.current = performance.now();
    };
    window.addEventListener(BOOST_ACTIVATED_EVENT, onActivated);
    return () => window.removeEventListener(BOOST_ACTIVATED_EVENT, onActivated);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let rafId: number;
    const loop = () => {
      const t = activatedAtRef.current;
      if (t == null) {
        setFill(1);
        setIsBoosting(false);
        setIsReady(true);
      } else {
        const elapsed = performance.now() - t;
        if (elapsed < BOOST_DURATION_MS) {
          setFill(1 - elapsed / BOOST_DURATION_MS);
          setIsBoosting(true);
          setIsReady(false);
        } else if (elapsed < COOLDOWN_DURATION_MS) {
          setFill((elapsed - BOOST_DURATION_MS) / CHARGE_DURATION_MS);
          setIsBoosting(false);
          setIsReady(false);
        } else {
          activatedAtRef.current = null;
          setFill(1);
          setIsBoosting(false);
          setIsReady(true);
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [active]);

  return { fill, isBoosting, isReady };
}

export function HUD({
  players,
  config,
  localIdentity,
  botZombies = [],
  connection,
  pingMs = null,
  voiceEnabled,
  onVoiceToggle,
  onLeaveRoom,
}: HUDProps) {
  const [tick, setTick] = useState(0);
  const [nameInput, setNameInput] = useState("");
  const [nameError, setNameError] = useState("");
  const [isEditingName, setIsEditingName] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const humans = players.filter((p) => !p.isZombie);
  const zombies = players.filter((p) => p.isZombie);
  const humanCount = humans.length;
  const zombieCount =
    zombies.length +
    (config?.gameMode === "vs_bots" ? botZombies.length : 0);

  const localPlayer = localIdentity
    ? players.find(
        (p) => p.identity.toHexString() === localIdentity.toHexString(),
      )
    : null;
  const isZombie = localPlayer?.isZombie ?? false;
  const currentName = localPlayer?.name ?? "Player";
  const roundActive = config?.roundActive ?? false;

  const showAbilityBar = isZombie && roundActive;
  const {
    fill: abilityBarFill,
    isBoosting: boostActive,
    isReady: abilityReady,
  } = useAbilityBar(showAbilityBar);

  const nowMicros = BigInt(Date.now()) * 1000n;
  const roundElapsedMs = config?.roundStartMicros
    ? Number(nowMicros - config.roundStartMicros) / 1000
    : 0;
  const roundElapsedSec = Math.max(0, Math.floor(roundElapsedMs / 1000));
  const roundDurationMs = Number(ROUND_DURATION_MICROS) / 1000;
  const roundRemainingMs = roundActive
    ? Math.max(0, roundDurationMs - roundElapsedMs)
    : 0;
  const roundRemainingSec = Math.ceil(roundRemainingMs / 1000);
  const timeLeftMin = Math.floor(roundRemainingSec / 60);
  const timeLeftSec = roundRemainingSec % 60;
  const timeLeftStr = `${timeLeftMin}:${String(timeLeftSec).padStart(2, "0")}`;

  const roundWinner = config?.roundWinner;
  const showScoreboard =
    !roundActive && (roundWinner === "zombies" || roundWinner === "humans");
  const sortedByScore = [...players].sort((a, b) => Number(b.score - a.score));

  const nextRoundMicros =
    config?.roundEndMicros != null && config.roundEndMicros > 0n
      ? config.roundEndMicros + ROUND_RESET_DELAY_MICROS
      : 0n;
  const remainingMicros =
    nextRoundMicros > 0n ? nextRoundMicros - nowMicros : 0n;
  const countdownSec = Math.max(
    0,
    Math.ceil(Number(remainingMicros) / 1_000_000),
  );

  useEffect(() => {
    if (!showScoreboard || countdownSec <= 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [showScoreboard, countdownSec]);

  const handleStartEditing = () => {
    setNameInput(currentName === "Player" ? "" : currentName);
    setNameError("");
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
        p.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (taken) {
      setNameError("Name already taken");
      return;
    }
    if (connection) {
      connection.reducers.setName({ name: trimmed });
    }
    setNameError("");
    setIsEditingName(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") handleSubmitName();
    if (e.key === "Escape") setIsEditingName(false);
  };

  const handleBoostClick = () => {
    if (!connection || !abilityReady) return;
    fireBoostActivated();
    connection.reducers.useZombieAbility({});
  };

  return (
    <div className="hud">
      {onLeaveRoom && (
        <button
          type="button"
          className="hud-leave-btn"
          onClick={onLeaveRoom}
          aria-label="Back to menu"
        >
          ← Menu
        </button>
      )}
      {isZombie && roundActive && (
        <div className="hud-ability-bar-wrap" aria-label="Ability charge">
          <div className="hud-ability-bar-track">
            <div
              className={`hud-ability-bar-fill ${boostActive ? "hud-ability-bar-fill-boost" : ""}`}
              style={{ height: `${abilityBarFill * 100}%` }}
            />
          </div>
          <span className="hud-ability-bar-label">Speed</span>
          <span className="hud-ability-bar-key" aria-hidden="true">
            (Space)
          </span>
          <button
            type="button"
            className={`hud-ability-btn ${abilityReady ? "" : "hud-ability-btn-cooldown"}`}
            disabled={!abilityReady}
            onClick={handleBoostClick}
            aria-label="Use speed boost"
          >
            Boost
          </button>
        </div>
      )}
      <div className="hud-stats">
        <span className="hud-stat">Humans: {humanCount}</span>
        <span className="hud-stat">Zombies: {zombieCount}</span>
        <span className="hud-stat">
          {roundActive
            ? `Time left: ${timeLeftStr}`
            : `Round timer: ${roundElapsedSec}s`}
        </span>
      </div>
      <div className={`hud-role ${isZombie ? "zombie" : "human"}`}>
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
              onChange={(e) => {
                setNameInput(e.target.value);
                setNameError("");
              }}
              onKeyDown={handleKeyDown}
              placeholder="Enter your name..."
            />
            <button className="hud-name-btn" onClick={handleSubmitName}>
              Set
            </button>
            <button
              className="hud-name-btn hud-name-cancel"
              onClick={() => setIsEditingName(false)}
            >
              Cancel
            </button>
            {nameError && <div className="hud-name-error">{nameError}</div>}
          </div>
        ) : (
          <div className="hud-name-row">
            <button className="hud-name-display" onClick={handleStartEditing}>
              {currentName} <span className="hud-name-edit-icon">&#9998;</span>
            </button>
            {onVoiceToggle && (
              <button
                type="button"
                className={`hud-voice-btn ${voiceEnabled ? 'hud-voice-on' : 'hud-voice-off'}`}
                onClick={onVoiceToggle}
                title={voiceEnabled ? 'Voice chat on' : 'Voice chat off'}
                aria-label={voiceEnabled ? 'Turn voice chat off' : 'Turn voice chat on'}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                </svg>
                {!voiceEnabled && <span className="hud-voice-slash" />}
              </button>
            )}
          </div>
        )}
      </div>

      {showScoreboard && (
        <div className="hud-scoreboard">
          <h2>
            Round Over -{" "}
            {roundWinner === "humans" ? "Humans Win!" : "Zombies Win!"}
          </h2>
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

      {pingMs != null && (
        <div className="hud-ping" aria-label={`Network latency ${pingMs} ms`}>
          {pingMs} ms
        </div>
      )}
    </div>
  );
}
