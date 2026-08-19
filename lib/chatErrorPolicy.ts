export type ChatRequestPhase = 'submit' | 'poll' | 'cancel' | 'list';
export type ChatErrorSource = 'request' | 'job' | 'other';

export type ChatErrorPolicyInput = {
    status?: number;
    detail?: string;
    phase?: ChatRequestPhase;
    source?: ChatErrorSource;
};

export type ChatErrorClassification = 'rate-limit' | 'context-length' | 'authentication' | 'timeout' | 'other';

export type ChatErrorPolicy = {
    classification: ChatErrorClassification;
    retryable: boolean;
    action?: 'retry' | 'open-settings';
};

const RATE_LIMIT_PATTERN = /rate limit|too many requests|tokens?\s+per\s+(?:min(?:ute)?|hour|sec(?:ond)?)|\bTPM\b|\bRPM\b|requests?\s+per\s+(?:min(?:ute)?|hour|sec(?:ond)?)/i;
const EXPLICIT_CONTEXT_PATTERN = /context[_\s-]?length|context[_\s-]?(?:window|size|limit)|maximum context|(?:max(?:imum)?)[ -]*(?:context|input|prompt)[ -]*(?:length|size|window|limit|tokens?)|(?:input|prompt)[ -]*(?:tokens?|length)[ -]*(?:limit|maximum)|(?:prompt|input)[^\n]{0,40}too (?:long|large)|(?:too (?:long|large))[^\n]{0,40}(?:prompt|input)|コンテキスト[^\n]{0,30}(?:超過|上限|長すぎ|大きすぎ)|トークン(?:数)?[^\n]{0,30}(?:超過|上限|多すぎ|長すぎ|大きすぎ)/i;
const BROAD_CONTEXT_PATTERN = /too many(?: input)? tokens?|token limit|(?:prompt|input)[^\n]{0,40}(?:too long|too large)/i;
const AUTHENTICATION_PATTERN = /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api|access) key|authentication (?:failed|error)|permission denied|認証(?:に失敗|エラー)|アクセス(?:権限|が拒否)/i;
const TIMEOUT_PATTERN = /aborted|abort|timeout|timed out|network connection was lost|cancel|時間切れ|中断/i;
const RETRYABLE_JOB_PATTERN = /\b(?:408|429|499|5\d{2})\b|timeout|timed out|aborted|temporar|rate limit|too many requests|server|upstream|network|connection|通信|時間切れ|中断/i;

function getStatusClassification(status?: number): ChatErrorClassification | undefined {
    if (status === 401 || status === 403) return 'authentication';
    if (status === 429) return 'rate-limit';
    if (status === 413) return 'context-length';
    return undefined;
}

export function isRateLimitError(input: ChatErrorPolicyInput): boolean {
    if (input.status === 401 || input.status === 403 || input.status === 413) return false;
    return input.status === 429 || RATE_LIMIT_PATTERN.test(input.detail ?? '');
}

export function isContextLengthError(input: ChatErrorPolicyInput): boolean {
    if (input.status === 401 || input.status === 403 || input.status === 429) return false;
    if (input.status === 413) return true;

    // A provider may mention tokens while reporting a TPM/RPM limit. Rate limiting
    // wins over body-based context classification when no stronger status applies.
    if (isRateLimitError(input)) return false;
    if (EXPLICIT_CONTEXT_PATTERN.test(input.detail ?? '')) return true;
    if (input.status !== 400) return false;
    return BROAD_CONTEXT_PATTERN.test(input.detail ?? '');
}

export function isAuthenticationError(input: ChatErrorPolicyInput): boolean {
    if (input.status === 401 || input.status === 403) return true;
    if (input.status === 429 || input.status === 413) return false;
    return AUTHENTICATION_PATTERN.test(input.detail ?? '');
}

export function isTimeoutOrAbortError(input: ChatErrorPolicyInput): boolean {
    if (getStatusClassification(input.status)) return false;
    return (input.status != null && [408, 499, 504].includes(input.status))
        || TIMEOUT_PATTERN.test(input.detail ?? '');
}

export function isRetryableGenerationError(input: ChatErrorPolicyInput): boolean {
    const classification = classifyChatError(input);
    if (classification === 'context-length' || classification === 'authentication') return false;

    if (input.source === 'request' && input.phase === 'submit') {
        return classification === 'rate-limit'
            || classification === 'timeout'
            || (input.status != null && input.status >= 500);
    }

    if (input.source === 'job') {
        return classification === 'rate-limit'
            || classification === 'timeout'
            || RETRYABLE_JOB_PATTERN.test(input.detail ?? '');
    }

    return false;
}

export function classifyChatError(input: ChatErrorPolicyInput): ChatErrorClassification {
    const statusClassification = getStatusClassification(input.status);
    if (statusClassification) return statusClassification;
    if (isRateLimitError(input)) return 'rate-limit';
    if (isContextLengthError(input)) return 'context-length';
    if (isAuthenticationError(input)) return 'authentication';
    if (isTimeoutOrAbortError(input)) return 'timeout';
    return 'other';
}

export function getChatErrorPolicy(input: ChatErrorPolicyInput): ChatErrorPolicy {
    const classification = classifyChatError(input);
    const retryable = isRetryableGenerationError(input);
    return {
        classification,
        retryable,
        ...(classification === 'authentication'
            ? { action: 'open-settings' as const }
            : retryable
                ? { action: 'retry' as const }
                : {}),
    };
}

export function shouldAutoHideChatNotice(action?: 'retry' | 'open-settings'): boolean {
    return action == null;
}
