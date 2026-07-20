import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, MessagesSquare, Plus, RotateCcw, Sparkles, Trash2, User, Users, X } from 'lucide-react';
import {
    Character,
    DEFAULT_CHARACTER_MAX_HISTORY,
    DEFAULT_CHARACTER_TEMPERATURE,
    DEFAULT_CHARACTER_TOP_P,
    DEFAULT_CHARACTER_TOP_K,
    Room,
    Situation,
    SituationActor,
    SituationDirector,
    SituationPriorMessage,
    useStore,
} from '@/lib/store';
import { generateId } from '@/lib/id';
import CharacterGeneratorModal from './CharacterGeneratorModal';
import SituationDescriptionGeneratorModal from './SituationDescriptionGeneratorModal';
import StoredImage from './StoredImage';

type TemporaryActorDraft = {
    id: string;
    name: string;
    systemPrompt: string;
    model: string;
    temperature: number | null;
    topP: number | null;
    topK: number | null;
};

type CharacterActorMeta = {
    id: string;
    rolePrompt?: string;
    directorDescription?: string;
};

interface SituationSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    situation?: Situation | null;
    room?: Room | null;
    onCreated?: () => void;
}

const fieldStyle: CSSProperties = {
    width: '100%',
    padding: '0.75rem 1rem',
    borderRadius: '0.5rem',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    outline: 'none',
};

const sectionLabelStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: 'var(--text-secondary)',
    fontSize: '0.875rem',
    fontWeight: 500,
};

type TemporaryActorParamKey = 'temperature' | 'topP' | 'topK';

interface TemporaryActorSliderParam {
    label: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
}

const TEMPORARY_ACTOR_SLIDER_PARAMS: Record<TemporaryActorParamKey, TemporaryActorSliderParam> = {
    temperature: { label: 'Temperature', min: 0, max: 2, step: 0.001, defaultValue: DEFAULT_CHARACTER_TEMPERATURE },
    topP: { label: 'Top P', min: 0, max: 1, step: 0.001, defaultValue: DEFAULT_CHARACTER_TOP_P ?? 1 },
    topK: { label: 'Top K', min: 0, max: 100, step: 1, defaultValue: DEFAULT_CHARACTER_TOP_K },
};

const MAX_HISTORY_SLIDER_MAX = 100;
const DEFAULT_MAX_HISTORY_SLIDER_VALUE = DEFAULT_CHARACTER_MAX_HISTORY == null
    ? MAX_HISTORY_SLIDER_MAX
    : Math.max(1, Math.min(MAX_HISTORY_SLIDER_MAX, Math.round(DEFAULT_CHARACTER_MAX_HISTORY)));
const DEFAULT_MAX_HISTORY_LABEL = DEFAULT_CHARACTER_MAX_HISTORY == null
    ? '無制限'
    : `${DEFAULT_MAX_HISTORY_SLIDER_VALUE}件`;
const RESET_MAX_HISTORY_TITLE = DEFAULT_CHARACTER_MAX_HISTORY == null
    ? '履歴上限を無制限に戻す'
    : '履歴上限をデフォルト値に戻す';

function createTemporaryDraft(): TemporaryActorDraft {
    return {
        id: generateId(),
        name: '',
        systemPrompt: '',
        model: '',
        temperature: null,
        topP: null,
        topK: null,
    };
}

function getInitialDirectorModel(situation: Situation | null | undefined, defaultDirectorModel: string): string {
    return situation?.director?.model?.trim() || defaultDirectorModel;
}

function getInitialMaxTurns(situation: Situation | null | undefined, room: Room | null | undefined): number {
    return Math.max(1, Math.min(10, room?.maxMentionChain ?? situation?.director?.maxAutoTurns ?? 3));
}

interface MaxAutoTurnsSliderProps {
    value: number;
    onChange: (value: string) => void;
}

function MaxAutoTurnsSlider({ value, onChange }: MaxAutoTurnsSliderProps) {
    const percent = ((value - 1) / (10 - 1)) * 100;

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem', gap: '0.75rem' }}>
                <label
                    htmlFor="situation-max-auto-turns"
                    style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: 'var(--text-secondary)',
                    }}
                >
                    会話の連鎖上限
                </label>
                <span
                    style={{
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: 'var(--accent-primary)',
                        minWidth: '3.5rem',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                    }}
                >
                    {value}回
                </span>
            </div>

            <div style={{ position: 'relative', height: '24px', display: 'flex', alignItems: 'center' }}>
                <div
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '4px',
                        borderRadius: '2px',
                        background: 'var(--bg-tertiary)',
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            width: `${percent}%`,
                            height: '100%',
                            background: 'var(--accent-primary)',
                            borderRadius: '2px',
                            transition: 'width 0.15s ease',
                        }}
                    />
                </div>
                <input
                    id="situation-max-auto-turns"
                    type="range"
                    aria-label="会話の連鎖上限"
                    min={1}
                    max={10}
                    step={1}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '24px',
                        opacity: 0,
                        cursor: 'pointer',
                        margin: 0,
                        padding: 0,
                        zIndex: 2,
                    }}
                />
                <div
                    style={{
                        position: 'absolute',
                        left: `calc(${percent}% - 8px)`,
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: 'var(--accent-primary)',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                        transition: 'left 0.15s ease',
                        pointerEvents: 'none',
                        zIndex: 1,
                    }}
                />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>1回</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>10回</span>
            </div>
        </div>
    );
}

