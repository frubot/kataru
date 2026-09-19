import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react';
import { X, ChevronDown, ChevronRight, RotateCcw, User, Info, ImagePlus, Shirt, Smile } from 'lucide-react';
import type { GeneratedCharacterDraft } from '@/lib/characterGeneration';
import {
    useStore,
    Character,
    Costume,
    Expression,
    DEFAULT_CHARACTER_MAX_HISTORY,
    DEFAULT_CHARACTER_MAX_CHARACTERS,
    DEFAULT_CHARACTER_TEMPERATURE,
    DEFAULT_CHARACTER_TOP_P,
    DEFAULT_CHARACTER_TOP_K,
    DEFAULT_CHARACTER_FREQUENCY_PENALTY,
    DEFAULT_CHARACTER_PRESENCE_PENALTY,
    DEFAULT_CHARACTER_REPETITION_PENALTY,
} from '@/lib/store';
import { modelRefsEqual, type ModelRef } from '@/lib/modelDefaults';
import ImageGenerationModal from './ImageGenerationModal';
import ExpressionDiffModal from './ExpressionDiffModal';
import CostumeDiffModal from './CostumeDiffModal';
import PromptSectionEditor from './PromptSectionEditor';
import StoredImage from './StoredImage';
import ModelSelector from './ModelSelector';
import TtsVoiceField from './TtsVoiceField';
import TtsSpeedSlider, { formatTtsSpeed } from './TtsSpeedSlider';
import TtsPreviewButton from './TtsPreviewButton';
import { useModalKeyboard } from './useModalKeyboard';
import { resolveTtsProfile } from '@/lib/tts';
import { getVrmExpressionNames } from '@/lib/vrm';

const VrmAvatarView = lazy(() => import('./VrmAvatarView'));

const NEUTRAL_NAME = 'neutral';
const DEFAULT_COSTUME_NAME = 'default';
const CHARACTER_PROMPT_SECTION_TITLE = 'プロフィール';
const SPEECH_STYLE_SECTION_TITLE = '口調';
const PROTAGONIST_PROMPT_SECTION_TITLE = '主人公について';
const USER_CONSTRAINTS_SECTION_TITLE = '追加の制約';

interface CharacterSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    character: Character | null;
    isNew?: boolean;
    initialGeneratedDraft?: GeneratedCharacterDraft | null;
    onOpenMemoryList?: () => void;
}

function buildInitialCharacterDraft(
    character: Character | null,
    defaultChatModel: ModelRef,
    generatedDraft?: GeneratedCharacterDraft | null,
) {
    return {
        name: generatedDraft?.name ?? character?.name ?? '',
        systemPrompt: generatedDraft?.systemPrompt ?? character?.systemPrompt ?? '',
        speechStyle: generatedDraft?.speechStyle ?? character?.speechStyle ?? '',
        protagonistPrompt: generatedDraft?.protagonistPrompt ?? character?.protagonistPrompt ?? '',
        userConstraints: character?.userConstraints ?? '',
        model: character?.model.model.trim() ? character.model : defaultChatModel,
        enableThinking: character?.enableThinking ?? false,
        enableMemory: character?.enableMemory ?? true,
        maxCharacters: character?.maxCharacters != null ? String(character.maxCharacters) : '',
        maxHistory: character?.maxHistory != null ? String(character.maxHistory) : '',
        temperature: character?.temperature ?? null,
        topP: character?.topP ?? null,
        topK: character?.topK ?? null,
        frequencyPenalty: character?.frequencyPenalty ?? null,
        presencePenalty: character?.presencePenalty ?? null,
        repetitionPenalty: character?.repetitionPenalty ?? null,
        icon: character?.icon ?? null,
        expressions: character?.expressions ?? [],
        costumes: character?.costumes ?? [],
        ttsVoice: character?.tts?.voice ?? '',
        ttsSpeed: character?.tts?.speed,
    };
}

// ---- スライダーパラメータ定義 ----
interface SliderParam {
    label: string;
    hint: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
}

const SLIDER_PARAMS: Record<string, SliderParam> = {
    temperature: { label: 'Temperature', hint: '値が高いほどランダム性が増します', min: 0, max: 2, step: 0.001, defaultValue: DEFAULT_CHARACTER_TEMPERATURE },
    topP:        { label: 'Top P',        hint: '核サンプリングの確率閾値',          min: 0, max: 1, step: 0.001, defaultValue: DEFAULT_CHARACTER_TOP_P ?? 1.000 },
    topK:        { label: 'Top K',        hint: '上位K個の候補からサンプリング。0で無効',         min: 0, max: 100, step: 1, defaultValue: DEFAULT_CHARACTER_TOP_K },
    frequencyPenalty: { label: 'Frequency Penalty', hint: '出現回数に応じて同じ語句の繰り返しを抑えます。0で無効、負の値で繰り返しを促します。対応モデルのみ有効で、Anthropic APIでは使用しません。', min: -2, max: 2, step: 0.001, defaultValue: DEFAULT_CHARACTER_FREQUENCY_PENALTY },
    presencePenalty: { label: 'Presence Penalty', hint: '一度出現した語句の再使用を抑えます。0で無効、負の値で再使用を促します。対応モデルのみ有効で、Anthropic APIでは使用しません。', min: -2, max: 2, step: 0.001, defaultValue: DEFAULT_CHARACTER_PRESENCE_PENALTY },
    repetitionPenalty: { label: 'Repetition Penalty', hint: '1で無効、1より大きい値で繰り返しを抑え、1未満で促します。OpenRouterの対応モデルのみ有効です。', min: 0, max: 2, step: 0.001, defaultValue: DEFAULT_CHARACTER_REPETITION_PENALTY },
};

