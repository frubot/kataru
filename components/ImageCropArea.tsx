import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import StoredImage from './StoredImage';

export interface CropBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Area (in original image coordinates) the crop box may occupy. */
interface CropBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Returns the initial crop box. With `allowOverflow`, an image narrower than
 * `aspect` starts with a box that contains the whole image.
 */
export function createInitialCrop(width: number, height: number, aspect: number, allowOverflow = false): CropBox {
    const imageAspect = width / height;
    if (allowOverflow && imageAspect < aspect) {
        return getCropBounds({ w: width, h: height }, aspect, true);
    }
    const cropWidth = imageAspect > aspect ? height * aspect : width;
    const cropHeight = imageAspect > aspect ? height : width / aspect;
    return {
        x: (width - cropWidth) / 2,
        y: (height - cropHeight) / 2,
        width: cropWidth,
        height: cropHeight,
    };
}

/**
 * Returns the area the crop box may occupy. With `allowOverflow`, an image
 * narrower than `aspect` gets transparent margins on the left and right so
 * the whole image fits inside one crop box.
 */
function getCropBounds(natural: { w: number; h: number }, aspect: number, allowOverflow: boolean): CropBounds {
    if (!allowOverflow || natural.w / natural.h >= aspect) {
        return { x: 0, y: 0, width: natural.w, height: natural.h };
    }
    const width = natural.h * aspect;
    return { x: (natural.w - width) / 2, y: 0, width, height: natural.h };
}

interface CropAreaProps {
    imgRef: RefObject<HTMLImageElement | null>;
    src: string;
    natural: { w: number; h: number };
    crop: CropBox;
    aspect: number;
    /** Lets the crop box extend past the left and right edges of the image. The outside area is saved as transparent. */
    allowOverflow?: boolean;
    onChange: (next: CropBox) => void;
}

const CHECKERBOARD_BACKGROUND = 'repeating-conic-gradient(var(--bg-tertiary) 0% 25%, var(--bg-secondary) 0% 50%) 0 0 / 16px 16px';

