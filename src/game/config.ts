import Phaser from 'phaser';
import { MainScene } from './scenes/MainScene';

/** Game size from container so camera/viewport match the visible area (avoids mobile mismatch). */
export function createGameConfig(
  parent: string,
  width?: number,
  height?: number
): Phaser.Types.Core.GameConfig {
  const w = width ?? window.innerWidth;
  const h = height ?? window.innerHeight;
  return {
    type: Phaser.AUTO,
    parent,
    width: w,
    height: h,
    backgroundColor: '#0f1f14',
    scene: [MainScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    input: {
      touch: true,
      activePointers: 3,
    },
  };
}