const MAX_HISTORY_SLIDER_MAX = 100;
const DEFAULT_MAX_HISTORY_SLIDER_VALUE = DEFAULT_CHARACTER_MAX_HISTORY == null
    ? MAX_HISTORY_SLIDER_MAX
    : Math.max(1, Math.min(MAX_HISTORY_SLIDER_MAX, Math.round(DEFAULT_CHARACTER_MAX_HISTORY)));
const DEFAULT_MAX_CHARACTERS_PLACEHOLDER = `デフォルト（${DEFAULT_CHARACTER_MAX_CHARACTERS}）`;
const DEFAULT_MAX_HISTORY_LABEL = DEFAULT_CHARACTER_MAX_HISTORY == null
    ? '無制限'
    : `${DEFAULT_MAX_HISTORY_SLIDER_VALUE} 件`;
const RESET_MAX_HISTORY_TITLE = DEFAULT_CHARACTER_MAX_HISTORY == null
    ? '無制限に戻す'
    : 'デフォルト値に戻す';

interface InfoButtonProps {
    text: string;
    ariaLabel?: string;
}

function InfoButton({ text, ariaLabel = '説明を表示' }: InfoButtonProps) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <button
                type="button"
                aria-label={ariaLabel}
                aria-expanded={isOpen}
                title={ariaLabel}
                onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen((prev) => !prev);
                }}
                onBlur={() => setIsOpen(false)}
                style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    border: '1px solid var(--border-color)',
                    background: isOpen ? 'rgba(var(--accent-primary-rgb), 0.12)' : 'var(--bg-secondary)',
                    color: isOpen ? 'var(--accent-primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                    flexShrink: 0,
                }}
            >
                <Info size={13} />
            </button>
            {isOpen && (
                <span
                    role="tooltip"
                    style={{
                        position: 'absolute',
                        top: 'calc(100% + 0.375rem)',
                        left: 0,
                        zIndex: 30,
                        width: 'min(240px, 70vw)',
                        padding: '0.625rem 0.75rem',
                        borderRadius: '0.5rem',
                        border: '1px solid var(--border-color)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-secondary)',
                        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
                        fontSize: '0.75rem',
                        lineHeight: 1.5,
                        fontWeight: 400,
                        textAlign: 'left',
                        whiteSpace: 'normal',
                    }}
                >
                    {text}
                </span>
            )}
        </span>
    );
}

// ---- スライダーコンポーネント ----
interface ParamSliderProps {
    paramKey: string;
    value: number | null;
    onChange: (v: number | null) => void;
}

function ParamSlider({ paramKey, value, onChange }: ParamSliderProps) {
    const param = SLIDER_PARAMS[paramKey];
    const displayValue = value ?? param.defaultValue;
    const isCustom = value !== null;
    const isInteger = param.step >= 1;
    const formatValue = (v: number) => isInteger ? String(Math.round(v)) : v.toFixed(3);

    const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const next = parseFloat(e.target.value);
        onChange(isInteger ? Math.round(next) : parseFloat(next.toFixed(3)));
    };

    const handleReset = () => {
        onChange(null);
    };

    const percent = ((displayValue - param.min) / (param.max - param.min)) * 100;

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    <label style={{
                        fontSize: '0.8125rem',
                        fontWeight: 500,
                        color: 'var(--text-secondary)',
                    }}>
                        {param.label}
                    </label>
                    <InfoButton text={param.hint} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        color: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                        minWidth: '3.5rem',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                    }}>
                        {formatValue(displayValue)}
                    </span>
                    {isCustom && (
                        <button
                            type="button"
                            onClick={handleReset}
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
                            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                        >
                            <RotateCcw size={12} />
                        </button>
                    )}
                </div>
            </div>

            {/* スライダートラック */}
            <div style={{ position: 'relative', height: '20px', display: 'flex', alignItems: 'center' }}>
                {/* 背景トラック */}
                <div style={{
                    position: 'absolute',
                    width: '100%',
                    height: '4px',
                    borderRadius: '2px',
                    background: 'var(--bg-tertiary)',
                    overflow: 'hidden',
                }}>
                    {/* 塗りつぶし部分 */}
                    <div style={{
                        width: `${percent}%`,
                        height: '100%',
                        background: isCustom
                            ? 'var(--accent-primary)'
                            : 'var(--text-muted)',
                        borderRadius: '2px',
                        transition: 'background 0.2s ease',
                    }} />
                </div>

                {/* Native range input (透過して重ねる) */}
                <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={displayValue}
                    onChange={handleSliderChange}
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

                {/* サム（ハンドル） */}
                <div style={{
                    position: 'absolute',
                    left: `calc(${percent}% - 8px)`,
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                    transition: 'background 0.2s ease, transform 0.1s ease',
                    pointerEvents: 'none',
                    zIndex: 1,
                }} />
            </div>

            {/* 最小・最大ラベル */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: '0.25rem',
            }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{formatValue(param.min)}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{formatValue(param.max)}</span>
            </div>
        </div>
    );
}

// ---- メインコンポーネント ----
export default function CharacterSettingsModal(props: CharacterSettingsModalProps) {
    const { isOpen, character, isNew = false } = props;

    if (!isOpen) return null;

    const draftKey = isNew ? 'new-character' : `character:${character?.id ?? 'missing'}`;
    return <CharacterSettingsModalContent key={draftKey} {...props} />;
}

