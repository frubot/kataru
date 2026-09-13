import { describe, expect, test } from 'vitest';
import {
    clampVrmViewAdjustment,
    computeVrmPixelToOffset,
    DEFAULT_VRM_VIEW_ADJUSTMENT,
    dragVrmViewAdjustment,
    isVrmResetTap,
    normalizeVrmWheelDelta,
    VRM_VIEW_OFFSET_LIMIT,
    VRM_VIEW_SCALE_LIMIT,
    zoomVrmViewAdjustment,
} from '../lib/vrmInteraction';

const pixelToOffset = computeVrmPixelToOffset({ halfHeight: 1, viewportHeight: 500, modelHeight: 2 });

describe('VRM game-view interaction', () => {
    test('defines a stable pixel-to-model ratio from the fitted orthographic camera', () => {
        // 2 world units of visible height across 500px, divided by a 2-unit-tall model.
        expect(pixelToOffset).toBeCloseTo(2 / (500 * 2), 10);
        expect(computeVrmPixelToOffset({ halfHeight: 0, viewportHeight: 500, modelHeight: 2 })).toBe(0);
        expect(computeVrmPixelToOffset({ halfHeight: 1, viewportHeight: 0, modelHeight: 2 })).toBe(0);
        expect(computeVrmPixelToOffset({ halfHeight: 1, viewportHeight: 500, modelHeight: 0 })).toBe(0);
        expect(computeVrmPixelToOffset({ halfHeight: Number.NaN, viewportHeight: 500, modelHeight: 2 })).toBe(0);
    });

    test('moves the avatar exactly as far as the pointer travelled', () => {
        const moved = dragVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, { deltaX: 250, deltaY: 0, pixelToOffset });
        // 250px of drag equals 250px of world space, expressed in model-height units.
        expect(moved.offsetX).toBeCloseTo(250 * pixelToOffset, 10);
        expect(moved.offsetX * 2).toBeCloseTo(250 * pixelToOffset * 2, 10);
        expect(moved.scale).toBe(1);
        // Screen Y grows downward while the scene's Y grows upward.
        expect(dragVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, { deltaX: 0, deltaY: 50, pixelToOffset: 0.01 }).offsetY)
            .toBeCloseTo(-0.5, 10);
        // Dragging back to the start restores the original view.
        const returned = dragVrmViewAdjustment(moved, { deltaX: -250, deltaY: 0, pixelToOffset });
        expect(returned.offsetX).toBeCloseTo(0, 10);
    });

    test('keeps the saved framing independent from the transient offsets', () => {
        const framing = { scale: 1.2, offsetY: 0.1, rotation: 15 };
        const moved = dragVrmViewAdjustment({ ...DEFAULT_VRM_VIEW_ADJUSTMENT, offsetY: 0.2 }, {
            deltaX: 0,
            deltaY: 0,
            pixelToOffset,
        });
        expect(moved.offsetY).toBe(0.2);
        expect(framing).toEqual({ scale: 1.2, offsetY: 0.1, rotation: 15 });
    });

    test('clamps drags to the reachable area and ignores unusable deltas', () => {
        const dragged = dragVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, { deltaX: 10_000, deltaY: -10_000, pixelToOffset: 1 });
        expect(dragged.offsetX).toBe(VRM_VIEW_OFFSET_LIMIT);
        expect(dragged.offsetY).toBe(VRM_VIEW_OFFSET_LIMIT);
        expect(dragVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, { deltaX: 10, deltaY: 10, pixelToOffset: Number.NaN }))
            .toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
    });

    test('normalizes wheel deltas across delta modes', () => {
        expect(normalizeVrmWheelDelta(0)).toBe(0);
        expect(normalizeVrmWheelDelta(120)).toBe(120);
        expect(normalizeVrmWheelDelta(3, 1)).toBe(48);
        expect(normalizeVrmWheelDelta(1, 2)).toBe(100);
        expect(normalizeVrmWheelDelta(Number.NaN)).toBe(0);
    });

    test('zooms in when rolling forward and clamps the scale range', () => {
        const zoomedIn = zoomVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, -120);
        expect(zoomedIn.scale).toBeGreaterThan(1);
        const zoomedOut = zoomVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 120);
        expect(zoomedOut.scale).toBeLessThan(1);
        // Opposite notches cancel out.
        expect(zoomVrmViewAdjustment(zoomedIn, 120).scale).toBeCloseTo(1, 10);
        expect(zoomVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, -1e6).scale).toBe(VRM_VIEW_SCALE_LIMIT.max);
        expect(zoomVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 1e6).scale).toBe(VRM_VIEW_SCALE_LIMIT.min);
        expect(zoomVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 0)).toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
    });

    test('keeps NaN fallbacks and clamped infinities out of the scene', () => {
        expect(clampVrmViewAdjustment({ scale: Number.NaN, offsetX: Number.NaN, offsetY: Number.NaN }))
            .toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
        expect(clampVrmViewAdjustment({
            scale: Number.POSITIVE_INFINITY,
            offsetX: Number.POSITIVE_INFINITY,
            offsetY: Number.NEGATIVE_INFINITY,
        })).toEqual({ scale: VRM_VIEW_SCALE_LIMIT.max, offsetX: VRM_VIEW_OFFSET_LIMIT, offsetY: -VRM_VIEW_OFFSET_LIMIT });
    });

    test('detects a quick double tap but not a slow or distant second tap', () => {
        const start = { at: 1000, x: 100, y: 100 };
        expect(isVrmResetTap(null, start)).toBe(false);
        expect(isVrmResetTap(start, { at: 1100, x: 108, y: 106 })).toBe(true);
        expect(isVrmResetTap(start, { at: 1100, x: 400, y: 100 })).toBe(false);
        expect(isVrmResetTap(start, { at: 2000, x: 100, y: 100 })).toBe(false);
        expect(isVrmResetTap(start, { at: 900, x: 100, y: 100 })).toBe(false);
    });
});
