export const TTS_CHUNK_MIN_CHARS_SLIDER_STEP = 1;

interface TtsChunkMinCharsSliderProps {
    id?: string;
    min: number;
    max: number;
    value: number;
    disabled?: boolean;
    ariaLabel: string;
    onChange: (chars: number) => void;
}

/** Irodoriストリーミングの分割しきい値スライダー（整数）。
 * 他モーダルのパラメータスライダーと同じ見た目。 */
export default function TtsChunkMinCharsSlider({
    id,
    min,
    max,
    value,
    disabled = false,
    ariaLabel,
    onChange,
}: TtsChunkMinCharsSliderProps) {
    const percent = Math.max(0, Math.min(100,
        ((value - min) / (max - min)) * 100,
    ));

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
                        background: 'var(--accent-primary)',
                        borderRadius: '2px',
                        transition: 'background 0.2s ease',
                    }} />
                </div>
                <input
                    id={id}
                    type="range"
                    aria-label={ariaLabel}
                    min={min}
                    max={max}
                    step={TTS_CHUNK_MIN_CHARS_SLIDER_STEP}
                    value={Math.max(min, Math.min(max, value))}
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
                    background: 'var(--accent-primary)',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                    transition: 'background 0.2s ease',
                    pointerEvents: 'none',
                    zIndex: 1,
                }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {min}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {max}
                </span>
            </div>
        </div>
    );
}
