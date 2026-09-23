import type { VrmAnimation, VrmAvatar } from './store/types';
import { getImageAssetId } from './imageSource';

export const MAX_VRM_BYTES = 50 * 1024 * 1024;
export const VRM_DATA_PREFIX = 'data:model/gltf-binary;base64,';
export const MAX_VRMA_BYTES = 20 * 1024 * 1024;
export const VRMA_DATA_PREFIX = 'data:application/x-vrma;base64,';
export const DEFAULT_VRM_FRAMING = { scale: 1, offsetY: 0, rotation: 0 };
const AUTOMATIC_EXPRESSIONS = /^(neutral|blink|blinkLeft|blinkRight|lookUp|lookDown|lookLeft|lookRight|aa|ih|ou|ee|oh)$/i;

export function createVrmExpressionMap(names: string[]): Record<string, string> {
    return Object.fromEntries(names.filter((name) => !AUTOMATIC_EXPRESSIONS.test(name)).map((name) => [name, name]));
}

export function getVrmExpressionNames(avatar: VrmAvatar): string[] {
    return ['neutral', ...Object.entries(avatar.expressionMap).filter(([, target]) => target).map(([name]) => name)]
        .filter((name, index, names) => names.indexOf(name) === index);
}

export function resolveVrmExpression(avatar: VrmAvatar, expression?: string | null): string | null {
    if (!expression || expression.toLowerCase() === 'neutral') return null;
    return Object.entries(avatar.expressionMap).find(([name]) => name.toLowerCase() === expression.toLowerCase())?.[1] || null;
}

export function getVrmMotionNames(avatar: VrmAvatar): string[] {
    return (avatar.animations ?? [])
        .map((animation) => animation.name.trim())
        .filter((name, index, names) => name.length > 0 && names.indexOf(name) === index);
}

export function isVrmSource(source: unknown, allowAsset = true): source is string {
    return typeof source === 'string' && (
        (allowAsset && getImageAssetId(source) !== null)
        || (source.startsWith(VRM_DATA_PREFIX) && source.length <= VRM_DATA_PREFIX.length + Math.ceil(MAX_VRM_BYTES / 3) * 4
            && /^[A-Za-z0-9+/]+={0,2}$/.test(source.slice(VRM_DATA_PREFIX.length)))
    );
}

export function isVrmaSource(source: unknown, allowAsset = true): source is string {
    return typeof source === 'string' && (
        (allowAsset && getImageAssetId(source) !== null)
        || (source.startsWith(VRMA_DATA_PREFIX) && source.length <= VRMA_DATA_PREFIX.length + Math.ceil(MAX_VRMA_BYTES / 3) * 4
            && /^[A-Za-z0-9+/]+={0,2}$/.test(source.slice(VRMA_DATA_PREFIX.length)))
    );
}

/** Read a picked .vrm file into an avatar record with default framing. */
export async function readVrmFile(file: File): Promise<VrmAvatar> {
    if (!file.name.toLowerCase().endsWith('.vrm')) throw new Error('.vrmファイルを選択してください。');
    if (file.size > MAX_VRM_BYTES) throw new Error('VRMは50MB以下にしてください。');
    const buffer = await file.arrayBuffer();
    validateVrmBuffer(buffer);
    const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(VRM_DATA_PREFIX + String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('ファイルを読み込めませんでした。'));
        reader.readAsDataURL(file);
    });
    return { source, framing: { ...DEFAULT_VRM_FRAMING }, expressionMap: {} };
}

/** Read a picked .vrma file into an animation record. */
export async function readVrmaFile(file: File): Promise<VrmAnimation> {
    if (!file.name.toLowerCase().endsWith('.vrma')) throw new Error('.vrmaファイルを選択してください。');
    if (file.size > MAX_VRMA_BYTES) throw new Error('VRMAは20MB以下にしてください。');
    const buffer = await file.arrayBuffer();
    validateVrmaBuffer(buffer);
    const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(VRMA_DATA_PREFIX + String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('ファイルを読み込めませんでした。'));
        reader.readAsDataURL(file);
    });
    return { name: file.name.replace(/\.vrma$/i, ''), source, loop: false };
}

/** Parse the GLB container header and return the decoded JSON chunk. */
function parseGlbJson(buffer: ArrayBuffer, maxBytes: number, invalid: () => Error) {
    if (buffer.byteLength < 20 || buffer.byteLength > maxBytes) throw invalid();
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
        || view.getUint32(8, true) !== buffer.byteLength || view.getUint32(16, true) !== 0x4e4f534a) throw invalid();
    const length = view.getUint32(12, true);
    if (length > buffer.byteLength - 20) throw invalid();
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
}

/** Reject all URI fields, including extension resources, so imported models cannot fetch external resources. */
function rejectExternalUris(value: unknown, message: string): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        if (key === 'uri') throw new Error(message);
        rejectExternalUris(child, message);
    }
}

/** Inspect before GLTFLoader runs so imported models cannot fetch external resources. */
export function validateVrmBuffer(buffer: ArrayBuffer): void {
    const invalid = () => new Error('有効なVRM 0.x / 1.0ファイルを選択してください。');
    const json = parseGlbJson(buffer, MAX_VRM_BYTES, invalid);
    if (!json.extensions?.VRM && !json.extensions?.VRMC_vrm) throw invalid();
    // VRM embeds its buffers and textures. Reject all URI fields, including extension resources.
    rejectExternalUris(json, '外部リソースを参照するVRMには対応していません。テクスチャを内包して書き出してください。');
}

/** Inspect before the animation loader runs so imported clips cannot fetch external resources. */
export function validateVrmaBuffer(buffer: ArrayBuffer): void {
    const invalid = () => new Error('有効なVRMAファイルを選択してください。');
    const json = parseGlbJson(buffer, MAX_VRMA_BYTES, invalid);
    if (!json.extensions?.VRMC_vrm_animation) throw invalid();
    // VRMA embeds its buffers. Reject all URI fields, including extension resources.
    rejectExternalUris(json, '外部リソースを参照するVRMAには対応していません。');
}
