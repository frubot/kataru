import { useCallback, useRef, useState } from 'react';
import type { Costume, VrmAvatar } from '@/lib/store/types';
import type { VrmPreview } from './VrmAvatarView';
import VrmModelEditor from './VrmModelEditor';

export default function VrmCostumeEditor({ costume, name, existingNames, expressionNames = [], onSave, onCancel }: {
    costume?: Costume;
    name: string;
    existingNames: string[];
    expressionNames?: string[];
    onSave: (costume: Costume) => void;
    onCancel?: () => void;
}) {
    const [avatar, setAvatar] = useState<VrmAvatar | undefined>(costume?.vrm);
    const [ready, setReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const preview = useRef<VrmPreview | null>(null);
    const handleReady = useCallback((value: VrmPreview | null) => {
        preview.current = value;
        setReady(value !== null);
    }, []);
    const save = () => {
        try {
            const trimmed = name.trim();
            if (!trimmed || trimmed.toLowerCase() === 'default') throw new Error('default以外の衣装名を入力してください。');
            if (!costume && existingNames.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) throw new Error('同じ衣装名が既にあります。');
            if (!avatar || !preview.current || !ready) return;
            onSave({ name: trimmed, kind: 'vrm', image: preview.current.capture(), vrm: avatar, promptDetail: costume?.promptDetail });
        } catch (reason) { setError(reason instanceof Error ? reason.message : '保存できませんでした。'); }
    };
    return <div className="vrm-editor">
        <VrmModelEditor
            avatar={avatar}
            name={name || 'プレビュー'}
            fallbackImage={costume?.image}
            expressionNames={expressionNames}
            onChange={setAvatar}
            onReady={handleReady}
            onError={setError}
            onLoadingChange={setLoading}
        />
        {error && <p role="alert" style={{ color: 'var(--error)' }}>{error}</p>}
        <div className="vrm-editor-actions">
            {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>キャンセル</button>}
            <button type="button" className="btn btn-primary" disabled={!ready || loading || !name.trim()} onClick={save}>{costume ? '調整を保存' : '3Dアバターを追加'}</button>
        </div>
    </div>;
}
