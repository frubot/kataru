'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Sparkles, Loader2, Upload } from 'lucide-react';
import { resizeToMaxEdge, cropSquareToJpeg, cropRectToPng, loadImage } from '@/lib/imageUtils';
import { CropArea, createInitialCrop, type CropBox } from './ImageCropArea';
import { useStore } from '@/lib/store';
const MAX_EDGE = 1024;
const AVATAR_SIZE = 128;
const IMAGE_ASPECT_RATIO = '2:3';
const AVATAR_ASPECT = 1;
const NEUTRAL_ASPECT = 2 / 3;

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onComplete: (avatarDataUrl: string, fullBodyDataUrl: string) => void;
}

type ImageSource = 'generated' | 'uploaded';
type CropTarget = 'neutral' | 'avatar';

export default function ImageGenerationModal({ isOpen, onClose, onComplete }: Props) {
    const { defaultImageModel, aiProvider, openAiCompatibleImageGenerationEnabled, getAiProviderConfig } = useStore();
    const [prompt, setPrompt] = useState('');
    const [model, setModel] = useState(defaultImageModel);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fullBody, setFullBody] = useState<string | null>(null);
    const [source, setSource] = useState<ImageSource | null>(null);
    const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
    const [avatarCrop, setAvatarCrop] = useState<CropBox | null>(null);
    const [neutralCrop, setNeutralCrop] = useState<CropBox | null>(null);
    const [cropTarget, setCropTarget] = useState<CropTarget>('avatar');
    const abortRef = useRef<AbortController | null>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const canGenerateImages = aiProvider === 'openrouter' || openAiCompatibleImageGenerationEnabled;
    const imageGenerationHint = aiProvider === 'openai-compatible'
        ? openAiCompatibleImageGenerationEnabled
            ? 'OpenAI互換APIでは、テキストからの画像生成だけを試します。'
            : 'OpenAI互換APIでの画像生成は無効です。ファイルからアップロードしてください。'
        : '例: full body portrait of a smiling young woman with long brown hair, 2:3 vertical composition, neutral expression';

    useEffect(() => {
        if (!isOpen) {
            setPrompt('');
            setModel(defaultImageModel);
            setGenerating(false);
            setError(null);
            setFullBody(null);
            setSource(null);
            setImgNatural(null);
            setAvatarCrop(null);
            setNeutralCrop(null);
            setCropTarget('avatar');
            abortRef.current?.abort();
            abortRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const attemptClose = () => {
        if (generating) return;
        if (fullBody && !window.confirm('生成した画像がまだ確定されていません。閉じますか？')) return;
        onClose();
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') attemptClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onClose, generating, fullBody]);

    const handleGenerate = async () => {
        if (!canGenerateImages || !prompt.trim() || !model.trim() || generating) return;
        setError(null);
        setGenerating(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const res = await fetch('/api/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: prompt.trim(),
                    model: model.trim(),
                    aspectRatio: IMAGE_ASPECT_RATIO,
                    aiProviderConfig: getAiProviderConfig(),
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || `生成に失敗しました (${res.status})`);
            }
            const data = await res.json();
            const resized = await resizeToMaxEdge(data.image, MAX_EDGE);
            const img = await loadImage(resized);
            setFullBody(resized);
            setSource('generated');
            setImgNatural({ w: img.width, h: img.height });
            setAvatarCrop(createInitialCrop(img.width, img.height, AVATAR_ASPECT));
            setNeutralCrop(null);
            setCropTarget('avatar');
        } catch (e) {
            if (e instanceof Error && e.name !== 'AbortError') {
                setError(e.message);
            }
        } finally {
            setGenerating(false);
            abortRef.current = null;
        }
    };

    const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setError(null);
        try {
            const dataUrl: string = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
            const resized = await resizeToMaxEdge(dataUrl, MAX_EDGE);
            const img = await loadImage(resized);
            setFullBody(resized);
            setSource('uploaded');
            setImgNatural({ w: img.width, h: img.height });
            setAvatarCrop(createInitialCrop(img.width, img.height, AVATAR_ASPECT));
            setNeutralCrop(createInitialCrop(img.width, img.height, NEUTRAL_ASPECT));
            setCropTarget('neutral');
        } catch (err) {
            setError(err instanceof Error ? err.message : '画像の読み込みに失敗しました');
        }
    };

    const handleCancel = () => {
        if (generating) {
            abortRef.current?.abort();
            setGenerating(false);
        } else {
            attemptClose();
        }
    };

    const handleConfirm = async () => {
        if (!fullBody || !avatarCrop) return;
        const neutral = source === 'uploaded' && neutralCrop
            ? await cropRectToPng(fullBody, neutralCrop.x, neutralCrop.y, neutralCrop.width, neutralCrop.height)
            : fullBody;
        const avatar = await cropSquareToJpeg(fullBody, avatarCrop.x, avatarCrop.y, avatarCrop.width, AVATAR_SIZE);
        onComplete(avatar, neutral);
        onClose();
    };

    const handleRegenerate = () => {
        setFullBody(null);
        setSource(null);
        setImgNatural(null);
        setAvatarCrop(null);
        setNeutralCrop(null);
        setCropTarget('avatar');
    };

    if (!isOpen) return null;

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
                        <Sparkles size={18} /> アバターの変更
                    </h2>
                    <button className="btn btn-ghost" onClick={handleCancel} style={{ padding: '0.5rem' }}>
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {!fullBody && (
                        <>
                            <div>
                                <label style={labelStyle}>プロンプト</label>
                                <textarea
                                    className="input textarea"
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    placeholder="生成したいキャラクターの説明（全身・縦長 2:3 が想定されます）"
                                    style={{ minHeight: 120 }}
                                    disabled={generating || !canGenerateImages}
                                />
                                <p style={hintStyle}>{imageGenerationHint}</p>
                            </div>
                            <div>
                                <label style={labelStyle}>モデル</label>
                                <input
                                    type="text"
                                    className="input"
                                    value={model}
                                    onChange={(e) => setModel(e.target.value)}
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

                    {fullBody && imgNatural && avatarCrop && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {source === 'uploaded' && neutralCrop && (
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button
                                        type="button"
                                        className={cropTarget === 'neutral' ? 'btn btn-primary' : 'btn btn-ghost'}
                                        onClick={() => setCropTarget('neutral')}
                                        style={{ flex: 1 }}
                                    >
                                        neutral 2:3
                                    </button>
                                    <button
                                        type="button"
                                        className={cropTarget === 'avatar' ? 'btn btn-primary' : 'btn btn-ghost'}
                                        onClick={() => setCropTarget('avatar')}
                                        style={{ flex: 1 }}
                                    >
                                        アバター
                                    </button>
                                </div>
                            )}

                            {source === 'uploaded' && cropTarget === 'neutral' && neutralCrop ? (
                                <CropArea
                                    key="neutral"
                                    imgRef={imgRef}
                                    src={fullBody}
                                    natural={imgNatural}
                                    crop={neutralCrop}
                                    aspect={NEUTRAL_ASPECT}
                                    hint="neutral はこの範囲を 2:3 で保存します"
                                    onChange={(next) => setNeutralCrop(next)}
                                />
                            ) : (
                                <CropArea
                                    key="avatar"
                                    imgRef={imgRef}
                                    src={fullBody}
                                    natural={imgNatural}
                                    crop={avatarCrop}
                                    aspect={AVATAR_ASPECT}
                                    hint="この範囲を 128×128 のアバターにします"
                                    onChange={(next) => setAvatarCrop(next)}
                                />
                            )}
                        </div>
                    )}
                </div>

                <div className="modal-footer">
                    {!fullBody && (
                        <>
                            <button className="btn btn-ghost" onClick={handleCancel}>
                                {generating ? '中止' : 'キャンセル'}
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={handleGenerate}
                                disabled={generating || !canGenerateImages || !prompt.trim() || !model.trim()}
                                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                            >
                                {generating && <Loader2 size={16} className="animate-spin" />}
                                {generating ? '生成中...' : '生成'}
                            </button>
                        </>
                    )}
                    {fullBody && (
                        <>
                            <button className="btn btn-ghost" onClick={handleRegenerate}>再生成</button>
                            <button className="btn btn-primary" onClick={handleConfirm}>確定</button>
                        </>
                    )}
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

const hintStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    marginTop: '0.375rem',
};
