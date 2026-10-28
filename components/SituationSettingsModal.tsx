import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, ChevronUp, EllipsisVertical, Image as ImageIcon, ImagePlus, MessagesSquare, Plus, RotateCcw, Search, Shirt, Smile, Sparkles, Trash2, User, Users, X } from 'lucide-react';
import {
    Character,
    Costume,
    DEFAULT_CHARACTER_MAX_HISTORY,
    DEFAULT_SITUATION_MAX_TURNS,
    MAX_SITUATION_MAX_TURNS,
    MIN_SITUATION_MAX_TURNS,
    Expression,
    Room,
    Situation,
    SituationActor,
    SituationPriorMessage,
    useStore,
} from '@/lib/store';
import { generateId } from '@/lib/id';
import {
    DEFAULT_COSTUME_NAME,
    getVisualNovelCostumeOptions,
    getVisualNovelExpressionNames,
} from '@/lib/visualNovelPresentation';
import CharacterGeneratorModal from './CharacterGeneratorModal';
import ExpressionDiffModal from './ExpressionDiffModal';
import ImageGenerationModal from './ImageGenerationModal';
import SituationBackgroundModal from './SituationBackgroundModal';
import SituationDescriptionGeneratorModal from './SituationDescriptionGeneratorModal';
import StoredImage from './StoredImage';
import PromptSectionEditor from './PromptSectionEditor';
import OptionSelector from './OptionSelector';
import { useModalKeyboard } from './useModalKeyboard';
import { getVrmExpressionNames } from '@/lib/vrm';

const VrmAvatarView = lazy(() => import('./VrmAvatarView'));

type TemporaryActorDraft = {
    id: string;
    name: string;
    systemPrompt: string;
    speechStyle: string;
    userConstraints: string;
    icon: string | null;
    expressions: Expression[];
    costumes: Costume[];
};

type CharacterActorMeta = {
    id: string;
    costumeName?: string;
    rolePrompt?: string;
};

type CostumeMenuState = {
    characterId: string;
    anchorElement: HTMLButtonElement;
    anchorTop: number;
    anchorRight: number;
    anchorBottom: number;
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
    background: 'var(--bg-secondary)',
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

/** Borderless compact trigger for the prior-message actor/expression pickers. */
const priorMessageSelectTriggerStyle: CSSProperties = {
    minHeight: 0,
    padding: '0.25rem 0.375rem',
    border: 'none',
    borderRadius: '0.375rem',
    outline: 'none',
    background: 'transparent',
    boxShadow: 'none',
    color: 'var(--text-muted)',
    fontSize: '0.75rem',
    fontWeight: 500,
    gap: '0.25rem',
};

const NEUTRAL_EXPRESSION_NAME = 'neutral';

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
        speechStyle: '',
        userConstraints: '',
        icon: null,
        expressions: [],
        costumes: [],
    };
}

