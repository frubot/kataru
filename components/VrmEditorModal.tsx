import { useCallback, useRef, useState } from 'react';
import { Box, X } from 'lucide-react';
import type { VrmAvatar } from '@/lib/store/types';
import type { VrmPreview } from './VrmAvatarView';
import VrmModelEditor from './VrmModelEditor';
import { useModalKeyboard } from './useModalKeyboard';

/** Standalone VRM editor dialog. The preview fills one pane while the file,
 *  framing, expression and motion controls sit in the other; the panes sit
 *  side by side on wide screens and stack on mobile.
 *  The parent owns the avatar draft and decides what closing means. */
export default function VrmEditorModal({ avatar, name, fallbackImage, expressionNames = [], title = '3Dアバターの設定', confirmLabel = '確定', cancelLabel = '戻る', confirmDisabled = false, onChange, onConfirm, onClose }: {
    avatar?: VrmAvatar;
    /** Preview caption, typically the character or costume name. */
    name: string;
    fallbackImage?: string;
    /** 2D expression names offered as mapping targets alongside the saved map keys. */
    expressionNames?: string[];
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** Extra gate on top of the preview-ready check (e.g. an invalid name). */
    confirmDisabled?: boolean;
    onChange: (avatar: VrmAvatar) => void;
    /** May throw; the message is shown inside the modal. */
    onConfirm: (avatar: VrmAvatar, preview: VrmPreview) => void;
    onClose: () => void;
}) {
    const [ready, setReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const preview = useRef<VrmPreview | null>(null);
    const modalRef = useRef<HTMLDivElement>(null);

    const handleReady = useCallback((value: VrmPreview | null) => {
        preview.current = value;
        setReady(value !== null);
    }, []);

    useModalKeyboard({ isOpen: true, containerRef: modalRef, onClose, canClose: !loading });

    const handleConfirm = () => {
        const current = preview.current;
        if (!avatar || !current || !ready) return;
        try {
            onConfirm(avatar, current);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'プレビューの取得に失敗しました');
        }
    };

    return (
        <div
            className="modal-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget && !loading) onClose();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content settings-form-modal vrm-editor-modal"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <div className="settings-form-modal-actions" style={{ justifyContent: 'space-between' }}>
                    <h2 style={{ margin: 0, paddingLeft: '0.25rem', fontSize: '0.9375rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Box size={18} /> {title}
                    </h2>
                    <button className="btn btn-ghost" onClick={onClose} disabled={loading} title="閉じる" aria-label="閉じる">
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body vrm-editor-modal-body">
                    <VrmModelEditor
                        avatar={avatar}
                        name={name}
                        fallbackImage={fallbackImage}
                        expressionNames={expressionNames}
                        onChange={onChange}
                        onReady={handleReady}
                        onError={setError}
                        onLoadingChange={setLoading}
                    />
                </div>

                {error && <p role="alert" className="vrm-editor-modal-error">{error}</p>}

                <div className="vrm-editor-modal-footer">
                    <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>{cancelLabel}</button>
                    <button type="button" className="btn btn-primary" disabled={!ready || loading || confirmDisabled} onClick={handleConfirm}>{confirmLabel}</button>
                </div>
            </div>
        </div>
    );
}
