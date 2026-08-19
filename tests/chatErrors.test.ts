import { describe, expect, test } from 'vitest';

import {
    ChatGenerationJobError,
    ChatRequestError,
    getChatErrorNotice,
    isRetryableGenerationError,
    shouldOpenSettingsForChatError,
} from '../lib/chatErrors';

describe('chat errors', () => {
    test('keeps authentication priority over rate-limit wording', () => {
        const error = new ChatRequestError(401, 'Invalid API key; rate limit metadata unavailable');
        expect(shouldOpenSettingsForChatError(error)).toBe(true);
        expect(isRetryableGenerationError(error)).toBe(false);
        expect(getChatErrorNotice(error, false)).toContain('API認証');
    });

    test('offers retry for request rate limits', () => {
        const error = new ChatRequestError(429, 'TPM rate limit', undefined, undefined, undefined, 'submit');
        expect(isRetryableGenerationError(error)).toBe(true);
        expect(getChatErrorNotice(error, false)).toContain('利用上限');
    });

    test('classifies job timeouts as retryable', () => {
        const error = new ChatGenerationJobError('generation timeout');
        expect(isRetryableGenerationError(error)).toBe(true);
        expect(getChatErrorNotice(error, false)).toContain('時間切れ');
    });
});
