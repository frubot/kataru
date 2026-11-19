import { useState, useEffect, useRef } from 'react';
import { X, Sparkles, Loader2, Upload } from 'lucide-react';
import { resizeToMaxEdge, cropSquareToJpeg, cropSquareToPng, cropRectToPng, loadImage } from '@/lib/imageUtils';
import {
    buildNativeTransparentFullBodyPrompt,
    buildTransparentFullBodyPrompt,
    removeAvatarChromaKeyBackground,
} from '@/lib/avatarImageGeneration';
import { useTransparentImageBackground } from '@/lib/useTransparentImageBackground';
import { CropArea, createInitialCrop, type CropBox } from './ImageCropArea';
import StoredImage from './StoredImage';
import { useStore } from '@/lib/store';
import { isAiConnectionKind } from '@/lib/aiApi';
import { useAiConnections } from '@/lib/aiConnections';
import { serializeModelRef, type ModelRef } from '@/lib/modelDefaults';
import type { Costume, VrmAvatar } from '@/lib/store/types';
import { isCostumeNameTaken } from '@/lib/costumes';
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
/** 最初の衣装の名前の初期値。 */
const INITIAL_COSTUME_NAME = 'default';

/**
 * 作成結果。`icon` はアイコンを更新するときだけ、`image` は衣装を作成するときだけ入る。
 * `costumeName` は target が 'icon' の画面から衣装も作成したときの衣装名。
 */
export type ImageGenerationResult = {
    icon?: string;
    image?: string;
    costumeName?: string;
    vrm?: VrmAvatar;
};

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onComplete: (result: ImageGenerationResult) => void;
    /**
     * 'costume' は衣装の画像（全身の立ち絵）を、'icon' はアイコンを作成する。
     * 画像ができた後の確定画面で、もう一方にも使うかを選べる。
     */
    target?: 'costume' | 'icon';
    /** target が 'costume' のとき、アイコンにも使う選択の初期値。 */
    defaultUpdateIcon?: boolean;
    /** target が 'icon' のとき、登録済みの衣装を渡すと衣装としても追加できる。 */
    costumes?: Costume[];
    title?: string;
    transparentFullBody?: boolean;
    /** Existing 2D expression names offered as VRM mapping targets. */
    expressionNames?: string[];
    /** Opens the VRM settings with the saved avatar when set. */
    initialVrm?: VrmAvatar;
    vrmPreviewName?: string;
    vrmFallbackImage?: string;
    /** false hides the file upload (images and .vrm); defaults to true. */
    allowUpload?: boolean;
}

type ImageSource = 'generated' | 'uploaded';
type CropTarget = 'neutral' | 'avatar';

