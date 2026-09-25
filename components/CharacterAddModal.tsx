import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Loader2, Plus, Sparkles, Upload, User, X } from 'lucide-react';
import type { GeneratedCharacterDraft } from '@/lib/characterGeneration';
import { AI_CONNECTION_KINDS } from '@/lib/aiApi';
import { getAiConnections } from '@/lib/aiConnections';
import {
    importCharacterPackage,
    inspectCharacterPackage,
    type CharacterPackageInspection,
} from '@/lib/characterPackage';
import { useStore } from '@/lib/store';
import CharacterGeneratorModal from './CharacterGeneratorModal';
import StoredImage from './StoredImage';
import { useModalKeyboard } from './useModalKeyboard';

interface CharacterAddModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: () => void;
    onGenerated: (draft: GeneratedCharacterDraft) => void;
}

export default function CharacterAddModal({
    isOpen,
    onClose,
    onCreate,
    onGenerated,
}: CharacterAddModalProps) {
    const { addImportedCharacter, defaultChatModel } = useStore();
    const [packageFile, setPackageFile] = useState<{
        file: File;
        inspection: CharacterPackageInspection;
    } | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [isReading, setIsReading] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [characterGeneratorOpen, setCharacterGeneratorOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const busy = isReading || isImporting;

    useEffect(() => {
        if (isOpen) return;
        setPackageFile(null);
        setImportError(null);
        setIsReading(false);
        setIsImporting(false);
        setCharacterGeneratorOpen(false);
    }, [isOpen]);

    const attemptClose = () => {
        if (!busy && !characterGeneratorOpen) onClose();
    };

    useModalKeyboard({
        isOpen,
        containerRef: modalRef,
        onClose: attemptClose,
        canClose: !busy && !characterGeneratorOpen,
    });

    if (!isOpen) return null;

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file || busy) return;

        setImportError(null);
        setIsReading(true);
        try {
            const inspection = await inspectCharacterPackage(file);
            setPackageFile({ file, inspection });
        } catch (error) {
            setPackageFile(null);
            setImportError(error instanceof Error ? error.message : 'インポートに失敗しました');
        } finally {
            setIsReading(false);
        }
    };

    const handleImport = async () => {
        if (!packageFile || busy) return;

        setImportError(null);
        setIsImporting(true);
        try {
            const connectionIds = await getAiConnections()
                .then((response) => response.connections.map((connection) => connection.id))
                .catch(() => [] as string[]);
            const character = await importCharacterPackage(packageFile.file, {
                fallbackModel: defaultChatModel.model,
                fallbackConnectionId: defaultChatModel.connectionId,
                knownConnectionIds: [...AI_CONNECTION_KINDS, ...connectionIds],
            });
            addImportedCharacter(character);
            setIsImporting(false);
            onClose();
        } catch (error) {
            setImportError(error instanceof Error ? error.message : 'インポートに失敗しました');
            setIsImporting(false);
        }
    };

    const inspection = packageFile?.inspection ?? null;

    return (
        <>
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
                    aria-label="追加方法を選択"
                    aria-busy={busy}
                >
                    <div className="modal-header">
                        <h2 className="character-add-modal-title">
                            <User size={18} /> 追加方法を選択
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
                        {inspection ? (
                            <div className="character-import-preview">
                                <div className="character-import-preview-image">
                                    {inspection.previewImage ? (
                                        <StoredImage
                                            src={inspection.previewImage}
                                            alt={`${inspection.name}のプレビュー`}
                                            loading="eager"
                                        />
                                    ) : (
                                        <User size={52} aria-hidden="true" />
                                    )}
                                </div>
                                <h3>{inspection.name}</h3>
                                <p style={{
                                    margin: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexWrap: 'wrap',
                                    gap: '0.5rem',
                                    color: 'var(--text-secondary)',
                                    fontSize: '0.8rem',
                                }}>
                                    <span>{inspection.assetCount}個のアセット</span>
                                    {inspection.hasVrm && (
                                        <span style={{
                                            padding: '0.1rem 0.5rem',
                                            border: '1px solid var(--accent-primary)',
                                            borderRadius: '999px',
                                            color: 'var(--accent-primary)',
                                            fontSize: '0.7rem',
                                            fontWeight: 600,
                                        }}>
                                            3D衣装あり
                                        </span>
                                    )}
                                </p>
                            </div>
                        ) : (
                            <div className="character-add-options">
                                <button
                                    type="button"
                                    className="character-add-option"
                                    onClick={onCreate}
                                    disabled={busy}
                                >
                                    <span className="character-add-option-icon"><Plus size={20} /></span>
                                    <span>新しく作る</span>
                                    <ChevronRight size={18} aria-hidden="true" />
                                </button>
                                <button
                                    type="button"
                                    className="character-add-option"
                                    onClick={() => setCharacterGeneratorOpen(true)}
                                    disabled={busy}
                                >
                                    <span className="character-add-option-icon"><Sparkles size={19} /></span>
                                    <span>AIに作ってもらう</span>
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
                            accept=".kataru,.zip"
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

                    {inspection && (
                        <div className="modal-footer">
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                    setPackageFile(null);
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

            <CharacterGeneratorModal
                isOpen={characterGeneratorOpen}
                onClose={() => setCharacterGeneratorOpen(false)}
                onApply={(draft) => {
                    setCharacterGeneratorOpen(false);
                    onGenerated(draft);
                }}
            />
        </>
    );
}
