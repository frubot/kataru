import type { Message } from './store';

type AssistantEnvelope = {
    message: string;
    messages: string[];
    to: string[];
    thinking?: string;
    expression?: string;
};

type AssistantResponseFormat = {
    type: 'json_schema';
    json_schema: {
        name: string;
        strict: boolean;
        schema: {
            type: 'object';
            properties: Record<string, unknown>;
            required: string[];
            additionalProperties: boolean;
        };
    };
};

const NEUTRAL_EXPRESSION_NAME = 'neutral';

export type { AssistantEnvelope, AssistantResponseFormat };

function getDefaultExpressionName(expressionNames: string[]): string | undefined {
    return expressionNames.find((name) => name.toLowerCase() === NEUTRAL_EXPRESSION_NAME)
        ?? expressionNames[0];
}

function normalizeExpressionName(expression: string | undefined, expressionNames: string[]): string | undefined {
    if (expressionNames.length === 0) return undefined;
    if (!expression) return getDefaultExpressionName(expressionNames);

    const matched = expressionNames.find((name) => name.toLowerCase() === expression.trim().toLowerCase());
    return matched ?? getDefaultExpressionName(expressionNames);
}

export function buildAssistantResponseFormat(
    expressionNames?: string[],
    toNames?: string[],
    useMessageMode = false,
    useThinkMode = false,
): AssistantResponseFormat {
    const hasExpression = !!expressionNames && expressionNames.length > 0;
    const hasTo = !!toNames && toNames.length > 0;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    if (useThinkMode) {
        properties.thinking = {
            type: 'string',
        };
        required.push('thinking');
    }

    if (hasExpression) {
        properties.expression = {
            type: 'string',
            description: '今現在のキャラクターの表情。',
            enum: expressionNames,
        };
        required.push('expression');
    }

    if (useMessageMode) {
        properties.messages = {
            type: 'array',
            description: 'あなたの返答',
            minItems: 1,
            maxItems: 4,
            items: {
                type: 'string',
            },
        };
        required.push('messages');
    } else {
        properties.message = {
            type: 'string',
            description: 'あなたの返答',
        };
        required.push('message');
    }

    if (hasTo) {
        properties.to = {
            type: 'array',
            description: '今発言した内容に反応が欲しいキャラクターの名前。反応が不要な場合や、主人公宛のメッセージである場合は、空の配列を使用してください。',
            items: {
                type: 'string',
                enum: toNames,
            },
        };
        required.push('to');
    }

    return {
        type: 'json_schema',
        json_schema: {
            name: 'roleplay',
            strict: true,
            schema: {
                type: 'object',
                properties,
                required,
                additionalProperties: false,
            },
        },
    };
}

export function stripJsonCodeFence(content: string): string {
    const trimmed = content.trim();
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    return match ? match[1].trim() : trimmed;
}

function uniqueTrimmedStrings(values: string[]): string[] {
    const seen = new Set<string>();
    return values
        .map((value) => value.trim())
        .filter((value) => {
            if (!value || seen.has(value)) return false;
            seen.add(value);
            return true;
        });
}

function removeTrailingJsonCommas(source: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (inString) {
            result += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }

        if (char === ',') {
            let nextIndex = i + 1;
            while (/\s/.test(source[nextIndex] ?? '')) nextIndex++;
            if (source[nextIndex] === '}' || source[nextIndex] === ']') continue;
        }

        result += char;
    }

    return result;
}

function findJsonValueEnd(source: string, startIndex: number): number {
    const opening = source[startIndex];
    if (opening !== '{' && opening !== '[') return -1;

    const stack: string[] = [opening];
    let inString = false;
    let escaped = false;
    for (let i = startIndex + 1; i < source.length; i++) {
        const char = source[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '{' || char === '[') {
            stack.push(char);
        } else if (char === '}' || char === ']') {
            const expectedOpening = char === '}' ? '{' : '[';
            if (stack.pop() !== expectedOpening) return -1;
            if (stack.length === 0) return i + 1;
        }
    }

    return -1;
}

function parseJsonValue(source: string): unknown {
    try {
        return JSON.parse(source) as unknown;
    } catch {
        return JSON.parse(removeTrailingJsonCommas(source)) as unknown;
    }
}

