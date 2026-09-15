import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { RotateCcw } from 'lucide-react';
import type { VrmAvatar } from '@/lib/store/types';
import { resolveStoredImageUrl } from '@/lib/imageSource';
import { isVrmSource, resolveVrmExpression, validateVrmBuffer } from '@/lib/vrm';
import {
    computeVrmPixelToOffset,
    DEFAULT_VRM_VIEW_ADJUSTMENT,
    dragVrmViewAdjustment,
    isVrmResetTap,
    normalizeVrmWheelDelta,
    vrmViewZoom,
    zoomVrmViewAdjustment,
    type VrmTapSample,
    type VrmViewAdjustment,
} from '@/lib/vrmInteraction';
import { applyVrmRelaxedPose, createVrmIdleAnimation } from '@/lib/vrmPose';
import StoredImage from './StoredImage';

export type VrmPreview = { expressions: string[]; capture: () => string };
type Props = {
    avatar: VrmAvatar;
    expression?: string | null;
    fallbackImage?: string;
    name: string;
    /** Enables dragging and wheel zoom in the game view. The saved framing is never changed. */
    interactive?: boolean;
    onReady?: (preview: VrmPreview | null) => void;
};

type DragState = { pointerId: number; originX: number; originY: number; lastX: number; lastY: number; moved: boolean };

