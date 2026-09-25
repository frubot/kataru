import { AI_CONNECTION_KINDS } from './aiApi';
import { fetchWithTransientRetry } from './fetchRetry';
import type { Character } from './store/types';

/** `.kataru` パッケージを開かずにサーバーが返す事前情報。 */
export interface CharacterPackageInspection {
    name: string;
    previewImage: string | null;
    exportedAt: number;
    hasVrm: boolean;
    assetCount: number;
}

async function readPackageError(response: Response): Promise<string> {
    const data = await response.json().catch(() => null) as { error?: unknown } | null;
    return typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`;
}

function isCharacterPackageInspection(value: unknown): value is CharacterPackageInspection {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.name === 'string'
        && (record.previewImage === null || typeof record.previewImage === 'string')
        && typeof record.exportedAt === 'number'
        && typeof record.hasVrm === 'boolean'
        && typeof record.assetCount === 'number';
}

/** キャラクターをZIP形式の `.kataru` パッケージとして書き出す。 */
export async function createCharacterPackage(
    characterId: string,
    includeVrm: boolean,
    fallbackConnectionId: string,
): Promise<Blob> {
    const params = new URLSearchParams({
        includeVrm: String(includeVrm),
        builtin: AI_CONNECTION_KINDS.join(','),
        fallbackConnectionId,
    });
    const response = await fetchWithTransientRetry(
        `/api/characters/${encodeURIComponent(characterId)}/package?${params.toString()}`,
        { cache: 'no-store', credentials: 'same-origin' },
    );
    if (!response.ok) {
        throw new Error(`キャラクターパッケージの書き出しに失敗しました: ${await readPackageError(response)}`);
    }
    return response.blob();
}

/** `.kataru` パッケージの内容をインポート前に確認する。 */
export async function inspectCharacterPackage(file: Blob): Promise<CharacterPackageInspection> {
    const response = await fetch('/api/character-packages/inspect', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
    });
    if (!response.ok) {
        throw new Error(`キャラクターパッケージの確認に失敗しました: ${await readPackageError(response)}`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!isCharacterPackageInspection(body)) {
        throw new Error('キャラクターパッケージの確認応答が不正です');
    }
    return body;
}

/** `.kataru` パッケージをインポートする。サーバー側で永続化済みのCharacterが返る。 */
export async function importCharacterPackage(
    file: Blob,
    params: { fallbackModel: string; fallbackConnectionId: string; knownConnectionIds: string[] },
): Promise<Character> {
    const query = new URLSearchParams({
        fallbackModel: params.fallbackModel,
        fallbackConnectionId: params.fallbackConnectionId,
        knownConnectionIds: params.knownConnectionIds.join(','),
    });
    const response = await fetch(`/api/character-packages/import?${query.toString()}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
    });
    if (!response.ok) {
        throw new Error(`キャラクターパッケージのインポートに失敗しました: ${await readPackageError(response)}`);
    }
    return await response.json() as Character;
}

export function createCharacterPackageFilename(name: string): string {
    const normalized = Array.from(name.normalize('NFKC'), (character) => (
        character.charCodeAt(0) <= 0x1f || '<>:"/\\|?*'.includes(character)
            ? '_'
            : character
    )).join('')
        .replace(/[. ]+$/g, '')
        .trim();
    const safeName = (normalized || 'character').slice(0, 80);
    return `${safeName}.kataru`;
}

export function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export async function shareBlobFile(
    blob: Blob,
    filename: string,
    title: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
    if (typeof navigator !== 'undefined' && typeof File === 'function' && typeof navigator.share === 'function') {
        const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
        const shareData: ShareData = { files: [file], title };
        let canShareFiles = true;
        if (typeof navigator.canShare === 'function') {
            try {
                canShareFiles = navigator.canShare(shareData);
            } catch {
                canShareFiles = false;
            }
        }
        if (canShareFiles) {
            try {
                await navigator.share(shareData);
                return 'shared';
            } catch (error) {
                if (
                    typeof error === 'object'
                    && error !== null
                    && 'name' in error
                    && error.name === 'AbortError'
                ) {
                    return 'cancelled';
                }
            }
        }
    }

    downloadBlob(blob, filename);
    return 'downloaded';
}
