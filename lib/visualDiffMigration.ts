import { NEUTRAL_EXPRESSION_NAME, createCostumeId } from './costumes';
import type { Character, Costume, Expression } from './store/types';

const LEGACY_DEFAULT_COSTUME_NAME = 'default';

const matchesName = (value: string | undefined, name: string) =>
    value?.trim().toLowerCase() === name;

/** 旧形式で直下に表情を持っていたもの。 */
type LegacyCostumeOwner = {
    expressions?: unknown;
    costumes?: Costume[];
    defaultCostumeId?: string;
};

function isExpression(value: unknown): value is Expression {
    return value != null
        && typeof value === 'object'
        && typeof (value as Expression).name === 'string'
        && typeof (value as Expression).image === 'string';
}

/** 同名（大文字小文字を区別しない）の表情は `primary` 側を優先して結合する。 */
function mergeExpressions(primary: Expression[], secondary: Expression[]): Expression[] {
    const seen = new Set(primary.map((expression) => expression.name.trim().toLowerCase()));
    return [
        ...primary,
        ...secondary.filter((expression) => !seen.has(expression.name.trim().toLowerCase())),
    ];
}

/**
 * 衣装データを現行形式へ変換する。冪等で、変更がなければ同じオブジェクトを返す。
 *
 * - 全衣装に不変の id を振る（欠けている・重複しているものだけ）。
 * - 直下の `expressions` をデフォルト衣装へ移す。neutral は衣装画像になり、
 *   それ以外は `costume.expressions` に入る。デフォルト衣装が無ければ neutral
 *   （無ければ先頭の表情）の画像から `default` という名前の衣装を作る。
 *   既存のデフォルト衣装に画像がある場合は、その画像を優先する。
 * - 旧形式の予約名 `default`（大文字小文字無視）の衣装を `defaultCostumeId` にする。
 *   `default` が無く衣装だけある場合は先頭の衣装をデフォルトにする。
 */
export function migrateCostumeOwner<T extends object>(owner: T): T {
    const source = owner as T & LegacyCostumeOwner;
    const hasLegacyExpressions = 'expressions' in source;
    const legacyExpressions = Array.isArray(source.expressions)
        ? source.expressions.filter(isExpression)
        : [];
    const rawCostumes = Array.isArray(source.costumes) ? source.costumes : [];

    let changed = hasLegacyExpressions || (source.costumes !== undefined && !Array.isArray(source.costumes));
    const usedIds = new Set<string>();
    let costumes = rawCostumes.map((costume) => {
        const id = typeof costume.id === 'string' ? costume.id.trim() : '';
        if (id && !usedIds.has(id) && id === costume.id) {
            usedIds.add(id);
            return costume;
        }
        changed = true;
        const nextId = id && !usedIds.has(id) ? id : createCostumeId();
        usedIds.add(nextId);
        return { ...costume, id: nextId };
    });

    let defaultCostume = costumes.find((costume) => costume.id === source.defaultCostumeId)
        ?? costumes.find((costume) => matchesName(costume.name, LEGACY_DEFAULT_COSTUME_NAME));

    const neutral = legacyExpressions.find((expression) => matchesName(expression.name, NEUTRAL_EXPRESSION_NAME));
    const otherExpressions = legacyExpressions.filter((expression) => expression !== neutral);
    const baseImage = neutral?.image || legacyExpressions[0]?.image || '';

    if (legacyExpressions.length > 0) {
        if (defaultCostume) {
            const target = defaultCostume;
            const next: Costume = {
                ...target,
                image: target.image || baseImage,
                expressions: mergeExpressions(otherExpressions, target.expressions ?? []),
            };
            if (next.expressions?.length === 0) delete next.expressions;
            costumes = costumes.map((costume) => (costume === target ? next : costume));
            defaultCostume = next;
        } else if (baseImage) {
            const created: Costume = {
                id: createCostumeId(),
                name: LEGACY_DEFAULT_COSTUME_NAME,
                image: baseImage,
                ...(otherExpressions.length > 0 ? { expressions: otherExpressions } : {}),
            };
            costumes = [created, ...costumes];
            defaultCostume = created;
        }
    }

    defaultCostume ??= costumes[0];
    const defaultCostumeId = defaultCostume?.id;
    if (defaultCostumeId !== source.defaultCostumeId) changed = true;
    if (!changed) return owner;

    const next = { ...source } as T & LegacyCostumeOwner;
    delete next.expressions;
    if (costumes.length > 0) {
        next.costumes = costumes;
    } else {
        delete next.costumes;
    }
    if (defaultCostumeId) {
        next.defaultCostumeId = defaultCostumeId;
    } else {
        delete next.defaultCostumeId;
    }
    return next as T;
}

export function normalizeCharacterCostumeDiffs(character: Character): Character {
    return migrateCostumeOwner(character);
}

export function normalizeCharactersForCostumeDiffs(characters: Character[]): Character[] {
    let changed = false;
    const normalized = characters.map((character) => {
        const next = normalizeCharacterCostumeDiffs(character);
        if (next !== character) changed = true;
        return next;
    });
    return changed ? normalized : characters;
}
