import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Loader2, Sparkles, Upload, User, X } from 'lucide-react';
import { resolveCharacterImportPreviewImage } from '@/lib/characterImportPreview';
import { parseCharacterBackup, type ParsedBackup } from '@/lib/importExport';
import { useStore } from '@/lib/store';
import StoredImage from './StoredImage';
import { useModalKeyboard } from './useModalKeyboard';

interface CharacterAddModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: () => void;
    onGenerate: () => void;
}

export default function CharacterAddModal({
    isOpen,
    onClose,
    onCreate,
    onGenerate,
}: CharacterAddModalProps) {
    const { mergeBackup } = useStore();
    const [importData, setImportData] = useState<ParsedBackup | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [isReading, setIsReading] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const busy = isReading || isImporting;

    useEffect(() => {
        if (isOpen) return;
        setImportData(null);
        setImportError(null);
        setIsReading(false);
        setIsImporting(false);
    }, [isOpen]);

    const attemptClose = () => {
        if (!busy) onClose();
    };

    useModalKeyboard({
        isOpen,
        containerRef: modalRef,
        onClose: attemptClose,
        canClose: !busy,
    });

    if (!isOpen) return null;

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file || busy) return;

        setImportError(null);
        setIsReading(true);
        try {
            const parsed = parseCharacterBackup(await file.text());
            setImportData(parsed);
        } catch (error) {
            setImportData(null);
            setImportError(error instanceof Error ? error.message : 'インポートに失敗しました');
        } finally {
            setIsReading(false);
        }
    };

    const handleImport = async () => {
        if (!importData || busy) return;

        setImportError(null);
        setIsImporting(true);
        try {
            await mergeBackup(importData);
            setIsImporting(false);
            onClose();
        } catch (error) {
            setImportError(error instanceof Error ? error.message : 'インポートに失敗しました');
            setIsImporting(false);
        }
    };

    const previewCharacter = importData?.characters[0] ?? null;
    const previewImage = previewCharacter
        ? resolveCharacterImportPreviewImage(previewCharacter)
        : null;

    return (
        <div
            className="modal-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) attemptClose();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content character-add-modal"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="キャラクターを追加"
                aria-busy={busy}
            >
                <div className="modal-header">
                    <h2 className="character-add-modal-title">
                        <User size={18} /> キャラクターを追加
                    </h2>
                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={attemptClose}
                        disabled={busy}
                        title="閉じる"
                        aria-label="閉じる"
                        style={{ padding: '0.5rem' }}
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body">
                    {previewCharacter ? (
                        <div className="character-import-preview">
                            <div className="character-import-preview-image">
                                {previewImage ? (
                                    <StoredImage
                                        src={previewImage}
                                        alt={`${previewCharacter.name}のdefault衣装・neutral表情`}
                                        loading="eager"
                                    />
                                ) : (
                                    <User size={52} aria-hidden="true" />
                                )}
                            </div>
                            <h3>{previewCharacter.name}</h3>
                        </div>
                    ) : (
                        <div className="character-add-options">
                            <button
                                type="button"
                                className="character-add-option"
                                onClick={onCreate}
                                disabled={busy}
                            >
                                <span className="character-add-option-icon"><User size={19} /></span>
                                <span>新しく作る</span>
                                <ChevronRight size={18} aria-hidden="true" />
                            </button>
                            <button
                                type="button"
                                className="character-add-option"
                                onClick={onGenerate}
                                disabled={busy}
                            >
                                <span className="character-add-option-icon"><Sparkles size={19} /></span>
                                <span>AIで自動作成</span>
                                <ChevronRight size={18} aria-hidden="true" />
                            </button>
                            <button
                                type="button"
                                className="character-add-option"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={busy}
                            >
                                <span className="character-add-option-icon">
                                    {isReading ? <Loader2 size={19} className="animate-spin" /> : <Upload size={19} />}
                                </span>
                                <span>ファイルからインポート</span>
                                <ChevronRight size={18} aria-hidden="true" />
                            </button>
                        </div>
                    )}

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,application/json"
                        onChange={handleFileSelect}
                        disabled={busy}
                        style={{ display: 'none' }}
                    />

                    {importError && (
                        <div className="character-add-error" role="alert">
                            <AlertTriangle size={15} />
                            <span>{importError}</span>
                        </div>
                    )}
                </div>

                {previewCharacter && (
                    <div className="modal-footer">
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => {
                                setImportData(null);
                                setImportError(null);
                            }}
                            disabled={busy}
                        >
                            戻る
                        </button>
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => { void handleImport(); }}
                            disabled={busy}
                        >
                            {isImporting && <Loader2 size={16} className="animate-spin" />}
                            {isImporting ? '追加中...' : '追加する'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
