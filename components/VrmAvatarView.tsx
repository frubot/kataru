import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
    createVRMAnimationClip,
    VRMAnimationLoaderPlugin,
    VRMLookAtQuaternionProxy,
    type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import { Eye, RotateCcw } from 'lucide-react';
import type { VrmAnimation, VrmAvatar } from '@/lib/store/types';
import { resolveStoredImageUrl } from '@/lib/imageSource';
import { isVrmSource, isVrmaSource, resolveVrmExpression, validateVrmBuffer, validateVrmaBuffer } from '@/lib/vrm';
import {
    computeVrmPixelToOffset,
    DEFAULT_VRM_VIEW_ADJUSTMENT,
    dragVrmViewAdjustment,
    isVrmResetTap,
    normalizeVrmWheelDelta,
    pinchVrmViewAdjustment,
    rotateVrmViewAdjustment,
    vrmViewZoom,
    zoomVrmViewAdjustment,
    type VrmTapSample,
    type VrmViewAdjustment,
} from '@/lib/vrmInteraction';
import { applyVrmRelaxedPose, createVrmIdleAnimation } from '@/lib/vrmPose';
import { getTtsAudioLevel } from '@/lib/ttsPlayer';
import StoredImage from './StoredImage';

export type VrmPreview = {
    expressions: string[];
    capture: (mode?: 'portrait' | 'avatar') => string;
    /** Per-animation load result so editors can warn about clips that failed. */
    motions: { name: string; error: string | null }[];
};
type Props = {
    avatar: VrmAvatar;
    expression?: string | null;
    /** Fires the named motion once every time the nonce changes. */
    motion?: { name: string; nonce: string } | null;
    fallbackImage?: string;
    name: string;
    /** Enables dragging and wheel zoom in the game view. The saved framing is never changed. */
    interactive?: boolean;
    /** Moves the mouth with the shared TTS playback volume. */
    lipSync?: boolean;
    onReady?: (preview: VrmPreview | null) => void;
};

type DragState = {
    /** Mouse drags orbit or pan by button; a touch gesture pans with one finger and orbits+zooms with two. */
    mode: 'rotate' | 'pan';
    touch: boolean;
    pointers: Map<number, { x: number; y: number }>;
    /** Finger spread from the last move; the ratio against it drives pinch zoom. */
    pinchDistance: number;
    originX: number;
    originY: number;
    moved: boolean;
    /** A second finger joined, so the gesture can no longer count as a tap. */
    multiTouch: boolean;
};

/** A VRMA clip bound to the mixer with the playback metadata it was loaded with. */
type LoadedVrmMotion = {
    action: THREE.AnimationAction;
    /** Expression keys the clip owns while it plays (useExpressions clips only). */
    expressions: Set<string>;
    loop: boolean;
};

