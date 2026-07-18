import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import {
    formatGeneratedCharacterPrompt,
    formatGeneratedProtagonistPrompt,
    normalizeGeneratedCharacterProfile,
    type GeneratedCharacterProfile,
} from '@/lib/characterGeneration';
import { useStore } from '@/lib/store';

interface GeneratedCharacterDraft {
    name: string;
    systemPrompt: string;
    protagonistPrompt: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onApply: (draft: GeneratedCharacterDraft) => void;
}

export default function CharacterGeneratorModal({ isOpen, onClose, onApply }: Props) {
    const { defaultAutoGenerationModel, getAiProviderConfig } = useStore();
    const [direction, setDirection] = useState('');
    const [model, setModel] = useState(defaultAutoGenerationModel);
    const [generated, setGenerated] = useState<GeneratedCharacterProfile | null>(null);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!isOpen) {
            setDirection('');
            setModel(defaultAutoGenerationModel);
            setGenerated(null);
            setGenerating(false);
            setError(null);
            abortRef.current?.abort();
            abortRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

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
            const res = await fetch('/api/generate-character', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    direction: direction.trim(),
                    model: model.trim(),
                    aiProviderConfig: getAiProviderConfig(),
                }),
                signal: controller.signal,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data?.error || `生成に失敗しました (${res.status})`);
            }
            const character = normalizeGeneratedCharacterProfile(data?.character);
            if (!character) {
                throw new Error('生成結果の形式が不正でした。');
            }
            setGenerated(character);
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
        if (!generated) return;
        onApply({
            name: generated.name,
            systemPrompt: formatGeneratedCharacterPrompt(generated),
            protagonistPrompt: formatGeneratedProtagonistPrompt(generated),
        });
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
                        <Sparkles size={18} /> キャラクター生成
                    </h2>
                    <button className="btn btn-ghost" onClick={handleCancel} style={{ padding: '0.5rem' }}>
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
                            placeholder="例: 明るい先輩、退廃的なSF世界の案内人"
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
                            placeholder="例: z-ai/glm-5.1"
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
                            gap: '0.75rem',
                            padding: '1rem',
                            borderRadius: '0.5rem',
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-primary)',
                        }}>
                            <PreviewRow label="名前" value={generated.name} />
                            <PreviewRow label="性別" value={generated.gender} />
                            <PreviewRow label="一人称" value={generated.firstPerson} />
                            <PreviewRow label="主人公への呼び方" value={generated.protagonistAddress} />
                            <PreviewRow label="主人公から見た関係性" value={generated.relationship} />
                            <PreviewRow label="詳細" value={generated.details} />
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
                        disabled={generating || !model.trim()}
                    >
                        {isInitialGenerating && <Loader2 size={16} className="animate-spin" />}
                        {generated ? '設定に反映' : direction.trim() ? '生成' : 'おまかせ生成'}
                    </button>
                </div>
            </div>
        </div>
    );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: '9rem minmax(0, 1fr)', gap: '0.75rem', alignItems: 'start' }}>
            <div style={previewLabelStyle}>{label}</div>
            <div style={previewValueStyle}>{value}</div>
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

const previewLabelStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    lineHeight: 1.6,
};

const previewValueStyle: React.CSSProperties = {
    fontSize: '0.875rem',
    color: 'var(--text-primary)',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
};
