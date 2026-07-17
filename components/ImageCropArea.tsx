'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import StoredImage from './StoredImage';

export interface CropBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function createInitialCrop(width: number, height: number, aspect: number): CropBox {
    const imageAspect = width / height;
    const cropWidth = imageAspect > aspect ? height * aspect : width;
    const cropHeight = imageAspect > aspect ? height : width / aspect;
    return {
        x: (width - cropWidth) / 2,
        y: (height - cropHeight) / 2,
        width: cropWidth,
        height: cropHeight,
    };
}

interface CropAreaProps {
    imgRef: RefObject<HTMLImageElement | null>;
    src: string;
    natural: { w: number; h: number };
    crop: CropBox;
    aspect: number;
    hint: string;
    onChange: (next: CropBox) => void;
}

export function CropArea({ imgRef, src, natural, crop, aspect, hint, onChange }: CropAreaProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);

    const recompute = useCallback(() => {
        const el = imgRef.current;
        if (!el) return;
        setDisplaySize({ w: el.clientWidth, h: el.clientHeight });
    }, [imgRef]);

    useEffect(() => {
        recompute();
        window.addEventListener('resize', recompute);
        return () => window.removeEventListener('resize', recompute);
    }, [recompute]);

    const scale = displaySize ? displaySize.w / natural.w : 1;

    type DragMode =
        | { kind: 'move'; pointerId: number; offsetX: number; offsetY: number }
        | { kind: 'resize'; pointerId: number; anchorX: number; anchorY: number };
    const dragRef = useRef<DragMode | null>(null);

    const onPointerDownBox = (e: ReactPointerEvent) => {
        if (!displaySize) return;
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
        if (!displaySize) return;
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
        if (!mode || !container || !displaySize) return;
        if (e.pointerId !== mode.pointerId) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        if (mode.kind === 'move') {
            const newDisplayX = px - mode.offsetX;
            const newDisplayY = py - mode.offsetY;
            const widthPx = crop.width * scale;
            const heightPx = crop.height * scale;
            const clampedX = Math.max(0, Math.min(displaySize.w - widthPx, newDisplayX));
            const clampedY = Math.max(0, Math.min(displaySize.h - heightPx, newDisplayY));
            onChange({
                x: clampedX / scale,
                y: clampedY / scale,
                width: crop.width,
                height: crop.height,
            });
        } else {
            const anchorPxX = mode.anchorX * scale;
            const anchorPxY = mode.anchorY * scale;
            const dx = px - anchorPxX;
            const dy = py - anchorPxY;
            const maxWidthPx = Math.min(displaySize.w - anchorPxX, (displaySize.h - anchorPxY) * aspect);
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

    const boxStyle: CSSProperties = displaySize
        ? {
            position: 'absolute',
            left: crop.x * scale,
            top: crop.y * scale,
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
            <p style={hintStyle}>切り取り範囲をドラッグで移動、右下のハンドルでサイズ変更。{hint}</p>
            <div
                ref={containerRef}
                style={{
                    position: 'relative',
                    width: '100%',
                    background: 'var(--bg-tertiary)',
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
                    style={{ width: '100%', display: 'block', touchAction: 'none' }}
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

const hintStyle: CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    marginTop: '0.375rem',
};
