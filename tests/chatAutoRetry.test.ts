import { expect, test } from 'vitest';

import { formatChatAutoRetryNotice, getChatAutoRetryPlan } from '../lib/chatAutoRetry';

test('returns no plan when auto retry is disabled', () => {
    expect(getChatAutoRetryPlan(0, false)).toBeUndefined();
});

test('plans attempts in order until the limit is reached', () => {
    const delays = [100, 200];
    expect(getChatAutoRetryPlan(0, true, delays)).toEqual({ attempt: 1, maxAttempts: 2, delayMs: 100 });
    expect(getChatAutoRetryPlan(1, true, delays)).toEqual({ attempt: 2, maxAttempts: 2, delayMs: 200 });
    expect(getChatAutoRetryPlan(2, true, delays)).toBeUndefined();
});

test('treats invalid attempt counts as the first attempt', () => {
    expect(getChatAutoRetryPlan(Number.NaN, true, [100])?.attempt).toBe(1);
    expect(getChatAutoRetryPlan(-3, true, [100])?.attempt).toBe(1);
});

test('formats the notice with remaining seconds and attempt count', () => {
    expect(formatChatAutoRetryNotice('混雑しています。', { attempt: 1, maxAttempts: 3, delayMs: 1500 }))
        .toBe('混雑しています。（2秒後に自動で再試行 1/3）');
});
