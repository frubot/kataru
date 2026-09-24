import { useState } from 'react';
import type { Costume, VrmAvatar } from '@/lib/store/types';
import type { VrmPreview } from './VrmAvatarView';
import VrmEditorModal from './VrmEditorModal';

/** VrmEditorModal with costume validation: the confirm builds a vrm costume
 *  from the preview capture once the name checks out. */
export default function VrmCostumeEditor({ costume, initialAvatar, name, existingNames, expressionNames = [], onSave, onCancel }: {
    costume?: Costume;
    /** Avatar picked via the unified upload input before this editor mounts. */
    initialAvatar?: VrmAvatar;
    name: string;
    existingNames: string[];
    expressionNames?: string[];
    onSave: (costume: Costume) => void;
    onCancel?: () => void;
}) {
    const [avatar, setAvatar] = useState<VrmAvatar | undefined>(costume?.vrm ?? initialAvatar);
    const confirm = (next: VrmAvatar, preview: VrmPreview) => {
        const trimmed = name.trim();
        if (!trimmed || trimmed.toLowerCase() === 'default') throw new Error('default以外の衣装名を入力してください。');
        if (!costume && existingNames.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) throw new Error('同じ衣装名が既にあります。');
        onSave({ name: trimmed, kind: 'vrm', image: preview.capture(), vrm: next, promptDetail: costume?.promptDetail });
    };
    return <VrmEditorModal
        avatar={avatar}
        name={name}
        fallbackImage={costume?.image}
        expressionNames={expressionNames}
        title={costume ? `${costume.name} の3D設定` : '3Dアバターを追加'}
        confirmLabel={costume ? '調整を保存' : '3Dアバターを追加'}
        cancelLabel="キャンセル"
        confirmDisabled={!name.trim()}
        onChange={setAvatar}
        onConfirm={confirm}
        onClose={() => onCancel?.()}
    />;
}
