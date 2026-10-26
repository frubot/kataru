import { describe, expect, test } from 'vitest';

import {
    DEFAULT_CONNECTION_ID,
    isAiConnectionKind,
    modelRefConnectionId,
    modelRefModel,
    normalizeAiApiConfig,
    normalizeModelRef,
    serializeModelRef,
} from '../lib/aiApi';
import { normalizeCharacters } from '../lib/store/characters';
import { normalizeSituationActor } from '../lib/store/situations';
import type { Character } from '../lib/store/types';

const FALLBACK = { connectionId: DEFAULT_CONNECTION_ID, model: 'fallback-model' };

describe('isAiConnectionKind', () => {
    test('accepts the built-in kinds and rejects anything else', () => {
        expect(isAiConnectionKind('openrouter')).toBe(true);
        expect(isAiConnectionKind('openai-compatible')).toBe(true);
        expect(isAiConnectionKind('anthropic')).toBe(true);
        expect(isAiConnectionKind('bogus')).toBe(false);
        expect(isAiConnectionKind(undefined)).toBe(false);
    });
});

describe('normalizeModelRef', () => {
    test('wraps a plain string with the fallback connection', () => {
        expect(normalizeModelRef('model-1', FALLBACK)).toEqual({
            connectionId: DEFAULT_CONNECTION_ID,
            model: 'model-1',
        });
    });

    test('keeps object connection ids including custom cx_* ids', () => {
        expect(normalizeModelRef(
            { connectionId: 'cx_local', model: 'model-2' },
            FALLBACK,
        )).toEqual({ connectionId: 'cx_local', model: 'model-2' });
    });

    test('folds the legacy { model, aiApiType } shape into connectionId', () => {
        expect(normalizeModelRef(
            { model: 'claude-3', aiApiType: 'anthropic' },
            FALLBACK,
        )).toEqual({ connectionId: 'anthropic', model: 'claude-3' });
    });

    test('falls back on blank or missing model values', () => {
        expect(normalizeModelRef('   ', FALLBACK)).toEqual(FALLBACK);
        // オブジェクトの接続 id は尊重し、モデル名だけフォールバックする。
        expect(normalizeModelRef({ connectionId: 'cx_local' }, FALLBACK)).toEqual({
            connectionId: 'cx_local',
            model: 'fallback-model',
        });
        expect(normalizeModelRef(undefined, FALLBACK)).toEqual(FALLBACK);
    });
});

describe('model ref helpers', () => {
    test('serializeModelRef emits { model, connectionId }', () => {
        expect(serializeModelRef({ connectionId: 'cx_a', model: 'm' })).toEqual({
            model: 'm',
            connectionId: 'cx_a',
        });
    });

    test('modelRefModel and modelRefConnectionId read normalized refs', () => {
        const ref = { connectionId: 'anthropic', model: 'claude' };
        expect(modelRefModel(ref)).toBe('claude');
        expect(modelRefConnectionId(ref)).toBe('anthropic');
        const normalized = normalizeModelRef('plain-model', { connectionId: 'cx_fallback', model: 'x' });
        expect(modelRefModel(normalized)).toBe('plain-model');
        expect(modelRefConnectionId(normalized)).toBe('cx_fallback');
    });
});

describe('normalizeAiApiConfig', () => {
    test('keeps only connectionId and per-role model defaults', () => {
        const config = normalizeAiApiConfig({
            connectionId: 'cx_local',
            modelDefaults: {
                summaryModel: { model: 'm1', connectionId: 'cx_a' },
                defaultChatModel: 'plain',
            },
            // 旧フィールドは無視する。
            aiApiType: 'anthropic',
            roleApiTypes: { summaryModel: 'anthropic' },
            openRouterIgnoredProviders: ['x'],
            openAiCompatibleBaseUrl: 'https://example.test',
        } as never);

        expect(config.connectionId).toBe('cx_local');
        expect(config.modelDefaults.summaryModel).toEqual({ model: 'm1', connectionId: 'cx_a' });
        expect(config.modelDefaults.defaultChatModel).toEqual({
            model: 'plain',
            connectionId: 'cx_local',
        });
        expect(config).not.toHaveProperty('aiApiType');
        expect(config).not.toHaveProperty('roleApiTypes');
        expect(config).not.toHaveProperty('openRouterIgnoredProviders');
        expect(config).not.toHaveProperty('openAiCompatibleBaseUrl');
    });
});

describe('legacy per-entity model settings', () => {
    test('normalizeCharacters drops the per-character model and sampling settings', () => {
        const [legacy, current] = normalizeCharacters([
            {
                id: 'character-1',
                name: '葵',
                systemPrompt: '',
                model: 'model-1',
                aiApiType: 'anthropic',
                temperature: 0.4,
                topP: 0.9,
                reasoningEffort: 'low',
                createdAt: 1,
                updatedAt: 1,
            } as unknown as Character,
            {
                id: 'character-2',
                name: '蛍',
                systemPrompt: '',
                createdAt: 1,
                updatedAt: 1,
            },
        ]);

        for (const key of ['model', 'aiApiType', 'temperature', 'topP', 'reasoningEffort']) {
            expect(legacy).not.toHaveProperty(key);
        }
        expect(legacy.name).toBe('葵');
        // 変更のないキャラクターは同じオブジェクトのまま返し、書き戻しを避ける。
        const input = { id: 'character-3', name: '凛', systemPrompt: '', createdAt: 1, updatedAt: 1 };
        expect(normalizeCharacters([input])[0]).toBe(input);
        expect(current).not.toHaveProperty('model');
    });

    test('normalizeSituationActor drops model settings on temporary actors', () => {
        const temporary = normalizeSituationActor({
            id: 'actor-1',
            type: 'temporary',
            name: '臨時',
            systemPrompt: '',
            model: 'model-1',
            aiApiType: 'openai-compatible',
            temperature: 0.4,
            directorDescription: '指揮役向けの説明',
        }, new Set());
        expect(temporary).not.toHaveProperty('model');
        expect(temporary).not.toHaveProperty('aiApiType');
        expect(temporary).not.toHaveProperty('temperature');
        expect(temporary).not.toHaveProperty('directorDescription');
    });
});
