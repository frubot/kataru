// These are pure tests for the legacy TypeScript helper. The production
// assistant-response path is implemented and tested in src/conversation/response.rs.
import { describe, expect, test } from 'vitest';

import {
    buildAssistantResponseFormat,
    parseAssistantResponse,
    stripJsonCodeFence,
} from '../lib/chatAssistantResponse';

describe('stripJsonCodeFence', () => {
    test('removes a json code fence and surrounding whitespace', () => {
        expect(stripJsonCodeFence('  ```json\n{"message":"こんにちは"}\n```  '))
            .toBe('{"message":"こんにちは"}');
    });

    test('leaves non-fenced content unchanged apart from trimming', () => {
        expect(stripJsonCodeFence('  {"message":"そのまま"}  '))
            .toBe('{"message":"そのまま"}');
    });
});

describe('parseAssistantResponse', () => {
    test('parses plain JSON and normalizes expression and recipients', () => {
        const result = parseAssistantResponse(
            JSON.stringify({
                message: '  こんにちは  ',
                expression: ' HAPPY ',
                to: [' ボブ ', 'ボブ', '', 42],
            }),
            ['neutral', 'Happy'],
        );

        expect(result).toEqual({
            message: 'こんにちは',
            messages: ['こんにちは'],
            expression: 'Happy',
            to: ['ボブ'],
        });
    });

    test('accepts JSON inside a code fence and explanatory text', () => {
        const result = parseAssistantResponse(
            '回答は次の通りです。\n```json\n{"message":"コードフェンス内"}\n```\n補足です。',
        );

        expect(result.message).toBe('コードフェンス内');
        expect(result.messages).toEqual(['コードフェンス内']);
    });

    test('finds a JSON object surrounded by prose', () => {
        const result = parseAssistantResponse(
            'ここから回答です: {"message":"前後説明付き"} 以上です。',
        );

        expect(result.messages).toEqual(['前後説明付き']);
    });

    test('accepts trailing commas in objects and arrays', () => {
        const result = parseAssistantResponse(
            '{"messages":["一","二",],"to":["ボブ",],}',
            undefined,
            true,
        );

        expect(result.message).toBe('一\n\n二');
        expect(result.messages).toEqual(['一', '二']);
        expect(result.to).toEqual(['ボブ']);
    });

    test('uses messages in message mode and message in single-message mode', () => {
        const content = JSON.stringify({
            message: '単一フィールド',
            messages: ['一つ目', '二つ目'],
        });

        expect(parseAssistantResponse(content, undefined, true).messages)
            .toEqual(['一つ目', '二つ目']);
        expect(parseAssistantResponse(content, undefined, false).messages)
            .toEqual(['単一フィールド']);
    });

    test('falls back to the raw content or an ellipsis for broken input', () => {
        expect(parseAssistantResponse('JSONではない返答', ['neutral', 'happy']))
            .toEqual({
                message: 'JSONではない返答',
                messages: ['JSONではない返答'],
                expression: 'neutral',
                to: [],
            });
        expect(parseAssistantResponse('   ', ['neutral']).messages).toEqual(['...']);
        expect(parseAssistantResponse('{"unexpected":true}', undefined, false, true).message)
            .toBe('...');
        expect(() => parseAssistantResponse('JSONではない返答', undefined, false, true))
            .toThrow('structured JSON object');
    });

    test('falls back to neutral when an unknown expression is returned', () => {
        const result = parseAssistantResponse(
            '{"message":"返答","expression":"unknown"}',
            ['neutral', 'happy'],
        );

        expect(result.expression).toBe('neutral');
    });
});

test('buildAssistantResponseFormat describes expression, messages, and recipients', () => {
    const format = buildAssistantResponseFormat(['neutral', 'happy'], ['ボブ'], true);
    const schema = format.json_schema.schema;

    expect(schema.required).toEqual(['expression', 'messages', 'to']);
    expect(schema.properties.expression).toEqual(expect.objectContaining({
        type: 'string',
        enum: ['neutral', 'happy'],
    }));
    expect(schema.properties.messages).toEqual(expect.objectContaining({
        type: 'array',
        minItems: 1,
        maxItems: 4,
    }));
    expect(schema.properties.to).toEqual(expect.objectContaining({
        type: 'array',
    }));
});
