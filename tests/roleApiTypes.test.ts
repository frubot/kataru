import { describe, expect, test } from 'vitest';

import {
    normalizeAiApiConfig,
    normalizeRoleApiTypes,
    resolveRoleApiType,
    supportsAiApiFeature,
} from '../lib/aiApi';
import { getDefaultModelDefaults } from '../lib/modelDefaults';
import { normalizeCharacters } from '../lib/store/characters';
import { activeModelDefaults, roleApiTypeFor } from '../lib/store/settings';
import { normalizeSituationActor, normalizeSituationDirector } from '../lib/store/situations';
import type { Character } from '../lib/store/types';

describe('normalizeRoleApiTypes', () => {
    test('keeps valid role overrides and drops invalid entries', () => {
        expect(normalizeRoleApiTypes({
            defaultChatModel: 'anthropic',
            summaryModel: 'openai-compatible',
            defaultImageModel: 'not-a-provider',
            unknownRole: 'openrouter',
        })).toEqual({
            defaultChatModel: 'anthropic',
            summaryModel: 'openai-compatible',
        });
    });

    test('returns an empty map for non-objects', () => {
        expect(normalizeRoleApiTypes(undefined)).toEqual({});
        expect(normalizeRoleApiTypes('anthropic')).toEqual({});
        expect(normalizeRoleApiTypes(['anthropic'])).toEqual({});
    });
});

describe('role provider precedence', () => {
    test('role override wins over the global provider', () => {
        const config = normalizeAiApiConfig({
            aiApiType: 'openrouter',
            roleApiTypes: { summaryModel: 'anthropic' },
        });

        expect(resolveRoleApiType(config, 'summaryModel')).toBe('anthropic');
        expect(resolveRoleApiType(config, 'defaultChatModel')).toBe('openrouter');
    });

    test('roleApiTypeFor resolves the effective provider for a role', () => {
        const state = {
            aiApiType: 'openai-compatible' as const,
            roleApiTypes: { defaultImageModel: 'openrouter' as const },
        };

        expect(roleApiTypeFor(state, 'defaultImageModel')).toBe('openrouter');
        expect(roleApiTypeFor(state, 'defaultChatModel')).toBe('openai-compatible');
    });

    test('activeModelDefaults picks the model remembered for each role provider', () => {
        const modelDefaultsByApiType = {
            openrouter: getDefaultModelDefaults('openrouter'),
            'openai-compatible': {
                ...getDefaultModelDefaults('openai-compatible'),
                defaultChatModel: 'local-model',
            },
            anthropic: {
                ...getDefaultModelDefaults('anthropic'),
                defaultChatModel: 'claude-opus',
            },
        };
        const state = {
            aiApiType: 'openai-compatible' as const,
            roleApiTypes: { defaultChatModel: 'anthropic' as const },
            modelDefaultsByApiType,
        };

        const active = activeModelDefaults(state);
        expect(active.defaultChatModel).toBe('claude-opus');
        expect(active.summaryModel).toBe(modelDefaultsByApiType['openai-compatible'].summaryModel);
    });
});

describe('capability checks per provider', () => {
    test('anthropic never supports embeddings or image generation', () => {
        const config = normalizeAiApiConfig({});
        expect(supportsAiApiFeature(config, 'anthropic', 'embeddings')).toBe(false);
        expect(supportsAiApiFeature(config, 'anthropic', 'imageGeneration')).toBe(false);
    });

    test('openai-compatible honors its feature flags', () => {
        const config = normalizeAiApiConfig({
            openAiCompatibleEmbeddingsEnabled: false,
            openAiCompatibleImageGenerationEnabled: true,
        });
        expect(supportsAiApiFeature(config, 'openai-compatible', 'embeddings')).toBe(false);
        expect(supportsAiApiFeature(config, 'openai-compatible', 'imageGeneration')).toBe(true);
        expect(supportsAiApiFeature(config, 'openrouter', 'embeddings')).toBe(true);
    });
});

describe('entity provider overrides', () => {
    test('normalizeCharacters keeps a valid aiApiType and drops an invalid one', () => {
        const [kept, dropped] = normalizeCharacters([
            {
                id: 'character-1',
                name: '葵',
                systemPrompt: '',
                model: 'model-1',
                aiApiType: 'anthropic',
                createdAt: 1,
                updatedAt: 1,
            } as Character,
            {
                id: 'character-2',
                name: '蛍',
                systemPrompt: '',
                model: 'model-2',
                aiApiType: 'bogus',
                createdAt: 1,
                updatedAt: 1,
            } as Character,
        ], 'fallback-model');

        expect(kept.aiApiType).toBe('anthropic');
        expect(dropped.aiApiType).toBeUndefined();
    });

    test('normalizeSituationActor keeps aiApiType on temporary actors only', () => {
        const temporary = normalizeSituationActor({
            id: 'actor-1',
            type: 'temporary',
            name: '臨時',
            systemPrompt: '',
            aiApiType: 'openai-compatible',
        }, new Set(), 'fallback-model');
        expect(temporary).toMatchObject({ aiApiType: 'openai-compatible' });

        const invalid = normalizeSituationActor({
            id: 'actor-2',
            type: 'temporary',
            name: '臨時2',
            systemPrompt: '',
            aiApiType: 'bogus',
        }, new Set(), 'fallback-model');
        expect(invalid).not.toMatchObject({ aiApiType: expect.anything() });
    });

    test('normalizeSituationDirector keeps a valid aiApiType', () => {
        const director = normalizeSituationDirector({
            enabled: true,
            model: 'director-model',
            aiApiType: 'anthropic',
            maxAutoTurns: 3,
            stopPolicy: 'max-turns',
        }, 'fallback-model');
        expect(director.aiApiType).toBe('anthropic');

        const invalid = normalizeSituationDirector({
            enabled: true,
            model: 'director-model',
            aiApiType: 'bogus' as never,
            maxAutoTurns: 3,
            stopPolicy: 'max-turns',
        }, 'fallback-model');
        expect(invalid.aiApiType).toBeUndefined();
    });
});
