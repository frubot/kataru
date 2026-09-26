import { useState, useEffect, useRef } from 'react';
import { X, Sparkles, Loader2, Upload } from 'lucide-react';
import { resizeToMaxEdge, cropSquareToJpeg, cropSquareToPng, cropRectToPng, loadImage } from '@/lib/imageUtils';
import {
    buildTransparentFullBodyPrompt,
    removeAvatarChromaKeyBackground,
} from '@/lib/avatarImageGeneration';
import { CropArea, createInitialCrop, type CropBox } from './ImageCropArea';
import { useStore } from '@/lib/store';
import { isAiConnectionKind } from '@/lib/aiApi';
import { useAiConnections } from '@/lib/aiConnections';
import { serializeModelRef, type ModelRef } from '@/lib/modelDefaults';
import type { VrmAvatar } from '@/lib/store/types';
import { readVrmFile } from '@/lib/vrm';
import ModelSelector from './ModelSelector';
import VrmEditorModal from './VrmEditorModal';
import type { VrmPreview } from './VrmAvatarView';
import { useModalKeyboard } from './useModalKeyboard';
const MAX_EDGE = 1536;
const AVATAR_SIZE = 128;
const IMAGE_ASPECT_RATIO = '2:3';
const AVATAR_ASPECT = 1;
const NEUTRAL_ASPECT = 2 / 3;

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onComplete: (avatarDataUrl: string, fullBodyDataUrl: string, vrm?: VrmAvatar) => void;
    transparentFullBody?: boolean;
    /** Existing 2D expression names offered as VRM mapping targets. */
    expressionNames?: string[];
    /** Opens the VRM settings with the saved avatar when set. */
    initialVrm?: VrmAvatar;
    vrmPreviewName?: string;
    vrmFallbackImage?: string;
}

type ImageSource = 'generated' | 'uploaded';
type CropTarget = 'neutral' | 'avatar';

