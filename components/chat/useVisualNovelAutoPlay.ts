import { useEffect, useRef } from 'react';
import { getTtsEntryState } from '@/lib/ttsPlayer';

const VN_AUTOPLAY_BASE_DELAY_MS = 1100;
const VN_AUTOPLAY_PER_CHAR_MS = 50;
const VN_AUTOPLAY_MAX_DELAY_MS = 8000;
const VN_AUTOPLAY_TTS_POLL_MS = 320;
const VN_AUTOPLAY_MAX_TTS_WAIT_MS = 60000;

type UseVisualNovelAutoPlayOptions = {
    enabled: boolean;
    canAdvance: boolean;
    isTypewriterActive: boolean;
    /** 表示中ページの読み上げキー。再生中は終わるまでページ送りを保留する。 */
    ttsItemKey?: string | null;
    /** 表示中ページの文字数。読み切り時間の目安に使う。 */
    contentLength: number;
    onAdvance: () => void;
};

export function useVisualNovelAutoPlay({
    enabled,
    canAdvance,
    isTypewriterActive,
    ttsItemKey,
    contentLength,
    onAdvance,
}: UseVisualNovelAutoPlayOptions) {
    const onAdvanceRef = useRef(onAdvance);

    useEffect(() => {
        onAdvanceRef.current = onAdvance;
    }, [onAdvance]);

    useEffect(() => {
        if (!enabled || !canAdvance || isTypewriterActive) return;
        const delay = Math.min(
            VN_AUTOPLAY_BASE_DELAY_MS + contentLength * VN_AUTOPLAY_PER_CHAR_MS,
            VN_AUTOPLAY_MAX_DELAY_MS,
        );
        let ttsWaitedMs = 0;
        let timer = 0;
        const schedule = (wait: number) => {
            timer = window.setTimeout(() => {
                // 描画時点のstatusではなく最新状態を見る。読み上げ開始が同コミットで
                // まだ反映されていなくても、タイマー発火時に検出できる。
                const status = ttsItemKey ? getTtsEntryState(ttsItemKey).status : null;
                if (status === 'playing' || status === 'loading') {
                    ttsWaitedMs += wait;
                    if (ttsWaitedMs < VN_AUTOPLAY_MAX_TTS_WAIT_MS) {
                        schedule(VN_AUTOPLAY_TTS_POLL_MS);
                        return;
                    }
                }
                onAdvanceRef.current();
            }, wait);
        };
        schedule(delay);
        return () => window.clearTimeout(timer);
    }, [enabled, canAdvance, isTypewriterActive, ttsItemKey, contentLength]);
}
