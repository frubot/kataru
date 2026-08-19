import { expect, test } from 'vitest';

import {
    classifyChatError,
    getChatErrorPolicy,
    isContextLengthError,
    isRateLimitError,
    shouldAutoHideChatNotice,
} from '../lib/chatErrorPolicy';

test('classifies TPM wording at 429 as rate limiting, not context overflow', () => {
    const input = {
        status: 429,
        detail: 'Request too large for this endpoint: 120000 tokens per min (TPM): Limit 100000',
        source: 'request',
        phase: 'submit',
    };

    expect(isRateLimitError(input)).toBe(true);
    expect(isContextLengthError(input)).toBe(false);
    expect(classifyChatError(input)).toBe('rate-limit');
    expect(getChatErrorPolicy(input).retryable).toBe(true);
    expect(getChatErrorPolicy(input).action).toBe('retry');
});

test('classifies RPM wording at 429 as retryable rate limiting', () => {
    const policy = getChatErrorPolicy({
        status: 429,
        detail: 'Too many requests: 120 requests per min (RPM), limit 60',
        source: 'job',
    });

    expect(policy.classification).toBe('rate-limit');
    expect(policy.retryable).toBe(true);
    expect(policy.action).toBe('retry');
});

test('HTTP 401 and 403 keep authentication priority over rate-limit wording', () => {
    const invalidKeyPolicy = getChatErrorPolicy({
        status: 401,
        detail: 'Invalid API key; rate limit metadata unavailable',
        source: 'request',
        phase: 'submit',
    });
    const forbiddenPolicy = getChatErrorPolicy({
        status: 403,
        detail: 'Forbidden from reading RPM rate limit',
        source: 'request',
        phase: 'submit',
    });

    for (const policy of [invalidKeyPolicy, forbiddenPolicy]) {
        expect(policy.classification).toBe('authentication');
        expect(policy.retryable).toBe(false);
        expect(policy.action).toBe('open-settings');
    }
});

test('HTTP 413 keeps context priority over TPM rate-limit wording', () => {
    const input = {
        status: 413,
        detail: 'Request too large: TPM rate limit metadata unavailable',
        source: 'request',
        phase: 'submit',
    };
    const policy = getChatErrorPolicy(input);

    expect(isRateLimitError(input)).toBe(false);
    expect(isContextLengthError(input)).toBe(true);
    expect(policy.classification).toBe('context-length');
    expect(policy.retryable).toBe(false);
    expect(policy.action).toBeUndefined();
});

test('classifies an ordinary 400 context error without offering retry', () => {
    const policy = getChatErrorPolicy({
        status: 400,
        detail: 'context_length_exceeded: maximum context length is 128000 tokens',
        source: 'request',
        phase: 'submit',
    });

    expect(policy.classification).toBe('context-length');
    expect(policy.retryable).toBe(false);
    expect(policy.action).toBeUndefined();
});

test('keeps generic token wording out of context classification unless it is a 400', () => {
    expect(isContextLengthError({ status: 500, detail: 'too many tokens' })).toBe(false);
    expect(isContextLengthError({ status: 400, detail: 'too many tokens' })).toBe(true);
});

test('body-only auth errors offer settings and are not retryable', () => {
    const policy = getChatErrorPolicy({
        detail: 'Invalid API key',
        source: 'request',
        phase: 'submit',
    });

    expect(policy.classification).toBe('authentication');
    expect(policy.retryable).toBe(false);
    expect(policy.action).toBe('open-settings');
});

test('only actionless notices auto-hide', () => {
    expect(shouldAutoHideChatNotice()).toBe(true);
    expect(shouldAutoHideChatNotice('retry')).toBe(false);
    expect(shouldAutoHideChatNotice('open-settings')).toBe(false);
});
