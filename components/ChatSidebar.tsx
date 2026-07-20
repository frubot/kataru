import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, MessageSquare, Settings, Trash2, ChevronDown, ChevronRight, User, Users, Copy, EllipsisVertical, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { useStore, Character, Situation, resolveSituationParticipants } from '@/lib/store';
import StoredImage from './StoredImage';
import SituationSettingsModal from './SituationSettingsModal';
import SidebarSearchDialog, { type SidebarSearchResult } from './SidebarSearchDialog';

type SidebarContextMenu =
    | { type: 'character'; characterId: string; x: number; y: number }
    | { type: 'character-actions'; characterId: string; x: number; y: number }
    | { type: 'situation'; groupId: string; x: number; y: number }
    | { type: 'room'; roomId: string; x: number; y: number };

type SidebarContextMenuTarget =
    | { type: 'character'; characterId: string }
    | { type: 'situation'; groupId: string }
    | { type: 'room'; roomId: string };

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_ITEM_HEIGHT = 36;
const CONTEXT_MENU_VERTICAL_PADDING = 8;
const CONTEXT_MENU_MARGIN = 8;

function getContextMenuHeight(type: SidebarContextMenu['type']) {
    const itemCount = type === 'character' ? 4 : type === 'character-actions' ? 2 : type === 'situation' ? 3 : 1;
    return itemCount * CONTEXT_MENU_ITEM_HEIGHT + CONTEXT_MENU_VERTICAL_PADDING;
}

function clampContextMenuPosition(value: number, size: number, viewportSize: number) {
    const max = Math.max(CONTEXT_MENU_MARGIN, viewportSize - size - CONTEXT_MENU_MARGIN);
    return Math.min(Math.max(value, CONTEXT_MENU_MARGIN), max);
}

function SidebarContextMenuItem({ icon, label, danger = false, onClick }: { icon: ReactNode; label: string; danger?: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            role="menuitem"
            className={`sidebar-context-menu-item ${danger ? 'danger' : ''}`}
            onClick={onClick}
        >
            {icon}
            <span>{label}</span>
        </button>
    );
}

function GroupAvatarStack({ chars }: { chars: { icon?: string; name: string }[] }) {
    const visible = chars.slice(0, 3);
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
            {visible.map((c, i) => {
                const faded = i === 2;
                const style: React.CSSProperties = {
                    width: '13px',
                    height: '13px',
                    borderRadius: '50%',
                    flexShrink: 0,
                    opacity: faded ? 0.4 : 1,
                };
                if (c.icon) {
                    return <StoredImage key={i} src={c.icon} alt={c.name} style={{ ...style, objectFit: 'cover' }} />;
                }
                return (
                    <div key={i} style={{
                        ...style,
                        background: 'var(--accent-primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '7px',
                        color: 'white',
                        fontWeight: 600,
                    }}>
                        {c.name.charAt(0)}
                    </div>
                );
            })}
        </div>
    );
}

interface ChatSidebarProps {
    onOpenSettings: () => void;
    onOpenCharacterSettings: (character: Character | null, isNew: boolean) => void;
    isOpen: boolean;
    isDesktopOpen: boolean;
    onClose: () => void;
    onToggleDesktop: () => void;
}

