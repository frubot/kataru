import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Check, Copy, GitBranch, History, Loader2, Play, RefreshCw, Shirt, Square, Undo2, Volume2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Character } from '@/lib/store';
import type { VrmAvatar } from '@/lib/store/types';
import { stopTtsPlayback } from '@/lib/ttsPlayer';
import type { TtsPlaybackStatus } from '@/lib/ttsPlayer';
import { DEFAULT_COSTUME_NAME, findVisualNovelCostume } from '@/lib/visualNovelPresentation';
import type { VisualNovelCostumeOption } from '@/lib/visualNovelPresentation';
import { preloadVisualNovelImages } from '@/lib/visualNovelImagePreload';
import StoredImage from '../StoredImage';
import { useVisualNovelImagePreload } from './useVisualNovelImagePreload';
import WaitingEllipsis from './WaitingEllipsis';

const VrmAvatarView = lazy(() => import('../VrmAvatarView'));

export type VisualNovelStageSprite = {
    id: string;
    name: string;
    icon?: string;
    image: string | null;
    expression?: string | null;
    vrm?: VrmAvatar;
    vrmFallbackImage?: string | null;
    active: boolean;
    bounce: boolean;
};

const SPRITE_CROSSFADE_MS = 420;

function SpriteImage({ src, alt }: { src: string; alt: string }) {
    const [layers, setLayers] = useState(() => [{ key: 0, src }]);
    const nextLayerKey = useRef(1);

    useEffect(() => {
        setLayers((current) => (
            current[current.length - 1]?.src === src
                ? current
                : [...current.slice(-1), { key: nextLayerKey.current++, src }]
        ));
    }, [src]);

    useEffect(() => {
        if (layers.length <= 1) return;
        const timer = setTimeout(() => {
            setLayers((current) => current.slice(-1));
        }, SPRITE_CROSSFADE_MS);
        return () => clearTimeout(timer);
    }, [layers.length]);

    return (
        <div className="vn-sprite-stack">
            {layers.map((layer, index) => {
                const topmost = index === layers.length - 1;
                return (
                    <StoredImage
                        key={layer.key}
                        src={layer.src}
                        alt={topmost ? alt : ''}
                        aria-hidden={!topmost}
                        className={`vn-character-image ${topmost ? 'vn-sprite-img-in' : 'vn-sprite-img-out'}`}
                        loading="eager"
                        fetchPriority="high"
                    />
                );
            })}
        </div>
    );
}

type VisualNovelViewProps = {
    character: Character | null;
    fallbackCharacterName?: string;
    speakerName?: string;
    castCharacters?: Character[];
    stageSprites?: VisualNovelStageSprite[];
    stagePreloadSources?: string[];
    expressionImage: string | null;
    expression?: string | null;
    backgroundImage?: string;
    bounceActive: boolean;
    replySuggestions: ReactNode;
    hasReplySuggestions: boolean;
    isSummarizing: boolean;
    selectedCostumeName: string;
    costumeOptions: VisualNovelCostumeOption[];
    onSelectCostume: (costumeName: string) => void;
    showCostumeSelector?: boolean;
    onOpenLog: () => void;
    canEditLatestUserMessage: boolean;
    onEditLatestUserMessage: () => void;
    displayedMessageId?: string;
    displayedMessageContent?: string;
    isDisplayedMessageCopied: boolean;
    onCopyDisplayedMessage: () => void;
    autoPlay: boolean;
    onToggleAutoPlay: () => void;
    ttsStatus?: TtsPlaybackStatus | null;
    canTtsPlay?: boolean;
    onTtsToggle?: () => void;
    canRegenerate: boolean;
    onRegenerate: () => void;
    canBranch: boolean;
    onBranch: () => void;
    isWaitingForAssistant: boolean;
    dialogueContent: string;
    isTypewriterActive: boolean;
    dialogueAdvanceAvailable: boolean;
    showDialogueAdvanceIndicator: boolean;
    onAdvanceDialogue: () => void;
};

