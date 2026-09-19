export const TTS_VOLUME_SLIDER_MIN = 0;
export const TTS_VOLUME_SLIDER_MAX = 1;
export const TTS_VOLUME_SLIDER_STEP = 0.05;

export function formatTtsVolume(volume: number): string {
    return `${Math.round(volume * 100)}%`;
}

interface TtsVolumeSliderProps {
    id?: string;
    value: number;
    /** 継承値（全体設定など）の表示時は false でミュート色にする */
    custom?: boolean;
    disabled?: boolean;
    ariaLabel: string;
    onChange: (volume: number) => void;
}

/** 読み上げ音量スライダー。読み上げ速度スライダーと同じ見た目。 */
export default function TtsVolumeSlider({
    id,
    value,
    custom = true,
    disabled = false,
    ariaLabel,
    onChange,
}: TtsVolumeSliderProps) {
    const percent = Math.max(0, Math.min(100,
        ((value - TTS_VOLUME_SLIDER_MIN) / (TTS_VOLUME_SLIDER_MAX - TTS_VOLUME_SLIDER_MIN)) * 100,
    ));
    const activeColor = custom ? 'var(--accent-primary)' : 'var(--text-muted)';

    return (
        <div>
            <div style={{ position: 'relative', height: '20px', display: 'flex', alignItems: 'center' }}>
                <div style={{
                    position: 'absolute',
                    width: '100%',
                    height: '4px',
                    borderRadius: '2px',
                    background: 'var(--bg-tertiary)',
                    overflow: 'hidden',
                }}>
                    <div style={{
                        width: `${percent}%`,
                        height: '100%',
                        background: activeColor,
                        borderRadius: '2px',
                        transition: 'background 0.2s ease',
                    }} />
                </div>
                <input
                    id={id}
                    type="range"
                    aria-label={ariaLabel}
                    min={TTS_VOLUME_SLIDER_MIN}
                    max={TTS_VOLUME_SLIDER_MAX}
                    step={TTS_VOLUME_SLIDER_STEP}
                    value={Math.max(TTS_VOLUME_SLIDER_MIN, Math.min(TTS_VOLUME_SLIDER_MAX, value))}
                    disabled={disabled}
                    onChange={(event) => onChange(Number(event.target.value))}
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '20px',
                        opacity: 0,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        margin: 0,
                        padding: 0,
                        zIndex: 2,
                    }}
                />
                <div style={{
                    position: 'absolute',
                    left: `calc(${percent}% - 8px)`,
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: activeColor,
                    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                    transition: 'background 0.2s ease',
                    pointerEvents: 'none',
                    zIndex: 1,
                }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {formatTtsVolume(TTS_VOLUME_SLIDER_MIN)}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {formatTtsVolume(TTS_VOLUME_SLIDER_MAX)}
                </span>
            </div>
        </div>
    );
}
