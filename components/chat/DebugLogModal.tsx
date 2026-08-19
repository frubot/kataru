import { Trash2, X } from 'lucide-react';
import type { FullJsonDebugLog } from '@/lib/store';

function getDebugSourceLabel(source: string): string {
    switch (source) {
        case 'assistant-json':
        case 'chat-response-json':
            return '出力されたJSON';
        case 'chat-http-error':
            return 'HTTPエラー';
        case 'chat-response-parse-error':
            return '応答解析エラー';
        case 'chat-error':
            return '生成エラー';
        case 'director-json':
            return 'キャラクタールーターによる出力';
        case 'director-error':
            return 'キャラクタールーターのエラー';
        default:
            return source;
    }
}

type DebugLogModalProps = {
    logs: FullJsonDebugLog[];
    onClose: () => void;
    onClear: () => void;
};

export default function DebugLogModal({ logs, onClose, onClear }: DebugLogModalProps) {
    return (
        <div
            className="modal-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
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
                    {logs.length === 0 ? (
                        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                            まだJSONログはありません。
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