export default function VisualNovelView({
    character,
    fallbackCharacterName,
    speakerName,
    castCharacters,
    stageSprites,
    stagePreloadSources,
    expressionImage,
    expression,
    backgroundImage,
    bounceActive,
    replySuggestions,
    hasReplySuggestions,
    isSummarizing,
    selectedCostumeName,
    costumeOptions,
    onSelectCostume,
    showCostumeSelector = true,
    onOpenLog,
    canEditLatestUserMessage,
    onEditLatestUserMessage,
    displayedMessageId,
    displayedMessageContent,
    isDisplayedMessageCopied,
    onCopyDisplayedMessage,
    autoPlay,
    onToggleAutoPlay,
    ttsStatus,
    canTtsPlay,
    onTtsToggle,
    canRegenerate,
    onRegenerate,
    canBranch,
    onBranch,
    isWaitingForAssistant,
    dialogueContent,
    isTypewriterActive,
    dialogueAdvanceAvailable,
    showDialogueAdvanceIndicator,
    onAdvanceDialogue,
}: VisualNovelViewProps) {
    const [costumeMenuOpen, setCostumeMenuOpen] = useState(false);
    const costumeMenuRef = useRef<HTMLDivElement>(null);
    const dialogueBodyRef = useRef<HTMLDivElement>(null);
    const selectedCostume = findVisualNovelCostume(character, selectedCostumeName);
    const vrmAvatar = selectedCostume?.kind === 'vrm' ? selectedCostume.vrm : undefined;

    useVisualNovelImagePreload({
        character,
        costumeName: selectedCostumeName,
        currentImage: expressionImage,
        backgroundImage,
    });

    useEffect(() => {
        if (!stageSprites?.length) return;
        const visible = stageSprites.map((sprite) => sprite.image);
        return preloadVisualNovelImages(stagePreloadSources ?? [], visible);
    }, [stageSprites, stagePreloadSources]);

    useEffect(() => {
        if (!costumeMenuOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (target && costumeMenuRef.current?.contains(target)) return;
            setCostumeMenuOpen(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [costumeMenuOpen]);

    useEffect(() => {
        const dialogueBody = dialogueBodyRef.current;
        if (!dialogueBody) return;
        const frameId = requestAnimationFrame(() => {
            dialogueBody.scrollTop = dialogueBody.scrollHeight;
        });
        return () => cancelAnimationFrame(frameId);
    }, [dialogueContent]);

    const selectCostume = (costumeName: string) => {
        onSelectCostume(costumeName);
        setCostumeMenuOpen(false);
    };

    return (
        <div className={`vn-stage${hasReplySuggestions ? ' has-reply-suggestions' : ''}`}>
            <div className="vn-scene">
                {stageSprites && stageSprites.length > 0 ? (
                    <div className="vn-sprite-stage" aria-label="登場キャラクター">
                        {stageSprites.map((sprite, index) => (
                            <div
                                key={sprite.id}
                                className={`vn-sprite-slot ${sprite.active ? 'vn-sprite-lit' : 'vn-sprite-dim'}`}
                                style={{ '--vn-sprite-order': index } as CSSProperties}
                            >
                                <div className={`vn-sprite-figure ${sprite.vrm ? 'vn-sprite-3d' : ''} ${sprite.bounce ? 'vn-character-bounce' : ''}`}>
                                    {sprite.vrm ? (
                                        <Suspense fallback={sprite.image ? <StoredImage src={sprite.image} alt={sprite.name} className="vn-character-image" /> : <span>3D表示を準備中…</span>}>
                                            <VrmAvatarView
                                                avatar={sprite.vrm}
                                                expression={sprite.expression}
                                                name={sprite.name}
                                                fallbackImage={sprite.vrmFallbackImage ?? undefined}
                                                lipSync={sprite.active}
                                            />
                                        </Suspense>
                                    ) : sprite.image ? (
                                        <SpriteImage src={sprite.image} alt={sprite.name} />
                                    ) : (
                                        <div className="vn-character-placeholder">
                                            {sprite.icon ? (
                                                <StoredImage src={sprite.icon} alt={sprite.name} />
                                            ) : (
                                                <span>{sprite.name.charAt(0) || '?'}</span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : character ? (
                    <div className={`vn-character-wrap ${vrmAvatar ? 'vn-character-3d' : bounceActive ? 'vn-character-bounce' : ''}`}>
                        {vrmAvatar ? <Suspense fallback={expressionImage ? <StoredImage src={expressionImage} alt={character.name} className="vn-character-image" /> : <span>3D表示を準備中…</span>}>
                            <VrmAvatarView avatar={vrmAvatar} expression={expression} name={character.name} fallbackImage={selectedCostume?.image} interactive lipSync />
                        </Suspense> : expressionImage ? (
                            <SpriteImage src={expressionImage} alt={character.name} />
                        ) : (
                            <div className="vn-character-placeholder">
                                {character.icon ? (
                                    <StoredImage src={character.icon} alt={character.name} />
                                ) : (
                                    <span>{character.name.charAt(0) || '?'}</span>
                                )}
                            </div>
                        )}
                    </div>
                ) : castCharacters && castCharacters.length > 0 ? (
                    <div className="vn-cast" aria-label="参加キャラクター">
                        {castCharacters.map((castCharacter) => (
                            <div key={castCharacter.id} className="vn-cast-member">
                                <div className="vn-cast-avatar">
                                    {castCharacter.icon ? (
                                        <StoredImage src={castCharacter.icon} alt={castCharacter.name} />
                                    ) : (
                                        <span>{castCharacter.name.charAt(0) || '?'}</span>
                                    )}
                                </div>
                                <span>{castCharacter.name}</span>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="vn-character-wrap">
                        <div className="vn-character-placeholder">
                            <span>?</span>
                        </div>
                    </div>
                )}
            </div>

            {replySuggestions}
            <div className="vn-dialogue">
                <div className="vn-dialogue-topline">
                    <div className="vn-speaker">
                        {speakerName ?? character?.name ?? fallbackCharacterName ?? 'Character'}
                    </div>
                    <div className="vn-actions">
                        {isSummarizing && (
                            <div className="vn-status" title="古い会話を要約中">
                                <div className="spinner" />
                            </div>
                        )}
                        {showCostumeSelector && character && (
                            <div ref={costumeMenuRef} style={{ position: 'relative' }}>
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={() => setCostumeMenuOpen((open) => !open)}
                                    title={`衣装変更: ${selectedCostumeName}`}
                                    style={{ color: selectedCostumeName !== DEFAULT_COSTUME_NAME ? 'var(--accent-primary)' : undefined }}
                                    aria-haspopup="menu"
                                    aria-expanded={costumeMenuOpen}
                                >
                                    <Shirt size={15} />
                                </button>
                                {costumeMenuOpen && (
                                    <div
                                        role="menu"
                                        style={{
                                            position: 'absolute',
                                            right: 0,
                                            bottom: 'calc(100% + 0.5rem)',
                                            width: 240,
                                            maxHeight: 320,
                                            overflowY: 'auto',
                                            padding: 6,
                                            border: '1px solid var(--border-color)',
                                            borderRadius: 8,
                                            background: 'var(--bg-primary)',
                                            boxShadow: '0 12px 28px rgba(0,0,0,0.28)',
                                            zIndex: 20,
                                        }}
                                    >
                                        {costumeOptions.map((option) => {
                                            const active = option.name === selectedCostumeName;
                                            return (
                                                <button
                                                    key={option.name}
                                                    type="button"
                                                    role="menuitemradio"
                                                    aria-checked={active}
                                                    onClick={() => selectCostume(option.name)}
                                                    style={{
                                                        width: '100%',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: 8,
                                                        padding: '6px 8px',
                                                        border: 'none',
                                                        borderRadius: 6,
                                                        background: active ? 'var(--bg-tertiary)' : 'transparent',
                                                        color: 'var(--text-primary)',
                                                        cursor: 'pointer',
                                                        textAlign: 'left',
                                                    }}
                                                >
                                                    <span style={{
                                                        width: 30,
                                                        height: 42,
                                                        flexShrink: 0,
                                                        overflow: 'hidden',
                                                        borderRadius: 4,
                                                        border: '1px solid var(--border-color)',
                                                        background: 'var(--bg-secondary)',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                    }}>
                                                        {option.image ? (
                                                            <StoredImage src={option.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                        ) : (
                                                            <Shirt size={14} style={{ color: 'var(--text-muted)' }} />
                                                        )}
                                                    </span>
                                                    <span style={{ minWidth: 0, flex: 1 }}>
                                                        <span style={{ display: 'block', fontSize: '0.8125rem', fontWeight: active ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {option.name} <small>{option.kind === 'vrm' ? '3D' : '2D'}</small>
                                                        </span>
                                                        <span style={{ display: 'block', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                            表情 {option.expressionCount}件
                                                        </span>
                                                    </span>
                                                    {active && <Check size={14} style={{ flexShrink: 0, color: 'var(--accent-primary)' }} />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={onOpenLog}
                            title="会話ログを表示"
                            aria-label="会話ログを表示"
                        >
                            <History size={15} />
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={onEditLatestUserMessage}
                            disabled={!canEditLatestUserMessage}
                            title="直前の入力を編集"
                        >
                            <Undo2 size={15} />
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={onCopyDisplayedMessage}
                            disabled={!displayedMessageId || displayedMessageContent == null}
                            title="コピー"
                        >
                            {isDisplayedMessageCopied ? <Check size={15} /> : <Copy size={15} />}
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={onToggleAutoPlay}
                            aria-pressed={autoPlay}
                            style={{ color: autoPlay ? 'var(--accent-primary)' : undefined }}
                            title={autoPlay ? '自動再生を停止' : '自動再生'}
                            aria-label={autoPlay ? '自動再生を停止' : '自動再生'}
                        >
                            <Play size={15} />
                        </button>
                        {onTtsToggle && (
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => {
                                    if (ttsStatus === 'playing' || ttsStatus === 'loading') {
                                        stopTtsPlayback();
                                    } else {
                                        onTtsToggle();
                                    }
                                }}
                                disabled={!canTtsPlay && ttsStatus !== 'playing' && ttsStatus !== 'loading'}
                                style={{ color: ttsStatus === 'error' ? 'var(--error)' : undefined }}
                                title={
                                    ttsStatus === 'playing'
                                        ? '停止'
                                        : ttsStatus === 'loading'
                                            ? '生成中…'
                                            : 'このページを読み上げ'
                                }
                                aria-label={
                                    ttsStatus === 'playing'
                                        ? '停止'
                                        : ttsStatus === 'loading'
                                            ? '生成中…'
                                            : 'このページを読み上げ'
                                }
                            >
                                {ttsStatus === 'loading' ? (
                                    <Loader2 size={15} className="animate-spin" />
                                ) : ttsStatus === 'playing' ? (
                                    <Square size={15} />
                                ) : (
                                    <Volume2 size={15} />
                                )}
                            </button>
                        )}
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={onRegenerate}
                            disabled={!canRegenerate}
                            title="回答を再生成"
                        >
                            <RefreshCw size={15} />
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={onBranch}
                            disabled={!canBranch}
                            title="ここから会話を分岐"
                        >
                            <GitBranch size={15} />
                        </button>
                    </div>
                </div>
                <div className="vn-dialogue-rule" aria-hidden="true" />
                <div
                    ref={dialogueBodyRef}
                    className="vn-dialogue-body"
                    onClick={dialogueAdvanceAvailable ? onAdvanceDialogue : undefined}
                    title={isTypewriterActive ? '全文表示' : dialogueAdvanceAvailable ? '次へ' : undefined}
                    style={{ cursor: dialogueAdvanceAvailable ? 'pointer' : undefined }}
                >
                    {isWaitingForAssistant ? (
                        <WaitingEllipsis className="vn-waiting-ellipsis" />
                    ) : (
                        <ReactMarkdown>{dialogueContent}</ReactMarkdown>
                    )}
                </div>
                {showDialogueAdvanceIndicator && (
                    <span className="vn-dialogue-advance-indicator" aria-hidden="true" />
                )}
            </div>
        </div>
    );
}
