'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { useStore } from '@/lib/store';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onApply: (description: string) => void;
    initialDirection: string;
    currentDescription: string;
    situationName: string;
    participants: string[];
    initialModel: string;
}

export default function SituationDescriptionGeneratorModal({
    isOpen,
    onClose,
    onApply,
    initialDirection,
    currentDescription,
    situationName,
    participants,
    initialModel,
}: Props) {
    const { getAiProviderConfig } = useStore();
    const [direction, setDirection] = useState('');
    const [model, setModel] = useState('');
    const [generated, setGenerated] = useState('');
    const [draftDescription, setDraftDescription] = useState('');
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (isOpen) {
            setDirection(initialDirection);
            setModel(initialModel);
            setGenerated('');
            setDraftDescription('');
            setGenerating(false);
            setError(null);
        } else {
            abortRef.current?.abort();
            abortRef.current = null;
        }
    }, [isOpen, initialDirection, initialModel]);

    const attemptClose = () => {
        if (generating) return;
        onClose();
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') attemptClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [generating, onClose]);

    if (!isOpen) return null;

    const handleGenerate = async () => {
        if (!model.trim() || generating) return;
        setError(null);
        setGenerating(true);
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const normalizedDirection = direction.trim();
            const normalizedCurrent = currentDescription.trim();
            const res = await fetch('/api/generate-situation-description', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    direction: normalizedDirection,
                    currentDescription: normalizedCurrent === normalizedDirection ? '' : normalizedCurrent,
                    situationName: situationName.trim(),
                    participants,
                    model: model.trim(),
                    aiProviderConfig: getAiProviderConfig(),
                }),
                signal: controller.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data?.error || `生成に失敗しました (${res.status})`);
            }
            if (typeof data?.description !== 'string' || !data.description.trim()) {
                throw new Error('生成結果の形式が不正でした。');
            }
            const nextDescription = data.description.trim();
            setGenerated(nextDescription);
            setDraftDescription(nextDescription);
        } catch (e) {
            if (e instanceof Error && e.name !== 'AbortError') {
                setError(e.message);
            }
        } finally {
            setGenerating(false);
            abortRef.current = null;
        }
    };

    const handleCancel = () => {
        if (generating) {
            abortRef.current?.abort();
            setGenerating(false);
            return;
        }
        onClose();
    };

    const handleApply = () => {
        const description = draftDescription.trim();
        if (!generated || !description) return;
        onApply(description);
    };

    const isInitialGenerating = generating && !generated;
    const isRegenerating = generating && !!generated;

    return (
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) attemptClose();
            }}
        >
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
                <div className="modal-header">
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Sparkles size={18} />
                        シチュエーション説明生成
                    </h2>
                    <button className="btn btn-ghost" onClick={handleCancel} style={{ padding: '0.5rem' }} title="閉じる">
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div>
                        <label style={labelStyle}>方向性</label>
                        <textarea
                            className="input textarea"
                            value={direction}
                            onChange={(e) => setDirection(e.target.value)}
                            placeholder="例: 雨の夜、古い洋館、初対面のはずなのに互いを知っている"
                            style={{ minHeight: 110 }}
                            disabled={generating}
                        />
                    </div>

                    <div>
                        <label style={labelStyle}>生成モデル</label>
                        <input
                            type="text"
                            className="input"
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            disabled={generating}
                            placeholder="例: deepseek/deepseek-v4-flash"
                        />
                    </div>

                    {error && (
                        <p style={{ color: 'var(--error)', fontSize: '0.8125rem', lineHeight: 1.5 }}>
                            {error}
                        </p>
                    )}

                    {generated && (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.5rem',
                            padding: '1rem',
                            borderRadius: '0.5rem',
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-primary)',
                        }}>
                            <label style={labelStyle}>生成結果</label>
                            <textarea
                                className="input textarea"
                                value={draftDescription}
                                onChange={(e) => setDraftDescription(e.target.value)}
                                rows={8}
                                disabled={generating}
                            />
                        </div>
                    )}
                </div>

                <div className="modal-footer generation-modal-footer">
                    <button className="btn btn-ghost" onClick={handleCancel}>
                        {generating ? '中止' : 'キャンセル'}
                    </button>
                    {generated && (
                        <button
                            className={`btn btn-secondary generation-modal-regenerate${isRegenerating ? ' is-loading' : ''}`}
                            onClick={handleGenerate}
                            disabled={generating || !model.trim()}
                        >
                            {isRegenerating && <Loader2 size={16} className="animate-spin" />}
                            再生成
                        </button>
                    )}
                    <button
                        className="btn btn-primary"
                        onClick={generated ? handleApply : handleGenerate}
                        disabled={generating || !model.trim() || (!!generated && !draftDescription.trim())}
                    >
                        {isInitialGenerating && <Loader2 size={16} className="animate-spin" />}
                        {generated ? '説明に反映' : direction.trim() ? '生成' : 'おまかせ生成'}
                    </button>
                </div>
            </div>
        </div>
    );
}

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    marginBottom: '0.5rem',
    color: 'var(--text-secondary)',
};