function getInitialMaxTurns(situation: Situation | null | undefined, room: Room | null | undefined): number {
    return Math.max(
        MIN_SITUATION_MAX_TURNS,
        Math.min(MAX_SITUATION_MAX_TURNS, room?.maxMentionChain ?? situation?.maxTurns ?? DEFAULT_SITUATION_MAX_TURNS),
    );
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

interface TemporaryActorSettingsModalProps {
    actor: TemporaryActorDraft;
    isNew: boolean;
    onClose: () => void;
    onSave: (actor: TemporaryActorDraft) => void;
}

function TemporaryActorSettingsModal({
    actor,
    isNew,
    onClose,
    onSave,
}: TemporaryActorSettingsModalProps) {
    const [draft, setDraft] = useState<TemporaryActorDraft>(() => ({ ...actor }));
    const [generatorOpen, setGeneratorOpen] = useState(false);
    const [imageGenOpen, setImageGenOpen] = useState(false);
    const [expressionsOpen, setExpressionsOpen] = useState(false);
    // 左ペインのプレビュー選択。保存対象ではなく表示切替だけに使う。
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

    const updateDraft = (updates: Partial<TemporaryActorDraft>) => {
        setDraft((current) => ({ ...current, ...updates }));
    };

    const saveAndClose = useCallback(() => {
        const trimmedName = draft.name.trim();
        if (isNew && !trimmedName) {
            onClose();
            return;
        }
        onSave({
            ...draft,
            name: trimmedName || actor.name,
        });
    }, [actor.name, draft, isNew, onClose, onSave]);

    useModalKeyboard({
        isOpen: true,
        containerRef: modalRef,
        onClose: isNew ? onClose : saveAndClose,
        canClose: !generatorOpen && !imageGenOpen && !expressionsOpen,
    });

    const sectionStyle: CSSProperties = { marginBottom: '1.25rem' };
    const promptLabelStyle: CSSProperties = {
        fontSize: '0.875rem',
        fontWeight: 600,
        color: 'var(--text-primary)',
        marginBottom: '0.5rem',
        letterSpacing: '0.02em',
    };

    // 左ペインの立ち絵プレビュー（衣装差分は扱わず、デフォルト衣装と表情だけを表示する）
    const defaultCostume = draft.costumes.find((costume) => costume.name.toLowerCase() === DEFAULT_COSTUME_NAME) ?? null;
    const defaultNeutralImage = defaultCostume?.image
        ?? draft.expressions.find((expression) => expression.name === NEUTRAL_EXPRESSION_NAME)?.image;
    const previewVrm = defaultCostume?.kind === 'vrm' ? defaultCostume.vrm : undefined;
    const previewExpression = previewExpressionName && !previewVrm
        ? draft.expressions.find((expression) => expression.name === previewExpressionName) ?? null
        : null;
    const portraitImage = previewExpression?.image ?? defaultNeutralImage ?? null;
    const expressionThumbs: { name: string; image?: string }[] = previewVrm
        ? getVrmExpressionNames(previewVrm).map((name) => ({ name }))
        : draft.expressions.map((expression) => ({ name: expression.name, image: expression.image }));

    return (
        <>
            <div
                className="modal-overlay"
                onPointerDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (isNew) {
                        onClose();
                    } else {
                        saveAndClose();
                    }
                }}
            >
                <div
                    ref={modalRef}
                    className="modal-content settings-form-modal character-profile-modal"
                    onClick={(event) => event.stopPropagation()}
                    role="dialog"
                    aria-modal="true"
                    aria-label={isNew ? '登場人物を追加' : `${actor.name}の設定`}
                >
                    <div className="settings-form-modal-actions">
                        {isNew && (
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => setGeneratorOpen(true)}
                                title="AIでキャラクター生成"
                                aria-label="AIでキャラクター生成"
                            >
                                <Sparkles size={16} />
                            </button>
                        )}
                        {isNew ? (
                            <button
                                type="button"
                                className="btn btn-primary settings-form-modal-save"
                                onClick={saveAndClose}
                                disabled={!draft.name.trim()}
                            >
                                保存
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={saveAndClose}
                                aria-label="閉じて保存"
                                title="閉じて保存"
                            >
                                <X size={20} />
                            </button>
                        )}
                    </div>

                    <div className="modal-body character-profile-body">
                        {/* 立ち絵ペイン */}
                        <aside className="character-profile-portrait">
                            {!isMobile && expressionThumbs.length > 0 && (
                                <div className="character-profile-thumbs">
                                    {expressionThumbs.map((thumb) => {
                                        const isNeutral = thumb.name.toLowerCase() === NEUTRAL_EXPRESSION_NAME;
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
                            {!isMobile && previewExpressionName && (
                                <div className="character-profile-preview-label">{previewExpressionName}</div>
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
                                                name={draft.name || 'キャラクター'}
                                                fallbackImage={defaultCostume?.image ?? defaultNeutralImage ?? draft.icon ?? undefined}
                                                interactive
                                                lipSync
                                            />
                                        </Suspense>
                                    ) : portraitImage ? (
                                        <StoredImage src={portraitImage} alt={draft.name || 'キャラクター'} loading="eager" />
                                    ) : (
                                        <div className="character-profile-placeholder">
                                            <div className="character-profile-placeholder-initial">
                                                {draft.icon ? (
                                                    <StoredImage src={draft.icon} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
                                                ) : (
                                                    draft.name.trim().charAt(0) || '?'
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
                                    title="アバターと立ち絵を登録します。表情差分にも使用されます"
                                >
                                    <ImagePlus size={13} />
                                    立ち絵
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
                                        {draft.icon ? (
                                            <StoredImage src={draft.icon} alt="avatar" />
                                        ) : (
                                            <User size={22} />
                                        )}
                                    </button>
                                    {draft.icon && (
                                        <button
                                            type="button"
                                            className="character-profile-icon-remove"
                                            onClick={() => updateDraft({ icon: null })}
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
                                    value={draft.name}
                                    onChange={(event) => updateDraft({ name: event.target.value })}
                                    placeholder="キャラクターの名前"
                                    aria-label="キャラクター名"
                                    autoFocus={isNew}
                                />
                            </div>

                            {/* プロンプト */}
                            <div style={sectionStyle}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                                    <div>
                                        <div style={promptLabelStyle}>プロフィール</div>
                                        <PromptSectionEditor
                                            markdown={draft.systemPrompt}
                                            onChange={(systemPrompt) => updateDraft({ systemPrompt })}
                                            placeholder="キャラクターに関する詳細を記述してください..."
                                        />
                                    </div>
                                    <div>
                                        <div style={promptLabelStyle}>口調</div>
                                        <PromptSectionEditor
                                            markdown={draft.speechStyle}
                                            onChange={(speechStyle) => updateDraft({ speechStyle })}
                                            placeholder="例: 「それ、めっちゃいいじゃん！あとで私にも分けて？」"
                                            plain
                                        />
                                    </div>
                                    <div>
                                        <div style={promptLabelStyle}>追加の制約</div>
                                        <PromptSectionEditor
                                            markdown={draft.userConstraints}
                                            onChange={(userConstraints) => updateDraft({ userConstraints })}
                                            placeholder="キャラクターに守らせたい制約を記述してください..."
                                            plain
                                        />
                                    </div>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>
            </div>

            <CharacterGeneratorModal
                isOpen={generatorOpen}
                onClose={() => setGeneratorOpen(false)}
                onApply={(generated) => {
                    updateDraft({
                        name: generated.name,
                        systemPrompt: generated.systemPrompt,
                        speechStyle: generated.speechStyle,
                    });
                    setGeneratorOpen(false);
                }}
            />

            <ImageGenerationModal
                isOpen={imageGenOpen}
                onClose={() => setImageGenOpen(false)}
                transparentFullBody
                expressionNames={draft.expressions.map((expression) => expression.name)}
                initialVrm={draft.costumes.find((costume) => costume.name.toLowerCase() === DEFAULT_COSTUME_NAME && costume.kind === 'vrm')?.vrm}
                vrmPreviewName={draft.name || 'キャラクター'}
                vrmFallbackImage={draft.icon ?? undefined}
                onComplete={(avatar, fullBody, vrm) => {
                    setDraft((current) => {
                        const expressions = current.expressions.filter(
                            (expression) => expression.name !== NEUTRAL_EXPRESSION_NAME,
                        );
                        expressions.unshift({ name: NEUTRAL_EXPRESSION_NAME, image: fullBody });
                        const existingDefault = current.costumes.find(
                            (costume) => costume.name.toLowerCase() === DEFAULT_COSTUME_NAME,
                        );
                        const costumes = current.costumes.filter(
                            (costume) => costume.name.toLowerCase() !== DEFAULT_COSTUME_NAME,
                        );
                        costumes.unshift({
                            name: DEFAULT_COSTUME_NAME,
                            ...(vrm ? { kind: 'vrm' as const, vrm } : {}),
                            description: existingDefault?.description,
                            image: fullBody,
                        });
                        return { ...current, icon: avatar, expressions, costumes };
                    });
                    setImageGenOpen(false);
                }}
            />

            <ExpressionDiffModal
                isOpen={expressionsOpen}
                onClose={() => setExpressionsOpen(false)}
                expressions={draft.expressions}
                costumes={draft.costumes}
                showCostumeSettings={false}
                onUpsert={(expression) => {
                    setDraft((current) => {
                        const index = current.expressions.findIndex((item) => item.name === expression.name);
                        if (index < 0) {
                            return { ...current, expressions: [...current.expressions, expression] };
                        }
                        const expressions = [...current.expressions];
                        expressions[index] = expression;
                        return { ...current, expressions };
                    });
                }}
                onRename={(currentName, nextName) => {
                    setDraft((current) => ({
                        ...current,
                        expressions: current.expressions.map((expression) => (
                            expression.name === currentName
                                ? { ...expression, name: nextName }
                                : expression
                        )),
                    }));
                }}
                onRemove={(name) => {
                    setDraft((current) => ({
                        ...current,
                        expressions: current.expressions.filter((expression) => expression.name !== name),
                    }));
                }}
            />
        </>
    );
}

function buildInitialState(
    situation: Situation | null | undefined,
    room: Room | null | undefined,
) {
    const selectedCharacterIds = new Set<string>();
    const characterActorMeta: Record<string, CharacterActorMeta> = {};
    const temporaryActors: TemporaryActorDraft[] = [];

    for (const actor of situation?.actors ?? []) {
        if (actor.type === 'character') {
            selectedCharacterIds.add(actor.characterId);
            characterActorMeta[actor.characterId] = {
                id: actor.id,
                costumeName: actor.costumeName,
                rolePrompt: actor.rolePrompt,
            };
        } else {
            temporaryActors.push({
                id: actor.id,
                name: actor.name,
                systemPrompt: actor.systemPrompt,
                speechStyle: actor.speechStyle ?? '',
                userConstraints: actor.userConstraints ?? '',
                icon: actor.icon ?? null,
                expressions: actor.expressions ?? [],
                costumes: actor.costumes ?? [],
            });
        }
    }

    return {
        name: situation?.name ?? '',
        backgroundImage: situation?.backgroundImage ?? '',
        situationPrompt: situation?.situationPrompt ?? '',
        characterCommonRules: situation?.characterCommonRules ?? '',
        maxAutoTurns: String(getInitialMaxTurns(situation, room)),
        limitTurns: situation?.limitTurns === true,
        maxHistory: situation?.maxHistory != null ? String(situation.maxHistory) : '',
        memoryReadOnly: situation?.memoryMode === 'readOnly',
        // 新規作成時はナレーションを分ける。既存のシチュエーションは保存済みの設定に従う。
        separateNarration: situation ? situation.separateNarration === true : true,
        priorMessages: (situation?.priorMessages ?? []).map((message) => ({ ...message })),
        selectedCharacterIds,
        characterActorMeta,
        temporaryActors,
    };
}

function serializeSituationDraft(draft: ReturnType<typeof buildInitialState>) {
    return JSON.stringify({
        name: draft.name,
        backgroundImage: draft.backgroundImage,
        situationPrompt: draft.situationPrompt,
        characterCommonRules: draft.characterCommonRules,
        maxAutoTurns: draft.maxAutoTurns,
        limitTurns: draft.limitTurns,
        maxHistory: draft.maxHistory,
        memoryReadOnly: draft.memoryReadOnly,
        separateNarration: draft.separateNarration,
        priorMessages: draft.priorMessages,
        selectedCharacterIds: Array.from(draft.selectedCharacterIds),
        characterActorMeta: draft.characterActorMeta,
        temporaryActors: draft.temporaryActors,
    });
}

function SwitchRow({ label, description, checked, onToggle }: {
    label: string;
    description?: string;
    checked: boolean;
    onToggle: () => void;
}) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '0.75rem', fontSize: '0.875rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: '0.125rem' }}>
                    {label}
                    {description && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{description}</span>
                    )}
                </span>
                <button
                    type="button"
                    role="switch"
                    aria-checked={checked}
                    aria-label={label}
                    onClick={onToggle}
                    style={{
                        position: 'relative',
                        width: '44px',
                        height: '24px',
                        borderRadius: '12px',
                        border: 'none',
                        cursor: 'pointer',
                        background: checked ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                        transition: 'background 0.2s ease',
                        padding: 0,
                        flexShrink: 0,
                    }}
                >
                    <span style={{
                        position: 'absolute',
                        top: '2px',
                        left: checked ? '22px' : '2px',
                        width: '20px',
                        height: '20px',
                        borderRadius: '50%',
                        background: '#fff',
                        transition: 'left 0.2s ease',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    }} />
                </button>
            </label>
        </div>
    );
}

interface CharacterSelectionModalProps {
    characters: Character[];
    selectedCharacterIds: Set<string>;
    onToggle: (character: Character) => void;
    onClose: () => void;
}

function normalizeCharacterSearchText(value: string) {
    return value.normalize('NFKC').toLocaleLowerCase('ja-JP');
}

function CharacterSelectionModal({
    characters,
    selectedCharacterIds,
    onToggle,
    onClose,
}: CharacterSelectionModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState('');
    const normalizedQuery = normalizeCharacterSearchText(query.trim());
    const filteredCharacters = useMemo(
        () => normalizedQuery
            ? characters.filter((character) => normalizeCharacterSearchText(character.name).includes(normalizedQuery))
            : characters,
        [characters, normalizedQuery],
    );

    useModalKeyboard({
        isOpen: true,
        containerRef: modalRef,
        onClose,
    });

    return (
        <div
            className="modal-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content settings-form-modal"
                onClick={(event) => event.stopPropagation()}
                style={{ maxWidth: 560 }}
                role="dialog"
                aria-modal="true"
                aria-label="既存キャラクターを編集"
            >
                <div className="settings-form-modal-actions" style={{ justifyContent: 'space-between' }}>
                    <span style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--text-primary)', paddingLeft: '0.25rem' }}>
                        既存キャラクターを編集
                    </span>
                    <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={onClose}
                        aria-label="閉じる"
                        title="閉じる"
                    >
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body">
                    {characters.length > 0 && (
                        <label style={{ position: 'relative', display: 'block', marginBottom: '1rem' }}>
                            <Search
                                size={17}
                                aria-hidden="true"
                                style={{ position: 'absolute', left: '0.75rem', top: '50%', color: 'var(--text-muted)', transform: 'translateY(-50%)', pointerEvents: 'none' }}
                            />
                            <input
                                type="search"
                                className="situation-character-search-input"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="キャラクター名で検索"
                                aria-label="キャラクター名で検索"
                                autoFocus
                                style={{ ...fieldStyle, paddingLeft: '2.25rem' }}
                            />
                        </label>
                    )}

                    {filteredCharacters.length > 0 ? (
                        <div aria-live="polite" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 5.5rem)', gap: '0.5rem', justifyContent: 'start' }}>
                            {filteredCharacters.map((character) => {
                                const checked = selectedCharacterIds.has(character.id);
                                return (
                                    <button
                                        key={character.id}
                                        type="button"
                                        className={`situation-character-selection-card${checked ? ' selected' : ''}`}
                                        onClick={() => onToggle(character)}
                                        aria-pressed={checked}
                                        style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: '0.375rem',
                                            width: '5.5rem',
                                            minHeight: '6.75rem',
                                            padding: '0.625rem 0.375rem 0.5rem',
                                            cursor: 'pointer',
                                            minWidth: 0,
                                            textAlign: 'center',
                                            color: 'inherit',
                                            font: 'inherit',
                                        }}
                                    >
                                        <div className="situation-character-selection-avatar-wrap">
                                            <div style={{ width: 56, height: 56, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${checked ? 'var(--accent-primary)' : 'transparent'}`, boxShadow: checked ? '0 0 0 2px rgba(var(--accent-primary-rgb), 0.25)' : 'none', transition: 'border-color 0.15s ease, box-shadow 0.15s ease' }}>
                                                {character.icon ? (
                                                    <StoredImage src={character.icon} alt={character.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                ) : (
                                                    <User size={28} style={{ color: 'var(--text-muted)' }} />
                                                )}
                                            </div>
                                            {checked && (
                                                <span className="situation-character-selection-check" aria-hidden="true">
                                                    <Check size={13} strokeWidth={3} />
                                                </span>
                                            )}
                                        </div>
                                        <span className="situation-character-selection-name" title={character.name} style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.75rem', lineHeight: 1.25 }}>
                                            {character.name}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : characters.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', textAlign: 'center', padding: '1.5rem 0' }}>
                            既存キャラクターがありません
                        </div>
                    ) : (
                        <div aria-live="polite" style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', textAlign: 'center', padding: '1.5rem 0' }}>
                            「{query.trim()}」に一致するキャラクターはいません
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

interface CharacterCostumeMenuProps {
    character: Character;
    selectedCostumeName: string;
    anchor: CostumeMenuState;
    onSelect: (costumeName: string) => void;
    onClose: () => void;
}

function CharacterCostumeMenu({
    character,
    selectedCostumeName,
    anchor,
    onSelect,
    onClose,
}: CharacterCostumeMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const costumeOptions = getVisualNovelCostumeOptions(character);
    const resolvedCostumeName = costumeOptions.some((option) => option.name === selectedCostumeName)
        ? selectedCostumeName
        : DEFAULT_COSTUME_NAME;
    const menuWidth = Math.min(240, window.innerWidth - 16);
    const left = Math.max(8, Math.min(anchor.anchorRight - menuWidth, window.innerWidth - menuWidth - 8));
    const placeAbove = window.innerHeight - anchor.anchorBottom < 220 && anchor.anchorTop > window.innerHeight - anchor.anchorBottom;

    useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (!target || menuRef.current?.contains(target) || anchor.anchorElement.contains(target)) return;
            onClose();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
            anchor.anchorElement.focus({ preventScroll: true });
        };
        const handleViewportChange = () => onClose();

        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        window.addEventListener('resize', handleViewportChange);
        document.addEventListener('scroll', handleViewportChange, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('resize', handleViewportChange);
            document.removeEventListener('scroll', handleViewportChange, true);
        };
    }, [anchor.anchorElement, onClose]);

    return createPortal(
        <div
            ref={menuRef}
            role="menu"
            aria-label={`${character.name}の衣装`}
            style={{
                position: 'fixed',
                left,
                ...(placeAbove
                    ? { bottom: window.innerHeight - anchor.anchorTop + 6 }
                    : { top: anchor.anchorBottom + 6 }),
                width: menuWidth,
                maxHeight: 320,
                overflowY: 'auto',
                padding: 6,
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                background: 'var(--bg-primary)',
                boxShadow: '0 12px 28px rgba(0,0,0,0.28)',
                zIndex: 80,
            }}
        >
            <div style={{ padding: '0.375rem 0.5rem', color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 600 }}>
                衣装
            </div>
            {costumeOptions.map((option) => {
                const active = option.name === resolvedCostumeName;
                return (
                    <button
                        key={option.name}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => onSelect(option.name)}
                        style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            border: 'none',
                            borderRadius: 6,
                            background: active ? 'var(--bg-tertiary)' : 'transparent',
                            color: 'var(--text-primary)',
                            cursor: 'pointer',
                            textAlign: 'left',
                        }}
                    >
                        <span style={{
                            width: 30,
                            height: 42,
                            flexShrink: 0,
                            overflow: 'hidden',
                            borderRadius: 4,
                            border: '1px solid var(--border-color)',
                            background: 'var(--bg-secondary)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}>
                            {option.image ? (
                                <StoredImage src={option.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                                <Shirt size={14} style={{ color: 'var(--text-muted)' }} />
                            )}
                        </span>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {option.name} <small>{option.kind === 'vrm' ? '3D' : '2D'}</small>
                        </span>
                        {active && <Check size={15} style={{ flexShrink: 0, color: 'var(--accent-primary)' }} />}
                    </button>
                );
            })}
        </div>,
        document.body,
    );
}

interface TemporaryActorDeleteDialogProps {
    actor: TemporaryActorDraft;
    onCancel: () => void;
    onConfirm: () => void;
}

function TemporaryActorDeleteDialog({ actor, onCancel, onConfirm }: TemporaryActorDeleteDialogProps) {
    const modalRef = useRef<HTMLDivElement>(null);

    useModalKeyboard({
        isOpen: true,
        containerRef: modalRef,
        onClose: onCancel,
    });

    return (
        <div
            className="modal-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onCancel();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content"
                onClick={(event) => event.stopPropagation()}
                style={{ maxWidth: 400 }}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="temporary-actor-delete-title"
                aria-describedby="temporary-actor-delete-description"
            >
                <div className="modal-body">
                    <div id="temporary-actor-delete-title" style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                        本当に削除しますか？
                    </div>
                    <p id="temporary-actor-delete-description" style={{ margin: 0, fontSize: '0.8125rem', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                        「{actor.name}」をその他の登場人物から削除します。
                    </p>
                </div>
                <div className="modal-footer">
                    <button type="button" className="btn btn-secondary" onClick={onCancel} autoFocus>
                        キャンセル
                    </button>
                    <button type="button" className="btn btn-danger" onClick={onConfirm}>
                        <Trash2 size={16} />
                        削除
                    </button>
                </div>
            </div>
        </div>
    );
}

function SituationSettingsModalForm({ onClose, situation, room, onCreated }: Omit<SituationSettingsModalProps, 'isOpen'>) {
    const {
        characters,
        defaultAutoGenerationModel,
        createSituationRoom,
        updateSituation,
        updateRoomSettings,
    } = useStore();

    const isEditing = !!situation;
    const sortedCharacters = useMemo(() => [...characters].sort((a, b) => b.updatedAt - a.updatedAt), [characters]);
    const initial = buildInitialState(situation, room);
    const initialDraftRef = useRef(initial);
    const [name, setName] = useState(initial.name);
    const [backgroundImage, setBackgroundImage] = useState(initial.backgroundImage);
    const [situationPrompt, setSituationPrompt] = useState(initial.situationPrompt);
    const [characterCommonRules, setCharacterCommonRules] = useState(initial.characterCommonRules);
    const [maxAutoTurns, setMaxAutoTurns] = useState(initial.maxAutoTurns);
    const [limitTurns, setLimitTurns] = useState(initial.limitTurns);
    const [maxHistory, setMaxHistory] = useState(initial.maxHistory);
    const [memoryReadOnly, setMemoryReadOnly] = useState(initial.memoryReadOnly);
    const [separateNarration, setSeparateNarration] = useState(initial.separateNarration);
    const [priorMessages, setPriorMessages] = useState<SituationPriorMessage[]>(initial.priorMessages);
    const [selectedCharacterIds, setSelectedCharacterIds] = useState<Set<string>>(initial.selectedCharacterIds);
    const [characterActorMeta, setCharacterActorMeta] = useState<Record<string, CharacterActorMeta>>(initial.characterActorMeta);
    const [temporaryActors, setTemporaryActors] = useState<TemporaryActorDraft[]>(initial.temporaryActors);
    const [costumeMenu, setCostumeMenu] = useState<CostumeMenuState | null>(null);
    const [descriptionGeneratorOpen, setDescriptionGeneratorOpen] = useState(false);
    const [backgroundEditorOpen, setBackgroundEditorOpen] = useState(false);
    const [characterSelectionOpen, setCharacterSelectionOpen] = useState(false);
    const [temporaryActorPendingDelete, setTemporaryActorPendingDelete] = useState<TemporaryActorDraft | null>(null);
    const [temporaryActorModal, setTemporaryActorModal] = useState<{
        actor: TemporaryActorDraft;
        isNew: boolean;
    } | null>(null);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const closeCostumeMenu = useCallback(() => setCostumeMenu(null), []);

    const validTemporaryActors = useMemo(
        () => temporaryActors.filter((actor) => actor.name.trim()),
        [temporaryActors],
    );
    const actorCount = selectedCharacterIds.size + validTemporaryActors.length;
    const selectedCharacters = useMemo(
        () => sortedCharacters.filter((character) => selectedCharacterIds.has(character.id)),
        [selectedCharacterIds, sortedCharacters],
    );
    const costumeMenuCharacter = costumeMenu
        ? characters.find((character) => character.id === costumeMenu.characterId) ?? null
        : null;
    const parsedMaxTurns = Math.max(
        MIN_SITUATION_MAX_TURNS,
        Math.min(MAX_SITUATION_MAX_TURNS, Math.round(Number(maxAutoTurns) || DEFAULT_SITUATION_MAX_TURNS)),
    );
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
                expressionNames: getVisualNovelExpressionNames(
                    character,
                    characterActorMeta[character.id]?.costumeName,
                ),
            })),
        ...temporaryActors
            .filter((actor) => actor.name.trim())
            .map((actor) => ({
                id: actor.id,
                name: actor.name.trim(),
                icon: actor.icon ?? undefined,
                expressionNames: getVisualNovelExpressionNames(actor),
            })),
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

    const selectCharacterCostume = (characterId: string, costumeName: string) => {
        setCharacterActorMeta((meta) => {
            const current = meta[characterId] ?? { id: characterId };
            if (costumeName === DEFAULT_COSTUME_NAME) {
                const nextCurrent = { ...current };
                delete nextCurrent.costumeName;
                return { ...meta, [characterId]: nextCurrent };
            }
            return {
                ...meta,
                [characterId]: { ...current, costumeName },
            };
        });
        setCostumeMenu(null);
    };

    const addTemporaryActor = () => {
        setTemporaryActorModal({ actor: createTemporaryDraft(), isNew: true });
    };

    const editTemporaryActor = (actor: TemporaryActorDraft) => {
        setTemporaryActorModal({ actor: { ...actor }, isNew: false });
    };

    const saveTemporaryActor = (actor: TemporaryActorDraft) => {
        setTemporaryActors((current) => {
            const exists = current.some((item) => item.id === actor.id);
            return exists
                ? current.map((item) => item.id === actor.id ? actor : item)
                : [...current, actor];
        });
        setTemporaryActorModal(null);
    };

    const removeTemporaryActor = (id: string) => {
        setTemporaryActors((prev) => prev.filter((actor) => actor.id !== id));
        setTemporaryActorPendingDelete(null);
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
        const actor = actorOptions.find((option) => option.id === actorId);
        setPriorMessages((messages) => messages.map((message) => (
            message.id === id && message.role === 'assistant'
                ? (() => {
                    const next = { ...message, actorId };
                    if (!message.expression || actor?.expressionNames.includes(message.expression)) return next;
                    delete next.expression;
                    return next;
                })()
                : message
        )));
    };

    const updatePriorMessageExpression = (id: string, expression: string) => {
        setPriorMessages((messages) => messages.map((message) => {
            if (message.id !== id || message.role !== 'assistant') return message;
            const next = { ...message };
            if (expression) {
                next.expression = expression;
            } else {
                delete next.expression;
            }
            return next;
        }));
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
                ...(meta?.costumeName ? { costumeName: meta.costumeName } : {}),
                ...(meta?.rolePrompt ? { rolePrompt: meta.rolePrompt } : {}),
            };
        }),
        ...validTemporaryActors.map((actor) => ({
            id: actor.id,
            type: 'temporary' as const,
            name: actor.name.trim(),
            systemPrompt: actor.systemPrompt.trim(),
            ...(actor.speechStyle.trim() ? { speechStyle: actor.speechStyle.trim() } : {}),
            ...(actor.userConstraints.trim() ? { userConstraints: actor.userConstraints.trim() } : {}),
            ...(actor.icon ? { icon: actor.icon } : {}),
            ...(actor.expressions.length > 0 ? { expressions: actor.expressions } : {}),
            ...(actor.costumes.length > 0 ? { costumes: actor.costumes } : {}),
        })),
    ], [characterActorMeta, selectedCharacterIds, validTemporaryActors]);

    const saveAndClose = useCallback(() => {
        if (isEditing) {
            const currentDraft = {
                name,
                backgroundImage,
                situationPrompt,
                characterCommonRules,
                maxAutoTurns,
                limitTurns,
                maxHistory,
                memoryReadOnly,
                separateNarration,
                priorMessages,
                selectedCharacterIds,
                characterActorMeta,
                temporaryActors,
            };
            if (serializeSituationDraft(currentDraft) === serializeSituationDraft(initialDraftRef.current)) {
                onClose();
                return;
            }
        }

        const actors = buildActors();
        const effectiveActors = actors.length > 0 ? actors : situation?.actors ?? [];
        const validActorIds = new Set(effectiveActors.map((actor) => actor.id));
        const fallbackActorId = effectiveActors[0]?.id ?? '';
        const priorMessagesForSave = priorMessages.map((message) => {
            if (message.role !== 'assistant') return message;
            const actorId = validActorIds.has(message.actorId) ? message.actorId : fallbackActorId;
            const actor = actorOptions.find((option) => option.id === actorId);
            const next = { ...message, actorId };
            if (!message.expression || actor?.expressionNames.includes(message.expression)) return next;
            delete next.expression;
            return next;
        });

        if (situation) {
            updateSituation(situation.id, {
                name: name.trim() || 'シチュエーション',
                backgroundImage: backgroundImage || undefined,
                situationPrompt: situationPrompt.trim(),
                characterCommonRules: characterCommonRules.trim(),
                priorMessages: priorMessagesForSave,
                actors,
                maxTurns: effectiveMaxTurns,
                limitTurns,
                memoryMode: memoryReadOnly ? 'readOnly' : 'off',
                separateNarration,
                maxHistory: parsedMaxHistory,
            });
            if (room?.id) {
                updateRoomSettings(room.id, { maxMentionChain: effectiveMaxTurns });
            }
        } else if (actorCount > 0) {
            createSituationRoom({
                name: name.trim() || undefined,
                backgroundImage: backgroundImage || undefined,
                situationPrompt: situationPrompt.trim(),
                characterCommonRules: characterCommonRules.trim(),
                priorMessages: priorMessagesForSave,
                actors,
                maxTurns: effectiveMaxTurns,
                limitTurns,
                memoryMode: memoryReadOnly ? 'readOnly' : 'off',
                separateNarration,
                maxHistory: parsedMaxHistory,
            });
            onCreated?.();
        }

        onClose();
    }, [actorCount, actorOptions, backgroundImage, buildActors, characterActorMeta, characterCommonRules, createSituationRoom, effectiveMaxTurns, isEditing, limitTurns, maxAutoTurns, maxHistory, memoryReadOnly, name, onClose, onCreated, parsedMaxHistory, priorMessages, room, selectedCharacterIds, separateNarration, situation, situationPrompt, temporaryActors, updateRoomSettings, updateSituation]);

    const modalRef = useRef<HTMLDivElement>(null);
    useModalKeyboard({
        isOpen: true,
        containerRef: modalRef,
        onClose: isEditing ? saveAndClose : onClose,
        canClose: !descriptionGeneratorOpen
            && !backgroundEditorOpen
            && !characterSelectionOpen
            && costumeMenu === null
            && temporaryActorPendingDelete === null
            && temporaryActorModal === null,
    });

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
                    ref={modalRef}
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

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                        <label htmlFor="situation-character-common-rules-input" style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                            キャラクターの共通ルール
                        </label>
                        <textarea
                            id="situation-character-common-rules-input"
                            value={characterCommonRules}
                            onChange={(e) => setCharacterCommonRules(e.target.value)}
                            rows={4}
                            placeholder="参加キャラクター全員に適用するルール"
                            style={{ ...fieldStyle, resize: 'vertical', minHeight: 96 }}
                        />
                    </div>

                    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={sectionLabelStyle}>
                                <MessagesSquare size={16} />
                                直前の会話
                            </div>
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
                                    if (message.role === 'narration') {
                                        return (
                                            <div key={message.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                                                    <span style={{ marginRight: 'auto', paddingLeft: '0.25rem', color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 500 }}>
                                                        ナレーション
                                                    </span>
                                                    {renderPriorMessageActions(message.id, index)}
                                                </div>
                                                <div className="situation-narration" style={{ maxWidth: '100%', margin: 0 }}>
                                                    <textarea
                                                        value={message.content}
                                                        onChange={(event) => updatePriorMessageContent(message.id, event.target.value)}
                                                        rows={3}
                                                        placeholder="場面全体の描写"
                                                        aria-label={`${index + 1}件目のナレーション`}
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
                                                            lineHeight: 1.6,
                                                            textAlign: 'left',
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        );
                                    }

                                    if (message.role === 'user') {
                                        return (
                                            <div key={message.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', width: '80%', gap: '0.375rem' }}>
                                                    <span style={{ marginRight: 'auto', paddingLeft: '0.25rem', color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 500 }}>
                                                        {'{{user}}'}
                                                    </span>
                                                    {renderPriorMessageActions(message.id, index)}
                                                </div>
                                                <div className="message-bubble user" style={{ width: '80%', maxWidth: '80%', padding: '0.65rem 0.875rem' }}>
                                                    <textarea
                                                        value={message.content}
                                                        onChange={(event) => updatePriorMessageContent(message.id, event.target.value)}
                                                        rows={3}
                                                        placeholder="{{user}}の発言"
                                                        aria-label={`${index + 1}件目のユーザーの発言`}
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
                                    const selectedExpression = selectedActor?.expressionNames.includes(message.expression ?? '')
                                        ? message.expression ?? ''
                                        : '';
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
                                                    <OptionSelector
                                                        value={selectedActor?.id ?? ''}
                                                        onChange={(actorId) => updatePriorMessageActor(message.id, actorId)}
                                                        ariaLabel={`${index + 1}件目の発言キャラクター`}
                                                        style={{ flex: '1 1 0', minWidth: 0 }}
                                                        triggerStyle={priorMessageSelectTriggerStyle}
                                                        menuStyle={{ minWidth: '10rem' }}
                                                        chevronSize={12}
                                                        options={actorOptions.map((actor) => ({
                                                            value: actor.id,
                                                            label: actor.name,
                                                        }))}
                                                    />
                                                    <OptionSelector
                                                        value={selectedExpression}
                                                        onChange={(expression) => updatePriorMessageExpression(message.id, expression)}
                                                        disabled={!selectedActor || selectedActor.expressionNames.length === 0}
                                                        ariaLabel={`${index + 1}件目の表情`}
                                                        title={selectedActor?.expressionNames.length ? '表情' : '登録済みの表情がありません'}
                                                        style={{ flex: '1 1 0', minWidth: 0 }}
                                                        triggerStyle={priorMessageSelectTriggerStyle}
                                                        menuStyle={{ minWidth: '10rem' }}
                                                        chevronSize={12}
                                                        options={[
                                                            { value: '', label: '表情指定なし' },
                                                            ...(selectedActor?.expressionNames.map((expressionName) => ({
                                                                value: expressionName,
                                                                label: expressionName,
                                                            })) ?? []),
                                                        ]}
                                                    />
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
                                    {'{{user}}'}の発言
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
                                <button type="button" className="btn btn-secondary" onClick={() => addPriorMessage('narration')}>
                                    <Plus size={15} />
                                    ナレーション
                                </button>
                            </div>
                        </div>
                    </section>

                    <SwitchRow
                        label="メモリの参照"
                        checked={memoryReadOnly}
                        onToggle={() => setMemoryReadOnly((value) => !value)}
                    />
                    <SwitchRow
                        label="ナレーションを分ける"
                        description="場面全体の描写を、キャラクターの発言とは別のナレーションとして生成します（メッセージ形式では無効）。"
                        checked={separateNarration}
                        onToggle={() => setSeparateNarration((value) => !value)}
                    />

                    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                            <div style={sectionLabelStyle}>
                                <ImageIcon size={16} />
                                背景
                            </div>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => setBackgroundEditorOpen(true)}
                            >
                                編集
                            </button>
                        </div>
                        {backgroundImage ? (
                            <div
                                style={{
                                    width: 'min(100%, 22rem)',
                                    aspectRatio: '16 / 9',
                                    overflow: 'hidden',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: '0.625rem',
                                    background: 'var(--bg-secondary)',
                                }}
                            >
                                <StoredImage
                                    src={backgroundImage}
                                    alt="設定中の背景"
                                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                />
                            </div>
                        ) : (
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', padding: '0.25rem 0' }}>
                                設定されていません
                            </div>
                        )}
                    </section>

                    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                            <div style={sectionLabelStyle}>
                                <Users size={16} />
                                既存キャラクター
                            </div>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => setCharacterSelectionOpen(true)}
                            >
                                編集
                            </button>
                        </div>
                        {selectedCharacters.length > 0 ? (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 5.5rem)', gap: '0.5rem', justifyContent: 'start' }}>
                                {selectedCharacters.map((character) => {
                                    const costumeOptions = getVisualNovelCostumeOptions(character);
                                    const storedCostumeName = characterActorMeta[character.id]?.costumeName ?? DEFAULT_COSTUME_NAME;
                                    const selectedCostumeName = costumeOptions.some((option) => option.name === storedCostumeName)
                                        ? storedCostumeName
                                        : DEFAULT_COSTUME_NAME;
                                    const menuOpen = costumeMenu?.characterId === character.id;
                                    return (
                                        <div
                                            key={character.id}
                                            style={{
                                                display: 'flex',
                                                flexDirection: 'column',
                                                alignItems: 'center',
                                                gap: '0.375rem',
                                                width: '5.5rem',
                                                minWidth: 0,
                                                padding: '0.375rem',
                                                textAlign: 'center',
                                            }}
                                        >
                                            <div style={{ position: 'relative', width: 56, height: 56, flexShrink: 0 }}>
                                                <div style={{ width: 56, height: 56, borderRadius: '50%', overflow: 'hidden', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                    {character.icon ? (
                                                        <StoredImage src={character.icon} alt={character.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                    ) : (
                                                        <User size={28} style={{ color: 'var(--text-muted)' }} />
                                                    )}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        const anchorElement = event.currentTarget;
                                                        const rect = anchorElement.getBoundingClientRect();
                                                        setCostumeMenu((current) => current?.characterId === character.id
                                                            ? null
                                                            : {
                                                                characterId: character.id,
                                                                anchorElement,
                                                                anchorTop: rect.top,
                                                                anchorRight: rect.right,
                                                                anchorBottom: rect.bottom,
                                                            });
                                                    }}
                                                    title={`衣装: ${selectedCostumeName}`}
                                                    aria-label={`${character.name}の衣装を選択`}
                                                    aria-haspopup="menu"
                                                    aria-expanded={menuOpen}
                                                    style={{
                                                        position: 'absolute',
                                                        top: -5,
                                                        right: -7,
                                                        width: 24,
                                                        height: 24,
                                                        padding: 0,
                                                        border: '1px solid var(--border-color)',
                                                        borderRadius: '50%',
                                                        background: 'var(--bg-primary)',
                                                        color: selectedCostumeName === DEFAULT_COSTUME_NAME
                                                            ? 'var(--text-secondary)'
                                                            : 'var(--accent-primary)',
                                                        cursor: 'pointer',
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.25)',
                                                    }}
                                                >
                                                    <EllipsisVertical size={15} />
                                                </button>
                                            </div>
                                            <span title={character.name} style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.75rem', lineHeight: 1.25 }}>
                                                {character.name}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', padding: '0.25rem 0' }}>
                                選択されていません
                            </div>
                        )}
                    </section>

                    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                            <div style={sectionLabelStyle}>
                                <User size={16} />
                                その他の登場人物
                            </div>
                            <button type="button" className="btn btn-secondary" onClick={addTemporaryActor}>
                                <Plus size={16} />
                                追加
                            </button>
                        </div>

                        {temporaryActors.length > 0 && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 5.5rem)', gap: '0.5rem', justifyContent: 'start' }}>
                                {temporaryActors.map((actor) => (
                                    <div
                                        key={actor.id}
                                        style={{
                                            position: 'relative',
                                            width: '5.5rem',
                                            minWidth: 0,
                                        }}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => editTemporaryActor(actor)}
                                            aria-label={`${actor.name}の設定を編集`}
                                            style={{
                                                width: '100%',
                                                minWidth: 0,
                                                display: 'flex',
                                                flexDirection: 'column',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.375rem',
                                                minHeight: '6.75rem',
                                                padding: '0.625rem 0.375rem 0.5rem',
                                                border: 'none',
                                                background: 'transparent',
                                                color: 'var(--text-primary)',
                                                cursor: 'pointer',
                                                textAlign: 'center',
                                                font: 'inherit',
                                            }}
                                        >
                                            <div style={{ width: 56, height: 56, borderRadius: '50%', overflow: 'hidden', flexShrink: 0, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                {actor.icon ? (
                                                    <StoredImage src={actor.icon} alt={actor.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                                ) : (
                                                    <User size={28} style={{ color: 'var(--text-muted)' }} />
                                                )}
                                            </div>
                                            <span title={actor.name} style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.75rem', lineHeight: 1.25 }}>
                                                {actor.name}
                                            </span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setTemporaryActorPendingDelete(actor)}
                                            style={{
                                                position: 'absolute',
                                                top: '0.25rem',
                                                right: '0.125rem',
                                                zIndex: 1,
                                                width: 22,
                                                height: 22,
                                                padding: 0,
                                                borderRadius: '50%',
                                                border: '1px solid var(--border-color)',
                                                background: 'var(--bg-primary)',
                                                color: 'var(--text-secondary)',
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                boxShadow: '0 1px 4px rgba(0, 0, 0, 0.25)',
                                            }}
                                            title={`${actor.name}を削除する`}
                                            aria-label={`${actor.name}を削除する`}
                                        >
                                            <X size={13} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    <div style={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>
                        <button
                            type="button"
                            onClick={() => setAdvancedOpen((open) => !open)}
                            aria-expanded={advancedOpen}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.375rem',
                                width: '100%',
                                padding: 0,
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--text-secondary)',
                                cursor: 'pointer',
                                textAlign: 'left',
                            }}
                        >
                            {advancedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>高度な設定</span>
                        </button>
                    </div>

                    {advancedOpen && (
                        <section
                            style={{
                                padding: '1rem',
                                borderRadius: '0.5rem',
                                background: 'var(--bg-secondary)',
                            }}
                        >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {actorCount > 1 && (
                                    <>
                                        <SwitchRow
                                            label="会話の連鎖上限を設定"
                                            description="OFFのときは、場面に応じて発言数をAIが決めます。"
                                            checked={limitTurns}
                                            onToggle={() => setLimitTurns((value) => !value)}
                                        />
                                        {limitTurns && (
                                            <MaxAutoTurnsSlider value={parsedMaxTurns} onChange={setMaxAutoTurns} />
                                        )}
                                    </>
                                )}
                                <MaxHistorySlider value={maxHistory} onChange={setMaxHistory} />
                            </div>
                        </section>
                    )}
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

            {backgroundEditorOpen && (
                <SituationBackgroundModal
                    isOpen
                    currentImage={backgroundImage || undefined}
                    initialPrompt={[name.trim(), situationPrompt.trim()].filter(Boolean).join('\n\n')}
                    onClose={() => setBackgroundEditorOpen(false)}
                    onComplete={(image) => setBackgroundImage(image ?? '')}
                />
            )}

            {costumeMenu && costumeMenuCharacter && (
                <CharacterCostumeMenu
                    character={costumeMenuCharacter}
                    selectedCostumeName={characterActorMeta[costumeMenuCharacter.id]?.costumeName ?? DEFAULT_COSTUME_NAME}
                    anchor={costumeMenu}
                    onSelect={(costumeName) => selectCharacterCostume(costumeMenuCharacter.id, costumeName)}
                    onClose={closeCostumeMenu}
                />
            )}

            {characterSelectionOpen && (
                <CharacterSelectionModal
                    characters={sortedCharacters}
                    selectedCharacterIds={selectedCharacterIds}
                    onToggle={toggleCharacter}
                    onClose={() => setCharacterSelectionOpen(false)}
                />
            )}

            {temporaryActorPendingDelete && (
                <TemporaryActorDeleteDialog
                    actor={temporaryActorPendingDelete}
                    onCancel={() => setTemporaryActorPendingDelete(null)}
                    onConfirm={() => removeTemporaryActor(temporaryActorPendingDelete.id)}
                />
            )}

            {temporaryActorModal && (
                <TemporaryActorSettingsModal
                    key={`${temporaryActorModal.actor.id}:${temporaryActorModal.isNew ? 'new' : 'edit'}`}
                    actor={temporaryActorModal.actor}
                    isNew={temporaryActorModal.isNew}
                    onClose={() => setTemporaryActorModal(null)}
                    onSave={saveTemporaryActor}
                />
            )}
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