export default function VrmAvatarView({ avatar, expression, fallbackImage, name, interactive = false, onReady }: Props) {
    const host = useRef<HTMLDivElement>(null);
    const live = useRef({ avatar, expression, interactive, onReady, ready: false });
    useEffect(() => {
        live.current = { ...live.current, avatar, expression, interactive, onReady };
    }, [avatar, expression, interactive, onReady]);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [adjusted, setAdjusted] = useState(false);
    // Transient view state for the game mode: it layers on top of the saved framing.
    const view = useRef<{ pixelToOffset: number; adjustment: VrmViewAdjustment }>({
        pixelToOffset: 0,
        adjustment: { ...DEFAULT_VRM_VIEW_ADJUSTMENT },
    });
    const drag = useRef<DragState | null>(null);
    const lastTap = useRef<VrmTapSample | null>(null);
    const adjustedFlag = useRef(false);
    const syncAdjusted = () => {
        const adjustment = view.current.adjustment;
        const next = adjustment.scale !== DEFAULT_VRM_VIEW_ADJUSTMENT.scale
            || adjustment.offsetX !== DEFAULT_VRM_VIEW_ADJUSTMENT.offsetX
            || adjustment.offsetY !== DEFAULT_VRM_VIEW_ADJUSTMENT.offsetY;
        // Pointer moves fire continuously; only re-render when the reset button appears or goes away.
        if (next === adjustedFlag.current) return;
        adjustedFlag.current = next;
        setAdjusted(next);
    };
    const resetView = () => {
        view.current.adjustment = { ...DEFAULT_VRM_VIEW_ADJUSTMENT };
        lastTap.current = null;
        adjustedFlag.current = false;
        setAdjusted(false);
    };
    const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!live.current.interactive || !live.current.ready) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            moved: false,
        };
        setDragging(true);
    };
    const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - current.lastX;
        const deltaY = event.clientY - current.lastY;
        current.lastX = event.clientX;
        current.lastY = event.clientY;
        current.moved = current.moved
            || Math.hypot(event.clientX - current.originX, event.clientY - current.originY) > 4;
        const state = view.current;
        state.adjustment = dragVrmViewAdjustment(state.adjustment, {
            deltaX,
            deltaY,
            pixelToOffset: state.pixelToOffset,
            zoom: vrmViewZoom(live.current.avatar.framing.scale, state.adjustment),
        });
        if (current.moved) syncAdjusted();
    };
    const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        drag.current = null;
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        // A double tap/click restores the saved framing without opening the settings.
        if (current.moved) {
            lastTap.current = null;
            return;
        }
        const tap: VrmTapSample = {
            at: event.timeStamp || performance.now(),
            x: event.clientX,
            y: event.clientY,
        };
        if (isVrmResetTap(lastTap.current, tap)) resetView();
        else lastTap.current = tap;
    };

    useEffect(() => {
        const container = host.current;
        if (!container) return;
        let disposed = false;
        let renderer: THREE.WebGLRenderer | undefined;
        let vrm: VRM | undefined;
        let resize: ResizeObserver | undefined;
        let frame = 0;
        const abort = new AbortController();
        const scene = new THREE.Scene();
        live.current.ready = false;
        setStatus('loading');
        // A reloaded model can have new bounds, so start from the saved framing again.
        view.current.adjustment = { ...DEFAULT_VRM_VIEW_ADJUSTMENT };
        lastTap.current = null;
        drag.current = null;
        adjustedFlag.current = false;
        setAdjusted(false);
        live.current.onReady?.(null);

        const fail = (reason: unknown) => {
            if (disposed) return;
            cancelAnimationFrame(frame);
            setError(reason instanceof Error ? reason.message : '3Dモデルを表示できませんでした。');
            setStatus('error');
            live.current.onReady?.(null);
        };
        const contextLost = (event: Event) => {
            event.preventDefault();
            fail(new Error('3D描画が中断されました。再読み込みしてください。'));
        };
        void (async () => {
            try {
                if (!isVrmSource(avatar.source)) throw new Error('VRMの保存データが不正です。');
                const response = await fetch(resolveStoredImageUrl(avatar.source), { signal: abort.signal, credentials: 'same-origin' });
                if (!response.ok) throw new Error('保存したVRMを読み込めませんでした。');
                const buffer = await response.arrayBuffer();
                if (disposed) return;
                validateVrmBuffer(buffer);
                const manager = new THREE.LoadingManager();
                // GLTFLoader creates blob URLs for embedded textures only.
                manager.setURLModifier((url) => {
                    if (!url.startsWith('blob:')) throw new Error('外部リソースの読み込みはできません。');
                    return url;
                });
                const loader = new GLTFLoader(manager);
                loader.register((parser) => new VRMLoaderPlugin(parser));
                const gltf = await loader.parseAsync(buffer, '');
                const loaded = gltf.userData.vrm as VRM | undefined;
                if (disposed || !loaded) {
                    VRMUtils.deepDispose(gltf.scene);
                    if (!loaded && !disposed) throw new Error('VRMモデルが見つかりません。');
                    return;
                }
                vrm = loaded;
                VRMUtils.rotateVRM0(vrm);
                VRMUtils.removeUnnecessaryVertices(vrm.scene);
                VRMUtils.combineSkeletons(vrm.scene);
                VRMUtils.combineMorphs(vrm);
                vrm.scene.traverse((object) => { object.frustumCulled = false; });
                applyVrmRelaxedPose(vrm.humanoid);
                vrm.update(0);
                vrm.scene.updateMatrixWorld(true);
                const bounds = new THREE.Box3().setFromObject(vrm.scene);
                const size = bounds.getSize(new THREE.Vector3());
                const center = bounds.getCenter(new THREE.Vector3());
                if (!Number.isFinite(size.y) || size.y <= 0) throw new Error('モデルの大きさを取得できません。');
                vrm.scene.position.sub(center);
                scene.add(vrm.scene);
                scene.add(new THREE.HemisphereLight(0xffffff, 0x9295b0, 1));
                const light = new THREE.DirectionalLight(0xffffff, 2.5);
                light.position.set(1, 2, 3);
                scene.add(light);
                const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
                const cameraDistance = Math.max(size.y * 4, 5);
                camera.position.z = cameraDistance;
                renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
                renderer.setClearColor(0x000000, 0);
                renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
                renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
                renderer.domElement.addEventListener('webglcontextlost', contextLost);
                container.appendChild(renderer.domElement);
                const fit = () => {
                    if (!renderer) return;
                    const width = Math.max(container.clientWidth, 1);
                    const height = Math.max(container.clientHeight, 1);
                    renderer.setSize(width, height, false);
                    const aspect = width / height;
                    const halfHeight = Math.max(size.y * 0.55, size.x / aspect * 0.55);
                    camera.left = -halfHeight * aspect;
                    camera.right = halfHeight * aspect;
                    camera.top = halfHeight;
                    camera.bottom = -halfHeight;
                    camera.updateProjectionMatrix();
                    view.current.pixelToOffset = computeVrmPixelToOffset({
                        halfHeight,
                        viewportHeight: height,
                        modelHeight: size.y,
                    });
                };
                resize = new ResizeObserver(fit);
                resize.observe(container);
                fit();
                const expressions = Object.keys(vrm.expressionManager?.expressionMap ?? {});
                const animateIdle = createVrmIdleAnimation(vrm.humanoid);
                const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
                let previous = performance.now();
                let elapsed = 0;
                let blinkAt = 2.5;
                const render = (delta: number, neutral = false) => {
                    if (!vrm || !renderer) return;
                    const current = live.current;
                    const framing = current.avatar.framing;
                    const adjustment = view.current.adjustment;
                    // Spring bones integrate in world space, so moving, rotating or
                    // rescaling an ancestor of the model reads as a kick and the
                    // avatar keeps wobbling. Framing, zoom and pan therefore all
                    // live on the orthographic camera and never touch the rig.
                    const yaw = framing.rotation * Math.PI / 180;
                    const offsetX = adjustment.offsetX * size.y;
                    const offsetY = (framing.offsetY + adjustment.offsetY) * size.y;
                    camera.zoom = vrmViewZoom(framing.scale, adjustment);
                    camera.position.set(
                        -cameraDistance * Math.sin(yaw) - offsetX * Math.cos(yaw),
                        -offsetY,
                        cameraDistance * Math.cos(yaw) - offsetX * Math.sin(yaw),
                    );
                    camera.lookAt(
                        camera.position.x + Math.sin(yaw),
                        camera.position.y,
                        camera.position.z - Math.cos(yaw),
                    );
                    camera.updateProjectionMatrix();
                    const moving = !reduceMotion.matches && !neutral;
                    animateIdle(elapsed, moving);
                    const selected = neutral ? null : resolveVrmExpression(current.avatar, current.expression);
                    // Eyelids close in ~70ms and reopen over ~150ms; irregular
                    // spacing and the occasional double blink look less mechanical.
                    const blinkAge = elapsed - blinkAt;
                    const blink = moving && blinkAge >= 0
                        ? blinkAge < 0.07
                            ? Math.sin(blinkAge / 0.07 * Math.PI * 0.5)
                            : Math.cos(Math.min(blinkAge - 0.07, 0.15) / 0.15 * Math.PI * 0.5)
                        : 0;
                    if (blinkAge > 0.22) blinkAt = elapsed + (Math.random() < 0.18 ? 0.3 + Math.random() * 0.2 : 2 + Math.random() * 4);
                    for (const key of expressions) {
                        const target = key === selected ? 1 : key === 'blink' ? blink : 0;
                        const value = vrm.expressionManager?.getValue(key) ?? 0;
                        vrm.expressionManager?.setValue(key, neutral || key === 'blink' ? target : THREE.MathUtils.lerp(value, target, 1 - Math.exp(-delta * 12)));
                    }
                    vrm.update(delta);
                    renderer.render(scene, camera);
                };
                render(0);
                live.current.ready = true;
                setStatus('ready');
                live.current.onReady?.({ expressions, capture: () => {
                    if (disposed || !renderer) throw new Error('プレビューを読み直してください。');
                    render(0, true);
                    const thumbnail = document.createElement('canvas');
                    thumbnail.width = 400;
                    thumbnail.height = 600;
                    thumbnail.getContext('2d')!.drawImage(renderer.domElement, 0, 0, 400, 600);
                    return thumbnail.toDataURL('image/png');
                } });
                const tick = (now: number) => {
                    if (disposed) return;
                    frame = requestAnimationFrame(tick);
                    if (now - previous < 1000 / 30) return;
                    const delta = Math.min((now - previous) / 1000, 0.05);
                    previous = now;
                    if (document.hidden) return;
                    elapsed += delta;
                    try { render(delta); } catch (reason) { fail(reason); }
                };
                frame = requestAnimationFrame(tick);
            } catch (reason) { fail(reason); }
        })();
        return () => {
            disposed = true;
            abort.abort();
            cancelAnimationFrame(frame);
            resize?.disconnect();
            live.current.onReady?.(null);
            if (vrm) VRMUtils.deepDispose(vrm.scene);
            if (renderer) {
                renderer.domElement.removeEventListener('webglcontextlost', contextLost);
                renderer.dispose();
                renderer.forceContextLoss();
                renderer.domElement.remove();
            }
        };
    }, [avatar.source, attempt]);

    // Wheel zoom is registered imperatively: React attaches wheel listeners as passive,
    // so preventDefault would not stop the surrounding page from scrolling.
    useEffect(() => {
        const container = host.current;
        if (!container || !interactive) return;
        const handleWheel = (event: WheelEvent) => {
            const delta = normalizeVrmWheelDelta(event.deltaY, event.deltaMode);
            if (delta === 0) return;
            event.preventDefault();
            const state = view.current;
            state.adjustment = zoomVrmViewAdjustment(state.adjustment, delta);
            syncAdjusted();
        };
        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, [interactive]);

    const showReset = interactive && status === 'ready' && adjusted;
    return <div
        className={`vrm-avatar${interactive ? ' vrm-avatar-interactive' : ''}${dragging ? ' vrm-avatar-dragging' : ''}`}
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerUp={interactive ? handlePointerEnd : undefined}
        onPointerCancel={interactive ? handlePointerEnd : undefined}
    >
        <div
            ref={host}
            className="vrm-canvas"
            role="img"
            aria-label={interactive ? `${name}の3Dアバター。ドラッグで移動、ホイールで拡大縮小できます。` : `${name}の3Dアバター`}
            style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }}
        />
        {showReset && <button
            type="button"
            className="vrm-view-reset"
            title="表示位置と拡大率を戻す"
            aria-label="表示位置と拡大率を戻す"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={resetView}
        >
            <RotateCcw size={14} />
        </button>}
        {status !== 'ready' && <div className="vrm-fallback">
            {fallbackImage && <StoredImage src={fallbackImage} alt="" />}
            <div className="vrm-status" role="status">
                {status === 'loading' ? '3Dモデルを読み込み中…' : <>{error}<button type="button" className="btn btn-secondary" onClick={() => setAttempt((value) => value + 1)}>再読み込み</button></>}
            </div>
        </div>}
    </div>;
}