interface MaxHistorySliderProps {
    value: string;
    onChange: (value: string) => void;
}

function MaxHistorySlider({ value, onChange }: MaxHistorySliderProps) {
    const isCustom = value !== '';
    const sliderValue = isCustom ? Number(value) : DEFAULT_MAX_HISTORY_SLIDER_VALUE;
    const percent = ((sliderValue - 1) / (MAX_HISTORY_SLIDER_MAX - 1)) * 100;

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem', gap: '0.75rem' }}>
                <label
                    htmlFor="situation-max-history"
                    style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: 'var(--text-secondary)',
                    }}
                >
                    履歴上限
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span
                        style={{
                            fontSize: '0.8125rem',
                            fontWeight: 600,
                            color: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                            minWidth: '3.5rem',
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {isCustom ? `${value}件` : DEFAULT_MAX_HISTORY_LABEL}
                    </span>
                    {isCustom && (
                        <button
                            type="button"
                            onClick={() => onChange('')}
                            title={RESET_MAX_HISTORY_TITLE}
                            aria-label={RESET_MAX_HISTORY_TITLE}
                            style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '2px',
                                color: 'var(--text-muted)',
                                display: 'flex',
                                alignItems: 'center',
                                borderRadius: '4px',
                                transition: 'color 0.15s ease',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                        >
                            <RotateCcw size={12} />
                        </button>
                    )}
                </div>
            </div>

            <div style={{ position: 'relative', height: '24px', display: 'flex', alignItems: 'center' }}>
                <div
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '4px',
                        borderRadius: '2px',
                        background: 'var(--bg-tertiary)',
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            width: `${percent}%`,
                            height: '100%',
                            background: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                            borderRadius: '2px',
                            transition: 'background 0.2s ease, width 0.15s ease',
                        }}
                    />
                </div>
                <input
                    id="situation-max-history"
                    type="range"
                    aria-label="履歴上限"
                    min={1}
                    max={MAX_HISTORY_SLIDER_MAX}
                    step={1}
                    value={sliderValue}
                    onChange={(e) => {
                        const next = Number(e.target.value);
                        onChange(next === DEFAULT_MAX_HISTORY_SLIDER_VALUE ? '' : String(next));
                    }}
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '24px',
                        opacity: 0,
                        cursor: 'pointer',
                        margin: 0,
                        padding: 0,
                        zIndex: 2,
                    }}
                />
                <div
                    style={{
                        position: 'absolute',
                        left: `calc(${percent}% - 8px)`,
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                        transition: 'background 0.2s ease, left 0.15s ease',
                        pointerEvents: 'none',
                        zIndex: 1,
                    }}
                />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>1件</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>100件</span>
            </div>
        </div>
    );
}

interface TemporaryActorParamSliderProps {
    paramKey: TemporaryActorParamKey;
    value: number | null;
    onChange: (value: number | null) => void;
}

