import { useEffect, useRef, useState } from 'react';
import {
    Brain,
    Bug,
    Check,
    ChevronDown,
    Gamepad2,
    HatGlasses,
    Menu,
    MessageSquare,
    MessagesSquare,
    SquarePen,
} from 'lucide-react';
import type { Room } from '@/lib/store';

type RoomViewMode = NonNullable<Room['viewMode']>;

const CHAT_MODE_OPTIONS: { value: RoomViewMode; label: string; description: string }[] = [
    { value: 'chat', label: 'ベーシック', description: 'キャラクターと話す' },
    { value: 'message', label: 'メッセージ', description: 'メッセージアプリのような会話' },
    { value: 'vn', label: 'ゲーム', description: 'ノベルゲームのような体験' },
];

function getRoomViewModeLabel(viewMode: RoomViewMode): string {
    return CHAT_MODE_OPTIONS.find((option) => option.value === viewMode)?.label ?? 'ベーシック';
}

function renderRoomViewModeIcon(viewMode: RoomViewMode, size = 18) {
    if (viewMode === 'message') return <MessagesSquare size={size} />;
    if (viewMode === 'vn') return <Gamepad2 size={size} />;
    return <MessageSquare size={size} />;
}

type ChatHeaderProps = {
    roomId: string;
    roomName: string;
    subtitle?: string;
    isMobile: boolean;
    onOpenSidebar: () => void;
    debugEnabled: boolean;
    debugLogCount: number;
    onOpenDebug: () => void;
    showMemoryButton: boolean;
    onOpenMemory: () => void;
    showSecretModeButton: boolean;
    isSecretMode: boolean;
    isRoomEmpty: boolean;
    onToggleSecretMode: () => void;
    onStartNewChat?: () => void;
    newChatTitle?: string;
    showViewModeSelector: boolean;
    allowVisualNovelMode: boolean;
    currentViewMode: RoomViewMode;
    onChangeViewMode: (viewMode: RoomViewMode) => void;
    disabled: boolean;
};

export default function ChatHeader({
    roomId,
    roomName,
    subtitle,
    isMobile,
    onOpenSidebar,
    debugEnabled,
    debugLogCount,
    onOpenDebug,
    showMemoryButton,
    onOpenMemory,
    showSecretModeButton,
    isSecretMode,
    isRoomEmpty,
    onToggleSecretMode,
    onStartNewChat,
    newChatTitle,
    showViewModeSelector,
    allowVisualNovelMode,
    currentViewMode,
    onChangeViewMode,
    disabled,
}: ChatHeaderProps) {
    const [modeMenuOpen, setModeMenuOpen] = useState(false);
    const modeMenuRef = useRef<HTMLDivElement>(null);
    const modeLabel = getRoomViewModeLabel(currentViewMode);
    const modeOptions = allowVisualNovelMode
        ? CHAT_MODE_OPTIONS
        : CHAT_MODE_OPTIONS.filter((option) => option.value !== 'vn');

    useEffect(() => {
        setModeMenuOpen(false);
    }, [roomId, allowVisualNovelMode]);

    useEffect(() => {
        if (!modeMenuOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (target && modeMenuRef.current?.contains(target)) return;
            setModeMenuOpen(false);
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [modeMenuOpen]);

    const selectViewMode = (viewMode: RoomViewMode) => {
        onChangeViewMode(viewMode);
        setModeMenuOpen(false);
    };

    return (
        <div className="chat-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
                {isMobile && (
                    <button
                        type="button"
                        className="btn btn-ghost mobile-sidebar-trigger"
                        onClick={onOpenSidebar}
                        style={{ padding: '0.5rem', flexShrink: 0 }}
                        title="サイドバーを開く"
                        aria-label="サイドバーを開く"
                    >
                        <Menu size={20} />
                    </button>
                )}
                <div style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}>
                    <h2 style={{ fontSize: '1rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {roomName}
                    </h2>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {subtitle}
                    </p>
                </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                {debugEnabled && (
                    <button type="button" className="btn btn-ghost" onClick={onOpenDebug} title="デバッグログを表示">
                        <Bug size={18} />
                        <span className="desktop-only" style={{ fontSize: '0.75rem' }}>
                            {debugLogCount}
                        </span>
                    </button>
                )}
                {showMemoryButton && (
                    <button type="button" className="btn btn-ghost" onClick={onOpenMemory} title="メモリを表示">
                        <Brain size={18} />
                    </button>
                )}
                {showSecretModeButton && (
                    <button
                        type="button"
                        className={`btn btn-ghost secret-mode-button ${isSecretMode ? 'active' : ''}`}
                        onClick={onToggleSecretMode}
                        disabled={disabled}
                        aria-pressed={isSecretMode}
                        title={
                            isSecretMode
                                ? (isRoomEmpty ? 'シークレットモードを解除' : 'シークレットモードで会話中です。会話履歴とメモリには保存されません')
                                : 'シークレットモードでチャットを開始'
                        }
                        aria-label={
                            isSecretMode
                                ? (isRoomEmpty ? 'シークレットモードを解除' : 'シークレットモードで会話中')
                                : 'シークレットモードでチャットを開始'
                        }
                    >
                        <HatGlasses size={18} />
                    </button>
                )}
                {onStartNewChat && (
                    <button
                        type="button"
                        className="btn btn-ghost mobile-only"
                        onClick={onStartNewChat}
                        disabled={disabled}
                        title={newChatTitle ?? `${modeLabel}モードで新しいチャットを開始`}
                    >
                        <SquarePen size={18} />
                    </button>
                )}
                {showViewModeSelector && (
                    <div ref={modeMenuRef} className="chat-mode-selector">
                        <button
                            type="button"
                            className="btn btn-ghost chat-mode-trigger"
                            onClick={() => setModeMenuOpen((open) => !open)}
                            disabled={disabled}
                            title={`表示モード: ${modeLabel}`}
                            aria-haspopup="menu"
                            aria-expanded={modeMenuOpen}
                            style={{ color: currentViewMode !== 'chat' ? 'var(--accent-primary)' : undefined }}
                        >
                            {renderRoomViewModeIcon(currentViewMode)}
                            <span className="desktop-only">{modeLabel}</span>
                            <ChevronDown size={14} />
                        </button>
                        {modeMenuOpen && (
                            <div className="chat-mode-menu" role="menu" aria-label="表示モード">
                                {modeOptions.map((option) => {
                                    const active = option.value === currentViewMode;
                                    return (
                                        <button
                                            key={option.value}
                                            type="button"
                                            role="menuitemradio"
                                            aria-checked={active}
                                            className={`chat-mode-menu-item ${active ? 'active' : ''}`}
                                            onClick={() => selectViewMode(option.value)}
                                        >
                                            {renderRoomViewModeIcon(option.value, 16)}
                                            <span className="chat-mode-menu-copy">
                                                <span className="chat-mode-menu-label">{option.label}</span>
                                                <span className="chat-mode-menu-description">{option.description}</span>
                                            </span>
                                            {active && <Check size={14} className="chat-mode-menu-check" />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
