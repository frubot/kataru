/** 自動再試行の待ち時間（ミリ秒）。要素数が最大試行回数になる。 */
export const CHAT_AUTO_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000];

export type ChatAutoRetryPlan = {
    /** これから行う試行が何回目か（1始まり）。 */
    attempt: number;
    maxAttempts: number;
    delayMs: number;
};

/**
 * 直前までの自動再試行回数から次の試行計画を返す。
 * 上限に達した場合や無効な場合は undefined を返し、手動の再試行に任せる。
 */
export function getChatAutoRetryPlan(
    previousAttempts: number,
    enabled: boolean,
    delaysMs: readonly number[] = CHAT_AUTO_RETRY_DELAYS_MS,
): ChatAutoRetryPlan | undefined {
    if (!enabled) return undefined;
    const attemptIndex = Number.isFinite(previousAttempts) ? Math.max(0, Math.floor(previousAttempts)) : 0;
    const delayMs = delaysMs[attemptIndex];
    if (delayMs == null) return undefined;
    return {
        attempt: attemptIndex + 1,
        maxAttempts: delaysMs.length,
        delayMs,
    };
}

export function formatChatAutoRetryNotice(message: string, plan: ChatAutoRetryPlan): string {
    const seconds = Math.ceil(plan.delayMs / 1000);
    return `${message}（${seconds}秒後に自動で再試行 ${plan.attempt}/${plan.maxAttempts}）`;
}
