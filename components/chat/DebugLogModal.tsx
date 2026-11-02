import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { Loader2, Trash2, X } from 'lucide-react';
import { backgroundTaskKindLabel, type BackgroundTask } from '@/lib/backgroundTasks';
import type { DebugLogUsage, FullJsonDebugLog, Room } from '@/lib/store';
import { useModalKeyboard } from '../useModalKeyboard';

const metaChipStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    padding: '0.125rem 0.4375rem',
    borderRadius: '999px',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-tertiary)',
    fontSize: '0.6875rem',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap',
};

function formatCount(value: number): string {
    return value.toLocaleString();
}

function formatCost(cost: number): string {
    return `$${cost.toFixed(6)}`;
}

function formatDuration(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} ms`;
}

/** 使用量をチップ表示用の文字列へ整える。サーバーが返さなかった項目は出さない。 */
function usageLabels(usage: DebugLogUsage | undefined): string[] {
    if (!usage) return [];
    const labels: string[] = [];
    const promptTokens = usage.promptTokens ?? 0;
    const completionTokens = usage.completionTokens ?? 0;
    const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
    if (promptTokens > 0 || completionTokens > 0 || totalTokens > 0) {
        labels.push(
            `入力 ${formatCount(promptTokens)} / 出力 ${formatCount(completionTokens)} / 計 ${formatCount(totalTokens)} トークン${usage.estimated ? '（推定）' : ''}`,
        );
    }
    if (usage.tokensPerSecond != null) {
        labels.push(`${usage.tokensPerSecond.toLocaleString()} tok/s`);
    }
    if (usage.promptTokensPerSecond != null) {
        labels.push(`プロンプト ${usage.promptTokensPerSecond.toLocaleString()} tok/s`);
    }
    if (usage.timeToFirstTokenMs != null) {
        labels.push(`初回 ${formatDuration(usage.timeToFirstTokenMs)}`);
    }
    if (usage.cost != null && usage.cost > 0) {
        labels.push(formatCost(usage.cost));
    }
    return labels;
}

function MetaChips({ labels, prefix }: { labels: string[]; prefix?: string }) {
    if (labels.length === 0) return null;
    return (
        <>
            {prefix ? (
                <span style={{ fontSize: '0.6875rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                    {prefix}
                </span>
            ) : null}
            {labels.map((label) => (
                <span key={label} style={metaChipStyle}>{label}</span>
            ))}
        </>
    );
}

function getDebugSourceLabel(source: string): string {
    switch (source) {
        case 'assistant-json':
        case 'chat-response-json':
            return '出力されたJSON';
        case 'assistant-text':
            return '出力されたテキスト';
        case 'chat-http-error':
            return 'HTTPエラー';
        case 'chat-response-parse-error':
            return '応答解析エラー';
        case 'chat-error':
            return '生成エラー';
        case 'director-json':
            return 'キャラクタールーターによる出力';
        case 'director-jev':
            return '指揮役による出力';
        case 'director-error':
            return 'キャラクタールーターのエラー';
        case 'memory-gate-jev':
            return 'メモリ保存の判定';
        case 'memory-gate-error':
            return 'メモリ保存判定のエラー';
        case 'memory-extraction-json':
            return '記憶の抽出（裏タスク）';
        case 'memory-extraction-error':
            return '記憶の抽出のエラー（裏タスク）';
        case 'memory-batch-json':
            return '記憶のバッチ抽出（裏タスク）';
        case 'memory-batch-error':
            return '記憶のバッチ抽出のエラー（裏タスク）';
        default:
            return source;
    }
}

const TASK_STATUS_STYLE: Record<BackgroundTask['status'], { label: string; color: string }> = {
    running: { label: '実行中', color: 'var(--accent-primary)' },
    completed: { label: '完了', color: 'var(--success)' },
    failed: { label: '失敗', color: 'var(--error)' },
};

function taskTimeLabel(task: BackgroundTask, now: number): string {
    const started = new Date(task.startedAt).toLocaleTimeString();
    const elapsed = Math.max(0, (task.finishedAt ?? now) - task.startedAt);
    return `${started} / ${formatDuration(elapsed)}${task.finishedAt ? '' : ' 経過'}`;
}

function BackgroundTaskList({ tasks, rooms, now }: { tasks: BackgroundTask[]; rooms: Room[]; now: number }) {
    const runningCount = tasks.filter((task) => task.status === 'running').length;
    return (
        <section aria-label="裏で動いているタスク" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', flexWrap: 'wrap' }}>
                <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    裏で動いているタスク
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {runningCount > 0 ? `${runningCount} 件実行中` : '実行中のタスクはありません'}
                </span>
            </div>
            {tasks.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                    返信のあとに記憶の抽出などが走ると、ここに表示されます。
                </p>
            ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.375rem', maxHeight: '15rem', overflowY: 'auto' }}>
                    {tasks.map((task) => {
                        const status = TASK_STATUS_STYLE[task.status] ?? TASK_STATUS_STYLE.failed;
                        const roomName = rooms.find((room) => room.id === task.roomId)?.name;
                        const message = task.status === 'failed' ? task.error : task.detail;
                        return (
                            <li
                                key={task.id}
                                style={{
                                    padding: '0.5rem 0.75rem',
                                    borderRadius: '0.5rem',
                                    border: '1px solid var(--border-color)',
                                    background: 'var(--bg-secondary)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '0.25rem',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.375rem 0.5rem', minWidth: 0 }}>
                                    <span style={{
                                        flexShrink: 0,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                        fontSize: '0.6875rem',
                                        fontWeight: 600,
                                        color: status.color,
                                        border: `1px solid ${status.color}`,
                                        borderRadius: '999px',
                                        padding: '0.125rem 0.375rem',
                                    }}>
                                        {task.status === 'running' && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
                                        {status.label}
                                    </span>
                                    <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                                        {backgroundTaskKindLabel(task.kind)}
                                    </span>
                                    {task.reason ? <span style={metaChipStyle}>{task.reason}</span> : null}
                                    <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                        {taskTimeLabel(task, now)}
                                    </span>
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {[task.characterName, roomName ?? task.roomId].filter(Boolean).join(' / ')}
                                </div>
                                {message ? (
                                    <div style={{ fontSize: '0.8125rem', color: task.status === 'failed' ? 'var(--error)' : 'var(--text-secondary)', wordBreak: 'break-word' }}>
                                        {message}
                                    </div>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

type DebugLogModalProps = {
    logs: FullJsonDebugLog[];
    backgroundTasks: BackgroundTask[];
    /** 一覧を受け取った時刻。数秒ごとに更新される。 */
    backgroundTasksCheckedAt: number;
    rooms: Room[];
    onClose: () => void;
    onClear: () => void;
};

export default function DebugLogModal({
    logs,
    backgroundTasks,
    backgroundTasksCheckedAt,
    rooms,
    onClose,
    onClear,
}: DebugLogModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);
    useModalKeyboard({ isOpen: true, containerRef: modalRef, onClose });

    return (
        <div
            className="modal-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content settings-form-modal"
                onClick={(event) => event.stopPropagation()}
                style={{ maxWidth: 820 }}
                role="dialog"
                aria-modal="true"
                aria-label="デバッグログ"
            >
                <div className="settings-form-modal-actions">
                    <button className="btn btn-ghost" onClick={onClose} aria-label="閉じる" title="閉じる">
                        <X size={20} />
                    </button>
                </div>
                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <BackgroundTaskList tasks={backgroundTasks} rooms={rooms} now={backgroundTasksCheckedAt} />
                    {logs.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                            まだログはありません。
                        </p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {logs.map((log) => (
                                <div
                                    key={log.id}
                                    style={{
                                        padding: '0.875rem',
                                        borderRadius: '0.5rem',
                                        border: '1px solid var(--border-color)',
                                        background: 'var(--bg-secondary)',
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.5rem' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                                                <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {log.characterName}
                                                </div>
                                                <span style={{
                                                    flexShrink: 0,
                                                    fontSize: '0.6875rem',
                                                    fontWeight: 600,
                                                    color: log.status === 'error' ? 'var(--error)' : 'var(--success)',
                                                    border: `1px solid ${log.status === 'error' ? 'var(--error)' : 'var(--success)'}`,
                                                    borderRadius: '999px',
                                                    padding: '0.125rem 0.375rem',
                                                }}>
                                                    {log.status === 'error' ? 'エラー' : '成功'}
                                                </span>
                                            </div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '0.125rem' }}>
                                                {log.roomName} / {getDebugSourceLabel(log.source)}
                                                {log.httpStatus ? ` / HTTP ${log.httpStatus}` : ''}
                                                {log.elapsedMs != null ? ` / ${log.elapsedMs}ms` : ''}
                                            </div>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.375rem', marginTop: '0.375rem' }}>
                                                {log.model ? (
                                                    <span
                                                        style={{ ...metaChipStyle, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                                        title={log.model}
                                                    >
                                                        モデル: {log.model}
                                                    </span>
                                                ) : null}
                                                <MetaChips labels={usageLabels(log.usage)} />
                                                <MetaChips labels={usageLabels(log.secondUsage)} prefix="2回目" />
                                            </div>
                                        </div>
                                        <time style={{ flexShrink: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                            {new Date(log.createdAt).toLocaleString()}
                                        </time>
                                    </div>
                                    {log.prompt && (
                                        <div style={{ marginBottom: '0.75rem' }}>
                                            <div style={{ marginBottom: '0.375rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                                プロンプト
                                            </div>
                                            <pre style={{
                                                margin: 0,
                                                maxHeight: '420px',
                                                overflow: 'auto',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-word',
                                                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                                                fontSize: '0.8125rem',
                                                lineHeight: 1.55,
                                                color: 'var(--text-secondary)',
                                            }}>{log.prompt}</pre>
                                        </div>
                                    )}
                                    {log.reasoning && (
                                        <div style={{ marginBottom: '0.75rem' }}>
                                            <div style={{ marginBottom: '0.375rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                                推論
                                            </div>
                                            <pre style={{
                                                margin: 0,
                                                maxHeight: '420px',
                                                overflow: 'auto',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-word',
                                                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                                                fontSize: '0.8125rem',
                                                lineHeight: 1.55,
                                                color: 'var(--text-secondary)',
                                            }}>{log.reasoning}</pre>
                                        </div>
                                    )}
                                    <div style={{ marginBottom: '0.375rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                        出力
                                    </div>
                                    <pre style={{
                                        margin: 0,
                                        maxHeight: '420px',
                                        overflow: 'auto',
                                        whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word',
                                        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                                        fontSize: '0.8125rem',
                                        lineHeight: 1.55,
                                        color: 'var(--text-secondary)',
                                    }}>{log.json}</pre>
                                    {log.secondJson && (
                                        <>
                                            <div style={{ marginTop: '0.75rem', marginBottom: '0.375rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                                                出力（2回目の応答）
                                            </div>
                                            <pre style={{
                                                margin: 0,
                                                maxHeight: '420px',
                                                overflow: 'auto',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-word',
                                                fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
                                                fontSize: '0.8125rem',
                                                lineHeight: 1.55,
                                                color: 'var(--text-secondary)',
                                            }}>{log.secondJson}</pre>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                {logs.length > 0 && (
                    <div className="modal-footer">
                        <button className="btn btn-secondary" onClick={onClear}>
                            <Trash2 size={15} />
                            ログを消去
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
