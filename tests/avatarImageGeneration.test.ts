import { describe, expect, test } from 'vitest';

import {
    AVATAR_CHROMA_KEY_HEX,
    applyAvatarChromaKey,
    buildTransparentFullBodyPrompt,
} from '../lib/avatarImageGeneration';

describe('avatar image generation', () => {
    test('adds full-body composition and a rare solid chroma-key background to the prompt', () => {
        const prompt = buildTransparentFullBodyPrompt('silver-haired knight in blue armor');

        expect(prompt).toContain('silver-haired knight in blue armor');
        expect(prompt).toContain('full-body standing illustration');
        expect(prompt).toContain('both feet');
        expect(prompt).toContain(AVATAR_CHROMA_KEY_HEX);
        expect(prompt).toContain('perfectly flat, uniform');
        expect(prompt).toContain('no scenery');
    });

    test('makes key-colored pixels transparent, including enclosed background areas', () => {
        const pixels = new Uint8ClampedArray([
            0, 255, 0, 255,
            255, 0, 0, 255,
            20, 240, 15, 255,
        ]);

        const stats = applyAvatarChromaKey(pixels, 3, 1);

        expect([...pixels]).toEqual([
            0, 255, 0, 0,
            255, 0, 0, 255,
            20, 240, 15, 0,
        ]);
        expect(stats.transparentPixels).toBe(2);
    });

    test('feathers only key-like pixels touching confirmed background', () => {
        const pixels = new Uint8ClampedArray([
            0, 255, 0, 255,
            120, 240, 120, 255,
            120, 240, 120, 255,
        ]);

        const stats = applyAvatarChromaKey(pixels, 3, 1);

        expect(pixels[3]).toBe(0);
        expect(pixels[7]).toBeGreaterThan(0);
        expect(pixels[7]).toBeLessThan(255);
        expect(pixels[11]).toBe(255);
        expect(stats.featheredPixels).toBe(1);
    });

    test('rejects inconsistent image dimensions', () => {
        expect(() => applyAvatarChromaKey(new Uint8ClampedArray(4), 2, 1)).toThrow(RangeError);
    });
});
