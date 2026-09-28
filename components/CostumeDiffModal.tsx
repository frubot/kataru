import { useState, useEffect, useRef } from 'react';
import { Check, X, Loader2, Pencil, Plus, Trash2, RefreshCw, Shirt, Sparkles, Upload } from 'lucide-react';
import type { Costume } from '@/lib/store';
import type { VrmAvatar } from '@/lib/store/types';
import { useStore } from '@/lib/store';
import { isAiConnectionKind } from '@/lib/aiApi';
import { useAiConnections } from '@/lib/aiConnections';
import { serializeModelRef, type ModelRef } from '@/lib/modelDefaults';
import { readVrmFile } from '@/lib/vrm';
import { createNameRegistry, reserveUniqueName } from '@/lib/nameRegistry';
import { buildBaseImageRequest, resolveStoredImageUrl } from '@/lib/imageSource';
import { cropRectToPng, loadImage, resizeToMaxEdge, resizeToMaxEdgeAsJpeg } from '@/lib/imageUtils';
import { CropArea, createInitialCrop, type CropBox } from './ImageCropArea';
import StoredImage from './StoredImage';
import ModelSelector from './ModelSelector';
import { useModalKeyboard } from './useModalKeyboard';
import { useTransparentImageBackground } from '@/lib/useTransparentImageBackground';
import VrmCostumeEditor from './VrmCostumeEditor';

const MAX_EDGE = 1536;
const COSTUME_ASPECT_RATIO = '2:3';
const COSTUME_ASPECT = 2 / 3;
const COSTUME_DETECTION_MAX_EDGE = 1280;
const COSTUME_DETECTION_JPEG_QUALITY = 0.85;
const NEW_BUSY_KEY = '__new__';
const UPLOAD_BUSY_KEY = '__upload__';
const DEFAULT_COSTUME_NAME = 'default';

type AddMode = 'generate' | 'upload';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    baseImage?: string;
    costumes: Costume[];
    expressionNames?: string[];
    onUpsert: (costume: Costume) => void;
    onRename: (currentName: string, nextName: string) => void;
    onRemove: (name: string) => void;
}