function parseJsonFromText(content: string): unknown {
    const trimmed = stripJsonCodeFence(content);
    try {
        const parsed = parseJsonValue(trimmed);
        if (typeof parsed !== 'string') return parsed;

        const nested = stripJsonCodeFence(parsed);
        if (nested === parsed && !/^(?:\{|\[)/.test(nested)) return parsed;
        return parseJsonValue(nested);
    } catch {
        // Some models add a short explanation before or after an otherwise valid JSON value.
    }

    for (let i = 0; i < trimmed.length; i++) {
        if (trimmed[i] !== '{' && trimmed[i] !== '[') continue;
        const endIndex = findJsonValueEnd(trimmed, i);
        if (endIndex < 0) continue;
        try {
            return parseJsonValue(trimmed.slice(i, endIndex));
        } catch {
            // This balanced value was not JSON. Continue looking for the next candidate.
        }
    }

    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getRecordValue(record: Record<string, unknown>, names: string[]): unknown {
    for (const name of names) {
        if (name in record) return record[name];
    }

    const matchingEntry = Object.entries(record).find(([key]) =>
        names.some((name) => name.toLowerCase() === key.toLowerCase()),
    );
    return matchingEntry?.[1];
}

function unwrapAssistantRecord(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value)) return null;

    const responseKeys = ['message', 'messages', 'dialogue', 'content', 'text', 'reply', 'answer'];
    if (getRecordValue(value, responseKeys) !== undefined) return value;

    for (const wrapperName of ['response', 'result', 'data', 'output']) {
        const nested = getRecordValue(value, [wrapperName]);
        if (isRecord(nested) && getRecordValue(nested, responseKeys) !== undefined) return nested;
    }

    return value;
}

function parseMessageStrings(value: unknown): string[] {
    if (typeof value === 'string') return uniqueTrimmedStrings([value]);
    if (!Array.isArray(value)) return [];

    return uniqueTrimmedStrings(value.flatMap((item) => {
        if (typeof item === 'string') return [item];
        if (!isRecord(item)) return [];
        const text = getRecordValue(item, ['message', 'content', 'text', 'dialogue']);
        return typeof text === 'string' ? [text] : [];
    }));
}

function parseToNames(value: unknown): string[] {
    if (Array.isArray(value)) {
        return uniqueTrimmedStrings(value.filter((name): name is string => typeof name === 'string'));
    }
    if (typeof value === 'string') {
        return uniqueTrimmedStrings([value]);
    }
    return [];
}

function parseAssistantJson(content: string): Partial<AssistantEnvelope> | null {
    const parsed = parseJsonFromText(content);
    if (Array.isArray(parsed)) {
        const messages = parseMessageStrings(parsed);
        return messages.length > 0 ? { messages, to: [] } : null;
    }

    const record = unwrapAssistantRecord(parsed);
    if (!record) return null;

    const messageValue = getRecordValue(record, ['message', 'dialogue', 'content', 'text', 'reply', 'answer']);
    const messagesValue = getRecordValue(record, ['messages']);
    const messageStrings = parseMessageStrings(messageValue);
    const messages = parseMessageStrings(messagesValue);
    const to = parseToNames(getRecordValue(record, ['to', 'recipients', 'recipient']));
    const thinkingValue = getRecordValue(record, ['thinking', 'reasoning', 'thought']);
    const expressionValue = getRecordValue(record, ['expression', 'emotion']);

    return {
        message: messageStrings[0],
        messages,
        to,
        thinking: typeof thinkingValue === 'string' ? thinkingValue : undefined,
        expression: typeof expressionValue === 'string' ? expressionValue : undefined,
    };
}

function uniqueMemories(memories: string[]): string[] {
    return uniqueTrimmedStrings(memories);
}

export function parseAssistantResponse(
    content: string,
    expressionNames?: string[],
    useMessageMode = false,
    requireStructuredJson = false,
): AssistantEnvelope {
    const parsedJson = parseAssistantJson(content);
    if (requireStructuredJson && !parsedJson) {
        throw new Error('Assistant response was not a structured JSON object.');
    }
    const rawMessages = parsedJson
        ? useMessageMode
            ? parsedJson.messages?.length
                ? parsedJson.messages
                : parsedJson.message
                    ? [parsedJson.message]
                    : []
            : parsedJson.message
                ? [parsedJson.message]
                : parsedJson.messages ?? []
        : [content];
    const messages = rawMessages
        .map((rawMessage) => rawMessage.trim())
        .filter(Boolean);
    const normalizedMessages = messages.length > 0 ? messages : ['...'];
    const expression = normalizeExpressionName(
        parsedJson?.expression,
        expressionNames ?? [],
    );

    return {
        message: normalizedMessages.join('\n\n'),
        messages: normalizedMessages,
        to: uniqueTrimmedStrings(parsedJson?.to ?? []),
        ...(parsedJson?.thinking ? { thinking: parsedJson.thinking.trim() } : {}),
        ...(expression ? { expression } : {}),
    };
}

export function getMessageMemories(message: Pick<Message, 'content' | 'memories'>): string[] {
    return uniqueMemories(message.memories ?? []);
}
