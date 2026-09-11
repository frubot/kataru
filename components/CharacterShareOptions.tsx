import { useRef, useState } from 'react';
import { useModalKeyboard } from './useModalKeyboard';

export default function CharacterShareOptions({ name, onShare, onClose }: {
    name: string;
    onShare: (includeVrm: boolean) => Promise<void>;
    onClose: () => void;
}) {
    const [include, setInclude] = useState(false);
    const [busy, setBusy] = useState(false);
    const modal = useRef<HTMLDivElement>(null);
    useModalKeyboard({ isOpen: true, containerRef: modal, onClose, canClose: !busy });
    return <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}>
        <div ref={modal} className="modal-content" role="dialog" aria-modal="true" aria-label="キャラクターを共有" onClick={(event) => event.stopPropagation()} style={{ maxWidth: 440, padding: 24 }}>
            <h2 style={{ fontSize: '1rem' }}>{name} を共有</h2>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '16px 0' }}>
                <input type="checkbox" checked={include} disabled={busy} onChange={(event) => setInclude(event.target.checked)} />VRMモデル本体を含める
            </label>
            <p className="vrm-hint">含めない場合、3D衣装はサムネイル画像の2D衣装として書き出します。モデルを含める場合は、配布元の利用条件を確認してください。</p>
            <div className="vrm-editor-actions" style={{ marginTop: 20 }}>
                <button className="btn btn-ghost" disabled={busy} onClick={onClose}>キャンセル</button>
                <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await onShare(include); } finally { setBusy(false); } }}>{busy ? '準備中…' : '書き出す'}</button>
            </div>
        </div>
    </div>;
}
