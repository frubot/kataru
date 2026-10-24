import { describe, expect, test } from 'vitest';

import {
    DEFAULT_ANTHROPIC_TEXT_MODEL,
    getDefaultModelDefaults,
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
    test('leaves the defaults alone when nothing is configured', () => {
        const defaults = getDefaultModelDefaults();

        const result = rebaseModelDefaults(defaults, []);

        expect(result.defaults).toBe(defaults);
        expect(result.changedRoles).toEqual([]);
    });

    test('keeps OpenRouter defaults when OpenRouter is configured', () => {
        const defaults = getDefaultModelDefaults();

        const result = rebaseModelDefaults(defaults, [openrouter, anthropic]);

        expect(result.defaults).toBe(defaults);
        expect(result.changedRoles).toEqual([]);
    });

    test('moves text roles to Anthropic and leaves capability-only roles on OpenRouter', () => {
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
        // 画像・埋め込み・判定はAnthropicでは提供されないので、遷移先が無い。
        expect(result.defaults.defaultImageModel.connectionId).toBe('openrouter');
        expect(result.defaults.memoryEmbeddingModel.connectionId).toBe('openrouter');
        expect(result.defaults.memoryGateModel.connectionId).toBe('openrouter');
        expect(result.changedRoles).toHaveLength(8);
    });

    test('moves text roles to a local compatible server without inventing a model name', () => {
        const result = rebaseModelDefaults(getDefaultModelDefaults(), [localServer]);

        expect(result.defaults.defaultChatModel).toEqual({
            connectionId: 'cx_local',
            model: '',
        });
        expect(result.defaults.memoryGateModel.connectionId).toBe('openrouter');
        expect(result.defaults.defaultImageModel.connectionId).toBe('openrouter');
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
        // TypeSafeはテキスト生成を提供しないので、他は遷移先が無い。
        expect(result.defaults.defaultChatModel.connectionId).toBe('openrouter');
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

    test('ignores TTS-only connections', () => {
        const voicevox = connection('voicevox', 'voicevox', { apiKey: { configured: false } });
        const irodori = connection('irodori', 'irodori', { apiKey: { configured: false } });

        const result = rebaseModelDefaults(getDefaultModelDefaults(), [voicevox, irodori]);

        expect(result.changedRoles).toEqual([]);
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

    test('normalizeModelDefaults keeps an unset model instead of restoring the OpenRouter name', () => {
        const defaults = normalizeModelDefaults({
            defaultChatModel: { connectionId: 'cx_local', model: '' },
        });

        expect(defaults.defaultChatModel).toEqual({ connectionId: 'cx_local', model: '' });
        // 未設定のエントリは従来どおり既定で補われる。
        expect(defaults.summaryModel).toEqual(getDefaultModelDefaults().summaryModel);
    });
});
