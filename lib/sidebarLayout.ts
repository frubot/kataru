// サイドバーのフォルダ構成と手動の並び順。
// キャラクター・シチュエーションの本体データとは分けて meta に1件で保存する。

export const SIDEBAR_LAYOUT_META_KEY = 'sidebarLayout';
export const FAVORITES_FOLDER_NAME = 'お気に入り';
export const FAVORITES_FOLDER_ID = 'favorites';
export const DEFAULT_FOLDER_NAME = '新しいフォルダ';

export type SidebarFolderEntry = {
    type: 'folder';
    id: string;
    name: string;
    items: string[];
    collapsed?: boolean;
};

export type SidebarItemEntry = { type: 'item'; id: string };

export type SidebarEntry = SidebarItemEntry | SidebarFolderEntry;

export type SidebarSectionKey = 'characters' | 'situations';

export interface SidebarLayout {
    version: 1;
    characters: SidebarEntry[];
    situations: SidebarEntry[];
}

export type SidebarEntryRef = { type: 'item' | 'folder'; id: string };

export type SidebarDropTarget =
    | { type: 'before' | 'after'; entry: SidebarEntryRef }
    | { type: 'into-folder'; folderId: string }
    | { type: 'root-end' };

type LayoutItem = { id: string; favorite?: boolean };

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function parseEntries(value: unknown): SidebarEntry[] {
    if (!Array.isArray(value)) return [];
    const entries: SidebarEntry[] = [];
    for (const raw of value) {
        if (!raw || typeof raw !== 'object') continue;
        const entry = raw as Record<string, unknown>;
        if (!isString(entry.id)) continue;
        if (entry.type === 'item') {
            entries.push({ type: 'item', id: entry.id });
        } else if (entry.type === 'folder') {
            entries.push({
                type: 'folder',
                id: entry.id,
                name: isString(entry.name) ? entry.name : DEFAULT_FOLDER_NAME,
                items: Array.isArray(entry.items) ? entry.items.filter(isString) : [],
                ...(entry.collapsed === true ? { collapsed: true } : {}),
            });
        }
    }
    return entries;
}

export function parseSidebarLayout(value: unknown): SidebarLayout | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (raw.version !== 1) return null;
    return {
        version: 1,
        characters: parseEntries(raw.characters),
        situations: parseEntries(raw.situations),
    };
}

/**
 * 保存済みの構成と現在の項目を突き合わせる。
 * 存在しない項目は除き、未配置の項目は items の順でルートの先頭に入れる。
 * 構成が未保存なら、お気に入りを「お気に入り」フォルダへ移した初期構成を作る。
 * items は新しい順に並んでいることを前提とする。
 */
