import { RotateCcw } from 'lucide-react';
import { CHAT_SAMPLING_PARAMS, type ChatSamplingKey } from '@/lib/chatSampling';
import InfoButton from './InfoButton';

/** 生成パラメータ1つ分のスライダー。未設定（null）のときは既定値を薄く表示する。 */
interface ParamSliderProps {
    paramKey: ChatSamplingKey;
    value: number | null;
    onChange: (v: number | null) => void;
}

export default function ParamSlider({ paramKey, value, onChange }: ParamSliderProps) {
    const param = CHAT_SAMPLING_PARAMS[paramKey];
    const displayValue = value ?? param.defaultValue;
    const isCustom = value !== null;
    const isInteger = param.step >= 1;
    const formatValue = (v: number) => isInteger ? String(Math.round(v)) : v.toFixed(3);

    const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const next = parseFloat(e.target.value);
        onChange(isInteger ? Math.round(next) : parseFloat(next.toFixed(3)));
    };

    const handleReset = () => {
        onChange(null);
    };

    const percent = ((displayValue - param.min) / (param.max - param.min)) * 100;

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    <label style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: 'var(--text-secondary)',
                    }}>
                        {param.label}
                    </label>
                    <InfoButton text={param.hint} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                        minWidth: '3.5rem',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                    }}>
                        {formatValue(displayValue)}
                    </span>
                    {isCustom && (
                        <button
                            type="button"
                            onClick={handleReset}
                            title="デフォルト値に戻す"
                            style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '2px',
                                color: 'var(--text-muted)',
                                display: 'flex',
                                alignItems: 'center',
                                borderRadius: '4px',
                                transition: 'color 0.15s ease',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                        >
                            <RotateCcw size={12} />
                        </button>
                    )}
                </div>
            </div>

            {/* スライダートラック */}
            <div style={{ position: 'relative', height: '20px', display: 'flex', alignItems: 'center' }}>
                {/* 背景トラック */}
                <div style={{
                    position: 'absolute',
                    width: '100%',
                    height: '4px',
                    borderRadius: '2px',
                    background: 'var(--bg-tertiary)',
                    overflow: 'hidden',
                }}>
                    {/* 塗りつぶし部分 */}
                    <div style={{
                        width: `${percent}%`,
                        height: '100%',
                        background: isCustom
                            ? 'var(--accent-primary)'
                            : 'var(--text-muted)',
                        borderRadius: '2px',
                        transition: 'background 0.2s ease',
                    }} />
                </div>

                {/* Native range input (透過して重ねる) */}
                <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={displayValue}
                    onChange={handleSliderChange}
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '20px',
                        opacity: 0,
                        cursor: 'pointer',
                        margin: 0,
                        padding: 0,
                        zIndex: 2,
                    }}
                />

                {/* サム（ハンドル） */}
                <div style={{
                    position: 'absolute',
                    left: `calc(${percent}% - 8px)`,
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                    transition: 'background 0.2s ease, transform 0.1s ease',
                    pointerEvents: 'none',
                    zIndex: 1,
                }} />
            </div>

            {/* 最小・最大ラベル */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: '0.25rem',
            }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{formatValue(param.min)}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{formatValue(param.max)}</span>
            </div>
        </div>
    );
}
