'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Loader2, Trash2, RefreshCw, Shirt, Sparkles, Upload } from 'lucide-react';
import type { Costume } from '@/lib/store';
import { useStore } from '@/lib/store';
import { cropRectToPng, loadImage, resizeToMaxEdge } from '@/lib/imageUtils';
import { CropArea, createInitialCrop, type CropBox } from './ImageCropArea';
import StoredImage from './StoredImage';

const MAX_EDGE = 1024;
const COSTUME_ASPECT_RATIO = '2:3';
const COSTUME_ASPECT = 2 / 3;
const NEW_BUSY_KEY = '__new__';
const UPLOAD_BUSY_KEY = '__upload__';
const DEFAULT_COSTUME_NAME = 'default';

type AddMode = 'generate' | 'upload';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    baseImage?: string;
    costumes: Costume[];
    onUpsert: (costume: Costume) => void;
    onRemove: (name: string) => void;
}

export default function CostumeDiffModal({ isOpen, onClose, baseImage, costumes, onUpsert, onRemove }: Props) {
    const { defaultImageModel, aiProvider, getAiProviderConfig } = useStore();
    const canGenerateDiffs = aiProvider === 'openrouter';
    const [newName, setNewName] = useState('');
    const [newPromptDetail, setNewPromptDetail] = useState('');
    const [addMode, setAddMode] = useState<AddMode>('generate');
    const [model, setModel] = useState(defaultImageModel);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadImgRef = useRef<HTMLImageElement>(null);
    const [uploadImage, setUploadImage] = useState<string | null>(null);
    const [uploadNatural, setUploadNatural] = useState<{ w: number; h: number } | null>(null);
    const [uploadCrop, setUploadCrop] = useState<CropBox | null>(null);

    useEffect(() => {
        if (!isOpen) {
            setNewName('');
            setNewPromptDetail('');
            setAddMode(canGenerateDiffs ? 'generate' : 'upload');
            setModel(defaultImageModel);
            setBusy(null);
            setError(null);
            setUploadImage(null);
            setUploadNatural(null);
            setUploadCrop(null);
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
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !busy) onClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose, busy]);

    const clearUploadDraft = () => {
        setUploadImage(null);
        setUploadNatural(null);
        setUploadCrop(null);
    };

    const buildPrompt = (name: string, promptDetail?: string) => {
        const detail = promptDetail?.trim();
        return [
            `Change the character's outfit/costume to ${name}.`,
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

    const generate = async (name: string, busyKey: string, promptDetail?: string) => {
        if (!canGenerateDiffs) {
            setError('OpenAI互換APIでは元画像を使う衣装差分生成に対応していません。アップロードを使ってください。');
            return;
        }
        if (!baseImage) {
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
                    baseImage,
                    aspectRatio: COSTUME_ASPECT_RATIO,
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
            const existing = costumes.find((c) => c.name === name);
            onUpsert({
                ...existing,
                name,
                promptDetail: normalizedPromptDetail,
                image: resized,
            });
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
        const name = validateName();
        if (!name || busy || !model.trim() || !canGenerateDiffs) return;
        generate(name, NEW_BUSY_KEY, newPromptDetail);
    };

    const handleUploadClick = () => {
        if (!validateName()) return;
        fileInputRef.current?.click();
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        if (!validateName()) return;
        if (!file.type.startsWith('image/')) {
            setError('画像ファイルを選択してください。');
            return;
        }

        setBusy(UPLOAD_BUSY_KEY);
        clearUploadDraft();
        try {
            const dataUrl: string = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
                reader.readAsDataURL(file);
            });
            const resized = await resizeToMaxEdge(dataUrl, MAX_EDGE);
            const img = await loadImage(resized);
            setUploadImage(resized);
            setUploadNatural({ w: img.width, h: img.height });
            setUploadCrop(createInitialCrop(img.width, img.height, COSTUME_ASPECT));
        } catch (e) {
            setError(e instanceof Error ? e.message : '画像の読み込みに失敗しました');
        } finally {
            setBusy(null);
        }
    };

    const handleConfirmUpload = async () => {
        const name = validateName();
        if (!name || !uploadImage || !uploadCrop) return;

        setBusy(UPLOAD_BUSY_KEY);
        try {
            const cropped = await cropRectToPng(
                uploadImage,
                uploadCrop.x,
                uploadCrop.y,
                uploadCrop.width,
                uploadCrop.height,
            );
            onUpsert({ name, image: cropped });
            setNewName('');
            setNewPromptDetail('');
            clearUploadDraft();
        } catch (e) {
            setError(e instanceof Error ? e.message : '画像の切り取りに失敗しました');
        } finally {
            setBusy(null);
        }
    };

    const handleCancelBusy = () => {
        abortRef.current?.abort();
        setBusy(null);
    };

    if (!isOpen) return null;

    return (
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget && !busy) onClose();
            }}
        >
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
                <div className="modal-header">
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Shirt size={18} /> 衣装差分
                    </h2>
                    <button className="btn btn-ghost" onClick={() => !busy && onClose()} style={{ padding: '0.5rem' }}>
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div>
                        <label style={labelStyle}>新しい衣装を追加</label>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                            <button
                                type="button"
                                className={addMode === 'generate' ? 'btn btn-primary' : 'btn btn-ghost'}
                                onClick={() => {
                                    setAddMode('generate');
                                    clearUploadDraft();
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
                                <input
                                    type="text"
                                    className="input"
                                    value={model}
                                    onChange={(e) => setModel(e.target.value)}
                                    disabled={!!busy || !canGenerateDiffs}
                                    placeholder="例: bytedance-seed/seedream-4.5"
                                />
                            </div>
                        )}
                        <div style={{ marginBottom: 8 }}>
                            <label style={fieldLabelStyle}>衣装名</label>
                            <input
                                type="text"
                                className="input"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="例: casual, school_uniform, dress"
                                disabled={!!busy}
                                onKeyDown={(e) => { if (e.key === 'Enter' && addMode === 'generate') handleAdd(); }}
                            />
                        </div>
                        {addMode === 'generate' && (
                            <>
                                <label style={fieldLabelStyle}>補足</label>
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
                        {addMode === 'generate' ? (
                            <p style={hintStyle}>
                                {!canGenerateDiffs
                                    ? 'OpenAI互換APIでは元画像を使う差分生成に対応していません。アップロードで追加してください。'
                                    : baseImage
                                    ? 'デフォルトの立ち絵をベースに、衣装だけを変更して生成します'
                                    : '生成には「アバター画像」から立ち絵の登録が必要です。アップロードなら衣装差分を直接追加できます。'}
                            </p>
                        ) : (
                            <p style={hintStyle}>
                                {uploadImage
                                    ? '切り取り範囲を調整してから追加します'
                                    : '画像を選択すると 2:3 の切り取り範囲を調整できます'}
                            </p>
                        )}
                        {addMode === 'upload' && uploadImage && uploadNatural && uploadCrop && (
                            <div style={{ marginTop: 8 }}>
                                <CropArea
                                    key={uploadImage}
                                    imgRef={uploadImgRef}
                                    src={uploadImage}
                                    natural={uploadNatural}
                                    crop={uploadCrop}
                                    aspect={COSTUME_ASPECT}
                                    hint="この範囲を 2:3 の衣装差分として保存します"
                                    onChange={(next) => setUploadCrop(next)}
                                />
                            </div>
                        )}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
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
                                disabled={!!busy || !canGenerateDiffs || !newName.trim() || !model.trim() || !baseImage}
                                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                            >
                                {busy === NEW_BUSY_KEY && <Loader2 size={16} className="animate-spin" />}
                                {busy === NEW_BUSY_KEY ? '生成中...' : '生成'}
                            </button>
                        ) : (
                            <>
                                {uploadImage && (
                                    <button
                                        type="button"
                                        className="btn btn-ghost"
                                        onClick={handleUploadClick}
                                        disabled={!!busy || !newName.trim()}
                                    >
                                        選び直す
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={uploadImage ? () => { void handleConfirmUpload(); } : handleUploadClick}
                                    disabled={!!busy || !newName.trim() || (!!uploadImage && !uploadCrop)}
                                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                                >
                                    {busy === UPLOAD_BUSY_KEY && <Loader2 size={16} className="animate-spin" />}
                                    {busy === UPLOAD_BUSY_KEY ? '処理中...' : uploadImage ? '追加' : '選択'}
                                </button>
                            </>
                        )}
                    </div>

                    <div>
                        <label style={labelStyle}>登録済み（{costumes.length}件）</label>
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
                                            {busy === costume.name && (
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
                                            <div style={{ fontSize: '0.8125rem', fontWeight: 500, marginBottom: 6, wordBreak: 'break-all' }}>
                                                {costume.name}
                                            </div>
                                            <textarea
                                                className="input"
                                                value={costume.promptDetail ?? ''}
                                                onChange={(e) => {
                                                    const promptDetail = e.target.value || undefined;
                                                    onUpsert({ ...costume, promptDetail });
                                                }}
                                                placeholder={isDefault ? 'アバター変更で更新される基準衣装' : 'この衣装の特徴'}
                                                disabled={!!busy || isDefault}
                                                rows={3}
                                                style={{
                                                    width: '100%',
                                                    resize: 'vertical',
                                                    fontSize: '0.75rem',
                                                    marginBottom: 6,
                                                }}
                                            />
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                                                <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                    {isDefault ? '基準衣装' : `表情 ${costume.expressions?.length ?? 0}件`}
                                                </span>
                                                {isDefault ? (
                                                    <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                        アバター変更で更新
                                                    </span>
                                                ) : (
                                                    <div style={{ display: 'flex', gap: 4 }}>
                                                        <button
                                                            className="btn btn-ghost"
                                                            title="再生成"
                                                            disabled={!!busy || !canGenerateDiffs || !baseImage}
                                                            onClick={() => generate(costume.name, costume.name, costume.promptDetail)}
                                                            style={{ padding: '4px 8px' }}
                                                        >
                                                            <RefreshCw size={14} />
                                                        </button>
                                                        <button
                                                            className="btn btn-ghost"
                                                            title="削除"
                                                            disabled={!!busy}
                                                            onClick={() => {
                                                                if (confirm(`「${costume.name}」を削除しますか？`)) onRemove(costume.name);
                                                            }}
                                                            style={{ padding: '4px 8px', color: 'var(--error)' }}
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-ghost" onClick={() => !busy && onClose()} disabled={!!busy}>閉じる</button>
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
