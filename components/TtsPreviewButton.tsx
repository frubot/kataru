import { useEffect } from 'react';
import { Loader2, Square, Volume2 } from 'lucide-react';

import { useStore } from '@/lib/store';
import { isTtsProfilePlayable, type TtsProfile } from '@/lib/tts';
import { getTtsEntryState, requestTtsPlayback, stopTtsPlayback, useTtsEntry } from '@/lib/ttsPlayer';

const PREVIEW_ROOM_ID = '__tts_preview__';
const PREVIEW_TEXT = 'こんにちは。これは音声合成の試聴です。';

interface TtsPreviewButtonProps {
    /** 再生状態を識別するID。配置場所ごとに一意にする。 */
    previewId: string;
    profile: TtsProfile;
    disabled?: boolean;
}

/** 設定中の声と速度でサンプル文を再生する試聴ボタン。 */
export default function TtsPreviewButton({ previewId, profile, disabled = false }: TtsPreviewButtonProps) {
    const { status, error } = useTtsEntry(previewId);
    const playable = isTtsProfilePlayable(profile);
    const active = status === 'playing' || status === 'loading';

    // モーダルを閉じても試聴が残らないようにする
    useEffect(() => () => {
        const entry = getTtsEntryState(previewId);
        if (entry.status === 'playing' || entry.status === 'loading') {
            stopTtsPlayback();
        }
    }, [previewId]);

    const handleClick = () => {
        if (active) {
            stopTtsPlayback();
            return;
        }
        if (!playable) return;
        const state = useStore.getState();
        void requestTtsPlayback({
            roomId: PREVIEW_ROOM_ID,
            messageId: previewId,
            segments: [{ text: PREVIEW_TEXT, kind: 'dialogue' }],
            profile,
            captionCfgScale: state.ttsCaptionCfgScale,
            chunkMinChars: state.ttsChunkMinChars,
            firstChunkMinChars: state.ttsFirstChunkMinChars,
            aiApiConfig: { ...state.getAiApiConfig(), connectionId: profile.connectionId },
        }).catch(() => {});
    };

    const label = status === 'loading' ? '生成中…' : status === 'playing' ? '停止' : '試聴';

    return (
        <button
            type="button"
            className="btn btn-secondary"
            disabled={disabled || (!playable && !active)}
            onClick={handleClick}
            title={error ?? (playable ? 'サンプル文を読み上げます' : '接続先と声を設定すると試聴できます')}
            aria-label={label}
            style={{ flexShrink: 0, padding: '0 0.875rem', fontSize: '0.8125rem', minHeight: '2.75rem' }}
        >
            {status === 'loading' ? (
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : status === 'playing' ? (
                <Square size={12} aria-hidden="true" />
            ) : (
                <Volume2 size={13} aria-hidden="true" />
            )}
            {label}
        </button>
    );
}
