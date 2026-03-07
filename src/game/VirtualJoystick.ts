import Phaser from 'phaser';

const BASE_RADIUS = 60;
const KNOB_RADIUS = 25;
const DEPTH = 3000;
const BASE_ALPHA = 0.25;
const KNOB_ALPHA = 0.5;
const BASE_COLOR = 0x555555;
const KNOB_COLOR = 0xaaaaaa;
const DEAD_ZONE = 8;

function isTouchDevice(): boolean {
  return (
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
    (typeof window !== 'undefined' && 'ontouchstart' in window)
  );
}

export class VirtualJoystick {
  private scene: Phaser.Scene;
  private base: Phaser.GameObjects.Arc;
  private knob: Phaser.GameObjects.Arc;
  private maxKnobOffset: number;
  private active = false;
  private activePointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private dirX = 0;
  private dirY = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.maxKnobOffset = BASE_RADIUS - KNOB_RADIUS;

    this.base = scene.add.circle(0, 0, BASE_RADIUS, BASE_COLOR, BASE_ALPHA);
    this.base.setScrollFactor(0);
    this.base.setDepth(DEPTH);
    this.base.setVisible(false);

    this.knob = scene.add.circle(0, 0, KNOB_RADIUS, KNOB_COLOR, KNOB_ALPHA);
    this.knob.setScrollFactor(0);
    this.knob.setDepth(DEPTH + 1);
    this.knob.setVisible(false);

    this.excludeFromMinimap();
    this.bindEvents();
  }

  private excludeFromMinimap(): void {
    const cam = (this.scene as Phaser.Scene & { minimapCam?: Phaser.Cameras.Scene2D.Camera })
      .minimapCam;
    if (cam) {
      this.base.cameraFilter |= cam.id;
      this.knob.cameraFilter |= cam.id;
    }
  }

  /** Activation zone: bottom half of the screen, right half. */
  private isInBottomRight(ptr: Phaser.Input.Pointer): boolean {
    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
    return ptr.x > w * 0.5 && ptr.y > h * 0.5;
  }

  private bindEvents(): void {
    this.scene.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (this.active) return;
      if (!this.isInBottomRight(ptr)) return;

      this.active = true;
      this.activePointerId = ptr.id;
      this.originX = ptr.x;
      this.originY = ptr.y;

      this.base.setPosition(ptr.x, ptr.y);
      this.knob.setPosition(ptr.x, ptr.y);
      this.base.setVisible(true);
      this.knob.setVisible(true);
    });

    this.scene.input.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      if (!this.active || ptr.id !== this.activePointerId) return;
      this.updateFromPointer(ptr);
    });

    const release = (ptr: Phaser.Input.Pointer) => {
      if (!this.active || ptr.id !== this.activePointerId) return;
      this.active = false;
      this.activePointerId = null;
      this.dirX = 0;
      this.dirY = 0;
      this.base.setVisible(false);
      this.knob.setVisible(false);
    };

    this.scene.input.on('pointerup', release);
    this.scene.input.on('pointerupoutside', release);
  }

  private updateFromPointer(ptr: Phaser.Input.Pointer): void {
    let dx = ptr.x - this.originX;
    let dy = ptr.y - this.originY;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len < DEAD_ZONE) {
      this.dirX = 0;
      this.dirY = 0;
      this.knob.setPosition(this.originX, this.originY);
      return;
    }

    if (len > this.maxKnobOffset) {
      const s = this.maxKnobOffset / len;
      dx *= s;
      dy *= s;
    }

    this.knob.setPosition(this.originX + dx, this.originY + dy);
    this.dirX = dx / this.maxKnobOffset;
    this.dirY = dy / this.maxKnobOffset;
  }

  getDirX(): number {
    return this.dirX;
  }

  getDirY(): number {
    return this.dirY;
  }

  static isTouchDevice(): boolean {
    return isTouchDevice();
  }
}