export function reconcileSection(
    entries: SidebarEntry[] | null,
    items: readonly LayoutItem[],
): SidebarEntry[] {
    if (entries === null) {
        const favorites = items.filter((item) => item.favorite === true).map((item) => item.id);
        const rest: SidebarEntry[] = items
            .filter((item) => item.favorite !== true)
            .map((item) => ({ type: 'item', id: item.id }));
        if (favorites.length === 0) return rest;
        return [{ type: 'folder', id: FAVORITES_FOLDER_ID, name: FAVORITES_FOLDER_NAME, items: favorites }, ...rest];
    }

    const known = new Set(items.map((item) => item.id));
    const seen = new Set<string>();
    const take = (id: string) => {
        if (!known.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
    };

    const kept: SidebarEntry[] = [];
    for (const entry of entries) {
        if (entry.type === 'item') {
            if (take(entry.id)) kept.push(entry);
        } else {
            kept.push({ ...entry, items: entry.items.filter(take) });
        }
    }

    const missing: SidebarEntry[] = items
        .filter((item) => !seen.has(item.id))
        .map((item) => ({ type: 'item', id: item.id }));
    return [...missing, ...kept];
}

export function findFolderOfItem(entries: readonly SidebarEntry[], itemId: string): SidebarFolderEntry | null {
    for (const entry of entries) {
        if (entry.type === 'folder' && entry.items.includes(itemId)) return entry;
    }
    return null;
}

function sameRef(entry: SidebarEntry, ref: SidebarEntryRef) {
    return entry.type === ref.type && entry.id === ref.id;
}

export function moveEntry(
    entries: readonly SidebarEntry[],
    source: SidebarEntryRef,
    target: SidebarDropTarget,
): SidebarEntry[] {
    if (target.type !== 'root-end') {
        const targetRef: SidebarEntryRef = target.type === 'into-folder'
            ? { type: 'folder', id: target.folderId }
            : target.entry;
        if (targetRef.type === source.type && targetRef.id === source.id) return [...entries];
    }

    if (source.type === 'folder') {
        const folder = entries.find((entry) => sameRef(entry, source));
        if (!folder) return [...entries];
        const rest = entries.filter((entry) => entry !== folder);

        // フォルダは1階層のみ。フォルダ内の項目を基準にした場合は、そのフォルダの前後に置く。
        let anchor: SidebarEntryRef | null = null;
        let after = true;
        if (target.type === 'into-folder') {
            anchor = { type: 'folder', id: target.folderId };
        } else if (target.type === 'before' || target.type === 'after') {
            after = target.type === 'after';
            const parent = target.entry.type === 'item' ? findFolderOfItem(rest, target.entry.id) : null;
            anchor = parent ? { type: 'folder', id: parent.id } : target.entry;
        }

        const index = anchor ? rest.findIndex((entry) => sameRef(entry, anchor)) : -1;
        if (index === -1) return [...rest, folder];
        rest.splice(after ? index + 1 : index, 0, folder);
        return rest;
    }

    // 項目をいったん取り除く
    const itemId = source.id;
    const removed: SidebarEntry[] = entries
        .filter((entry) => !(entry.type === 'item' && entry.id === itemId))
        .map((entry) => (
            entry.type === 'folder' && entry.items.includes(itemId)
                ? { ...entry, items: entry.items.filter((id) => id !== itemId) }
                : entry
        ));
    const itemEntry: SidebarItemEntry = { type: 'item', id: itemId };

    if (target.type === 'root-end') return [...removed, itemEntry];

    if (target.type === 'into-folder') {
        const index = removed.findIndex((entry) => entry.type === 'folder' && entry.id === target.folderId);
        if (index === -1) return [...entries];
        const folder = removed[index] as SidebarFolderEntry;
        removed[index] = { ...folder, items: [...folder.items, itemId] };
        return removed;
    }

    const after = target.type === 'after';
    const ref = target.entry;

    if (ref.type === 'item') {
        const parent = findFolderOfItem(removed, ref.id);
        if (parent) {
            const items = [...parent.items];
            const index = items.indexOf(ref.id);
            items.splice(after ? index + 1 : index, 0, itemId);
            return removed.map((entry) => (entry === parent ? { ...parent, items } : entry));
        }
    }

    const index = removed.findIndex((entry) => sameRef(entry, ref));
    if (index === -1) return [...entries];
    removed.splice(after ? index + 1 : index, 0, itemEntry);
    return removed;
}

export function createFolder(entries: readonly SidebarEntry[], id: string, name = DEFAULT_FOLDER_NAME): SidebarEntry[] {
    return [{ type: 'folder', id, name, items: [] }, ...entries];
}

export function renameFolder(entries: readonly SidebarEntry[], folderId: string, name: string): SidebarEntry[] {
    const trimmed = name.trim();
    if (!trimmed) return [...entries];
    return entries.map((entry) => (
        entry.type === 'folder' && entry.id === folderId ? { ...entry, name: trimmed } : entry
    ));
}

/** フォルダを削除し、中の項目はフォルダがあった位置へ出す。 */
export function deleteFolder(entries: readonly SidebarEntry[], folderId: string): SidebarEntry[] {
    return entries.flatMap((entry) => (
        entry.type === 'folder' && entry.id === folderId
            ? entry.items.map((id): SidebarEntry => ({ type: 'item', id }))
            : [entry]
    ));
}

export function setFolderCollapsed(entries: readonly SidebarEntry[], folderId: string, collapsed: boolean): SidebarEntry[] {
    return entries.map((entry) => {
        if (entry.type !== 'folder' || entry.id !== folderId) return entry;
        const next: SidebarFolderEntry = { ...entry };
        if (collapsed) next.collapsed = true;
        else delete next.collapsed;
        return next;
    });
}
