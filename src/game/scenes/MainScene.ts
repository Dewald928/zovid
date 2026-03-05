import Phaser from 'phaser';
import { getConnection, getGameState, getLocalIdentity } from '../stdbBridge';
import { VirtualJoystick } from '../VirtualJoystick';

const PLAYER_SIZE = 32;
const HUMAN_COLOR = 0x4488ff;
const ZOMBIE_COLOR = 0x44ff44;
const LOCAL_COLOR = 0xaa44ff;
const FOG_RADIUS = 400;
const LERP = 0.3;
const LOCAL_LERP = 0.5;
const LOCAL_SPEED = 200;
const LOCAL_ZOMBIE_SPEED = 140;
const ARENA_FILL = 0x1a3320;
const ARENA_BORDER = 0x2a5530;
const GRID_COLOR = 0x224428;
const GRID_SPACING = 200;
const DECOR_COLOR_1 = 0x1e3a24;
const DECOR_COLOR_2 = 0x162c1a;
const FOG_ALPHA = 0.95;

export class MainScene extends Phaser.Scene {
  private playerSprites!: Map<string, Phaser.GameObjects.Rectangle>;
  private fogSprite!: Phaser.GameObjects.Image;
  private arenaGraphics!: Phaser.GameObjects.Graphics;
  private minimapBorder!: Phaser.GameObjects.Graphics;
  private minimapCam!: Phaser.Cameras.Scene2D.Camera;
  private lastDirX = 0;
  private lastDirY = 0;
  private localIdentityHex: string | null = null;
  private lastMapW = 0;
  private lastMapH = 0;
  private joystick: VirtualJoystick | null = null;

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

  private drawMinimapBorder(x: number, y: number, size: number, pad: number): void {
    this.minimapBorder.clear();
    this.minimapBorder.lineStyle(2, 0xcc3333, 0.9);
    this.minimapBorder.strokeRect(x - pad, y - pad, size + pad * 2, size + pad * 2);
    this.minimapBorder.lineStyle(1, 0xff5555, 0.5);
    this.minimapBorder.strokeRect(x - pad - 1, y - pad - 1, size + pad * 2 + 2, size + pad * 2 + 2);
  }

  create(): void {
    this.playerSprites = new Map();
    const mapW = 2000;
    const mapH = 2000;

    this.cameras.main.setBounds(0, 0, mapW, mapH);
    this.cameras.main.setZoom(1);
    this.cameras.main.centerOn(mapW / 2, mapH / 2);

    this.arenaGraphics = this.add.graphics();
    this.arenaGraphics.setDepth(0);
    this.drawArena(this.arenaGraphics, mapW, mapH);
    this.lastMapW = mapW;
    this.lastMapH = mapH;

    const keys = this.input.keyboard!.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT') as Record<string, Phaser.Input.Keyboard.Key> & {
      W: Phaser.Input.Keyboard.Key;
      A: Phaser.Input.Keyboard.Key;
      S: Phaser.Input.Keyboard.Key;
      D: Phaser.Input.Keyboard.Key;
    };
    this.registry.set('moveKeys', keys);

    // Fog sprite: dark everywhere with gradient vision hole in center
    // Size it to cover the full screen even when camera is bounds-clamped
    const fogW = Math.max(this.scale.width, this.scale.height) * 2 + FOG_RADIUS * 2;
    const fogDim = Math.min(fogW, 6000);
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
    }
  }

  update(_time: number, _delta: number): void {
    this.localIdentityHex = getLocalIdentity();
    const conn = getConnection();
    const { players, config } = getGameState();

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

    const keys = this.registry.get('moveKeys') as Record<string, Phaser.Input.Keyboard.Key> & {
      W: Phaser.Input.Keyboard.Key;
      A: Phaser.Input.Keyboard.Key;
      S: Phaser.Input.Keyboard.Key;
      D: Phaser.Input.Keyboard.Key;
    };
    let dirX = 0;
    let dirY = 0;
    const k = keys as Record<string, Phaser.Input.Keyboard.Key | undefined>;
    if (keys.W?.isDown || k['UP']?.isDown) dirY -= 1;
    if (keys.S?.isDown || k['DOWN']?.isDown) dirY += 1;
    if (keys.A?.isDown || k['LEFT']?.isDown) dirX -= 1;
    if (keys.D?.isDown || k['RIGHT']?.isDown) dirX += 1;
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

    const dt = _delta / 1000;
    const seen = new Set<string>();
    const isLocal = (key: string) => key === this.localIdentityHex;

    for (const p of players) {
      const key = p.identity.toHexString();
      seen.add(key);
      let rect = this.playerSprites.get(key);
      if (!rect) {
        rect = this.add.rectangle(p.x, p.y, PLAYER_SIZE, PLAYER_SIZE, p.isZombie ? ZOMBIE_COLOR : HUMAN_COLOR);
        rect.setDepth(100);
        this.playerSprites.set(key, rect);
      }

      if (isLocal(key)) {
        const speed = p.isZombie ? LOCAL_ZOMBIE_SPEED : LOCAL_SPEED;
        const predX = rect.x + dirX * speed * dt;
        const predY = rect.y + dirY * speed * dt;
        const clampedX = Math.max(0, Math.min(mapW, predX));
        const clampedY = Math.max(0, Math.min(mapH, predY));
        rect.x = Phaser.Math.Linear(clampedX, p.x, LOCAL_LERP);
        rect.y = Phaser.Math.Linear(clampedY, p.y, LOCAL_LERP);
      } else {
        rect.x = Phaser.Math.Linear(rect.x, p.x, LERP);
        rect.y = Phaser.Math.Linear(rect.y, p.y, LERP);
      }
      const color = isLocal(key) ? LOCAL_COLOR : p.isZombie ? ZOMBIE_COLOR : HUMAN_COLOR;
      rect.setFillStyle(color);
    }
    for (const [key, rect] of this.playerSprites) {
      if (!seen.has(key)) {
        rect.destroy();
        this.playerSprites.delete(key);
      }
    }

    const localPlayer = this.localIdentityHex ? players.find((p) => p.identity.toHexString() === this.localIdentityHex) : null;
    const localSprite = this.localIdentityHex ? this.playerSprites.get(this.localIdentityHex) : null;
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
