import Phaser from 'phaser';
import { getConnection, getGameState, getLocalIdentity } from '../stdbBridge';
import { VirtualJoystick } from '../VirtualJoystick';
import { fireBoostActivated } from '../../components/HUD';

const PLAYER_SIZE = 32;
const PLAYER_HALF = PLAYER_SIZE / 2;
const HUMAN_COLOR = 0x4488ff;
const ZOMBIE_COLOR = 0x44ff44;
const LOCAL_COLOR = 0xaa44ff;
const FOG_RADIUS = 400;
const LERP = 0.3;
const LOCAL_LERP = 0.5;
const LOCAL_SPEED = 200;
const LOCAL_ZOMBIE_SPEED = 140;
const LOCAL_ZOMBIE_SPEED_BOOST = 220;
const ZOMBIE_BOOST_GLOW_SIZE = 44; // PLAYER_SIZE + 12
const ZOMBIE_BOOST_GLOW_COLOR = 0x44ff88;
const ARENA_FILL = 0x1a3320;
const ARENA_BORDER = 0x2a5530;
const GRID_COLOR = 0x224428;
const GRID_SPACING = 200;
const DECOR_COLOR_1 = 0x1e3a24;
const DECOR_COLOR_2 = 0x162c1a;
const FOG_ALPHA = 0.95;
const OBSTACLE_DEPTH = 50;
const BUILDING_FILL = 0x4a4a4a;
const BUILDING_BORDER = 0x666666;
const RUIN_FILL = 0x5a5040;
const RUIN_BORDER = 0x6a6050;
const TREE_FILL = 0x2d5a1e;
const TREE_TRUNK = 0x4a3520;

export class MainScene extends Phaser.Scene {
  private playerSprites!: Map<string, Phaser.GameObjects.Rectangle>;
  private playerBoostGlows!: Map<string, Phaser.GameObjects.Rectangle>;
  private playerNames!: Map<string, Phaser.GameObjects.Text>;
  private botZombieSprites!: Map<string, Phaser.GameObjects.Rectangle>;
  private fogSprite!: Phaser.GameObjects.Image;
  private arenaGraphics!: Phaser.GameObjects.Graphics;
  private obstacleGraphics!: Phaser.GameObjects.Graphics;
  private minimapBorder!: Phaser.GameObjects.Graphics;
  private minimapCam!: Phaser.Cameras.Scene2D.Camera;
  private lastDirX = 0;
  private lastDirY = 0;
  private localIdentityHex: string | null = null;
  private lastMapW = 0;
  private lastMapH = 0;
  private lastObstacleCount = -1;
  private lastObstacleIdSig = '';
  private lastRoundNumber: string = '';
  private joystick: VirtualJoystick | null = null;
  // Survival mode: health bars, blood decals, muzzle flash
  private healthBarGraphics!: Phaser.GameObjects.Graphics;
  private bloodGraphics!: Phaser.GameObjects.Graphics;
  private bloodDecals: Array<{ x: number; y: number; createdAt: number }> = [];
  private readonly MAX_BLOOD_DECALS = 100;
  private readonly BLOOD_FADE_MS = 15000;
  private prevPlayerHealth = new Map<string, number>();
  private prevBotHealth = new Map<string, number>();
  private prevBotPos = new Map<string, { x: number; y: number }>();
  private muzzleFlashGraphics: Phaser.GameObjects.Graphics | null = null;
  private muzzleFlashUntil = 0;
  private muzzleFlashX = 0;
  private muzzleFlashY = 0;
  private bulletTracerGraphics: Phaser.GameObjects.Graphics | null = null;
  private bulletTracerUntil = 0;
  private bulletTracerFrom = { x: 0, y: 0 };
  private bulletTracerTo = { x: 0, y: 0 };
  private gunGraphics: Phaser.GameObjects.Graphics | null = null;
  private static readonly WEAPON_TIP_OFFSET = PLAYER_HALF + 10;
  private static readonly WEAPON_RANGE_VISUAL = 300;
  private static readonly GUN_BARREL_LENGTH = 22;
  private static readonly GUN_BARREL_THICKNESS = 5;
  private static readonly WEAPON_COOLDOWN_MS = 400;
  static readonly SHOOT_DOWN_EVENT = 'zovid-shoot-down';
  static readonly SHOOT_UP_EVENT = 'zovid-shoot-up';

  private shootButtonHeld = false;
  private canvasShootHeld = false;
  private lastShotTime = 0;
  private lastAimWorld = { x: 0, y: 0 };
  private lastAimSet = false;

  constructor() {
    super({ key: 'MainScene' });
  }

