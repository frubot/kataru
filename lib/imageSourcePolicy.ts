/**
 * 画像参照として許可してよいURLかどうかの判定。
 *
 * AIの出力や取り込んだバックアップに外部URLが混ざると、画面がそのまま
 * 読み込んで外部へリクエストを送ってしまう（会話内容やIPの漏えい）。
 * そのため「アプリ内で完結する参照」だけを許可し、外部URLは拒否する。
 *
 * 判定は許可制（allowlist）で行い、`new URL` で解決した結果のオリジンも
 * 確認する。`//attacker.example/...` のようなプロトコル相対URLや、
 * `http://127.0.0.1:37371@attacker.example/` のようなユーザー情報付きURLも
 * オリジン不一致として弾かれる。
 */

import { getImageAssetId } from './imageSource';

/** アプリが保存画像を配信するパス。id は内容のSHA-256（16進64桁）。 */
const API_ASSET_PATH = /^\/api\/assets\/[0-9a-f]{64}$/;

/**
 * 画像のdata URL。MIME typeはラスタ画像だけを許可する。
 * SVGはスクリプトを含み得るため許可しない。
 */
const RASTER_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif)(?:;[a-z0-9=._+-]+)*,/i;

/** `data:image/...` のラスタ画像data URLか。 */
export function isAllowedRasterImageDataUrl(source: string): boolean {
    return RASTER_IMAGE_DATA_URL.test(source);
}

function documentBaseUrl(baseUrl?: string): string | null {
    if (baseUrl) return baseUrl;
    if (typeof window !== 'undefined' && window.location) return window.location.origin;
    return null;
}

/**
 * 同一オリジンの保存画像URL（`/api/assets/<sha256>`）か。
 *
 * 基準URLが無い環境（Node等）では、外部URLになり得ないパス形式だけを受け付ける。
 */
function isSameOriginApiAssetUrl(source: string, baseUrl?: string): boolean {
    const base = documentBaseUrl(baseUrl);
    if (!base) return API_ASSET_PATH.test(source);

    let url: URL;
    let baseOrigin: string;
    try {
        url = new URL(source, base);
        baseOrigin = new URL(base).origin;
    } catch {
        return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.origin !== baseOrigin) return false;
    return API_ASSET_PATH.test(url.pathname) && url.search === '' && url.hash === '';
}

/**
 * Markdown中の画像として表示してよい参照か。
 *
 * 許可するのは次の3種類だけ。
 * - `data:image/(png|jpeg|webp|gif)` のdata URL
 * - ページ内で生成した `blob:` URL
 * - アプリ内の保存画像（`asset:<sha256>` と同一オリジンの `/api/assets/<sha256>`）
 */
export function isAllowedMarkdownImageSource(source: string, baseUrl?: string): boolean {
    const value = source.trim();
    if (!value) return false;
    if (isAllowedRasterImageDataUrl(value)) return true;
    if (value.toLowerCase().startsWith('blob:')) return true;
    if (getImageAssetId(value) !== null) return true;
    return isSameOriginApiAssetUrl(value, baseUrl);
}

/**
 * バックアップ取り込み時の画像参照として保存してよい値か。
 *
 * 保存できる正規形（`asset:<sha256>` と画像のdata URL）だけを許可する。
 * 表示用の `/api/assets/<sha256>` は保存時に `asset:` へ解決されないため、
 * 取り込みでは受け付けない（サーバー側 src/db/storage/images.rs も同じ規則）。
 * `blob:` は保存しても復元できないため受け付けない。
 */
export function isAllowedImportedImageSource(source: string): boolean {
    if (source.trim() !== source) return false;
    if (!source) return false;
    if (isAllowedRasterImageDataUrl(source)) return true;
    return getImageAssetId(source) !== null;
}
