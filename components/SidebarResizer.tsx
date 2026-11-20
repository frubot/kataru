import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import {
    SIDEBAR_WIDTH_DEFAULT,
    SIDEBAR_WIDTH_KEYBOARD_STEP,
    SIDEBAR_WIDTH_MAX,
    SIDEBAR_WIDTH_MIN,
    clampSidebarWidth,
} from '@/lib/sidebarWidth';

interface SidebarResizerProps {
    width: number;
    /** ドラッグ中に `--sidebar-width` を直接書き換える要素。 */
    layoutRef: RefObject<HTMLElement | null>;
    onResize: (width: number) => void;
    onResizeStart: () => void;
    onResizeEnd: (width: number) => void;
}

type DragState = { pointerId: number; startX: number; startWidth: number; width: number; frame: number | null };

export default function SidebarResizer({ width, layoutRef, onResize, onResizeStart, onResizeEnd }: SidebarResizerProps) {
    const dragRef = useRef<DragState | null>(null);

    useEffect(() => () => {
        const frame = dragRef.current?.frame;
        if (frame != null) cancelAnimationFrame(frame);
    }, []);

    // ドラッグ中はReactの再描画を避け、1フレームに1回だけCSS変数を更新する。
    const applyWidth = (drag: DragState) => {
        drag.frame = null;
        layoutRef.current?.style.setProperty('--sidebar-width', `${drag.width}px`);
    };

    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width, frame: null };
        onResizeStart();
    };

    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const next = clampSidebarWidth(drag.startWidth + event.clientX - drag.startX);
        if (next === drag.width) return;
        drag.width = next;
        if (drag.frame == null) drag.frame = requestAnimationFrame(() => applyWidth(drag));
    };

    const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        if (drag.frame != null) cancelAnimationFrame(drag.frame);
        applyWidth(drag);
        // 開閉用のtransitionが戻る前に最終幅を確定させる。
        layoutRef.current?.getBoundingClientRect();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        onResizeEnd(drag.width);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        let next: number | null = null;
        if (event.key === 'ArrowLeft') next = width - SIDEBAR_WIDTH_KEYBOARD_STEP;
        else if (event.key === 'ArrowRight') next = width + SIDEBAR_WIDTH_KEYBOARD_STEP;
        else if (event.key === 'Home') next = SIDEBAR_WIDTH_MIN;
        else if (event.key === 'End') next = SIDEBAR_WIDTH_MAX;
        if (next === null) return;
        event.preventDefault();
        const clamped = clampSidebarWidth(next);
        onResize(clamped);
        onResizeEnd(clamped);
    };

    return (
        <div
            className="sidebar-resizer desktop-only"
            role="separator"
            aria-orientation="vertical"
            aria-label="サイドバーの幅"
            aria-valuemin={SIDEBAR_WIDTH_MIN}
            aria-valuemax={SIDEBAR_WIDTH_MAX}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onDoubleClick={() => {
                onResize(SIDEBAR_WIDTH_DEFAULT);
                onResizeEnd(SIDEBAR_WIDTH_DEFAULT);
            }}
            onKeyDown={handleKeyDown}
        />
    );
}
