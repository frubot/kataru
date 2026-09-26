import { useState, useMemo, useEffect } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, BarChart3, Calendar, Users } from 'lucide-react';
import { useStore, type UsageRecord } from '@/lib/store';
import OptionSelector from '@/components/OptionSelector';

type ViewMode = 'tokens' | 'input' | 'output' | 'requests' | 'cost';
type SortOrder = 'desc' | 'asc';
type PeriodFilter = 'all' | 'thisMonth' | 'lastMonth' | 'last3Months' | 'lastYear';
type ChartGranularity = 'day' | 'week' | 'month';

interface ChartPoint {
    start: number;
    end: number;
    label: string;
    description: string;
    value: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const periodOptions: { value: PeriodFilter; label: string }[] = [
    { value: 'all', label: '全期間' },
    { value: 'thisMonth', label: '今月' },
    { value: 'lastMonth', label: '先月' },
    { value: 'last3Months', label: '過去3ヶ月' },
    { value: 'lastYear', label: '過去1年' },
];

const viewModeOptions: { value: ViewMode; label: string; chartLabel: string }[] = [
    { value: 'requests', label: 'リクエスト数', chartLabel: 'リクエスト数' },
    { value: 'input', label: '入力', chartLabel: '入力トークン' },
    { value: 'output', label: '出力', chartLabel: '出力トークン' },
    { value: 'tokens', label: 'トークン', chartLabel: '合計トークン' },
    { value: 'cost', label: '料金', chartLabel: '料金' },
];

interface MetricTotals {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    recordCount?: number;
}

function getMetricValue(totals: MetricTotals, viewMode: ViewMode): number {
    switch (viewMode) {
        case 'requests':
            return totals.recordCount ?? 1;
        case 'input':
            return totals.promptTokens;
        case 'output':
            return totals.completionTokens;
        case 'cost':
            return totals.cost;
        default:
            return totals.totalTokens;
    }
}

function getDateRange(period: PeriodFilter): { start: number; end: number } {
    const now = new Date();
    const end = now.getTime();

    switch (period) {
        case 'thisMonth': {
            const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
            return { start, end };
        }
        case 'lastMonth': {
            const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const start = lastMonth.getTime();
            const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1;
            return { start, end: endOfLastMonth };
        }
        case 'last3Months': {
            const start = new Date(now.getFullYear(), now.getMonth() - 3, 1).getTime();
            return { start, end };
        }
        case 'lastYear': {
            const start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).getTime();
            return { start, end };
        }
        default:
            return { start: 0, end };
    }
}

function getChartGranularity(period: PeriodFilter, start: number, end: number): ChartGranularity {
    if (period === 'thisMonth' || period === 'lastMonth') {
        return 'day';
    }

    if (period === 'last3Months') {
        return 'week';
    }

    if (period === 'lastYear') {
        return 'month';
    }

    const spanInDays = Math.max(1, Math.ceil((end - start) / DAY_MS));
    if (spanInDays <= 31) return 'day';
    if (spanInDays <= 120) return 'week';
    return 'month';
}

