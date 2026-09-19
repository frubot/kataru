export const TTS_SPEED_SLIDER_MIN = 0.5;
export const TTS_SPEED_SLIDER_MAX = 2;
export const TTS_SPEED_SLIDER_STEP = 0.05;

export function formatTtsSpeed(speed: number): string {
    return `${speed.toFixed(2)}x`;
}

interface TtsSpeedSliderProps {
    id?: string;
    value: number;
    /** 継承値（全体設定など）の表示時は false でミュート色にする */
    custom?: boolean;
    disabled?: boolean;
    ariaLabel: string;
    onChange: (speed: number) => void;
}

/** 読み上げ速度スライダー。他モーダルのパラメータスライダーと同じ見た目。 */
export default function TtsSpeedSlider({
    id,
    value,
    custom = true,
    disabled = false,
    ariaLabel,
    onChange,
}: TtsSpeedSliderProps) {
    const percent = Math.max(0, Math.min(100,
        ((value - TTS_SPEED_SLIDER_MIN) / (TTS_SPEED_SLIDER_MAX - TTS_SPEED_SLIDER_MIN)) * 100,
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
                    min={TTS_SPEED_SLIDER_MIN}
                    max={TTS_SPEED_SLIDER_MAX}
                    step={TTS_SPEED_SLIDER_STEP}
                    value={Math.max(TTS_SPEED_SLIDER_MIN, Math.min(TTS_SPEED_SLIDER_MAX, value))}
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
                    {formatTtsSpeed(TTS_SPEED_SLIDER_MIN)}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {formatTtsSpeed(TTS_SPEED_SLIDER_MAX)}
                </span>
            </div>
        </div>
    );
}
