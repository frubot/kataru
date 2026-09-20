import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { isAiConnectionKind } from '@/lib/aiApi';
import { useAiConnections } from '@/lib/aiConnections';
import { getTtsSpeakers, type TtsSpeaker } from '@/lib/tts';
import OptionSelector, { type OptionSelectorItem } from '@/components/OptionSelector';

interface TtsVoiceFieldProps {
    connectionId: string;
    value: string;
    onChange: (voice: string) => void;
    disabled?: boolean;
    id?: string;
    /** 空欄オプションのラベル（既定値は「既定」） */
    emptyLabel?: string;
}

const noteStyle = {
    margin: '0.375rem 0 0',
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    lineHeight: 1.5,
} as const;

/** Voice input shared by the global TTS settings and per-character overrides.
 * VOICEVOX接続では話者一覧から選び、それ以外ではモデル固有の声名を入力する。 */
export default function TtsVoiceField({
    connectionId,
    value,
    onChange,
    disabled = false,
    id,
    emptyLabel = '既定',
}: TtsVoiceFieldProps) {
    const { connections } = useAiConnections();
    const connection = connections.find((candidate) => candidate.id === connectionId) ?? null;
    const kind = connection?.kind ?? (isAiConnectionKind(connectionId) ? connectionId : null);
    const [speakers, setSpeakers] = useState<TtsSpeaker[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        if (kind !== 'voicevox' || !connectionId) {
            setSpeakers([]);
            setLoading(false);
            setError(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        getTtsSpeakers(connectionId)
            .then((result: TtsSpeaker[]) => {
                if (cancelled) return;
                setSpeakers(result);
                setLoading(false);
            })
            .catch((caught: unknown) => {
                if (cancelled) return;
                setSpeakers([]);
                setError(caught instanceof Error ? caught.message : '話者一覧を取得できませんでした。');
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [connectionId, kind, reloadToken]);

    const retry = useCallback(() => setReloadToken((token) => token + 1), []);

    const textInput = (
        <input
            id={id}
            className="input"
            type="text"
            value={value}
            disabled={disabled}
            spellCheck={false}
            placeholder="例: alloy"
            onChange={(event) => onChange(event.target.value)}
        />
    );

    if (kind !== 'voicevox') return textInput;

    if (error) {
        return (
            <>
                {textInput}
                <p style={{ ...noteStyle, color: 'var(--error)' }} role="alert">
                    {error}
                </p>
                <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={loading}
                    onClick={retry}
                    style={{ marginTop: '0.375rem', padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                >
                    <RefreshCw size={12} aria-hidden="true" />
                    話者一覧を再読み込み
                </button>
            </>
        );
    }

    const hasValue = speakers.some((speaker) => speaker.styles.some((style) => String(style.id) === value));

    const options: OptionSelectorItem[] = [
        { value: '', label: emptyLabel },
        ...speakers.map((speaker) => ({
            label: speaker.name,
            options: speaker.styles.map((style) => ({
                value: String(style.id),
                label: style.name,
            })),
        })),
        ...(value !== '' && !hasValue ? [{ value, label: value }] : []),
    ];

    return (
        <>
            <OptionSelector
                id={id}
                value={value}
                onChange={onChange}
                options={options}
                disabled={disabled || loading}
                ariaLabel="話者"
                searchable
                searchPlaceholder="話者・スタイルで検索"
                searchAriaLabel="話者を検索"
                loading={loading}
                loadingLabel="話者一覧を読み込んでいます…"
                emptyLabel="利用可能な話者がありません。"
            />
            {loading && <p style={noteStyle} role="status">話者一覧を読み込んでいます…</p>}
        </>
    );
}
