import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, Settings, Trash2, ChevronDown, ChevronRight, User, Users, Copy, EllipsisVertical, PanelLeftClose, PanelLeftOpen, Search, Share2, SquarePen, X, Folder, FolderOpen, FolderPlus, FolderInput, FolderOutput, Pencil } from 'lucide-react';
import { useStore, Character, Situation, resolveSituationParticipants, type Room } from '@/lib/store';
import * as db from '@/lib/db';
import { generateId } from '@/lib/id';
import {
    SIDEBAR_LAYOUT_META_KEY,
    createFolder,
    deleteFolder,
    findFolderOfItem,
    moveEntry,
    parseSidebarLayout,
    reconcileSection,
    renameFolder,
    setFolderCollapsed,
    type SidebarDropTarget,
    type SidebarEntry,
    type SidebarEntryRef,
    type SidebarFolderEntry,
    type SidebarLayout,
    type SidebarSectionKey,
} from '@/lib/sidebarLayout';
import { createCharacterPackage, createCharacterPackageFilename, shareBlobFile } from '@/lib/characterPackage';
import StoredImage from './StoredImage';
import CharacterShareOptions from './CharacterShareOptions';
import SituationSettingsModal from './SituationSettingsModal';
import SidebarSearchDialog, { type SidebarSearchResult } from './SidebarSearchDialog';

type SidebarContextMenuTarget =
    | { type: 'character'; characterId: string }
    | { type: 'character-actions'; characterId: string }
    | { type: 'situation'; groupId: string }
    | { type: 'situation-actions'; groupId: string }
    | { type: 'room'; roomId: string }
    | { type: 'folder'; section: SidebarSectionKey; folderId: string }
    | { type: 'move'; section: SidebarSectionKey; itemId: string };

type SidebarContextMenu = SidebarContextMenuTarget & { x: number; y: number };

type SidebarDragSource = { section: SidebarSectionKey; ref: SidebarEntryRef };

type SidebarDropPosition = 'before' | 'after' | 'into' | 'end';

type SidebarDropIndicator = { section: SidebarSectionKey; key: string; position: SidebarDropPosition };

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_ITEM_HEIGHT = 36;
const CONTEXT_MENU_VERTICAL_PADDING = 8;
const CONTEXT_MENU_MARGIN = 8;
const ROOM_PREVIEW_LIMIT = 5;

function getContextMenuHeight(itemCount: number) {
    return itemCount * CONTEXT_MENU_ITEM_HEIGHT + CONTEXT_MENU_VERTICAL_PADDING;
}

function getContextMenuKey(menu: SidebarContextMenuTarget) {
    switch (menu.type) {
        case 'character':
        case 'character-actions':
            return `${menu.type}:${menu.characterId}`;
        case 'situation':
        case 'situation-actions':
            return `${menu.type}:${menu.groupId}`;
        case 'room':
            return `room:${menu.roomId}`;
        case 'folder':
            return `folder:${menu.folderId}`;
        case 'move':
            return `move:${menu.itemId}`;
    }
}

function getEntryKey(ref: SidebarEntryRef) {
    return `${ref.type}:${ref.id}`;
}

function getDropClassName(position: SidebarDropPosition | undefined) {
    return position ? `sidebar-drop-${position}` : '';
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
    onOpenCharacterAdd: () => void;
    isOpen: boolean;
    isDesktopOpen: boolean;
    onClose: () => void;
    onToggleDesktop: () => void;
}

