import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { VrmAnimation, VrmAvatar } from '@/lib/store/types';
import { createVrmExpressionMap, DEFAULT_VRM_FRAMING, readVrmFile, readVrmaFile } from '@/lib/vrm';
import type { VrmPreview } from './VrmAvatarView';
import OptionSelector from './OptionSelector';

const VrmAvatarView = lazy(() => import('./VrmAvatarView'));

/** Shared VRM editor body: file picker, framed preview and expression mapping.
 *  Renders a preview pane and a controls pane; the surrounding layout decides
 *  whether they stack (inline editors) or sit side by side (VrmEditorModal).
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
    const [previewMotion, setPreviewMotion] = useState<{ name: string; nonce: string } | null>(null);
    const [previewMotions, setPreviewMotions] = useState<{ name: string; error: string | null }[]>([]);
    const fileInput = useRef<HTMLInputElement>(null);
    const vrmaInput = useRef<HTMLInputElement>(null);
    const generation = useRef(0);
    const motionNonce = useRef(0);
    const idleGroup = useId();
    // An in-flight file read must not revive the editor after the parent unmounts it.
    useEffect(() => () => { generation.current += 1; }, []);
    const setBusy = (value: boolean) => {
        setLoading(value);
        onLoadingChange?.(value);
    };
    const handleReady = useCallback((value: VrmPreview | null) => {
        onReady?.(value);
        // The view reports one entry per registered motion, flagging load failures.
        setPreviewMotions(value?.motions ?? []);
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
            setPreviewMotion(null);
            setPreviewMotions([]);
            onReady?.(null);
            onChange(next);
        } catch (reason) {
            onError?.(reason instanceof Error ? reason.message : '読み込みに失敗しました。');
        } finally { if (request === generation.current) setBusy(false); }
    };
    const selectMotion = async (file?: File) => {
        if (!file || !avatar) return;
        const request = ++generation.current;
        onError?.('');
        setBusy(true);
        try {
            const animation = await readVrmaFile(file);
            if (request !== generation.current) return;
            // Motion names double as chat triggers and the idle pick, so keep them unique.
            const taken = new Set((avatar.animations ?? []).map((entry) => entry.name.toLowerCase()));
            const base = animation.name.trim() || 'モーション';
            let name = base;
            for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) name = `${base} (${suffix})`;
            onChange({ ...avatar, animations: [...(avatar.animations ?? []), { ...animation, name }] });
        } catch (reason) {
            onError?.(reason instanceof Error ? reason.message : '読み込みに失敗しました。');
        } finally { if (request === generation.current) setBusy(false); }
    };
    const updateAnimation = (index: number, patch: Partial<VrmAnimation>) => {
        if (!avatar) return;
        onChange({ ...avatar, animations: (avatar.animations ?? []).map((entry, position) => position === index ? { ...entry, ...patch } : entry) });
    };
    const removeAnimation = (index: number) => {
        if (!avatar) return;
        const removed = avatar.animations?.[index];
        onChange({
            ...avatar,
            animations: (avatar.animations ?? []).filter((_, position) => position !== index),
            // A removed idle motion falls back to the procedural idle animation.
            idleAnimation: removed && avatar.idleAnimation === removed.name ? undefined : avatar.idleAnimation,
        });
    };
    const names = Array.from(new Set([...Object.keys(avatar?.expressionMap ?? {}), ...expressionNames.filter((entry) => entry !== 'neutral')]));
    const animations = avatar?.animations ?? [];
    // A dangling idle reference (e.g. an older save) shows as the standard idle.
    const idleName = animations.some((entry) => entry.name === avatar?.idleAnimation) ? avatar?.idleAnimation : undefined;
    return <>
        {avatar && <div className="vrm-editor-preview">
            <div className="vrm-preview"><Suspense fallback={<p>プレビューを準備中…</p>}>
                <VrmAvatarView avatar={avatar} expression={expression} motion={previewMotion} name={name || 'プレビュー'} fallbackImage={fallbackImage} interactive onReady={handleReady} />
            </Suspense></div>
        </div>}
        <div className="vrm-editor-controls">
            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => fileInput.current?.click()}>{avatar ? 'VRMファイルを変更' : 'VRMファイルを選択'}</button>
            <input ref={fileInput} type="file" accept=".vrm" disabled={loading} onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} style={{ display: 'none' }} />
            <p className="vrm-hint">VRM 0.x / 1.0、50MBまで。</p>
            {loading && <p role="status">読み込み中…</p>}
            {avatar && <>
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
                    <button type="button" className="btn btn-ghost" onClick={() => setExpression('neutral')}>プレビューをリセット</button>
                    {names.map((entry) => <div className="vrm-expression-row" key={entry}>
                        <span>{entry}</span>
                        <OptionSelector ariaLabel={`${entry}に対応するVRM表情`} value={avatar.expressionMap[entry] ?? ''} onChange={(target) => {
                            onChange({ ...avatar, expressionMap: { ...avatar.expressionMap, [entry]: target } });
                            setExpression(entry);
                        }} options={[
                            { value: '', label: 'デフォルト' },
                            ...available.map((target) => ({ value: target, label: target })),
                        ]} />
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
                <details>
                    <summary>モーション</summary>
                    <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => vrmaInput.current?.click()}>VRMAファイルを追加</button>
                    <input ref={vrmaInput} type="file" accept=".vrma" disabled={loading} onChange={(event) => { void selectMotion(event.target.files?.[0]); event.target.value = ''; }} style={{ display: 'none' }} />
                    {animations.length > 0 && <div className="vrm-motion-row">
                        <label><input type="radio" name={idleGroup} checked={idleName === undefined} onChange={() => onChange({ ...avatar, idleAnimation: undefined })} />デフォルトの待機モーションを使用する</label>
                    </div>}
                    {animations.map((animation, index) => {
                        const issue = previewMotions.find((entry) => entry.name === animation.name)?.error;
                        return <div className="vrm-motion-row" key={animation.name}>
                            <span className="vrm-motion-name">{animation.name}</span>
                            <label><input type="checkbox" checked={animation.loop ?? false} onChange={(event) => updateAnimation(index, { loop: event.target.checked })} />ループ</label>
                            <label><input type="checkbox" checked={animation.useExpressions ?? false} onChange={(event) => updateAnimation(index, { useExpressions: event.target.checked })} />表情も再生</label>
                            <button type="button" className="btn btn-ghost" aria-label={`${animation.name}を再生`} onClick={() => setPreviewMotion({ name: animation.name, nonce: String(++motionNonce.current) })}>再生</button>
                            <label><input type="radio" name={idleGroup} checked={idleName === animation.name} onChange={() => onChange({ ...avatar, idleAnimation: animation.name })} />待機モーションに設定</label>
                            <button type="button" className="btn btn-ghost" aria-label={`${animation.name}を削除`} onClick={() => removeAnimation(index)}>削除</button>
                            {issue && <span className="vrm-motion-error" title={issue}>読み込みエラー</span>}
                        </div>;
                    })}
                </details>
            </>}
        </div>
    </>;
}
