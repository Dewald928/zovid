import React, { useEffect, useRef, useState } from 'react';
import './App.css';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables } from './module_bindings';
import { setConnection, setGameState, setLocalIdentity } from './game/stdbBridge';
import { createGameConfig } from './game/config';
import Phaser from 'phaser';
import { HUD, fireBoostActivated } from './components/HUD';
import { useProximityVoice } from './voice/useProximityVoice';

function App() {
  const { getConnection, identity, isActive } = useSpacetimeDB();
  const connection = getConnection() as DbConnection | null;
  const gameRef = useRef<Phaser.Game | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const spaceKeyDownRef = useRef(false);

  const [players] = useTable(tables.Player);
  const [configRows] = useTable(tables.GameConfig);
  const [obstacles] = useTable(tables.Obstacle);
  const [botZombies] = useTable(tables.BotZombie);

  const [pingMs, setPingMs] = React.useState<number | null>(null);

  const [voiceEnabled, setVoiceEnabled] = useState(() => {
    try {
      return localStorage.getItem('zovid_voice_enabled') !== 'false';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('zovid_voice_enabled', String(voiceEnabled));
    } catch {
      /* ignore */
    }
  }, [voiceEnabled]);

  const localPlayer = identity
    ? (players ?? []).find((p) => p.identity.toHexString() === identity.toHexString())
    : null;
  const roomId = localPlayer?.roomId ?? 0n;
  const inMenu = roomId === 0n;
  const config = configRows.find((c) => c.id === roomId) ?? null;
  const isZombie = localPlayer?.isZombie ?? false;
  const roundActive = config?.roundActive ?? false;

  const roomPlayers = (players ?? []).filter((p) => p.roomId === roomId);
  const roomObstacles = (obstacles ?? []).filter((o) => o.roomId === roomId);
  const roomBotZombies = (botZombies ?? []).filter((b) => b.roomId === roomId);

  useEffect(() => {
    if (!connection) {
      setConnection(null);
      return;
    }
    setConnection(connection);
    connection.subscriptionBuilder().subscribeToAllTables();
  }, [connection]);

  // Drive game loop: call tick reducer every 50ms (server throttles to 50ms)
  useEffect(() => {
    if (!connection) return;
    const interval = setInterval(() => {
      connection.reducers.tick({});
    }, 50);
    return () => clearInterval(interval);
  }, [connection]);

  // Server connection ping (RTT) via no-op procedure, every 2s
  useEffect(() => {
    if (!connection) return;
    const runPing = () => {
      const start = Date.now();
      connection.procedures.ping({}).then(() => {
        setPingMs(Math.round(Date.now() - start));
      }).catch(() => {
        setPingMs(null);
      });
    };
    runPing();
    const interval = setInterval(runPing, 2000);
    return () => clearInterval(interval);
  }, [connection]);

  useEffect(() => {
    setGameState({
      players: roomPlayers,
      config,
      obstacles: roomObstacles,
      botZombies: roomBotZombies,
    });
  }, [roomPlayers, config, roomObstacles, roomBotZombies]);

  const gameMode = config?.gameMode;
  const showGame = isActive && !inMenu && (gameMode === 'vs_humans' || gameMode === 'vs_bots');

  useEffect(() => {
    if (!containerRef.current || !showGame) return;
    const container = containerRef.current;
    // Wait one frame so the container has layout and dimensions (100dvh etc.)
    const id = requestAnimationFrame(() => {
      const el = document.getElementById('phaser-game');
      if (!el) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      const config = createGameConfig('phaser-game', w, h);
      gameRef.current = new Phaser.Game(config);

      // Keep canvas in sync with container (fixes mobile: URL bar, orientation, safe area)
      const game = gameRef.current;
      const resize = () => {
        const cw = container.clientWidth || window.innerWidth;
        const ch = container.clientHeight || window.innerHeight;
        if (cw > 0 && ch > 0 && game.scale) game.scale.resize(cw, ch);
      };
      const vv = window.visualViewport;
      window.addEventListener('resize', resize);
      if (vv) vv.addEventListener('resize', resize);
      resizeCleanupRef.current = () => {
        window.removeEventListener('resize', resize);
        if (vv) vv.removeEventListener('resize', resize);
        resizeCleanupRef.current = null;
      };
      resize();
    });
    return () => {
      cancelAnimationFrame(id);
      resizeCleanupRef.current?.();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, [showGame]);

  useEffect(() => {
    setLocalIdentity(identity ? identity.toHexString() : null);
  }, [identity]);

  const { startAudio } = useProximityVoice({
    enabled: voiceEnabled && isActive && !!identity && !!localPlayer && !inMenu,
    identity: identity ?? null,
    isZombie,
    players: roomPlayers,
    roundActive,
    roomId,
  });

  // Global Space key: trigger zombie ability (works even when canvas doesn't have focus)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (!connection || !isZombie || !roundActive) return;
      if (spaceKeyDownRef.current) return; // avoid repeat while key held
      spaceKeyDownRef.current = true;
      e.preventDefault();
      fireBoostActivated();
      connection.reducers.useZombieAbility({});
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') spaceKeyDownRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [connection, isZombie, roundActive]);

  if (!isActive) {
    return (
      <div className="app">
        <div className="app-connecting">Connecting to game...</div>
      </div>
    );
  }

  if (inMenu) {
    return (
      <div className="app app-menu">
        <div className="app-menu-bg" aria-hidden="true" />
        <div className="app-menu-content">
          <h1 className="app-menu-title">
            <span className="app-menu-title-main">ZOVID</span>
            <span className="app-menu-title-sub">Outlast the horde</span>
          </h1>
          <p className="app-menu-subtitle">Choose your fight</p>
          <div className="app-menu-buttons">
            <button
              type="button"
              className="app-menu-btn app-menu-btn-humans"
              onClick={() => connection?.reducers.joinRoom({ mode: 'vs_humans' })}
            >
              <span className="app-menu-btn-label">Vs Humans</span>
              <span className="app-menu-btn-desc">Multiplayer — infect or survive</span>
            </button>
            <button
              type="button"
              className="app-menu-btn app-menu-btn-bots"
              onClick={() => connection?.reducers.joinRoom({ mode: 'vs_bots' })}
            >
              <span className="app-menu-btn-label">Vs Bots</span>
              <span className="app-menu-btn-desc">Multiplayer survival — endless zombie waves</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const handleVoiceToggle = () => {
    setVoiceEnabled((v) => {
      const next = !v;
      if (next) startAudio();
      return next;
    });
  };

  return (
    <div className="app">
      <div ref={containerRef} id="phaser-game" className="app-game" />
      <HUD
        players={roomPlayers}
        config={config}
        botZombies={roomBotZombies}
        localIdentity={identity ?? undefined}
        connection={connection ?? null}
        pingMs={pingMs}
        voiceEnabled={voiceEnabled}
        onVoiceToggle={handleVoiceToggle}
        onLeaveRoom={() => connection?.reducers.leaveRoom({})}
      />
    </div>
  );
}

export default App;
