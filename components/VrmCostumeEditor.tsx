import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import type { Costume, VrmAvatar } from '@/lib/store/types';
import { createVrmExpressionMap, DEFAULT_VRM_FRAMING, MAX_VRM_BYTES, validateVrmBuffer, VRM_DATA_PREFIX } from '@/lib/vrm';
import type { VrmPreview } from './VrmAvatarView';

const VrmAvatarView = lazy(() => import('./VrmAvatarView'));

export default function VrmCostumeEditor({ costume, name, existingNames, expressionNames = [], onSave, onCancel }: {
    costume?: Costume;
    name: string;
    existingNames: string[];
    expressionNames?: string[];
    onSave: (costume: Costume) => void;
    onCancel?: () => void;
}) {
    const [avatar, setAvatar] = useState<VrmAvatar | undefined>(costume?.vrm);
    const [available, setAvailable] = useState<string[]>([]);
    const [ready, setReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [expression, setExpression] = useState('neutral');
    const [customName, setCustomName] = useState('');
    const preview = useRef<VrmPreview | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const generation = useRef(0);
    const handleReady = useCallback((value: VrmPreview | null) => {
        preview.current = value;
        setReady(value !== null);
        if (value) {
            setAvailable(value.expressions);
            setAvatar((current) => current && Object.keys(current.expressionMap).length === 0
                ? { ...current, expressionMap: createVrmExpressionMap(value.expressions) } : current);
        }
    }, []);
    const selectFile = async (file?: File) => {
        if (!file) return;
        const request = ++generation.current;
        setError('');
        setLoading(true);
        try {
            if (!file.name.toLowerCase().endsWith('.vrm')) throw new Error('.vrmファイルを選択してください。');
            if (file.size > MAX_VRM_BYTES) throw new Error('VRMは50MB以下にしてください。');
            const buffer = await file.arrayBuffer();
            validateVrmBuffer(buffer);
            const source = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(VRM_DATA_PREFIX + String(reader.result).split(',')[1]);
                reader.onerror = () => reject(new Error('ファイルを読み込めませんでした。'));
                reader.readAsDataURL(file);
            });
            if (request !== generation.current) return;
            preview.current = null;
            setReady(false);
            setAvailable([]);
            setExpression('neutral');
            setAvatar({ source, framing: { ...DEFAULT_VRM_FRAMING }, expressionMap: {} });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : '読み込みに失敗しました。');
        } finally { if (request === generation.current) setLoading(false); }
    };
    const save = () => {
        try {
            const trimmed = name.trim();
            if (!trimmed || trimmed.toLowerCase() === 'default') throw new Error('default以外の衣装名を入力してください。');
            if (!costume && existingNames.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) throw new Error('同じ衣装名が既にあります。');
            if (!avatar || !preview.current || !ready) return;
            onSave({ name: trimmed, kind: 'vrm', image: preview.current.capture(), vrm: avatar, promptDetail: costume?.promptDetail });
        } catch (reason) { setError(reason instanceof Error ? reason.message : '保存できませんでした。'); }
    };
    const names = Array.from(new Set([...Object.keys(avatar?.expressionMap ?? {}), ...expressionNames.filter((entry) => entry !== 'neutral')]));
    return <div className="vrm-editor">
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => fileInput.current?.click()}>{avatar ? 'VRMファイルを変更' : 'VRMファイルを選択'}</button>
        <input ref={fileInput} type="file" accept=".vrm" disabled={loading} onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} style={{ display: 'none' }} />
        <p className="vrm-hint">VRM 0.x / 1.0、50MBまで。モデルはこの端末に保存されます。</p>
        {loading && <p role="status">ファイルを読み込み中…</p>}
        {avatar && <>
            <div className="vrm-preview"><Suspense fallback={<p>プレビューを準備中…</p>}>
                <VrmAvatarView avatar={avatar} expression={expression} name={name || 'プレビュー'} fallbackImage={costume?.image} onReady={handleReady} />
            </Suspense></div>
            {([
                ['scale', '拡大率', 0.5, 2, 0.05],
                ['offsetY', '上下位置', -0.5, 0.5, 0.01],
                ['rotation', '向き', -180, 180, 5],
            ] as const).map(([key, label, min, max, step]) => <label className="vrm-control" key={key}>
                <span>{label} <output>{avatar.framing[key]}</output></span>
                <input type="range" aria-label={label} min={min} max={max} step={step} value={avatar.framing[key]} onChange={(event) => setAvatar({ ...avatar, framing: { ...avatar.framing, [key]: Number(event.target.value) } })} />
            </label>)}
            <button type="button" className="btn btn-ghost" onClick={() => setAvatar({ ...avatar, framing: { ...DEFAULT_VRM_FRAMING } })}>表示位置をリセット</button>
            <details>
                <summary>表情の対応・プレビュー</summary>
                <p className="vrm-hint">会話で使う表情名とモデルの表情を対応させます。「通常顔」の項目はAIに渡しません。</p>
                <button type="button" className="btn btn-ghost" onClick={() => setExpression('neutral')}>通常顔を表示</button>
                {names.map((entry) => <div className="vrm-expression-row" key={entry}>
                    <span>{entry}</span>
                    <select className="input" aria-label={`${entry}に対応するVRM表情`} value={avatar.expressionMap[entry] ?? ''} onChange={(event) => {
                        setAvatar({ ...avatar, expressionMap: { ...avatar.expressionMap, [entry]: event.target.value } });
                        setExpression(entry);
                    }}>
                        <option value="">通常顔</option>
                        {available.map((target) => <option key={target} value={target}>{target}</option>)}
                    </select>
                    <button type="button" className="btn btn-ghost" aria-label={`${entry}の表情を確認`} onClick={() => setExpression(entry)}>確認</button>
                </div>)}
                <div className="vrm-expression-row">
                    <input className="input" aria-label="追加する表情名" placeholder="表情名を追加" value={customName} onChange={(event) => setCustomName(event.target.value)} />
                    <button type="button" className="btn btn-ghost" disabled={!customName.trim() || customName.trim().toLowerCase() === 'neutral'} onClick={() => {
                        setAvatar({ ...avatar, expressionMap: { ...avatar.expressionMap, [customName.trim()]: '' } });
                        setCustomName('');
                    }}>追加</button>
                </div>
            </details>
        </>}
        {error && <p role="alert" style={{ color: 'var(--error)' }}>{error}</p>}
        <div className="vrm-editor-actions">
            {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>キャンセル</button>}
            <button type="button" className="btn btn-primary" disabled={!ready || loading || !name.trim()} onClick={save}>{costume ? '調整を保存' : '3Dアバターを追加'}</button>
        </div>
    </div>;
}
