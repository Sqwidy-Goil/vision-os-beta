import { describe, expect, it } from 'vitest';
import { HandInteractionController } from '../src/tracking/handInteraction';

describe('hand interaction', () => {
  it('activates once on each pinch edge', () => {
    const controller = new HandInteractionController();
    expect(controller.update(100, 100, true, 0.016).activate).toBe(true);
    expect(controller.update(100, 100, true, 0.016).activate).toBe(false);
    expect(controller.update(100, 100, false, 0.016).activate).toBe(false);
    expect(controller.update(100, 100, true, 0.016).activate).toBe(true);
  });

  it('dwells only while the cursor is stable and fires once', () => {
    const controller = new HandInteractionController();
    expect(controller.update(100, 100, false, 0.5).activate).toBe(false);
    expect(controller.update(140, 100, false, 0.5).activate).toBe(false);
    expect(controller.update(140, 100, false, 0.5).activate).toBe(false);
    expect(controller.update(140, 100, false, 0.7).activate).toBe(true);
    expect(controller.update(140, 100, false, 0.7).activate).toBe(false);
  });
});
