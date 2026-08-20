import { describe, expect, test } from 'vitest';

import { useStore } from '../lib/store';
import {
    createMemoryRecord,
    inferMemoryKind,
    memoryTextSimilarity,
    normalizeMemoryContent,
} from '../lib/store/memories';
import { toPreview } from '../lib/store/persistence';
import { resolveThemeSelection } from '../lib/store/settings';

describe('store composition', () => {
    test('assembles state and actions from every slice', () => {
        const state = useStore.getState();

        expect(state.hydrated).toBe(false);
        expect(state.characters).toEqual([]);
        expect(state.groups).toEqual([]);
        expect(state.rooms).toEqual([]);
        expect(state.usageRecords).toEqual([]);
        expect(state.themeMode).toBe('dark');
        expect(state.themePalette).toBe('mono');

        for (const action of [
            'hydrate',
            'createCharacter',
            'addMemory',
            'createRoom',
            'addMessage',
            'addUsageRecord',
            'mergeBackup',
            'resetApplication',
        ] as const) {
            expect(state[action], action).toBeTypeOf('function');
        }
    });
});

describe('store pure helpers', () => {
    test('builds a safe conversation preview', () => {
        expect(toPreview('[emotion:happy] こんにちは <memory>非表示の記憶</memory>   世界'))
            .toBe('こんにちは 世界');
        expect(toPreview('a'.repeat(60))).toHaveLength(50);
    });

    test('normalizes theme values independently', () => {
        expect(resolveThemeSelection({ mode: 'light', palette: 'sakura' }))
            .toEqual({ mode: 'light', palette: 'sakura' });
        expect(resolveThemeSelection({ mode: 'invalid', palette: null }))
            .toEqual({ mode: 'dark', palette: 'mono' });
    });

    test('normalizes, classifies, and compares memory text', () => {
        expect(normalizeMemoryContent('  紅茶が\n  好き  ')).toBe('紅茶が 好き');
        expect(inferMemoryKind('紅茶が好き')).toBe('preference');
        expect(inferMemoryKind('前回の出来事')).toBe('event');
        expect(memoryTextSimilarity('「紅茶」が好き。', '紅茶 が好き')).toBe(1);
        expect(memoryTextSimilarity('紅茶が好き', '宇宙船を修理した')).toBeLessThan(0.5);
    });

    test('creates a normalized memory record with defaults', () => {
        const record = createMemoryRecord('character-1', '  紅茶が好き  ');

        expect(record).toMatchObject({
            characterId: 'character-1',
            content: '紅茶が好き',
            kind: 'preference',
            scope: 'character',
            importance: 0.6,
            confidence: 0.85,
            sourceMessageIds: [],
            usageCount: 0,
        });
        expect(createMemoryRecord('character-1', '   ')).toBeNull();
    });
});
