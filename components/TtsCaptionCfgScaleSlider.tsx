export const TTS_CAPTION_CFG_SCALE_SLIDER_MIN = 0;
export const TTS_CAPTION_CFG_SCALE_SLIDER_MAX = 10;
export const TTS_CAPTION_CFG_SCALE_SLIDER_STEP = 0.5;

export function formatTtsCaptionCfgScale(scale: number): string {
    return scale.toFixed(1);
}

interface TtsCaptionCfgScaleSliderProps {
    id?: string;
    value: number;
    disabled?: boolean;
    ariaLabel: string;
    onChange: (scale: number) => void;
}

/** Irodoriの caption（演技指示）ガイダンス強度スライダー。
 * 他モーダルのパラメータスライダーと同じ見た目。 */
export default function TtsCaptionCfgScaleSlider({
    id,
    value,
    disabled = false,
    ariaLabel,
    onChange,
}: TtsCaptionCfgScaleSliderProps) {
    const percent = Math.max(0, Math.min(100,
        ((value - TTS_CAPTION_CFG_SCALE_SLIDER_MIN)
            / (TTS_CAPTION_CFG_SCALE_SLIDER_MAX - TTS_CAPTION_CFG_SCALE_SLIDER_MIN)) * 100,
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
                    min={TTS_CAPTION_CFG_SCALE_SLIDER_MIN}
                    max={TTS_CAPTION_CFG_SCALE_SLIDER_MAX}
                    step={TTS_CAPTION_CFG_SCALE_SLIDER_STEP}
                    value={Math.max(TTS_CAPTION_CFG_SCALE_SLIDER_MIN, Math.min(TTS_CAPTION_CFG_SCALE_SLIDER_MAX, value))}
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
                    {formatTtsCaptionCfgScale(TTS_CAPTION_CFG_SCALE_SLIDER_MIN)}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {formatTtsCaptionCfgScale(TTS_CAPTION_CFG_SCALE_SLIDER_MAX)}
                </span>
            </div>
        </div>
    );
}
