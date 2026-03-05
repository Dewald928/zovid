import Phaser from 'phaser';
import { getConnection, getGameState, getLocalIdentity } from '../stdbBridge';

const PLAYER_SIZE = 32;
const HUMAN_COLOR = 0x4488ff;
const ZOMBIE_COLOR = 0x44ff44;
const FOG_RADIUS = 400;
const LERP = 0.2;
const ARENA_FILL = 0x303068;
const ARENA_BORDER = 0x5050a0;
const FOG_SIZE = 3000;

export class MainScene extends Phaser.Scene {
  private playerSprites!: Map<string, Phaser.GameObjects.Rectangle>;
  private fogSprite!: Phaser.GameObjects.Image;
  private arenaGraphics!: Phaser.GameObjects.Graphics;
  private minimapCam!: Phaser.Cameras.Scene2D.Camera;
  private lastDirX = 0;
  private lastDirY = 0;
  private localIdentityHex: string | null = null;
  private lastMapW = 0;
  private lastMapH = 0;

  constructor() {
    super({ key: 'MainScene' });
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
    this.arenaGraphics.fillStyle(ARENA_FILL, 1);
    this.arenaGraphics.fillRect(0, 0, mapW, mapH);
    this.arenaGraphics.lineStyle(4, ARENA_BORDER, 1);
    this.arenaGraphics.strokeRect(0, 0, mapW, mapH);
    this.lastMapW = mapW;
    this.lastMapH = mapH;

    const keys = this.input.keyboard!.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT') as Record<string, Phaser.Input.Keyboard.Key> & {
      W: Phaser.Input.Keyboard.Key;
      A: Phaser.Input.Keyboard.Key;
      S: Phaser.Input.Keyboard.Key;
      D: Phaser.Input.Keyboard.Key;
    };
    this.registry.set('moveKeys', keys);

    // Generate fog texture: dark everywhere with a gradient transparent hole in center
    const fogTex = this.textures.createCanvas('fogTex', FOG_SIZE, FOG_SIZE);
    const ctx = fogTex!.getContext();
    const cx = FOG_SIZE / 2;
    const cy = FOG_SIZE / 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.95)';
    ctx.fillRect(0, 0, FOG_SIZE, FOG_SIZE);

    ctx.globalCompositeOperation = 'destination-out';
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, FOG_RADIUS);
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(0.3, 'rgba(0, 0, 0, 0.98)');
    grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.7)');
    grad.addColorStop(0.75, 'rgba(0, 0, 0, 0.25)');
    grad.addColorStop(0.9, 'rgba(0, 0, 0, 0.05)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, FOG_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
    fogTex!.refresh();

    this.fogSprite = this.add.image(0, 0, 'fogTex');
    this.fogSprite.setDepth(1000);
    this.fogSprite.setVisible(false);

    this.minimapCam = this.cameras.add(this.scale.width - 210, 10, 200, 150);
    this.minimapCam.setBackgroundColor('rgba(0, 0, 0, 0.6)');
    this.minimapCam.centerOn(mapW / 2, mapH / 2);
    this.minimapCam.setZoom(Math.min(200 / mapW, 150 / mapH));
    this.minimapCam.setVisible(false);

    // Hide fog sprite from minimap
    this.fogSprite.cameraFilter |= this.minimapCam.id;
  }

  update(_time: number, _delta: number): void {
    this.localIdentityHex = getLocalIdentity();
    const conn = getConnection();
    const { players, config } = getGameState();

    const mapW = config?.mapWidth ?? 2000;
    const mapH = config?.mapHeight ?? 2000;
    this.cameras.main.setBounds(0, 0, mapW, mapH);
    this.minimapCam.setBounds(0, 0, mapW, mapH);
    this.minimapCam.centerOn(mapW / 2, mapH / 2);
    this.minimapCam.setZoom(Math.min(200 / mapW, 150 / mapH));
    this.minimapCam.setPosition(this.scale.width - 210, 10);

    if (mapW !== this.lastMapW || mapH !== this.lastMapH) {
      this.lastMapW = mapW;
      this.lastMapH = mapH;
      this.arenaGraphics.clear();
      this.arenaGraphics.fillStyle(ARENA_FILL, 1);
      this.arenaGraphics.fillRect(0, 0, mapW, mapH);
      this.arenaGraphics.lineStyle(4, ARENA_BORDER, 1);
      this.arenaGraphics.strokeRect(0, 0, mapW, mapH);
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
    if (dirX !== this.lastDirX || dirY !== this.lastDirY) {
      this.lastDirX = dirX;
      this.lastDirY = dirY;
      if (conn) {
        conn.reducers.setInput({ dirX, dirY });
      }
    }

    const seen = new Set<string>();
    for (const p of players) {
      const key = p.identity.toHexString();
      seen.add(key);
      let rect = this.playerSprites.get(key);
      if (!rect) {
        rect = this.add.rectangle(p.x, p.y, PLAYER_SIZE, PLAYER_SIZE, p.isZombie ? ZOMBIE_COLOR : HUMAN_COLOR);
        rect.setDepth(100);
        this.playerSprites.set(key, rect);
      }
      rect.x = Phaser.Math.Linear(rect.x, p.x, LERP);
      rect.y = Phaser.Math.Linear(rect.y, p.y, LERP);
      rect.setFillStyle(p.isZombie ? ZOMBIE_COLOR : HUMAN_COLOR);
    }
    for (const [key, rect] of this.playerSprites) {
      if (!seen.has(key)) {
        rect.destroy();
        this.playerSprites.delete(key);
      }
    }

    const localPlayer = this.localIdentityHex ? players.find((p) => p.identity.toHexString() === this.localIdentityHex) : null;
    if (localPlayer) {
      this.cameras.main.centerOn(localPlayer.x, localPlayer.y);
      const isZombie = localPlayer.isZombie;
      this.minimapCam.setVisible(isZombie);
      this.fogSprite.setVisible(!isZombie);
      if (!isZombie) {
        this.fogSprite.setPosition(localPlayer.x, localPlayer.y);
      }
    } else if (players.length > 0) {
      this.cameras.main.centerOn(players[0].x, players[0].y);
    } else {
      this.cameras.main.centerOn(mapW / 2, mapH / 2);
    }
  }
}
