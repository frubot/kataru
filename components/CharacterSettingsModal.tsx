'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Brain, ChevronDown, ChevronRight, RotateCcw, User, Smile, Shirt, Info, Sparkles, FileText, LayoutList } from 'lucide-react';
import {
    useStore,
    Character,
    Costume,
    Expression,
    DEFAULT_CHARACTER_MAX_HISTORY,
    DEFAULT_CHARACTER_MAX_TOKENS,
    DEFAULT_CHARACTER_TEMPERATURE,
    DEFAULT_CHARACTER_TOP_P,
    DEFAULT_CHARACTER_TOP_K,
} from '@/lib/store';
import ImageGenerationModal from './ImageGenerationModal';
import ExpressionDiffModal from './ExpressionDiffModal';
import CostumeDiffModal from './CostumeDiffModal';
import CharacterGeneratorModal from './CharacterGeneratorModal';
import PromptBlockEditor from './PromptBlockEditor';
import StoredImage from './StoredImage';

const NEUTRAL_NAME = 'neutral';
const DEFAULT_COSTUME_NAME = 'default';
const CHARACTER_PROMPT_SECTION_TITLE = 'キャラクターについて';
const PROTAGONIST_PROMPT_SECTION_TITLE = '主人公について';

interface CharacterSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    character: Character | null;
    isNew?: boolean;
    onOpenMemoryList?: () => void;
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
};

const MAX_HISTORY_SLIDER_MAX = 100;
const DEFAULT_MAX_HISTORY_SLIDER_VALUE = DEFAULT_CHARACTER_MAX_HISTORY == null
    ? MAX_HISTORY_SLIDER_MAX
    : Math.max(1, Math.min(MAX_HISTORY_SLIDER_MAX, Math.round(DEFAULT_CHARACTER_MAX_HISTORY)));
