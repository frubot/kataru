import { describe, expect, test } from 'vitest';
import {
    FAVORITES_FOLDER_ID,
    createFolder,
    deleteFolder,
    moveEntry,
    parseSidebarLayout,
    reconcileSection,
    renameFolder,
    type SidebarEntry,
} from '../lib/sidebarLayout';

const folder = (id: string, items: string[]): SidebarEntry => ({ type: 'folder', id, name: id, items });
const item = (id: string): SidebarEntry => ({ type: 'item', id });

describe('reconcileSection', () => {
    test('moves favorites into a favorites folder when no layout is stored', () => {
        const result = reconcileSection(null, [{ id: 'a' }, { id: 'b', favorite: true }, { id: 'c' }]);
        expect(result).toEqual([
            { type: 'folder', id: FAVORITES_FOLDER_ID, name: 'お気に入り', items: ['b'] },
            item('a'),
            item('c'),
        ]);
    });

    test('drops unknown ids, removes duplicates and puts new items first', () => {
        const stored = [item('a'), folder('f', ['b', 'gone', 'a']), item('gone')];
        const result = reconcileSection(stored, [{ id: 'new' }, { id: 'a' }, { id: 'b' }]);
        expect(result).toEqual([item('new'), item('a'), folder('f', ['b'])]);
    });
});

describe('moveEntry', () => {
    const base = [item('a'), folder('f', ['b', 'c']), item('d')];

    test('moves an item into a folder', () => {
        expect(moveEntry(base, { type: 'item', id: 'a' }, { type: 'into-folder', folderId: 'f' }))
            .toEqual([folder('f', ['b', 'c', 'a']), item('d')]);
    });

    test('moves an item out of a folder next to a root item', () => {
        expect(moveEntry(base, { type: 'item', id: 'c' }, { type: 'after', entry: { type: 'item', id: 'd' } }))
            .toEqual([item('a'), folder('f', ['b']), item('d'), item('c')]);
    });

    test('reorders items inside a folder', () => {
        expect(moveEntry(base, { type: 'item', id: 'c' }, { type: 'before', entry: { type: 'item', id: 'b' } }))
            .toEqual([item('a'), folder('f', ['c', 'b']), item('d')]);
    });

    test('keeps folders at the root when dropped on an item inside another folder', () => {
        const entries = [folder('g', []), ...base];
        expect(moveEntry(entries, { type: 'folder', id: 'g' }, { type: 'after', entry: { type: 'item', id: 'b' } }))
            .toEqual([item('a'), folder('f', ['b', 'c']), folder('g', []), item('d')]);
    });

    test('dropping onto itself changes nothing', () => {
        expect(moveEntry(base, { type: 'item', id: 'a' }, { type: 'before', entry: { type: 'item', id: 'a' } }))
            .toEqual(base);
    });

    test('moves to the root end', () => {
        expect(moveEntry(base, { type: 'item', id: 'b' }, { type: 'root-end' }))
            .toEqual([item('a'), folder('f', ['c']), item('d'), item('b')]);
    });
});

describe('folder operations', () => {
    test('deleting a folder keeps its items in place', () => {
        expect(deleteFolder([item('a'), folder('f', ['b', 'c']), item('d')], 'f'))
            .toEqual([item('a'), item('b'), item('c'), item('d')]);
    });

    test('creates folders at the top and ignores blank names', () => {
        const created = createFolder([item('a')], 'f', 'x');
        expect(created[0]).toEqual({ type: 'folder', id: 'f', name: 'x', items: [] });
        expect(renameFolder(created, 'f', '  ')).toEqual(created);
        expect(renameFolder(created, 'f', ' y ')[0]).toMatchObject({ name: 'y' });
    });

    test('parses only valid stored layouts', () => {
        expect(parseSidebarLayout(null)).toBeNull();
        expect(parseSidebarLayout({ version: 2 })).toBeNull();
        expect(parseSidebarLayout({ version: 1, characters: [{ type: 'item', id: 'a' }, { id: 1 }], situations: 'x' }))
            .toEqual({ version: 1, characters: [item('a')], situations: [] });
    });
});