function TemporaryActorParamSlider({ paramKey, value, onChange }: TemporaryActorParamSliderProps) {
    const param = TEMPORARY_ACTOR_SLIDER_PARAMS[paramKey];
    const displayValue = value ?? param.defaultValue;
    const isCustom = value !== null;
    const isInteger = param.step >= 1;
    const percent = ((displayValue - param.min) / (param.max - param.min)) * 100;
    const formatValue = (v: number) => isInteger ? String(Math.round(v)) : v.toFixed(3);

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem', gap: '0.75rem' }}>
                <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                    {param.label}
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span
                        style={{
                            fontSize: '0.8125rem',
                            fontWeight: 600,
                            color: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                            minWidth: '3.5rem',
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {formatValue(displayValue)}
                    </span>
                    {isCustom && (
                        <button
                            type="button"
                            onClick={() => onChange(null)}
                            title="デフォルト値に戻す"
                            style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '2px',
                                color: 'var(--text-muted)',
                                display: 'flex',
                                alignItems: 'center',
                                borderRadius: '4px',
                                transition: 'color 0.15s ease',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                        >
                            <RotateCcw size={12} />
                        </button>
                    )}
                </div>
            </div>

            <div style={{ position: 'relative', height: '20px', display: 'flex', alignItems: 'center' }}>
                <div
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '4px',
                        borderRadius: '2px',
                        background: 'var(--bg-tertiary)',
                        overflow: 'hidden',
                    }}
                >
                    <div
                        style={{
                            width: `${percent}%`,
                            height: '100%',
                            background: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                            borderRadius: '2px',
                            transition: 'background 0.2s ease',
                        }}
                    />
                </div>
                <input
                    type="range"
                    aria-label={param.label}
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={displayValue}
                    onChange={(e) => {
                        const next = Number(e.target.value);
                        onChange(isInteger ? Math.round(next) : Number(next.toFixed(3)));
                    }}
                    style={{
                        position: 'absolute',
                        width: '100%',
                        height: '20px',
                        opacity: 0,
                        cursor: 'pointer',
                        margin: 0,
                        padding: 0,
                        zIndex: 2,
                    }}
                />
                <div
                    style={{
                        position: 'absolute',
                        left: `calc(${percent}% - 8px)`,
                        width: '16px',
                        height: '16px',
                        borderRadius: '50%',
                        background: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                        transition: 'background 0.2s ease',
                        pointerEvents: 'none',
                        zIndex: 1,
                    }}
                />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{formatValue(param.min)}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{formatValue(param.max)}</span>
            </div>
        </div>
    );
}

function buildInitialState(
    situation: Situation | null | undefined,
    room: Room | null | undefined,
    defaultDirectorModel: string,
) {
    const selectedCharacterIds = new Set<string>();
    const characterActorMeta: Record<string, CharacterActorMeta> = {};
    const temporaryActors: TemporaryActorDraft[] = [];

    for (const actor of situation?.actors ?? []) {
        if (actor.type === 'character') {
            selectedCharacterIds.add(actor.characterId);
            characterActorMeta[actor.characterId] = {
                id: actor.id,
                rolePrompt: actor.rolePrompt,
                directorDescription: actor.directorDescription,
            };
        } else {
            temporaryActors.push({
                id: actor.id,
                name: actor.name,
                systemPrompt: actor.systemPrompt,
                model: actor.model ?? '',
                temperature: typeof actor.temperature === 'number' ? actor.temperature : null,
                topP: typeof actor.topP === 'number' ? actor.topP : null,
                topK: typeof actor.topK === 'number' ? actor.topK : null,
            });
        }
    }

    return {
        name: situation?.name ?? '',
        situationPrompt: situation?.situationPrompt ?? '',
        directorModel: getInitialDirectorModel(situation, defaultDirectorModel),
        directorReasoningMedium: situation?.director?.reasoningEffort === 'medium',
        maxAutoTurns: String(getInitialMaxTurns(situation, room)),
        maxHistory: situation?.maxHistory != null ? String(situation.maxHistory) : '',
        memoryReadOnly: situation?.memoryMode === 'readOnly',
        priorMessages: (situation?.priorMessages ?? []).map((message) => ({ ...message })),
        selectedCharacterIds,
        characterActorMeta,
        temporaryActors,
    };
}