const DEFAULT_MAX_TOKENS_PLACEHOLDER = DEFAULT_CHARACTER_MAX_TOKENS == null
    ? 'デフォルト（指定なし）'
    : `デフォルト（${DEFAULT_CHARACTER_MAX_TOKENS}）`;
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
export default function CharacterSettingsModal({ isOpen, onClose, character, isNew = false, onOpenMemoryList }: CharacterSettingsModalProps) {
    const { createCharacter, updateCharacter, defaultChatModel } = useStore();
    const [name, setName] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');
    const [protagonistPrompt, setProtagonistPrompt] = useState('');
    const [model, setModel] = useState(defaultChatModel);
    const [useBlockEditor, setUseBlockEditor] = useState(true);

    // Summary / compression settings
    const [enableSummary, setEnableSummary] = useState(true);

    // Memory settings
    const [enableMemory, setEnableMemory] = useState(true);

    // Character inner thought settings
    const [thinkModeEnabled, setThinkModeEnabled] = useState(false);

    // Parameter settings
    const [parametersOpen, setParametersOpen] = useState(false);
    const [maxTokens, setMaxTokens] = useState<string>('');
    const [maxHistory, setMaxHistory] = useState<string>('');
    // null = use code default, number = custom value
    const [temperature, setTemperature] = useState<number | null>(null);
    const [topP, setTopP] = useState<number | null>(null);
    const [topK, setTopK] = useState<number | null>(null);

    // Avatar
    const [icon, setIcon] = useState<string | null>(null);

    // Expressions
    const [expressions, setExpressions] = useState<Expression[]>([]);
    const [costumes, setCostumes] = useState<Costume[]>([]);
    const [imageGenOpen, setImageGenOpen] = useState(false);
    const [characterGeneratorOpen, setCharacterGeneratorOpen] = useState(false);
    const [expressionsOpen, setExpressionsOpen] = useState(false);
    const [costumesOpen, setCostumesOpen] = useState(false);

    useEffect(() => {
        if (character) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setName(character.name);
            setSystemPrompt(character.systemPrompt);
            setProtagonistPrompt(character.protagonistPrompt ?? '');
            setModel(character.model.trim() || defaultChatModel);
            setEnableMemory(character.enableMemory ?? true);
            setEnableSummary(character.enableSummary ?? true);
            setThinkModeEnabled(character.thinkModeEnabled === true);
            setMaxTokens(character.maxTokens != null ? String(character.maxTokens) : '');
            setMaxHistory(character.maxHistory != null ? String(character.maxHistory) : '');
            setTemperature(character.temperature ?? null);
            setTopP(character.topP ?? null);
            setTopK(character.topK ?? null);
            setIcon(character.icon ?? null);
            setExpressions(character.expressions ?? []);
            setCostumes(character.costumes ?? []);
        } else {
            setName('');
            setSystemPrompt('');
            setProtagonistPrompt('');
            setModel(defaultChatModel);
            setEnableMemory(true);
            setEnableSummary(true);
            setThinkModeEnabled(false);
            setMaxTokens('');
            setMaxHistory('');
            setTemperature(null);
            setTopP(null);
            setTopK(null);
            setIcon(null);
            setExpressions([]);
            setCostumes([]);
        }
        setParametersOpen(false);
    }, [character, defaultChatModel, isOpen]);

    useEffect(() => {
        if (!isOpen) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setCharacterGeneratorOpen(false);
        }
    }, [isOpen]);

    const saveAndClose = useCallback(() => {
        const trimmedName = name.trim();

        // 必須の名前が未入力の新規画面は、空のキャラクターを作らずに閉じる。
        if ((isNew || !character) && !trimmedName) {
            onClose();
            return;
        }

        const resolvedModel = model.trim() || defaultChatModel;
        const updates = {
            name: trimmedName || character?.name || 'キャラクター',
            systemPrompt,
            protagonistPrompt: protagonistPrompt.trim() ? protagonistPrompt : undefined,
            model: resolvedModel,
            enableMemory,
            enableSummary,
            thinkModeEnabled,
            maxTokens: maxTokens ? Number(maxTokens) : undefined,
            maxHistory: maxHistory ? Math.min(100, Math.max(1, Number(maxHistory))) : undefined,
            temperature: temperature ?? undefined,
            topP: topP ?? undefined,
            topK: topK != null ? Math.max(0, Math.round(topK)) : undefined,
            icon: icon ?? undefined,
            expressions: expressions.length > 0 ? expressions : undefined,
            costumes: costumes.length > 0 ? costumes : undefined,
        };

        if (isNew || !character) {
            createCharacter(trimmedName, systemPrompt, resolvedModel, updates);
        } else {
            updateCharacter(character.id, updates);
        }
        onClose();
    }, [character, costumes, createCharacter, defaultChatModel, enableMemory, enableSummary, expressions, icon, isNew, maxHistory, maxTokens, model, name, onClose, protagonistPrompt, systemPrompt, temperature, thinkModeEnabled, topK, topP, updateCharacter]);

    useEffect(() => {
        const childModalOpen = imageGenOpen || characterGeneratorOpen || expressionsOpen || costumesOpen;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isOpen && e.key === 'Escape' && !childModalOpen) {
                if (isNew || !character) {
                    onClose();
                } else {
                    saveAndClose();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [character, characterGeneratorOpen, costumesOpen, expressionsOpen, imageGenOpen, isNew, isOpen, onClose, saveAndClose]);

    if (!isOpen) return null;

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

    // パラメータに何かカスタム値が設定されているか
    const hasCustomParams = maxTokens || maxHistory || temperature !== null || topP !== null || topK !== null;
    const combinedPromptEditorStyle: React.CSSProperties = {
        border: '1px solid var(--border-color)',
        borderRadius: '0.5rem',
        background: 'var(--bg-primary)',
        padding: '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.875rem',
    };
    const fixedPromptLabelStyle: React.CSSProperties = {
        fontSize: '0.8125rem',
        fontWeight: 600,
        color: 'var(--text-secondary)',
        marginBottom: '0.5rem',
    };

    return (
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                    if (isNew || !character) {
                        onClose();
                    } else {
                        saveAndClose();
                    }
                }
            }}
        >
            <div
                className="modal-content settings-form-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={isNew ? '新しいキャラクター' : 'キャラクター設定'}
            >
                <div className="settings-form-modal-actions">
                    {isNew && (
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => setCharacterGeneratorOpen(true)}
                            title="AIでキャラクター生成"
                            aria-label="AIでキャラクター生成"
                        >
                            <Sparkles size={16} />
                        </button>
                    )}
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

                <div className="modal-body">
                    {/* アバター */}
                    <div style={{ ...sectionStyle, display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                        <button
                            type="button"
                            onClick={() => setImageGenOpen(true)}
                            title="アバターを変更"
                            style={{
                                width: '72px',
                                height: '72px',
                                borderRadius: '50%',
                                border: '2px dashed var(--border)',
                                background: 'var(--bg-secondary)',
                                cursor: 'pointer',
                                overflow: 'hidden',
                                flexShrink: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: 0,
                            }}
                        >
                            {icon ? (
                                <StoredImage src={icon} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            ) : (
                                <User size={28} style={{ color: 'var(--text-muted)' }} />
                            )}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            {renderLabelWithInfo('アバター画像', '表情・衣装差分にも使用されます', {
                                marginBottom: '0.25rem',
                                labelStyleOverride: { fontSize: '0.8125rem' },
                            })}
                            {icon && (
                                <button
                                    type="button"
                                    onClick={() => setIcon(null)}
                                    style={{ fontSize: '0.75rem', color: 'var(--error)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginTop: '0.25rem' }}
                                >
                                    削除
                                </button>
                            )}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => setCostumesOpen(true)}
                                title={!expressions.some((e) => e.name === NEUTRAL_NAME) ? '生成には「アバター画像」から立ち絵の登録が必要です。アップロードなら直接追加できます' : undefined}
                                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem' }}
                            >
                                <Shirt size={14} /> 衣装差分
                                {costumes.length > 0 && (
                                    <span style={{ fontSize: '0.6875rem', opacity: 0.7 }}>({costumes.length})</span>
                                )}
                            </button>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => setExpressionsOpen(true)}
                                title={!expressions.some((e) => e.name === NEUTRAL_NAME) ? 'デフォルトの立ち絵が登録されていない場合でも追加できます' : undefined}
                                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem' }}
                            >
                                <Smile size={14} /> 表情差分
                                {expressions.length > 0 && (
                                    <span style={{ fontSize: '0.6875rem', opacity: 0.7 }}>({expressions.length})</span>
                                )}
                            </button>
                        </div>
                    </div>

                    {/* キャラクター名 */}
                    <div style={sectionStyle}>
                        <label style={labelStyle}>キャラクター名</label>
                        <input
                            type="text"
                            className="input"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="キャラクターの名前"
                        />
                    </div>

                    {/* モデル */}
                    <div style={sectionStyle}>
                        {renderLabelWithInfo('モデル', '選択中の接続先で利用可能なモデル名を入力してください')}
                        <input
                            type="text"
                            className="input"
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            placeholder="例: moonshotai/kimi-k2.6"
                        />
                    </div>

                    {/* システムプロンプト */}
                    <div style={sectionStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                            <label style={{ ...labelStyle, marginBottom: 0 }}>{useBlockEditor ? '設定プロンプト' : 'キャラクターについて'}</label>
                            <button
                                type="button"
                                onClick={() => setUseBlockEditor((v) => !v)}
                                title={useBlockEditor ? 'テキスト編集に切り替え' : 'ブロック編集に切り替え'}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.25rem',
                                    padding: '0.25rem 0.5rem',
                                    borderRadius: '0.375rem',
                                    border: '1px solid var(--border-color)',
                                    background: useBlockEditor ? 'rgba(var(--accent-primary-rgb), 0.12)' : 'var(--bg-secondary)',
                                    color: useBlockEditor ? 'var(--accent-primary)' : 'var(--text-muted)',
                                    fontSize: '0.75rem',
                                    cursor: 'pointer',
                                    transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                                }}
                            >
                                {useBlockEditor ? <LayoutList size={13} /> : <FileText size={13} />}
                                {useBlockEditor ? 'ブロック' : 'テキスト'}
                            </button>
                        </div>
                        {useBlockEditor ? (
                            <div style={combinedPromptEditorStyle}>
                                <div>
                                    <div style={fixedPromptLabelStyle}>{CHARACTER_PROMPT_SECTION_TITLE}</div>
                                    <PromptBlockEditor
                                        markdown={systemPrompt}
                                        onChange={setSystemPrompt}
                                        placeholder="キャラクターに関する詳細を記述してください..."
                                        frame={false}
                                        minHeight="96px"
                                        maxHeight={null}
                                    />
                                </div>
                                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '0.875rem' }}>
                                    <div style={fixedPromptLabelStyle}>{PROTAGONIST_PROMPT_SECTION_TITLE}</div>
                                    <PromptBlockEditor
                                        markdown={protagonistPrompt}
                                        onChange={setProtagonistPrompt}
                                        placeholder="主人公に関する詳細を記述してください..."
                                        frame={false}
                                        minHeight="96px"
                                        maxHeight={null}
                                    />
                                </div>
                            </div>
                        ) : (
                            <textarea
                                className="input textarea"
                                value={systemPrompt}
                                onChange={(e) => setSystemPrompt(e.target.value)}
                                placeholder="キャラクターに関する詳細を記述してください..."
                                style={{ minHeight: '150px' }}
                            />
                        )}
                    </div>

                    {!useBlockEditor && (
                        <div style={sectionStyle}>
                            <label style={labelStyle}>主人公について</label>
                            <textarea
                                className="input textarea"
                                value={protagonistPrompt}
                                onChange={(e) => setProtagonistPrompt(e.target.value)}
                                placeholder="主人公に関する詳細を記述してください..."
                                style={{ minHeight: '120px' }}
                            />
                        </div>
                    )}

                    {/* 考える */}
                    <div style={sectionStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                            <div>
                                {renderLabelWithInfo('考える', '返信前に内容を考えます。精度向上が期待できますが、トークン消費が増加します。内容は表示されません', {
                                    marginBottom: 0,
                                })}
                            </div>
                            <button
                                type="button"
                                onClick={() => setThinkModeEnabled(!thinkModeEnabled)}
                                style={{
                                    position: 'relative',
                                    width: '44px',
                                    height: '24px',
                                    borderRadius: '12px',
                                    border: 'none',
                                    cursor: 'pointer',
                                    background: thinkModeEnabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                    transition: 'background 0.2s ease',
                                    padding: 0,
                                    flexShrink: 0,
                                }}
                                aria-label="考えるを有効化"
                            >
                                <span style={{
                                    position: 'absolute',
                                    top: '2px',
                                    left: thinkModeEnabled ? '22px' : '2px',
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

                    {/* 会話圧縮トグル */}
                    <div style={sectionStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div>
                                {renderLabelWithInfo('会話圧縮', '長い会話でコンテキストを節約できます。', {
                                    marginBottom: 0,
                                })}
                            </div>
                            <button
                                type="button"
                                onClick={() => setEnableSummary(!enableSummary)}
                                style={{
                                    position: 'relative',
                                    width: '44px',
                                    height: '24px',
                                    borderRadius: '12px',
                                    border: 'none',
                                    cursor: 'pointer',
                                    background: enableSummary ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                    transition: 'background 0.2s ease',
                                    padding: 0,
                                    flexShrink: 0,
                                }}
                                aria-label="会話圧縮を有効化"
                            >
                                <span style={{
                                    position: 'absolute',
                                    top: '2px',
                                    left: enableSummary ? '22px' : '2px',
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

                    {/* 記憶機能トグル */}
                    <div style={sectionStyle}>
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

                    {/* パラメータ (折りたたみ) */}
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
                            パラメータ
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
                                padding: '1rem',
                                borderRadius: '0.5rem',
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--border-color)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '1.25rem',
                            }}>
                                {/* Max Tokens */}
                                <div>
                                    {renderLabelWithInfo('Max Tokens', '生成する最大トークン数です', {
                                        marginBottom: '0.375rem',
                                        labelStyleOverride: { fontSize: '0.8125rem' },
                                    })}
                                    <input
                                        type="number"
                                        className="input"
                                        value={maxTokens}
                                        onChange={(e) => setMaxTokens(e.target.value)}
                                        placeholder={DEFAULT_MAX_TOKENS_PLACEHOLDER}
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
                            </div>
                        )}
                    </div>

                    {/* 記憶 */}
                    {!isNew && character && (
                        <div style={sectionStyle}>
                            <label style={labelStyle}>記憶</label>
                            <button
                                className="btn btn-secondary"
                                onClick={handleOpenMemory}
                                style={{ width: '100%' }}
                            >
                                <Brain size={16} />
                                記憶を表示
                            </button>
                        </div>
                    )}
                </div>

            </div>

            <ImageGenerationModal
                isOpen={imageGenOpen}
                onClose={() => setImageGenOpen(false)}
                onComplete={(avatar, fullBody) => {
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
                            promptDetail: existingDefault?.promptDetail,
                            image: fullBody,
                        });
                        return next;
                    });
                }}
            />

            <CharacterGeneratorModal
                isOpen={characterGeneratorOpen}
                onClose={() => setCharacterGeneratorOpen(false)}
                onApply={(draft) => {
                    setName(draft.name);
                    setSystemPrompt(draft.systemPrompt);
                    setProtagonistPrompt(draft.protagonistPrompt);
                    setCharacterGeneratorOpen(false);
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
