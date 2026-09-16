import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { VrmAvatar } from '@/lib/store/types';
import { createVrmExpressionMap, DEFAULT_VRM_FRAMING, readVrmFile } from '@/lib/vrm';
import type { VrmPreview } from './VrmAvatarView';

const VrmAvatarView = lazy(() => import('./VrmAvatarView'));

/** Shared VRM editor body: file picker, framed preview and expression mapping.
 *  The parent owns the avatar state and the confirm/cancel actions. */
export default function VrmModelEditor({ avatar, name, fallbackImage, expressionNames = [], onChange, onReady, onError, onLoadingChange }: {
    avatar: VrmAvatar | undefined;
    name: string;
    fallbackImage?: string;
    /** 2D expression names offered as mapping targets alongside the saved map keys. */
    expressionNames?: string[];
    onChange: (avatar: VrmAvatar) => void;
    onReady?: (preview: VrmPreview | null) => void;
    onError?: (message: string) => void;
    onLoadingChange?: (loading: boolean) => void;
}) {
    const [available, setAvailable] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [expression, setExpression] = useState('neutral');
    const [customName, setCustomName] = useState('');
    const fileInput = useRef<HTMLInputElement>(null);
    const generation = useRef(0);
    // An in-flight file read must not revive the editor after the parent unmounts it.
    useEffect(() => () => { generation.current += 1; }, []);
    const setBusy = (value: boolean) => {
        setLoading(value);
        onLoadingChange?.(value);
    };
    const handleReady = useCallback((value: VrmPreview | null) => {
        onReady?.(value);
        if (value) {
            setAvailable(value.expressions);
            if (avatar && Object.keys(avatar.expressionMap).length === 0) {
                onChange({ ...avatar, expressionMap: createVrmExpressionMap(value.expressions) });
            }
        }
    }, [avatar, onChange, onReady]);
    const selectFile = async (file?: File) => {
        if (!file) return;
        const request = ++generation.current;
        onError?.('');
        setBusy(true);
        try {
            const next = await readVrmFile(file);
            if (request !== generation.current) return;
            setAvailable([]);
            setExpression('neutral');
            setCustomName('');
            onReady?.(null);
            onChange(next);
        } catch (reason) {
            onError?.(reason instanceof Error ? reason.message : '読み込みに失敗しました。');
        } finally { if (request === generation.current) setBusy(false); }
    };
    const names = Array.from(new Set([...Object.keys(avatar?.expressionMap ?? {}), ...expressionNames.filter((entry) => entry !== 'neutral')]));
    return <>
        <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => fileInput.current?.click()}>{avatar ? 'VRMファイルを変更' : 'VRMファイルを選択'}</button>
        <input ref={fileInput} type="file" accept=".vrm" disabled={loading} onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} style={{ display: 'none' }} />
        <p className="vrm-hint">VRM 0.x / 1.0、50MBまで。モデルはこの端末に保存されます。</p>
        {loading && <p role="status">ファイルを読み込み中…</p>}
        {avatar && <>
            <div className="vrm-preview"><Suspense fallback={<p>プレビューを準備中…</p>}>
                <VrmAvatarView avatar={avatar} expression={expression} name={name || 'プレビュー'} fallbackImage={fallbackImage} onReady={handleReady} />
            </Suspense></div>
            {([
                ['scale', '拡大率', 0.5, 2, 0.05],
                ['offsetY', '上下位置', -0.5, 0.5, 0.01],
                ['rotation', '向き', -180, 180, 5],
            ] as const).map(([key, label, min, max, step]) => <label className="vrm-control" key={key}>
                <span>{label} <output>{avatar.framing[key]}</output></span>
                <input type="range" aria-label={label} min={min} max={max} step={step} value={avatar.framing[key]} onChange={(event) => onChange({ ...avatar, framing: { ...avatar.framing, [key]: Number(event.target.value) } })} />
            </label>)}
            <button type="button" className="btn btn-ghost" onClick={() => onChange({ ...avatar, framing: { ...DEFAULT_VRM_FRAMING } })}>表示位置をリセット</button>
            <details>
                <summary>表情の対応・プレビュー</summary>
                <p className="vrm-hint">会話で使う表情名とモデルの表情を対応させます。「通常顔」の項目はAIに渡しません。</p>
                <button type="button" className="btn btn-ghost" onClick={() => setExpression('neutral')}>通常顔を表示</button>
                {names.map((entry) => <div className="vrm-expression-row" key={entry}>
                    <span>{entry}</span>
                    <select className="input" aria-label={`${entry}に対応するVRM表情`} value={avatar.expressionMap[entry] ?? ''} onChange={(event) => {
                        onChange({ ...avatar, expressionMap: { ...avatar.expressionMap, [entry]: event.target.value } });
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
                        onChange({ ...avatar, expressionMap: { ...avatar.expressionMap, [customName.trim()]: '' } });
                        setCustomName('');
                    }}>追加</button>
                </div>
            </details>
        </>}
    </>;
}