function SituationSettingsModalForm({ onClose, situation, room, onCreated }: Omit<SituationSettingsModalProps, 'isOpen'>) {
    const {
        characters,
        defaultChatModel,
        defaultDirectorModel,
        defaultAutoGenerationModel,
        createSituationRoom,
        updateSituation,
        updateRoomSettings,
    } = useStore();

    const isEditing = !!situation;
    const sortedCharacters = useMemo(() => [...characters].sort((a, b) => b.updatedAt - a.updatedAt), [characters]);
    const initial = buildInitialState(situation, room, defaultDirectorModel);
    const [name, setName] = useState(initial.name);
    const [situationPrompt, setSituationPrompt] = useState(initial.situationPrompt);
    const [directorModel, setDirectorModel] = useState(initial.directorModel);
    const [directorReasoningMedium, setDirectorReasoningMedium] = useState(initial.directorReasoningMedium);
    const [maxAutoTurns, setMaxAutoTurns] = useState(initial.maxAutoTurns);
    const [maxHistory, setMaxHistory] = useState(initial.maxHistory);
    const [memoryReadOnly, setMemoryReadOnly] = useState(initial.memoryReadOnly);
    const [priorMessages, setPriorMessages] = useState<SituationPriorMessage[]>(initial.priorMessages);
    const [selectedCharacterIds, setSelectedCharacterIds] = useState<Set<string>>(initial.selectedCharacterIds);
    const [characterActorMeta, setCharacterActorMeta] = useState<Record<string, CharacterActorMeta>>(initial.characterActorMeta);
    const [temporaryActors, setTemporaryActors] = useState<TemporaryActorDraft[]>(initial.temporaryActors);
    const [descriptionGeneratorOpen, setDescriptionGeneratorOpen] = useState(false);
    const [temporaryActorGeneratorOpen, setTemporaryActorGeneratorOpen] = useState(false);
    const [expandedTemporaryActorParams, setExpandedTemporaryActorParams] = useState<Set<string>>(new Set());

    const validTemporaryActors = useMemo(
        () => temporaryActors.filter((actor) => actor.name.trim()),
        [temporaryActors],
    );
    const actorCount = selectedCharacterIds.size + validTemporaryActors.length;
    const parsedMaxTurns = Math.max(1, Math.min(10, Math.round(Number(maxAutoTurns) || 3)));
    const effectiveMaxTurns = actorCount <= 1 ? 1 : parsedMaxTurns;
    const parsedMaxHistory = maxHistory ? Math.max(1, Math.min(100, Math.round(Number(maxHistory)))) : undefined;
    const participantNames = useMemo(() => [
        ...characters
            .filter((character) => selectedCharacterIds.has(character.id))
            .map((character) => character.name.trim())
            .filter(Boolean),
        ...temporaryActors
            .map((actor) => actor.name.trim())
            .filter(Boolean),
    ], [characters, selectedCharacterIds, temporaryActors]);
    const actorOptions = useMemo(() => [
        ...characters
            .filter((character) => selectedCharacterIds.has(character.id))
            .map((character) => ({
                id: characterActorMeta[character.id]?.id || character.id,
                name: character.name.trim() || '名前なし',
                icon: character.icon,
            })),
        ...temporaryActors
            .filter((actor) => actor.name.trim())
            .map((actor) => ({ id: actor.id, name: actor.name.trim(), icon: undefined })),
    ], [characterActorMeta, characters, selectedCharacterIds, temporaryActors]);

    const toggleCharacter = (character: Character) => {
        const willSelect = !selectedCharacterIds.has(character.id);
        setSelectedCharacterIds((prev) => {
            const next = new Set(prev);
            if (next.has(character.id)) {
                next.delete(character.id);
            } else {
                next.add(character.id);
            }
            return next;
        });
        if (willSelect) {
            setCharacterActorMeta((meta) => ({
                ...meta,
                [character.id]: meta[character.id] ?? { id: character.id },
            }));
        }
    };

    const addTemporaryActor = () => {
        setTemporaryActors((prev) => [...prev, createTemporaryDraft()]);
    };

    const addGeneratedTemporaryActor = (draft: { name: string; systemPrompt: string }) => {
        setTemporaryActors((prev) => [
            ...prev,
            {
                id: generateId(),
                name: draft.name,
                systemPrompt: draft.systemPrompt,
                model: '',
                temperature: null,
                topP: null,
                topK: null,
            },
        ]);
        setTemporaryActorGeneratorOpen(false);
    };

    const updateTemporaryActor = (id: string, updates: Partial<TemporaryActorDraft>) => {
        setTemporaryActors((prev) => prev.map((actor) => (
            actor.id === id ? { ...actor, ...updates } : actor
        )));
    };

    const removeTemporaryActor = (id: string) => {
        setTemporaryActors((prev) => prev.filter((actor) => actor.id !== id));
        setExpandedTemporaryActorParams((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    };

    const toggleTemporaryActorParams = (id: string) => {
        setExpandedTemporaryActorParams((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const addPriorMessage = (role: SituationPriorMessage['role']) => {
        const id = generateId();
        setPriorMessages((messages) => [
            ...messages,
            role === 'assistant'
                ? { id, role, content: '', actorId: actorOptions[0]?.id ?? '' }
                : { id, role, content: '' },
        ]);
    };

    const updatePriorMessageContent = (id: string, content: string) => {
        setPriorMessages((messages) => messages.map((message) => (
            message.id === id ? { ...message, content } : message
        )));
    };

    const updatePriorMessageActor = (id: string, actorId: string) => {
        setPriorMessages((messages) => messages.map((message) => (
            message.id === id && message.role === 'assistant'
                ? { ...message, actorId }
                : message
        )));
    };

    const removePriorMessage = (id: string) => {
        setPriorMessages((messages) => messages.filter((message) => message.id !== id));
    };

    const movePriorMessage = (index: number, offset: -1 | 1) => {
        setPriorMessages((messages) => {
            const targetIndex = index + offset;
            if (targetIndex < 0 || targetIndex >= messages.length) return messages;
            const next = [...messages];
            [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
            return next;
        });
    };

    const renderPriorMessageActions = (messageId: string, index: number) => (
        <div style={{ display: 'flex', flexShrink: 0 }}>
            <button
                type="button"
                className="btn btn-ghost"
                onClick={() => movePriorMessage(index, -1)}
                disabled={index === 0}
                title="上へ移動"
                aria-label={`${index + 1}件目を上へ移動`}
                style={{ width: 30, height: 30, padding: 0 }}
            >
                <ChevronUp size={15} />
            </button>
            <button
                type="button"
                className="btn btn-ghost"
                onClick={() => movePriorMessage(index, 1)}
                disabled={index === priorMessages.length - 1}
                title="下へ移動"
                aria-label={`${index + 1}件目を下へ移動`}
                style={{ width: 30, height: 30, padding: 0 }}
            >
                <ChevronDown size={15} />
            </button>
            <button
                type="button"
                className="btn btn-ghost"
                onClick={() => removePriorMessage(messageId)}
                title="削除"
                aria-label={`${index + 1}件目を削除`}
                style={{ width: 30, height: 30, padding: 0, color: 'var(--error)' }}
            >
                <Trash2 size={15} />
            </button>
        </div>
    );

    const buildActors = useCallback((): SituationActor[] => [
        ...Array.from(selectedCharacterIds).map((characterId) => {
            const meta = characterActorMeta[characterId];
            return {
                id: meta?.id || characterId,
                type: 'character' as const,
                characterId,
                ...(meta?.rolePrompt ? { rolePrompt: meta.rolePrompt } : {}),
                ...(meta?.directorDescription ? { directorDescription: meta.directorDescription } : {}),
            };
        }),
        ...validTemporaryActors.map((actor) => ({
            id: actor.id,
            type: 'temporary' as const,
            name: actor.name.trim(),
            systemPrompt: actor.systemPrompt.trim(),
            model: actor.model.trim() || defaultChatModel,
            ...(actor.temperature !== null ? { temperature: actor.temperature } : {}),
            ...(actor.topP !== null ? { topP: actor.topP } : {}),
            ...(actor.topK !== null ? { topK: actor.topK } : {}),
        })),
    ], [characterActorMeta, defaultChatModel, selectedCharacterIds, validTemporaryActors]);

    const saveAndClose = useCallback(() => {
        const director: SituationDirector = {
            ...(situation?.director ?? {}),
            enabled: true,
            model: directorModel.trim() || defaultDirectorModel,
            reasoningEffort: directorReasoningMedium ? 'medium' : 'none',
            maxAutoTurns: effectiveMaxTurns,
            stopPolicy: situation?.director?.stopPolicy === 'after-one' ? 'after-one' : 'max-turns',
        };
        const actors = buildActors();
        const effectiveActors = actors.length > 0 ? actors : situation?.actors ?? [];
        const validActorIds = new Set(effectiveActors.map((actor) => actor.id));
        const fallbackActorId = effectiveActors[0]?.id ?? '';
        const priorMessagesForSave = priorMessages.map((message) => (
            message.role === 'assistant' && !validActorIds.has(message.actorId)
                ? { ...message, actorId: fallbackActorId }
                : message
        ));

        if (situation) {
            updateSituation(situation.id, {
                name: name.trim() || 'シチュエーション',
                situationPrompt: situationPrompt.trim(),
                priorMessages: priorMessagesForSave,
                actors,
                director,
                memoryMode: memoryReadOnly ? 'readOnly' : 'off',
                maxHistory: parsedMaxHistory,
            });
            if (room?.id) {
                updateRoomSettings(room.id, { maxMentionChain: effectiveMaxTurns });
            }
        } else if (actorCount > 0) {
            createSituationRoom({
                name: name.trim() || undefined,
                situationPrompt: situationPrompt.trim(),
                priorMessages: priorMessagesForSave,
                actors,
                director,
                memoryMode: memoryReadOnly ? 'readOnly' : 'off',
                maxHistory: parsedMaxHistory,
            });
            onCreated?.();
        }

        onClose();
    }, [actorCount, buildActors, createSituationRoom, defaultDirectorModel, directorModel, directorReasoningMedium, effectiveMaxTurns, memoryReadOnly, name, onClose, onCreated, parsedMaxHistory, priorMessages, room, situation, situationPrompt, updateRoomSettings, updateSituation]);

    useEffect(() => {
        const childModalOpen = descriptionGeneratorOpen || temporaryActorGeneratorOpen;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !childModalOpen) {
                if (isEditing) {
                    saveAndClose();
                } else {
                    onClose();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [descriptionGeneratorOpen, isEditing, onClose, saveAndClose, temporaryActorGeneratorOpen]);

    return (
        <>
            <div
                className="modal-overlay"
                onPointerDown={(e) => {
                    if (e.target === e.currentTarget) {
                        if (isEditing) {
                            saveAndClose();
                        } else {
                            onClose();
                        }
                    }
                }}
            >
                <div
                    className="modal-content settings-form-modal"
                    onClick={(e) => e.stopPropagation()}
                    style={{ maxWidth: 720 }}
                    role="dialog"
                    aria-modal="true"
                    aria-label={isEditing ? 'シチュエーション設定' : '新しいシチュエーション'}
                >
                <div className="settings-form-modal-actions">
                    {isEditing ? (
                        <button className="btn btn-ghost" onClick={saveAndClose} aria-label="閉じて保存" title="閉じて保存">
                            <X size={20} />
                        </button>
                    ) : (
                        <button
                            className="btn btn-primary settings-form-modal-save"
                            onClick={saveAndClose}
                            disabled={actorCount < 1}
                        >
                            保存
                        </button>
                    )}
                </div>

                <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', minWidth: 0 }}>
                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>名前</span>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="シチュエーション名"
                                style={fieldStyle}
                            />
                        </label>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                            <label htmlFor="situation-prompt-input" style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                                シチュエーションの説明
                            </label>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => setDescriptionGeneratorOpen(true)}
                                title="AIでシチュエーション説明を生成"
                                aria-label="AIでシチュエーション説明を生成"
                                style={{ width: 30, height: 30, padding: 0, flexShrink: 0 }}
                            >
                                <Sparkles size={15} />
                            </button>
                        </div>
                        <textarea
                            id="situation-prompt-input"
                            value={situationPrompt}
                            onChange={(e) => setSituationPrompt(e.target.value)}
                            rows={5}
                            placeholder="舞台、関係性、開始時点の状況"
                            style={{ ...fieldStyle, resize: 'vertical', minHeight: 120 }}
                        />
                    </div>

                    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={sectionLabelStyle}>
                                <MessagesSquare size={16} />
                                直前の会話
                            </div>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                すべてのルームで会話履歴の先頭に使用されます。チャット画面には表示されません。
                            </span>
                        </div>

                        <div
                            style={{
                                overflow: 'hidden',
                                border: '1px solid var(--border-color)',
                                borderRadius: '0.75rem',
                                background: 'var(--bg-primary)',
                            }}
                        >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', minHeight: 150, padding: '1rem' }}>
                                {priorMessages.length === 0 ? (
                                    <div
                                        style={{
                                            display: 'flex',
                                            flex: 1,
                                            minHeight: 118,
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            color: 'var(--text-muted)',
                                            fontSize: '0.8125rem',
                                            textAlign: 'center',
                                        }}
                                    >
                                        直前の会話は設定されていません。
                                    </div>
                                ) : priorMessages.map((message, index) => {
                                    if (message.role === 'user') {
                                        return (
                                            <div key={message.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', width: '80%', gap: '0.375rem' }}>
                                                    <span style={{ marginRight: 'auto', paddingLeft: '0.25rem', color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 500 }}>
                                                        主人公
                                                    </span>
                                                    {renderPriorMessageActions(message.id, index)}
                                                </div>
                                                <div className="message-bubble user" style={{ width: '80%', maxWidth: '80%', padding: '0.65rem 0.875rem' }}>
                                                    <textarea
                                                        value={message.content}
                                                        onChange={(event) => updatePriorMessageContent(message.id, event.target.value)}
                                                        rows={3}
                                                        placeholder="主人公の発言"
                                                        aria-label={`${index + 1}件目の主人公の発言`}
                                                        style={{
                                                            display: 'block',
                                                            width: '100%',
                                                            minHeight: 72,
                                                            padding: 0,
                                                            resize: 'vertical',
                                                            border: 'none',
                                                            outline: 'none',
                                                            background: 'transparent',
                                                            color: 'inherit',
                                                            font: 'inherit',
                                                            lineHeight: 1.5,
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    }

                                    const selectedActor = actorOptions.find((actor) => actor.id === message.actorId) ?? actorOptions[0];
                                    return (
                                        <div key={message.id} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.625rem' }}>
                                            <div
                                                style={{
                                                    width: 36,
                                                    height: 36,
                                                    marginTop: 30,
                                                    overflow: 'hidden',
                                                    flexShrink: 0,
                                                    borderRadius: '50%',
                                                    background: 'var(--bg-tertiary)',
                                                    border: '1px solid var(--border-color)',
                                                }}
                                            >
                                                {selectedActor?.icon ? (
                                                    <StoredImage src={selectedActor.icon} alt={selectedActor.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                ) : (
                                                    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', fontWeight: 600 }}>
                                                        {selectedActor?.name.charAt(0) || '?'}
                                                    </div>
                                                )}
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', width: '80%', maxWidth: '80%', minWidth: 0, gap: '0.25rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                                    <select
                                                        value={selectedActor?.id ?? ''}
                                                        onChange={(event) => updatePriorMessageActor(message.id, event.target.value)}
                                                        aria-label={`${index + 1}件目の発言キャラクター`}
                                                        style={{
                                                            minWidth: 0,
                                                            maxWidth: '60%',
                                                            padding: '0.25rem 0.375rem',
                                                            border: 'none',
                                                            borderRadius: '0.375rem',
                                                            outline: 'none',
                                                            background: 'transparent',
                                                            color: 'var(--text-muted)',
                                                            fontSize: '0.75rem',
                                                            fontWeight: 500,
                                                        }}
                                                    >
                                                        {actorOptions.map((actor) => (
                                                            <option key={actor.id} value={actor.id}>{actor.name}</option>
                                                        ))}
                                                    </select>
                                                    <div style={{ marginLeft: 'auto' }}>
                                                        {renderPriorMessageActions(message.id, index)}
                                                    </div>
                                                </div>
                                                <div className="message-bubble assistant" style={{ display: 'block', width: '100%', maxWidth: '100%', padding: '0.65rem 0.875rem' }}>
                                                    <textarea
                                                        value={message.content}
                                                        onChange={(event) => updatePriorMessageContent(message.id, event.target.value)}
                                                        rows={3}
                                                        placeholder="キャラクターの発言"
                                                        aria-label={`${index + 1}件目のキャラクターの発言`}
                                                        style={{
                                                            display: 'block',
                                                            width: '100%',
                                                            minHeight: 72,
                                                            padding: 0,
                                                            resize: 'vertical',
                                                            border: 'none',
                                                            outline: 'none',
                                                            background: 'transparent',
                                                            color: 'inherit',
                                                            font: 'inherit',
                                                            lineHeight: 1.5,
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', padding: '0.75rem', borderTop: '1px solid var(--border-color)', background: 'var(--bg-secondary)', flexWrap: 'wrap' }}>
                                <button type="button" className="btn btn-secondary" onClick={() => addPriorMessage('user')}>
                                    <Plus size={15} />
                                    主人公の発言
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => addPriorMessage('assistant')}
                                    disabled={actorOptions.length === 0}
                                    title={actorOptions.length === 0 ? '先に参加者を追加してください' : undefined}
                                >
                                    <Plus size={15} />
                                    キャラクターの発言
                                </button>
                            </div>
                        </div>
                    </section>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', minWidth: 0 }}>
                            <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>このシチュエーションを制御するモデル</span>
                            <input
                                type="text"
                                value={directorModel}
                                onChange={(e) => setDirectorModel(e.target.value)}
                                placeholder={defaultDirectorModel}
                                style={fieldStyle}
                            />
                        </label>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minHeight: 38, justifyContent: 'end' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={directorReasoningMedium}
                                    onChange={(e) => setDirectorReasoningMedium(e.target.checked)}
                                    style={{ accentColor: 'var(--primary)' }}
                                />
                                少し考える
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                                <input
                                    type="checkbox"
                                    checked={memoryReadOnly}
                                    onChange={(e) => setMemoryReadOnly(e.target.checked)}
                                    style={{ accentColor: 'var(--primary)' }}
                                />
                                メモリの参照
                            </label>
                        </div>
                    </div>

                    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={sectionLabelStyle}>
                            <Users size={16} />
                            既存キャラクター
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))', gap: '0.375rem' }}>
                            {sortedCharacters.map((character) => {
                                const checked = selectedCharacterIds.has(character.id);
                                return (
                                    <button
                                        key={character.id}
                                        type="button"
                                        onClick={() => toggleCharacter(character)}
                                        aria-pressed={checked}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.5rem',
                                            padding: '0.5rem',
                                            borderRadius: '0.5rem',
                                            border: `1px solid ${checked ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                            background: checked ? 'rgba(var(--accent-primary-rgb), 0.1)' : 'var(--bg-tertiary)',
                                            cursor: 'pointer',
                                            minWidth: 0,
                                            textAlign: 'left',
                                            color: 'inherit',
                                            font: 'inherit',
                                        }}
                                    >
                                        <div style={{ width: 24, height: 24, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            {character.icon ? (
                                                <StoredImage src={character.icon} alt={character.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            ) : (
                                                <User size={15} style={{ color: 'var(--text-muted)' }} />
                                            )}
                                        </div>
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.875rem' }}>
                                            {character.name}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                            <div style={sectionLabelStyle}>
                                <User size={16} />
                                その他の登場人物
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <button type="button" className="btn btn-secondary" onClick={() => setTemporaryActorGeneratorOpen(true)}>
                                    <Sparkles size={16} />
                                    AI生成
                                </button>
                                <button type="button" className="btn btn-secondary" onClick={addTemporaryActor}>
                                    <Plus size={16} />
                                    追加
                                </button>
                            </div>
                        </div>

                        {temporaryActors.map((actor) => {
                            const paramsExpanded = expandedTemporaryActorParams.has(actor.id);
                            const hasCustomParams = actor.temperature !== null || actor.topP !== null || actor.topK !== null;
                            return (
                                <div
                                    key={actor.id}
                                    style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '0.5rem',
                                        padding: '0.75rem',
                                        border: '1px solid var(--border-color)',
                                        borderRadius: '0.5rem',
                                        background: 'var(--bg-secondary)',
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <input
                                            type="text"
                                            value={actor.name}
                                            onChange={(e) => updateTemporaryActor(actor.id, { name: e.target.value })}
                                            placeholder="名前"
                                            style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
                                        />
                                        <button type="button" className="btn btn-ghost" onClick={() => removeTemporaryActor(actor.id)} style={{ padding: '0.5rem', color: 'var(--error)' }} title="削除">
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                    <textarea
                                        value={actor.systemPrompt}
                                        onChange={(e) => updateTemporaryActor(actor.id, { systemPrompt: e.target.value })}
                                        rows={3}
                                        placeholder="キャラクター設定"
                                        style={{ ...fieldStyle, resize: 'vertical' }}
                                    />
                                    <input
                                        type="text"
                                        value={actor.model}
                                        onChange={(e) => updateTemporaryActor(actor.id, { model: e.target.value })}
                                        placeholder={`モデル (${defaultChatModel})`}
                                        style={fieldStyle}
                                    />
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: paramsExpanded ? '0.75rem' : 0, paddingTop: '0.25rem' }}>
                                        <button
                                            type="button"
                                            onClick={() => toggleTemporaryActorParams(actor.id)}
                                            aria-expanded={paramsExpanded}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: '0.75rem',
                                                width: '100%',
                                                padding: '0.5rem 0',
                                                border: 'none',
                                                background: 'transparent',
                                                color: 'var(--text-secondary)',
                                                cursor: 'pointer',
                                                textAlign: 'left',
                                            }}
                                        >
                                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', minWidth: 0 }}>
                                                {paramsExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                                                <span style={{ fontSize: '0.8125rem', fontWeight: 500 }}>
                                                    生成パラメータ
                                                </span>
                                            </span>
                                            {hasCustomParams && (
                                                <span style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', flexShrink: 0 }}>
                                                    カスタム
                                                </span>
                                            )}
                                        </button>
                                        {paramsExpanded && (
                                            <>
                                                <TemporaryActorParamSlider
                                                    paramKey="temperature"
                                                    value={actor.temperature}
                                                    onChange={(value) => updateTemporaryActor(actor.id, { temperature: value })}
                                                />
                                                <TemporaryActorParamSlider
                                                    paramKey="topP"
                                                    value={actor.topP}
                                                    onChange={(value) => updateTemporaryActor(actor.id, { topP: value })}
                                                />
                                                <TemporaryActorParamSlider
                                                    paramKey="topK"
                                                    value={actor.topK}
                                                    onChange={(value) => updateTemporaryActor(actor.id, { topK: value })}
                                                />
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </section>

                    <section
                        style={{
                            padding: '1rem',
                            borderRadius: '0.5rem',
                            background: 'var(--bg-secondary)',
                        }}
                    >
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            {actorCount > 1 && (
                                <MaxAutoTurnsSlider value={parsedMaxTurns} onChange={setMaxAutoTurns} />
                            )}
                            <MaxHistorySlider value={maxHistory} onChange={setMaxHistory} />
                        </div>
                    </section>
                </div>

            </div>
            </div>

            <SituationDescriptionGeneratorModal
                isOpen={descriptionGeneratorOpen}
                onClose={() => setDescriptionGeneratorOpen(false)}
                onApply={(description) => {
                    setSituationPrompt(description);
                    setDescriptionGeneratorOpen(false);
                }}
                initialDirection={situationPrompt}
                currentDescription={situationPrompt}
                situationName={name}
                participants={participantNames}
                initialModel={defaultAutoGenerationModel}
            />

            <CharacterGeneratorModal
                isOpen={temporaryActorGeneratorOpen}
                onClose={() => setTemporaryActorGeneratorOpen(false)}
                onApply={addGeneratedTemporaryActor}
            />
        </>
    );
}

export default function SituationSettingsModal({ isOpen, onClose, situation, room, onCreated }: SituationSettingsModalProps) {
    if (!isOpen) return null;

    const formKey = [
        situation?.id ?? 'new',
        situation?.updatedAt ?? 0,
        room?.id ?? '',
        room?.maxMentionChain ?? '',
    ].join(':');

    return (
        <SituationSettingsModalForm
            key={formKey}
            onClose={onClose}
            situation={situation}
            room={room}
            onCreated={onCreated}
        />
    );
}
