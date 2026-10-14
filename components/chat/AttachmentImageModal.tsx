import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import StoredImage from '../StoredImage';
import { useModalKeyboard } from '../useModalKeyboard';

export type PreviewedAttachmentImage = {
    src: string;
    name: string;
};

type AttachmentImageModalProps = {
    image: PreviewedAttachmentImage;
    onClose: () => void;
};

export default function AttachmentImageModal({
    image,
    onClose,
}: AttachmentImageModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    useModalKeyboard({
        isOpen: true,
        containerRef: modalRef,
        initialFocusRef: closeButtonRef,
        onClose,
    });

    return createPortal(
        <div
            className="modal-overlay attachment-image-lightbox-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={modalRef}
                className="attachment-image-lightbox-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={image.name || '添付画像の拡大表示'}
                onPointerDown={(event) => {
                    if (event.target === event.currentTarget) onClose();
                }}
            >
                <div className="attachment-image-lightbox-header" onClick={(event) => event.stopPropagation()}>
                    {image.name && (
                        <div className="attachment-image-lightbox-caption" title={image.name}>
                            {image.name}
                        </div>
                    )}
                    <button
                        ref={closeButtonRef}
                        type="button"
                        className="btn btn-ghost attachment-image-lightbox-close"
                        onClick={onClose}
                        aria-label="閉じる"
                        title="閉じる"
                    >
                        <X size={20} />
                    </button>
                </div>
                <StoredImage
                    src={image.src}
                    alt={image.name}
                    className="attachment-image-lightbox-img"
                    loading="eager"
                    onClick={(event) => event.stopPropagation()}
                />
            </div>
        </div>,
        document.body,
    );
}
