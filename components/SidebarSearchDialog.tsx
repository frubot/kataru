import { useMemo, useState } from 'react';
import { MessageSquare, Search, User, Users, X } from 'lucide-react';
import type { Character, Room, Situation } from '@/lib/store';

export type SidebarSearchResult =
    | { type: 'character'; item: Character }
    | { type: 'situation'; item: Situation }
    | { type: 'room'; item: Room };

interface SidebarSearchDialogProps {
    characters: Character[];
    situations: Situation[];
    rooms: Room[];
    onClose: () => void;
    onSelect: (result: SidebarSearchResult) => void;
}

function normalizeSearchText(value: string) {
    return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
}

export default function SidebarSearchDialog({
    characters,
    situations,
    rooms,
    onClose,
    onSelect,
}: SidebarSearchDialogProps) {
    const [query, setQuery] = useState('');
    const normalizedQuery = normalizeSearchText(query.trim());
    const characterNames = useMemo(
        () => new Map(characters.map((character) => [character.id, character.name])),
        [characters],
    );
    const situationNames = useMemo(
        () => new Map(situations.map((situation) => [situation.id, situation.name])),
        [situations],
    );

    const sections = useMemo(() => {
        if (!normalizedQuery) return [];

        return [
            {
                type: 'character' as const,
                label: 'キャラクター',
                results: characters
                    .filter((character) => normalizeSearchText(character.name).includes(normalizedQuery))
                    .map((item) => ({ type: 'character' as const, item })),
            },
            {
                type: 'situation' as const,
                label: 'シチュエーション',
                results: situations
                    .filter((situation) => normalizeSearchText(situation.name).includes(normalizedQuery))
                    .map((item) => ({ type: 'situation' as const, item })),
            },
            {
                type: 'room' as const,
                label: 'チャット',
                results: rooms
                    .filter((room) => normalizeSearchText(room.name).includes(normalizedQuery))
                    .map((item) => ({ type: 'room' as const, item })),
            },
        ].filter((section) => section.results.length > 0);
    }, [characters, normalizedQuery, rooms, situations]);

    const recentResults = useMemo<SidebarSearchResult[]>(
        () => [
            ...characters.slice(0, 2).map((item) => ({ type: 'character' as const, item })),
            ...situations.slice(0, 2).map((item) => ({ type: 'situation' as const, item })),
            ...rooms.slice(0, 2).map((item) => ({ type: 'room' as const, item })),
        ].sort((a, b) => b.item.updatedAt - a.item.updatedAt),
        [characters, rooms, situations],
    );

    const resultCount = sections.reduce((count, section) => count + section.results.length, 0);

    const getRoomContext = (room: Room) => {
        if (room.groupId) return situationNames.get(room.groupId);
        return characterNames.get(room.characterId);
    };

    const renderResult = (result: SidebarSearchResult) => {
        const Icon = result.type === 'character'
            ? User
            : result.type === 'situation'
                ? Users
                : MessageSquare;
        const roomContext = result.type === 'room'
            ? getRoomContext(result.item)
            : undefined;

        return (
            <button
                type="button"
                key={`${result.type}:${result.item.id}`}
                className="sidebar-search-result"
                onClick={() => onSelect(result)}
            >
                <span className="sidebar-search-result-icon">
                    <Icon size={17} />
                </span>
                <span className="sidebar-search-result-text">
                    <span className="sidebar-search-result-name">
                        {result.item.name}
                    </span>
                    {roomContext && (
                        <span className="sidebar-search-result-context">
                            {roomContext}
                        </span>
                    )}
                </span>
            </button>
        );
    };

    return (
        <div
            className="modal-overlay sidebar-search-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') onClose();
            }}
        >
            <div
                className="sidebar-search-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="検索"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="sidebar-search-input-wrap">
                    <Search size={18} aria-hidden="true" />
                    <input
                        type="search"
                        className="sidebar-search-input"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="検索"
                        aria-label="検索キーワード"
                        autoFocus
                    />
                    <button
                        type="button"
                        className="btn btn-ghost sidebar-search-close"
                        onClick={onClose}
                        title="検索を閉じる"
                        aria-label="検索を閉じる"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="sidebar-search-results" aria-live="polite">
                    {!normalizedQuery ? (
                        recentResults.length === 0 ? (
                            <div className="sidebar-search-empty">
                                検索できる項目はまだありません
                            </div>
                        ) : (
                            <section className="sidebar-search-section">
                                <h3>最近</h3>
                                <div className="sidebar-search-result-list">
                                    {recentResults.map(renderResult)}
                                </div>
                            </section>
                        )
                    ) : resultCount === 0 ? (
                        <div className="sidebar-search-empty">
                            「{query.trim()}」に一致する項目はありません
                        </div>
                    ) : (
                        sections.map((section) => (
                            <section key={section.type} className="sidebar-search-section">
                                <h3>
                                    {section.label}
                                    <span>{section.results.length}</span>
                                </h3>
                                <div className="sidebar-search-result-list">
                                    {section.results.map(renderResult)}
                                </div>
                            </section>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
