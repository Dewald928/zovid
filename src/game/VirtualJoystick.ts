import Phaser from 'phaser';

const BASE_RADIUS = 60;
const KNOB_RADIUS = 25;
const INSET = 80;
const DEPTH = 3000;
const BASE_ALPHA = 0.4;
const KNOB_ALPHA = 0.7;
const BASE_COLOR = 0x333333;
const KNOB_COLOR = 0x888888;

function isTouchDevice(): boolean {
  return (
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
    (typeof window !== 'undefined' && 'ontouchstart' in window)
  );
}

export class VirtualJoystick {
  private scene: Phaser.Scene;
  private base!: Phaser.GameObjects.Arc;
  private knob!: Phaser.GameObjects.Arc;
  private centerX: number;
  private centerY: number;
  private maxKnobOffset: number;
  private active = false;
  private activePointerId: number | null = null;
  private dirX = 0;
  private dirY = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.maxKnobOffset = BASE_RADIUS - KNOB_RADIUS;
    this.centerX = INSET;
    this.centerY = scene.scale.height - INSET;

    this.create();
  }

  private create(): void {
    this.base = this.scene.add.circle(
      this.centerX,
      this.centerY,
      BASE_RADIUS,
      BASE_COLOR,
      BASE_ALPHA
    );
    this.base.setScrollFactor(0);
    this.base.setDepth(DEPTH);
    this.base.setInteractive(
      new Phaser.Geom.Circle(this.centerX, this.centerY, BASE_RADIUS),
      Phaser.Geom.Circle.Contains
    );

    this.knob = this.scene.add.circle(
      this.centerX,
      this.centerY,
      KNOB_RADIUS,
      KNOB_COLOR,
      KNOB_ALPHA
    );
    this.knob.setScrollFactor(0);
    this.knob.setDepth(DEPTH + 1);

    const minimapCamId = (this.scene as Phaser.Scene & { minimapCam?: Phaser.Cameras.Scene2D.Camera })
      .minimapCam?.id;
    if (minimapCamId != null) {
      this.base.cameraFilter |= minimapCamId;
      this.knob.cameraFilter |= minimapCamId;
    }

    this.base.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      this.active = true;
      this.activePointerId = ptr.id;
      this.updateFromPointer(ptr);
    });

    this.scene.input.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      if (this.active && ptr.id === this.activePointerId) {
        this.updateFromPointer(ptr);
      }
    });

    this.scene.input.on('pointerup', (ptr: Phaser.Input.Pointer) => {
      if (this.active && ptr.id === this.activePointerId) {
        this.active = false;
        this.activePointerId = null;
        this.dirX = 0;
        this.dirY = 0;
        this.knob.setPosition(this.centerX, this.centerY);
      }
    });
  }

  private updateFromPointer(ptr: Phaser.Input.Pointer): void {
    let dx = ptr.x - this.centerX;
    let dy = ptr.y - this.centerY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > this.maxKnobOffset) {
      const scale = this.maxKnobOffset / len;
      dx *= scale;
      dy *= scale;
    }
    this.knob.setPosition(this.centerX + dx, this.centerY + dy);
    this.dirX = len > 0 ? dx / this.maxKnobOffset : 0;
    this.dirY = len > 0 ? dy / this.maxKnobOffset : 0;
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

  setVisible(visible: boolean): void {
    this.base.setVisible(visible);
    this.knob.setVisible(visible);
  }
}