function CharacterSettingsModalContent({
    isOpen,
    onClose,
    character,
    isNew = false,
    initialGeneratedDraft,
    onOpenMemoryList,
}: CharacterSettingsModalProps) {
    const { createCharacter, updateCharacter, defaultChatModel, ttsConnectionId, ttsSpeed: defaultTtsSpeed } = useStore();
    const [initialDraft] = useState(() => buildInitialCharacterDraft(
        character,
        defaultChatModel,
        initialGeneratedDraft,
    ));
    const [name, setName] = useState(initialDraft.name);
    const [systemPrompt, setSystemPrompt] = useState(initialDraft.systemPrompt);
    const [speechStyle, setSpeechStyle] = useState(initialDraft.speechStyle);
    const [protagonistPrompt, setProtagonistPrompt] = useState(initialDraft.protagonistPrompt);
    const [userConstraints, setUserConstraints] = useState(initialDraft.userConstraints);
    const [model, setModel] = useState<ModelRef>(initialDraft.model);

    // Thinking settings
    const [enableThinking, setEnableThinking] = useState(initialDraft.enableThinking);

    // Memory settings
    const [enableMemory, setEnableMemory] = useState(initialDraft.enableMemory);

    // Parameter settings
    const [parametersOpen, setParametersOpen] = useState(false);
    const [maxCharacters, setMaxCharacters] = useState<string>(initialDraft.maxCharacters);
    const [maxHistory, setMaxHistory] = useState<string>(initialDraft.maxHistory);
    // null = use code default, number = custom value
    const [temperature, setTemperature] = useState<number | null>(initialDraft.temperature);
    const [topP, setTopP] = useState<number | null>(initialDraft.topP);
    const [topK, setTopK] = useState<number | null>(initialDraft.topK);
    const [frequencyPenalty, setFrequencyPenalty] = useState<number | null>(initialDraft.frequencyPenalty);
    const [presencePenalty, setPresencePenalty] = useState<number | null>(initialDraft.presencePenalty);
    const [repetitionPenalty, setRepetitionPenalty] = useState<number | null>(initialDraft.repetitionPenalty);

    // Avatar
    const [icon, setIcon] = useState<string | null>(initialDraft.icon);

    // Expressions
    const [expressions, setExpressions] = useState<Expression[]>(initialDraft.expressions);
    const [costumes, setCostumes] = useState<Costume[]>(initialDraft.costumes);

    // TTS overrides (空欄は全体設定に従う)
    const [ttsVoice, setTtsVoice] = useState(initialDraft.ttsVoice);
    const [ttsSpeed, setTtsSpeed] = useState<number | undefined>(initialDraft.ttsSpeed);
    const [imageGenOpen, setImageGenOpen] = useState(false);
    const [expressionsOpen, setExpressionsOpen] = useState(false);
    const [costumesOpen, setCostumesOpen] = useState(false);
    // 左ペインのプレビュー選択。保存対象ではなく表示切替だけに使う。
    const [previewCostumeName, setPreviewCostumeName] = useState(DEFAULT_COSTUME_NAME);
    const [previewExpressionName, setPreviewExpressionName] = useState<string | null>(null);
    const modalRef = useRef<HTMLDivElement>(null);

    // モバイルでは立ち絵を描画しない（VRM/画像の読み込み自体もスキップ）
    const [isMobile, setIsMobile] = useState(false);
    useEffect(() => {
        const checkMobile = () => setIsMobile(window.innerWidth <= 720);
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const saveAndClose = useCallback(() => {
        const currentDraft = {
            name,
            systemPrompt,
            speechStyle,
            protagonistPrompt,
            userConstraints,
            model,
            enableThinking,
            enableMemory,
            maxCharacters,
            maxHistory,
            temperature,
            topP,
            topK,
            frequencyPenalty,
            presencePenalty,
            repetitionPenalty,
            icon,
            expressions,
            costumes,
            ttsVoice,
            ttsSpeed,
        };
        if (!isNew && character && JSON.stringify(currentDraft) === JSON.stringify(initialDraft)) {
            onClose();
            return;
        }

        const trimmedName = name.trim();

        // 必須の名前が未入力の新規画面は、空のキャラクターを作らずに閉じる。
        if ((isNew || !character) && !trimmedName) {
            onClose();
            return;
        }

        const resolvedModel = model.model.trim() ? model : defaultChatModel;
        const updates = {
            name: trimmedName || character?.name || 'キャラクター',
            systemPrompt,
            speechStyle: speechStyle.trim() ? speechStyle : undefined,
            protagonistPrompt: protagonistPrompt.trim() ? protagonistPrompt : undefined,
            userConstraints: userConstraints.trim() ? userConstraints : undefined,
            model: resolvedModel,
            enableThinking,
            enableMemory,
            maxCharacters: maxCharacters ? Math.max(1, Math.round(Number(maxCharacters))) : undefined,
            maxHistory: maxHistory ? Math.min(100, Math.max(1, Number(maxHistory))) : undefined,
            temperature: temperature ?? undefined,
            topP: topP ?? undefined,
            topK: topK != null ? Math.max(0, Math.round(topK)) : undefined,
            frequencyPenalty: frequencyPenalty ?? undefined,
            presencePenalty: presencePenalty ?? undefined,
            repetitionPenalty: repetitionPenalty ?? undefined,
            icon: icon ?? undefined,
            expressions: expressions.length > 0 ? expressions : undefined,
            costumes: costumes.length > 0 ? costumes : undefined,
            tts: (ttsVoice.trim() || ttsSpeed != null)
                ? { voice: ttsVoice.trim() || undefined, speed: ttsSpeed }
                : undefined,
        };

        if (isNew || !character) {
            createCharacter(trimmedName, systemPrompt, resolvedModel, updates);
        } else {
            updateCharacter(character.id, updates);
        }
        onClose();
    }, [character, costumes, createCharacter, defaultChatModel, enableMemory, enableThinking, expressions, frequencyPenalty, icon, initialDraft, isNew, maxCharacters, maxHistory, model, name, onClose, presencePenalty, protagonistPrompt, repetitionPenalty, speechStyle, systemPrompt, temperature, topK, topP, ttsSpeed, ttsVoice, updateCharacter, userConstraints]);

    const attemptClose = useCallback(() => {
        const currentDraft = {
            name,
            systemPrompt,
            speechStyle,
            protagonistPrompt,
            userConstraints,
            model,
            enableThinking,
            enableMemory,
            maxCharacters,
            maxHistory,
            temperature,
            topP,
            topK,
            frequencyPenalty,
            presencePenalty,
            repetitionPenalty,
            icon,
            expressions,
            costumes,
            ttsVoice,
            ttsSpeed,
        };
        const blankDraft = buildInitialCharacterDraft(null, defaultChatModel);
        const hasInput = JSON.stringify(currentDraft) !== JSON.stringify(blankDraft);

        if ((isNew || !character)
            && hasInput
            && !window.confirm('入力した内容はまだ保存されていません。保存せずに閉じますか？')) {
            return;
        }

        onClose();
    }, [character, costumes, defaultChatModel, enableMemory, enableThinking, expressions, frequencyPenalty, icon, isNew, maxCharacters, maxHistory, model, name, onClose, presencePenalty, protagonistPrompt, repetitionPenalty, speechStyle, systemPrompt, temperature, topK, topP, ttsSpeed, ttsVoice, userConstraints]);

    const childModalOpen = imageGenOpen || expressionsOpen || costumesOpen;
    useModalKeyboard({
        isOpen,
        containerRef: modalRef,
        onClose: isNew || !character ? attemptClose : saveAndClose,
        canClose: !childModalOpen,
    });

    const handleOpenMemory = () => {
        if (onOpenMemoryList && character) {
            onOpenMemoryList();
        }
    };

    const labelStyle: React.CSSProperties = {
        display: 'block',
        fontSize: '0.875rem',
        fontWeight: 500,
        marginBottom: '0.5rem',
        color: 'var(--text-secondary)',
    };

    const sectionStyle: React.CSSProperties = {
        marginBottom: '1.25rem',
    };

    const renderLabelWithInfo = (
        label: string,
        info: string,
        options: { marginBottom?: React.CSSProperties['marginBottom']; labelStyleOverride?: React.CSSProperties } = {},
    ) => (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            marginBottom: options.marginBottom ?? '0.5rem',
        }}>
            <label style={{ ...labelStyle, ...options.labelStyleOverride, marginBottom: 0 }}>
                {label}
            </label>
            <InfoButton text={info} />
        </div>
    );

    const defaultNeutralImage = costumes.find((c) => c.name.toLowerCase() === DEFAULT_COSTUME_NAME)?.image
        ?? expressions.find((e) => e.name === NEUTRAL_NAME)?.image;

    // ---- 左ペインの立ち絵プレビュー ----
    const defaultCostume = costumes.find((c) => c.name.toLowerCase() === DEFAULT_COSTUME_NAME) ?? null;
    const previewCostume = previewCostumeName === DEFAULT_COSTUME_NAME
        ? defaultCostume
        : costumes.find((c) => c.name === previewCostumeName) ?? null;
    const previewVrm = previewCostume?.kind === 'vrm' ? previewCostume.vrm : undefined;
    const previewExpressionPool: Expression[] = previewCostume && previewCostumeName !== DEFAULT_COSTUME_NAME
        ? previewCostume.expressions ?? []
        : expressions;
    const previewExpression = previewExpressionName && !previewVrm
        ? previewExpressionPool.find((e) => e.name === previewExpressionName) ?? null
        : null;
    const portraitImage = previewExpression?.image ?? previewCostume?.image ?? defaultNeutralImage ?? null;
    const costumeThumbs = [
        { name: DEFAULT_COSTUME_NAME, image: defaultCostume?.image ?? defaultNeutralImage ?? icon, isVrm: defaultCostume?.kind === 'vrm' },
        ...costumes
            .filter((c) => c.name.toLowerCase() !== DEFAULT_COSTUME_NAME)
            .map((c) => ({ name: c.name, image: c.image, isVrm: c.kind === 'vrm' })),
    ];
    const expressionThumbs: { name: string; image?: string }[] = previewVrm
        ? getVrmExpressionNames(previewVrm).map((entryName) => ({ name: entryName }))
        : previewExpressionPool.map((e) => ({ name: e.name, image: e.image }));

    // 高度な設定に何かカスタム値が設定されているか
    const hasCustomParams = (model.model.trim() !== '' && !modelRefsEqual(model, defaultChatModel))
        || maxCharacters || maxHistory || temperature !== null || topP !== null || topK !== null
        || frequencyPenalty !== null || presencePenalty !== null || repetitionPenalty !== null
        || ttsVoice.trim() !== '' || ttsSpeed != null;
    const promptSectionsStyle: React.CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        gap: '1.25rem',
    };
    const fixedPromptLabelStyle: React.CSSProperties = {
        fontSize: '0.875rem',
        fontWeight: 600,
        color: 'var(--text-primary)',
        marginBottom: '0.5rem',
        letterSpacing: '0.02em',
    };

    return (
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                    if (isNew || !character) {
                        attemptClose();
                    } else {
                        saveAndClose();
                    }
                }
            }}
        >
            <div
                ref={modalRef}
                className="modal-content settings-form-modal character-profile-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={isNew ? '新しいキャラクター' : 'キャラクター設定'}
            >
                <div className="settings-form-modal-actions">
                    {isNew || !character ? (
                        <button
                            className="btn btn-primary settings-form-modal-save"
                            onClick={saveAndClose}
                            disabled={!name.trim()}
                        >
                            保存
                        </button>
                    ) : (
                        <button className="btn btn-ghost" onClick={saveAndClose} aria-label="閉じて保存" title="閉じて保存">
                            <X size={20} />
                        </button>
                    )}
                </div>

                <div className="modal-body character-profile-body">
                    {/* 立ち絵ペイン */}
                    <aside className="character-profile-portrait">
                        {!isMobile && (costumeThumbs.length > 1 || expressionThumbs.length > 0) && (
                            <div className="character-profile-thumbs">
                                {costumeThumbs.map((thumb) => (
                                    <button
                                        key={`costume:${thumb.name}`}
                                        type="button"
                                        className={`character-profile-thumb${previewCostumeName === thumb.name ? ' selected' : ''}`}
                                        title={`衣装: ${thumb.name}`}
                                        onClick={() => {
                                            setPreviewCostumeName(thumb.name);
                                            setPreviewExpressionName(null);
                                        }}
                                    >
                                        {thumb.image
                                            ? <StoredImage src={thumb.image} alt="" />
                                            : thumb.isVrm
                                                ? <span>3D</span>
                                                : <Shirt size={18} />}
                                    </button>
                                ))}
                                {expressionThumbs.length > 0 && <div className="character-profile-thumb-divider" />}
                                {expressionThumbs.map((thumb) => {
                                    const isNeutral = thumb.name.toLowerCase() === NEUTRAL_NAME;
                                    const selected = previewExpressionName === thumb.name
                                        || (previewExpressionName === null && isNeutral);
                                    return (
                                        <button
                                            key={`expression:${thumb.name}`}
                                            type="button"
                                            className={`character-profile-thumb${selected ? ' selected' : ''}`}
                                            title={`表情: ${thumb.name}`}
                                            onClick={() => setPreviewExpressionName(
                                                previewExpressionName === thumb.name || isNeutral ? null : thumb.name,
                                            )}
                                        >
                                            {thumb.image ? <StoredImage src={thumb.image} alt="" /> : thumb.name}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        {!isMobile && (
                            <div className="character-profile-preview-label">
                                {previewCostume?.name ?? previewCostumeName}
                                {previewExpressionName ? ` / ${previewExpressionName}` : ''}
                            </div>
                        )}
                        {!isMobile && (
                        <div className="character-profile-visual">
                            {previewVrm ? (
                                <Suspense fallback={(
                                    <div className="character-profile-placeholder">
                                        <span className="character-profile-placeholder-label">3D表示を準備中…</span>
                                    </div>
                                )}>
                                    <VrmAvatarView
                                        avatar={previewVrm}
                                        expression={previewExpressionName}
                                        name={name || 'キャラクター'}
                                        fallbackImage={previewCostume?.image ?? defaultNeutralImage ?? icon ?? undefined}
                                        interactive
                                    />
                                </Suspense>
                            ) : portraitImage ? (
                                <StoredImage src={portraitImage} alt={name || 'キャラクター'} loading="eager" />
                            ) : (
                                <div className="character-profile-placeholder">
                                    <div className="character-profile-placeholder-initial">
                                        {icon ? (
                                            <StoredImage src={icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
                                        ) : (
                                            name.trim().charAt(0) || '?'
                                        )}
                                    </div>
                                    <span className="character-profile-placeholder-label">立ち絵が未登録です</span>
                                </div>
                            )}
                        </div>
                        )}
                        <div className="character-profile-actions">
                            <button
                                type="button"
                                className="btn"
                                onClick={() => setImageGenOpen(true)}
                                title="アバターと立ち絵を登録します。表情・衣装差分にも使用されます"
                            >
                                <ImagePlus size={13} />
                                立ち絵
                            </button>
                            <button
                                type="button"
                                className="btn"
                                onClick={() => setCostumesOpen(true)}
                                title={!expressions.some((e) => e.name === NEUTRAL_NAME) ? '生成には「立ち絵」から登録が必要です。アップロードなら直接追加できます' : undefined}
                            >
                                <Shirt size={13} />
                                衣装
                            </button>
                            <button
                                type="button"
                                className="btn"
                                onClick={() => setExpressionsOpen(true)}
                            >
                                <Smile size={13} />
                                表情
                            </button>
                        </div>
                    </aside>

                    <div className="character-profile-fields">
                        {/* アイコン + キャラクター名 */}
                        <div className="character-profile-name-row">
                            <div style={{ position: 'relative', flexShrink: 0 }}>
                                <button
                                    type="button"
                                    className="character-profile-icon-button"
                                    onClick={() => setImageGenOpen(true)}
                                    title="アバター画像を変更"
                                >
                                    {icon ? (
                                        <StoredImage src={icon} alt="avatar" />
                                    ) : (
                                        <User size={22} />
                                    )}
                                </button>
                                {icon && (
                                    <button
                                        type="button"
                                        className="character-profile-icon-remove"
                                        onClick={() => setIcon(null)}
                                        title="アバターを削除"
                                        aria-label="アバターを削除"
                                    >
                                        <X size={11} />
                                    </button>
                                )}
                            </div>
                            <input
                                type="text"
                                className="character-profile-name-input"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="キャラクターの名前"
                                aria-label="キャラクター名"
                            />
                        </div>

                    {/* プロンプト */}
                    <div style={sectionStyle}>
                        <div style={promptSectionsStyle}>
                            <div>
                                <div style={fixedPromptLabelStyle}>{CHARACTER_PROMPT_SECTION_TITLE}</div>
                                <PromptSectionEditor
                                    markdown={systemPrompt}
                                    onChange={setSystemPrompt}
                                    placeholder="キャラクターに関する詳細を記述してください..."
                                />
                            </div>
                            <div>
                                <div style={fixedPromptLabelStyle}>{SPEECH_STYLE_SECTION_TITLE}</div>
                                <PromptSectionEditor
                                    markdown={speechStyle}
                                    onChange={setSpeechStyle}
                                    placeholder="例: 「それ、めっちゃいいじゃん！あとで私にも分けて？」"
                                    plain
                                />
                            </div>
                            <div>
                                <div style={fixedPromptLabelStyle}>{PROTAGONIST_PROMPT_SECTION_TITLE}</div>
                                <PromptSectionEditor
                                    markdown={protagonistPrompt}
                                    onChange={setProtagonistPrompt}
                                    placeholder="主人公に関する詳細を記述してください..."
                                />
                            </div>
                            <div>
                                <div style={fixedPromptLabelStyle}>{USER_CONSTRAINTS_SECTION_TITLE}</div>
                                <PromptSectionEditor
                                    markdown={userConstraints}
                                    onChange={setUserConstraints}
                                    placeholder="キャラクターに守らせたい制約を記述してください..."
                                    plain
                                />
                            </div>
                        </div>
                    </div>

                    {/* トグル群 */}
                    <div className="character-profile-toggle-grid" style={sectionStyle}>
                        {/* 思考トグル */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                            <div>
                                {renderLabelWithInfo('考える', '返答前の思考をJSONのthoughtフィールドに含めます。会話には表示されません。', {
                                    marginBottom: 0,
                                })}
                            </div>
                            <button
                                type="button"
                                onClick={() => setEnableThinking(!enableThinking)}
                                style={{
                                    position: 'relative',
                                    width: '44px',
                                    height: '24px',
                                    borderRadius: '12px',
                                    border: 'none',
                                    cursor: 'pointer',
                                    background: enableThinking ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                    transition: 'background 0.2s ease',
                                    padding: 0,
                                    flexShrink: 0,
                                }}
                                aria-label="考えるを有効化"
                                aria-pressed={enableThinking}
                            >
                                <span style={{
                                    position: 'absolute',
                                    top: '2px',
                                    left: enableThinking ? '22px' : '2px',
                                    width: '20px',
                                    height: '20px',
                                    borderRadius: '50%',
                                    background: '#fff',
                                    transition: 'left 0.2s ease',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                                }} />
                            </button>
                        </div>

                        {/* 記憶機能トグル */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                            <div>
                                {renderLabelWithInfo('メモリ', '関連するメモリの利用と、会話後の自動保存を有効にします。', {
                                    marginBottom: 0,
                                })}
                            </div>
                            <button
                                type="button"
                                onClick={() => setEnableMemory(!enableMemory)}
                                style={{
                                    position: 'relative',
                                    width: '44px',
                                    height: '24px',
                                    borderRadius: '12px',
                                    border: 'none',
                                    cursor: 'pointer',
                                    background: enableMemory ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                    transition: 'background 0.2s ease',
                                    padding: 0,
                                    flexShrink: 0,
                                }}
                                aria-label="メモリを有効化"
                            >
                                <span style={{
                                    position: 'absolute',
                                    top: '2px',
                                    left: enableMemory ? '22px' : '2px',
                                    width: '20px',
                                    height: '20px',
                                    borderRadius: '50%',
                                    background: '#fff',
                                    transition: 'left 0.2s ease',
                                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                                }} />
                            </button>
                        </div>
                    </div>

                    {/* 高度な設定 (折りたたみ) */}
                    <div style={sectionStyle}>
                        <button
                            type="button"
                            onClick={() => setParametersOpen(!parametersOpen)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.375rem',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '0.375rem 0',
                                fontSize: '0.875rem',
                                fontWeight: 500,
                                color: 'var(--text-secondary)',
                                width: '100%',
                            }}
                        >
                            {parametersOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            高度な設定
                            {hasCustomParams && !parametersOpen && (
                                <span style={{
                                    marginLeft: '0.375rem',
                                    fontSize: '0.7rem',
                                    padding: '0.1rem 0.4rem',
                                    borderRadius: '0.75rem',
                                    background: 'rgba(var(--accent-primary-rgb), 0.15)',
                                    color: 'var(--accent-primary)',
                                    fontWeight: 600,
                                }}>
                                    カスタム
                                </span>
                            )}
                        </button>

                        {parametersOpen && (
                            <div style={{
                                marginTop: '0.75rem',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '1.25rem',
                            }}>
                                {/* モデル */}
                                <div>
                                    <label style={{ ...labelStyle, fontSize: '0.8125rem', marginBottom: '0.375rem' }}>モデル</label>
                                    <ModelSelector
                                        value={model}
                                        onChange={setModel}
                                        outputModality="text"
                                        placeholder={`例: ${defaultChatModel.model}`}
                                    />
                                </div>

                                {/* 声 */}
                                <div>
                                    <label style={{ ...labelStyle, fontSize: '0.8125rem', marginBottom: '0.375rem' }}>声</label>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <TtsVoiceField
                                                connectionId={character?.tts?.connectionId ?? ttsConnectionId}
                                                value={ttsVoice}
                                                onChange={setTtsVoice}
                                                emptyLabel="全体設定"
                                            />
                                        </div>
                                        <TtsPreviewButton
                                            previewId={`tts-preview-character:${character?.id ?? 'new'}`}
                                            profile={resolveTtsProfile(useStore.getState(), {
                                                tts: { ...character?.tts, voice: ttsVoice, speed: ttsSpeed },
                                            })}
                                        />
                                    </div>
                                    <p style={{ margin: '0.375rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                                        空欄では全体設定を使用します。
                                    </p>
                                </div>

                                {/* 読み上げ速度 */}
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                            <label style={{
                                                fontSize: '0.8125rem',
                                                fontWeight: 500,
                                                color: 'var(--text-secondary)',
                                            }}>
                                                速度
                                            </label>
                                            <InfoButton text="読み上げ速度です。未設定では全体設定の値を使用します。" />
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <span style={{
                                                fontSize: '0.8125rem',
                                                fontWeight: 600,
                                                color: ttsSpeed != null ? 'var(--accent-primary)' : 'var(--text-muted)',
                                                minWidth: '3.5rem',
                                                textAlign: 'right',
                                                fontVariantNumeric: 'tabular-nums',
                                            }}>
                                                {ttsSpeed != null ? formatTtsSpeed(ttsSpeed) : '全体設定'}
                                            </span>
                                            {ttsSpeed != null && (
                                                <button
                                                    type="button"
                                                    onClick={() => setTtsSpeed(undefined)}
                                                    title="全体設定に戻す"
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
                                                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                                                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                                                >
                                                    <RotateCcw size={12} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <TtsSpeedSlider
                                        id="character-tts-speed-input"
                                        value={ttsSpeed ?? defaultTtsSpeed}
                                        custom={ttsSpeed != null}
                                        ariaLabel="読み上げ速度"
                                        onChange={setTtsSpeed}
                                    />
                                </div>

                                {/* Maximum reply characters */}
                                <div>
                                    {renderLabelWithInfo('最大の文字数', '返信本文（message/messages）の最大文字数です', {
                                        marginBottom: '0.375rem',
                                        labelStyleOverride: { fontSize: '0.8125rem' },
                                    })}
                                    <input
                                        type="number"
                                        className="input"
                                        value={maxCharacters}
                                        onChange={(e) => setMaxCharacters(e.target.value)}
                                        placeholder={DEFAULT_MAX_CHARACTERS_PLACEHOLDER}
                                        min="1"
                                        style={{ fontSize: '0.8125rem' }}
                                    />
                                </div>

                                {/* Max History */}
                                {(() => {
                                    const isCustom = maxHistory !== '';
                                    const sliderVal = isCustom ? Number(maxHistory) : DEFAULT_MAX_HISTORY_SLIDER_VALUE;
                                    const percent = ((sliderVal - 1) / (MAX_HISTORY_SLIDER_MAX - 1)) * 100;
                                    return (
                                        <div>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                                    <label style={{
                                                        fontSize: '0.8125rem',
                                                        fontWeight: 500,
                                                        color: 'var(--text-secondary)',
                                                    }}>
                                                        Max History
                                                    </label>
                                                    <InfoButton text="APIへ送信する直近のユーザー発話数です（AI返信も対応範囲を含めます）" />
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                    <span style={{
                                                        fontSize: '0.8125rem',
                                                        fontWeight: 600,
                                                        color: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                                                        minWidth: '3.5rem',
                                                        textAlign: 'right',
                                                        fontVariantNumeric: 'tabular-nums',
                                                    }}>
                                                        {isCustom ? `${maxHistory} 件` : DEFAULT_MAX_HISTORY_LABEL}
                                                    </span>
                                                    {isCustom && (
                                                        <button
                                                            type="button"
                                                            onClick={() => setMaxHistory('')}
                                                            title={RESET_MAX_HISTORY_TITLE}
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
                                                            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
                                                            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                                                        >
                                                            <RotateCcw size={12} />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>

                                            {/* スライダートラック */}
                                            <div style={{ position: 'relative', height: '20px', display: 'flex', alignItems: 'center' }}>
                                                {/* 背景トラック */}
                                                <div style={{
                                                    position: 'absolute',
                                                    width: '100%',
                                                    height: '4px',
                                                    borderRadius: '2px',
                                                    background: 'var(--bg-tertiary)',
                                                    overflow: 'hidden',
                                                }}>
                                                    {/* 塗りつぶし部分 */}
                                                    <div style={{
                                                        width: `${percent}%`,
                                                        height: '100%',
                                                        background: isCustom ? 'var(--accent-primary)' : 'var(--text-muted)',
                                                        borderRadius: '2px',
                                                        transition: 'background 0.2s ease',
                                                    }} />
                                                </div>

                                                {/* Native range input（透過して重ねる） */}
                                                <input
                                                    type="range"
                                                    min={1}
                                                    max={MAX_HISTORY_SLIDER_MAX}
                                                    step={1}
                                                    value={sliderVal}
                                                    onChange={(e) => {
                                                        const v = Number(e.target.value);
                                                        setMaxHistory(v === DEFAULT_MAX_HISTORY_SLIDER_VALUE ? '' : String(v));
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

                                                {/* サム（ハンドル） */}
                                                <div style={{
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
                                                }} />
                                            </div>

                                            {/* 最小・最大ラベル */}
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>1</span>
                                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{DEFAULT_CHARACTER_MAX_HISTORY == null ? '無制限' : `${MAX_HISTORY_SLIDER_MAX} 件`}</span>
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* Temperature スライダー */}
                                <ParamSlider
                                    paramKey="temperature"
                                    value={temperature}
                                    onChange={setTemperature}
                                />

                                {/* Top P スライダー */}
                                <ParamSlider
                                    paramKey="topP"
                                    value={topP}
                                    onChange={setTopP}
                                />

                                {/* Top K スライダー */}
                                <ParamSlider
                                    paramKey="topK"
                                    value={topK}
                                    onChange={setTopK}
                                />
                                <ParamSlider
                                    paramKey="frequencyPenalty"
                                    value={frequencyPenalty}
                                    onChange={setFrequencyPenalty}
                                />
                                <ParamSlider
                                    paramKey="presencePenalty"
                                    value={presencePenalty}
                                    onChange={setPresencePenalty}
                                />
                                <ParamSlider
                                    paramKey="repetitionPenalty"
                                    value={repetitionPenalty}
                                    onChange={setRepetitionPenalty}
                                />
                            </div>
                        )}
                    </div>

                    {/* 記憶 */}
                    {!isNew && character && (
                        <div style={{ ...sectionStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                            <label style={{ ...labelStyle, marginBottom: 0 }}>記憶</label>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={handleOpenMemory}
                            >
                                表示
                            </button>
                        </div>
                    )}
                    </div>
                </div>

            </div>

            <ImageGenerationModal
                isOpen={imageGenOpen}
                onClose={() => setImageGenOpen(false)}
                transparentFullBody
                expressionNames={expressions.map((expression) => expression.name)}
                initialVrm={costumes.find((c) => c.name.toLowerCase() === DEFAULT_COSTUME_NAME && c.kind === 'vrm')?.vrm}
                vrmPreviewName={name || 'キャラクター'}
                vrmFallbackImage={icon ?? undefined}
                onComplete={(avatar, fullBody, vrm) => {
                    setIcon(avatar);
                    setExpressions((prev) => {
                        const next = prev.filter((e) => e.name !== NEUTRAL_NAME);
                        next.unshift({ name: NEUTRAL_NAME, image: fullBody });
                        return next;
                    });
                    setCostumes((prev) => {
                        const existingDefault = prev.find((c) => c.name.toLowerCase() === DEFAULT_COSTUME_NAME);
                        const next = prev.filter((c) => c.name.toLowerCase() !== DEFAULT_COSTUME_NAME);
                        next.unshift({
                            name: DEFAULT_COSTUME_NAME,
                            ...(vrm ? { kind: 'vrm' as const, vrm } : {}),
                            promptDetail: existingDefault?.promptDetail,
                            image: fullBody,
                        });
                        return next;
                    });
                }}
            />

            <ExpressionDiffModal
                isOpen={expressionsOpen}
                onClose={() => setExpressionsOpen(false)}
                expressions={expressions}
                costumes={costumes}
                onUpsert={(exp, costumeName) => {
                    if (costumeName) {
                        setCostumes((prev) => prev.map((costume) => {
                            if (costume.name !== costumeName) return costume;
                            const currentExpressions = costume.expressions ?? [];
                            const idx = currentExpressions.findIndex((e) => e.name === exp.name);
                            const expressionsNext = idx >= 0
                                ? currentExpressions.map((e, i) => (i === idx ? exp : e))
                                : [...currentExpressions, exp];
                            return { ...costume, expressions: expressionsNext };
                        }));
                        return;
                    }
                    setExpressions((prev) => {
                        const idx = prev.findIndex((e) => e.name === exp.name);
                        if (idx >= 0) {
                            const next = [...prev];
                            next[idx] = exp;
                            return next;
                        }
                        return [...prev, exp];
                    });
                }}
                onRename={(currentName, nextName, costumeName) => {
                    if (costumeName) {
                        setCostumes((prev) => prev.map((costume) => (
                            costume.name === costumeName
                                ? {
                                    ...costume,
                                    expressions: (costume.expressions ?? []).map((expression) => (
                                        expression.name === currentName
                                            ? { ...expression, name: nextName }
                                            : expression
                                    )),
                                }
                                : costume
                        )));
                        return;
                    }
                    setExpressions((prev) => prev.map((expression) => (
                        expression.name === currentName
                            ? { ...expression, name: nextName }
                            : expression
                    )));
                }}
                onRemove={(name, costumeName) => {
                    if (costumeName) {
                        setCostumes((prev) => prev.map((costume) => (
                            costume.name === costumeName
                                ? { ...costume, expressions: (costume.expressions ?? []).filter((e) => e.name !== name) }
                                : costume
                        )));
                        return;
                    }
                    setExpressions((prev) => prev.filter((e) => e.name !== name));
                }}
            />

            <CostumeDiffModal
                isOpen={costumesOpen}
                expressionNames={expressions.map((expression) => expression.name)}
                onClose={() => setCostumesOpen(false)}
                baseImage={defaultNeutralImage}
                costumes={costumes}
                onUpsert={(costume) => setCostumes((prev) => {
                    const idx = prev.findIndex((c) => c.name === costume.name);
                    if (idx >= 0) {
                        const next = [...prev];
                        next[idx] = costume;
                        return next;
                    }
                    return [...prev, costume];
                })}
                onRemove={(name) => setCostumes((prev) => prev.filter((c) => {
                    if (c.name.toLowerCase() === DEFAULT_COSTUME_NAME) return true;
                    return c.name !== name;
                }))}
            />
        </div>
    );
}