function buildChartData(
    records: UsageRecord[],
    period: PeriodFilter,
    viewMode: ViewMode,
): ChartPoint[] {
    if (records.length === 0) return [];

    const selectedRange = getDateRange(period);
    const rangeStart = period === 'all'
        ? Math.min(...records.map((record) => record.timestamp))
        : selectedRange.start;
    const rangeEnd = selectedRange.end;
    const granularity = getChartGranularity(period, rangeStart, rangeEnd);
    const firstDate = new Date(rangeStart);
    let cursor = granularity === 'month'
        ? new Date(firstDate.getFullYear(), firstDate.getMonth(), 1)
        : new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
    const spansMultipleYears = cursor.getFullYear() !== new Date(rangeEnd).getFullYear();
    const points: ChartPoint[] = [];

    while (cursor.getTime() <= rangeEnd) {
        const start = cursor.getTime();
        const next = new Date(cursor);

        if (granularity === 'day') {
            next.setDate(next.getDate() + 1);
        } else if (granularity === 'week') {
            next.setDate(next.getDate() + 7);
        } else {
            next.setMonth(next.getMonth() + 1);
        }

        const end = next.getTime();
        const month = cursor.getMonth() + 1;
        const date = cursor.getDate();
        const year = cursor.getFullYear();
        const label = granularity === 'month'
            ? spansMultipleYears ? `${String(year).slice(-2)}/${month}` : `${month}月`
            : `${month}/${date}`;
        const description = granularity === 'month'
            ? `${year}年${month}月`
            : granularity === 'week'
                ? `${year}年${month}月${date}日からの1週間`
                : `${year}年${month}月${date}日`;
        const value = records.reduce((sum, record) => {
            if (record.timestamp < start || record.timestamp >= end) return sum;
            return sum + getMetricValue(record, viewMode);
        }, 0);

        points.push({ start, end, label, description, value });
        cursor = next;
    }

    return points;
}

interface CharacterStats {
    characterId: string;
    characterName: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    recordCount: number;
}