export default function ChatSidebar({ onOpenSettings, onOpenCharacterSettings, onOpenCharacterAdd, isOpen, isDesktopOpen, onClose, onToggleDesktop }: ChatSidebarProps) {
    const { characters, groups, rooms, currentRoomId, createRoom, createRoomForSituation, setCurrentRoom, deleteRoom, deleteSituation, duplicateSituation, deleteCharacter, duplicateCharacter } = useStore();
    const [expandedCharacters, setExpandedCharacters] = useState<Set<string>>(new Set());
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set(groups.map((g) => g.id)));
    const [fullRoomLists, setFullRoomLists] = useState<Set<string>>(new Set());
    const [situationSettingsOpen, setSituationSettingsOpen] = useState(false);
    const [editingSituation, setEditingSituation] = useState<Situation | null>(null);
    const [sharingCharacter, setSharingCharacter] = useState<Character | null>(null);
    const [groupExpanded, setGroupExpanded] = useState(true);
    const [characterSectionExpanded, setCharacterSectionExpanded] = useState(true);
    const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
    const [searchOpen, setSearchOpen] = useState(false);
    const [revealedItem, setRevealedItem] = useState<{ type: 'character' | 'situation'; id: string } | null>(null);
    const sidebarItemRefs = useRef(new Map<string, HTMLDivElement>());
    const [storedLayout, setStoredLayout] = useState<SidebarLayout | null>(null);
    const [layoutLoaded, setLayoutLoaded] = useState(false);
    // 読込に失敗した場合は、保存済みの構成を上書きしない。
    const layoutPersistableRef = useRef(false);
    const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
    const folderRenameCancelledRef = useRef(false);
    const [dragSource, setDragSource] = useState<SidebarDragSource | null>(null);
    const dragSourceRef = useRef<SidebarDragSource | null>(null);
    const [dropIndicator, setDropIndicator] = useState<SidebarDropIndicator | null>(null);

    useEffect(() => {
        let cancelled = false;
        db.getMeta<unknown>(SIDEBAR_LAYOUT_META_KEY)
            .then((value) => {
                if (cancelled) return;
                setStoredLayout(parseSidebarLayout(value));
                layoutPersistableRef.current = true;
            })
            .catch((error) => console.error('[sidebar]', error))
            .finally(() => {
                if (!cancelled) setLayoutLoaded(true);
            });
        return () => {
            cancelled = true;
        };
    }, []);

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
    }, [characterSectionExpanded, collapsedGroups, groupExpanded, isDesktopOpen, revealedItem, storedLayout]);

    const visibleRooms = rooms.filter((room) => !room.isDraft && room.secretMode !== true);
    // 未配置の項目（初回・新規作成）を並べるための新しい順。
    const sortedGroups = [...groups].sort((a, b) => {
        const latestA = Math.max(a.updatedAt, ...visibleRooms.filter((r) => r.groupId === a.id).map((r) => r.updatedAt));
        const latestB = Math.max(b.updatedAt, ...visibleRooms.filter((r) => r.groupId === b.id).map((r) => r.updatedAt));
        return latestB - latestA;
    });
    const sortedCharacters = [...characters].sort((a, b) => b.updatedAt - a.updatedAt);
    const characterEntries = reconcileSection(storedLayout ? storedLayout.characters : null, sortedCharacters);
    const situationEntries = reconcileSection(storedLayout ? storedLayout.situations : null, sortedGroups);
    const getSectionEntries = (section: SidebarSectionKey) => (
        section === 'characters' ? characterEntries : situationEntries
    );

    const updateSection = (section: SidebarSectionKey, update: (entries: SidebarEntry[]) => SidebarEntry[]) => {
        const next: SidebarLayout = {
            version: 1,
            characters: characterEntries,
            situations: situationEntries,
        };
        next[section] = update(getSectionEntries(section));
        setStoredLayout(next);
        if (layoutPersistableRef.current) {
            db.setMeta(SIDEBAR_LAYOUT_META_KEY, next).catch((error) => console.error('[db]', error));
        }
    };

    const getMenuItemCount = (menu: SidebarContextMenuTarget) => {
        switch (menu.type) {
            case 'character':
                return 6;
            case 'situation':
                return 5;
            case 'character-actions':
                return 4;
            case 'situation-actions':
                return 3;
            case 'room':
                return 1;
            case 'folder':
                return 2;
            case 'move': {
                const entries = getSectionEntries(menu.section);
                const current = findFolderOfItem(entries, menu.itemId);
                const folderCount = entries.filter((entry) => entry.type === 'folder' && entry.id !== current?.id).length;
                return folderCount + (current ? 1 : 0) + 1;
            }
        }
    };

    const showContextMenu = (menu: SidebarContextMenuTarget, x: number, y: number) => {
        const menuHeight = getContextMenuHeight(getMenuItemCount(menu));
        setContextMenu({
            ...menu,
            x: clampContextMenuPosition(x, CONTEXT_MENU_WIDTH, window.innerWidth),
            y: clampContextMenuPosition(y, menuHeight, window.innerHeight),
        });
    };

    const openContextMenu = (event: React.MouseEvent, menu: SidebarContextMenuTarget) => {
        event.preventDefault();
        event.stopPropagation();
        showContextMenu(menu, event.clientX, event.clientY);
    };

    const runContextMenuAction = (action: () => void) => {
        setContextMenu(null);
        action();
    };

    const openActionsMenu = (event: React.MouseEvent<HTMLButtonElement>, menu: SidebarContextMenuTarget) => {
        event.preventDefault();
        event.stopPropagation();

        if (contextMenu && getContextMenuKey(contextMenu) === getContextMenuKey(menu)) {
            setContextMenu(null);
            return;
        }

        const rect = event.currentTarget.getBoundingClientRect();
        showContextMenu(menu, rect.right - CONTEXT_MENU_WIDTH, rect.bottom + 4);
    };

    // 項目メニューから「フォルダへ移動」を開くときは、元のメニューの位置に出す。
    const openMoveMenu = (section: SidebarSectionKey, itemId: string) => {
        if (!contextMenu) return;
        showContextMenu({ type: 'move', section, itemId }, contextMenu.x, contextMenu.y);
    };

    const handleCreateFolder = (section: SidebarSectionKey, itemId?: string) => {
        const folderId = generateId();
        updateSection(section, (entries) => {
            const created = createFolder(entries, folderId);
            return itemId
                ? moveEntry(created, { type: 'item', id: itemId }, { type: 'into-folder', folderId })
                : created;
        });
        if (section === 'characters') setCharacterSectionExpanded(true);
        else setGroupExpanded(true);
        folderRenameCancelledRef.current = false;
        setEditingFolderId(folderId);
    };

    const startFolderRename = (folderId: string) => {
        folderRenameCancelledRef.current = false;
        setEditingFolderId(folderId);
    };

    const commitFolderRename = (section: SidebarSectionKey, folderId: string, name: string) => {
        setEditingFolderId(null);
        if (folderRenameCancelledRef.current) {
            folderRenameCancelledRef.current = false;
            return;
        }
        const folder = getSectionEntries(section).find((entry) => entry.type === 'folder' && entry.id === folderId);
        if (!folder || folder.type !== 'folder' || !name.trim() || folder.name === name.trim()) return;
        updateSection(section, (entries) => renameFolder(entries, folderId, name));
    };

    const toggleFolder = (section: SidebarSectionKey, folder: SidebarFolderEntry) => {
        updateSection(section, (entries) => setFolderCollapsed(entries, folder.id, !folder.collapsed));
    };

    const moveItemTo = (section: SidebarSectionKey, itemId: string, target: SidebarDropTarget) => {
        updateSection(section, (entries) => moveEntry(entries, { type: 'item', id: itemId }, target));
    };

    const revealInFolder = (section: SidebarSectionKey, itemId: string) => {
        const folder = findFolderOfItem(getSectionEntries(section), itemId);
        if (folder?.collapsed) {
            updateSection(section, (entries) => setFolderCollapsed(entries, folder.id, false));
        }
    };

    // ---- ドラッグ&ドロップ ----

    const endDrag = () => {
        dragSourceRef.current = null;
        setDragSource(null);
        setDropIndicator(null);
    };

    const showDropIndicator = (next: SidebarDropIndicator | null) => {
        setDropIndicator((current) => (
            current?.section === next?.section && current?.key === next?.key && current?.position === next?.position
                ? current
                : next
        ));
    };

    const getDragSourceProps = (section: SidebarSectionKey, ref: SidebarEntryRef) => ({
        draggable: true,
        onDragStart: (event: React.DragEvent<HTMLElement>) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', ref.id);
            const source = { section, ref };
            dragSourceRef.current = source;
            setDragSource(source);
            setContextMenu(null);
        },
        onDragEnd: endDrag,
    });

    const acceptDrag = (event: React.DragEvent, section: SidebarSectionKey) => {
        const source = dragSourceRef.current;
        if (!source || source.section !== section) return null;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        return source;
    };

    // 展開中のチャット一覧ではなく、見出し行を基準に前後を判定する。
    const getHeaderRect = (element: HTMLElement) => (element.firstElementChild ?? element).getBoundingClientRect();

    const getItemDropTarget = (event: React.DragEvent<HTMLElement>, itemId: string): SidebarDropTarget => {
        const rect = getHeaderRect(event.currentTarget);
        const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        return { type: position, entry: { type: 'item', id: itemId } };
    };

    const getFolderDropTarget = (event: React.DragEvent<HTMLElement>, source: SidebarDragSource, folderId: string): SidebarDropTarget => {
        const entry: SidebarEntryRef = { type: 'folder', id: folderId };
        if (source.ref.type === 'folder') {
            const rect = event.currentTarget.getBoundingClientRect();
            return { type: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after', entry };
        }
        const header = getHeaderRect(event.currentTarget);
        return event.clientY < header.top + header.height * 0.3
            ? { type: 'before', entry }
            : { type: 'into-folder', folderId };
    };

    const toIndicator = (section: SidebarSectionKey, target: SidebarDropTarget): SidebarDropIndicator => {
        if (target.type === 'root-end') return { section, key: 'end', position: 'end' };
        if (target.type === 'into-folder') return { section, key: `folder:${target.folderId}`, position: 'into' };
        return { section, key: getEntryKey(target.entry), position: target.type };
    };

    const applyDrop = (section: SidebarSectionKey, source: SidebarDragSource, target: SidebarDropTarget) => {
        endDrag();
        const entries = getSectionEntries(section);
        const next = moveEntry(entries, source.ref, target);
        updateSection(section, () => (
            target.type === 'into-folder' ? setFolderCollapsed(next, target.folderId, false) : next
        ));
    };

    const getItemDropProps = (section: SidebarSectionKey, itemId: string, inFolder: boolean) => {
        // フォルダは1階層のみなので、フォルダ内の項目へのフォルダのドロップは親フォルダに任せる。
        const accepts = () => !(dragSourceRef.current?.ref.type === 'folder' && inFolder);
        return {
            onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
                if (!accepts() || !acceptDrag(event, section)) return;
                showDropIndicator(toIndicator(section, getItemDropTarget(event, itemId)));
            },
            onDrop: (event: React.DragEvent<HTMLDivElement>) => {
                if (!accepts()) return;
                const source = acceptDrag(event, section);
                if (source) applyDrop(section, source, getItemDropTarget(event, itemId));
            },
        };
    };

    const getFolderDropProps = (section: SidebarSectionKey, folderId: string) => ({
        onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
            const source = acceptDrag(event, section);
            if (source) showDropIndicator(toIndicator(section, getFolderDropTarget(event, source, folderId)));
        },
        onDrop: (event: React.DragEvent<HTMLDivElement>) => {
            const source = acceptDrag(event, section);
            if (source) applyDrop(section, source, getFolderDropTarget(event, source, folderId));
        },
    });

    const getSectionDropProps = (section: SidebarSectionKey) => ({
        onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
            if (acceptDrag(event, section)) showDropIndicator({ section, key: 'end', position: 'end' });
        },
        onDrop: (event: React.DragEvent<HTMLDivElement>) => {
            const source = acceptDrag(event, section);
            if (source) applyDrop(section, source, { type: 'root-end' });
        },
        onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
            const related = event.relatedTarget;
            if (!(related instanceof Node) || !event.currentTarget.contains(related)) showDropIndicator(null);
        },
    });

    const getDropPosition = (section: SidebarSectionKey, key: string) => (
        dropIndicator?.section === section && dropIndicator.key === key ? dropIndicator.position : undefined
    );

    const isDragging = (section: SidebarSectionKey, ref: SidebarEntryRef) => (
        dragSource?.section === section && getEntryKey(dragSource.ref) === getEntryKey(ref)
    );

    const setFullRoomList = (listKey: string, showAll: boolean) => {
        setFullRoomLists((prev) => {
            if (prev.has(listKey) === showAll) return prev;
            const next = new Set(prev);
            if (showAll) {
                next.add(listKey);
            } else {
                next.delete(listKey);
            }
            return next;
        });
    };

    const toggleCharacterExpand = (characterId: string) => {
        if (expandedCharacters.has(characterId)) setFullRoomList(`character:${characterId}`, false);
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
        if (!collapsedGroups.has(groupId)) setFullRoomList(`situation:${groupId}`, false);
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

    const shareCharacterById = async (characterId: string, includeVrm?: boolean) => {
        const character = characters.find((candidate) => candidate.id === characterId);
        if (!character) return;
        if (includeVrm === undefined && character.costumes?.some((costume) => costume.kind === 'vrm')) {
            setSharingCharacter(character);
            return;
        }
        try {
            const blob = await createCharacterPackage(character.id, includeVrm ?? true);
            const filename = createCharacterPackageFilename(character.name);
            await shareBlobFile(blob, filename, `${character.name} - Kataru`);
            setSharingCharacter(null);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'キャラクターの共有に失敗しました';
            window.alert(message);
        }
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

    const duplicateSituationById = (groupId: string) => {
        duplicateSituation(groupId);
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
            setCharacterSectionExpanded(true);
            revealInFolder('characters', result.item.id);
            setExpandedCharacters((current) => new Set(current).add(result.item.id));
        } else {
            setGroupExpanded(true);
            revealInFolder('situations', result.item.id);
            setCollapsedGroups((current) => {
                const next = new Set(current);
                next.delete(result.item.id);
                return next;
            });
        }

        setRevealedItem({ type: result.type, id: result.item.id });
        if (!isDesktopOpen) onToggleDesktop();
    };

    const charactersById = new Map(characters.map((character) => [character.id, character]));
    const situationsById = new Map(groups.map((group) => [group.id, group]));
    const DesktopSidebarIcon = isDesktopOpen ? PanelLeftClose : PanelLeftOpen;
    const desktopSidebarTitle = isDesktopOpen ? 'サイドバーを折りたたむ' : 'サイドバーを開く';
    const selectedRoom = rooms.find((room) => room.id === currentRoomId) ?? null;
    const selectedSituation = selectedRoom?.groupId
        ? groups.find((group) => group.id === selectedRoom.groupId) ?? null
        : null;
    const selectedCharacter = selectedRoom && !selectedRoom.groupId
        ? characters.find((character) => character.id === selectedRoom.characterId) ?? null
        : null;
    const selectedConversationName = selectedSituation?.name ?? selectedCharacter?.name;
    const editingSituationRoom = editingSituation
        ? rooms.find((room) => room.id === currentRoomId && room.groupId === editingSituation.id) ?? null
        : null;
    const contextMenuCharacter = contextMenu?.type === 'character' || contextMenu?.type === 'character-actions'
        ? characters.find((character) => character.id === contextMenu.characterId) ?? null
        : null;
    const contextMenuSituation = contextMenu?.type === 'situation' || contextMenu?.type === 'situation-actions'
        ? groups.find((group) => group.id === contextMenu.groupId) ?? null
        : null;
    const contextMenuFolder = contextMenu?.type === 'folder'
        ? getSectionEntries(contextMenu.section).find((entry): entry is SidebarFolderEntry => entry.type === 'folder' && entry.id === contextMenu.folderId) ?? null
        : null;
    const contextMenuMoveCurrentFolder = contextMenu?.type === 'move'
        ? findFolderOfItem(getSectionEntries(contextMenu.section), contextMenu.itemId)
        : null;
    const contextMenuMoveFolders = contextMenu?.type === 'move'
        ? getSectionEntries(contextMenu.section).filter((entry): entry is SidebarFolderEntry => (
            entry.type === 'folder' && entry.id !== contextMenuMoveCurrentFolder?.id
        ))
        : [];
    const contextMenuRoom = contextMenu?.type === 'room'
        ? rooms.find((room) => room.id === contextMenu.roomId) ?? null
        : null;

    const renderRoomList = (listKey: string, roomList: Room[]) => {
        if (roomList.length === 0) {
            return (
                <div className="character-rooms">
                    <div style={{ padding: '0.5rem 0.75rem 0.5rem 2.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        チャットがありません
                    </div>
                </div>
            );
        }

        const isTruncatable = roomList.length > ROOM_PREVIEW_LIMIT;
        const showAll = !isTruncatable || fullRoomLists.has(listKey);
        const shownRooms = showAll
            ? roomList
            : roomList.filter((room, index) => index < ROOM_PREVIEW_LIMIT || room.id === currentRoomId);
        const hiddenCount = roomList.length - shownRooms.length;

        return (
            <div className="character-rooms">
                {shownRooms.map((room) => (
                    <div
                        key={room.id}
                        className={`room-item ${currentRoomId === room.id ? 'active' : ''}`}
                        onClick={() => handleRoomSelect(room.id)}
                        onContextMenu={(event) => openContextMenu(event, { type: 'room', roomId: room.id })}
                        style={{ paddingLeft: '2rem' }}
                    >
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 500, fontSize: '0.8125rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {room.name}
                            </div>
                        </div>
                        <button
                            className="btn btn-ghost"
                            onClick={(event) => {
                                event.stopPropagation();
                                deleteRoom(room.id);
                            }}
                            style={{ padding: '0.25rem', opacity: 0.5 }}
                            title="チャットを削除"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                ))}
                {isTruncatable && (
                    <button
                        type="button"
                        className="room-list-toggle"
                        onClick={() => setFullRoomList(listKey, !showAll)}
                    >
                        {showAll ? '表示を減らす' : `さらに表示（残り${hiddenCount}件）`}
                    </button>
                )}
            </div>
        );
    };

    const renderSituation = (group: Situation, inFolder: boolean) => {
        const groupRooms = visibleRooms
            .filter((room) => room.groupId === group.id)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const roomChars = resolveSituationParticipants(group, characters);
        const isExpanded = !collapsedGroups.has(group.id);
        const ref: SidebarEntryRef = { type: 'item', id: group.id };

        return (
            <div
                key={group.id}
                className={`character-group sidebar-draggable ${getDropClassName(getDropPosition('situations', getEntryKey(ref)))} ${isDragging('situations', ref) ? 'is-dragging' : ''}`}
                {...getItemDropProps('situations', group.id, inFolder)}
            >
                <div
                    className="character-header"
                    ref={(element) => {
                        const key = `situation:${group.id}`;
                        if (element) sidebarItemRefs.current.set(key, element);
                        else sidebarItemRefs.current.delete(key);
                    }}
                    {...getDragSourceProps('situations', ref)}
                    onClick={() => toggleGroupExpand(group.id)}
                    onContextMenu={(event) => openContextMenu(event, { type: 'situation', groupId: group.id })}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
                        {isExpanded
                            ? <ChevronDown size={16} className="sidebar-disclosure-icon" />
                            : <ChevronRight size={16} className="sidebar-disclosure-icon" />}
                        <GroupAvatarStack chars={roomChars} />
                        <span style={{ fontWeight: 500, fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {group.name}
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.125rem' }}>
                        <button
                            className="btn btn-ghost"
                            onClick={(event) => handleCreateRoomForGroup(event, group.id)}
                            style={{ padding: '0.25rem' }}
                            title="このシチュエーションで新しいチャット"
                        >
                            <Plus size={14} />
                        </button>
                        <button
                            className="btn btn-ghost"
                            onClick={(event) => handleEditGroup(event, group)}
                            style={{ padding: '0.25rem' }}
                            title="シチュエーション設定"
                        >
                            <Settings size={14} />
                        </button>
                        <button
                            className="btn btn-ghost"
                            onClick={(event) => openActionsMenu(event, { type: 'situation-actions', groupId: group.id })}
                            style={{ padding: '0.25rem' }}
                            title="その他の操作"
                            aria-label={`${group.name}のその他の操作`}
                            aria-haspopup="menu"
                            aria-expanded={contextMenu?.type === 'situation-actions' && contextMenu.groupId === group.id}
                        >
                            <EllipsisVertical size={16} />
                        </button>
                    </div>
                </div>

                {isExpanded && renderRoomList(`situation:${group.id}`, groupRooms)}
            </div>
        );
    };

    const renderCharacter = (character: Character, inFolder: boolean) => {
        const characterRooms = visibleRooms
            .filter((room) => room.characterId === character.id && !room.groupId)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const isExpanded = expandedCharacters.has(character.id);
        const ref: SidebarEntryRef = { type: 'item', id: character.id };

        return (
            <div
                key={character.id}
                className={`character-group sidebar-draggable ${getDropClassName(getDropPosition('characters', getEntryKey(ref)))} ${isDragging('characters', ref) ? 'is-dragging' : ''}`}
                {...getItemDropProps('characters', character.id, inFolder)}
            >
                <div
                    className="character-header"
                    ref={(element) => {
                        const key = `character:${character.id}`;
                        if (element) sidebarItemRefs.current.set(key, element);
                        else sidebarItemRefs.current.delete(key);
                    }}
                    {...getDragSourceProps('characters', ref)}
                    onClick={() => toggleCharacterExpand(character.id)}
                    onContextMenu={(event) => openContextMenu(event, { type: 'character', characterId: character.id })}
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
                    </div>
                    <div style={{ display: 'flex', gap: '0.125rem' }}>
                        <button
                            className="btn btn-ghost"
                            onClick={(event) => handleCreateRoom(event, character.id)}
                            style={{ padding: '0.25rem' }}
                            title="新しいチャット"
                        >
                            <Plus size={14} />
                        </button>
                        <button
                            className="btn btn-ghost"
                            onClick={(event) => {
                                event.stopPropagation();
                                openCharacterSettings(character);
                            }}
                            style={{ padding: '0.25rem' }}
                            title="キャラクター設定"
                        >
                            <Settings size={14} />
                        </button>
                        <button
                            className="btn btn-ghost"
                            onClick={(event) => openActionsMenu(event, { type: 'character-actions', characterId: character.id })}
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

                {isExpanded && renderRoomList(`character:${character.id}`, characterRooms)}
            </div>
        );
    };

    const renderSectionItem = (section: SidebarSectionKey, itemId: string, inFolder: boolean) => {
        if (section === 'characters') {
            const character = charactersById.get(itemId);
            return character ? renderCharacter(character, inFolder) : null;
        }
        const situation = situationsById.get(itemId);
        return situation ? renderSituation(situation, inFolder) : null;
    };

    const renderFolder = (section: SidebarSectionKey, folder: SidebarFolderEntry) => {
        const ref: SidebarEntryRef = { type: 'folder', id: folder.id };
        const isExpanded = !folder.collapsed;
        const isEditing = editingFolderId === folder.id;
        const FolderIcon = isExpanded ? FolderOpen : Folder;

        return (
            <div
                key={folder.id}
                className={`character-group sidebar-folder sidebar-draggable ${getDropClassName(getDropPosition(section, getEntryKey(ref)))} ${isDragging(section, ref) ? 'is-dragging' : ''}`}
                {...getFolderDropProps(section, folder.id)}
            >
                <div
                    className="character-header sidebar-folder-header"
                    {...(isEditing ? {} : getDragSourceProps(section, ref))}
                    onClick={() => {
                        if (!isEditing) toggleFolder(section, folder);
                    }}
                    onContextMenu={(event) => openContextMenu(event, { type: 'folder', section, folderId: folder.id })}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
                        {isExpanded
                            ? <ChevronDown size={16} className="sidebar-disclosure-icon" />
                            : <ChevronRight size={16} className="sidebar-disclosure-icon" />}
                        <FolderIcon size={16} className="sidebar-folder-icon" />
                        {isEditing ? (
                            <input
                                className="sidebar-folder-name-input"
                                defaultValue={folder.name}
                                autoFocus
                                aria-label="フォルダ名"
                                maxLength={100}
                                onFocus={(event) => event.currentTarget.select()}
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => {
                                    event.stopPropagation();
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        event.currentTarget.blur();
                                    } else if (event.key === 'Escape') {
                                        event.preventDefault();
                                        folderRenameCancelledRef.current = true;
                                        event.currentTarget.blur();
                                    }
                                }}
                                onBlur={(event) => commitFolderRename(section, folder.id, event.currentTarget.value)}
                            />
                        ) : (
                            <span style={{ fontWeight: 500, fontSize: '0.875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {folder.name}
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.125rem' }}>
                        <button
                            className="btn btn-ghost"
                            onClick={(event) => openActionsMenu(event, { type: 'folder', section, folderId: folder.id })}
                            style={{ padding: '0.25rem' }}
                            title="フォルダの操作"
                            aria-label={`${folder.name}の操作`}
                            aria-haspopup="menu"
                            aria-expanded={contextMenu?.type === 'folder' && contextMenu.folderId === folder.id}
                        >
                            <EllipsisVertical size={16} />
                        </button>
                    </div>
                </div>
                {isExpanded && (
                    <div className="sidebar-folder-items">
                        {folder.items.length === 0
                            ? <div className="sidebar-folder-empty">ここにドラッグして追加</div>
                            : folder.items.map((itemId) => renderSectionItem(section, itemId, true))}
                    </div>
                )}
            </div>
        );
    };

    const renderSectionEntries = (section: SidebarSectionKey) => {
        if (!layoutLoaded) return null;
        return (
            <div className="sidebar-tree-items" {...getSectionDropProps(section)}>
                {getSectionEntries(section).map((entry) => (
                    entry.type === 'folder'
                        ? renderFolder(section, entry)
                        : renderSectionItem(section, entry.id, false)
                ))}
                <div className={`sidebar-drop-end-zone ${getDropPosition(section, 'end') ? 'is-active' : ''}`} />
            </div>
        );
    };

    const renderSectionHeadingAction = (section: SidebarSectionKey) => (
        <button
            type="button"
            className="btn btn-ghost sidebar-tree-heading-action"
            onClick={(event) => {
                event.stopPropagation();
                handleCreateFolder(section);
            }}
            title="フォルダを作成"
            aria-label="フォルダを作成"
        >
            <FolderPlus size={14} />
        </button>
    );

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
                        <img className="sidebar-brand" src="/logo.png" alt="" />
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
                    <div className="sidebar-mobile-controls mobile-only">
                        <img className="sidebar-brand" src="/logo.png" alt="" />
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
                            className="btn btn-ghost sidebar-icon-button sidebar-close-button"
                            onClick={onClose}
                            title="サイドバーを閉じる"
                            aria-label="サイドバーを閉じる"
                        >
                            <X size={18} />
                        </button>
                    </div>
                    {selectedConversationName && (
                        <button
                            type="button"
                            className="btn btn-secondary sidebar-new-chat-action"
                            onClick={() => {
                                if (selectedSituation) {
                                    createSituationRoom(selectedSituation.id);
                                } else if (selectedCharacter) {
                                    createCharacterRoom(selectedCharacter.id);
                                }
                            }}
                            title={`${selectedConversationName}で新しいチャット`}
                            aria-label={`${selectedConversationName}で新しいチャット`}
                        >
                            <SquarePen size={18} className="sidebar-action-icon" />
                            <span className="sidebar-label">新しいチャット</span>
                        </button>
                    )}
                    <button
                        className="btn btn-primary sidebar-main-action"
                        onClick={onOpenCharacterAdd}
                        title="キャラクターを追加"
                        aria-label="キャラクターを追加"
                    >
                        <User size={18} className="sidebar-action-icon" />
                        <span className="sidebar-label">キャラクターを追加</span>
                    </button>
                    <button
                        className="btn btn-secondary sidebar-secondary-action"
                        onClick={handleCreateSituation}
                        title="シチュエーションを追加"
                        aria-label="シチュエーションを追加"
                    >
                        <Users size={18} className="sidebar-action-icon" />
                        <span className="sidebar-label">シチュエーションを追加</span>
                    </button>
                </div>

                <div className="sidebar-content">
                    {/* シチュエーション一覧 */}
                    <div className="sidebar-tree-section">
                        <div
                            className="sidebar-tree-heading sidebar-tree-heading-root"
                            onClick={() => setGroupExpanded((value) => !value)}
                        >
                            {groupExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <Users size={14} />
                            <span className="sidebar-tree-heading-label">シチュエーション</span>
                            {renderSectionHeadingAction('situations')}
                        </div>
                        {groupExpanded && renderSectionEntries('situations')}
                    </div>

                    {/* キャラクター一覧 */}
                    <div className="sidebar-tree-section">
                        <div
                            className="sidebar-tree-heading sidebar-tree-heading-root"
                            onClick={() => setCharacterSectionExpanded((value) => !value)}
                        >
                            {characterSectionExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <User size={14} />
                            <span className="sidebar-tree-heading-label">キャラクター</span>
                            {renderSectionHeadingAction('characters')}
                        </div>
                        {characterSectionExpanded && (
                            sortedCharacters.length === 0 && !characterEntries.some((entry) => entry.type === 'folder') ? (
                                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                                    <User size={32} style={{ margin: '0 auto 0.5rem', opacity: 0.5 }} />
                                    <p style={{ fontSize: '0.875rem' }}>キャラクターがいません</p>
                                    <p style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>「キャラクターを追加」から作成してください</p>
                                </div>
                            ) : renderSectionEntries('characters')
                        )}
                    </div>
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
                                icon={<FolderInput size={15} />}
                                label="フォルダへ移動"
                                onClick={() => openMoveMenu('characters', contextMenuCharacter.id)}
                            />
                            <SidebarContextMenuItem
                                icon={<Share2 size={15} />}
                                label="共有"
                                onClick={() => runContextMenuAction(() => { void shareCharacterById(contextMenuCharacter.id); })}
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
                                icon={<FolderInput size={15} />}
                                label="フォルダへ移動"
                                onClick={() => openMoveMenu('characters', contextMenuCharacter.id)}
                            />
                            <SidebarContextMenuItem
                                icon={<Share2 size={15} />}
                                label="共有"
                                onClick={() => runContextMenuAction(() => { void shareCharacterById(contextMenuCharacter.id); })}
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
                        </>
                    )}
                    {contextMenuSituation && contextMenu.type === 'situation' && (
                        <>
                            <SidebarContextMenuItem
                                icon={<Plus size={15} />}
                                label="新しいチャット"
                                onClick={() => runContextMenuAction(() => createSituationRoom(contextMenuSituation.id))}
                            />
                            <SidebarContextMenuItem
                                icon={<FolderInput size={15} />}
                                label="フォルダへ移動"
                                onClick={() => openMoveMenu('situations', contextMenuSituation.id)}
                            />
                            <SidebarContextMenuItem
                                icon={<Copy size={15} />}
                                label="複製"
                                onClick={() => runContextMenuAction(() => duplicateSituationById(contextMenuSituation.id))}
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
                    {contextMenuSituation && contextMenu.type === 'situation-actions' && (
                        <>
                            <SidebarContextMenuItem
                                icon={<FolderInput size={15} />}
                                label="フォルダへ移動"
                                onClick={() => openMoveMenu('situations', contextMenuSituation.id)}
                            />
                            <SidebarContextMenuItem
                                icon={<Copy size={15} />}
                                label="複製"
                                onClick={() => runContextMenuAction(() => duplicateSituationById(contextMenuSituation.id))}
                            />
                            <SidebarContextMenuItem
                                icon={<Trash2 size={15} />}
                                label="削除"
                                danger
                                onClick={() => runContextMenuAction(() => deleteSituationWithConfirmation(contextMenuSituation.id, contextMenuSituation.name))}
                            />
                        </>
                    )}
                    {contextMenuFolder && contextMenu.type === 'folder' && (
                        <>
                            <SidebarContextMenuItem
                                icon={<Pencil size={15} />}
                                label="名前を変更"
                                onClick={() => runContextMenuAction(() => startFolderRename(contextMenuFolder.id))}
                            />
                            <SidebarContextMenuItem
                                icon={<Trash2 size={15} />}
                                label="フォルダを削除"
                                danger
                                onClick={() => runContextMenuAction(() => updateSection(contextMenu.section, (entries) => deleteFolder(entries, contextMenuFolder.id)))}
                            />
                        </>
                    )}
                    {contextMenu.type === 'move' && (
                        <>
                            {contextMenuMoveCurrentFolder && (
                                <SidebarContextMenuItem
                                    icon={<FolderOutput size={15} />}
                                    label="フォルダから出す"
                                    onClick={() => runContextMenuAction(() => moveItemTo(contextMenu.section, contextMenu.itemId, {
                                        type: 'after',
                                        entry: { type: 'folder', id: contextMenuMoveCurrentFolder.id },
                                    }))}
                                />
                            )}
                            {contextMenuMoveFolders.map((folder) => (
                                <SidebarContextMenuItem
                                    key={folder.id}
                                    icon={<Folder size={15} />}
                                    label={folder.name}
                                    onClick={() => runContextMenuAction(() => moveItemTo(contextMenu.section, contextMenu.itemId, {
                                        type: 'into-folder',
                                        folderId: folder.id,
                                    }))}
                                />
                            ))}
                            <SidebarContextMenuItem
                                icon={<FolderPlus size={15} />}
                                label="新しいフォルダ"
                                onClick={() => runContextMenuAction(() => handleCreateFolder(contextMenu.section, contextMenu.itemId))}
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
            {sharingCharacter && <CharacterShareOptions name={sharingCharacter.name} onClose={() => setSharingCharacter(null)}
                onShare={(include) => shareCharacterById(sharingCharacter.id, include)} />}
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
