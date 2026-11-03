import OptionSelector from './OptionSelector';
import type { RealTimeMode } from '@/lib/store';

const REAL_TIME_MODE_OPTIONS = [
    { value: 'off', label: '使わない' },
    { value: 'date', label: '日付と曜日' },
    { value: 'datetime', label: '日付・曜日と時間帯' },
] as const;

export const REAL_TIME_MODE_DESCRIPTION =
    '現実の時間をキャラクターと共有します。';

export function toRealTimeMode(value: string | undefined): RealTimeMode {
    return value === 'date' || value === 'datetime' ? value : 'off';
}

export default function RealTimeModeSelector({ value, onChange }: {
    value: RealTimeMode;
    onChange: (value: RealTimeMode) => void;
}) {
    return (
        <OptionSelector
            value={value}
            onChange={(next) => onChange(toRealTimeMode(next))}
            options={REAL_TIME_MODE_OPTIONS}
            ariaLabel="現実の日時"
            style={{ width: 'auto', minWidth: '11rem', flexShrink: 0 }}
        />
    );
}