  private drawArena(g: Phaser.GameObjects.Graphics, w: number, h: number): void {
    g.clear();
    const hash = (a: number, b: number) => ((a * 2654435761) ^ (b * 2246822519)) >>> 0;

    g.fillStyle(ARENA_FILL, 1);
    g.fillRect(0, 0, w, h);

    const patchSize = 100;
    const patchColors = [0x1c3622, 0x17301c, 0x1f3926, 0x152b19, 0x213d28];
    for (let px = 0; px < w; px += patchSize) {
      for (let py = 0; py < h; py += patchSize) {
        const s = hash(px + 7, py + 13);
        const col = patchColors[s % patchColors.length];
        const alpha = 0.25 + (((s >> 4) % 30) / 100);
        const inset = (s >> 10) % 20;
        g.fillStyle(col, alpha);
        g.fillRect(px + inset, py + inset, patchSize - inset * 2, patchSize - inset * 2);
      }
    }

    g.lineStyle(1, GRID_COLOR, 0.35);
    for (let x = GRID_SPACING; x < w; x += GRID_SPACING) {
      g.lineBetween(x, 0, x, h);
    }
    for (let y = GRID_SPACING; y < h; y += GRID_SPACING) {
      g.lineBetween(0, y, w, y);
    }

    const cellSize = 80;
    for (let cx = 0; cx < w; cx += cellSize) {
      for (let cy = 0; cy < h; cy += cellSize) {
        const s = hash(cx, cy);
        const count = 1 + (s % 3);
        for (let i = 0; i < count; i++) {
          const si = hash(cx + i * 311, cy + i * 173);
          const kind = si % 8;
          const ox = (si % (cellSize - 10)) + 5;
          const oy = ((si >> 8) % (cellSize - 10)) + 5;
          const dx = cx + ox;
          const dy = cy + oy;
          if (dx >= w - 2 || dy >= h - 2) continue;

          if (kind === 0) {
            g.lineStyle(1, 0x2a5a30, 0.5);
            g.lineBetween(dx, dy, dx - 2, dy - 6);
            g.lineBetween(dx, dy, dx + 1, dy - 7);
            g.lineBetween(dx, dy, dx + 3, dy - 5);
          } else if (kind === 1) {
            g.fillStyle(0x2a2818, 0.3);
            g.fillCircle(dx, dy, 2 + (si % 2));
          } else if (kind === 2) {
            g.fillStyle(DECOR_COLOR_1, 0.4);
            g.fillCircle(dx, dy, 2);
            g.fillCircle(dx + 6, dy + 3, 1.5);
            g.fillCircle(dx - 4, dy + 5, 1.5);
          } else if (kind === 3) {
            g.fillStyle(DECOR_COLOR_2, 0.3);
            const sz = 4 + (si % 5);
            g.fillRect(dx - sz / 2, dy - sz / 2, sz, sz);
          } else if (kind === 4) {
            g.lineStyle(1, 0x306838, 0.45);
            g.lineBetween(dx - 1, dy, dx - 4, dy - 9);
            g.lineBetween(dx, dy, dx + 1, dy - 10);
            g.lineBetween(dx + 1, dy, dx + 5, dy - 8);
            g.lineBetween(dx + 2, dy, dx + 3, dy - 6);
          } else if (kind === 5) {
            g.fillStyle(DECOR_COLOR_1, 0.5);
            g.fillPoint(dx, dy - 3, 2);
            g.fillPoint(dx - 3, dy, 2);
            g.fillPoint(dx + 3, dy, 2);
            g.fillPoint(dx, dy + 3, 2);
          } else if (kind === 6) {
            g.fillStyle(0x1a4020, 0.25);
            g.fillCircle(dx, dy, 6 + (si % 4));
          }
        }
      }
    }

    g.lineStyle(4, ARENA_BORDER, 1);
    g.strokeRect(0, 0, w, h);
  }

  private drawObstacles(
    g: Phaser.GameObjects.Graphics,
    obstacles: Array<{ x: number; y: number; width: number; height: number; obstacleType: string }>
  ): void {
    g.clear();
    const hash = (a: number, b: number) => ((a * 2654435761) ^ (b * 2246822519)) >>> 0;
    for (const o of obstacles) {
      const left = o.x - o.width / 2;
      const top = o.y - o.height / 2;
      if (o.obstacleType === 'building_wall') {
        g.fillStyle(BUILDING_FILL, 1);
        g.fillRect(left, top, o.width, o.height);
        g.lineStyle(1, BUILDING_BORDER, 1);
        g.strokeRect(left, top, o.width, o.height);
      } else if (o.obstacleType === 'ruin') {
        const alpha = 0.7 + (hash(Math.floor(o.x), Math.floor(o.y)) % 21) / 100;
        g.fillStyle(RUIN_FILL, alpha);
        g.fillRect(left, top, o.width, o.height);
        g.lineStyle(1, RUIN_BORDER, 0.9);
        g.strokeRect(left, top, o.width, o.height);
        for (let r = 0; r < 4; r++) {
          const rx = left + (hash(r, Math.floor(o.y)) % 100) / 100 * o.width;
          const ry = top + (hash(Math.floor(o.x), r) % 100) / 100 * o.height;
          g.fillStyle(0x3a3020, 0.5);
          g.fillCircle(rx, ry, 1.5);
        }
      } else if (o.obstacleType === 'tree') {
        const radius = o.width / 2;
        g.fillStyle(TREE_FILL, 1);
        g.fillCircle(o.x, o.y, radius);
        g.fillStyle(TREE_TRUNK, 1);
        g.fillCircle(o.x, o.y, Math.max(2, radius * 0.25));
      }
    }
  }

