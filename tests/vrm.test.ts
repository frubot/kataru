import { describe, expect, test } from 'vitest';
import { createVrmExpressionMap, DEFAULT_VRM_FRAMING, getVrmMotionNames, isVrmaSource, MAX_VRMA_BYTES, resolveVrmExpression, validateVrmBuffer, validateVrmaBuffer, VRM_DATA_PREFIX, VRMA_DATA_PREFIX } from '../lib/vrm';
import { findVisualNovelCostume, getVisualNovelCostumeOptions, getVisualNovelExpressionNames, resolveVisualNovelExpressionImage } from '../lib/visualNovelPresentation';
import type { Character, VrmAvatar } from '../lib/store/types';

function glb(json: unknown): ArrayBuffer {
    const text = new TextEncoder().encode(JSON.stringify(json));
    const length = Math.ceil(text.length / 4) * 4;
    const buffer = new ArrayBuffer(20 + length);
    const view = new DataView(buffer);
    [0x46546c67, 2, buffer.byteLength, length, 0x4e4f534a].forEach((value, index) => view.setUint32(index * 4, value, true));
    const bytes = new Uint8Array(buffer, 20);
    bytes.fill(32);
    bytes.set(text);
    return buffer;
}

describe('VRM import and presentation', () => {
    test('accepts both VRM generations but rejects non-VRM, corrupt containers and external resources before loading', () => {
        for (const extension of ['VRM', 'VRMC_vrm']) {
            expect(() => validateVrmBuffer(glb({ extensions: { [extension]: {} } }))).not.toThrow();
        }
        expect(() => validateVrmBuffer(glb({ asset: { version: '2.0' } }))).toThrow();
        const truncated = glb({ extensions: { VRM: {} } }).slice(0, 25);
        expect(() => validateVrmBuffer(truncated)).toThrow();
        expect(() => validateVrmBuffer(glb({ extensions: { VRM: {} }, images: [{ uri: 'https://example.com/texture.png' }] }))).toThrow('外部リソース');
    });

    test('accepts VRMA containers only when the animation extension is present and self-contained', () => {
        expect(() => validateVrmaBuffer(glb({ extensions: { VRMC_vrm_animation: {} } }))).not.toThrow();
        for (const json of [
            { extensions: { VRM: {} } },
            { extensions: { VRMC_vrm: {} } },
            { asset: { version: '2.0' } },
        ]) {
            expect(() => validateVrmaBuffer(glb(json))).toThrow('有効なVRMAファイルを選択してください。');
        }
        const truncated = glb({ extensions: { VRMC_vrm_animation: {} } }).slice(0, 25);
        expect(() => validateVrmaBuffer(truncated)).toThrow();
        expect(() => validateVrmaBuffer(new ArrayBuffer(40))).toThrow();
        expect(() => validateVrmaBuffer(glb({ extensions: { VRMC_vrm_animation: {} }, buffers: [{ uri: 'https://example.com/buffer.bin' }] })))
            .toThrow('外部リソースを参照するVRMAには対応していません。');
    });

    test('accepts VRMA data URLs and asset ids while rejecting VRM or external sources', () => {
        expect(isVrmaSource(`${VRMA_DATA_PREFIX}AAAA`)).toBe(true);
        expect(isVrmaSource(`asset:${'a'.repeat(64)}`)).toBe(true);
        expect(isVrmaSource(`asset:${'a'.repeat(64)}`, false)).toBe(false);
        expect(isVrmaSource(`${VRM_DATA_PREFIX}AAAA`)).toBe(false);
        expect(isVrmaSource(VRMA_DATA_PREFIX)).toBe(false);
        expect(isVrmaSource(`${VRMA_DATA_PREFIX}!!??`)).toBe(false);
        expect(isVrmaSource(`${VRMA_DATA_PREFIX}${'A'.repeat(Math.ceil(MAX_VRMA_BYTES / 3) * 4 + 4)}`)).toBe(false);
        expect(isVrmaSource('https://example.com/motion.vrma')).toBe(false);
        expect(isVrmaSource(123)).toBe(false);
    });

    test('lists unique trimmed motion names and tolerates avatars without animations', () => {
        const avatar: VrmAvatar = { source: 'unused', framing: DEFAULT_VRM_FRAMING, expressionMap: {} };
        expect(getVrmMotionNames(avatar)).toEqual([]);
        avatar.animations = [
            { name: 'wave', source: 'a' },
            { name: '', source: 'b' },
            { name: '   ', source: 'c' },
            { name: 'idle', source: 'd' },
            { name: ' wave ', source: 'e' },
            { name: 'walk', source: 'f' },
        ];
        expect(getVrmMotionNames(avatar)).toEqual(['wave', 'idle', 'walk']);
    });

    test('exposes mapped emotions to the conversation while keeping blink and mouth controls automatic', () => {
        const avatar = { source: 'unused', framing: DEFAULT_VRM_FRAMING, expressionMap: { ...createVrmExpressionMap(['happy', 'angry', 'blink', 'aa', 'lookUp']), smile: 'happy', missing: '' } };
        const character = {
            id: 'alice', name: 'Alice', model: { connectionId: 'openrouter', model: 'test' }, systemPrompt: '', createdAt: 0, updatedAt: 0,
            expressions: [{ name: 'sad', image: 'default-sad.png' }],
            costumes: [{ name: '3d', kind: 'vrm', image: 'preview.png', vrm: avatar }],
        } satisfies Character;
        expect(getVisualNovelExpressionNames(character, '3d')).toEqual(['neutral', 'happy', 'angry', 'smile']);
        expect(resolveVrmExpression(avatar, 'SMILE')).toBe('happy');
        expect(resolveVrmExpression(avatar, 'unknown')).toBeNull();
        expect(resolveVisualNovelExpressionImage(character, 'happy', '3d')).toBe('preview.png');
        expect(getVisualNovelExpressionNames(character, 'default')).toEqual(['sad']);
    });

    test('a VRM stored on the default costume acts as the avatar', () => {
        const avatar = { source: 'unused', framing: DEFAULT_VRM_FRAMING, expressionMap: { happy: 'joy', missing: '' } };
        const character = {
            id: 'alice', name: 'Alice', model: { connectionId: 'openrouter', model: 'test' }, systemPrompt: '', createdAt: 0, updatedAt: 0,
            icon: 'icon.png',
            expressions: [{ name: 'neutral', image: 'portrait.png' }],
            costumes: [{ name: 'default', kind: 'vrm', image: 'portrait.png', vrm: avatar }],
        } satisfies Character;
        expect(getVisualNovelExpressionNames(character)).toEqual(['neutral', 'happy']);
        expect(getVisualNovelExpressionNames(character, 'default')).toEqual(['neutral', 'happy']);
        expect(getVisualNovelCostumeOptions(character)[0]).toEqual({
            name: 'default',
            kind: 'vrm',
            image: 'portrait.png',
            expressionCount: 1,
        });
        expect(resolveVisualNovelExpressionImage(character, 'happy', 'default')).toBe('portrait.png');
    });

    test('resolves the default costume regardless of its stored name casing', () => {
        const avatar = { source: 'unused', framing: DEFAULT_VRM_FRAMING, expressionMap: {} };
        const character = {
            id: 'alice', name: 'Alice', model: { connectionId: 'openrouter', model: 'test' }, systemPrompt: '', createdAt: 0, updatedAt: 0,
            costumes: [
                { name: 'Default', kind: 'vrm', image: 'portrait.png', vrm: avatar },
                { name: 'uniform', image: 'uniform.png' },
            ],
        } satisfies Character;

        expect(findVisualNovelCostume(character, 'default')?.vrm).toBe(avatar);
        expect(findVisualNovelCostume(character, 'Default')?.vrm).toBe(avatar);
        expect(findVisualNovelCostume(character, 'uniform')?.image).toBe('uniform.png');
        expect(findVisualNovelCostume(character, 'missing')).toBeNull();
        expect(findVisualNovelCostume(character, null)).toBeNull();
    });
});
