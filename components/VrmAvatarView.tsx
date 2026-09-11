import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { VrmAvatar } from '@/lib/store/types';
import { resolveStoredImageUrl } from '@/lib/imageSource';
import { isVrmSource, resolveVrmExpression, validateVrmBuffer } from '@/lib/vrm';
import StoredImage from './StoredImage';

export type VrmPreview = { expressions: string[]; capture: () => string };
type Props = {
    avatar: VrmAvatar;
    expression?: string | null;
    fallbackImage?: string;
    name: string;
    onReady?: (preview: VrmPreview | null) => void;
};

export default function VrmAvatarView({ avatar, expression, fallbackImage, name, onReady }: Props) {
    const host = useRef<HTMLDivElement>(null);
    const live = useRef({ avatar, expression, onReady });
    useEffect(() => { live.current = { avatar, expression, onReady }; }, [avatar, expression, onReady]);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);

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
        setStatus('loading');
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
                // Derive the rotation sign from the rest pose: VRM 0 and 1 face opposite axes.
                for (const side of ['left', 'right'] as const) {
                    const upper = vrm.humanoid.getNormalizedBoneNode(`${side}UpperArm`);
                    const lower = vrm.humanoid.getNormalizedBoneNode(`${side}LowerArm`);
                    if (upper && lower) upper.rotation.z = -Math.sign(lower.position.x) * 1.15;
                }
                vrm.update(0);
                vrm.scene.updateMatrixWorld(true);
                const bounds = new THREE.Box3().setFromObject(vrm.scene);
                const size = bounds.getSize(new THREE.Vector3());
                const center = bounds.getCenter(new THREE.Vector3());
                if (!Number.isFinite(size.y) || size.y <= 0) throw new Error('モデルの大きさを取得できません。');
                const pivot = new THREE.Group();
                vrm.scene.position.sub(center);
                pivot.add(vrm.scene);
                scene.add(pivot);
                scene.add(new THREE.HemisphereLight(0xffffff, 0x9295b0, 1));
                const light = new THREE.DirectionalLight(0xffffff, 2.5);
                light.position.set(1, 2, 3);
                scene.add(light);
                const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
                camera.position.z = Math.max(size.y * 4, 5);
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
                };
                resize = new ResizeObserver(fit);
                resize.observe(container);
                fit();
                const expressions = Object.keys(vrm.expressionManager?.expressionMap ?? {});
                const head = vrm.humanoid.getNormalizedBoneNode('head');
                const chest = vrm.humanoid.getNormalizedBoneNode('chest');
                const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
                let previous = performance.now();
                let elapsed = 0;
                let blinkAt = 2.5;
                const render = (delta: number, neutral = false) => {
                    if (!vrm || !renderer) return;
                    const current = live.current;
                    const framing = current.avatar.framing;
                    pivot.scale.setScalar(framing.scale);
                    pivot.position.y = framing.offsetY * size.y;
                    pivot.rotation.y = framing.rotation * Math.PI / 180;
                    const moving = !reduceMotion.matches && !neutral;
                    if (head) head.rotation.z = moving ? Math.sin(elapsed * 0.65) * 0.025 : 0;
                    if (chest) chest.rotation.x = moving ? Math.sin(elapsed * 1.6) * 0.012 : 0;
                    const selected = neutral ? null : resolveVrmExpression(current.avatar, current.expression);
                    const blink = moving && elapsed >= blinkAt ? Math.sin(Math.min((elapsed - blinkAt) / 0.18, 1) * Math.PI) : 0;
                    if (elapsed > blinkAt + 0.18) blinkAt = elapsed + 3 + Math.random() * 2;
                    for (const key of expressions) {
                        const target = key === selected ? 1 : key === 'blink' ? blink : 0;
                        const value = vrm.expressionManager?.getValue(key) ?? 0;
                        vrm.expressionManager?.setValue(key, neutral || key === 'blink' ? target : THREE.MathUtils.lerp(value, target, 1 - Math.exp(-delta * 12)));
                    }
                    vrm.update(delta);
                    renderer.render(scene, camera);
                };
                render(0);
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

    return <div className="vrm-avatar" role="img" aria-label={`${name}の3Dアバター`}>
        <div ref={host} className="vrm-canvas" style={{ visibility: status === 'ready' ? 'visible' : 'hidden' }} />
        {status !== 'ready' && <div className="vrm-fallback">
            {fallbackImage && <StoredImage src={fallbackImage} alt="" />}
            <div className="vrm-status" role="status">
                {status === 'loading' ? '3Dモデルを読み込み中…' : <>{error}<button type="button" className="btn btn-secondary" onClick={() => setAttempt((value) => value + 1)}>再読み込み</button></>}
            </div>
        </div>}
    </div>;
}