export default function ChatSidebar({ onOpenSettings, onOpenCharacterSettings, isOpen, isDesktopOpen, onClose, onToggleDesktop }: ChatSidebarProps) {
    const { characters, groups, rooms, currentRoomId, createRoom, createRoomForSituation, setCurrentRoom, deleteRoom, deleteSituation, deleteCharacter, duplicateCharacter, defaultChatModel } = useStore();
    const [expandedCharacters, setExpandedCharacters] = useState<Set<string>>(new Set());
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(groups.map((g) => g.id)));
    const [situationSettingsOpen, setSituationSettingsOpen] = useState(false);
    const [editingSituation, setEditingSituation] = useState<Situation | null>(null);
    const [groupExpanded, setGroupExpanded] = useState(true);
    const [charactersExpanded, setCharactersExpanded] = useState(true);
    const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [revealedItem, setRevealedItem] = useState<{ type: 'character' | 'situation'; id: string } | null>(null);
    const sidebarItemRefs = useRef(new Map<string, HTMLDivElement>());

    useEffect(() => {
        if (!contextMenu) return;

        const closeMenu = () => setContextMenu(null);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeMenu();
        };

        window.addEventListener('click', closeMenu);
        window.addEventListener('resize', closeMenu);
        window.addEventListener('scroll', closeMenu, true);
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('click', closeMenu);
            window.removeEventListener('resize', closeMenu);
            window.removeEventListener('scroll', closeMenu, true);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [contextMenu]);

    useEffect(() => {
        if (!revealedItem || !isDesktopOpen) return;

        const frame = requestAnimationFrame(() => {
            const item = sidebarItemRefs.current.get(`${revealedItem.type}:${revealedItem.id}`);
            item?.scrollIntoView({ block: 'nearest' });
            setRevealedItem(null);
        });

        return () => cancelAnimationFrame(frame);
    }, [charactersExpanded, collapsedGroups, groupExpanded, isDesktopOpen, revealedItem]);

    const openContextMenu = (event: React.MouseEvent, menu: SidebarContextMenuTarget) => {
        event.preventDefault();
        event.stopPropagation();

        const menuHeight = getContextMenuHeight(menu.type);
        const position = {
            x: clampContextMenuPosition(event.clientX, CONTEXT_MENU_WIDTH, window.innerWidth),
            y: clampContextMenuPosition(event.clientY, menuHeight, window.innerHeight),
        };

        if (menu.type === 'character') {
            setContextMenu({ type: 'character', characterId: menu.characterId, ...position });
        } else if (menu.type === 'situation') {
            setContextMenu({ type: 'situation', groupId: menu.groupId, ...position });
        } else {
            setContextMenu({ type: 'room', roomId: menu.roomId, ...position });
        }
    };

    const runContextMenuAction = (action: () => void) => {
        setContextMenu(null);
        action();
    };

    const openCharacterActionsMenu = (event: React.MouseEvent<HTMLButtonElement>, characterId: string) => {
        event.preventDefault();
        event.stopPropagation();

        if (contextMenu?.type === 'character-actions' && contextMenu.characterId === characterId) {
            setContextMenu(null);
            return;
        }

        const rect = event.currentTarget.getBoundingClientRect();
        const menuHeight = getContextMenuHeight('character-actions');
        setContextMenu({
            type: 'character-actions',
            characterId,
            x: clampContextMenuPosition(rect.right - CONTEXT_MENU_WIDTH, CONTEXT_MENU_WIDTH, window.innerWidth),
            y: clampContextMenuPosition(rect.bottom + 4, menuHeight, window.innerHeight),
        });
    };

    const toggleCharacterExpand = (characterId: string) => {
        setExpandedCharacters((prev) => {
            const next = new Set(prev);
            if (next.has(characterId)) {
                next.delete(characterId);
            } else {
                next.add(characterId);
            }
            return next;
        });
    };

    const toggleGroupExpand = (groupId: string) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
            }
            return next;
        });
    };

    const handleRoomSelect = (roomId: string) => {
        setCurrentRoom(roomId);
        onClose();
    };

    const createCharacterRoom = (characterId: string) => {
        createRoom(characterId);
        setExpandedCharacters((prev) => new Set(prev).add(characterId));
    };

    const handleCreateRoom = (e: React.MouseEvent, characterId: string) => {
        e.stopPropagation();
        createCharacterRoom(characterId);
    };

    const deleteCharacterWithConfirmation = (characterId: string) => {
        if (confirm('このキャラクターと関連するすべてのチャットを削除しますか？')) {
            deleteCharacter(characterId);
        }
    };

    const duplicateCharacterById = (characterId: string) => {
        duplicateCharacter(characterId);
    };

    const openCharacterSettings = (character: Character) => {
        onOpenCharacterSettings(character, false);
    };

    const createSituationRoom = (groupId: string) => {
        createRoomForSituation(groupId);
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            next.delete(groupId);
            return next;
        });
    };

    const handleCreateRoomForGroup = (e: React.MouseEvent, groupId: string) => {
        e.stopPropagation();
        createSituationRoom(groupId);
    };

    const handleCreateSituation = () => {
        setEditingSituation(null);
        setSituationSettingsOpen(true);
    };

    const openSituationSettings = (group: Situation) => {
        setEditingSituation(group);
        setSituationSettingsOpen(true);
    };

    const handleEditGroup = (e: React.MouseEvent, group: Situation) => {
        e.stopPropagation();
        openSituationSettings(group);
    };

    const deleteSituationWithConfirmation = (groupId: string, groupName: string) => {
        if (confirm(`シチュエーション「${groupName}」と関連するすべてのチャットを削除しますか？`)) {
            deleteSituation(groupId);
        }
    };

    const handleDeleteGroup = (e: React.MouseEvent, groupId: string, groupName: string) => {
        e.stopPropagation();
        deleteSituationWithConfirmation(groupId, groupName);
    };

    const handleCloseSituationSettings = () => {
        setSituationSettingsOpen(false);
        setEditingSituation(null);
    };

    const handleSearchSelect = (result: SidebarSearchResult) => {
        setSearchOpen(false);

        if (result.type === 'room') {
            handleRoomSelect(result.item.id);
            return;
        }

        if (result.type === 'character') {
            setCharactersExpanded(true);
            setExpandedCharacters((current) => new Set(current).add(result.item.id));
        } else {
            setGroupExpanded(true);
            setCollapsedGroups((current) => {
                const next = new Set(current);
                next.delete(result.item.id);
                return next;
            });
        }

        setRevealedItem({ type: result.type, id: result.item.id });
        if (!isDesktopOpen) onToggleDesktop();
    };

    const visibleRooms = rooms.filter((room) => !room.isDraft && room.secretMode !== true);

    const sortedGroups = [...groups].sort((a, b) => {
        const latestA = Math.max(a.updatedAt, ...visibleRooms.filter((r) => r.groupId === a.id).map((r) => r.updatedAt));
        const latestB = Math.max(b.updatedAt, ...visibleRooms.filter((r) => r.groupId === b.id).map((r) => r.updatedAt));
        return latestB - latestA;
    });

    const sortedCharacters = [...characters].sort((a, b) => b.updatedAt - a.updatedAt);
    const DesktopSidebarIcon = isDesktopOpen ? PanelLeftClose : PanelLeftOpen;
    const desktopSidebarTitle = isDesktopOpen ? 'サイドバーを折りたたむ' : 'サイドバーを開く';
    const editingSituationRoom = editingSituation
        ? rooms.find((room) => room.id === currentRoomId && room.groupId === editingSituation.id) ?? null
        : null;
    const contextMenuCharacter = contextMenu?.type === 'character' || contextMenu?.type === 'character-actions'
        ? characters.find((character) => character.id === contextMenu.characterId) ?? null
        : null;
    const contextMenuSituation = contextMenu?.type === 'situation'
        ? groups.find((group) => group.id === contextMenu.groupId) ?? null
        : null;
    const contextMenuRoom = contextMenu?.type === 'room'
        ? rooms.find((room) => room.id === contextMenu.roomId) ?? null
        : null;

    return (
        <>
            {/* モバイル用オーバーレイ */}
            <div
                className={`sidebar-overlay ${isOpen ? 'open' : ''}`}
                onClick={onClose}
            />
            <div className={`sidebar ${isOpen ? 'open' : ''}`}>
                <div className="sidebar-header" style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    <div className="sidebar-desktop-controls desktop-only">
                        <button
                            type="button"
                            className="btn btn-ghost sidebar-icon-button sidebar-search-button"
                            onClick={() => {
                                setContextMenu(null);
                                setSearchOpen(true);
                            }}
                            title="検索"
                            aria-label="検索"
                            aria-haspopup="dialog"
                        >
                            <Search size={18} />
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost sidebar-icon-button sidebar-toggle-button"
                            onClick={onToggleDesktop}
                            title={desktopSidebarTitle}
                            aria-label={desktopSidebarTitle}
                            aria-expanded={isDesktopOpen}
                        >
                            <DesktopSidebarIcon size={18} />
                        </button>
                    </div>
                    <button
                        className="btn btn-primary sidebar-main-action"
                        onClick={() => onOpenCharacterSettings(null, true)}
                        title="新しいキャラクター"
                    >
                        <User size={18} className="sidebar-action-icon" />
                        <span className="sidebar-label">新しいキャラクター</span>
                    </button>
                    <button
                        className="btn btn-secondary sidebar-secondary-action"
                        onClick={handleCreateSituation}
                        title="シチュエーション"
                        aria-label="シチュエーション"
                    >
                        <Users size={18} className="sidebar-action-icon" />
                        <span className="sidebar-label">シチュエーション</span>
                    </button>
                </div>

                <div className="sidebar-content">
                    {/* シチュエーション一覧 */}
                    {sortedGroups.length > 0 && (
                        <div>
                            <div
                                style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', userSelect: 'none' }}
                                onClick={() => setGroupExpanded((v) => !v)}
                            >
                                {groupExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <Users size={14} />
                                シチュエーション
                                <span style={{ marginLeft: '0.25rem' }}>({sortedGroups.length})</span>
                            </div>
                            {groupExpanded && sortedGroups.map((group: Situation) => {
                                const groupRooms = visibleRooms
                                    .filter((r) => r.groupId === group.id)
                                    .sort((a, b) => b.updatedAt - a.updatedAt);
                                const roomChars = resolveSituationParticipants(group, characters, defaultChatModel);
                                const charNames = roomChars.map((c) => c.name).join(', ');
                                const isExpanded = !collapsedGroups.has(group.id);
                                return (
                                    <div key={group.id} className="character-group">
                                        <div
                                            className="character-header"
                                            ref={(element) => {
                                                const key = `situation:${group.id}`;
                                                if (element) sidebarItemRefs.current.set(key, element);
                                                else sidebarItemRefs.current.delete(key);
                                            }}
                                            onClick={() => toggleGroupExpand(group.id)}
                                            onContextMenu={(e) => openContextMenu(e, { type: 'situation', groupId: group.id })}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
                                                {isExpanded
                                                    ? <ChevronDown size={16} className="sidebar-disclosure-icon" />
                                                    : <ChevronRight size={16} className="sidebar-disclosure-icon" />}
                                                <GroupAvatarStack chars={roomChars} />
                                                <span style={{ fontWeight: 500, fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {group.name}
                                                </span>
                                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                                                    ({groupRooms.length})
                                                </span>
                                            </div>
                                            <div style={{ display: 'flex', gap: '0.125rem' }}>
                                                <button
                                                    className="btn btn-ghost"
                                                    onClick={(e) => handleCreateRoomForGroup(e, group.id)}
                                                    style={{ padding: '0.25rem' }}
                                                    title="このシチュエーションで新しいチャット"
                                                >
                                                    <Plus size={14} />
                                                </button>
                                                <button
                                                    className="btn btn-ghost"
                                                    onClick={(e) => handleEditGroup(e, group)}
                                                    style={{ padding: '0.25rem' }}
                                                    title="シチュエーション設定"
                                                >
                                                    <Settings size={14} />
                                                </button>
                                                <button
                                                    className="btn btn-ghost"
                                                    onClick={(e) => handleDeleteGroup(e, group.id, group.name)}
                                                    style={{ padding: '0.25rem', color: 'var(--error)' }}
                                                    title="シチュエーションを削除"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>
                                        </div>

                                        {isExpanded && (
                                            <div className="character-rooms">
                                                {groupRooms.length === 0 ? (
                                                    <div style={{ padding: '0.5rem 0.75rem 0.5rem 2.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                        チャットがありません
                                                    </div>
                                                ) : (
                                                    groupRooms.map((room) => (
                                                        <div
                                                            key={room.id}
                                                            className={`room-item ${currentRoomId === room.id ? 'active' : ''}`}
                                                            onClick={() => handleRoomSelect(room.id)}
                                                            onContextMenu={(e) => openContextMenu(e, { type: 'room', roomId: room.id })}
                                                            style={{ paddingLeft: '2rem' }}
                                                        >
                                                            <MessageSquare size={16} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                                <div style={{ fontWeight: 500, fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                    {room.name}
                                                                </div>
                                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                    {room.lastMessagePreview
                                                                        ? room.lastMessagePreview.substring(0, 25) + (room.lastMessagePreview.length > 25 ? '...' : '')
                                                                        : charNames || 'メッセージなし'}
                                                                </div>
                                                            </div>
                                                            <button
                                                                className="btn btn-ghost"
                                                                onClick={(e) => { e.stopPropagation(); deleteRoom(room.id); }}
                                                                style={{ padding: '0.25rem', opacity: 0.5 }}
                                                                title="チャットを削除"
                                                            >
                                                                <Trash2 size={14} />
                                                            </button>
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <div
                        style={{ padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500, cursor: sortedCharacters.length > 0 ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: '0.25rem', userSelect: 'none' }}
                        onClick={() => sortedCharacters.length > 0 && setCharactersExpanded((v) => !v)}
                    >
                        {sortedCharacters.length > 0 ? (charactersExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span style={{ width: 14 }} />}
                        <User size={14} />
                        キャラクター
                        <span style={{ marginLeft: '0.25rem' }}>({sortedCharacters.length})</span>
                    </div>
                    {sortedCharacters.length === 0 ? (
                        <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                            <User size={32} style={{ margin: '0 auto 0.5rem', opacity: 0.5 }} />
                            <p style={{ fontSize: '0.875rem' }}>キャラクターがいません</p>
                            <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>「新しいキャラクター」をクリックして作成してください</p>
                        </div>
                    ) : charactersExpanded && (
                        sortedCharacters.map((character) => {
                            const characterRooms = visibleRooms
                                .filter((r) => r.characterId === character.id && !r.groupId)
                                .sort((a, b) => b.updatedAt - a.updatedAt);
                            const isExpanded = expandedCharacters.has(character.id);

                            return (
                                <div key={character.id} className="character-group">
                                    <div
                                        className="character-header"
                                        ref={(element) => {
                                            const key = `character:${character.id}`;
                                            if (element) sidebarItemRefs.current.set(key, element);
                                            else sidebarItemRefs.current.delete(key);
                                        }}
                                        onClick={() => toggleCharacterExpand(character.id)}
                                        onContextMenu={(e) => openContextMenu(e, { type: 'character', characterId: character.id })}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
                                            {isExpanded
                                                ? <ChevronDown size={16} className="sidebar-disclosure-icon" />
                                                : <ChevronRight size={16} className="sidebar-disclosure-icon" />}
                                            {character.icon ? (
                                                <StoredImage
                                                    src={character.icon}
                                                    alt={character.name}
                                                    style={{ width: '18px', height: '18px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                                                />
                                            ) : (
                                                <User size={18} style={{ flexShrink: 0, color: 'var(--primary)' }} />
                                            )}
                                            <span style={{ fontWeight: 500, fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {character.name}
                                            </span>
                                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                                                ({characterRooms.length})
                                            </span>
                                        </div>
                                        <div style={{ display: 'flex', gap: '0.125rem' }}>
                                            <button
                                                className="btn btn-ghost"
                                                onClick={(e) => handleCreateRoom(e, character.id)}
                                                style={{ padding: '0.25rem' }}
                                                title="新しいチャット"
                                            >
                                                <Plus size={14} />
                                            </button>
                                            <button
                                                className="btn btn-ghost"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    openCharacterSettings(character);
                                                }}
                                                style={{ padding: '0.25rem' }}
                                                title="キャラクター設定"
                                            >
                                                <Settings size={14} />
                                            </button>
                                            <button
                                                className="btn btn-ghost"
                                                onClick={(e) => openCharacterActionsMenu(e, character.id)}
                                                style={{ padding: '0.25rem' }}
                                                title="その他の操作"
                                                aria-label={`${character.name}のその他の操作`}
                                                aria-haspopup="menu"
                                                aria-expanded={contextMenu?.type === 'character-actions' && contextMenu.characterId === character.id}
                                            >
                                                <EllipsisVertical size={16} />
                                            </button>
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        <div className="character-rooms">
                                            {characterRooms.length === 0 ? (
                                                <div style={{ padding: '0.5rem 0.75rem 0.5rem 2.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                    チャットがありません
                                                </div>
                                            ) : (
                                                characterRooms.map((room) => (
                                                    <div
                                                        key={room.id}
                                                        className={`room-item ${currentRoomId === room.id ? 'active' : ''}`}
                                                        onClick={() => handleRoomSelect(room.id)}
                                                        onContextMenu={(e) => openContextMenu(e, { type: 'room', roomId: room.id })}
                                                        style={{ paddingLeft: '2rem' }}
                                                    >
                                                        <MessageSquare size={16} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                                                        <div style={{ flex: 1, minWidth: 0 }}>
                                                            <div
                                                                style={{
                                                                    fontWeight: 500,
                                                                    fontSize: '0.8125rem',
                                                                    overflow: 'hidden',
                                                                    textOverflow: 'ellipsis',
                                                                    whiteSpace: 'nowrap',
                                                                }}
                                                            >
                                                                {room.name}
                                                            </div>
                                                            <div
                                                                style={{
                                                                    fontSize: '0.6875rem',
                                                                    color: 'var(--text-muted)',
                                                                    overflow: 'hidden',
                                                                    textOverflow: 'ellipsis',
                                                                    whiteSpace: 'nowrap',
                                                                }}
                                                            >
                                                                {room.lastMessagePreview
                                                                    ? room.lastMessagePreview.substring(0, 25) + (room.lastMessagePreview.length > 25 ? '...' : '')
                                                                    : 'メッセージなし'}
                                                            </div>
                                                        </div>
                                                        <button
                                                            className="btn btn-ghost"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                deleteRoom(room.id);
                                                            }}
                                                            style={{ padding: '0.25rem', opacity: 0.5 }}
                                                        >
                                                            <Trash2 size={14} />
                                                        </button>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>


                <div className="sidebar-footer">
                    <button
                        className="btn sidebar-footer-action"
                        onClick={onOpenSettings}
                        title="設定"
                    >
                        <Settings size={18} />
                        <span className="sidebar-label">設定</span>
                    </button>
                </div>
            </div>
            {contextMenu && (
                <div
                    role="menu"
                    aria-label="サイドバー操作"
                    className="sidebar-context-menu"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.preventDefault()}
                >
                    {contextMenuCharacter && contextMenu.type === 'character' && (
                        <>
                            <SidebarContextMenuItem
                                icon={<Plus size={15} />}
                                label="新しいチャット"
                                onClick={() => runContextMenuAction(() => createCharacterRoom(contextMenuCharacter.id))}
                            />
                            <SidebarContextMenuItem
                                icon={<Copy size={15} />}
                                label="複製"
                                onClick={() => runContextMenuAction(() => duplicateCharacterById(contextMenuCharacter.id))}
                            />
                            <SidebarContextMenuItem
                                icon={<Trash2 size={15} />}
                                label="削除"
                                danger
                                onClick={() => runContextMenuAction(() => deleteCharacterWithConfirmation(contextMenuCharacter.id))}
                            />
                            <SidebarContextMenuItem
                                icon={<Settings size={15} />}
                                label="設定"
                                onClick={() => runContextMenuAction(() => openCharacterSettings(contextMenuCharacter))}
                            />
                        </>
                    )}
                    {contextMenuCharacter && contextMenu.type === 'character-actions' && (
                        <>
                            <SidebarContextMenuItem
                                icon={<Copy size={15} />}
                                label="複製"
                                onClick={() => runContextMenuAction(() => duplicateCharacterById(contextMenuCharacter.id))}
                            />
                            <SidebarContextMenuItem
                                icon={<Trash2 size={15} />}
                                label="削除"
                                danger
                                onClick={() => runContextMenuAction(() => deleteCharacterWithConfirmation(contextMenuCharacter.id))}
                            />
                        </>
                    )}
                    {contextMenuSituation && (
                        <>
                            <SidebarContextMenuItem
                                icon={<Plus size={15} />}
                                label="新しいチャット"
                                onClick={() => runContextMenuAction(() => createSituationRoom(contextMenuSituation.id))}
                            />
                            <SidebarContextMenuItem
                                icon={<Trash2 size={15} />}
                                label="削除"
                                danger
                                onClick={() => runContextMenuAction(() => deleteSituationWithConfirmation(contextMenuSituation.id, contextMenuSituation.name))}
                            />
                            <SidebarContextMenuItem
                                icon={<Settings size={15} />}
                                label="設定"
                                onClick={() => runContextMenuAction(() => openSituationSettings(contextMenuSituation))}
                            />
                        </>
                    )}
                    {contextMenuRoom && (
                        <SidebarContextMenuItem
                            icon={<Trash2 size={15} />}
                            label="削除"
                            danger
                            onClick={() => runContextMenuAction(() => deleteRoom(contextMenuRoom.id))}
                        />
                    )}
                </div>
            )}
            <SituationSettingsModal
                isOpen={situationSettingsOpen}
                onClose={handleCloseSituationSettings}
                situation={editingSituation}
                room={editingSituationRoom}
                onCreated={onClose}
            />
            {searchOpen && (
                <SidebarSearchDialog
                    characters={sortedCharacters}
                    situations={sortedGroups}
                    rooms={[...visibleRooms].sort((a, b) => b.updatedAt - a.updatedAt)}
                    onClose={() => setSearchOpen(false)}
                    onSelect={handleSearchSelect}
                />
            )}
        </>
    );
}