export default function CostumeDiffModal({ isOpen, onClose, baseImage, costumes, expressionNames, onUpsert, onRename, onRemove }: Props) {
    const { defaultImageModel, getAiApiConfig } = useStore();
    const { connections } = useAiConnections();
    const [newName, setNewName] = useState('');
    const [newPromptDetail, setNewPromptDetail] = useState('');
    const [autoDetectName, setAutoDetectName] = useState(false);
    const [addMode, setAddMode] = useState<AddMode>('generate');
    const [editingVrm, setEditingVrm] = useState<Costume | null>(null);
    const [vrmDraft, setVrmDraft] = useState<VrmAvatar | null>(null);
    const [model, setModel] = useState<ModelRef>(defaultImageModel);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadImgRef = useRef<HTMLImageElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const addModalRef = useRef<HTMLDivElement>(null);
    const [addOpen, setAddOpen] = useState(false);
    const reservedDetectedNamesRef = useRef<Set<string>>(new Set());
    const [uploadImage, setUploadImage] = useState<string | null>(null);
    const [uploadNatural, setUploadNatural] = useState<{ w: number; h: number } | null>(null);
    const [uploadCrop, setUploadCrop] = useState<CropBox | null>(null);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);
    const [uploadIndex, setUploadIndex] = useState(0);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editingNameValue, setEditingNameValue] = useState('');
    const [draftImage, setDraftImage] = useState<string | null>(null);
    const [draftName, setDraftName] = useState('');

    const selectedConnection = connections.find((connection) => connection.id === model.connectionId) ?? null;
    const selectedKind = selectedConnection?.kind
        ?? (isAiConnectionKind(model.connectionId) ? model.connectionId : null);
    const canGenerateDiffs = selectedKind === 'openrouter'
        || (selectedKind === 'openai-compatible' && selectedConnection?.imageGenerationEnabled === true);
    const transparentImageSupport = useTransparentImageBackground(model);

    useEffect(() => {
        if (isOpen && costumes.length === 0) setAddOpen(true);
        if (!isOpen) {
            setAddOpen(false);
            setNewName('');
            setEditingVrm(null);
            setVrmDraft(null);
            setNewPromptDetail('');
            setAutoDetectName(false);
            setAddMode(canGenerateDiffs ? 'generate' : 'upload');
            setModel(defaultImageModel);
            setBusy(null);
            setError(null);
            setUploadImage(null);
            setUploadNatural(null);
            setUploadCrop(null);
            setUploadFiles([]);
            setUploadIndex(0);
            reservedDetectedNamesRef.current.clear();
            setEditingName(null);
            setEditingNameValue('');
            setDraftImage(null);
            setDraftName('');
            abortRef.current?.abort();
            abortRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    useEffect(() => {
        if (!canGenerateDiffs && addMode === 'generate') {
            setAddMode('upload');
        }
    }, [addMode, canGenerateDiffs]);

    const clearUploadDraft = () => {
        setUploadImage(null);
        setUploadNatural(null);
        setUploadCrop(null);
    };

    const clearUploadQueue = () => {
        clearUploadDraft();
        setUploadFiles([]);
        setUploadIndex(0);
        reservedDetectedNamesRef.current.clear();
    };

    const prepareUpload = async (file: File) => {
        const dataUrl: string = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error(`${file.name} の読み込みに失敗しました。`));
            reader.readAsDataURL(file);
        });
        const resized = await resizeToMaxEdge(dataUrl, MAX_EDGE);
        const img = await loadImage(resized);
        setUploadImage(resized);
        setUploadNatural({ w: img.width, h: img.height });
        setUploadCrop(createInitialCrop(img.width, img.height, COSTUME_ASPECT));
    };

    const detectedNameRegistry = () => createNameRegistry([
        DEFAULT_COSTUME_NAME,
        ...costumes.map((costume) => costume.name),
    ]);

    const detectCostumeName = async (
        image: string,
        signal?: AbortSignal,
        reservedNames = detectedNameRegistry(),
    ) => {
        const [analysisImage, referenceImage] = await Promise.all([
            resizeToMaxEdgeAsJpeg(
                image,
                COSTUME_DETECTION_MAX_EDGE,
                COSTUME_DETECTION_JPEG_QUALITY,
            ),
            baseImage
                ? resizeToMaxEdgeAsJpeg(
                    resolveStoredImageUrl(baseImage),
                    COSTUME_DETECTION_MAX_EDGE,
                    COSTUME_DETECTION_JPEG_QUALITY,
                )
                : undefined,
        ]);
        const response = await fetch('/api/detect-costume-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: analysisImage,
                referenceImage,
                aiApiConfig: getAiApiConfig(),
            }),
            signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data?.error || `衣装名の自動判定に失敗しました (${response.status})`);
        }
        if (typeof data?.name !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(data.name)) {
            throw new Error('衣装名の自動判定結果が不正です。');
        }
        return reserveUniqueName(data.name, reservedNames, '衣装名');
    };

    const buildPrompt = (name: string, promptDetail?: string) => {
        const detail = promptDetail?.trim();
        return [
            name
                ? `Change the character's outfit/costume to ${name}.`
                : detail
                    ? 'Change the character\'s outfit/costume according to the costume-specific guidance below.'
                    : 'Change the character\'s outfit/costume to a distinct, clearly identifiable outfit.',
            detail ? `Costume-specific guidance: ${detail}` : null,
            'Keep the same character identity, face, body proportions, hairstyle, pose, background, composition, and art style.',
            'Use a neutral facial expression and keep the full-body 2:3 portrait framing.',
        ].filter(Boolean).join('\n');
    };

    const isDefaultCostume = (name: string) => name.toLowerCase() === DEFAULT_COSTUME_NAME;

    const validateName = () => {
        const name = newName.trim();
        if (!name || busy) return null;
        const lowerName = name.toLowerCase();
        if (lowerName === DEFAULT_COSTUME_NAME) {
            setError('「default」は予約名です。別の衣装名を使ってください。');
            return null;
        }
        if (costumes.some((c) => c.name.toLowerCase() === lowerName)) {
            setError(`「${name}」は既に存在します。`);
            return null;
        }
        setError(null);
        return name;
    };

    const requestImage = async (name: string, promptDetail: string | undefined, signal: AbortSignal) => {
        const prompt = buildPrompt(name, promptDetail);
        const res = await fetch('/api/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt,
                model: serializeModelRef(model),
                ...buildBaseImageRequest(baseImage as string),
                aspectRatio: COSTUME_ASPECT_RATIO,
                transparentBackground: transparentImageSupport.supported,
                aiApiConfig: { ...getAiApiConfig(), connectionId: model.connectionId },
            }),
            signal,
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data?.error || `生成に失敗しました (${res.status})`);
        }
        const data = await res.json();
        return resizeToMaxEdge(data.image, MAX_EDGE);
    };

    const generateDraft = async () => {
        if (busy || !model.model.trim() || !canGenerateDiffs) return;
        const name = autoDetectName ? '' : validateName();
        if (!autoDetectName && !name) return;
        if (!baseImage) {
            setError('生成には「アバター画像」から立ち絵の登録が必要です。');
            return;
        }
        setError(null);
        setBusy(NEW_BUSY_KEY);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const resized = await requestImage(name ?? '', newPromptDetail.trim() || undefined, controller.signal);
            const resolvedName = autoDetectName
                ? await detectCostumeName(resized, controller.signal)
                : name!;
            setDraftName(resolvedName);
            setDraftImage(resized);
        } catch (e) {
            if (e instanceof Error && e.name !== 'AbortError') {
                setError(e.message);
            }
        } finally {
            setBusy(null);
            abortRef.current = null;
        }
    };

    const confirmDraft = () => {
        if (!draftImage || busy) return false;
        const name = autoDetectName ? draftName : validateName();
        if (!name) return false;
        if (costumes.some((costume) => costume.name.toLowerCase() === name.toLowerCase())) {
            setError(`「${name}」は既に存在します。`);
            return false;
        }
        onUpsert({
            name,
            promptDetail: newPromptDetail.trim() || undefined,
            image: draftImage,
        });
        setNewName('');
        setNewPromptDetail('');
        setDraftImage(null);
        setDraftName('');
        setError(null);
        return true;
    };

    const handleAdd = () => {
        if (draftImage) {
            confirmDraft();
        } else {
            void generateDraft();
        }
    };

    const handleUploadClick = () => {
        if (!autoDetectName && !validateName()) return;
        fileInputRef.current?.click();
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = Array.from(e.target.files ?? []);
        e.target.value = '';
        const files = autoDetectName ? selectedFiles : selectedFiles.slice(0, 1);
        if (files.length === 0) return;

        if (!autoDetectName && !validateName()) return;

        if (files[0].name.toLowerCase().endsWith('.vrm')) {
            if (autoDetectName) {
                setError('VRMのアップロードでは衣装名の自動判定は使用できません。衣装名を入力して選択してください。');
                return;
            }
            setBusy(UPLOAD_BUSY_KEY);
            clearUploadQueue();
            try {
                setVrmDraft(await readVrmFile(files[0]));
            } catch (err) {
                setError(err instanceof Error ? err.message : 'VRMの読み込みに失敗しました');
            } finally {
                setBusy(null);
            }
            return;
        }

        const invalidFile = files.find((file) => !file.type.startsWith('image/'));
        if (invalidFile) {
            setError(autoDetectName
                ? `${invalidFile.name} は画像ファイルではありません。`
                : '画像または .vrm ファイルを選択してください。');
            return;
        }

        setBusy(UPLOAD_BUSY_KEY);
        setError(null);
        clearUploadDraft();
        setVrmDraft(null);
        try {
            setUploadFiles(files);
            setUploadIndex(0);
            reservedDetectedNamesRef.current = detectedNameRegistry();
            await prepareUpload(files[0]);
        } catch (e) {
            clearUploadQueue();
            setError(e instanceof Error ? e.message : '画像の読み込みに失敗しました');
        } finally {
            setBusy(null);
        }
    };

    const handleConfirmUpload = async (finishAfter = false): Promise<boolean> => {
        const manualName = autoDetectName ? null : validateName();
        if ((!autoDetectName && !manualName) || !uploadImage || !uploadCrop) return false;

        setBusy(UPLOAD_BUSY_KEY);
        setError(null);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const cropped = await cropRectToPng(
                uploadImage,
                uploadCrop.x,
                uploadCrop.y,
                uploadCrop.width,
                uploadCrop.height,
            );
            const name = autoDetectName
                ? await detectCostumeName(
                    cropped,
                    controller.signal,
                    reservedDetectedNamesRef.current,
                )
                : manualName!;
            onUpsert({ name, image: cropped });
            setNewName('');
            setNewPromptDetail('');
            const nextIndex = uploadIndex + 1;
            if (!finishAfter && autoDetectName && nextIndex < uploadFiles.length) {
                setUploadIndex(nextIndex);
                clearUploadDraft();
                try {
                    await prepareUpload(uploadFiles[nextIndex]);
                } catch (nextError) {
                    clearUploadQueue();
                    throw nextError;
                }
            } else {
                clearUploadQueue();
            }
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : '画像の切り取りに失敗しました');
            return false;
        } finally {
            setBusy(null);
            abortRef.current = null;
        }
    };

    const costumeNameExists = (name: string, currentName?: string) => costumes.some((costume) => (
        costume.name !== currentName
        && costume.name.toLowerCase() === name.toLowerCase()
    ));

    const saveCostumeName = (currentName: string) => {
        const nextName = editingNameValue.trim();
        if (!nextName) {
            setError('衣装名を入力してください。');
            return;
        }
        if (nextName.toLowerCase() === DEFAULT_COSTUME_NAME) {
            setError('「default」は予約名です。別の衣装名を使ってください。');
            return;
        }
        if (costumeNameExists(nextName, currentName)) {
            setError(`「${nextName}」は既に存在します。`);
            return;
        }
        if (nextName !== currentName) {
            onRename(currentName, nextName);
        }
        setEditingName(null);
        setEditingNameValue('');
        setError(null);
    };

    const handleCancelBusy = () => {
        abortRef.current?.abort();
        setBusy(null);
    };

    const closeAddModal = () => {
        if (busy) return;
        setAddOpen(false);
        setNewName('');
        setNewPromptDetail('');
        setError(null);
        clearUploadQueue();
        setDraftImage(null);
        setDraftName('');
        setVrmDraft(null);
    };

    const handleAddAndClose = () => {
        if (addMode === 'generate') {
            if (confirmDraft()) closeAddModal();
            return;
        }
        void (async () => {
            if (await handleConfirmUpload(true)) setAddOpen(false);
        })();
    };

    useModalKeyboard({
        isOpen,
        containerRef: modalRef,
        onClose,
        canClose: !busy,
    });

    useModalKeyboard({
        isOpen: isOpen && addOpen,
        containerRef: addModalRef,
        onClose: closeAddModal,
        canClose: !busy,
        onEnter: addMode === 'generate' ? handleAdd : undefined,
    });

    if (!isOpen) return null;

    return (
        <>
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget && !busy) onClose();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content settings-form-modal"
                onClick={(e) => e.stopPropagation()}
                style={{ maxWidth: 640 }}
                role="dialog"
                aria-modal="true"
                aria-label="衣装差分"
            >
                <div className="settings-form-modal-actions" style={{ justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0, paddingLeft: '0.25rem', fontSize: '0.9375rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Shirt size={18} /> 衣装差分
                    </h2>
                    <button className="btn btn-ghost" onClick={() => !busy && onClose()} disabled={!!busy} title="閉じる" aria-label="閉じる">
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {error && <p style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>{error}</p>}

                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
                            <label style={{ ...labelStyle, marginBottom: 0 }}>登録済み（{costumes.length}件）</label>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => { setError(null); setAddOpen(true); }}
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: '0.75rem' }}
                            >
                                <Plus size={14} /> 追加
                            </button>
                        </div>
                        {costumes.length === 0 && (
                            <p style={hintStyle}>まだ登録されていません。衣装を追加するとゲームモードで選択できるようになります。</p>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                            {costumes.map((costume) => {
                                const isDefault = isDefaultCostume(costume.name);
                                return (
                                    <div
                                        key={costume.name}
                                        style={{
                                            border: '1px solid var(--border-color)',
                                            borderRadius: 8,
                                            overflow: 'hidden',
                                            background: 'var(--bg-tertiary)',
                                        }}
                                    >
                                        <div style={{ aspectRatio: '2 / 3', background: '#000', position: 'relative' }}>
                                            <StoredImage
                                                src={costume.image}
                                                alt={costume.name}
                                                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                                            />
                                        </div>
                                        <div style={{ padding: '8px 10px' }}>
                                            {editingName === costume.name ? (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                                    <input
                                                        type="text"
                                                        className="input"
                                                        value={editingNameValue}
                                                        onChange={(event) => setEditingNameValue(event.target.value)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') {
                                                                event.preventDefault();
                                                                saveCostumeName(costume.name);
                                                            } else if (event.key === 'Escape') {
                                                                event.preventDefault();
                                                                setEditingName(null);
                                                                setEditingNameValue('');
                                                            }
                                                        }}
                                                        disabled={!!busy}
                                                        autoFocus
                                                        aria-label={`${costume.name}の衣装名`}
                                                        style={{ minWidth: 0, fontSize: '0.75rem' }}
                                                    />
                                                    <button
                                                        type="button"
                                                        className="btn btn-ghost"
                                                        title="変更を保存"
                                                        aria-label="変更を保存"
                                                        disabled={!!busy || !editingNameValue.trim()}
                                                        onClick={() => saveCostumeName(costume.name)}
                                                        style={{ padding: '4px 6px' }}
                                                    >
                                                        <Check size={14} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="btn btn-ghost"
                                                        title="変更をキャンセル"
                                                        aria-label="変更をキャンセル"
                                                        disabled={!!busy}
                                                        onClick={() => {
                                                            setEditingName(null);
                                                            setEditingNameValue('');
                                                        }}
                                                        style={{ padding: '4px 6px' }}
                                                    >
                                                        <X size={14} />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                                                    <div style={{ flex: 1, minWidth: 0, fontSize: '0.8125rem', fontWeight: 500, wordBreak: 'break-all' }}>
                                                        {costume.name} <small>{costume.kind === 'vrm' ? '3D' : '2D'}</small>
                                                    </div>
                                                    {!isDefault && (
                                                        <>
                                                            {costume.kind === 'vrm' && (
                                                                <button
                                                                    type="button"
                                                                    className="btn btn-ghost"
                                                                    title="3D表示・表情を調整"
                                                                    aria-label={`${costume.name}の3D表示・表情を調整`}
                                                                    disabled={!!busy}
                                                                    onClick={() => setEditingVrm(costume)}
                                                                    style={{ padding: '3px 8px', flexShrink: 0 }}
                                                                >
                                                                    調整
                                                                </button>
                                                            )}
                                                            <button
                                                                type="button"
                                                                className="btn btn-ghost"
                                                                title="衣装名を変更"
                                                                aria-label={`${costume.name}の衣装名を変更`}
                                                                disabled={!!busy}
                                                                onClick={() => {
                                                                    setEditingName(costume.name);
                                                                    setEditingNameValue(costume.name);
                                                                    setError(null);
                                                                }}
                                                                style={{ padding: '3px 5px', flexShrink: 0 }}
                                                            >
                                                                <Pencil size={13} />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="btn btn-ghost"
                                                                title="削除"
                                                                aria-label={`${costume.name}を削除`}
                                                                disabled={!!busy}
                                                                onClick={() => {
                                                                    if (confirm(`「${costume.name}」を削除しますか？`)) onRemove(costume.name);
                                                                }}
                                                                style={{ padding: '3px 5px', color: 'var(--error)', flexShrink: 0 }}
                                                            >
                                                                <Trash2 size={13} />
                                                            </button>
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

            </div>
        </div>

        {addOpen && (
            <div
                className="modal-overlay"
                onPointerDown={(e) => {
                    if (e.target === e.currentTarget) closeAddModal();
                }}
            >
                <div
                    ref={addModalRef}
                    className="modal-content settings-form-modal"
                    onClick={(e) => e.stopPropagation()}
                    style={{ maxWidth: 560 }}
                    role="dialog"
                    aria-modal="true"
                    aria-label="衣装を追加"
                >
                    <div className="settings-form-modal-actions" style={{ justifyContent: 'space-between' }}>
                        <h2 style={{ margin: 0, paddingLeft: '0.25rem', fontSize: '0.9375rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Shirt size={18} /> 衣装を追加
                        </h2>
                        <button className="btn btn-ghost" onClick={closeAddModal} disabled={!!busy} title="閉じる" aria-label="閉じる">
                            <X size={20} />
                        </button>
                    </div>

                    <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div>
                            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                                <button
                                    type="button"
                                    className={addMode === 'generate' ? 'btn btn-primary' : 'btn btn-ghost'}
                                    onClick={() => {
                                        setAddMode('generate');
                                        clearUploadQueue();
                                        setVrmDraft(null);
                                    }}
                                    disabled={!!busy || !canGenerateDiffs}
                                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                >
                                    <Sparkles size={14} /> 2D生成
                                </button>
                                <button
                                    type="button"
                                    className={addMode === 'upload' ? 'btn btn-primary' : 'btn btn-ghost'}
                                    onClick={() => { setAddMode('upload'); setDraftImage(null); setDraftName(''); }}
                                    disabled={!!busy}
                                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                >
                                    <Upload size={14} /> アップロード
                                </button>
                            </div>
                            {addMode === 'generate' && (
                                <div style={{ marginBottom: 8 }}>
                                    <label style={fieldLabelStyle}>モデル名</label>
                                    <ModelSelector
                                        value={model}
                                        onChange={setModel}
                                        outputModality="image"
                                        disabled={!!busy || !canGenerateDiffs}
                                        placeholder={`例: ${defaultImageModel.model}`}
                                    />
                                </div>
                            )}
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: '0.8125rem', cursor: busy ? 'default' : 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={autoDetectName}
                                    onChange={(event) => {
                                        setAutoDetectName(event.target.checked);
                                        clearUploadQueue();
                                        setDraftImage(null);
                                        setDraftName('');
                                        setError(null);
                                    }}
                                    disabled={!!busy}
                                />
                                衣装名を自動判定
                            </label>
                            {addMode === 'generate' && selectedKind === 'openai-compatible' && (
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: '0.8125rem', cursor: busy || !model.model.trim() ? 'default' : 'pointer' }}>
                                    <input
                                        type="checkbox"
                                        checked={transparentImageSupport.marked}
                                        onChange={(event) => transparentImageSupport.setMarked(event.target.checked)}
                                        disabled={!!busy || !model.model.trim()}
                                    />
                                    このモデルは画像透過に対応しています
                                </label>
                            )}
                            {!autoDetectName && (
                                <div style={{ marginBottom: 8 }}>
                                    <label style={fieldLabelStyle}>衣装名</label>
                                    <input
                                        type="text"
                                        className="input"
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        placeholder="例: casual, school_uniform, dress"
                                        disabled={!!busy}
                                        data-modal-enter-submit={addMode === 'generate' ? 'true' : undefined}
                                    />
                                </div>
                            )}
                            {addMode === 'generate' && (
                                <>
                                    <label style={fieldLabelStyle}>元画像からどう変化させるか</label>
                                    <textarea
                                        className="input"
                                        value={newPromptDetail}
                                        onChange={(e) => setNewPromptDetail(e.target.value)}
                                        placeholder="例: 白いブラウス、紺のプリーツスカート、赤いリボン。髪型や体型は変えない"
                                        disabled={!!busy}
                                        rows={3}
                                        style={{ width: '100%', resize: 'vertical' }}
                                    />  
                                </>
                            )}
                            {addMode === 'generate' && !baseImage && (
                                <p style={hintStyle}>生成には「アバター画像」から立ち絵の登録が必要です。アップロードなら衣装差分を直接追加できます。</p>
                            )}
                            {addMode === 'upload' && uploadImage && uploadNatural && uploadCrop && (
                                <div style={{ marginTop: 8 }}>
                                    {autoDetectName && uploadFiles.length > 0 && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={uploadFiles[uploadIndex]?.name}>
                                                {uploadFiles[uploadIndex]?.name}
                                            </span>
                                            <span style={{ flexShrink: 0 }}>{uploadIndex + 1} / {uploadFiles.length}</span>
                                        </div>
                                    )}
                                    <CropArea
                                        key={uploadImage}
                                        imgRef={uploadImgRef}
                                        src={uploadImage}
                                        natural={uploadNatural}
                                        crop={uploadCrop}
                                        aspect={COSTUME_ASPECT}
                                        onChange={(next) => setUploadCrop(next)}
                                    />
                                </div>
                            )}
                            {addMode === 'generate' && draftImage && (
                                <div style={{ marginTop: 8 }}>
                                    <div style={{
                                        position: 'relative',
                                        width: '100%',
                                        maxWidth: 220,
                                        margin: '0 auto',
                                        aspectRatio: '2 / 3',
                                        background: '#000',
                                        borderRadius: 8,
                                        overflow: 'hidden',
                                        border: '1px solid var(--border-color)',
                                    }}>
                                        <StoredImage
                                            src={draftImage}
                                            alt="衣装のプレビュー"
                                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                                        />
                                        {busy === NEW_BUSY_KEY && (
                                            <div style={{
                                                position: 'absolute', inset: 0, display: 'flex',
                                                alignItems: 'center', justifyContent: 'center',
                                                background: 'rgba(0,0,0,0.5)', color: 'white',
                                            }}>
                                                <Loader2 size={20} className="animate-spin" />
                                            </div>
                                        )}
                                    </div>
                                    {autoDetectName && (
                                        <p style={{ ...hintStyle, textAlign: 'center' }}>判定結果: {draftName}</p>
                                    )}
                                </div>
                            )}
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept={autoDetectName ? 'image/*' : 'image/*,.vrm'}
                                multiple={autoDetectName}
                                onChange={handleFileUpload}
                                style={{ display: 'none' }}
                            />
                        </div>

                        {error && <p style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>{error}</p>}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                            {addMode === 'generate' ? (
                                <>
                                    {busy && busy !== UPLOAD_BUSY_KEY ? (
                                        <button className="btn btn-ghost" onClick={handleCancelBusy}>
                                            生成をキャンセル
                                        </button>
                                    ) : draftImage && (
                                        <button
                                            type="button"
                                            className="btn btn-ghost"
                                            onClick={() => { void generateDraft(); }}
                                            disabled={!!busy || !canGenerateDiffs || (!autoDetectName && !newName.trim()) || !model.model.trim() || !baseImage}
                                            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                        >
                                            <RefreshCw size={14} /> 再生成
                                        </button>
                                    )}
                                    <button
                                        className="btn btn-primary"
                                        onClick={handleAdd}
                                        disabled={!!busy || !canGenerateDiffs || (!autoDetectName && !newName.trim()) || !model.model.trim() || !baseImage}
                                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                    >
                                        {busy === NEW_BUSY_KEY && !draftImage && <Loader2 size={16} className="animate-spin" />}
                                        {busy === NEW_BUSY_KEY && !draftImage ? (autoDetectName ? '生成・判定中...' : '生成中...') : draftImage ? '追加' : '生成'}
                                    </button>
                                    {draftImage && (
                                        <button
                                            type="button"
                                            className="btn btn-primary"
                                            onClick={handleAddAndClose}
                                            disabled={!!busy || !canGenerateDiffs || (!autoDetectName && !newName.trim()) || !model.model.trim() || !baseImage}
                                        >
                                            追加して完了
                                        </button>
                                    )}
                                </>
                            ) : addMode === 'upload' && !vrmDraft ? (
                                <>
                                    {uploadImage && (
                                        <button
                                            type="button"
                                            className="btn btn-ghost"
                                            onClick={handleUploadClick}
                                            disabled={!!busy || (!autoDetectName && !newName.trim())}
                                        >
                                            選び直す
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={uploadImage ? () => { void handleConfirmUpload(); } : handleUploadClick}
                                        disabled={!!busy || (!autoDetectName && !newName.trim()) || (!!uploadImage && !uploadCrop)}
                                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                    >
                                        {busy === UPLOAD_BUSY_KEY && <Loader2 size={16} className="animate-spin" />}
                                        {busy === UPLOAD_BUSY_KEY
                                            ? autoDetectName && uploadFiles.length > 1
                                                ? `処理・判定中... (${uploadIndex + 1}/${uploadFiles.length})`
                                                : autoDetectName ? '処理・判定中...' : '処理中...'
                                            : uploadImage && autoDetectName && uploadIndex + 1 < uploadFiles.length
                                                ? `追加して次へ (${uploadIndex + 1}/${uploadFiles.length})`
                                                : uploadImage && autoDetectName && uploadFiles.length > 1
                                                    ? `追加 (${uploadIndex + 1}/${uploadFiles.length})`
                                                    : uploadImage ? '追加' : '選択'}
                                    </button>
                                    {uploadImage && (
                                        <button
                                            type="button"
                                            className="btn btn-primary"
                                            onClick={handleAddAndClose}
                                            disabled={!!busy || (!autoDetectName && !newName.trim()) || !uploadCrop}
                                        >
                                            追加して完了
                                        </button>
                                    )}
                                </>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
        )}

        {addOpen && addMode === 'upload' && vrmDraft && !editingVrm && <VrmCostumeEditor name={newName}
            initialAvatar={vrmDraft}
            existingNames={costumes.map((costume) => costume.name)} expressionNames={expressionNames}
            onSave={(costume) => { onUpsert(costume); setNewName(''); setVrmDraft(null); }}
            onCancel={() => setVrmDraft(null)} />}
        {editingVrm && <VrmCostumeEditor key={editingVrm.name} costume={editingVrm} name={editingVrm.name}
            existingNames={costumes.map((costume) => costume.name)} expressionNames={expressionNames}
            onSave={(costume) => { onUpsert(costume); setEditingVrm(null); }} onCancel={() => setEditingVrm(null)} />}
        </>
    );
}

const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    marginBottom: '0.5rem',
    color: 'var(--text-secondary)',
};

const fieldLabelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.75rem',
    fontWeight: 500,
    marginBottom: '0.375rem',
    color: 'var(--text-muted)',
};

const hintStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    marginTop: '0.375rem',
};
