/**
 * メッセージモードで、現実の日時を会話に使うときに出す送信時刻と日付の区切り。
 *
 * - 日付が変わった最初のメッセージの上に日付の区切りを出す。
 * - 送信時刻は、同じ送り手が同じ分に続けて送ったまとまりの最後にだけ出す。
 */

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type TimelineMessage = {
    id: string;
    role: 'user' | 'assistant';
    characterId?: string;
    timestamp: number;
    mergedIntoPrevious?: boolean;
};

export type MessageTimeLabels = {
    /** このメッセージの上に出す日付の区切り。 */
    dateLabel?: string;
    /** このメッセージの下に出す送信時刻。 */
    timeLabel?: string;
};

function localDayNumber(time: number): number {
    const date = new Date(time);
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function minuteKey(time: number): number {
    return Math.floor(time / 60_000);
}

export function formatMessageDateLabel(time: number, now: number): string {
    const dayDiff = localDayNumber(now) - localDayNumber(time);
    if (dayDiff === 0) return '今日';
    if (dayDiff === 1) return '昨日';
    const date = new Date(time);
    const monthDay = `${date.getMonth() + 1}月${date.getDate()}日(${WEEKDAYS[date.getDay()]})`;
    return date.getFullYear() === new Date(now).getFullYear()
        ? monthDay
        : `${date.getFullYear()}年${monthDay}`;
}

export function formatMessageTimeLabel(time: number): string {
    const date = new Date(time);
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function hasTimestamp(message: TimelineMessage): boolean {
    return Number.isFinite(message.timestamp) && message.timestamp > 0;
}

function sameSender(left: TimelineMessage, right: TimelineMessage): boolean {
    return left.role === right.role && (left.role === 'user' || left.characterId === right.characterId);
}

/** 表示するメッセージ（表示順）ごとの日付の区切りと送信時刻。 */
export function buildMessageTimeLabels(
    messages: readonly TimelineMessage[],
    now: number = Date.now(),
): Map<string, MessageTimeLabels> {
    const visible = messages.filter((message) => !message.mergedIntoPrevious);
    const labels = new Map<string, MessageTimeLabels>();
    let previousDay: number | null = null;
    visible.forEach((message, index) => {
        if (!hasTimestamp(message)) return;
        const entry: MessageTimeLabels = {};
        const day = localDayNumber(message.timestamp);
        if (day !== previousDay) {
            entry.dateLabel = formatMessageDateLabel(message.timestamp, now);
            previousDay = day;
        }
        const next = visible[index + 1];
        const continuesGroup = next
            && hasTimestamp(next)
            && sameSender(message, next)
            && minuteKey(next.timestamp) === minuteKey(message.timestamp);
        if (!continuesGroup) entry.timeLabel = formatMessageTimeLabel(message.timestamp);
        if (entry.dateLabel || entry.timeLabel) labels.set(message.id, entry);
    });
    return labels;
}
