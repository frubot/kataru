import type { VrmAvatar } from './store/types';
import { getImageAssetId } from './imageSource';

export const MAX_VRM_BYTES = 50 * 1024 * 1024;
export const VRM_DATA_PREFIX = 'data:model/gltf-binary;base64,';
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

export function isVrmSource(source: unknown, allowAsset = true): source is string {
    return typeof source === 'string' && (
        (allowAsset && getImageAssetId(source) !== null)
        || (source.startsWith(VRM_DATA_PREFIX) && source.length <= VRM_DATA_PREFIX.length + Math.ceil(MAX_VRM_BYTES / 3) * 4
            && /^[A-Za-z0-9+/]+={0,2}$/.test(source.slice(VRM_DATA_PREFIX.length)))
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

/** Inspect before GLTFLoader runs so imported models cannot fetch external resources. */
export function validateVrmBuffer(buffer: ArrayBuffer): void {
    const invalid = () => new Error('有効なVRM 0.x / 1.0ファイルを選択してください。');
    if (buffer.byteLength < 20 || buffer.byteLength > MAX_VRM_BYTES) throw invalid();
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
        || view.getUint32(8, true) !== buffer.byteLength || view.getUint32(16, true) !== 0x4e4f534a) throw invalid();
    const length = view.getUint32(12, true);
    if (length > buffer.byteLength - 20) throw invalid();
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
    if (!json.extensions?.VRM && !json.extensions?.VRMC_vrm) throw invalid();
    // VRM embeds its buffers and textures. Reject all URI fields, including extension resources.
    const check = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) {
            if (key === 'uri') throw new Error('外部リソースを参照するVRMには対応していません。テクスチャを内包して書き出してください。');
            check(child);
        }
    };
    check(json);
}
