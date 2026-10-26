import { generateId } from '../id';
import {
    DEFAULT_SITUATION_MAX_TURNS,
    MAX_SITUATION_MAX_TURNS,
    MIN_SITUATION_MAX_TURNS,
    type Character,
    type Costume,
    type Expression,
    type Room,
    type Situation,
    type SituationActor,
    type SituationMemoryMode,
    type SituationParticipant,
    type SituationPriorMessage,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object';
}

export function defaultGroupRoomName(_groupName: string, index: number): string {
    return `チャット ${index}`;
}

export function defaultCharacterRoomName(characterName: string | undefined, index: number): string {
    return `${characterName?.trim() || 'Chat'} ${index}`;
}

export function normalizeSituationMaxHistory(maxHistory: unknown): number | undefined {
    if (typeof maxHistory !== 'number' || !Number.isFinite(maxHistory)) return undefined;
    return Math.max(1, Math.min(100, Math.round(maxHistory)));
}

export function normalizeSituationMaxTurns(maxTurns: unknown): number {
    if (typeof maxTurns !== 'number' || !Number.isFinite(maxTurns)) return DEFAULT_SITUATION_MAX_TURNS;
    return Math.max(MIN_SITUATION_MAX_TURNS, Math.min(MAX_SITUATION_MAX_TURNS, Math.round(maxTurns)));
}

/** 保存済みの最大発言数。旧形式の指揮役設定（`director.maxAutoTurns` と
 * `stopPolicy: 'after-one'`）からも読み取る。 */
function storedSituationMaxTurns(situation: Situation): number {
    if (typeof situation.maxTurns === 'number') return normalizeSituationMaxTurns(situation.maxTurns);
    const legacyDirector = (situation as { director?: unknown }).director;
    if (!isRecord(legacyDirector)) return DEFAULT_SITUATION_MAX_TURNS;
    if (legacyDirector.stopPolicy === 'after-one') return 1;
    return normalizeSituationMaxTurns(legacyDirector.maxAutoTurns);
}

export function normalizeSituationActor(
    rawActor: unknown,
    validCharacterIds: Set<string>,
): SituationActor | null {
    if (!isRecord(rawActor)) return null;
    const type = rawActor.type;
    if (type === 'character') {
        const characterId = typeof rawActor.characterId === 'string' ? rawActor.characterId.trim() : '';
        if (!characterId || !validCharacterIds.has(characterId)) return null;
        const id = typeof rawActor.id === 'string' && rawActor.id.trim() ? rawActor.id.trim() : characterId;
        const costumeName = typeof rawActor.costumeName === 'string' ? rawActor.costumeName.trim() : '';
        return {
            id,
            type: 'character',
            characterId,
            ...(costumeName && costumeName.toLowerCase() !== 'default' ? { costumeName } : {}),
            ...(typeof rawActor.rolePrompt === 'string' && rawActor.rolePrompt.trim()
                ? { rolePrompt: rawActor.rolePrompt.trim() }
                : {}),
        };
    }
    if (type === 'temporary') {
        const name = typeof rawActor.name === 'string' ? rawActor.name.trim() : '';
        if (!name) return null;
        const systemPrompt = typeof rawActor.systemPrompt === 'string' ? rawActor.systemPrompt.trim() : '';
        const id = typeof rawActor.id === 'string' && rawActor.id.trim() ? rawActor.id.trim() : generateId();
        return {
            id,
            type: 'temporary',
            name,
            systemPrompt,
            ...(typeof rawActor.speechStyle === 'string' && rawActor.speechStyle.trim()
                ? { speechStyle: rawActor.speechStyle.trim() }
                : {}),
            ...(typeof rawActor.userConstraints === 'string' && rawActor.userConstraints.trim()
                ? { userConstraints: rawActor.userConstraints.trim() }
                : {}),
            ...(typeof rawActor.icon === 'string' && rawActor.icon ? { icon: rawActor.icon } : {}),
            ...(typeof rawActor.rolePrompt === 'string' && rawActor.rolePrompt.trim()
                ? { rolePrompt: rawActor.rolePrompt.trim() }
                : {}),
            ...(typeof rawActor.maxCharacters === 'number' ? { maxCharacters: rawActor.maxCharacters } : {}),
            ...(typeof rawActor.maxHistory === 'number' ? { maxHistory: rawActor.maxHistory } : {}),
            ...(Array.isArray(rawActor.expressions) ? { expressions: rawActor.expressions as Expression[] } : {}),
            ...(Array.isArray(rawActor.costumes) ? { costumes: rawActor.costumes as Costume[] } : {}),
        };
    }
    return null;
}

