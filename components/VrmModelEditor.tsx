import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Pencil, Play, RotateCcw, Trash2 } from 'lucide-react';
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
    // One motion row at a time can open its option/name editor, keyed by name.
    const [editingMotion, setEditingMotion] = useState<string | null>(null);
    const [motionNameDraft, setMotionNameDraft] = useState('');
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
            setEditingMotion(null);
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
        if (removed && editingMotion === removed.name) setEditingMotion(null);
        onChange({
            ...avatar,
            animations: (avatar.animations ?? []).filter((_, position) => position !== index),
            // A removed idle motion falls back to the procedural idle animation.
            idleAnimation: removed && avatar.idleAnimation === removed.name ? undefined : avatar.idleAnimation,
        });
    };
    const commitMotionEdit = (animation: VrmAnimation) => {
        if (!avatar) return;
        const next = motionNameDraft.trim();
        const taken = (avatar.animations ?? []).some((entry) => entry !== animation && entry.name.toLowerCase() === next.toLowerCase());
        if (!next || taken) return;
        if (next !== animation.name) {
            // idleAnimation and chat triggers store the name, so move them across the rename.
            onChange({
                ...avatar,
                animations: (avatar.animations ?? []).map((entry) => entry === animation ? { ...entry, name: next } : entry),
                idleAnimation: avatar.idleAnimation === animation.name ? next : avatar.idleAnimation,
            });
            if (previewMotion?.name === animation.name) setPreviewMotion(null);
        }
        setEditingMotion(null);
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
                    <summary>
                        表情の対応・プレビュー
                        <button type="button" className="btn btn-ghost btn-icon vrm-summary-action" title="プレビューをリセット" aria-label="プレビューをリセット" onClick={(event) => { event.preventDefault(); setExpression('neutral'); }}><RotateCcw size={14} aria-hidden="true" /></button>
                    </summary>
                    {names.map((entry) => <div className="vrm-expression-row" key={entry}>
                        <span>{entry}</span>
                        <OptionSelector ariaLabel={`${entry}に対応するVRM表情`} value={avatar.expressionMap[entry] ?? ''} onChange={(target) => {
                            onChange({ ...avatar, expressionMap: { ...avatar.expressionMap, [entry]: target } });
                            setExpression(entry);
                        }} options={[
                            { value: '', label: 'デフォルト' },
                            ...available.map((target) => ({ value: target, label: target })),
                        ]} />
                        <button type="button" className="btn btn-ghost btn-icon" title="表情を確認" aria-label={`${entry}の表情を確認`} onClick={() => setExpression(entry)}><Play size={14} aria-hidden="true" /></button>
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
                        const editing = editingMotion === animation.name;
                        const draftName = motionNameDraft.trim();
                        const duplicate = editing && animations.some((entry) => entry !== animation && entry.name.toLowerCase() === draftName.toLowerCase());
                        const nameInvalid = draftName.length === 0 || duplicate;
                        return <div className="vrm-motion-row" key={animation.name}>
                            {editing ? <input
                                className="input vrm-motion-name-input"
                                aria-label="モーション名"
                                aria-invalid={nameInvalid}
                                value={motionNameDraft}
                                maxLength={64}
                                autoFocus
                                onChange={(event) => setMotionNameDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.nativeEvent.isComposing) return;
                                    if (event.key === 'Enter' && !nameInvalid) {
                                        event.preventDefault();
                                        commitMotionEdit(animation);
                                    } else if (event.key === 'Escape') {
                                        // Keep the key from bubbling into the modal's close handler.
                                        event.preventDefault();
                                        setEditingMotion(null);
                                    }
                                }}
                            /> : <span className="vrm-motion-name">{animation.name}</span>}
                            <button type="button" className="btn btn-ghost btn-icon" title="再生" aria-label={`${animation.name}を再生`} onClick={() => setPreviewMotion({ name: animation.name, nonce: String(++motionNonce.current) })}><Play size={14} aria-hidden="true" /></button>
                            {editing
                                ? <button type="button" className="btn btn-ghost btn-icon" title="完了" aria-label={`${animation.name}の編集を完了`} disabled={nameInvalid} onClick={() => commitMotionEdit(animation)}><Check size={14} aria-hidden="true" /></button>
                                : <button type="button" className="btn btn-ghost btn-icon" title="編集" aria-label={`${animation.name}の設定を編集`} onClick={() => { setEditingMotion(animation.name); setMotionNameDraft(animation.name); }}><Pencil size={14} aria-hidden="true" /></button>}
                            <button type="button" className="btn btn-ghost btn-icon" title="削除" aria-label={`${animation.name}を削除`} style={{ color: 'var(--error)' }} onClick={() => removeAnimation(index)}><Trash2 size={14} aria-hidden="true" /></button>
                            {editing && <>
                                <div className="vrm-motion-options">
                                    <label><input type="checkbox" checked={animation.loop ?? false} onChange={(event) => updateAnimation(index, { loop: event.target.checked })} />ループ</label>
                                    <label><input type="checkbox" checked={animation.useExpressions ?? false} onChange={(event) => updateAnimation(index, { useExpressions: event.target.checked })} />表情も再生</label>
                                    <label><input type="radio" name={idleGroup} checked={idleName === animation.name} onChange={() => onChange({ ...avatar, idleAnimation: animation.name })} />待機モーションに設定</label>
                                </div>
                                {duplicate && <span className="vrm-motion-error">同じ名前のモーションがあります</span>}
                            </>}
                            {issue && <span className="vrm-motion-error" title={issue}>読み込みエラー</span>}
                        </div>;
                    })}
                </details>
            </>}
        </div>
    </>;
}
