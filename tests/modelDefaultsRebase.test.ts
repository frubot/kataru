import { describe, expect, test } from 'vitest';

import {
    DEFAULT_ANTHROPIC_TEXT_MODEL,
    getDefaultModelDefaults,
    isEmptyModelRef,
    MODEL_DEFAULT_FIELDS,
    normalizeModelDefaults,
    normalizeModelRef,
    rebaseModelDefaults,
    type RebaseConnection,
} from '../lib/modelDefaults';

function connection(
    id: string,
    kind: RebaseConnection['kind'],
    overrides: Partial<RebaseConnection> = {},
): RebaseConnection {
    return {
        id,
        kind,
        apiKey: { configured: true },
        baseUrlSource: 'default',
        embeddingsEnabled: true,
        imageGenerationEnabled: false,
        ...overrides,
    };
}

const openrouter = connection('openrouter', 'openrouter');
const anthropic = connection('anthropic', 'anthropic');
const localServer = connection('cx_local', 'openai-compatible', {
    apiKey: { configured: false },
    baseUrlSource: 'stored',
});

describe('rebaseModelDefaults', () => {
    test('clears every role when nothing is configured', () => {
        const result = rebaseModelDefaults(getDefaultModelDefaults(), []);

        for (const role of MODEL_DEFAULT_FIELDS) {
            expect(isEmptyModelRef(result.defaults[role])).toBe(true);
        }
        expect(result.changedRoles).toEqual([...MODEL_DEFAULT_FIELDS]);
    });

    test('keeps OpenRouter defaults when OpenRouter is configured', () => {
        const defaults = getDefaultModelDefaults();

        const result = rebaseModelDefaults(defaults, [openrouter, anthropic]);

        expect(result.defaults).toBe(defaults);
        expect(result.changedRoles).toEqual([]);
    });

    test('moves text roles to Anthropic and clears capability-only roles', () => {
        const result = rebaseModelDefaults(getDefaultModelDefaults(), [anthropic]);

        for (const role of [
            'summaryModel',
            'defaultChatModel',
            'defaultDirectorModel',
            'defaultAutoGenerationModel',
            'titleGenerationModel',
            'replySuggestionModel',
            'expressionDetectionModel',
            'memoryExtractionModel',
        ] as const) {
            expect(result.defaults[role]).toEqual({
                connectionId: 'anthropic',
                model: DEFAULT_ANTHROPIC_TEXT_MODEL,
            });
        }
        // 画像・埋め込み・判定はAnthropicでは提供されないので空にする。
        expect(isEmptyModelRef(result.defaults.defaultImageModel)).toBe(true);
        expect(isEmptyModelRef(result.defaults.memoryEmbeddingModel)).toBe(true);
        expect(isEmptyModelRef(result.defaults.memoryGateModel)).toBe(true);
        expect(result.changedRoles).toHaveLength(11);
    });

    test('moves supported roles to a local compatible server without inventing a model name', () => {
        const result = rebaseModelDefaults(getDefaultModelDefaults(), [localServer]);

        expect(result.defaults.defaultChatModel).toEqual({
            connectionId: 'cx_local',
            model: '',
        });
        // 互換サーバーは埋め込みに対応しているが、画像生成と判定は未対応。
        expect(result.defaults.memoryEmbeddingModel).toEqual({
            connectionId: 'cx_local',
            model: '',
        });
        expect(isEmptyModelRef(result.defaults.memoryGateModel)).toBe(true);
        expect(isEmptyModelRef(result.defaults.defaultImageModel)).toBe(true);
    });

    test('uses compatible-server capabilities for image and embedding roles', () => {
        const imageAndEmbeddingServer = connection('cx_media', 'openai-compatible', {
            apiKey: { configured: false },
            baseUrlSource: 'stored',
            imageGenerationEnabled: true,
            embeddingsEnabled: true,
        });

        const result = rebaseModelDefaults(getDefaultModelDefaults(), [imageAndEmbeddingServer]);

        expect(result.defaults.defaultImageModel).toEqual({
            connectionId: 'cx_media',
            model: '',
        });
        expect(result.defaults.memoryEmbeddingModel).toEqual({
            connectionId: 'cx_media',
            model: '',
        });
    });

    test('moves only the decisions role to TypeSafe', () => {
        const typesafe = connection('typesafe', 'typesafe');

        const result = rebaseModelDefaults(getDefaultModelDefaults(), [typesafe]);

        expect(result.defaults.memoryGateModel).toEqual({
            connectionId: 'typesafe',
            model: 'jev-latest',
        });
        // TypeSafeはテキスト生成・画像・埋め込みを提供しないので、他は空になる。
        expect(isEmptyModelRef(result.defaults.defaultChatModel)).toBe(true);
        expect(isEmptyModelRef(result.defaults.defaultImageModel)).toBe(true);
        expect(isEmptyModelRef(result.defaults.memoryEmbeddingModel)).toBe(true);
    });

    test('does not treat a listed built-in without a key as usable', () => {
        const renamedButKeyless = connection('openrouter', 'openrouter', {
            apiKey: { configured: false },
        });

        const result = rebaseModelDefaults(getDefaultModelDefaults(), [renamedButKeyless, anthropic]);

        expect(result.defaults.defaultChatModel).toEqual({
            connectionId: 'anthropic',
            model: DEFAULT_ANTHROPIC_TEXT_MODEL,
        });
    });

    test('keeps an explicit choice on a configured connection', () => {
        const defaults = {
            ...getDefaultModelDefaults(),
            defaultChatModel: { connectionId: 'cx_local', model: 'local-model' },
        };

        const result = rebaseModelDefaults(defaults, [localServer]);

        expect(result.defaults.defaultChatModel).toEqual({
            connectionId: 'cx_local',
            model: 'local-model',
        });
    });

    test('treats TTS-only connections as no configuration', () => {
        const voicevox = connection('voicevox', 'voicevox', { apiKey: { configured: false } });
        const irodori = connection('irodori', 'irodori', { apiKey: { configured: false } });

        const result = rebaseModelDefaults(getDefaultModelDefaults(), [voicevox, irodori]);

        for (const role of MODEL_DEFAULT_FIELDS) {
            expect(isEmptyModelRef(result.defaults[role])).toBe(true);
        }
        expect(result.changedRoles).toHaveLength(11);
    });

    test('fills cleared roles once a capable connection is configured', () => {
        const cleared = rebaseModelDefaults(getDefaultModelDefaults(), []).defaults;

        const result = rebaseModelDefaults(cleared, [openrouter]);

        expect(result.defaults).toEqual(getDefaultModelDefaults());
        expect(result.changedRoles).toHaveLength(11);
    });

    test('is idempotent', () => {
        const first = rebaseModelDefaults(getDefaultModelDefaults(), [localServer]);
        const second = rebaseModelDefaults(first.defaults, [localServer]);

        expect(second.changedRoles).toEqual([]);
        expect(second.defaults).toBe(first.defaults);
    });
});

describe('unset model names', () => {
    test('normalizeModelRef keeps an explicitly empty model', () => {
        expect(normalizeModelRef(
            { connectionId: 'cx_local', model: '' },
            { connectionId: 'openrouter', model: 'z-ai/glm-5.2' },
        )).toEqual({ connectionId: 'cx_local', model: '' });
    });

    test('normalizeModelRef keeps an explicitly empty connection instead of restoring OpenRouter', () => {
        expect(normalizeModelRef(
            { connectionId: '', model: '' },
            { connectionId: 'openrouter', model: 'z-ai/glm-5.2' },
        )).toEqual({ connectionId: '', model: '' });
    });

    test('normalizeModelDefaults keeps an unset model instead of restoring the OpenRouter name', () => {
        const defaults = normalizeModelDefaults({
            defaultChatModel: { connectionId: 'cx_local', model: '' },
        });

        expect(defaults.defaultChatModel).toEqual({ connectionId: 'cx_local', model: '' });
        // 未設定のエントリは従来どおり既定で補われる。
        expect(defaults.summaryModel).toEqual(getDefaultModelDefaults().summaryModel);
    });
});
