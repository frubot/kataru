import type { CSSProperties } from 'react';

import { AI_API_TYPE_LABELS, type AiApiType } from '@/lib/aiApi';

interface ApiTypeSelectProps {
    /** `undefined` means the role/entity follows the global service. */
    value?: AiApiType;
    onChange: (apiType?: AiApiType) => void;
    /** Current global service, used for the "follow global" option label. */
    globalApiType: AiApiType;
    id?: string;
    ariaLabel?: string;
    disabled?: boolean;
    style?: CSSProperties;
}

const API_TYPE_OPTIONS: readonly AiApiType[] = [
    'openrouter',
    'openai-compatible',
    'anthropic',
];

export default function ApiTypeSelect({
    value,
    onChange,
    globalApiType,
    id,
    ariaLabel = '接続先',
    disabled = false,
    style,
}: ApiTypeSelectProps) {
    return (
        <select
            id={id}
            className="input"
            aria-label={ariaLabel}
            value={value ?? ''}
            disabled={disabled}
            onChange={(event) => {
                const next = event.target.value;
                onChange(next === '' ? undefined : (next as AiApiType));
            }}
            style={{ fontSize: '0.8125rem', ...style }}
        >
            <option value="">グローバル（{AI_API_TYPE_LABELS[globalApiType]}）</option>
            {API_TYPE_OPTIONS.map((apiType) => (
                <option key={apiType} value={apiType}>
                    {AI_API_TYPE_LABELS[apiType]}
                </option>
            ))}
        </select>
    );
}