export function CropArea({ imgRef, src, natural, crop, aspect, allowOverflow = false, onChange }: CropAreaProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [displayWidth, setDisplayWidth] = useState<number | null>(null);
    const bounds = getCropBounds(natural, aspect, allowOverflow);

    const recompute = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        setDisplayWidth(el.clientWidth);
    }, []);

    useEffect(() => {
        recompute();
        window.addEventListener('resize', recompute);
        return () => window.removeEventListener('resize', recompute);
    }, [recompute]);

    // Display pixels per original image pixel.
    const scale = displayWidth ? displayWidth / bounds.width : 1;

    type DragMode =
        | { kind: 'move'; pointerId: number; offsetX: number; offsetY: number }
        | { kind: 'resize'; pointerId: number; anchorX: number; anchorY: number };
    const dragRef = useRef<DragMode | null>(null);

    const onPointerDownBox = (e: ReactPointerEvent) => {
        if (!displayWidth) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        dragRef.current = {
            kind: 'move',
            pointerId: e.pointerId,
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
        };
        attachWindowListeners();
    };

    const onPointerDownResize = (e: ReactPointerEvent) => {
        if (!displayWidth) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
            kind: 'resize',
            pointerId: e.pointerId,
            anchorX: crop.x,
            anchorY: crop.y,
        };
        attachWindowListeners();
    };

    const attachWindowListeners = () => {
        window.addEventListener('pointermove', onWindowPointerMove);
        window.addEventListener('pointerup', onWindowPointerUp);
        window.addEventListener('pointercancel', onWindowPointerUp);
    };

    const detachWindowListeners = () => {
        window.removeEventListener('pointermove', onWindowPointerMove);
        window.removeEventListener('pointerup', onWindowPointerUp);
        window.removeEventListener('pointercancel', onWindowPointerUp);
    };

    const onWindowPointerMove = (e: PointerEvent) => {
        const mode = dragRef.current;
        const container = containerRef.current;
        if (!mode || !container || !displayWidth) return;
        if (e.pointerId !== mode.pointerId) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        // Pointer position in display pixels, measured from the top-left of the bounds.
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const boundsWidthPx = bounds.width * scale;
        const boundsHeightPx = bounds.height * scale;
        if (mode.kind === 'move') {
            const widthPx = crop.width * scale;
            const heightPx = crop.height * scale;
            const clampedX = Math.max(0, Math.min(boundsWidthPx - widthPx, px - mode.offsetX));
            const clampedY = Math.max(0, Math.min(boundsHeightPx - heightPx, py - mode.offsetY));
            onChange({
                x: bounds.x + clampedX / scale,
                y: bounds.y + clampedY / scale,
                width: crop.width,
                height: crop.height,
            });
        } else {
            const anchorPxX = (mode.anchorX - bounds.x) * scale;
            const anchorPxY = (mode.anchorY - bounds.y) * scale;
            const dx = px - anchorPxX;
            const dy = py - anchorPxY;
            const maxWidthPx = Math.min(boundsWidthPx - anchorPxX, (boundsHeightPx - anchorPxY) * aspect);
            if (maxWidthPx <= 0) return;
            const minWidthPx = Math.min(maxWidthPx, Math.max(20, 20 * aspect));
            const rawWidthPx = Math.min(dx, dy * aspect);
            const widthPx = Math.min(Math.max(minWidthPx, rawWidthPx), maxWidthPx);
            onChange({
                x: mode.anchorX,
                y: mode.anchorY,
                width: widthPx / scale,
                height: (widthPx / aspect) / scale,
            });
        }
    };

    const onWindowPointerUp = (e: PointerEvent) => {
        const mode = dragRef.current;
        if (mode && e.pointerId !== mode.pointerId) return;
        dragRef.current = null;
        detachWindowListeners();
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => () => detachWindowListeners(), []);

    const hasOverflow = bounds.width !== natural.w || bounds.height !== natural.h;

    const boxStyle: CSSProperties = displayWidth
        ? {
            position: 'absolute',
            left: (crop.x - bounds.x) * scale,
            top: (crop.y - bounds.y) * scale,
            width: crop.width * scale,
            height: crop.height * scale,
            border: '2px solid var(--accent-primary)',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
            cursor: 'move',
            touchAction: 'none',
        }
        : { display: 'none' };

    return (
        <div>
            <div
                ref={containerRef}
                style={{
                    position: 'relative',
                    width: '100%',
                    aspectRatio: `${bounds.width} / ${bounds.height}`,
                    background: hasOverflow ? CHECKERBOARD_BACKGROUND : 'var(--bg-tertiary)',
                    borderRadius: 8,
                    overflow: 'hidden',
                    userSelect: 'none',
                    touchAction: 'none',
                }}
            >
                <StoredImage
                    ref={imgRef}
                    src={src}
                    alt="crop source"
                    onLoad={recompute}
                    draggable={false}
                    style={{
                        position: 'absolute',
                        left: `${(-bounds.x / bounds.width) * 100}%`,
                        top: `${(-bounds.y / bounds.height) * 100}%`,
                        width: `${(natural.w / bounds.width) * 100}%`,
                        height: `${(natural.h / bounds.height) * 100}%`,
                        display: 'block',
                        touchAction: 'none',
                    }}
                />
                <div style={boxStyle} onPointerDown={onPointerDownBox}>
                    <div
                        onPointerDown={onPointerDownResize}
                        style={{
                            position: 'absolute',
                            right: -2,
                            bottom: -2,
                            width: 32,
                            height: 32,
                            cursor: 'nwse-resize',
                            touchAction: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <div
                            style={{
                                width: 16,
                                height: 16,
                                background: 'var(--accent-primary)',
                                borderRadius: 4,
                            }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
