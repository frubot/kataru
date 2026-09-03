import { useState, useEffect, useRef } from 'react';
import { Check, X, Loader2, Pencil, Trash2, RefreshCw, Smile, Sparkles, Upload } from 'lucide-react';
import type { Costume, Expression } from '@/lib/store';
import { useStore } from '@/lib/store';
import {
    createExpressionNameRegistry,
    reserveUniqueExpressionName,
} from '@/lib/expressionName';
import { buildBaseImageRequest } from '@/lib/imageSource';
import {
    cropRectToPng,
    loadImage,
    resizeToMaxEdge,
    resizeToMaxEdgeAsJpeg,
} from '@/lib/imageUtils';
import { CropArea, createInitialCrop, type CropBox } from './ImageCropArea';
import StoredImage from './StoredImage';
import ModelSelector from './ModelSelector';
import { useModalKeyboard } from './useModalKeyboard';

const NEUTRAL_NAME = 'neutral';
const DEFAULT_COSTUME_NAME = 'default';
const MAX_EDGE = 1536;
const EXPRESSION_ASPECT_RATIO = '2:3';
const EXPRESSION_ASPECT = 2 / 3;
const EXPRESSION_DETECTION_MAX_EDGE = 1280;
const EXPRESSION_DETECTION_JPEG_QUALITY = 0.85;
const NEW_BUSY_KEY = '__new__';
const UPLOAD_BUSY_KEY = '__upload__';

type AddMode = 'generate' | 'upload';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    expressions: Expression[];
    costumes: Costume[];
    showCostumeSettings?: boolean;
    onUpsert: (expression: Expression, costumeName?: string) => void;
    onRename: (currentName: string, nextName: string, costumeName?: string) => void;
    onRemove: (name: string, costumeName?: string) => void;
}

