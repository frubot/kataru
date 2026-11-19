import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderOpen, X } from 'lucide-react';

import { revealDesktopDownload, subscribeDesktopEvents } from '@/lib/desktopApp';

const VISIBLE_MS = 6000;

type DownloadNotice = {
    id: number;
    success: boolean;
    fileName: string | null;
};

/** デスクトップ版で、ダウンロードしたファイルの保存結果を知らせる。 */
export default function DesktopDownloadNotice() {
    const [notice, setNotice] = useState<DownloadNotice | null>(null);
    const [paused, setPaused] = useState(false);
    const nextId = useRef(0);

    useEffect(() => subscribeDesktopEvents((event) => {
        if (event.type !== 'download-finished') return;
        nextId.current += 1;
        setNotice({ id: nextId.current, success: event.success, fileName: event.fileName });
    }), []);

    useEffect(() => {
        if (!notice || paused) return;
        const timeoutId = window.setTimeout(() => setNotice(null), VISIBLE_MS);
        return () => window.clearTimeout(timeoutId);
    }, [notice, paused]);

    if (!notice) return null;

    const close = () => {
        setNotice(null);
        setPaused(false);
    };

    return (
        <div
            key={notice.id}
            className={`download-notice ${notice.success ? 'success' : 'error'}`}
            role="status"
            aria-live="polite"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
        >
            {notice.success
                ? <CheckCircle2 size={16} className="download-notice-icon" aria-hidden="true" />
                : <AlertTriangle size={16} className="download-notice-icon" aria-hidden="true" />}
            <span className="download-notice-message">
                {notice.success
                    ? `${notice.fileName ?? 'ファイル'} を保存しました`
                    : 'ファイルを保存できませんでした'}
            </span>
            {notice.success && (
                <button
                    type="button"
                    className="download-notice-action"
                    onClick={() => {
                        revealDesktopDownload();
                        close();
                    }}
                >
                    <FolderOpen size={14} aria-hidden="true" />
                    フォルダで表示
                </button>
            )}
            <button
                type="button"
                className="download-notice-close"
                onClick={close}
                title="閉じる"
                aria-label="通知を閉じる"
            >
                <X size={14} />
            </button>
        </div>
    );
}
