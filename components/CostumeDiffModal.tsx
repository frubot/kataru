import { useState, useEffect, useRef } from 'react';
import { Check, ImagePlus, X, Loader2, Pencil, Plus, Trash2, RefreshCw, Shirt, Smile, Sparkles, Star, Upload, Wand2 } from 'lucide-react';
import type { Costume } from '@/lib/store';
import type { VrmAvatar } from '@/lib/store/types';
import { useStore } from '@/lib/store';
import { isAiConnectionKind } from '@/lib/aiApi';
import { useAiConnections } from '@/lib/aiConnections';
import {
    collectCostumeExpressionNames,
    createCostumeId,
    isCostumeNameTaken,
    resolveDefaultCostume,
} from '@/lib/costumes';
import { serializeModelRef, type ModelRef } from '@/lib/modelDefaults';
import { readVrmFile } from '@/lib/vrm';
import { createNameRegistry, nameFromFileName, reserveUniqueName } from '@/lib/nameRegistry';
import { buildBaseImageRequest, resolveStoredImageUrl } from '@/lib/imageSource';
import { cropRectToPng, loadImage, resizeToMaxEdge, resizeToMaxEdgeAsJpeg } from '@/lib/imageUtils';
import { CropArea, createInitialCrop, type CropBox } from './ImageCropArea';
import ImageGenerationModal, { type ImageGenerationResult } from './ImageGenerationModal';
import StoredImage from './StoredImage';
import ModelSelector from './ModelSelector';
import OptionSelector from './OptionSelector';
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
/** 最初の衣装の名前の初期値。予約名ではなく、自由に変更できる。 */
const INITIAL_COSTUME_NAME = 'default';

/** 衣装の追加方法。scratch はゼロから生成、generate は既存衣装からの差分生成。 */
type AddMode = 'scratch' | 'generate' | 'upload';

const IMAGE_GENERATION_DISABLED_TITLE = '画像生成モデルの接続先で画像生成が無効です';

const isVrmFile = (file: File) => file.name.toLowerCase().endsWith('.vrm');
type NameSource = 'manual' | 'filename' | 'ai';

/** ImageGenerationModal で作成中の対象。新しい衣装の作成か、既存衣装の画像の差し替え。 */
type GenerationTarget =
    | { kind: 'new'; name: string }
    | { kind: 'replace'; costume: Costume };

interface Props {
    isOpen: boolean;
    onClose: () => void;
    costumes: Costume[];
    defaultCostumeId?: string;
    /** 3Dプレビューに表示する名前。 */
    ownerName?: string;
    /** アイコンが設定済みか。未設定なら「アイコンも更新」を既定でオンにする。 */
    hasIcon: boolean;
    onUpsert: (costume: Costume) => void;
    onRemove: (costumeId: string) => void;
    onSetDefault: (costumeId: string) => void;
    onIconChange: (icon: string) => void;
    /** Moves to the expression diffs of the given costume; the button is hidden when omitted. */
    onOpenExpressions?: (costumeId: string) => void;
}

/** 画像の差し替え結果を衣装へ反映する。2D画像なら3Dの設定を外す。 */
function applyGeneratedImage(costume: Costume, result: ImageGenerationResult): Costume {
    if (result.vrm) return { ...costume, kind: 'vrm', vrm: result.vrm, image: result.image ?? costume.image };
    const next: Costume = { ...costume, image: result.image ?? costume.image };
    delete next.kind;
    delete next.vrm;
    return next;
}

