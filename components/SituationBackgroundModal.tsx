import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Loader2, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { resizeToMaxEdge } from '@/lib/imageUtils';
import { buildSituationBackgroundPrompt } from '@/lib/situationBackgroundGeneration';
import { useStore } from '@/lib/store';
import ModelSelector from './ModelSelector';
import StoredImage from './StoredImage';
import { useModalKeyboard } from './useModalKeyboard';

const MAX_BACKGROUND_EDGE = 1920;
const BACKGROUND_ASPECT_RATIO = '16:9';

interface SituationBackgroundModalProps {
    isOpen: boolean;
    currentImage?: string;
    initialPrompt?: string;
    onClose: () => void;
    onComplete: (image?: string) => void;
}

export default function SituationBackgroundModal({
    isOpen,
    currentImage,
    initialPrompt = '',
    onClose,
    onComplete,
}: SituationBackgroundModalProps) {
    const {
        aiApiType,
        defaultImageModel,
        getAiApiConfig,
        openAiCompatibleImageGenerationEnabled,
    } = useStore();
    const [selectingImage, setSelectingImage] = useState(!currentImage);
    const [prompt, setPrompt] = useState(initialPrompt);
    const [model, setModel] = useState(defaultImageModel);
    const [candidate, setCandidate] = useState<string | null>(null);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);

    useEffect(() => () => abortRef.current?.abort(), []);

    const canGenerateImages = aiApiType === 'openrouter'
        || (aiApiType === 'openai-compatible' && openAiCompatibleImageGenerationEnabled);
    const providerHint = aiApiType === 'anthropic'
        ? 'Anthropic APIでは画像生成を利用できません。ファイルからアップロードしてください。'
        : aiApiType === 'openai-compatible'
            ? openAiCompatibleImageGenerationEnabled
                ? 'OpenAI互換APIでは、テキストからの画像生成だけを試します。'
                : 'OpenAI互換APIでの画像生成は無効です。ファイルからアップロードしてください。'
            : '人物や文字を含まない、ビジュアルノベル用の横長背景として生成します。';

    const attemptClose = () => {
        if (generating) return;
        if (candidate && !window.confirm('選択した背景がまだ確定されていません。閉じますか？')) return;
        onClose();
    };

    useModalKeyboard({
        isOpen,
        containerRef: modalRef,
        onClose: attemptClose,
        canClose: !generating,
    });

    const handleGenerate = async () => {
        if (!canGenerateImages || !prompt.trim() || !model.trim() || generating) return;
        setError(null);
        setGenerating(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const response = await fetch('/api/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: buildSituationBackgroundPrompt(prompt),
                    model: model.trim(),
                    aspectRatio: BACKGROUND_ASPECT_RATIO,
                    aiApiConfig: getAiApiConfig(),
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data?.error || `生成に失敗しました (${response.status})`);
            }
            const data = await response.json();
            setCandidate(await resizeToMaxEdge(data.image, MAX_BACKGROUND_EDGE));
        } catch (cause) {
            if (cause instanceof Error && cause.name !== 'AbortError') {
                setError(cause.message);
            }
        } finally {
            setGenerating(false);
            abortRef.current = null;
        }
    };

    const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setError(null);
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
                reader.readAsDataURL(file);
            });
            setCandidate(await resizeToMaxEdge(dataUrl, MAX_BACKGROUND_EDGE));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : '画像の読み込みに失敗しました');
        }
    };

    const handleCancel = () => {
        if (generating) {
            abortRef.current?.abort();
            setGenerating(false);
            return;
        }
        attemptClose();
    };

    const handleRemove = () => {
        if (!window.confirm('設定中の背景を削除しますか？')) return;
        onComplete(undefined);
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div
            className="modal-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) attemptClose();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content"
                onClick={(event) => event.stopPropagation()}
                style={{ maxWidth: 720 }}
                role="dialog"
                aria-modal="true"
                aria-label="背景を編集"
            >
                <div className="modal-header">
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <ImageIcon size={18} /> 背景を編集
                    </h2>
                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={handleCancel}
                        disabled={generating}
                        style={{ padding: '0.5rem' }}
                        title="閉じる"
                        aria-label="閉じる"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {!selectingImage && currentImage ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            <div style={previewFrameStyle}>
                                <StoredImage
                                    src={currentImage}
                                    alt="設定中の背景"
                                    style={previewImageStyle}
                                    loading="eager"
                                />
                            </div>
                            <p style={hintStyle}>ビジュアルノベル表示のシーン背景として使用されます。</p>
                        </div>
                    ) : candidate ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            <div style={previewFrameStyle}>
                                <img src={candidate} alt="選択した背景のプレビュー" style={previewImageStyle} />
                            </div>
                            <p style={hintStyle}>画面いっぱいに表示するときは、表示領域に合わせて画像の端が切り取られる場合があります。</p>
                        </div>
                    ) : (
                        <>
                            <div>
                                <label style={labelStyle}>プロンプト</label>
                                <textarea
                                    className="input textarea"
                                    value={prompt}
                                    onChange={(event) => setPrompt(event.target.value)}
                                    placeholder="例: 放課後の教室。窓から夕日が差し込み、机が並んでいる"
                                    style={{ minHeight: 120 }}
                                    disabled={generating || !canGenerateImages}
                                />
                                <p style={hintStyle}>{providerHint}</p>
                            </div>
                            <div>
                                <label style={labelStyle}>モデル</label>
                                <ModelSelector
                                    value={model}
                                    onChange={setModel}
                                    outputModality="image"
                                    disabled={generating || !canGenerateImages}
                                />
                            </div>
                            {error && <p style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>{error}</p>}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>または</span>
                                <div style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
                            </div>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={generating}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                            >
                                <Upload size={16} /> ファイルからアップロード
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                onChange={handleFile}
                                style={{ display: 'none' }}
                            />
                        </>
                    )}
                </div>

                <div className="modal-footer">
                    {!selectingImage && currentImage ? (
                        <>
                            <button type="button" className="btn btn-danger" onClick={handleRemove}>
                                <Trash2 size={16} /> 削除
                            </button>
                            <button type="button" className="btn btn-primary" onClick={() => setSelectingImage(true)}>
                                画像を変更
                            </button>
                        </>
                    ) : candidate ? (
                        <>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => {
                                    setCandidate(null);
                                    setError(null);
                                }}
                            >
                                選び直す
                            </button>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => {
                                    onComplete(candidate);
                                    onClose();
                                }}
                            >
                                確定
                            </button>
                        </>
                    ) : (
                        <>
                            <button type="button" className="btn btn-ghost" onClick={handleCancel}>
                                {generating ? '中止' : 'キャンセル'}
                            </button>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={handleGenerate}
                                disabled={generating || !canGenerateImages || !prompt.trim() || !model.trim()}
                                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                            >
                                {generating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                {generating ? '生成中...' : 'AI生成'}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '0.5rem',
    color: 'var(--text-secondary)',
    fontSize: '0.875rem',
    fontWeight: 500,
};

const hintStyle: React.CSSProperties = {
    margin: 0,
    marginTop: '0.375rem',
    color: 'var(--text-muted)',
    fontSize: '0.75rem',
};

const previewFrameStyle: React.CSSProperties = {
    width: '100%',
    aspectRatio: '16 / 9',
    overflow: 'hidden',
    border: '1px solid var(--border-color)',
    borderRadius: '0.75rem',
    background: 'var(--bg-secondary)',
};

const previewImageStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
};