  private drawMinimapBorder(x: number, y: number, size: number, pad: number): void {
    this.minimapBorder.clear();
    this.minimapBorder.lineStyle(2, 0xcc3333, 0.9);
    this.minimapBorder.strokeRect(x - pad, y - pad, size + pad * 2, size + pad * 2);
    this.minimapBorder.lineStyle(1, 0xff5555, 0.5);
    this.minimapBorder.strokeRect(x - pad - 1, y - pad - 1, size + pad * 2 + 2, size + pad * 2 + 2);
  }

  create(): void {
    this.playerSprites = new Map();
    this.playerBoostGlows = new Map();
    this.playerNames = new Map();
    this.botZombieSprites = new Map();
    this.healthBarGraphics = this.add.graphics();
    this.healthBarGraphics.setDepth(102);
    this.bloodGraphics = this.add.graphics();
    this.bloodGraphics.setDepth(98);
    this.muzzleFlashGraphics = this.add.graphics();
    this.muzzleFlashGraphics.setDepth(103);
    this.bulletTracerGraphics = this.add.graphics();
    this.bulletTracerGraphics.setDepth(104);
    this.gunGraphics = this.add.graphics();
    this.gunGraphics.setDepth(100.5);
    const mapW = 2000;
    const mapH = 2000;

    this.cameras.main.setBounds(0, 0, mapW, mapH);
    this.cameras.main.setZoom(1);
    this.cameras.main.centerOn(mapW / 2, mapH / 2);

    this.arenaGraphics = this.add.graphics();
    this.arenaGraphics.setDepth(0);
    this.drawArena(this.arenaGraphics, mapW, mapH);
    this.obstacleGraphics = this.add.graphics();
    this.obstacleGraphics.setDepth(OBSTACLE_DEPTH);
    this.lastMapW = mapW;
    this.lastMapH = mapH;

    if (this.input.keyboard) {
      const keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT') as Record<string, Phaser.Input.Keyboard.Key> & {
        W: Phaser.Input.Keyboard.Key;
        A: Phaser.Input.Keyboard.Key;
        S: Phaser.Input.Keyboard.Key;
        D: Phaser.Input.Keyboard.Key;
      };
      this.registry.set('moveKeys', keys);
      const spaceKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
      this.registry.set('abilityKey', spaceKey);
    } else {
      this.registry.set('moveKeys', null);
      this.registry.set('abilityKey', null);
    }

    // Fog sprite: dark everywhere with gradient vision hole in center
    // Size it to cover the full screen even on large desktops (generous size in all directions)
    const fogW = Math.max(this.scale.width, this.scale.height) * 4 + FOG_RADIUS * 2;
    const fogDim = Math.min(fogW, 12000);
    const fogTex = this.textures.createCanvas('fogTex', fogDim, fogDim);
    const ctx = fogTex!.getContext();
    const fcx = fogDim / 2;
    const fcy = fogDim / 2;

    ctx.fillStyle = `rgba(0, 0, 0, ${FOG_ALPHA})`;
    ctx.fillRect(0, 0, fogDim, fogDim);

