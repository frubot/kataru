'use client';

import { useState, useMemo, useEffect } from 'react';
import { BarChart3, Calendar, ChevronDown, Users } from 'lucide-react';
import { useStore } from '@/lib/store';

type ViewMode = 'tokens' | 'cost';
type PeriodFilter = 'all' | 'thisMonth' | 'lastMonth' | 'last3Months' | 'lastYear';

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
            const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0).getTime();
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

        return Array.from(statsMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);
    }, [filteredRecords, characters]);

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

    return (
        <div className="statistics-panel animate-fade-in">
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

                        {/* Total Summary */}
                        <div className="card" style={{ marginBottom: '1rem', background: 'rgba(var(--accent-primary-rgb), 0.1)' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--accent-primary)' }}>
                                合計
                            </h3>
                            {viewMode === 'tokens' ? (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
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
                                </div>
                            ) : (
                                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                                    {formatCost(totals.cost)}
                                </div>
                            )}
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                                {totals.recordCount}回のリクエスト
                            </div>
                        </div>

                        {/* Character Breakdown */}
                        {selectedCharacter === 'all' && characterStats.length > 0 && (
                            <div>
                                <h3 style={{ fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.75rem', color: 'var(--text-secondary)' }}>
                                    キャラクター別内訳
                                </h3>
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    {characterStats.map((stat, index) => (
                                        <div
                                            key={stat.characterId}
                                            style={{
                                                padding: '0.75rem 0',
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center',
                                                borderBottom: index < characterStats.length - 1
                                                    ? '1px solid var(--border-color)'
                                                    : 'none',
                                            }}
                                        >
                                            <div>
                                                <div style={{ fontWeight: 500 }}>{stat.characterName}</div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                    {stat.recordCount}回
                                                </div>
                                            </div>
                                            <div style={{ textAlign: 'right' }}>
                                                {viewMode === 'tokens' ? (
                                                    <div style={{ fontWeight: 600 }}>
                                                        {formatTokens(stat.totalTokens)} トークン
                                                    </div>
                                                ) : (
                                                    <div style={{ fontWeight: 600 }}>
                                                        {formatCost(stat.cost)}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
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