export default function ImageGenerationModal({
    isOpen,
    onClose,
    onComplete,
    transparentFullBody = false,
    expressionNames = [],
    initialVrm,
    vrmPreviewName,
    vrmFallbackImage,
}: Props) {
    const { defaultImageModel, getAiApiConfig } = useStore();
    const { connections } = useAiConnections();
    const [prompt, setPrompt] = useState('');
    const [model, setModel] = useState<ModelRef>(defaultImageModel);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fullBody, setFullBody] = useState<string | null>(null);
    const [source, setSource] = useState<ImageSource | null>(null);
    const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
    const [avatarCrop, setAvatarCrop] = useState<CropBox | null>(null);
    const [neutralCrop, setNeutralCrop] = useState<CropBox | null>(null);
    const [cropTarget, setCropTarget] = useState<CropTarget>('avatar');
    const [vrmAvatar, setVrmAvatar] = useState<VrmAvatar | null>(initialVrm ?? null);
    const abortRef = useRef<AbortController | null>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const selectedConnection = connections.find((connection) => connection.id === model.connectionId) ?? null;
    const selectedKind = selectedConnection?.kind
        ?? (isAiConnectionKind(model.connectionId) ? model.connectionId : null);
    const canGenerateImages = selectedKind === 'openrouter'
        || (selectedKind === 'openai-compatible' && selectedConnection?.imageGenerationEnabled === true);
    const providerImageGenerationHint = selectedKind === 'anthropic'
        ? 'Anthropic互換APIでは画像生成を利用できません。ファイルからアップロードしてください。'
        : selectedKind === 'openai-compatible'
        ? selectedConnection?.imageGenerationEnabled === true
            ? 'OpenAI互換APIでは、テキストからの画像生成だけを試します。'
            : 'この接続先での画像生成は無効です。ファイルからアップロードしてください。'
        : null;
    const imageGenerationHint = providerImageGenerationHint
        ?? (transparentFullBody
            ? `全身の立ち絵を生成します。背景は自動で透過されます。`
            : '例: full body portrait of a smiling young woman with long brown hair, 2:3 vertical composition, neutral expression');

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
        setVrmAvatar(initialVrm ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const attemptClose = () => {
        if (generating) return;
        if (fullBody && !window.confirm('生成した画像がまだ確定されていません。閉じますか？')) return;
        if (vrmAvatar && vrmAvatar !== initialVrm
            && !window.confirm('VRMの設定がまだ確定されていません。閉じますか？')) return;
        onClose();
    };

    useModalKeyboard({
        isOpen,
        containerRef: modalRef,
        onClose: attemptClose,
        canClose: !generating,
    });

    const handleGenerate = async () => {
        if (!canGenerateImages || !prompt.trim() || !model.model.trim() || generating) return;
        setError(null);
        setGenerating(true);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const res = await fetch('/api/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: transparentFullBody
                        ? buildTransparentFullBodyPrompt(prompt)
                        : prompt.trim(),
                    model: serializeModelRef(model),
                    aspectRatio: IMAGE_ASPECT_RATIO,
                    aiApiConfig: { ...getAiApiConfig(), connectionId: model.connectionId },
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || `生成に失敗しました (${res.status})`);
            }
            const data = await res.json();
            const resized = await resizeToMaxEdge(data.image, MAX_EDGE);
            const processed = transparentFullBody
                ? (await removeAvatarChromaKeyBackground(resized)).dataUrl
                : resized;
            const img = await loadImage(processed);
            setFullBody(processed);
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
        if (file.name.toLowerCase().endsWith('.vrm')) {
            try {
                const avatar = await readVrmFile(file);
                setVrmAvatar(avatar);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'VRMの読み込みに失敗しました');
            }
            return;
        }
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

    const handleVrmEditorClose = () => {
        if (vrmAvatar && vrmAvatar !== initialVrm
            && !window.confirm('VRMの設定がまだ確定されていません。閉じますか？')) return;
        setVrmAvatar(null);
        setError(null);
    };

    const handleConfirmVrm = (avatar: VrmAvatar, preview: VrmPreview) => {
        onComplete(preview.capture('avatar'), preview.capture(), avatar);
        onClose();
    };

    const handleConfirm = async () => {
        if (!fullBody || !avatarCrop) return;
        const neutral = source === 'uploaded' && neutralCrop
            ? await cropRectToPng(fullBody, neutralCrop.x, neutralCrop.y, neutralCrop.width, neutralCrop.height)
            : fullBody;
        const avatar = source === 'generated' && transparentFullBody
            ? await cropSquareToPng(fullBody, avatarCrop.x, avatarCrop.y, avatarCrop.width, AVATAR_SIZE)
            : await cropSquareToJpeg(fullBody, avatarCrop.x, avatarCrop.y, avatarCrop.width, AVATAR_SIZE);
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
            <div
                ref={modalRef}
                className="modal-content settings-form-modal"
                onClick={(e) => e.stopPropagation()}
                style={{ maxWidth: 640 }}
                role="dialog"
                aria-modal="true"
                aria-label="アバターの変更"
            >
                <div className="settings-form-modal-actions" style={{ justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0, paddingLeft: '0.25rem', fontSize: '0.9375rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Sparkles size={18} /> アバターの変更
                    </h2>
                    <button className="btn btn-ghost" onClick={handleCancel} disabled={generating} title="閉じる" aria-label="閉じる">
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {!fullBody && !vrmAvatar && (
                        <>
                            <div>
                                <label style={labelStyle}>プロンプト</label>
                                <textarea
                                    className="input textarea"
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    placeholder={transparentFullBody
                                        ? '生成したいキャラクターの説明（全身・立ち絵・透過背景は自動で指定されます）'
                                        : '生成したいキャラクターの説明（全身・縦長 2:3 が想定されます）'}
                                    style={{ minHeight: 120 }}
                                    disabled={generating || !canGenerateImages}
                                />
                                <p style={hintStyle}>{imageGenerationHint}</p>
                            </div>
                            <div className="image-generation-model-section">
                                <div className="global-settings-selector-row">
                                    <label htmlFor="avatar-image-model" style={modelLabelStyle}>モデル</label>
                                    <div className="global-settings-selector-control global-settings-model-selector-control">
                                        <ModelSelector
                                            id="avatar-image-model"
                                            value={model}
                                            onChange={setModel}
                                            outputModality="image"
                                            disabled={generating || !canGenerateImages}
                                        />
                                    </div>
                                </div>
                                <div className="image-generation-model-actions">
                                    {generating && (
                                        <button className="btn btn-ghost" onClick={handleCancel}>
                                            生成をキャンセル
                                        </button>
                                    )}
                                    <button
                                        className="btn btn-primary"
                                        onClick={handleGenerate}
                                        disabled={generating || !canGenerateImages || !prompt.trim() || !model.model.trim()}
                                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                    >
                                        {generating && <Loader2 size={16} className="animate-spin" />}
                                        {generating ? '生成中...' : '生成'}
                                    </button>
                                </div>
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
                            <p style={hintStyle}>画像のほか、.vrm の3Dモデルも選択できます</p>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*,.vrm"
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
                                    onChange={(next) => setAvatarCrop(next)}
                                />
                            )}

                            <div className="image-generation-inline-actions">
                                <button className="btn btn-ghost" onClick={handleRegenerate}>再生成</button>
                                <button className="btn btn-primary" onClick={handleConfirm}>確定</button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {vrmAvatar && (
                <VrmEditorModal
                    avatar={vrmAvatar}
                    name={vrmPreviewName ?? 'キャラクター'}
                    fallbackImage={vrmFallbackImage}
                    expressionNames={expressionNames}
                    onChange={setVrmAvatar}
                    onConfirm={handleConfirmVrm}
                    onClose={handleVrmEditorClose}
                />
            )}
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

const modelLabelStyle: React.CSSProperties = {
    color: 'var(--text-secondary)',
    fontSize: '0.875rem',
    fontWeight: 500,
};

const hintStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    marginTop: '0.375rem',
};