export default function ImageGenerationModal({
    isOpen,
    onClose,
    onComplete,
    target = 'costume',
    defaultUpdateIcon,
    costumes,
    title,
    transparentFullBody = false,
    expressionNames = [],
    initialVrm,
    vrmPreviewName,
    vrmFallbackImage,
    allowUpload = true,
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
    // 衣装とアイコンの両方に使うか。false のときは target の側だけを作成する。
    const [useForBoth, setUseForBoth] = useState(target === 'costume' && (defaultUpdateIcon ?? false));
    const [costumeName, setCostumeName] = useState('');
    const canChooseUsage = target === 'costume' || costumes !== undefined;
    const createsImage = target === 'costume' || useForBoth;
    const createsIcon = target === 'icon' || useForBoth;
    const modalTitle = title ?? (target === 'icon' ? 'アイコンの変更' : '衣装をゼロから作成');
    const abortRef = useRef<AbortController | null>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const imgRef = useRef<HTMLImageElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const selectedConnection = connections.find((connection) => connection.id === model.connectionId) ?? null;
    const selectedKind = selectedConnection?.kind
        ?? (isAiConnectionKind(model.connectionId) ? model.connectionId : null);
    const canGenerateImages = selectedKind === 'openrouter'
        || (selectedKind === 'openai-compatible' && selectedConnection?.imageGenerationEnabled === true);
    const transparentImageSupport = useTransparentImageBackground(model);
    const useNativeTransparentBackground = transparentFullBody && transparentImageSupport.supported;
    const uploadFallbackHint = allowUpload
        ? 'ファイルからアップロードしてください。'
        : '衣装の追加画面の「アップロード」から追加してください。';
    const providerImageGenerationHint = selectedKind === 'anthropic'
        ? `Anthropic互換APIでは画像生成を利用できません。${uploadFallbackHint}`
        : selectedKind === 'openai-compatible'
        ? selectedConnection?.imageGenerationEnabled === true
            ? null
            : `この接続先での画像生成は無効です。${uploadFallbackHint}`
        : null;
    const imageGenerationHint = providerImageGenerationHint
        ?? (transparentFullBody
            ? null
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
        setUseForBoth(target === 'costume' && (defaultUpdateIcon ?? false));
        setCostumeName(costumes?.length === 0 ? INITIAL_COSTUME_NAME : '');
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
                        ? useNativeTransparentBackground
                            ? buildNativeTransparentFullBodyPrompt(prompt)
                            : buildTransparentFullBodyPrompt(prompt)
                        : prompt.trim(),
                    model: serializeModelRef(model),
                    aspectRatio: IMAGE_ASPECT_RATIO,
                    transparentBackground: useNativeTransparentBackground,
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
                ? useNativeTransparentBackground
                    ? resized
                    : (await removeAvatarChromaKeyBackground(resized)).dataUrl
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
            if (target === 'icon') {
                setError('アイコンには画像ファイルを選択してください。');
                return;
            }
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
            setNeutralCrop(canChooseUsage ? createInitialCrop(img.width, img.height, NEUTRAL_ASPECT, true) : null);
            setCropTarget(createsImage ? 'neutral' : 'avatar');
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
        onComplete({
            ...(createsIcon ? { icon: preview.capture('avatar') } : {}),
            image: preview.capture(),
            vrm: avatar,
        });
        onClose();
    };

    const handleUsageChange = (both: boolean) => {
        setUseForBoth(both);
        setError(null);
        // 新しく増えた側の切り抜きを先に表示する。
        if (both) setCropTarget(target === 'costume' ? 'avatar' : 'neutral');
    };

    const handleConfirm = async () => {
        if (!fullBody || !avatarCrop) return;
        const newCostumeName = target === 'icon' && createsImage ? costumeName.trim() : undefined;
        if (newCostumeName !== undefined) {
            if (!newCostumeName) {
                setError('衣装名を入力してください。');
                return;
            }
            if (isCostumeNameTaken(costumes ?? [], newCostumeName)) {
                setError(`「${newCostumeName}」は既に存在します。`);
                return;
            }
        }
        setError(null);
        const image = !createsImage
            ? undefined
            : source === 'uploaded' && neutralCrop
                ? await cropRectToPng(fullBody, neutralCrop.x, neutralCrop.y, neutralCrop.width, neutralCrop.height)
                : fullBody;
        const icon = !createsIcon
            ? undefined
            : source === 'generated' && transparentFullBody
                ? await cropSquareToPng(fullBody, avatarCrop.x, avatarCrop.y, avatarCrop.width, AVATAR_SIZE)
                : await cropSquareToJpeg(fullBody, avatarCrop.x, avatarCrop.y, avatarCrop.width, AVATAR_SIZE);
        onComplete({
            ...(icon ? { icon } : {}),
            ...(image ? { image } : {}),
            ...(image && newCostumeName ? { costumeName: newCostumeName } : {}),
        });
        onClose();
    };

    // 片方だけを作るときは、切り抜き対象をその側に固定する。
    const effectiveCropTarget: CropTarget = !createsIcon
        ? 'neutral'
        : !createsImage || !neutralCrop ? 'avatar' : cropTarget;

    const handleRegenerate = () => {
        setFullBody(null);
        setSource(null);
        setImgNatural(null);
        setAvatarCrop(null);
        setNeutralCrop(null);
        setCropTarget('avatar');
        setError(null);
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
                aria-label={modalTitle}
            >
                <div className="settings-form-modal-actions" style={{ justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0, paddingLeft: '0.25rem', fontSize: '0.9375rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Sparkles size={18} /> {modalTitle}
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
                                {imageGenerationHint && <p style={hintStyle}>{imageGenerationHint}</p>}
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
                                {selectedKind === 'openai-compatible' && (
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8125rem', cursor: generating || !model.model.trim() ? 'default' : 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={transparentImageSupport.marked}
                                            onChange={(event) => transparentImageSupport.setMarked(event.target.checked)}
                                            disabled={generating || !model.model.trim()}
                                        />
                                        このモデルは画像透過に対応しています
                                    </label>
                                )}
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
                            {allowUpload && (
                                <>
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
                                    {createsImage && <p style={hintStyle}>画像のほか、.vrm の3Dモデルも選択できます</p>}
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept={createsImage ? 'image/*,.vrm' : 'image/*'}
                                        onChange={handleFile}
                                        style={{ display: 'none' }}
                                    />
                                </>
                            )}
                        </>
                    )}

                    {fullBody && imgNatural && avatarCrop && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {canChooseUsage && (
                                <div>
                                    <label style={labelStyle}>使い道</label>
                                    <div style={{ display: 'flex', gap: 8 }} role="group" aria-label="使い道">
                                        <button
                                            type="button"
                                            className={useForBoth ? 'btn btn-ghost' : 'btn btn-primary'}
                                            aria-pressed={!useForBoth}
                                            onClick={() => handleUsageChange(false)}
                                            style={{ flex: 1 }}
                                        >
                                            {target === 'costume' ? '衣装のみ' : 'アイコンのみ'}
                                        </button>
                                        <button
                                            type="button"
                                            className={useForBoth ? 'btn btn-primary' : 'btn btn-ghost'}
                                            aria-pressed={useForBoth}
                                            onClick={() => handleUsageChange(true)}
                                            style={{ flex: 1 }}
                                        >
                                            衣装とアイコン
                                        </button>
                                    </div>
                                </div>
                            )}
                            {target === 'icon' && createsImage && (
                                <div>
                                    <label htmlFor="image-generation-costume-name" style={labelStyle}>衣装名</label>
                                    <input
                                        id="image-generation-costume-name"
                                        type="text"
                                        className="input"
                                        value={costumeName}
                                        onChange={(e) => setCostumeName(e.target.value)}
                                        placeholder="例: casual, school_uniform, dress"
                                    />
                                </div>
                            )}

                            {source === 'uploaded' && neutralCrop && createsIcon && createsImage && (
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button
                                        type="button"
                                        className={cropTarget === 'neutral' ? 'btn btn-primary' : 'btn btn-ghost'}
                                        onClick={() => setCropTarget('neutral')}
                                        style={{ flex: 1 }}
                                    >
                                        衣装の切り抜き
                                    </button>
                                    <button
                                        type="button"
                                        className={cropTarget === 'avatar' ? 'btn btn-primary' : 'btn btn-ghost'}
                                        onClick={() => setCropTarget('avatar')}
                                        style={{ flex: 1 }}
                                    >
                                        アイコンの切り抜き
                                    </button>
                                </div>
                            )}

                            {effectiveCropTarget === 'neutral' && neutralCrop ? (
                                <CropArea
                                    key="neutral"
                                    imgRef={imgRef}
                                    src={fullBody}
                                    natural={imgNatural}
                                    crop={neutralCrop}
                                    aspect={NEUTRAL_ASPECT}
                                    allowOverflow
                                    onChange={(next) => setNeutralCrop(next)}
                                />
                            ) : !createsIcon ? (
                                <div style={{ width: '100%', maxWidth: 260, margin: '0 auto', aspectRatio: '2 / 3', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                                    <StoredImage
                                        src={fullBody}
                                        alt="衣装のプレビュー"
                                        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                                    />
                                </div>
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

                            {error && <p style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>{error}</p>}
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