export default function ExpressionDiffModal({
    isOpen,
    onClose,
    expressions,
    costumes,
    showCostumeSettings = true,
    onUpsert,
    onRename,
    onRemove,
}: Props) {
    const { defaultImageModel, aiApiType, getAiApiConfig } = useStore();
    const canGenerateDiffs = aiApiType === 'openrouter';
    const [selectedCostumeName, setSelectedCostumeName] = useState(DEFAULT_COSTUME_NAME);
    const [newName, setNewName] = useState('');
    const [newPromptDetail, setNewPromptDetail] = useState('');
    const [autoDetectName, setAutoDetectName] = useState(false);
    const [addMode, setAddMode] = useState<AddMode>('generate');
    const [model, setModel] = useState(defaultImageModel);
    const [busy, setBusy] = useState<string | null>(null); // expression name being generated, or internal busy key
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadImgRef = useRef<HTMLImageElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const reservedDetectedNamesRef = useRef<Set<string>>(new Set());
    const [uploadImage, setUploadImage] = useState<string | null>(null);
    const [uploadNatural, setUploadNatural] = useState<{ w: number; h: number } | null>(null);
    const [uploadCrop, setUploadCrop] = useState<CropBox | null>(null);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);
    const [uploadIndex, setUploadIndex] = useState(0);
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editingNameValue, setEditingNameValue] = useState('');

    useEffect(() => {
        if (!isOpen) {
            setSelectedCostumeName(DEFAULT_COSTUME_NAME);
            setNewName('');
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

    useEffect(() => {
        if (!showCostumeSettings) {
            setSelectedCostumeName(DEFAULT_COSTUME_NAME);
            return;
        }
        if (selectedCostumeName === DEFAULT_COSTUME_NAME) return;
        if (!costumes.some((costume) => costume.name === selectedCostumeName)) {
            setSelectedCostumeName(DEFAULT_COSTUME_NAME);
        }
    }, [costumes, selectedCostumeName, showCostumeSettings]);

    const additionalCostumes = costumes.filter((costume) => costume.name.toLowerCase() !== DEFAULT_COSTUME_NAME);
    const selectedCostume = selectedCostumeName === DEFAULT_COSTUME_NAME
        ? null
        : additionalCostumes.find((costume) => costume.name === selectedCostumeName) ?? null;
    const selectedCostumeExpressions = selectedCostume
        ? (selectedCostume.expressions ?? []).filter((e) => e.name !== NEUTRAL_NAME)
        : [];
    const defaultNeutral = expressions.find((e) => e.name === NEUTRAL_NAME);
    const selectedCostumeNeutral: Expression | null = selectedCostume
        ? { name: NEUTRAL_NAME, image: selectedCostume.image }
        : null;
    const neutral = selectedCostumeNeutral ?? defaultNeutral;
    const displayExpressions: Expression[] = selectedCostumeNeutral
        ? [selectedCostumeNeutral, ...selectedCostumeExpressions]
        : expressions;

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
        setUploadCrop(createInitialCrop(img.width, img.height, EXPRESSION_ASPECT));
    };

    const nameExists = (name: string, currentName?: string) => displayExpressions.some((expression) => (
        expression.name !== currentName
        && expression.name.toLowerCase() === name.toLowerCase()
    ));

    const validateManualName = () => {
        const name = newName.trim();
        if (!name || busy) return null;
        if (selectedCostume && name.toLowerCase() === NEUTRAL_NAME) {
            setError('衣装選択中の neutral は衣装画像そのものです。別の表情名を使ってください。');
            return null;
        }
        if (nameExists(name)) {
            setError(`「${name}」は既に存在します。`);
            return null;
        }
        setError(null);
        return name;
    };

    const detectExpressionName = async (
        image: string,
        signal?: AbortSignal,
        reservedNames = createExpressionNameRegistry(displayExpressions.map((expression) => expression.name)),
    ) => {
        const analysisImage = await resizeToMaxEdgeAsJpeg(
            image,
            EXPRESSION_DETECTION_MAX_EDGE,
            EXPRESSION_DETECTION_JPEG_QUALITY,
        );
        const response = await fetch('/api/detect-expression-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image: analysisImage,
                aiApiConfig: getAiApiConfig(),
            }),
            signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data?.error || `表情名の自動判定に失敗しました (${response.status})`);
        }
        if (typeof data?.name !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(data.name)) {
            throw new Error('表情名の自動判定結果が不正です。');
        }
        return reserveUniqueExpressionName(data.name, reservedNames);
    };

    const buildPrompt = (name: string, promptDetail?: string) => {
        const detail = promptDetail?.trim();
        return [
            name
                ? `Change the facial expression to ${name}.`
                : detail
                    ? 'Change the facial expression according to the character-specific guidance below.'
                    : 'Change the facial expression to a distinct, clearly readable expression.',
            detail ? `Character-specific expression guidance: ${detail}` : null,
            'Keep everything else (character, outfit, background, art style) identical.',
        ].filter(Boolean).join('\n');
    };

    const generate = async (
        name: string,
        busyKey: string,
        promptDetail?: string,
        shouldDetectName = false,
    ) => {
        if (!canGenerateDiffs) {
            setError('選択中のAPIでは元画像を使う表情差分生成に対応していません。アップロードを使ってください。');
            return;
        }
        if (!neutral) {
            setError('生成には「アバター画像」から立ち絵の登録が必要です。');
            return;
        }
        setError(null);
        setBusy(busyKey);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const normalizedPromptDetail = promptDetail?.trim() || undefined;
            const prompt = buildPrompt(name, normalizedPromptDetail);
            const res = await fetch('/api/generate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt,
                    model: model.trim(),
                    ...buildBaseImageRequest(neutral.image),
                    aspectRatio: EXPRESSION_ASPECT_RATIO,
                    aiApiConfig: getAiApiConfig(),
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || `生成に失敗しました (${res.status})`);
            }
            const data = await res.json();
            const resized = await resizeToMaxEdge(data.image, MAX_EDGE);
            const resolvedName = shouldDetectName
                ? await detectExpressionName(resized, controller.signal)
                : name;
            onUpsert({ name: resolvedName, promptDetail: normalizedPromptDetail, image: resized }, selectedCostume?.name);
            if (busyKey === NEW_BUSY_KEY) {
                setNewName('');
                setNewPromptDetail('');
            }
        } catch (e) {
            if (e instanceof Error && e.name !== 'AbortError') {
                setError(e.message);
            }
        } finally {
            setBusy(null);
            abortRef.current = null;
        }
    };

    const handleAdd = () => {
        if (busy || !model.trim() || !canGenerateDiffs) return;
        const name = autoDetectName ? '' : validateManualName();
        if (!autoDetectName && !name) return;
        void generate(name ?? '', NEW_BUSY_KEY, newPromptDetail, autoDetectName);
    };

    const handleUploadClick = () => {
        if (!autoDetectName && !validateManualName()) return;
        fileInputRef.current?.click();
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = Array.from(e.target.files ?? []);
        e.target.value = '';
        const files = autoDetectName ? selectedFiles : selectedFiles.slice(0, 1);
        if (files.length === 0) return;

        if (!autoDetectName && !validateManualName()) return;
        const invalidFile = files.find((file) => !file.type.startsWith('image/'));
        if (invalidFile) {
            setError(`${invalidFile.name} は画像ファイルではありません。`);
            return;
        }

        setBusy(UPLOAD_BUSY_KEY);
        setError(null);
        clearUploadDraft();
        try {
            setUploadFiles(files);
            setUploadIndex(0);
            reservedDetectedNamesRef.current = createExpressionNameRegistry(
                displayExpressions.map((expression) => expression.name),
            );
            await prepareUpload(files[0]);
        } catch (e) {
            clearUploadQueue();
            setError(e instanceof Error ? e.message : '画像の読み込みに失敗しました');
        } finally {
            setBusy(null);
        }
    };

    const handleConfirmUpload = async () => {
        const manualName = autoDetectName ? null : validateManualName();
        if ((!autoDetectName && !manualName) || !uploadImage || !uploadCrop) return;

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
                ? await detectExpressionName(
                    cropped,
                    controller.signal,
                    reservedDetectedNamesRef.current,
                )
                : manualName!;
            onUpsert({ name, image: cropped }, selectedCostume?.name);
            setNewName('');
            setNewPromptDetail('');
            const nextIndex = uploadIndex + 1;
            if (autoDetectName && nextIndex < uploadFiles.length) {
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
        } catch (e) {
            setError(e instanceof Error ? e.message : '画像の切り取りに失敗しました');
        } finally {
            setBusy(null);
            abortRef.current = null;
        }
    };

    const saveExpressionName = (currentName: string) => {
        const nextName = editingNameValue.trim();
        if (!nextName) {
            setError('表情名を入力してください。');
            return;
        }
        if (nameExists(nextName, currentName)) {
            setError(`「${nextName}」は既に存在します。`);
            return;
        }
        if (nextName !== currentName) {
            onRename(currentName, nextName, selectedCostume?.name);
        }
        setEditingName(null);
        setEditingNameValue('');
        setError(null);
    };

    const handleCancelBusy = () => {
        abortRef.current?.abort();
        setBusy(null);
    };

    useModalKeyboard({
        isOpen,
        containerRef: modalRef,
        onClose,
        canClose: !busy,
        onEnter: addMode === 'generate' ? handleAdd : undefined,
    });

    if (!isOpen) return null;

    return (
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
                aria-label="表情差分"
            >
                <div className="settings-form-modal-actions" style={{ justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0, paddingLeft: '0.25rem', fontSize: '0.9375rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Smile size={18} /> 表情差分
                    </h2>
                    <button className="btn btn-ghost" onClick={() => !busy && onClose()} disabled={!!busy} title="閉じる" aria-label="閉じる">
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {showCostumeSettings && (
                        <div>
                            <label style={labelStyle}>コスチューム</label>
                            <select
                                className="input"
                                value={selectedCostumeName}
                                onChange={(e) => {
                                    setSelectedCostumeName(e.target.value);
                                    clearUploadQueue();
                                    setEditingName(null);
                                    setEditingNameValue('');
                                    setError(null);
                                }}
                                disabled={!!busy}
                            >
                                <option value={DEFAULT_COSTUME_NAME}>default</option>
                                {additionalCostumes.map((costume) => (
                                    <option key={costume.name} value={costume.name}>
                                        {costume.name}
                                    </option>
                                ))}
                            </select>
                            <p style={hintStyle}>
                                {selectedCostume
                                    ? `「${selectedCostume.name}」の衣装画像をベースに、この衣装専用の表情差分を作成します`
                                    : 'デフォルトの立ち絵をベースに、従来の表情差分を作成します'}
                            </p>
                        </div>
                    )}

                    <div>
                        <label style={labelStyle}>新しい表情を追加</label>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                            <button
                                type="button"
                                className={addMode === 'generate' ? 'btn btn-primary' : 'btn btn-ghost'}
                                onClick={() => {
                                    setAddMode('generate');
                                    clearUploadQueue();
                                }}
                                disabled={!!busy || !canGenerateDiffs}
                                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                            >
                                <Sparkles size={14} /> 生成
                            </button>
                            <button
                                type="button"
                                className={addMode === 'upload' ? 'btn btn-primary' : 'btn btn-ghost'}
                                onClick={() => setAddMode('upload')}
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
                                    placeholder={`例: ${defaultImageModel}`}
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
                                    setError(null);
                                }}
                                disabled={!!busy}
                            />
                            表情名を自動判定
                        </label>
                        {autoDetectName ? (
                            <p style={{ ...hintStyle, marginTop: 0, marginBottom: 8 }}>
                                注意: 画像はAPIへ送信されます。機密情報が入った画像を選択しないでください
                            </p>
                        ) : (
                            <div style={{ marginBottom: 8 }}>
                                <label style={fieldLabelStyle}>表情</label>
                                <input
                                    type="text"
                                    className="input"
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                    placeholder="例: smile, sad, angry"
                                    disabled={!!busy}
                                    data-modal-enter-submit={addMode === 'generate' ? 'true' : undefined}
                                />
                            </div>
                        )}
                        {addMode === 'generate' && (
                            <>
                                <label style={fieldLabelStyle}>画像の説明</label>
                                <textarea
                                    className="input"
                                    value={newPromptDetail}
                                    onChange={(e) => setNewPromptDetail(e.target.value)}
                                    placeholder="例: このキャラクターは嬉しい時、大きく笑うより目元がやわらかくなり、口角だけ少し上がる"
                                    disabled={!!busy}
                                    rows={3}
                                    style={{ width: '100%', resize: 'vertical' }}
                                />
                            </>
                        )}
                        {addMode === 'generate' ? (
                            <p style={hintStyle}>
                                {!canGenerateDiffs
                                    ? '選択中のAPIでは元画像を使う差分生成に対応していません。アップロードで追加してください。'
                                    : neutral
                                    ? autoDetectName
                                        && '説明が空の場合は異なる表情をおまかせで生成します'
                                    : '生成には「アバター画像」から立ち絵の登録が必要です。アップロードなら neutral(デフォルトの表情) や表情差分を直接追加できます。'}
                            </p>
                        ) : (
                            <p style={hintStyle}>
                                {uploadImage
                                    && uploadFiles.length > 1
                                        ? '切り取り範囲を調整して追加すると、次の画像に進みます'
                                        : '切り取り範囲を調整してください'
                                    }
                            </p>
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
                                    aspect={EXPRESSION_ASPECT}
                                    hint="この範囲を 2:3 の表情差分として保存します"
                                    onChange={(next) => setUploadCrop(next)}
                                />
                            </div>
                        )}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            multiple={autoDetectName}
                            onChange={handleFileUpload}
                            style={{ display: 'none' }}
                        />
                    </div>

                    {error && <p style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>{error}</p>}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                        {busy && busy !== UPLOAD_BUSY_KEY && (
                            <button className="btn btn-ghost" onClick={handleCancelBusy}>
                                生成をキャンセル
                            </button>
                        )}
                        {addMode === 'generate' ? (
                            <button
                                className="btn btn-primary"
                                onClick={handleAdd}
                                disabled={!!busy || !canGenerateDiffs || (!autoDetectName && !newName.trim()) || !model.trim() || !neutral}
                                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                            >
                                {busy === NEW_BUSY_KEY && <Loader2 size={16} className="animate-spin" />}
                                {busy === NEW_BUSY_KEY ? (autoDetectName ? '生成・判定中...' : '生成中...') : '生成'}
                            </button>
                        ) : (
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
                            </>
                        )}
                    </div>

                    <div>
                        <label style={labelStyle}>登録済み（{displayExpressions.length}件）</label>
                        {displayExpressions.length === 0 && (
                            <p style={hintStyle}>まだ登録されていません。画像生成またはアップロードでデフォルトの立ち絵を追加できます。</p>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                            {displayExpressions.map((exp) => (
                                <div
                                    key={selectedCostume ? `${selectedCostume.name}:${exp.name}` : exp.name}
                                    style={{
                                        border: '1px solid var(--border-color)',
                                        borderRadius: 8,
                                        overflow: 'hidden',
                                        background: 'var(--bg-tertiary)',
                                    }}
                                >
                                    <div style={{ aspectRatio: '2 / 3', background: '#000', position: 'relative' }}>
                                        <StoredImage
                                            src={exp.image}
                                            alt={exp.name}
                                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                                        />
                                        {busy === exp.name && (
                                            <div style={{
                                                position: 'absolute', inset: 0, display: 'flex',
                                                alignItems: 'center', justifyContent: 'center',
                                                background: 'rgba(0,0,0,0.5)', color: 'white',
                                            }}>
                                                <Loader2 size={20} className="animate-spin" />
                                            </div>
                                        )}
                                    </div>
                                    <div style={{ padding: '8px 10px' }}>
                                        {editingName === exp.name ? (
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                                                <input
                                                    type="text"
                                                    className="input"
                                                    value={editingNameValue}
                                                    onChange={(event) => setEditingNameValue(event.target.value)}
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter') {
                                                            event.preventDefault();
                                                            saveExpressionName(exp.name);
                                                        } else if (event.key === 'Escape') {
                                                            event.preventDefault();
                                                            setEditingName(null);
                                                            setEditingNameValue('');
                                                        }
                                                    }}
                                                    disabled={!!busy}
                                                    autoFocus
                                                    aria-label={`${exp.name}の表情名`}
                                                    style={{ minWidth: 0, fontSize: '0.75rem' }}
                                                />
                                                <button
                                                    type="button"
                                                    className="btn btn-ghost"
                                                    title="変更を保存"
                                                    aria-label="変更を保存"
                                                    disabled={!!busy || !editingNameValue.trim()}
                                                    onClick={() => saveExpressionName(exp.name)}
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
                                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, marginBottom: 6 }}>
                                                <div style={{ flex: 1, minWidth: 0, fontSize: '0.8125rem', fontWeight: 500, wordBreak: 'break-all' }}>
                                                    {exp.name}
                                                </div>
                                                {!(selectedCostume && exp.name === NEUTRAL_NAME) && (
                                                    <button
                                                        type="button"
                                                        className="btn btn-ghost"
                                                        title="表情名を変更"
                                                        aria-label={`${exp.name}の表情名を変更`}
                                                        disabled={!!busy}
                                                        onClick={() => {
                                                            setEditingName(exp.name);
                                                            setEditingNameValue(exp.name);
                                                            setError(null);
                                                        }}
                                                        style={{ padding: '3px 5px', flexShrink: 0 }}
                                                    >
                                                        <Pencil size={13} />
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                        {exp.name !== NEUTRAL_NAME && (
                                            <textarea
                                                className="input"
                                                value={exp.promptDetail ?? ''}
                                                onChange={(e) => {
                                                    const promptDetail = e.target.value || undefined;
                                                    onUpsert({ ...exp, promptDetail }, selectedCostume?.name);
                                                }}
                                                placeholder="この表情でのキャラクターらしさ"
                                                disabled={!!busy}
                                                rows={3}
                                                style={{
                                                    width: '100%',
                                                    resize: 'vertical',
                                                    fontSize: '0.75rem',
                                                    marginBottom: 6,
                                                }}
                                            />
                                        )}
                                        <div style={{ display: 'flex', gap: 4 }}>
                                            {exp.name !== NEUTRAL_NAME && (
                                                <button
                                                    className="btn btn-ghost"
                                                    title="再生成"
                                                    disabled={!!busy || !canGenerateDiffs || !neutral}
                                                    onClick={() => generate(exp.name, exp.name, exp.promptDetail)}
                                                    style={{ padding: '4px 8px' }}
                                                >
                                                    <RefreshCw size={14} />
                                                </button>
                                            )}
                                            {!(selectedCostume && exp.name === NEUTRAL_NAME) && (
                                                <button
                                                    className="btn btn-ghost"
                                                    title="削除"
                                                    disabled={!!busy}
                                                    onClick={() => {
                                                        if (confirm(`「${exp.name}」を削除しますか？`)) onRemove(exp.name, selectedCostume?.name);
                                                    }}
                                                    style={{ padding: '4px 8px', color: 'var(--error)' }}
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
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
