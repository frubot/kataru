import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy, GitBranch, RefreshCw, Shirt, Undo2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Character } from '@/lib/store';
import { DEFAULT_COSTUME_NAME } from '@/lib/visualNovelPresentation';
import type { VisualNovelCostumeOption } from '@/lib/visualNovelPresentation';
import StoredImage from '../StoredImage';
import { useVisualNovelImagePreload } from './useVisualNovelImagePreload';
import WaitingEllipsis from './WaitingEllipsis';

type VisualNovelViewProps = {
    character: Character | null;
    fallbackCharacterName?: string;
    speakerName?: string;
    castCharacters?: Character[];
    expressionImage: string | null;
    bounceActive: boolean;
    onCharacterImageLoad: () => void;
    replySuggestions: ReactNode;
    hasReplySuggestions: boolean;
    isSummarizing: boolean;
    selectedCostumeName: string;
    costumeOptions: VisualNovelCostumeOption[];
    onSelectCostume: (costumeName: string) => void;
    showCostumeSelector?: boolean;
    canEditLatestUserMessage: boolean;
    onEditLatestUserMessage: () => void;
    displayedMessageId?: string;
    displayedMessageContent?: string;
    isDisplayedMessageCopied: boolean;
    onCopyDisplayedMessage: () => void;
    canRegenerate: boolean;
    onRegenerate: () => void;
    canBranch: boolean;
    onBranch: () => void;
    isWaitingForAssistant: boolean;
    dialogueContent: string;
    plainStreamingContent?: string;
    isTypewriterActive: boolean;
    dialogueAdvanceAvailable: boolean;
    onAdvanceDialogue: () => void;
};

export default function VisualNovelView({
    character,
    fallbackCharacterName,
    speakerName,
    castCharacters,
    expressionImage,
    bounceActive,
    onCharacterImageLoad,
    replySuggestions,
    hasReplySuggestions,
    isSummarizing,
    selectedCostumeName,
    costumeOptions,
    onSelectCostume,
    showCostumeSelector = true,
    canEditLatestUserMessage,
    onEditLatestUserMessage,
    displayedMessageId,
    displayedMessageContent,
    isDisplayedMessageCopied,
    onCopyDisplayedMessage,
    canRegenerate,
    onRegenerate,
    canBranch,
    onBranch,
    isWaitingForAssistant,
    dialogueContent,
    plainStreamingContent,
    isTypewriterActive,
    dialogueAdvanceAvailable,
    onAdvanceDialogue,
}: VisualNovelViewProps) {
    const [costumeMenuOpen, setCostumeMenuOpen] = useState(false);
    const costumeMenuRef = useRef<HTMLDivElement>(null);
    const dialogueBodyRef = useRef<HTMLDivElement>(null);

    useVisualNovelImagePreload({
        character,
        costumeName: selectedCostumeName,
        currentImage: expressionImage,
    });

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
    }, [dialogueContent, plainStreamingContent]);

    const selectCostume = (costumeName: string) => {
        onSelectCostume(costumeName);
        setCostumeMenuOpen(false);
    };

    return (
        <div className={`vn-stage${hasReplySuggestions ? ' has-reply-suggestions' : ''}`}>
            <div className="vn-scene">
                {character ? (
                    <div className={`vn-character-wrap ${bounceActive ? 'vn-character-bounce' : ''}`}>
                        {expressionImage ? (
                            <StoredImage
                                src={expressionImage}
                                alt={character.name}
                                className="vn-character-image"
                                onLoad={onCharacterImageLoad}
                            />
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
                                                            {option.name}
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
                    ) : plainStreamingContent != null ? (
                        <div
                            className="vn-streaming-preview"
                            role="status"
                            aria-live="polite"
                            style={{ whiteSpace: 'pre-wrap' }}
                        >
                            {plainStreamingContent}
                        </div>
                    ) : (
                        <ReactMarkdown>{dialogueContent}</ReactMarkdown>
                    )}
                </div>
            </div>
        </div>
    );
}
