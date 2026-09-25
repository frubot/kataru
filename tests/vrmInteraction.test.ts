import { describe, expect, test } from 'vitest';
import {
    clampVrmViewAdjustment,
    computeVrmPixelToOffset,
    DEFAULT_VRM_VIEW_ADJUSTMENT,
    dragVrmViewAdjustment,
    isVrmResetTap,
    normalizeVrmWheelDelta,
    pinchVrmViewAdjustment,
    rotateVrmViewAdjustment,
    VRM_ROTATE_DEGREES_PER_PIXEL,
    vrmViewZoom,
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

    test('shrinks the drag step with the camera zoom so the pointer keeps tracking', () => {
        // At 2x zoom one pixel covers half the world space, so the same drag
        // moves the offset half as far and the avatar stays under the pointer.
        const moved = dragVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, { deltaX: 250, deltaY: 0, pixelToOffset, zoom: 2 });
        expect(moved.offsetX).toBeCloseTo(125 * pixelToOffset, 10);
        const zoomedOut = dragVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, { deltaX: 100, deltaY: 0, pixelToOffset, zoom: 0.5 });
        expect(zoomedOut.offsetX).toBeCloseTo(200 * pixelToOffset, 10);
        // A broken zoom never moves the view.
        expect(dragVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, { deltaX: 10, deltaY: 10, pixelToOffset, zoom: 0 }))
            .toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
        expect(dragVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, { deltaX: 10, deltaY: 10, pixelToOffset, zoom: Number.NaN }))
            .toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
    });

    test('combines framing and gesture scales into a finite camera zoom', () => {
        expect(vrmViewZoom(1.5, { ...DEFAULT_VRM_VIEW_ADJUSTMENT, scale: 2 })).toBe(3);
        expect(vrmViewZoom(1, DEFAULT_VRM_VIEW_ADJUSTMENT)).toBe(1);
        // Corrupt values fall back to a neutral zoom instead of NaN/Infinity.
        expect(vrmViewZoom(0, DEFAULT_VRM_VIEW_ADJUSTMENT)).toBe(1);
        expect(vrmViewZoom(-2, DEFAULT_VRM_VIEW_ADJUSTMENT)).toBe(1);
        expect(vrmViewZoom(Number.NaN, DEFAULT_VRM_VIEW_ADJUSTMENT)).toBe(1);
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

    test('orbits the camera on the primary drag and wraps past the half turn', () => {
        const turned = rotateVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 90);
        expect(turned.rotation).toBeCloseTo(90 * VRM_ROTATE_DEGREES_PER_PIXEL, 10);
        // Rotating leaves the pan offsets alone, and dragging back unwinds the turn.
        expect(turned.offsetX).toBe(0);
        expect(rotateVrmViewAdjustment(turned, -90).rotation).toBeCloseTo(0, 10);
        // The angle stays inside (-180, 180] instead of growing without bound.
        expect(rotateVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 360 * 2 / VRM_ROTATE_DEGREES_PER_PIXEL).rotation).toBe(0);
        expect(rotateVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 400).rotation).toBeCloseTo(-160, 10);
        expect(rotateVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, Number.NaN))
            .toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
    });

    test('pinches zoom by the finger-spread ratio and clamps the extremes', () => {
        const zoomed = pinchVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 1.5);
        expect(zoomed.scale).toBeCloseTo(1.5, 10);
        expect(zoomed.offsetX).toBe(0);
        // Closing the fingers back by the same ratio cancels the zoom.
        expect(pinchVrmViewAdjustment(zoomed, 1 / 1.5).scale).toBeCloseTo(1, 10);
        expect(pinchVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 1e6).scale).toBe(VRM_VIEW_SCALE_LIMIT.max);
        expect(pinchVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 1e-6).scale).toBe(VRM_VIEW_SCALE_LIMIT.min);
        // Fingers landing on the same spot or a broken ratio change nothing.
        expect(pinchVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, 0)).toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
        expect(pinchVrmViewAdjustment(DEFAULT_VRM_VIEW_ADJUSTMENT, Number.NaN)).toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
    });

    test('keeps NaN fallbacks and clamped infinities out of the scene', () => {
        expect(clampVrmViewAdjustment({ scale: Number.NaN, offsetX: Number.NaN, offsetY: Number.NaN, rotation: Number.NaN }))
            .toEqual(DEFAULT_VRM_VIEW_ADJUSTMENT);
        expect(clampVrmViewAdjustment({
            scale: Number.POSITIVE_INFINITY,
            offsetX: Number.POSITIVE_INFINITY,
            offsetY: Number.NEGATIVE_INFINITY,
            rotation: Number.NaN,
        })).toEqual({ scale: VRM_VIEW_SCALE_LIMIT.max, offsetX: VRM_VIEW_OFFSET_LIMIT, offsetY: -VRM_VIEW_OFFSET_LIMIT, rotation: 0 });
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
