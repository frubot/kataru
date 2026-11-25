import { describe, expect, test } from 'vitest';

import {
    isAllowedImportedImageSource,
    isAllowedMarkdownImageSource,
    isAllowedRasterImageDataUrl,
} from '../lib/imageSourcePolicy';

const ASSET_ID = 'a'.repeat(64);
const BASE = 'http://127.0.0.1:37371';

describe('isAllowedRasterImageDataUrl', () => {
    test.each([
        'data:image/png;base64,iVBORw0KGgo=',
        'data:image/jpeg;base64,/9j/4AAQ',
        'data:image/webp;base64,UklGRg==',
        'data:image/gif;base64,R0lGODlh',
        'DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=',
        'data:image/png,plain-text-payload',
    ])('accepts raster image data URL: %s', (source) => {
        expect(isAllowedRasterImageDataUrl(source)).toBe(true);
    });

    test.each([
        'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        'data:text/html;base64,PHNjcmlwdD4=',
        'data:image/pngx;base64,AAAA',
        'data:image/png',
        'https://attacker.example/pixel.png',
        'data:image/',
    ])('rejects non-raster image source: %s', (source) => {
        expect(isAllowedRasterImageDataUrl(source)).toBe(false);
    });
});

describe('isAllowedMarkdownImageSource', () => {
    test.each([
        'data:image/png;base64,iVBORw0KGgo=',
        'blob:http://127.0.0.1:37371/9f8b6f8d',
        `asset:${ASSET_ID}`,
        `/api/assets/${ASSET_ID}`,
        `${BASE}/api/assets/${ASSET_ID}`,
    ])('accepts in-app image source: %s', (source) => {
        expect(isAllowedMarkdownImageSource(source, BASE)).toBe(true);
    });

    test.each([
        'https://attacker.example/?data=secret',
        'http://attacker.example/pixel.png',
        '//attacker.example/pixel.png',
        'http://127.0.0.1:37371@attacker.example/pixel.png',
        'javascript:alert(1)',
        'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        '/api/chat',
        `/api/assets/${ASSET_ID}?x=1`,
        `/api/assets/${'g'.repeat(64)}`,
        'asset:not-an-asset-id',
        '',
    ])('rejects external or malformed image source: %s', (source) => {
        expect(isAllowedMarkdownImageSource(source, BASE)).toBe(false);
    });

    test('rejects another loopback port such as the Vite dev server', () => {
        expect(isAllowedMarkdownImageSource('http://127.0.0.1:3000/api/assets/' + ASSET_ID, BASE)).toBe(false);
    });

    test('falls back to the strict path form when no base URL is available', () => {
        expect(isAllowedMarkdownImageSource(`/api/assets/${ASSET_ID}`)).toBe(true);
        expect(isAllowedMarkdownImageSource('/api/assets/../secret.png')).toBe(false);
        expect(isAllowedMarkdownImageSource('https://attacker.example/x.png')).toBe(false);
    });
});

describe('isAllowedImportedImageSource', () => {
    test.each([
        'data:image/png;base64,iVBORw0KGgo=',
        'data:image/gif;base64,R0lGODlh',
        `asset:${ASSET_ID}`,
    ])('accepts restorable in-app image source: %s', (source) => {
        expect(isAllowedImportedImageSource(source)).toBe(true);
    });

    test.each([
        'https://attacker.example/pixel.png',
        'http://attacker.example/pixel.png',
        '//attacker.example/pixel.png',
        'blob:http://127.0.0.1:37371/9f8b6f8d',
        'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        // 表示用のURLは保存形ではないため、取り込みでは正規形だけを受け付ける。
        `/api/assets/${ASSET_ID}`,
        ` /api/assets/${ASSET_ID}`,
        `asset:${ASSET_ID}\n`,
        '',
    ])('rejects source that would leak data or cannot be restored: %s', (source) => {
        expect(isAllowedImportedImageSource(source)).toBe(false);
    });
});