    ctx.globalCompositeOperation = 'destination-out';
    const grad = ctx.createRadialGradient(fcx, fcy, 0, fcx, fcy, FOG_RADIUS);
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(0.3, 'rgba(0, 0, 0, 0.98)');
    grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.7)');
    grad.addColorStop(0.75, 'rgba(0, 0, 0, 0.25)');
    grad.addColorStop(0.9, 'rgba(0, 0, 0, 0.05)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(fcx, fcy, FOG_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    fogTex!.refresh();

    this.fogSprite = this.add.image(0, 0, 'fogTex');
    this.fogSprite.setDepth(1000);
    this.fogSprite.setVisible(false);

    const mmSize = 180;
    const mmPad = 3;
    const mmX = this.scale.width - mmSize - mmPad - 10;
    const mmY = 10 + mmPad;

    this.minimapCam = this.cameras.add(mmX, mmY, mmSize, mmSize);
    this.minimapCam.setBackgroundColor('rgba(0, 0, 0, 0.5)');
    this.minimapCam.centerOn(mapW / 2, mapH / 2);
    this.minimapCam.setZoom(mmSize / Math.max(mapW, mapH));
    this.minimapCam.setVisible(false);

    this.minimapBorder = this.add.graphics();
    this.minimapBorder.setDepth(2000);
    this.minimapBorder.setScrollFactor(0);
    this.minimapBorder.setVisible(false);
    this.drawMinimapBorder(mmX, mmY, mmSize, mmPad);

    this.fogSprite.cameraFilter |= this.minimapCam.id;
    this.minimapBorder.cameraFilter |= this.minimapCam.id;

    if (VirtualJoystick.isTouchDevice()) {
      this.joystick = new VirtualJoystick(this);
      this.setupTouchBoostZone();
      this.setupNativeTouchBoostFallback();
    }

    // Survival: fire on click/tap and hold mouse to shoot continuously (aim at pointer)
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const { config } = getGameState();
      if (config?.gameMode === 'survival') this.canvasShootHeld = true;
      this.tryFireAtWorld(pointer.x, pointer.y);
    });
    this.input.on('pointerup', () => { this.canvasShootHeld = false; });
    this.input.on('pointerout', () => { this.canvasShootHeld = false; });

    // Hold-to-shoot: listen for shoot button (HUD) held state (mobile)
    const onShootDown = () => { this.shootButtonHeld = true; };
    const onShootUp = () => { this.shootButtonHeld = false; };
    window.addEventListener(MainScene.SHOOT_DOWN_EVENT, onShootDown);
    window.addEventListener(MainScene.SHOOT_UP_EVENT, onShootUp);
    this.events.once(Phaser.Scenes.Events.DESTROY, () => {
      window.removeEventListener(MainScene.SHOOT_DOWN_EVENT, onShootDown);
      window.removeEventListener(MainScene.SHOOT_UP_EVENT, onShootUp);
    });
  }

  private tryFireAtWorld(screenX: number, screenY: number): void {
    const { players, config } = getGameState();
    const conn = getConnection();
    const localHex = getLocalIdentity();
    const me = localHex ? players?.find((p) => p.identity.toHexString() === localHex) : null;
    if (!conn || !me || config?.gameMode !== 'survival' || !config?.roundActive || me.health <= 0) return;
    const nowMicros = BigInt(Date.now()) * 1000n;
    if (nowMicros < me.weaponCooldownUntilMicros) return;
    const world = this.cameras.main.getWorldPoint(screenX, screenY);
    this.lastAimWorld = { x: world.x, y: world.y };
    this.lastAimSet = true;
    const dx = world.x - me.x;
    const dy = world.y - me.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    this.muzzleFlashX = me.x + ux * MainScene.WEAPON_TIP_OFFSET;
    this.muzzleFlashY = me.y + uy * MainScene.WEAPON_TIP_OFFSET;
    this.muzzleFlashUntil = this.time.now + 80;
    const tipX = this.muzzleFlashX;
    const tipY = this.muzzleFlashY;
    this.bulletTracerFrom = { x: tipX, y: tipY };
    this.bulletTracerTo = {
      x: tipX + ux * MainScene.WEAPON_RANGE_VISUAL,
      y: tipY + uy * MainScene.WEAPON_RANGE_VISUAL,
    };
    this.bulletTracerUntil = this.time.now + 120;
    conn.reducers.fireWeapon({ targetX: world.x, targetY: world.y });
    this.lastShotTime = this.time.now;
  }

  private tryFireFromButton(): void {
    const { players, config } = getGameState();
    const conn = getConnection();
    const localHex = getLocalIdentity();
    const me = localHex ? players?.find((p) => p.identity.toHexString() === localHex) : null;
    if (!conn || !me || config?.gameMode !== 'survival' || !config?.roundActive || me.health <= 0) return;
    const nowMicros = BigInt(Date.now()) * 1000n;
    if (nowMicros < me.weaponCooldownUntilMicros) return;

    let targetX: number;
    let targetY: number;
    if (this.lastAimSet) {
      targetX = this.lastAimWorld.x;
      targetY = this.lastAimWorld.y;
    } else {
      const dx = me.dirX;
      const dy = me.dirY;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = len > 1e-6 ? dx / len : 1;
      const uy = len > 1e-6 ? dy / len : 0;
      targetX = me.x + ux * MainScene.WEAPON_RANGE_VISUAL;
      targetY = me.y + uy * MainScene.WEAPON_RANGE_VISUAL;
    }

    const dx = targetX - me.x;
    const dy = targetY - me.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    this.muzzleFlashX = me.x + ux * MainScene.WEAPON_TIP_OFFSET;
    this.muzzleFlashY = me.y + uy * MainScene.WEAPON_TIP_OFFSET;
    this.muzzleFlashUntil = this.time.now + 80;
    const tipX = this.muzzleFlashX;
    const tipY = this.muzzleFlashY;
    this.bulletTracerFrom = { x: tipX, y: tipY };
    this.bulletTracerTo = { x: tipX + ux * MainScene.WEAPON_RANGE_VISUAL, y: tipY + uy * MainScene.WEAPON_RANGE_VISUAL };
    this.bulletTracerUntil = this.time.now + 120;
    conn.reducers.fireWeapon({ targetX, targetY });
  }

  /** Bottom-left screen zone for boost on touch devices; works with joystick (bottom-right) for multi-touch. */
  private setupTouchBoostZone(): void {
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (!this.isInBoostZone(ptr.x, ptr.y)) return;
      this.tryFireBoost();
    });
  }

  /** Native touchstart fallback so the second finger is always seen (some browsers don't give Phaser a second pointer). */
  private setupNativeTouchBoostFallback(): void {
    const canvas = this.sys.game.canvas;
    const handler = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        const rect = canvas.getBoundingClientRect();
        const scaleW = this.scale.width;
        const scaleH = this.scale.height;
        const x = ((t.clientX - rect.left) / rect.width) * scaleW;
        const y = ((t.clientY - rect.top) / rect.height) * scaleH;
        if (this.isInBoostZone(x, y)) {
          this.tryFireBoost();
          e.preventDefault();
          break;
        }
      }
    };
    canvas.addEventListener('touchstart', handler, { passive: false });
    this.events.once(Phaser.Scenes.Events.DESTROY, () => {
      canvas.removeEventListener('touchstart', handler);
    });
  }

  private tryFireBoost(): void {
    const conn = getConnection();
    const { players, config } = getGameState();
    const localHex = getLocalIdentity();
    const me = localHex ? players.find((p) => p.identity.toHexString() === localHex) : null;
    if (!conn || !me?.isZombie || !config?.roundActive) return;
    const nowMicros = BigInt(Date.now()) * 1000n;
    if (me.abilityCooldownUntilMicros > nowMicros) return;
    fireBoostActivated();
    conn.reducers.useZombieAbility({});
  }

  private isInBoostZone(x: number, y: number): boolean {
    const w = this.scale.width;
    const h = this.scale.height;
    return x < w * 0.5 && y > h * 0.5;
  }

  /** Minimum distance between character centers so they don't overlap (same as server). */
  private static readonly MIN_CENTER_DIST = PLAYER_HALF * 2;

  /**
   * Clamp desired position so it doesn't overlap any blocker (opposite team / bots).
   * Uses axis sliding: try X-only, then Y-only, then block.
   */
  private clampToNotOverlap(
    desiredX: number,
    desiredY: number,
    currentX: number,
    currentY: number,
    blockers: Array<{ x: number; y: number }>,
  ): { x: number; y: number } {
    const minDistSq = MainScene.MIN_CENTER_DIST * MainScene.MIN_CENTER_DIST;
    const overlaps = (ax: number, ay: number) => {
      for (const b of blockers) {
        const dx = ax - b.x;
        const dy = ay - b.y;
        if (dx * dx + dy * dy < minDistSq) return true;
      }
      return false;
    };
    if (!overlaps(desiredX, desiredY)) return { x: desiredX, y: desiredY };
    const tryX = !overlaps(desiredX, currentY);
    const tryY = !overlaps(currentX, desiredY);
    if (tryX) return { x: desiredX, y: currentY };
    if (tryY) return { x: currentX, y: desiredY };
    return { x: currentX, y: currentY };
  }

  /** Nudge (ax, ay) away from (bx, by) so centers are at least MIN_CENTER_DIST apart. */
  private static nudgeApart(
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): { x: number; y: number } {
    const dx = ax - bx;
    const dy = ay - by;
    const dSq = dx * dx + dy * dy;
    if (dSq >= MainScene.MIN_CENTER_DIST * MainScene.MIN_CENTER_DIST || dSq < 1e-6) {
      return { x: ax, y: ay };
    }
    const d = Math.sqrt(dSq);
    const overlap = MainScene.MIN_CENTER_DIST - d;
    const nx = dx / d;
    const ny = dy / d;
    return { x: ax + nx * overlap, y: ay + ny * overlap };
  }

  private addBloodDecal(x: number, y: number): void {
    this.bloodDecals.push({ x, y, createdAt: this.time.now });
    if (this.bloodDecals.length > this.MAX_BLOOD_DECALS) this.bloodDecals.shift();
  }

  private drawHealthBars(
    players: Array<{ identity: { toHexString: () => string }; health: number; maxHealth: number }>,
    botZombies: Array<{ id: bigint; health: number; maxHealth: number }>,
  ): void {
    this.healthBarGraphics.clear();
    const barW = 24;
    const barH = 4;
    const pad = PLAYER_HALF + 4;
    for (const p of players) {
      const key = p.identity.toHexString();
      const rect = this.playerSprites.get(key);
      if (!rect || (p.maxHealth && p.maxHealth <= 0)) continue;
      const frac = Math.max(0, p.health / (p.maxHealth || 1));
      this.healthBarGraphics.fillStyle(0x333333, 0.9);
      this.healthBarGraphics.fillRect(rect.x - barW / 2, rect.y - pad - barH, barW, barH);
      this.healthBarGraphics.fillStyle(0x44aa44, 0.95);
      this.healthBarGraphics.fillRect(rect.x - barW / 2, rect.y - pad - barH, barW * frac, barH);
    }
    for (const bz of botZombies) {
      const key = `bot-${bz.id.toString()}`;
      const rect = this.botZombieSprites.get(key);
      if (!rect || (bz.maxHealth && bz.maxHealth <= 0)) continue;
      const frac = Math.max(0, bz.health / (bz.maxHealth || 1));
      this.healthBarGraphics.fillStyle(0x333333, 0.9);
      this.healthBarGraphics.fillRect(rect.x - barW / 2, rect.y - pad - barH, barW, barH);
      this.healthBarGraphics.fillStyle(0xaa4444, 0.95);
      this.healthBarGraphics.fillRect(rect.x - barW / 2, rect.y - pad - barH, barW * frac, barH);
    }
  }

  private drawBloodDecals(): void {
    this.bloodGraphics.clear();
    const now = this.time.now;
    while (this.bloodDecals.length > 0 && now - this.bloodDecals[0].createdAt > this.BLOOD_FADE_MS) {
      this.bloodDecals.shift();
    }
    const radius = 8;
    for (const d of this.bloodDecals) {
      const age = now - d.createdAt;
      const alpha = Math.max(0, 1 - age / this.BLOOD_FADE_MS) * 0.85;
      if (alpha <= 0) continue;
      this.bloodGraphics.fillStyle(0x660000, alpha);
      this.bloodGraphics.fillCircle(d.x, d.y, radius);
    }
  }

  update(_time: number, _delta: number): void {
    this.localIdentityHex = getLocalIdentity();
    const conn = getConnection();
    const { players, config, botZombies = [] } = getGameState();

    const mapW = config?.mapWidth ?? 2000;
    const mapH = config?.mapHeight ?? 2000;
    this.cameras.main.setBounds(0, 0, mapW, mapH);
    const mmSize = 180;
    const mmPad = 3;
    const mmX = this.scale.width - mmSize - mmPad - 10;
    const mmY = 10 + mmPad;
    this.minimapCam.setBounds(0, 0, mapW, mapH);
    this.minimapCam.centerOn(mapW / 2, mapH / 2);
    this.minimapCam.setZoom(mmSize / Math.max(mapW, mapH));
    this.minimapCam.setPosition(mmX, mmY);
    this.drawMinimapBorder(mmX, mmY, mmSize, mmPad);

    if (mapW !== this.lastMapW || mapH !== this.lastMapH) {
      this.lastMapW = mapW;
      this.lastMapH = mapH;
      this.drawArena(this.arenaGraphics, mapW, mapH);
    }
    const obstacles = getGameState().obstacles ?? [];
    const roundNumber = config?.roundNumber?.toString() ?? '0';
    const idSig = obstacles.length > 0 ? `${obstacles.length}-${obstacles[0].id.toString()}` : '0';
    const shouldRedraw =
      roundNumber !== this.lastRoundNumber ||
      obstacles.length !== this.lastObstacleCount ||
      idSig !== this.lastObstacleIdSig;
    if (shouldRedraw) {
      this.lastRoundNumber = roundNumber;
      this.lastObstacleCount = obstacles.length;
      this.lastObstacleIdSig = idSig;
      this.drawObstacles(this.obstacleGraphics, obstacles);
    }

    const keys = this.registry.get('moveKeys') as (Record<string, Phaser.Input.Keyboard.Key> & {
      W: Phaser.Input.Keyboard.Key;
      A: Phaser.Input.Keyboard.Key;
      S: Phaser.Input.Keyboard.Key;
      D: Phaser.Input.Keyboard.Key;
    }) | null;
    let dirX = 0;
    let dirY = 0;
    if (keys) {
      const k = keys as Record<string, Phaser.Input.Keyboard.Key | undefined>;
      if (keys.W?.isDown || k['UP']?.isDown) dirY -= 1;
      if (keys.S?.isDown || k['DOWN']?.isDown) dirY += 1;
      if (keys.A?.isDown || k['LEFT']?.isDown) dirX -= 1;
      if (keys.D?.isDown || k['RIGHT']?.isDown) dirX += 1;
    }
    if (this.joystick) {
      const jx = this.joystick.getDirX();
      const jy = this.joystick.getDirY();
      if (jx !== 0 || jy !== 0) {
        dirX = jx;
        dirY = jy;
      }
    }
    if (dirX !== this.lastDirX || dirY !== this.lastDirY) {
      this.lastDirX = dirX;
      this.lastDirY = dirY;
      if (conn) {
        conn.reducers.setInput({ dirX, dirY });
      }
    }

    const abilityKey = this.registry.get('abilityKey') as Phaser.Input.Keyboard.Key | null;
    const me = this.localIdentityHex
      ? players.find((p) => p.identity.toHexString() === this.localIdentityHex)
      : null;
    if (
      conn &&
      me?.isZombie &&
      config?.roundActive &&
      (abilityKey as { justDown?: boolean })?.justDown
    ) {
      fireBoostActivated();
      conn.reducers.useZombieAbility({});
    }

    // Hold-to-shoot (survival): fire at cooldown rate while mouse or shoot button is held
    const shootHeld = this.shootButtonHeld || this.canvasShootHeld;
    if (
      config?.gameMode === 'survival' &&
      config?.roundActive &&
      me &&
      !me.isZombie &&
      me.health > 0 &&
      shootHeld &&
      this.time.now - this.lastShotTime >= MainScene.WEAPON_COOLDOWN_MS
    ) {
      const nowMicrosCheck = BigInt(Date.now()) * 1000n;
      if (nowMicrosCheck >= me.weaponCooldownUntilMicros) {
        if (this.canvasShootHeld) {
          const ptr = this.input.activePointer;
          this.tryFireAtWorld(ptr.x, ptr.y);
        } else {
          this.tryFireFromButton();
        }
        this.lastShotTime = this.time.now;
      }
    }

    const dt = _delta / 1000;
    const nowMicros = BigInt(Date.now()) * 1000n;
    const seen = new Set<string>();
    const isLocal = (key: string) => key === this.localIdentityHex;

    // Blockers for local player: opposite team players + bot zombies (so we don't clip through them)
    const blockers: Array<{ x: number; y: number }> = [];
    if (me) {
      for (const p of players) {
        if (p.identity.toHexString() === this.localIdentityHex || p.isZombie === me.isZombie) continue;
        blockers.push({ x: p.x, y: p.y });
      }
      for (const bz of botZombies) {
        blockers.push({ x: bz.x, y: bz.y });
      }
    }

    for (const p of players) {
      const key = p.identity.toHexString();
      seen.add(key);
      let rect = this.playerSprites.get(key);
      if (!rect) {
        rect = this.add.rectangle(p.x, p.y, PLAYER_SIZE, PLAYER_SIZE, p.isZombie ? ZOMBIE_COLOR : HUMAN_COLOR);
        rect.setDepth(100);
        this.playerSprites.set(key, rect);
        const glow = this.add.rectangle(p.x, p.y, ZOMBIE_BOOST_GLOW_SIZE, ZOMBIE_BOOST_GLOW_SIZE, ZOMBIE_BOOST_GLOW_COLOR);
        glow.setDepth(99);
        glow.setVisible(false);
        this.playerBoostGlows.set(key, glow);
      }

      if (isLocal(key)) {
        const zombieSpeed =
          p.isZombie && p.speedBoostUntilMicros > nowMicros
            ? LOCAL_ZOMBIE_SPEED_BOOST
            : LOCAL_ZOMBIE_SPEED;
        const speed = p.isZombie ? zombieSpeed : LOCAL_SPEED;
        let predX = rect.x + dirX * speed * dt;
        let predY = rect.y + dirY * speed * dt;
        predX = Math.max(0, Math.min(mapW, predX));
        predY = Math.max(0, Math.min(mapH, predY));
        const clamped = this.clampToNotOverlap(predX, predY, rect.x, rect.y, blockers);
        predX = clamped.x;
        predY = clamped.y;
        rect.x = Phaser.Math.Linear(predX, p.x, LOCAL_LERP);
        rect.y = Phaser.Math.Linear(predY, p.y, LOCAL_LERP);
      } else {
        rect.x = Phaser.Math.Linear(rect.x, p.x, LERP);
        rect.y = Phaser.Math.Linear(rect.y, p.y, LERP);
      }
      const color = isLocal(key) ? LOCAL_COLOR : p.isZombie ? ZOMBIE_COLOR : HUMAN_COLOR;
      rect.setFillStyle(color);

      const boostActive = p.isZombie && p.speedBoostUntilMicros > nowMicros;
      const glow = this.playerBoostGlows.get(key)!;
      glow.setPosition(rect.x, rect.y);
      glow.setVisible(boostActive);
      if (boostActive) {
        const pulse = 0.35 + 0.2 * Math.sin(this.time.now / 80);
        glow.setAlpha(pulse);
      }

      let nameText = this.playerNames.get(key);
      const displayName = p.name || 'Player';
      if (!nameText) {
        nameText = this.add.text(rect.x, rect.y - PLAYER_SIZE - 4, displayName, {
          fontSize: '12px',
          fontFamily: 'Arial, sans-serif',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 3,
          align: 'center',
        });
        nameText.setOrigin(0.5, 1);
        nameText.setDepth(101);
        nameText.cameraFilter |= this.minimapCam.id;
        this.playerNames.set(key, nameText);
      }
      nameText.setPosition(rect.x, rect.y - PLAYER_SIZE / 2 - 4);
      if (nameText.text !== displayName) {
        nameText.setText(displayName);
      }
    }
    for (const [key, rect] of this.playerSprites) {
      if (!seen.has(key)) {
        rect.destroy();
        this.playerSprites.delete(key);
        const boostGlow = this.playerBoostGlows.get(key);
        if (boostGlow) {
          boostGlow.destroy();
          this.playerBoostGlows.delete(key);
        }
        const nameText = this.playerNames.get(key);
        if (nameText) {
          nameText.destroy();
          this.playerNames.delete(key);
        }
      }
    }

    const botZombieSeen = new Set<string>();
    for (const bz of botZombies) {
      const key = `bot-${bz.id.toString()}`;
      botZombieSeen.add(key);
      let rect = this.botZombieSprites.get(key);
      if (!rect) {
        rect = this.add.rectangle(bz.x, bz.y, PLAYER_SIZE, PLAYER_SIZE, ZOMBIE_COLOR);
        rect.setDepth(100);
        this.botZombieSprites.set(key, rect);
      }
      rect.x = Phaser.Math.Linear(rect.x, bz.x, LERP);
      rect.y = Phaser.Math.Linear(rect.y, bz.y, LERP);
      rect.setFillStyle(ZOMBIE_COLOR);
      this.prevBotPos.set(key, { x: bz.x, y: bz.y });
    }
    for (const [key, rect] of this.botZombieSprites) {
      if (!botZombieSeen.has(key)) {
        if (config?.gameMode === 'survival') {
          const pos = this.prevBotPos.get(key);
          if (pos) this.addBloodDecal(pos.x, pos.y);
        }
        this.prevBotHealth.delete(key);
        this.prevBotPos.delete(key);
        rect.destroy();
        this.botZombieSprites.delete(key);
      }
    }

    const isSurvival = config?.gameMode === 'survival';
    if (isSurvival) {
      for (const p of players) {
        const key = p.identity.toHexString();
        const prev = this.prevPlayerHealth.get(key);
        if (prev !== undefined && p.health < prev) this.addBloodDecal(p.x, p.y);
        this.prevPlayerHealth.set(key, p.health);
      }
      for (const bz of botZombies) {
        const key = `bot-${bz.id.toString()}`;
        const prev = this.prevBotHealth.get(key);
        if (prev !== undefined && bz.health < prev) this.addBloodDecal(bz.x, bz.y);
        this.prevBotHealth.set(key, bz.health);
      }
      this.healthBarGraphics.setVisible(true);
      this.bloodGraphics.setVisible(true);
      this.drawHealthBars(players, botZombies);
      this.drawBloodDecals();
    } else {
      this.healthBarGraphics.setVisible(false);
      this.bloodGraphics.setVisible(false);
    }

    // Nudge other sprites away from local player so they don't clip (client-side display only)
    const localSprite = this.localIdentityHex ? this.playerSprites.get(this.localIdentityHex) : null;
    if (localSprite) {
      const lx = localSprite.x;
      const ly = localSprite.y;
      for (const [key, rect] of this.playerSprites) {
        if (key === this.localIdentityHex) continue;
        const nudged = MainScene.nudgeApart(rect.x, rect.y, lx, ly);
        rect.x = nudged.x;
        rect.y = nudged.y;
      }
      for (const [, rect] of this.botZombieSprites) {
        const nudged = MainScene.nudgeApart(rect.x, rect.y, lx, ly);
        rect.x = nudged.x;
        rect.y = nudged.y;
      }
    }

    // Nudge bot zombie sprites apart from each other so they don't clip
    const botRects = [...this.botZombieSprites.values()];
    for (let i = 0; i < botRects.length; i++) {
      for (let j = i + 1; j < botRects.length; j++) {
        const a = botRects[i];
        const b = botRects[j];
        const nudgedA = MainScene.nudgeApart(a.x, a.y, b.x, b.y);
        const nudgedB = MainScene.nudgeApart(b.x, b.y, a.x, a.y);
        a.x = nudgedA.x;
        a.y = nudgedA.y;
        b.x = nudgedB.x;
        b.y = nudgedB.y;
      }
    }

    const localPlayer = this.localIdentityHex ? players.find((p) => p.identity.toHexString() === this.localIdentityHex) : null;
    const now = this.time.now;
    if (this.muzzleFlashGraphics) {
      if (now < this.muzzleFlashUntil) {
        this.muzzleFlashGraphics.setVisible(true);
        this.muzzleFlashGraphics.clear();
        this.muzzleFlashGraphics.fillStyle(0xffcc44, 0.7 - (this.muzzleFlashUntil - now) / 80 * 0.5);
        this.muzzleFlashGraphics.fillCircle(this.muzzleFlashX, this.muzzleFlashY, 18);
      } else {
        this.muzzleFlashGraphics.setVisible(false);
      }
    }
    if (this.bulletTracerGraphics) {
      if (now < this.bulletTracerUntil) {
        this.bulletTracerGraphics.setVisible(true);
        this.bulletTracerGraphics.clear();
        const tracerAlpha = Math.max(0, 1 - (now - (this.bulletTracerUntil - 120)) / 120);
        this.bulletTracerGraphics.lineStyle(4, 0xffdd66, tracerAlpha);
        this.bulletTracerGraphics.lineBetween(
          this.bulletTracerFrom.x,
          this.bulletTracerFrom.y,
          this.bulletTracerTo.x,
          this.bulletTracerTo.y,
        );
      } else {
        this.bulletTracerGraphics.setVisible(false);
      }
    }
    if (this.gunGraphics && config?.gameMode === 'survival' && localPlayer && localSprite && localPlayer.health > 0) {
      const ptr = this.input.activePointer;
      const world = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
      let dx = world.x - localSprite.x;
      let dy = world.y - localSprite.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const tipX = localSprite.x + ux * MainScene.GUN_BARREL_LENGTH;
      const tipY = localSprite.y + uy * MainScene.GUN_BARREL_LENGTH;
      this.gunGraphics.setVisible(true);
      this.gunGraphics.clear();
      this.gunGraphics.lineStyle(MainScene.GUN_BARREL_THICKNESS, 0x3a3530, 1);
      this.gunGraphics.lineBetween(localSprite.x, localSprite.y, tipX, tipY);
      this.gunGraphics.lineStyle(2, 0x1a1816, 1);
      this.gunGraphics.lineBetween(localSprite.x, localSprite.y, tipX, tipY);
    } else if (this.gunGraphics) {
      this.gunGraphics.setVisible(false);
    }
    if (localPlayer && localSprite) {
      this.cameras.main.centerOn(localSprite.x, localSprite.y);
      const isZombie = localPlayer.isZombie;
      this.minimapCam.setVisible(isZombie);
      this.minimapBorder.setVisible(isZombie);
      this.fogSprite.setVisible(!isZombie);
      if (!isZombie) {
        this.fogSprite.setPosition(localSprite.x, localSprite.y);
      }
    } else if (players.length > 0) {
      this.cameras.main.centerOn(players[0].x, players[0].y);
    } else {
      this.cameras.main.centerOn(mapW / 2, mapH / 2);
    }
  }
}
