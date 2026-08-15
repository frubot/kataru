import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAiSettingsMigration } from '../lib/aiSettingsMigration.ts';

const fields = [
    'summaryModel',
    'defaultChatModel',
    'defaultDirectorModel',
    'defaultAutoGenerationModel',
    'titleGenerationModel',
    'replySuggestionModel',
    'defaultImageModel',
    'memoryExtractionModel',
    'memoryEmbeddingModel',
];

function defaults(prefix) {
    return Object.fromEntries(fields.map((field) => [field, `${prefix}-${field}`]));
}

const defaultModelDefaultsByApiType = {
    openrouter: defaults('default-openrouter'),
    'openai-compatible': defaults('default-openai'),
    anthropic: defaults('default-anthropic'),
};

function migrate(overrides = {}) {
    return resolveAiSettingsMigration({
        canonicalAiApiType: undefined,
        legacyAiProvider: undefined,
        canonicalModelDefaultsByApiType: undefined,
        legacyModelDefaultsByProvider: undefined,
        defaultAiApiType: 'openrouter',
        defaultModelDefaultsByApiType,
        storedSchemaVersion: 2,
        currentSchemaVersion: 2,
        ...overrides,
    });
}

test('migrates legacy aiProvider to aiApiType and advances the schema version', () => {
    const result = migrate({
        legacyAiProvider: 'anthropic',
        storedSchemaVersion: 1,
    });

    assert.equal(result.aiApiType, 'anthropic');
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.shouldPersistAiApiType, true);
    assert.equal(result.shouldPersistSchemaVersion, true);
});

test('keeps each API type model defaults from modelDefaultsByProvider', () => {
    const result = migrate({
        legacyModelDefaultsByProvider: {
            openrouter: { summaryModel: 'legacy-openrouter-summary' },
            'openai-compatible': { defaultChatModel: 'legacy-openai-chat' },
            anthropic: { memoryExtractionModel: 'legacy-anthropic-memory' },
        },
    });

    assert.equal(result.modelDefaultsByApiType.openrouter.summaryModel, 'legacy-openrouter-summary');
    assert.equal(result.modelDefaultsByApiType['openai-compatible'].defaultChatModel, 'legacy-openai-chat');
    assert.equal(result.modelDefaultsByApiType.anthropic.memoryExtractionModel, 'legacy-anthropic-memory');
});

test('prefers canonical values over conflicting legacy values', () => {
    const result = migrate({
        canonicalAiApiType: 'anthropic',
        legacyAiProvider: 'openai-compatible',
        canonicalModelDefaultsByApiType: {
            openrouter: { summaryModel: 'canonical-summary' },
        },
        legacyModelDefaultsByProvider: {
            openrouter: { summaryModel: 'legacy-summary' },
        },
    });

    assert.equal(result.aiApiType, 'anthropic');
    assert.equal(result.modelDefaultsByApiType.openrouter.summaryModel, 'canonical-summary');
    assert.equal(result.shouldPersistAiApiType, false);
});

test('merges canonical and legacy model defaults field by field', () => {
    const result = migrate({
        canonicalModelDefaultsByApiType: {
            openrouter: { summaryModel: 'canonical-summary' },
        },
        legacyModelDefaultsByProvider: {
            openrouter: { defaultChatModel: 'legacy-chat' },
        },
    });

    assert.equal(result.modelDefaultsByApiType.openrouter.summaryModel, 'canonical-summary');
    assert.equal(result.modelDefaultsByApiType.openrouter.defaultChatModel, 'legacy-chat');
    assert.equal(result.shouldPersistModelDefaultsByApiType, true);
});

test('falls back safely for broken values and unknown API types', () => {
    const result = migrate({
        canonicalAiApiType: 'unknown',
        legacyAiProvider: 'also-unknown',
        canonicalModelDefaultsByApiType: {
            openrouter: { summaryModel: 42 },
            unknown: { summaryModel: 'must-not-be-added' },
        },
    });

    assert.equal(result.aiApiType, 'openrouter');
    assert.equal(result.modelDefaultsByApiType.openrouter.summaryModel, 'default-openrouter-summaryModel');
    assert.equal('unknown' in result.modelDefaultsByApiType, false);
});

test('does not resave canonical settings merely because legacy keys remain', () => {
    const canonicalModelDefaultsByApiType = {
        openrouter: defaults('canonical-openrouter'),
        'openai-compatible': defaults('canonical-openai'),
        anthropic: defaults('canonical-anthropic'),
    };
    const result = migrate({
        canonicalAiApiType: 'openrouter',
        legacyAiProvider: 'anthropic',
        canonicalModelDefaultsByApiType,
        legacyModelDefaultsByProvider: {
            openrouter: { summaryModel: 'old-summary' },
        },
    });

    assert.equal(result.shouldPersistAiApiType, false);
    assert.equal(result.shouldPersistModelDefaultsByApiType, false);
    assert.equal(result.shouldPersistSchemaVersion, false);
});
