import { useState, useMemo, useEffect } from 'react';
import { BarChart3, Calendar, ChevronDown, Users } from 'lucide-react';
import { useStore, type UsageRecord } from '@/lib/store';

type ViewMode = 'tokens' | 'cost';
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
            return sum + (viewMode === 'tokens' ? record.totalTokens : record.cost);
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

        return Array.from(statsMap.values()).sort((a, b) => (
            viewMode === 'tokens'
                ? b.totalTokens - a.totalTokens
                : b.cost - a.cost
        ));
    }, [filteredRecords, characters, viewMode]);

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
    const formatChartValue = (value: number) => (
        viewMode === 'tokens' ? `${formatTokens(value)} トークン` : formatCost(value)
    );

    return (
        <div className="statistics-panel">
                        {/* Filters */}
                        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
                            <div style={{ flex: 1, minWidth: '140px' }}>
                                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.25rem' }}>
                                    <Calendar size={12} />
                                    期間
                                </label>
                                <div className="statistics-filter-select-wrapper">
                                    <select
                                        className="input statistics-filter-select"
                                        value={period}
                                        onChange={(e) => setPeriod(e.target.value as PeriodFilter)}
                                        style={{ width: '100%' }}
                                    >
                                        {periodOptions.map((opt) => (
                                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                                        ))}
                                    </select>
                                    <ChevronDown className="statistics-filter-select-arrow" size={16} aria-hidden="true" />
                                </div>
                            </div>
                            <div style={{ flex: 1, minWidth: '140px' }}>
                                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.25rem' }}>
                                    <Users size={12} />
                                    キャラクター
                                </label>
                                <div className="statistics-filter-select-wrapper">
                                    <select
                                        className="input statistics-filter-select"
                                        value={selectedCharacter}
                                        onChange={(e) => setSelectedCharacter(e.target.value)}
                                        style={{ width: '100%' }}
                                    >
                                        <option value="all">全体</option>
                                        {characters.map((c) => (
                                            <option key={c.id} value={c.id}>{c.name}</option>
                                        ))}
                                    </select>
                                    <ChevronDown className="statistics-filter-select-arrow" size={16} aria-hidden="true" />
                                </div>
                            </div>
                            <div style={{ flex: 1, minWidth: '140px' }}>
                                <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginBottom: '0.25rem' }}>
                                    <BarChart3 size={12} />
                                    項目
                                </label>
                                <div className="statistics-filter-select-wrapper">
                                    <select
                                        className="input statistics-filter-select"
                                        value={viewMode}
                                        onChange={(e) => setViewMode(e.target.value as ViewMode)}
                                        style={{ width: '100%' }}
                                    >
                                        <option value="tokens">トークン</option>
                                        <option value="cost">料金</option>
                                    </select>
                                    <ChevronDown className="statistics-filter-select-arrow" size={16} aria-hidden="true" />
                                </div>
                            </div>
                        </div>

                        {/* Usage Trend */}
                        {chartData.length > 0 && (
                            <section className="statistics-chart-card" aria-labelledby="statistics-chart-heading">
                                <div className="statistics-chart-heading">
                                    <div>
                                        <h3 id="statistics-chart-heading">利用推移</h3>
                                        <p>{viewMode === 'tokens' ? '合計トークン' : '料金'}の推移</p>
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
                                    aria-label={`${viewMode === 'tokens' ? 'トークン' : '料金'}の利用推移。ピークは${chartPeak ? `${chartPeak.description}の${formatChartValue(chartPeak.value)}` : 'ありません'}`}
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
                        <div className="card" style={{ marginBottom: '1rem', background: 'rgba(var(--accent-primary-rgb), 0.1)' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--accent-primary)' }}>
                                合計
                            </h3>
                            {viewMode === 'tokens' ? (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '1rem' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>入力</div>
                                        <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>{formatTokens(totals.promptTokens)}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>出力</div>
                                        <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>{formatTokens(totals.completionTokens)}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>合計</div>
                                        <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>{formatTokens(totals.totalTokens)}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>リクエスト</div>
                                        <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>{formatTokens(totals.recordCount)}回</div>
                                    </div>
                                </div>
                            ) : (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '1rem' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>料金</div>
                                        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{formatCost(totals.cost)}</div>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>リクエスト</div>
                                        <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{formatTokens(totals.recordCount)}回</div>
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
                                                <th scope="col" className="statistics-table-number">リクエスト</th>
                                                <th scope="col" className="statistics-table-number">入力</th>
                                                <th scope="col" className="statistics-table-number">出力</th>
                                                <th
                                                    scope="col"
                                                    className={`statistics-table-number${viewMode === 'tokens' ? ' is-active' : ''}`}
                                                >
                                                    合計トークン
                                                </th>
                                                <th
                                                    scope="col"
                                                    className={`statistics-table-number${viewMode === 'cost' ? ' is-active' : ''}`}
                                                >
                                                    料金
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {characterStats.map((stat, index) => {
                                                const selectedTotal = viewMode === 'tokens' ? totals.totalTokens : totals.cost;
                                                const selectedValue = viewMode === 'tokens' ? stat.totalTokens : stat.cost;
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
                                                        <td className="statistics-table-number">
                                                            {formatTokens(stat.recordCount)}回
                                                        </td>
                                                        <td className="statistics-table-number">
                                                            {formatTokens(stat.promptTokens)}
                                                        </td>
                                                        <td className="statistics-table-number">
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
                                                <td className="statistics-table-number">{formatTokens(totals.recordCount)}回</td>
                                                <td className="statistics-table-number">{formatTokens(totals.promptTokens)}</td>
                                                <td className="statistics-table-number">{formatTokens(totals.completionTokens)}</td>
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