export function uniqueSituationActors(actors: SituationActor[]): SituationActor[] {
    const seen = new Set<string>();
    return actors.filter((actor) => {
        const key = actor.id.trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function getSituationActorIds(situation: Pick<Situation, 'actors'>): string[] {
    return situation.actors.map((actor) => actor.id);
}

export function getSituationCostumeSelections(
    actors: SituationActor[],
): Record<string, string> | undefined {
    const selections = Object.fromEntries(
        actors.flatMap((actor) => {
            if (actor.type !== 'character') return [];
            const costumeName = actor.costumeName?.trim();
            return costumeName && costumeName.toLowerCase() !== 'default'
                ? [[actor.id, costumeName] as const]
                : [];
        }),
    );
    return Object.keys(selections).length > 0 ? selections : undefined;
}

export function normalizeSituationPriorMessages(
    messages: unknown,
    validActorIds: Set<string>,
): SituationPriorMessage[] {
    if (!Array.isArray(messages)) return [];

    const usedIds = new Set<string>();
    const normalized: SituationPriorMessage[] = [];
    for (const rawMessage of messages) {
        if (!rawMessage || typeof rawMessage !== 'object') continue;
        const message = rawMessage as Partial<SituationPriorMessage>;
        const content = typeof message.content === 'string' ? message.content.trim() : '';
        if (!content || (message.role !== 'user' && message.role !== 'assistant')) continue;

        const rawId = typeof message.id === 'string' ? message.id.trim() : '';
        const id = rawId && !usedIds.has(rawId) ? rawId : generateId();
        usedIds.add(id);
        if (message.role === 'user') {
            normalized.push({ id, role: 'user', content });
            continue;
        }

        const actorId = 'actorId' in message && typeof message.actorId === 'string'
            ? message.actorId
            : '';
        if (validActorIds.has(actorId)) {
            const expression = 'expression' in message && typeof message.expression === 'string'
                ? message.expression.trim()
                : '';
            normalized.push({
                id,
                role: 'assistant',
                content,
                actorId,
                ...(expression ? { expression } : {}),
            });
        }
    }
    return normalized;
}

export function normalizeSituation(
    situation: Situation,
    validCharacterIds: Set<string>,
    now = Date.now(),
): Situation | null {
    const actors = uniqueSituationActors(
        situation.actors
            .map((actor) => normalizeSituationActor(actor, validCharacterIds))
            .filter((actor): actor is SituationActor => actor != null),
    );
    if (actors.length === 0) return null;

    const actorIds = actors.map((actor) => actor.id);
    const memoryMode: SituationMemoryMode = situation.memoryMode === 'readOnly' ? 'readOnly' : 'off';
    return {
        id: situation.id,
        name: situation.name?.trim() || 'シチュエーション',
        ...(typeof situation.backgroundImage === 'string' && situation.backgroundImage
            ? { backgroundImage: situation.backgroundImage }
            : {}),
        situationPrompt: situation.situationPrompt ?? '',
        characterCommonRules: situation.characterCommonRules ?? '',
        priorMessages: normalizeSituationPriorMessages(situation.priorMessages, new Set(actorIds)),
        actors,
        maxTurns: storedSituationMaxTurns(situation),
        memoryMode,
        maxHistory: normalizeSituationMaxHistory(situation.maxHistory),
        createdAt: situation.createdAt ?? now,
        updatedAt: situation.updatedAt ?? now,
    };
}

export function resolveSituationParticipants(
    situation: Situation | null | undefined,
    characters: Character[],
): SituationParticipant[] {
    if (!situation) return [];
    const byId = new Map(characters.map((character) => [character.id, character]));
    return situation.actors
        .map((actor): SituationParticipant | null => {
            if (actor.type === 'character') {
                const character = byId.get(actor.characterId);
                if (!character) return null;
                return {
                    ...character,
                    id: actor.id,
                    actorId: actor.id,
                    actorType: 'character',
                    sourceCharacterId: character.id,
                    rolePrompt: actor.rolePrompt,
                };
            }
            const now = Date.now();
            return {
                id: actor.id,
                actorId: actor.id,
                actorType: 'temporary',
                name: actor.name,
                systemPrompt: actor.systemPrompt,
                speechStyle: actor.speechStyle,
                userConstraints: actor.userConstraints,
                icon: actor.icon,
                maxCharacters: actor.maxCharacters,
                maxHistory: actor.maxHistory,
                enableMemory: false,
                expressions: actor.expressions,
                costumes: actor.costumes,
                createdAt: situation.createdAt ?? now,
                updatedAt: actor.id ? situation.updatedAt ?? now : now,
                rolePrompt: actor.rolePrompt,
            };
        })
        .filter((participant): participant is SituationParticipant => participant != null);
}

export function normalizeGroupData(params: {
    characters: Character[];
    groups: Situation[];
    rooms: Room[];
}): { groups: Situation[]; rooms: Room[]; changedGroups: Situation[]; changedRooms: Room[] } {
    const now = Date.now();
    const validCharacterIds = new Set(params.characters.map((character) => character.id));
    const groupsById = new Map<string, Situation>();
    const changedGroups: Situation[] = [];
    const changedRooms: Room[] = [];

    for (const group of params.groups) {
        const normalizedGroup = normalizeSituation(group, validCharacterIds, now);
        if (!normalizedGroup) continue;
        groupsById.set(normalizedGroup.id, normalizedGroup);
        if (JSON.stringify(normalizedGroup) !== JSON.stringify(group)) changedGroups.push(normalizedGroup);
    }

    const characterNames = new Map(
        params.characters.map((character) => [character.id, character.name]),
    );
    const roomOrdinals = new Map<string, number>();
    const roomCounts = new Map<string, number>();
    for (const room of [...params.rooms].sort((left, right) => (
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    ))) {
        const scope = room.groupId ? `situation:${room.groupId}` : `character:${room.characterId}`;
        const ordinal = (roomCounts.get(scope) ?? 0) + 1;
        roomCounts.set(scope, ordinal);
        roomOrdinals.set(room.id, ordinal);
    }

    const rooms = params.rooms.map((room) => {
        const ordinal = roomOrdinals.get(room.id) ?? 1;
        const trimmedName = typeof room.name === 'string' ? room.name.trim() : '';
        const normalizedName = trimmedName || (room.groupId
            ? defaultGroupRoomName(groupsById.get(room.groupId)?.name ?? '', ordinal)
            : defaultCharacterRoomName(characterNames.get(room.characterId), ordinal));
        let next: Room = normalizedName === room.name
            ? room
            : { ...room, name: normalizedName };
        let changed = next !== room;

        if (room.groupId && groupsById.has(room.groupId)) {
            const group = groupsById.get(room.groupId)!;
            const actorIds = getSituationActorIds(group);
            const costumeSelections = getSituationCostumeSelections(group.actors);
            next = {
                ...next,
                characterId: actorIds[0],
                costumeSelections,
            };
            if (
                next.characterId !== room.characterId
                || JSON.stringify(next.costumeSelections ?? {}) !== JSON.stringify(room.costumeSelections ?? {})
            ) {
                changed = true;
            }
        }
        if (changed) {
            changedRooms.push(next);
            return next;
        }
        return room;
    });

    return {
        groups: [...groupsById.values()],
        rooms,
        changedGroups,
        changedRooms,
    };
}