export default function VrmAvatarView({ avatar, expression, motion, fallbackImage, name, interactive = false, lipSync = false, onReady }: Props) {
    const host = useRef<HTMLDivElement>(null);
    const [lookAtCamera, setLookAtCamera] = useState(false);
    const live = useRef({ avatar, expression, motion, interactive, lipSync, lookAtCamera, onReady, ready: false });
    useEffect(() => {
        live.current = { ...live.current, avatar, expression, motion, interactive, lipSync, lookAtCamera, onReady };
    }, [avatar, expression, motion, interactive, lipSync, lookAtCamera, onReady]);
    // loop/useExpressions bake into the clip at load, so they join the reload
    // key; only idleAnimation is read live each frame.
    const animationKey = useMemo(
        () => (avatar.animations ?? []).map((animation) => `${animation.name}\n${animation.source}\n${animation.loop === true}\n${animation.useExpressions === true}`).join('\n'),
        [avatar.animations],
    );
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [canGaze, setCanGaze] = useState(false);
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
            || adjustment.offsetY !== DEFAULT_VRM_VIEW_ADJUSTMENT.offsetY
            || adjustment.rotation !== DEFAULT_VRM_VIEW_ADJUSTMENT.rotation;
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
    const fingerSpread = (pointers: DragState['pointers']) => {
        const [a, b] = [...pointers.values()];
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!live.current.interactive || !live.current.ready) return;
        if (event.pointerType === 'mouse') {
            // Left button orbits the avatar; the right button pans it.
            if (drag.current) return;
            const mode = event.button === 0 ? 'rotate' : event.button === 2 ? 'pan' : null;
            if (mode === null) return;
            drag.current = {
                mode,
                touch: false,
                pointers: new Map([[event.pointerId, { x: event.clientX, y: event.clientY }]]),
                pinchDistance: 0,
                originX: event.clientX,
                originY: event.clientY,
                moved: false,
                multiTouch: false,
            };
        } else {
            // Touch: one finger pans; a second finger turns the drag into orbit + pinch.
            if (drag.current && !drag.current.touch) return;
            const current = drag.current ??= {
                mode: 'pan',
                touch: true,
                pointers: new Map(),
                pinchDistance: 0,
                originX: event.clientX,
                originY: event.clientY,
                moved: false,
                multiTouch: false,
            };
            if (current.pointers.size >= 2) return;
            current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (current.pointers.size === 2) {
                current.multiTouch = true;
                current.pinchDistance = fingerSpread(current.pointers);
            }
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
    };
    const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        const point = current?.pointers.get(event.pointerId);
        if (!current || !point) return;
        const deltaX = event.clientX - point.x;
        const deltaY = event.clientY - point.y;
        point.x = event.clientX;
        point.y = event.clientY;
        current.moved = current.moved
            || Math.hypot(event.clientX - current.originX, event.clientY - current.originY) > 4;
        const state = view.current;
        if (current.pointers.size === 2) {
            // Two fingers work like a turntable: the pair's sideways drift orbits
            // the avatar and the changing spread zooms.
            state.adjustment = rotateVrmViewAdjustment(state.adjustment, deltaX / 2);
            const spread = fingerSpread(current.pointers);
            if (current.pinchDistance > 0 && spread > 0) {
                state.adjustment = pinchVrmViewAdjustment(state.adjustment, spread / current.pinchDistance);
            }
            current.pinchDistance = spread;
        } else if (current.mode === 'pan') {
            state.adjustment = dragVrmViewAdjustment(state.adjustment, {
                deltaX,
                deltaY,
                pixelToOffset: state.pixelToOffset,
                zoom: vrmViewZoom(live.current.avatar.framing.scale, state.adjustment),
            });
        } else {
            state.adjustment = rotateVrmViewAdjustment(state.adjustment, deltaX);
        }
        if (current.moved) syncAdjusted();
    };
    const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = drag.current;
        if (!current || !current.pointers.delete(event.pointerId)) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (current.pointers.size > 0) {
            // A finger stays down after a two-finger gesture: panning resumes from
            // where that finger rests and the next pinch measures from scratch.
            current.pinchDistance = 0;
            const [remaining] = current.pointers.values();
            current.originX = remaining.x;
            current.originY = remaining.y;
            return;
        }
        drag.current = null;
        setDragging(false);
        // A double tap/click restores the saved framing without opening the settings.
        // Only a primary gesture (left button or a lone finger) can count as a tap.
        if (current.moved || current.multiTouch || (!current.touch && current.mode !== 'rotate')) {
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
        let mixer: THREE.AnimationMixer | undefined;
        let vrm: VRM | undefined;
        let resize: ResizeObserver | undefined;
        let frame = 0;
        const abort = new AbortController();
        const scene = new THREE.Scene();
        live.current.ready = false;
        setStatus('loading');
        setCanGaze(false);
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
                // VRMA files parse through the same loader; this plugin only
                // reacts to the VRMC_vrm_animation extension.
                loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
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
                const animationMixer = new THREE.AnimationMixer(vrm.scene);
                mixer = animationMixer;
                // Clips steer the gaze through this proxy; createVRMAnimationClip
                // binds to it by name, so it must exist before any clip is made.
                const lookAtProxy = vrm.lookAt ? new VRMLookAtQuaternionProxy(vrm.lookAt) : null;
                if (lookAtProxy) {
                    lookAtProxy.name = 'VRMLookAtQuaternionProxy';
                    vrm.scene.add(lookAtProxy);
                }
                const motions = new Map<string, LoadedVrmMotion>();
                const seenMotionNames = new Set<string>();
                const loadMotion = async (animation: VrmAnimation): Promise<{ name: string; error: string | null }> => {
                    const key = animation.name.trim().toLowerCase();
                    try {
                        if (!key) throw new Error('モーション名が設定されていません。');
                        if (seenMotionNames.has(key)) throw new Error(`モーション名「${animation.name}」が重複しています。`);
                        seenMotionNames.add(key);
                        if (!isVrmaSource(animation.source)) throw new Error('VRMAの保存データが不正です。');
                        const response = await fetch(resolveStoredImageUrl(animation.source), { signal: abort.signal, credentials: 'same-origin' });
                        if (!response.ok) throw new Error('保存したVRMAを読み込めませんでした。');
                        const buffer = await response.arrayBuffer();
                        if (disposed) return { name: animation.name, error: null };
                        validateVrmaBuffer(buffer);
                        const gltf = await loader.parseAsync(buffer, '');
                        // The clip retargets onto our model; the VRMA scene itself is dead weight.
                        VRMUtils.deepDispose(gltf.scene);
                        if (disposed || !vrm) return { name: animation.name, error: null };
                        const vrmAnimation = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0];
                        if (!vrmAnimation) throw new Error('VRMAにモーションが含まれていません。');
                        const clip = createVRMAnimationClip(vrmAnimation, vrm);
                        clip.name = animation.name;
                        const driven = new Set<string>();
                        clip.tracks = clip.tracks.filter((track) => {
                            const expressionKey = /^VRMExpression_(.+)\.weight$/.exec(track.name)?.[1];
                            if (!expressionKey) return true;
                            if (animation.useExpressions) {
                                driven.add(expressionKey);
                                return true;
                            }
                            return false;
                        });
                        if (clip.tracks.length === 0) throw new Error('このモデルに対応するボーンがありません。');
                        motions.set(key, { action: animationMixer.clipAction(clip), expressions: driven, loop: animation.loop === true });
                        return { name: animation.name, error: null };
                    } catch (reason) {
                        return { name: animation.name, error: reason instanceof Error ? reason.message : 'VRMAを読み込めませんでした。' };
                    }
                };
                // The fetches overlap the synchronous renderer setup below and
                // are awaited before the component reports ready.
                const motionResults = Promise.all((live.current.avatar.animations ?? []).map(loadMotion));
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
                // 'aa' is the normalized VRM 1.0 preset; a stray 'a' covers
                // models whose viseme was not normalized.
                const mouthKey = expressions.find((key) => /^(aa|a)$/i.test(key)) ?? null;
                let mouthLevel = 0;
                const animateIdle = createVrmIdleAnimation(vrm.humanoid);
                const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
                const motionList = await motionResults;
                if (disposed) return;
                // Playback arbitration: at most one idle clip and one fired
                // one-shot are live; `retiring` holds actions fading to a stop.
                let idle: { action: THREE.AnimationAction; entry: LoadedVrmMotion } | null = null;
                let oneshot: { action: THREE.AnimationAction; entry: LoadedVrmMotion; stopping: boolean } | null = null;
                let lastNonce: string | undefined;
                let suspended = false;
                const retiring = new Set<THREE.AnimationAction>();
                animationMixer.addEventListener('finished', ({ action }) => {
                    // A finished one-shot parks on its last frame
                    // (clampWhenFinished); dissolve it, then the idle resumes
                    // once the retiring sweep stops the action.
                    if (oneshot && action === oneshot.action && !oneshot.stopping) {
                        oneshot.stopping = true;
                        action.fadeOut(0.25);
                        retiring.add(action);
                    }
                });
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
                    const yaw = (framing.rotation + adjustment.rotation) * Math.PI / 180;
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
                    if (neutral) {
                        // A capture freezes every clip and rebuilds the relaxed
                        // pose; playback resumes on the next regular frame.
                        if (!suspended) {
                            suspended = true;
                            animationMixer.stopAllAction();
                            retiring.clear();
                            oneshot = null;
                        }
                        vrm.humanoid.resetNormalizedPose();
                        applyVrmRelaxedPose(vrm.humanoid);
                        lookAtProxy?.quaternion.identity();
                        animateIdle(elapsed, false);
                    } else {
                        const resume = suspended;
                        suspended = false;
                        const fired = current.motion;
                        if (fired && fired.nonce !== lastNonce) {
                            lastNonce = fired.nonce;
                            const entry = motions.get(fired.name.trim().toLowerCase());
                            if (entry && !reduceMotion.matches) {
                                if (oneshot) {
                                    oneshot.action.fadeOut(0.15);
                                    retiring.add(oneshot.action);
                                    oneshot = null;
                                }
                                if (idle) {
                                    // The fired clip may be the idle clip; only
                                    // fade out a different one.
                                    if (idle.action !== entry.action) {
                                        idle.action.fadeOut(0.2);
                                        retiring.add(idle.action);
                                    }
                                    idle = null;
                                }
                                entry.action.reset();
                                entry.action.setLoop(entry.loop ? THREE.LoopRepeat : THREE.LoopOnce, entry.loop ? Infinity : 1);
                                entry.action.clampWhenFinished = true;
                                retiring.delete(entry.action);
                                entry.action.fadeIn(0.2).play();
                                oneshot = { action: entry.action, entry, stopping: false };
                            }
                        }
                        if (oneshot && reduceMotion.matches) {
                            // Reduced motion cuts in immediately rather than
                            // letting a running clip play out.
                            oneshot.action.fadeOut(0.15);
                            retiring.add(oneshot.action);
                            oneshot = null;
                        }
                        if (oneshot?.entry.loop && current.motion == null) {
                            // A looped emote holds only while its motion prop is
                            // present; once the scene moves on, fade back to idle.
                            oneshot.action.fadeOut(0.25);
                            retiring.add(oneshot.action);
                            oneshot = null;
                        }
                        const idleKey = (current.avatar.idleAnimation ?? '').trim().toLowerCase();
                        const wantIdle = !oneshot && !reduceMotion.matches && idleKey ? motions.get(idleKey) ?? null : null;
                        if (wantIdle !== (idle?.entry ?? null)) {
                            if (idle) {
                                idle.action.fadeOut(0.2);
                                retiring.add(idle.action);
                                idle = null;
                            }
                            if (wantIdle) {
                                retiring.delete(wantIdle.action);
                                wantIdle.action.reset();
                                wantIdle.action.setLoop(THREE.LoopRepeat, Infinity);
                                wantIdle.action.clampWhenFinished = false;
                                wantIdle.action.fadeIn(0.2).play();
                                idle = { action: wantIdle.action, entry: wantIdle };
                            }
                        }
                        if (resume && idle && !idle.action.isRunning()) idle.action.reset().play();
                        // The mixer writes bones, expressions and the look-at
                        // proxy first; the procedural layers below either stand
                        // down or overwrite the managed bones afterwards.
                        animationMixer.update(delta);
                        for (const action of [...retiring]) {
                            if (action.getEffectiveWeight() <= 0.001) {
                                action.stop();
                                retiring.delete(action);
                                if (oneshot?.action === action) oneshot = null;
                            }
                        }
                        // While any clip is live (including its fade tail) the
                        // procedural idle must not reset the managed bones or
                        // it would stomp the clip's output.
                        if (idle === null && oneshot === null && retiring.size === 0) animateIdle(elapsed, moving);
                    }
                    // Expression keys a playing clip drives are skipped here so
                    // the two writers never fight over the same weight.
                    const clipExpressions = new Set<string>();
                    if (!neutral) {
                        if (idle) idle.entry.expressions.forEach((key) => clipExpressions.add(key));
                        if (oneshot && !oneshot.stopping) oneshot.entry.expressions.forEach((key) => clipExpressions.add(key));
                    }
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
                    // The mouth tracks the shared TTS volume: a fast attack and
                    // slower release keep it synced without buzzing.
                    const lipTarget = !neutral && current.lipSync ? getTtsAudioLevel() : 0;
                    mouthLevel = neutral ? 0 : THREE.MathUtils.lerp(
                        mouthLevel,
                        lipTarget,
                        1 - Math.exp(-delta * (lipTarget > mouthLevel ? 25 : 8)),
                    );
                    for (const key of expressions) {
                        if (clipExpressions.has(key)) continue;
                        const target = key === selected ? 1 : key === 'blink' ? blink : key === mouthKey ? mouthLevel : 0;
                        const value = vrm.expressionManager?.getValue(key) ?? 0;
                        vrm.expressionManager?.setValue(key, neutral || key === 'blink' || key === mouthKey ? target : THREE.MathUtils.lerp(value, target, 1 - Math.exp(-delta * 12)));
                    }
                    // While the toggle is on, autoUpdate re-aims the eyes at the
                    // camera every frame, overriding clip-driven lookAt output.
                    if (vrm.lookAt) {
                        const gazeTarget = current.lookAtCamera ? camera : null;
                        if (vrm.lookAt.target !== gazeTarget) {
                            vrm.lookAt.target = gazeTarget;
                            if (!gazeTarget) vrm.lookAt.reset();
                        }
                    }
                    vrm.update(delta);
                    renderer.render(scene, camera);
                };
                render(0);
                live.current.ready = true;
                setStatus('ready');
                setCanGaze(vrm.lookAt != null);
                live.current.onReady?.({ expressions, motions: motionList, capture: (mode: 'portrait' | 'avatar' = 'portrait') => {
                    if (disposed || !renderer) throw new Error('プレビューを読み直してください。');
                    // Captured thumbnails must match the saved framing, so the
                    // transient drag/zoom adjustment is parked for this render.
                    const transient = view.current.adjustment;
                    view.current.adjustment = { ...DEFAULT_VRM_VIEW_ADJUSTMENT };
                    render(0, true);
                    view.current.adjustment = transient;
                    const source = renderer.domElement;
                    const thumbnail = document.createElement('canvas');
                    const context = thumbnail.getContext('2d')!;
                    if (mode === 'avatar') {
                        // Chat icons are square: crop the upper part of the portrait.
                        thumbnail.width = 400;
                        thumbnail.height = 400;
                        const size = Math.min(source.width, source.height);
                        context.drawImage(source, (source.width - size) / 2, 0, size, size, 0, 0, 400, 400);
                    } else {
                        thumbnail.width = 400;
                        thumbnail.height = 600;
                        context.drawImage(source, 0, 0, 400, 600);
                    }
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
            if (mixer) {
                mixer.stopAllAction();
                if (vrm) mixer.uncacheRoot(vrm.scene);
            }
            if (vrm) VRMUtils.deepDispose(vrm.scene);
            if (renderer) {
                renderer.domElement.removeEventListener('webglcontextlost', contextLost);
                renderer.dispose();
                renderer.forceContextLoss();
                renderer.domElement.remove();
            }
        };
    }, [avatar.source, animationKey, attempt]);

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
    const showGaze = interactive && status === 'ready' && canGaze;
    return <div
        className={`vrm-avatar${interactive ? ' vrm-avatar-interactive' : ''}${dragging ? ' vrm-avatar-dragging' : ''}`}
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerUp={interactive ? handlePointerEnd : undefined}
        onPointerCancel={interactive ? handlePointerEnd : undefined}
        // The right button pans, so the browser's context menu must stay closed.
        onContextMenu={interactive ? (event) => event.preventDefault() : undefined}
    >
        <div
            ref={host}
            className="vrm-canvas"
            role="img"
            aria-label={interactive ? `${name}の3Dアバター。左ドラッグや2本指で回転、右ドラッグや1本指で移動、ホイールやピンチで拡大縮小できます。` : `${name}の3Dアバター`}
            style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }}
        />
        {(showReset || showGaze) && <div className="vrm-view-tools">
            {showReset && <button
                type="button"
                className="vrm-view-reset"
                title="表示位置・向き・拡大率を戻す"
                aria-label="表示位置・向き・拡大率を戻す"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={resetView}
            >
                <RotateCcw size={14} />
            </button>}
            {showGaze && <button
                type="button"
                className={`vrm-view-gaze${lookAtCamera ? ' is-active' : ''}`}
                title={lookAtCamera ? 'カメラ目線を解除' : 'カメラ目線にする'}
                aria-label={lookAtCamera ? 'カメラ目線を解除' : 'カメラ目線にする'}
                aria-pressed={lookAtCamera}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setLookAtCamera((on) => !on)}
            >
                <Eye size={14} />
            </button>}
        </div>}
        {status !== 'ready' && <div className="vrm-fallback">
            {fallbackImage && <StoredImage src={fallbackImage} alt="" />}
            <div className="vrm-status" role="status">
                {status === 'loading' ? '3Dモデルを読み込み中…' : <>{error}<button type="button" className="btn btn-secondary" onClick={() => setAttempt((value) => value + 1)}>再読み込み</button></>}
            </div>
        </div>}
    </div>;
}