export default function CostumeDiffModal({
    isOpen,
    onClose,
    costumes,
    defaultCostumeId,
    ownerName,
    hasIcon,
    onUpsert,
    onRemove,
    onSetDefault,
    onIconChange,
    onOpenExpressions,
}: Props) {
    const { defaultImageModel, getAiApiConfig } = useStore();
    const { connections } = useAiConnections();
    const [newName, setNewName] = useState('');
    const [newPromptDetail, setNewPromptDetail] = useState('');
    const [nameSource, setNameSource] = useState<NameSource>('manual');
    const [addMode, setAddMode] = useState<AddMode>('scratch');
    const autoDetectName = addMode !== 'scratch' && nameSource === 'ai';
    const nameFromFile = addMode === 'upload' && nameSource === 'filename';
    // True when names are assigned per uploaded file, which enables multi-file uploads.
    const autoName = autoDetectName || nameFromFile;
    const [editingVrm, setEditingVrm] = useState<Costume | null>(null);
    const [vrmDraft, setVrmDraft] = useState<VrmAvatar | null>(null);
    const [generationTarget, setGenerationTarget] = useState<GenerationTarget | null>(null);
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
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingNameValue, setEditingNameValue] = useState('');
    const [editingDescriptionValue, setEditingDescriptionValue] = useState('');
    const [draftImage, setDraftImage] = useState<string | null>(null);
    const [draftName, setDraftName] = useState('');
    const [baseCostumeId, setBaseCostumeId] = useState<string | null>(null);

    const defaultCostume = resolveDefaultCostume({ costumes, defaultCostumeId });
    const baseCostume = costumes.find((costume) => costume.id === baseCostumeId) ?? defaultCostume;
    const baseImage = baseCostume?.image || undefined;
    const vrmExpressionNames = collectCostumeExpressionNames(costumes);

    const selectedConnection = connections.find((connection) => connection.id === model.connectionId) ?? null;
    const selectedKind = selectedConnection?.kind
        ?? (isAiConnectionKind(model.connectionId) ? model.connectionId : null);
    const canGenerateImages = selectedKind === 'openrouter'
        || (selectedKind === 'openai-compatible' && selectedConnection?.imageGenerationEnabled === true);
    const transparentImageSupport = useTransparentImageBackground(model);

    const initialAddMode = (): AddMode => (
        !canGenerateImages ? 'upload' : costumes.length === 0 ? 'scratch' : 'generate'
    );

    const openAddModal = () => {
        setError(null);
        const mode = initialAddMode();
        setAddMode(mode);
        setNewName(costumes.length === 0 ? INITIAL_COSTUME_NAME : '');
        setBaseCostumeId(defaultCostume?.id ?? null);
        setAddOpen(true);
    };

    useEffect(() => {
        if (isOpen && costumes.length === 0) openAddModal();
        if (!isOpen) {
            setAddOpen(false);
            setNewName('');
            setEditingVrm(null);
            setVrmDraft(null);
            setGenerationTarget(null);
            setNewPromptDetail('');
            setNameSource('manual');
            setModel(defaultImageModel);
            setBusy(null);
            setError(null);
            setUploadImage(null);
            setUploadNatural(null);
            setUploadCrop(null);
            setUploadFiles([]);
            setUploadIndex(0);
            reservedDetectedNamesRef.current.clear();
            setEditingId(null);
            setEditingNameValue('');
            setEditingDescriptionValue('');
            setDraftImage(null);
            setDraftName('');
            setBaseCostumeId(null);
            abortRef.current?.abort();
            abortRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    useEffect(() => {
        // Both generation modes need image generation; fall back to uploads.
        if (!canGenerateImages && (addMode === 'generate' || addMode === 'scratch')) {
            setAddMode('upload');
        }
    }, [addMode, canGenerateImages]);

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

    const switchAddMode = (mode: AddMode) => {
        setAddMode(mode);
        if (mode === 'scratch') {
            if (nameSource === 'ai') setNameSource('manual');
        }
        if (mode === 'scratch' || mode === 'generate') {
            if (nameSource === 'filename') setNameSource('manual');
        }
        clearUploadQueue();
        setVrmDraft(null);
        setDraftImage(null);
        setDraftName('');
        setError(null);
    };

    const loadUploadSource = async (file: File) => {
        const dataUrl: string = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error(`${file.name} の読み込みに失敗しました。`));
            reader.readAsDataURL(file);
        });
        const image = await resizeToMaxEdge(dataUrl, MAX_EDGE);
        const img = await loadImage(image);
        return {
            image,
            natural: { w: img.width, h: img.height },
            crop: createInitialCrop(img.width, img.height, COSTUME_ASPECT, true),
        };
    };

    const prepareUpload = async (file: File) => {
        const source = await loadUploadSource(file);
        setUploadImage(source.image);
        setUploadNatural(source.natural);
        setUploadCrop(source.crop);
    };

    const detectedNameRegistry = () => createNameRegistry(costumes.map((costume) => costume.name));

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

    const reserveFileName = (file: File | undefined, reservedNames = reservedDetectedNamesRef.current) => {
        const candidate = file ? nameFromFileName(file.name) : '';
        if (!candidate) {
            throw new Error(`${file?.name ?? 'ファイル'} から衣装名を作成できませんでした。`);
        }
        // Existing costume names are reserved, so duplicates get a numeric suffix.
        return reserveUniqueName(candidate, reservedNames, '衣装名');
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

    const validateName = () => {
        const name = newName.trim();
        if (!name || busy) return null;
        if (isCostumeNameTaken(costumes, name)) {
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
        if (busy || !model.model.trim() || !canGenerateImages) return;
        const name = autoDetectName ? '' : validateName();
        if (!autoDetectName && !name) return;
        if (!baseImage) {
            setError('差分生成にはベースにする衣装が必要です。');
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
        if (isCostumeNameTaken(costumes, name)) {
            setError(`「${name}」は既に存在します。`);
            return false;
        }
        onUpsert({
            id: createCostumeId(),
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

    const openScratchGeneration = () => {
        const name = validateName();
        if (!name) return;
        setGenerationTarget({ kind: 'new', name });
    };

    const handleGenerationComplete = (result: ImageGenerationResult) => {
        const target = generationTarget;
        if (!target) return;
        if (result.icon) onIconChange(result.icon);
        if (target.kind === 'replace') {
            onUpsert(applyGeneratedImage(target.costume, result));
        } else if (result.image) {
            onUpsert({
                id: createCostumeId(),
                name: target.name,
                image: result.image,
                ...(result.vrm ? { kind: 'vrm' as const, vrm: result.vrm } : {}),
            });
            setAddOpen(false);
            setNewName('');
            setError(null);
        }
        setGenerationTarget(null);
    };

    const handleUploadClick = () => {
        if (!autoName && !validateName()) return;
        fileInputRef.current?.click();
    };

    /** Opens the VRM editor for one .vrm file. AI naming cannot read a 3D
     *  model, so any automatic naming mode falls back to the file name. */
    const prepareVrmUpload = async (file: File) => {
        setBusy(UPLOAD_BUSY_KEY);
        setError(null);
        clearUploadQueue();
        try {
            if (autoName) {
                setNewName(reserveFileName(file, detectedNameRegistry()));
            }
            setVrmDraft(await readVrmFile(file));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'VRMの読み込みに失敗しました');
        } finally {
            setBusy(null);
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = Array.from(e.target.files ?? []);
        e.target.value = '';
        const files = autoName ? selectedFiles : selectedFiles.slice(0, 1);
        if (files.length === 0) return;

        if (!autoName && !validateName()) return;

        // The file extension decides between the 2D image and 3D (VRM) flows.
        const vrmFiles = files.filter(isVrmFile);
        if (vrmFiles.length > 0) {
            if (files.length > 1) {
                setError('.vrm ファイルは1つずつ選択してください。画像と同時には選択できません。');
                return;
            }
            await prepareVrmUpload(vrmFiles[0]);
            return;
        }
        const invalidFile = files.find((file) => !file.type.startsWith('image/'));
        if (invalidFile) {
            setError(`${invalidFile.name} は画像ファイルでも .vrm ファイルでもありません。`);
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

    const resolveUploadName = (image: string, file: File | undefined, manualName: string | null, signal: AbortSignal) => {
        if (autoDetectName) return detectCostumeName(image, signal, reservedDetectedNamesRef.current);
        if (nameFromFile) return Promise.resolve(reserveFileName(file));
        return Promise.resolve(manualName!);
    };

    const cropUpload = (image: string, crop: CropBox) => cropRectToPng(image, crop.x, crop.y, crop.width, crop.height);

    /** Adds the remaining queued files with their initial crop. On failure the failing file stays open for manual retry. */
    const addRemainingUploads = async (startIndex: number, signal: AbortSignal): Promise<boolean> => {
        clearUploadDraft();
        for (let index = startIndex; index < uploadFiles.length; index += 1) {
            const file = uploadFiles[index];
            setUploadIndex(index);
            try {
                const source = await loadUploadSource(file);
                const image = await cropUpload(source.image, source.crop);
                const name = await resolveUploadName(image, file, null, signal);
                onUpsert({ id: createCostumeId(), name, image });
            } catch (e) {
                const message = e instanceof Error ? e.message : '画像の処理に失敗しました';
                setError(`${file.name}: ${message}（ここまでの画像は追加済みです）`);
                try {
                    await prepareUpload(file);
                } catch {
                    clearUploadQueue();
                }
                return false;
            }
        }
        clearUploadQueue();
        return true;
    };

    const handleConfirmUpload = async (finishAfter = false): Promise<boolean> => {
        const manualName = autoName ? null : validateName();
        if ((!autoName && !manualName) || !uploadImage || !uploadCrop) return false;

        setBusy(UPLOAD_BUSY_KEY);
        setError(null);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const image = await cropUpload(uploadImage, uploadCrop);
            const name = await resolveUploadName(image, uploadFiles[uploadIndex], manualName, controller.signal);
            onUpsert({ id: createCostumeId(), name, image });
            setNewName('');
            setNewPromptDetail('');
            const nextIndex = uploadIndex + 1;
            if (!autoName || nextIndex >= uploadFiles.length) {
                clearUploadQueue();
                return true;
            }
            if (finishAfter) {
                return await addRemainingUploads(nextIndex, controller.signal);
            }
            setUploadIndex(nextIndex);
            clearUploadDraft();
            try {
                await prepareUpload(uploadFiles[nextIndex]);
            } catch (nextError) {
                clearUploadQueue();
                throw nextError;
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

    const cancelCostumeEdit = () => {
        setEditingId(null);
        setEditingNameValue('');
        setEditingDescriptionValue('');
    };

    const saveCostumeEdit = (costume: Costume) => {
        const nextName = editingNameValue.trim();
        if (!nextName) {
            setError('衣装名を入力してください。');
            return;
        }
        if (isCostumeNameTaken(costumes, nextName, costume.id)) {
            setError(`「${nextName}」は既に存在します。`);
            return;
        }
        const nextDescription = editingDescriptionValue.trim();
        const nameChanged = nextName !== costume.name;
        const descriptionChanged = nextDescription !== (costume.description?.trim() ?? '');
        if (nameChanged || descriptionChanged) {
            onUpsert({
                ...costume,
                name: nextName,
                description: nextDescription || undefined,
            });
        }
        cancelCostumeEdit();
        setError(null);
    };

    const removeCostume = (costume: Costume) => {
        if (costumes.length <= 1) return;
        const isDefault = costume.id === defaultCostume?.id;
        const nextDefault = isDefault ? costumes.find((entry) => entry.id !== costume.id) : null;
        const message = nextDefault
            ? `「${costume.name}」を削除しますか？デフォルトの衣装は「${nextDefault.name}」に変わります。`
            : `「${costume.name}」を削除しますか？`;
        if (!confirm(message)) return;
        if (editingId === costume.id) cancelCostumeEdit();
        onRemove(costume.id);
    };

    const cardEditDirty = () => {
        const costume = costumes.find((entry) => entry.id === editingId);
        if (!costume) return false;
        const nameChanged = editingNameValue.trim() !== costume.name;
        const descriptionChanged = editingDescriptionValue.trim() !== (costume.description?.trim() ?? '');
        return nameChanged || descriptionChanged;
    };

    const requestClose = () => {
        if (busy) return;
        if (cardEditDirty()
            && !window.confirm('編集内容はまだ保存されていません。保存せずに閉じますか？')) {
            return;
        }
        onClose();
    };

    /** Leaves this modal for the costume's expression diffs, after the same unsaved-edit check as closing. */
    const openExpressions = (costume: Costume) => {
        if (busy || !onOpenExpressions) return;
        if (cardEditDirty()
            && !window.confirm('編集内容はまだ保存されていません。保存せずに表情差分を開きますか？')) {
            return;
        }
        onOpenExpressions(costume.id);
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
        onClose: requestClose,
        canClose: !busy,
    });

    useModalKeyboard({
        isOpen: isOpen && addOpen,
        containerRef: addModalRef,
        onClose: closeAddModal,
        canClose: !busy,
        onEnter: addMode === 'generate' ? handleAdd : addMode === 'scratch' ? openScratchGeneration : undefined,
    });

    if (!isOpen) return null;

    const generateDisabled = !!busy || !canGenerateImages || (!autoDetectName && !newName.trim()) || !model.model.trim() || !baseImage;
    const addModeOptions: { mode: AddMode; label: string; icon: React.ReactNode; disabled?: boolean; title?: string }[] = [
        {
            mode: 'scratch',
            label: 'ゼロから生成',
            icon: <Sparkles size={14} />,
            disabled: !canGenerateImages,
            title: !canGenerateImages ? IMAGE_GENERATION_DISABLED_TITLE : undefined,
        },
        {
            mode: 'generate',
            label: '差分生成',
            icon: <Wand2 size={14} />,
            disabled: !canGenerateImages || costumes.length === 0,
            title: !canGenerateImages
                ? IMAGE_GENERATION_DISABLED_TITLE
                : costumes.length === 0 ? '差分生成には元にする衣装が必要です' : undefined,
        },
        { mode: 'upload', label: 'アップロード', icon: <Upload size={14} /> },
    ];

    return (
        <>
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) requestClose();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content settings-form-modal"
                onClick={(e) => e.stopPropagation()}
                style={{ maxWidth: 640 }}
                role="dialog"
                aria-modal="true"
                aria-label="衣装"
            >
                <div className="settings-form-modal-actions" style={{ justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0, paddingLeft: '0.25rem', fontSize: '0.9375rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Shirt size={18} /> 衣装
                    </h2>
                    <button className="btn btn-ghost" onClick={requestClose} disabled={!!busy} title="閉じる" aria-label="閉じる">
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {error && !addOpen && <p style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>{error}</p>}

                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
                            <label style={{ ...labelStyle, marginBottom: 0 }}>登録済み（{costumes.length}件）</label>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={openAddModal}
                                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: '0.75rem' }}
                            >
                                <Plus size={14} /> 追加
                            </button>
                        </div>
                        {costumes.length === 0 && (
                            <p style={hintStyle}>まだ登録されていません。衣装を追加すると、立ち絵として表示され、表情差分も登録できるようになります。</p>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                            {costumes.map((costume) => {
                                const isDefault = costume.id === defaultCostume?.id;
                                return (
                                    <div
                                        key={costume.id}
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
                                            {isDefault && (
                                                <span style={{
                                                    position: 'absolute',
                                                    top: 6,
                                                    left: 6,
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 4,
                                                    padding: '2px 8px',
                                                    borderRadius: 999,
                                                    background: 'var(--accent-primary)',
                                                    color: '#fff',
                                                    fontSize: '0.6875rem',
                                                    fontWeight: 600,
                                                }}>
                                                    <Star size={11} fill="currentColor" /> デフォルト
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ padding: '8px 10px' }}>
                                            {editingId === costume.id ? (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                                        <input
                                                            type="text"
                                                            className="input"
                                                            value={editingNameValue}
                                                            onChange={(event) => setEditingNameValue(event.target.value)}
                                                            onKeyDown={(event) => {
                                                                if (event.key === 'Enter') {
                                                                    event.preventDefault();
                                                                    saveCostumeEdit(costume);
                                                                } else if (event.key === 'Escape') {
                                                                    event.preventDefault();
                                                                    cancelCostumeEdit();
                                                                }
                                                            }}
                                                            disabled={!!busy}
                                                            autoFocus
                                                            aria-label={`${costume.name}の衣装名`}
                                                            style={{ minWidth: 0, fontSize: '0.75rem', padding: '4px 8px', borderRadius: 6 }}
                                                        />
                                                        <button
                                                            type="button"
                                                            className="btn btn-ghost"
                                                            title="変更を保存"
                                                            aria-label="変更を保存"
                                                            disabled={!!busy || !editingNameValue.trim()}
                                                            onClick={() => saveCostumeEdit(costume)}
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
                                                            onClick={cancelCostumeEdit}
                                                            style={{ padding: '4px 6px' }}
                                                        >
                                                            <X size={14} />
                                                        </button>
                                                    </div>
                                                    <textarea
                                                        className="input"
                                                        value={editingDescriptionValue}
                                                        onChange={(event) => setEditingDescriptionValue(event.target.value)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Escape') {
                                                                event.preventDefault();
                                                                cancelCostumeEdit();
                                                            }
                                                        }}
                                                        placeholder="衣装の説明（任意）"
                                                        disabled={!!busy}
                                                        rows={2}
                                                        aria-label={`${costume.name}の衣装の説明`}
                                                        style={{ width: '100%', resize: 'vertical', fontSize: '0.75rem', padding: '4px 8px', borderRadius: 6 }}
                                                    />
                                                </div>
                                            ) : (
                                                <div>
                                                    <div style={{ fontSize: '0.8125rem', fontWeight: 500, wordBreak: 'break-all' }}>
                                                        {costume.name} <small>{costume.kind === 'vrm' ? '3D' : '2D'}</small>
                                                    </div>
                                                    {costume.description?.trim() && (
                                                        <p
                                                            title={costume.description}
                                                            style={{ margin: '2px 0 0', fontSize: '0.6875rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                                        >
                                                            {costume.description}
                                                        </p>
                                                    )}
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, marginTop: 4 }}>
                                                        {!isDefault && (
                                                            <button
                                                                type="button"
                                                                className="btn btn-ghost"
                                                                title="デフォルトにする"
                                                                aria-label={`${costume.name}をデフォルトにする`}
                                                                disabled={!!busy}
                                                                onClick={() => onSetDefault(costume.id)}
                                                                style={{ padding: '3px 5px' }}
                                                            >
                                                                <Star size={13} />
                                                            </button>
                                                        )}
                                                        {onOpenExpressions && costume.kind !== 'vrm' && (
                                                            <button
                                                                type="button"
                                                                className="btn btn-ghost"
                                                                title="表情差分を開く"
                                                                aria-label={`${costume.name}の表情差分を開く`}
                                                                disabled={!!busy}
                                                                onClick={() => openExpressions(costume)}
                                                                style={{ padding: '3px 5px' }}
                                                            >
                                                                <Smile size={13} />
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            className="btn btn-ghost"
                                                            title="名前と説明を編集"
                                                            aria-label={`${costume.name}の名前と説明を編集`}
                                                            disabled={!!busy}
                                                            onClick={() => {
                                                                setEditingId(costume.id);
                                                                setEditingNameValue(costume.name);
                                                                setEditingDescriptionValue(costume.description ?? '');
                                                                setError(null);
                                                            }}
                                                            style={{ padding: '3px 5px' }}
                                                        >
                                                            <Pencil size={13} />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className="btn btn-ghost"
                                                            title="画像を作り直す"
                                                            aria-label={`${costume.name}の画像を作り直す`}
                                                            disabled={!!busy}
                                                            onClick={() => { setError(null); setGenerationTarget({ kind: 'replace', costume }); }}
                                                            style={{ padding: '3px 5px' }}
                                                        >
                                                            <ImagePlus size={13} />
                                                        </button>
                                                        {costume.kind === 'vrm' && (
                                                            <button
                                                                type="button"
                                                                className="btn btn-ghost"
                                                                title="3D表示・表情を調整"
                                                                aria-label={`${costume.name}の3D表示・表情を調整`}
                                                                disabled={!!busy}
                                                                onClick={() => setEditingVrm(costume)}
                                                                style={{ padding: '3px 8px' }}
                                                            >
                                                                調整
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            className="btn btn-ghost"
                                                            title={costumes.length <= 1 ? '最後の衣装は削除できません' : '削除'}
                                                            aria-label={`${costume.name}を削除`}
                                                            disabled={!!busy || costumes.length <= 1}
                                                            onClick={() => removeCostume(costume)}
                                                            style={{ padding: '3px 5px', color: 'var(--error)', marginLeft: 'auto' }}
                                                        >
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </div>
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
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: 8 }}>
                                {addModeOptions.map((option) => (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        className={addMode === option.mode ? 'btn btn-primary' : 'btn btn-ghost'}
                                        onClick={() => switchAddMode(option.mode)}
                                        disabled={!!busy || option.disabled}
                                        title={option.title}
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                    >
                                        {option.icon} {option.label}
                                    </button>
                                ))}
                            </div>
                            {addMode === 'upload' && !uploadImage && (
                                <p style={{ ...hintStyle, marginTop: 0, marginBottom: 8 }}>
                                    画像または .vrm の3Dモデルを選択できます。
                                </p>
                            )}
                            {addMode === 'generate' && (
                                <>
                                    <div style={{ marginBottom: 8 }}>
                                        <label style={fieldLabelStyle}>元にする衣装</label>
                                        <OptionSelector
                                            value={baseCostume?.id ?? ''}
                                            onChange={(value) => {
                                                setBaseCostumeId(value);
                                                setDraftImage(null);
                                                setDraftName('');
                                            }}
                                            disabled={!!busy}
                                            ariaLabel="元にする衣装"
                                            options={costumes.map((costume) => ({
                                                value: costume.id,
                                                label: costume.name,
                                                ...(costume.id === defaultCostume?.id ? { detail: 'デフォルト' } : {}),
                                            }))}
                                        />
                                    </div>
                                    <div style={{ marginBottom: 8 }}>
                                        <label style={fieldLabelStyle}>モデル名</label>
                                        <ModelSelector
                                            value={model}
                                            onChange={setModel}
                                            outputModality="image"
                                            disabled={!!busy || !canGenerateImages}
                                            placeholder={`例: ${defaultImageModel.model}`}
                                        />
                                    </div>
                                </>
                            )}
                            {addMode !== 'scratch' && (
                                <div style={{ marginBottom: 8 }}>
                                    <label style={fieldLabelStyle}>衣装名の付け方</label>
                                    <OptionSelector
                                        value={nameSource}
                                        onChange={(value) => {
                                            setNameSource(value as NameSource);
                                            clearUploadQueue();
                                            setDraftImage(null);
                                            setDraftName('');
                                            setError(null);
                                        }}
                                        disabled={!!busy}
                                        ariaLabel="衣装名の付け方"
                                        options={[
                                            { value: 'manual', label: '手入力' },
                                            ...(addMode === 'upload'
                                                ? [{ value: 'filename', label: 'ファイル名から', detail: '拡張子を除いたファイル名を衣装名にします' }]
                                                : []),
                                            {
                                                value: 'ai',
                                                label: 'AIで自動判定',
                                                ...(addMode === 'upload' ? { detail: '.vrm はファイル名を衣装名にします' } : {}),
                                            },
                                        ]}
                                    />
                                </div>
                            )}
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
                            {!autoName && (
                                <div style={{ marginBottom: 8 }}>
                                    <label style={fieldLabelStyle}>衣装名</label>
                                    <input
                                        type="text"
                                        className="input"
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        placeholder="例: casual, school_uniform, dress"
                                        disabled={!!busy}
                                        data-modal-enter-submit={addMode === 'generate' || addMode === 'scratch' ? 'true' : undefined}
                                    />
                                </div>
                            )}
                            {addMode === 'generate' && (
                                <>
                                    <label style={fieldLabelStyle}>元の衣装からどう変化させるか</label>
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
                            {addMode === 'upload' && uploadImage && uploadNatural && uploadCrop && (
                                <div style={{ marginTop: 8 }}>
                                    {autoName && uploadFiles.length > 0 && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 8, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={uploadFiles[uploadIndex]?.name}>
                                                {uploadFiles[uploadIndex]?.name}
                                                {nameFromFile && ` → ${nameFromFileName(uploadFiles[uploadIndex]?.name ?? '') || '（名前なし）'}`}
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
                                        allowOverflow
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
                                accept="image/*,.vrm"
                                multiple={autoName}
                                onChange={handleFileUpload}
                                style={{ display: 'none' }}
                            />
                        </div>

                        {error && <p style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>{error}</p>}

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                            {addMode === 'scratch' ? (
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={openScratchGeneration}
                                    disabled={!!busy || !newName.trim()}
                                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                >
                                    <Sparkles size={14} /> 作成画面を開く
                                </button>
                            ) : addMode === 'generate' ? (
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
                                            disabled={generateDisabled}
                                            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                        >
                                            <RefreshCw size={14} /> 再生成
                                        </button>
                                    )}
                                    <button
                                        className="btn btn-primary"
                                        onClick={handleAdd}
                                        disabled={generateDisabled}
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
                                            disabled={generateDisabled}
                                        >
                                            追加して完了
                                        </button>
                                    )}
                                </>
                            ) : (
                                <>
                                    {uploadImage && (
                                        <button
                                            type="button"
                                            className="btn btn-ghost"
                                            onClick={handleUploadClick}
                                            disabled={!!busy || (!autoName && !newName.trim())}
                                        >
                                            選び直す
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={uploadImage ? () => { void handleConfirmUpload(); } : handleUploadClick}
                                        disabled={!!busy || (!autoName && !newName.trim()) || (!!uploadImage && !uploadCrop)}
                                        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                    >
                                        {busy === UPLOAD_BUSY_KEY && <Loader2 size={16} className="animate-spin" />}
                                        {busy === UPLOAD_BUSY_KEY
                                            ? autoName && uploadFiles.length > 1
                                                ? `${autoDetectName ? '処理・判定中' : '処理中'}... (${uploadIndex + 1}/${uploadFiles.length})`
                                                : autoDetectName ? '処理・判定中...' : '処理中...'
                                            : uploadImage && autoName && uploadIndex + 1 < uploadFiles.length
                                                ? `追加して次へ (${uploadIndex + 1}/${uploadFiles.length})`
                                                : uploadImage && autoName && uploadFiles.length > 1
                                                    ? `追加 (${uploadIndex + 1}/${uploadFiles.length})`
                                                    : uploadImage ? '追加' : '選択'}
                                    </button>
                                    {uploadImage && (
                                        <button
                                            type="button"
                                            className="btn btn-primary"
                                            onClick={handleAddAndClose}
                                            disabled={!!busy || (!autoName && !newName.trim()) || !uploadCrop}
                                            title={autoName && uploadIndex + 1 < uploadFiles.length
                                                ? '残りの画像は最初の切り抜き枠のまま追加します'
                                                : undefined}
                                        >
                                            {autoName && uploadIndex + 1 < uploadFiles.length
                                                ? `残り${uploadFiles.length - uploadIndex - 1}枚も追加して完了`
                                                : '追加して完了'}
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        )}

        {generationTarget && (
            <ImageGenerationModal
                isOpen
                onClose={() => setGenerationTarget(null)}
                target="costume"
                title={generationTarget.kind === 'replace'
                    ? `「${generationTarget.costume.name}」の画像を作り直す`
                    : `「${generationTarget.name}」をゼロから作成`}
                defaultUpdateIcon={!hasIcon}
                transparentFullBody
                expressionNames={vrmExpressionNames}
                vrmPreviewName={ownerName || 'キャラクター'}
                vrmFallbackImage={generationTarget.kind === 'replace' ? generationTarget.costume.image : undefined}
                allowUpload={generationTarget.kind === 'replace'}
                onComplete={handleGenerationComplete}
            />
        )}

        {addOpen && addMode === 'upload' && vrmDraft && !editingVrm && <VrmCostumeEditor name={newName}
            initialAvatar={vrmDraft}
            existingNames={costumes.map((costume) => costume.name)} expressionNames={vrmExpressionNames}
            onSave={(costume) => { onUpsert(costume); setNewName(''); setVrmDraft(null); setAddOpen(false); }}
            onCancel={() => setVrmDraft(null)} />}
        {editingVrm && <VrmCostumeEditor key={editingVrm.id} costume={editingVrm} name={editingVrm.name}
            existingNames={costumes.map((costume) => costume.name)} expressionNames={vrmExpressionNames}
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
