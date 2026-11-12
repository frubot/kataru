import { generateId } from './id';
import type { Costume, Expression } from './store/types';

export const NEUTRAL_EXPRESSION_NAME = 'neutral';

/** 衣装を持つもの（キャラクターとシチュエーションの一時キャラクター）。 */
export type CostumeOwner = {
    costumes?: Costume[];
    defaultCostumeId?: string;
};

/** 衣装の一覧とデフォルト衣装の組。編集画面の下書きで使う。 */
export type CostumeSet = {
    costumes: Costume[];
    defaultCostumeId?: string;
};

export function createCostumeId(): string {
    return generateId();
}

export function findCostumeById(
    owner: CostumeOwner | null | undefined,
    costumeId: string | null | undefined,
): Costume | null {
    if (!owner || !costumeId) return null;
    return (owner.costumes ?? []).find((costume) => costume.id === costumeId) ?? null;
}

/** デフォルト衣装。`defaultCostumeId` が無効なときは先頭の衣装を使う。 */
export function resolveDefaultCostume(owner: CostumeOwner | null | undefined): Costume | null {
    if (!owner) return null;
    return findCostumeById(owner, owner.defaultCostumeId) ?? owner.costumes?.[0] ?? null;
}

/** 選択中の衣装。未選択・不明な id のときはデフォルト衣装に従う。 */
export function resolveActiveCostume(
    owner: CostumeOwner | null | undefined,
    costumeId?: string | null,
): Costume | null {
    return findCostumeById(owner, costumeId) ?? resolveDefaultCostume(owner);
}

export function isDefaultCostume(owner: CostumeOwner | null | undefined, costumeId: string): boolean {
    return resolveDefaultCostume(owner)?.id === costumeId;
}

/** 衣装名の重複判定（大文字小文字は区別しない）。`exceptId` の衣装は除外する。 */
export function isCostumeNameTaken(costumes: Costume[], name: string, exceptId?: string): boolean {
    const key = name.trim().toLowerCase();
    return costumes.some((costume) => costume.id !== exceptId && costume.name.trim().toLowerCase() === key);
}

/** 衣装を id で置き換え、無ければ末尾に追加する。デフォルトが無ければ追加した衣装をデフォルトにする。 */
export function upsertCostume(set: CostumeSet, costume: Costume): CostumeSet {
    const index = set.costumes.findIndex((entry) => entry.id === costume.id);
    const costumes = index >= 0
        ? set.costumes.map((entry, entryIndex) => (entryIndex === index ? costume : entry))
        : [...set.costumes, costume];
    const hasDefault = costumes.some((entry) => entry.id === set.defaultCostumeId);
    return { costumes, defaultCostumeId: hasDefault ? set.defaultCostumeId : costumes[0]?.id };
}

export function setDefaultCostume(set: CostumeSet, costumeId: string): CostumeSet {
    if (!set.costumes.some((costume) => costume.id === costumeId)) return set;
    return { ...set, defaultCostumeId: costumeId };
}

/**
 * 衣装を削除する。最後の1着は削除しない。デフォルトを削除したときは
 * 残った衣装の先頭をデフォルトにする。
 */
export function removeCostume(set: CostumeSet, costumeId: string): CostumeSet {
    if (set.costumes.length <= 1 || !set.costumes.some((costume) => costume.id === costumeId)) return set;
    const costumes = set.costumes.filter((costume) => costume.id !== costumeId);
    const defaultCostumeId = costumes.some((costume) => costume.id === set.defaultCostumeId)
        ? set.defaultCostumeId
        : costumes[0]?.id;
    return { costumes, defaultCostumeId };
}

function updateCostumeExpressions(
    costumes: Costume[],
    costumeId: string,
    update: (expressions: Expression[]) => Expression[],
): Costume[] {
    return costumes.map((costume) => (
        costume.id === costumeId
            ? { ...costume, expressions: update(costume.expressions ?? []) }
            : costume
    ));
}

export function upsertCostumeExpression(costumes: Costume[], costumeId: string, expression: Expression): Costume[] {
    return updateCostumeExpressions(costumes, costumeId, (expressions) => {
        const index = expressions.findIndex((entry) => entry.name === expression.name);
        return index >= 0
            ? expressions.map((entry, entryIndex) => (entryIndex === index ? expression : entry))
            : [...expressions, expression];
    });
}

export function renameCostumeExpression(
    costumes: Costume[],
    costumeId: string,
    currentName: string,
    nextName: string,
): Costume[] {
    return updateCostumeExpressions(costumes, costumeId, (expressions) => expressions.map((entry) => (
        entry.name === currentName ? { ...entry, name: nextName } : entry
    )));
}

export function removeCostumeExpression(costumes: Costume[], costumeId: string, name: string): Costume[] {
    return updateCostumeExpressions(costumes, costumeId, (expressions) => expressions.filter((entry) => entry.name !== name));
}

/** 2D衣装の表情名（neutral を含む）を重複なく集める。VRMの表情対応付けの候補に使う。 */
export function collectCostumeExpressionNames(costumes: Costume[]): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const name of [NEUTRAL_EXPRESSION_NAME, ...costumes.flatMap((costume) => (costume.expressions ?? []).map((expression) => expression.name))]) {
        const key = name.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        names.push(name.trim());
    }
    return names;
}

/**
 * 部屋やシチュエーションに保存された衣装の参照を衣装 id に解決する。
 * 衣装 id はそのまま使い、旧形式の衣装名は id に変換する。`default` と
 * 不明な値は未選択（デフォルト衣装に従う）として undefined を返す。
 */
export function resolveStoredCostumeReference(
    owner: CostumeOwner | null | undefined,
    value: unknown,
): string | undefined {
    if (typeof value !== 'string') return undefined;
    const reference = value.trim();
    if (!reference) return undefined;
    const costumes = owner?.costumes ?? [];
    const byId = costumes.find((costume) => costume.id === reference);
    if (byId) return byId.id;
    if (reference.toLowerCase() === 'default') return undefined;
    const byName = costumes.find((costume) => costume.name === reference)
        ?? costumes.find((costume) => costume.name.trim().toLowerCase() === reference.toLowerCase());
    return byName?.id;
}
