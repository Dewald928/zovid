import React, { useEffect, useRef } from 'react';
import './App.css';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables } from './module_bindings';
import { setConnection, setGameState, setLocalIdentity } from './game/stdbBridge';
import { createGameConfig } from './game/config';
import Phaser from 'phaser';
import { HUD, fireBoostActivated } from './components/HUD';

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

  const [pingMs, setPingMs] = React.useState<number | null>(null);

  const config = configRows.length > 0 ? configRows[0] : null;
  const localPlayer = identity
    ? (players ?? []).find((p) => p.identity.toHexString() === identity.toHexString())
    : null;
  const isZombie = localPlayer?.isZombie ?? false;
  const roundActive = config?.roundActive ?? false;

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
      players: players ? [...players] : [],
      config,
      obstacles: obstacles ? [...obstacles] : [],
    });
  }, [players, config, obstacles]);

  useEffect(() => {
    if (!containerRef.current || !isActive) return;
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
  }, [isActive]);

  useEffect(() => {
    setLocalIdentity(identity ? identity.toHexString() : null);
  }, [identity]);

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

  return (
    <div className="app">
      <div ref={containerRef} id="phaser-game" className="app-game" />
      <HUD players={players ? [...players] : []} config={config} localIdentity={identity ?? undefined} connection={connection ?? null} pingMs={pingMs} />
    </div>
  );
}

export default App;