export default function StatisticsPanel() {
    const { usageRecords, characters, cleanOldUsageRecords } = useStore();
    const [viewMode, setViewMode] = useState<ViewMode>('tokens');
    const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
    const [period, setPeriod] = useState<PeriodFilter>('all');
    const [selectedCharacter, setSelectedCharacter] = useState<string>('all');

    // 統計タブを表示したときに、保持期間を過ぎた記録を整理します。
    useEffect(() => {
        void cleanOldUsageRecords();
    }, [cleanOldUsageRecords]);

    const filteredRecords = useMemo(() => {
        const { start, end } = getDateRange(period);
        let records = usageRecords.filter(r => r.timestamp >= start && r.timestamp <= end);

        if (selectedCharacter !== 'all') {
            records = records.filter(r => r.characterId === selectedCharacter);
        }

        return records;
    }, [usageRecords, period, selectedCharacter]);

    const characterStats = useMemo((): CharacterStats[] => {
        const statsMap = new Map<string, CharacterStats>();

        for (const record of filteredRecords) {
            const existing = statsMap.get(record.characterId);
            const character = characters.find(c => c.id === record.characterId);

            if (existing) {
                existing.promptTokens += record.promptTokens;
                existing.completionTokens += record.completionTokens;
                existing.totalTokens += record.totalTokens;
                existing.cost += record.cost;
                existing.recordCount += 1;
            } else {
                statsMap.set(record.characterId, {
                    characterId: record.characterId,
                    characterName: character?.name || '削除されたキャラクター',
                    promptTokens: record.promptTokens,
                    completionTokens: record.completionTokens,
                    totalTokens: record.totalTokens,
                    cost: record.cost,
                    recordCount: 1,
                });
            }
        }

        const direction = sortOrder === 'desc' ? -1 : 1;
        return Array.from(statsMap.values()).sort(
            (a, b) => (getMetricValue(a, viewMode) - getMetricValue(b, viewMode)) * direction,
        );
    }, [filteredRecords, characters, viewMode, sortOrder]);

    const totals = useMemo(() => {
        return characterStats.reduce(
            (acc, stat) => ({
                promptTokens: acc.promptTokens + stat.promptTokens,
                completionTokens: acc.completionTokens + stat.completionTokens,
                totalTokens: acc.totalTokens + stat.totalTokens,
                cost: acc.cost + stat.cost,
                recordCount: acc.recordCount + stat.recordCount,
            }),
            { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, recordCount: 0 }
        );
    }, [characterStats]);

    const formatTokens = (n: number) => n.toLocaleString();
    const formatCost = (n: number) => `$${n.toFixed(6)}`;
    const chartData = useMemo(
        () => buildChartData(filteredRecords, period, viewMode),
        [filteredRecords, period, viewMode],
    );
    const chartMaximum = Math.max(...chartData.map((point) => point.value), 0);
    const chartPeak = chartData.reduce<ChartPoint | null>(
        (peak, point) => peak === null || point.value > peak.value ? point : peak,
        null,
    );
    const chartLabelIndexes = Array.from(new Set([
        0,
        Math.floor((chartData.length - 1) / 2),
        chartData.length - 1,
    ])).filter((index) => index >= 0);
    const formatChartValue = (value: number) => {
        if (viewMode === 'cost') return formatCost(value);
        if (viewMode === 'requests') return `${formatTokens(value)}回`;
        return `${formatTokens(value)} トークン`;
    };
    const activeChartLabel = viewModeOptions.find((opt) => opt.value === viewMode)?.chartLabel ?? '';
    const sortOrderLabel = sortOrder === 'desc' ? '高い順' : '低い順';
    const handleColumnSort = (mode: ViewMode) => {
        if (mode === viewMode) {
            setSortOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
        } else {
            setViewMode(mode);
            setSortOrder('desc');
        }
    };
    const renderSortableHeader = (mode: ViewMode, label: string) => {
        const isActive = viewMode === mode;
        return (
            <th
                scope="col"
                className={`statistics-table-number${isActive ? ' is-active' : ''}`}
                aria-sort={isActive ? (sortOrder === 'desc' ? 'descending' : 'ascending') : 'none'}
            >
                <button
                    type="button"
                    className="statistics-table-sort-button"
                    onClick={() => handleColumnSort(mode)}
                    aria-label={
                        isActive
                            ? `${label}（${sortOrderLabel}）。クリックで並び順を切り替え`
                            : `${label}で並べ替え`
                    }
                    title={isActive ? `${sortOrderLabel}（クリックで切替）` : `${label}で並べ替え`}
                >
                    <span>{label}</span>
                    {isActive
                        ? (sortOrder === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />)
                        : <ArrowUpDown size={12} className="statistics-table-sort-hint" aria-hidden="true" />}
                </button>
            </th>
        );
    };

    return (
        <div className="statistics-panel">
                        {/* Filters */}
                        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: '140px' }}>
                                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.25rem' }}>
                                    <Calendar size={12} />
                                    期間
                                </label>
                                <OptionSelector
                                    value={period}
                                    onChange={(next) => setPeriod(next as PeriodFilter)}
                                    ariaLabel="期間"
                                    menuStyle={{ minWidth: 'min(12rem, calc(100vw - 3rem))' }}
                                    options={periodOptions.map((opt) => ({
                                        value: opt.value,
                                        label: opt.label,
                                    }))}
                                />
                            </div>
                            <div style={{ flex: 1, minWidth: '140px' }}>
                                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.25rem' }}>
                                    <Users size={12} />
                                    キャラクター
                                </label>
                                <OptionSelector
                                    value={selectedCharacter}
                                    onChange={setSelectedCharacter}
                                    ariaLabel="キャラクター"
                                    searchable
                                    searchPlaceholder="キャラクター名で検索"
                                    searchAriaLabel="キャラクターを検索"
                                    menuStyle={{ minWidth: 'min(14rem, calc(100vw - 3rem))' }}
                                    options={[
                                        { value: 'all', label: '全体' },
                                        ...characters.map((c) => ({ value: c.id, label: c.name })),
                                    ]}
                                />
                            </div>
                            <div style={{ flex: 1, minWidth: '140px' }}>
                                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.25rem' }}>
                                    <BarChart3 size={12} />
                                    項目
                                </label>
                                <OptionSelector
                                    value={viewMode}
                                    onChange={(next) => setViewMode(next as ViewMode)}
                                    ariaLabel="項目"
                                    menuStyle={{ minWidth: 'min(12rem, calc(100vw - 3rem))' }}
                                    options={viewModeOptions.map((opt) => ({
                                        value: opt.value,
                                        label: opt.label,
                                    }))}
                                />
                            </div>
                        </div>

                        {/* Usage Trend */}
                        {chartData.length > 0 && (
                            <section className="statistics-chart-card" aria-labelledby="statistics-chart-heading">
                                <div className="statistics-chart-heading">
                                    <div>
                                        <h3 id="statistics-chart-heading">利用推移</h3>
                                        <p>{activeChartLabel}の推移</p>
                                    </div>
                                    {chartPeak && (
                                        <div className="statistics-chart-peak">
                                            <span>ピーク</span>
                                            <strong>{formatChartValue(chartPeak.value)}</strong>
                                        </div>
                                    )}
                                </div>
                                <div
                                    className="statistics-chart"
                                    role="img"
                                    aria-label={`${activeChartLabel}の利用推移。ピークは${chartPeak ? `${chartPeak.description}の${formatChartValue(chartPeak.value)}` : 'ありません'}`}
                                >
                                    <div className="statistics-chart-grid" aria-hidden="true">
                                        <span />
                                        <span />
                                        <span />
                                    </div>
                                    <div className="statistics-chart-bars" aria-hidden="true">
                                        {chartData.map((point) => {
                                            const height = chartMaximum > 0 ? (point.value / chartMaximum) * 100 : 0;

                                            return (
                                                <div
                                                    className="statistics-chart-bar-column"
                                                    key={point.start}
                                                    title={`${point.description}: ${formatChartValue(point.value)}`}
                                                >
                                                    <span
                                                        className="statistics-chart-bar"
                                                        style={{ height: point.value > 0 ? `${Math.max(height, 2)}%` : 0 }}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div
                                    className="statistics-chart-axis"
                                    style={{ gridTemplateColumns: `repeat(${chartLabelIndexes.length}, minmax(0, 1fr))` }}
                                    aria-hidden="true"
                                >
                                    {chartLabelIndexes.map((index) => (
                                        <span key={chartData[index].start}>{chartData[index].label}</span>
                                    ))}
                                </div>
                            </section>
                        )}

                        {/* Total Summary */}
                        <div className="card statistics-total-card">
                            <h3 className="statistics-total-heading">
                                合計
                            </h3>
                            {viewMode !== 'cost' ? (
                                <div className="statistics-total-metrics statistics-total-metrics-tokens">
                                    <div className="statistics-total-metric">
                                        <div className="statistics-total-label">入力</div>
                                        <div className="statistics-total-value">{formatTokens(totals.promptTokens)}</div>
                                    </div>
                                    <div className="statistics-total-metric">
                                        <div className="statistics-total-label">出力</div>
                                        <div className="statistics-total-value">{formatTokens(totals.completionTokens)}</div>
                                    </div>
                                    <div className="statistics-total-metric">
                                        <div className="statistics-total-label">合計</div>
                                        <div className="statistics-total-value">{formatTokens(totals.totalTokens)}</div>
                                    </div>
                                    <div className="statistics-total-metric">
                                        <div className="statistics-total-label">リクエスト</div>
                                        <div className="statistics-total-value">{formatTokens(totals.recordCount)}回</div>
                                    </div>
                                </div>
                            ) : (
                                <div className="statistics-total-metrics statistics-total-metrics-cost">
                                    <div className="statistics-total-metric">
                                        <div className="statistics-total-label">料金</div>
                                        <div className="statistics-total-value statistics-total-value-cost">{formatCost(totals.cost)}</div>
                                    </div>
                                    <div className="statistics-total-metric">
                                        <div className="statistics-total-label">リクエスト</div>
                                        <div className="statistics-total-value statistics-total-value-cost">{formatTokens(totals.recordCount)}回</div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Character Breakdown */}
                        {characterStats.length > 0 && (
                            <section className="statistics-breakdown" aria-labelledby="statistics-breakdown-heading">
                                <div className="statistics-breakdown-heading">
                                    <div>
                                        <h3 id="statistics-breakdown-heading">キャラクター別内訳</h3>
                                        <p>選択した期間の利用状況</p>
                                    </div>
                                </div>
                                <div className="statistics-table-wrapper">
                                    <table className="statistics-table">
                                        <caption>キャラクター別のリクエスト数、トークン数、料金</caption>
                                        <thead>
                                            <tr>
                                                <th scope="col">キャラクター</th>
                                                {renderSortableHeader('requests', 'リクエスト')}
                                                {renderSortableHeader('input', '入力')}
                                                {renderSortableHeader('output', '出力')}
                                                {renderSortableHeader('tokens', '合計トークン')}
                                                {renderSortableHeader('cost', '料金')}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {characterStats.map((stat, index) => {
                                                const selectedTotal = getMetricValue(totals, viewMode);
                                                const selectedValue = getMetricValue(stat, viewMode);
                                                const share = selectedTotal > 0 ? (selectedValue / selectedTotal) * 100 : 0;

                                                return (
                                                    <tr key={stat.characterId}>
                                                        <th scope="row">
                                                            <div className="statistics-character">
                                                                <span className="statistics-character-rank" aria-hidden="true">
                                                                    {index + 1}
                                                                </span>
                                                                <div className="statistics-character-details">
                                                                    <span className="statistics-character-name">{stat.characterName}</span>
                                                                    <div className="statistics-share">
                                                                        <span
                                                                            className="statistics-share-fill"
                                                                            style={{ width: `${share}%` }}
                                                                        />
                                                                    </div>
                                                                    <span className="statistics-share-label">全体の {share.toFixed(1)}%</span>
                                                                </div>
                                                            </div>
                                                        </th>
                                                        <td className={`statistics-table-number${viewMode === 'requests' ? ' is-active' : ''}`}>
                                                            {formatTokens(stat.recordCount)}回
                                                        </td>
                                                        <td className={`statistics-table-number${viewMode === 'input' ? ' is-active' : ''}`}>
                                                            {formatTokens(stat.promptTokens)}
                                                        </td>
                                                        <td className={`statistics-table-number${viewMode === 'output' ? ' is-active' : ''}`}>
                                                            {formatTokens(stat.completionTokens)}
                                                        </td>
                                                        <td className={`statistics-table-number${viewMode === 'tokens' ? ' is-active' : ''}`}>
                                                            {formatTokens(stat.totalTokens)}
                                                        </td>
                                                        <td className={`statistics-table-number${viewMode === 'cost' ? ' is-active' : ''}`}>
                                                            {formatCost(stat.cost)}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                        <tfoot>
                                            <tr>
                                                <th scope="row">合計</th>
                                                <td className={`statistics-table-number${viewMode === 'requests' ? ' is-active' : ''}`}>{formatTokens(totals.recordCount)}回</td>
                                                <td className={`statistics-table-number${viewMode === 'input' ? ' is-active' : ''}`}>{formatTokens(totals.promptTokens)}</td>
                                                <td className={`statistics-table-number${viewMode === 'output' ? ' is-active' : ''}`}>{formatTokens(totals.completionTokens)}</td>
                                                <td className={`statistics-table-number${viewMode === 'tokens' ? ' is-active' : ''}`}>
                                                    {formatTokens(totals.totalTokens)}
                                                </td>
                                                <td className={`statistics-table-number${viewMode === 'cost' ? ' is-active' : ''}`}>
                                                    {formatCost(totals.cost)}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>
                            </section>
                        )}

                        {characterStats.length === 0 && (
                            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                                <BarChart3 size={48} style={{ opacity: 0.5, marginBottom: '0.5rem' }} />
                                <p>選択した期間のデータがありません</p>
                            </div>
                        )}
        </div>
    );
}
