/**
 * Transient view adjustment for the interactive game-mode avatar.
 *
 * The costume settings stored with the character stay untouched. Dragging and the
 * wheel only move a multiplier/offset on top of them, so a wrong gesture never
 * rewrites the saved framing.
 */
export type VrmViewAdjustment = {
    /** Multiplier applied on top of the costume framing scale. */
    scale: number;
    /** Horizontal offset in model-height units, added to the pivot position. */
    offsetX: number;
    /** Vertical offset in model-height units, added to the pivot position. */
    offsetY: number;
};

export type VrmTapSample = { at: number; x: number; y: number };

export const DEFAULT_VRM_VIEW_ADJUSTMENT: VrmViewAdjustment = { scale: 1, offsetX: 0, offsetY: 0 };

export const VRM_VIEW_SCALE_LIMIT = { min: 0.25, max: 4 } as const;
export const VRM_VIEW_OFFSET_LIMIT = 0.75;
/** Zoom per wheel unit. One 100-unit notch changes the scale by about 14%. */
export const VRM_WHEEL_ZOOM_SENSITIVITY = 0.0015;
const WHEEL_UNITS_PER_LINE = 16;
const WHEEL_UNITS_PER_PAGE = 100;
/** A second tap that lands close and quickly returns the avatar to the saved framing. */
export const VRM_RESET_TAP_MS = 320;
export const VRM_RESET_TAP_DISTANCE = 24;

function clampNumber(value: number, min: number, max: number, fallback: number): number {
    // Keep ±Infinity out of the scene while still clamping it to the intended bound.
    if (Number.isNaN(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

export function clampVrmViewAdjustment(adjustment: VrmViewAdjustment): VrmViewAdjustment {
    return {
        scale: clampNumber(adjustment.scale, VRM_VIEW_SCALE_LIMIT.min, VRM_VIEW_SCALE_LIMIT.max, DEFAULT_VRM_VIEW_ADJUSTMENT.scale),
        offsetX: clampNumber(adjustment.offsetX, -VRM_VIEW_OFFSET_LIMIT, VRM_VIEW_OFFSET_LIMIT, DEFAULT_VRM_VIEW_ADJUSTMENT.offsetX),
        offsetY: clampNumber(adjustment.offsetY, -VRM_VIEW_OFFSET_LIMIT, VRM_VIEW_OFFSET_LIMIT, DEFAULT_VRM_VIEW_ADJUSTMENT.offsetY),
    };
}

/**
 * World units per CSS pixel divided by the model height, so one world unit of
 * offset equals one model height. The camera is not scaled by the pivot, so a drag
 * keeps following the pointer at any zoom level.
 */
export function computeVrmPixelToOffset(
    { halfHeight, viewportHeight, modelHeight }: { halfHeight: number; viewportHeight: number; modelHeight: number },
): number {
    if (!(halfHeight > 0) || !(viewportHeight > 0) || !(modelHeight > 0)) return 0;
    return (2 * halfHeight) / (viewportHeight * modelHeight);
}

export function normalizeVrmWheelDelta(deltaY: number, deltaMode = 0): number {
    if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
    if (deltaMode === 1) return deltaY * WHEEL_UNITS_PER_LINE;
    if (deltaMode === 2) return deltaY * WHEEL_UNITS_PER_PAGE;
    return deltaY;
}

export function zoomVrmViewAdjustment(adjustment: VrmViewAdjustment, deltaY: number): VrmViewAdjustment {
    if (Number.isNaN(deltaY) || deltaY === 0) return clampVrmViewAdjustment(adjustment);
    const scale = adjustment.scale * Math.exp(-deltaY * VRM_WHEEL_ZOOM_SENSITIVITY);
    return clampVrmViewAdjustment({ ...adjustment, scale });
}

export function dragVrmViewAdjustment(
    adjustment: VrmViewAdjustment,
    { deltaX, deltaY, pixelToOffset }: { deltaX: number; deltaY: number; pixelToOffset: number },
): VrmViewAdjustment {
    const factor = Number.isFinite(pixelToOffset) ? pixelToOffset : 0;
    return clampVrmViewAdjustment({
        scale: adjustment.scale,
        offsetX: adjustment.offsetX + (Number.isFinite(deltaX) ? deltaX : 0) * factor,
        // Screen coordinates grow downward, the scene's do not.
        offsetY: adjustment.offsetY - (Number.isFinite(deltaY) ? deltaY : 0) * factor,
    });
}
export function isVrmResetTap(previous: VrmTapSample | null, next: VrmTapSample): boolean {
    if (!previous) return false;
    const elapsed = next.at - previous.at;
    if (!(elapsed >= 0) || elapsed > VRM_RESET_TAP_MS) return false;
    return Math.hypot(next.x - previous.x, next.y - previous.y) <= VRM_RESET_TAP_DISTANCE;
}
