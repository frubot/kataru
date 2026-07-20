import { useState, useEffect, useRef } from 'react';
import { X, Trash2, AlertTriangle, Download, Upload, Sun, Moon, Brain, Braces, Search, Image, Check, ChevronDown, type LucideIcon } from 'lucide-react';
import { useStore, ThemeMode, ThemePalette, VnTypingSpeed, DEFAULT_SUMMARY_MODEL, DEFAULT_CHAT_MODEL, DEFAULT_DIRECTOR_MODEL, DEFAULT_AUTO_GENERATION_MODEL, DEFAULT_TITLE_GENERATION_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_MEMORY_EXTRACTION_MODEL, DEFAULT_MEMORY_EMBEDDING_MODEL, type AiProvider } from '@/lib/store';
import { createFullBackup, downloadJson, parseFullBackup, reassignIds, ParsedBackup } from '@/lib/importExport';
import StatisticsPanel from '@/components/StatisticsPanel';
import packageJson from '../package.json';

interface GlobalSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type SettingsTab = 'general' | 'models' | 'debug' | 'statistics';

const SETTINGS_TABS = [
    { id: 'general', label: '一般' },
    { id: 'models', label: 'モデル' },
    { id: 'debug', label: 'デバッグ' },
    { id: 'statistics', label: '統計' },
] as const satisfies readonly { id: SettingsTab; label: string }[];

const PALETTE_OPTIONS = [
    {
        id: 'classic',
        label: 'クラシック',
        preview: {
            light: { bg: '#f6f7ff', surface: '#ffffff', accent: '#4f46e5' },
            dark: { bg: '#0f1117', surface: '#202435', accent: '#818cf8' },
        },
    },
    {
        id: 'sakura',
        label: 'サクラ',
        preview: {
            light: { bg: '#fff7fa', surface: '#ffeaf1', accent: '#e11d48' },
            dark: { bg: '#140d12', surface: '#2b1824', accent: '#fb7185' },
        },
    },
    {
        id: 'sage',
        label: 'セージ',
        preview: {
            light: { bg: '#f5fbf6', surface: '#eaf6ed', accent: '#15803d' },
            dark: { bg: '#0d120f', surface: '#1b281f', accent: '#86efac' },
        },
    },
    {
        id: 'sky',
        label: 'スカイ',
        preview: {
            light: { bg: '#f3f9ff', surface: '#e5f2ff', accent: '#0369a1' },
            dark: { bg: '#071018', surface: '#122638', accent: '#38bdf8' },
        },
    },
    {
        id: 'amber',
        label: 'アンバー',
        preview: {
            light: { bg: '#fff9ed', surface: '#fff0d3', accent: '#b45309' },
            dark: { bg: '#151006', surface: '#2d2110', accent: '#fbbf24' },
        },
    },
    {
        id: 'mono',
        label: 'モノ',
        preview: {
            light: { bg: '#f7f7f8', surface: '#eeeeef', accent: '#3f3f46' },
            dark: { bg: '#101114', surface: '#22242a', accent: '#a1a1aa' },
        },
    },
] as const satisfies readonly {
    id: ThemePalette;
    label: string;
    preview: Record<ThemeMode, { bg: string; surface: string; accent: string }>;
}[];

const VN_SPEED_OPTIONS = [
    { id: 'slow', label: '遅い' },
    { id: 'default', label: 'デフォルト' },
    { id: 'fast', label: '速い' },
    { id: 'streaming', label: 'ストリーミング' },
] as const satisfies readonly { id: VnTypingSpeed; label: string }[];

const AI_PROVIDER_OPTIONS = [
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'openai-compatible', label: 'OpenAI互換API' },
] as const satisfies readonly { id: AiProvider; label: string }[];

const VN_SPEED_INDEX: Record<VnTypingSpeed, number> = {
    slow: 0,
    default: 1,
    fast: 2,
    streaming: 3,
};

interface VnSpeedSliderProps {
    value: VnTypingSpeed;
    onChange: (speed: VnTypingSpeed) => void;
}

function VnSpeedSlider({ value, onChange }: VnSpeedSliderProps) {
    const index = VN_SPEED_INDEX[value];
    const percent = (index / (VN_SPEED_OPTIONS.length - 1)) * 100;
    const currentOption = VN_SPEED_OPTIONS[index];
    const [isMenuOpen, setMenuOpen] = useState(false);
    const speedMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isMenuOpen) return;

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && !speedMenuRef.current?.contains(target)) {
                setMenuOpen(false);
            }
        };

        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [isMenuOpen]);

    return (
        <div style={{ position: 'relative' }} ref={speedMenuRef}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                    文字送り速度
                </label>
                <button
                    type="button"
                    className="settings-select-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={isMenuOpen}
                    onClick={() => setMenuOpen((open) => !open)}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.5rem',
                        minWidth: '7rem',
                        minHeight: '2.25rem',
                        padding: '0.5rem 0.625rem',
                        borderRadius: '0.5rem',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        fontSize: '0.8125rem',
                        fontWeight: 600,
                        transition: 'background 0.15s ease, border-color 0.15s ease',
                    }}
                >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                        {currentOption.label}
                    </span>
                    <ChevronDown
                        size={15}
                        aria-hidden="true"
                        style={{
                            flexShrink: 0,
                            color: 'var(--text-muted)',
                            transform: isMenuOpen ? 'rotate(180deg)' : undefined,
                            transition: 'transform 0.15s ease',
                        }}
                    />
                </button>
            </div>

            {isMenuOpen && (
                <div
                    role="dialog"
                    aria-label="文字送り速度"
                    style={{
                        position: 'absolute',
                        right: 0,
                        top: 'calc(100% + 0.5rem)',
                        width: 'min(100%, 20rem)',
                        minWidth: '16rem',
                        padding: '0.75rem 1rem',
                        border: '1px solid var(--border-color)',
                        borderRadius: '0.5rem',
                        background: 'var(--bg-primary)',
                        boxShadow: '0 12px 28px rgba(0, 0, 0, 0.24)',
                        zIndex: 20,
                    }}
                >
                    <div style={{ position: 'relative', height: '24px', display: 'flex', alignItems: 'center' }}>
                        <div style={{
                            position: 'absolute',
                            width: '100%',
                            height: '4px',
                            borderRadius: '2px',
                            background: 'var(--bg-tertiary)',
                            overflow: 'hidden',
                        }}>
                            <div style={{
                                width: `${percent}%`,
                                height: '100%',
                                background: 'var(--accent-primary)',
                                borderRadius: '2px',
                                transition: 'width 0.15s ease',
                            }} />
                        </div>
                        <input
                            type="range"
                            aria-label="文字送り速度"
                            min={0}
                            max={VN_SPEED_OPTIONS.length - 1}
                            step={1}
                            value={index}
                            onChange={(e) => {
                                const option = VN_SPEED_OPTIONS[Number(e.target.value)] ?? VN_SPEED_OPTIONS[1];
                                onChange(option.id);
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
                        <div style={{
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
                        }} />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                        {VN_SPEED_OPTIONS.map((option) => (
                            <span
                                key={option.id}
                                style={{
                                    fontSize: '0.7rem',
                                    color: value === option.id ? 'var(--accent-primary)' : 'var(--text-muted)',
                                    fontWeight: value === option.id ? 600 : 400,
                                }}
                            >
                                {option.label}
                            </span>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default function GlobalSettingsModal({ isOpen, onClose }: GlobalSettingsModalProps) {
    const {
        themeMode, themePalette, vnTypingSpeed,
        summaryModel, setSummaryModel,
        defaultChatModel, setDefaultChatModel,
        defaultDirectorModel, setDefaultDirectorModel,
        defaultAutoGenerationModel, setDefaultAutoGenerationModel,
        titleGenerationModel, setTitleGenerationModel,
        defaultImageModel, setDefaultImageModel,
        memoryExtractionModel, setMemoryExtractionModel,
        memoryEmbeddingModel, setMemoryEmbeddingModel,
        generateTitleOnFirstReply, setGenerateTitleOnFirstReply,
        aiProvider, setAiProvider,
        openAiCompatibleEmbeddingsEnabled, setOpenAiCompatibleEmbeddingsEnabled,
        openAiCompatibleImageGenerationEnabled, setOpenAiCompatibleImageGenerationEnabled,
        thinkDebugEnabled, thinkDebugLogs, fullJsonDebugEnabled, fullJsonDebugLogs,
        setThemeMode, setThemePalette, setVnTypingSpeed,
        setThinkDebugEnabled, setFullJsonDebugEnabled, clearThinkDebugLogs, clearFullJsonDebugLogs,
        clearAllHistory, mergeBackup, restoreBackup,
    } = useStore();
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [importData, setImportData] = useState<ParsedBackup | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);
    const [isClearingHistory, setIsClearingHistory] = useState(false);
    const [activeTab, setActiveTab] = useState<SettingsTab>('general');
    const [isPaletteMenuOpen, setPaletteMenuOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const paletteMenuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    useEffect(() => {
        if (!isOpen) setPaletteMenuOpen(false);
    }, [isOpen]);

    useEffect(() => {
        if (!isPaletteMenuOpen) return;

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && !paletteMenuRef.current?.contains(target)) {
                setPaletteMenuOpen(false);
            }
        };

        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [isPaletteMenuOpen]);

    if (!isOpen) return null;

    const handleClearHistory = async () => {
        if (isClearingHistory) return;
        setHistoryError(null);
        setIsClearingHistory(true);
        try {
            await clearAllHistory();
            setShowClearConfirm(false);
        } catch (err) {
            setHistoryError(err instanceof Error ? err.message : '会話履歴の削除に失敗しました');
        } finally {
            setIsClearingHistory(false);
        }
    };

    const handleExport = async () => {
        const json = await createFullBackup();
        const date = new Date().toISOString().slice(0, 10);
        downloadJson(json, `roleplay-backup-${date}.json`);
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (isImporting) return;
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = parseFullBackup(ev.target?.result as string);
                setImportData(parsed);
                setImportError(null);
                setShowRestoreConfirm(false);
            } catch (err) {
                setImportData(null);
                setImportError(err instanceof Error ? err.message : 'インポートに失敗しました');
                setShowRestoreConfirm(false);
            }
        };
        reader.readAsText(file);
    };

    const handleMerge = async () => {
        if (!importData) return;
        setImportError(null);
        setIsImporting(true);
        try {
            await mergeBackup(reassignIds(importData));
            setImportData(null);
        } catch (err) {
            setImportError(err instanceof Error ? err.message : 'インポートに失敗しました');
        } finally {
            setIsImporting(false);
        }
    };

    const handleRestore = async () => {
        if (!importData) return;
        setImportError(null);
        setIsImporting(true);
        try {
            await restoreBackup(importData);
            setImportData(null);
            setShowRestoreConfirm(false);
        } catch (err) {
            setImportError(err instanceof Error ? err.message : 'インポートに失敗しました');
        } finally {
            setIsImporting(false);
        }
    };

    const handleSummaryModelBlur = () => {
        const normalized = summaryModel.trim();
        setSummaryModel(normalized || DEFAULT_SUMMARY_MODEL);
    };

    const handleDefaultChatModelBlur = () => {
        const normalized = defaultChatModel.trim();
        setDefaultChatModel(normalized || DEFAULT_CHAT_MODEL);
    };

    const handleDefaultDirectorModelBlur = () => {
        const normalized = defaultDirectorModel.trim();
        setDefaultDirectorModel(normalized || DEFAULT_DIRECTOR_MODEL);
    };

    const handleDefaultAutoGenerationModelBlur = () => {
        const normalized = defaultAutoGenerationModel.trim();
        setDefaultAutoGenerationModel(normalized || DEFAULT_AUTO_GENERATION_MODEL);
    };

    const handleTitleGenerationModelBlur = () => {
        const normalized = titleGenerationModel.trim();
        setTitleGenerationModel(normalized || DEFAULT_TITLE_GENERATION_MODEL);
    };

    const handleDefaultImageModelBlur = () => {
        const normalized = defaultImageModel.trim();
        setDefaultImageModel(normalized || DEFAULT_IMAGE_MODEL);
    };

    const handleMemoryExtractionModelBlur = () => {
        const normalized = memoryExtractionModel.trim();
        setMemoryExtractionModel(normalized || DEFAULT_MEMORY_EXTRACTION_MODEL);
    };

    const handleMemoryEmbeddingModelBlur = () => {
        const normalized = memoryEmbeddingModel.trim();
        setMemoryEmbeddingModel(normalized || DEFAULT_MEMORY_EMBEDDING_MODEL);
    };

    const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
        let nextIndex: number | null = null;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            nextIndex = (tabIndex + 1) % SETTINGS_TABS.length;
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            nextIndex = (tabIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
        } else if (event.key === 'Home') {
            nextIndex = 0;
        } else if (event.key === 'End') {
            nextIndex = SETTINGS_TABS.length - 1;
        }

        if (nextIndex === null) return;
        event.preventDefault();
        const nextTab = SETTINGS_TABS[nextIndex];
        setActiveTab(nextTab.id);
        document.getElementById(`settings-tab-${nextTab.id}`)?.focus();
    };

    const debugLogCount = thinkDebugLogs.length + fullJsonDebugLogs.length;
    const selectedPalette = PALETTE_OPTIONS.find(({ id }) => id === themePalette) ?? PALETTE_OPTIONS[0];
    const renderPaletteDots = (colors: { bg: string; surface: string; accent: string }) => (
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
            {[colors.bg, colors.surface, colors.accent].map((color, index) => (
                <span
                    key={`${color}-${index}`}
                    aria-hidden="true"
                    style={{
                        width: '0.625rem',
                        height: '0.625rem',
                        borderRadius: '50%',
                        background: color,
                        border: '1px solid rgba(128,128,128,0.35)',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
                    }}
                />
            ))}
        </span>
    );

    const handleClearDebugLogs = () => {
        clearThinkDebugLogs();
        clearFullJsonDebugLogs();
    };
    const renderDebugToggle = ({
        Icon,
        label,
        enabled,
        onToggle,
        ariaLabel,
    }: {
        Icon: LucideIcon;
        label: string;
        enabled: boolean;
        onToggle: () => void;
        ariaLabel: string;
    }) => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
            <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                    <Icon size={15} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                        {label}
                    </span>
                </div>
            </div>
            <button
                type="button"
                onClick={onToggle}
                style={{
                    position: 'relative',
                    width: '44px',
                    height: '24px',
                    borderRadius: '12px',
                    border: 'none',
                    cursor: 'pointer',
                    background: enabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                    transition: 'background 0.2s ease',
                    padding: 0,
                    flexShrink: 0,
                }}
                aria-label={ariaLabel}
            >
                <span style={{
                    position: 'absolute',
                    top: '2px',
                    left: enabled ? '22px' : '2px',
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 0.2s ease',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
            </button>
        </div>
    );

    return (
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="modal-content settings-modal" onClick={(e) => e.stopPropagation()}>
                <button className="btn btn-ghost settings-modal-close" onClick={onClose} aria-label="設定を閉じる">
                    <X size={20} />
                </button>

                <div className="settings-layout">
                    <nav className="settings-tabs" role="tablist" aria-label="設定カテゴリー">
                        {SETTINGS_TABS.map(({ id, label }, index) => {
                            const selected = activeTab === id;
                            return (
                                <button
                                    id={`settings-tab-${id}`}
                                    key={id}
                                    type="button"
                                    role="tab"
                                    aria-selected={selected}
                                    aria-controls="settings-tab-panel"
                                    tabIndex={selected ? 0 : -1}
                                    className={`settings-tab ${selected ? 'active' : ''}`}
                                    onClick={() => setActiveTab(id)}
                                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                                >
                                    <span>{label}</span>
                                </button>
                            );
                        })}
                    </nav>

                    <div
                        id="settings-tab-panel"
                        className="settings-tab-content"
                        role="tabpanel"
                        aria-labelledby={`settings-tab-${activeTab}`}
                    >
                        <div key={activeTab} className="animate-fade-in">

                        {activeTab === 'general' && (
                            <>
                        {/* Application Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                                アプリケーション
                            </h3>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                        バージョン
                                    </span>
                                    <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                        v{packageJson.version}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Appearance Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '1rem',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                        外観
                                    </span>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={themeMode === 'dark'}
                                        aria-label={`外観: ${themeMode === 'dark' ? 'ダーク' : 'ライト'}`}
                                        title={themeMode === 'dark' ? 'ダーク' : 'ライト'}
                                        onClick={() => setThemeMode(themeMode === 'light' ? 'dark' : 'light')}
                                        style={{
                                            position: 'relative',
                                            width: '80px',
                                            height: '32px',
                                            borderRadius: '16px',
                                            border: '1px solid var(--border-color)',
                                            background: 'var(--bg-tertiary)',
                                            color: 'var(--text-muted)',
                                            cursor: 'pointer',
                                            padding: '1px',
                                            display: 'grid',
                                            gridTemplateColumns: '1fr 1fr',
                                            alignItems: 'center',
                                            justifyItems: 'center',
                                            flexShrink: 0,
                                            transition: 'border-color 0.15s ease, background 0.15s ease',
                                        }}
                                    >
                                        <span
                                            aria-hidden="true"
                                            style={{
                                                position: 'absolute',
                                                top: '50%',
                                                left: themeMode === 'dark' ? '75%' : '25%',
                                                width: '34px',
                                                height: '28px',
                                                borderRadius: '999px',
                                                background: 'var(--bg-secondary)',
                                                boxShadow: '0 1px 4px rgba(0, 0, 0, 0.18)',
                                                transform: 'translate(-50%, -50%)',
                                                transition: 'left 0.18s ease',
                                                zIndex: 0,
                                            }}
                                        />
                                        <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, color: themeMode === 'light' ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                            <Sun size={15} aria-hidden="true" />
                                        </span>
                                        <span style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0, color: themeMode === 'dark' ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                            <Moon size={15} aria-hidden="true" />
                                        </span>
                                    </button>
                                </div>

                                <div style={{ position: 'relative' }} ref={paletteMenuRef}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                                        <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                            色
                                        </span>
                                        <button
                                            type="button"
                                            className="settings-select-trigger"
                                            aria-haspopup="menu"
                                            aria-expanded={isPaletteMenuOpen}
                                            onClick={() => setPaletteMenuOpen((open) => !open)}
                                            style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.5rem',
                                                minWidth: '7rem',
                                                minHeight: '2.25rem',
                                                padding: '0.5rem 0.625rem',
                                                borderRadius: '0.5rem',
                                                color: 'var(--text-primary)',
                                                cursor: 'pointer',
                                                fontSize: '0.8125rem',
                                                fontWeight: 600,
                                                transition: 'background 0.15s ease, border-color 0.15s ease',
                                            }}
                                        >
                                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                                                {selectedPalette.label}
                                            </span>
                                            <ChevronDown
                                                size={15}
                                                aria-hidden="true"
                                                style={{
                                                    flexShrink: 0,
                                                    color: 'var(--text-muted)',
                                                    transform: isPaletteMenuOpen ? 'rotate(180deg)' : undefined,
                                                    transition: 'transform 0.15s ease',
                                                }}
                                            />
                                        </button>
                                    </div>
                                    {isPaletteMenuOpen && (
                                        <div
                                            role="menu"
                                            aria-label="色"
                                            style={{
                                                position: 'absolute',
                                                right: 0,
                                                top: 'calc(100% + 0.5rem)',
                                                width: 'min(100%, 16rem)',
                                                minWidth: '12rem',
                                                padding: '0.375rem',
                                                border: '1px solid var(--border-color)',
                                                borderRadius: '0.5rem',
                                                background: 'var(--bg-primary)',
                                                boxShadow: '0 12px 28px rgba(0, 0, 0, 0.24)',
                                                zIndex: 20,
                                            }}
                                        >
                                            {PALETTE_OPTIONS.map(({ id, label, preview }) => {
                                                const selected = themePalette === id;
                                                const colors = preview[themeMode];
                                                return (
                                                    <button
                                                        key={id}
                                                        type="button"
                                                        className="settings-select-option"
                                                        role="menuitemradio"
                                                        aria-checked={selected}
                                                        onClick={() => {
                                                            setThemePalette(id);
                                                            setPaletteMenuOpen(false);
                                                        }}
                                                        style={{
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: '0.625rem',
                                                            width: '100%',
                                                            minHeight: '2.5rem',
                                                            padding: '0.5rem 0.625rem',
                                                            border: 'none',
                                                            borderRadius: '0.375rem',
                                                            color: selected ? 'var(--accent-primary)' : 'var(--text-primary)',
                                                            cursor: 'pointer',
                                                            textAlign: 'left',
                                                        }}
                                                    >
                                                        {renderPaletteDots(colors)}
                                                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.875rem', fontWeight: selected ? 600 : 500 }}>
                                                            {label}
                                                        </span>
                                                        {selected && <Check size={15} aria-hidden="true" style={{ flexShrink: 0 }} />}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                <VnSpeedSlider value={vnTypingSpeed} onChange={setVnTypingSpeed} />
                            </div>
                        </div>

                            </>
                        )}

                        {activeTab === 'models' && (
                            <>
                        {/* API Provider Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                                API 接続先
                            </h3>
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '1rem',
                            }}>
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(2, 1fr)',
                                    gap: '0.25rem',
                                    padding: '0.25rem',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: '1.6rem',
                                    background: 'var(--bg-tertiary)',
                                }}>
                                    {AI_PROVIDER_OPTIONS.map((option) => {
                                        const selected = aiProvider === option.id;
                                        return (
                                            <button
                                                key={option.id}
                                                type="button"
                                                aria-pressed={selected}
                                                onClick={() => setAiProvider(option.id)}
                                                style={{
                                                    minHeight: '2.25rem',
                                                    border: 'none',
                                                    borderRadius: '1.5rem',
                                                    background: selected ? 'var(--bg-secondary)' : 'transparent',
                                                    color: selected ? 'var(--accent-primary)' : 'var(--text-secondary)',
                                                    boxShadow: selected ? '0 1px 4px rgba(0, 0, 0, 0.12)' : 'none',
                                                    cursor: 'pointer',
                                                    fontSize: '0.8125rem',
                                                    fontWeight: selected ? 600 : 500,
                                                    transition: 'all 0.15s ease',
                                                }}
                                            >
                                                {option.label}
                                            </button>
                                        );
                                    })}
                                </div>

                                {aiProvider === 'openai-compatible' && (
                                    <>

                                        {renderDebugToggle({
                                            Icon: Search,
                                            label: 'embeddings モデルを使う',
                                            enabled: openAiCompatibleEmbeddingsEnabled,
                                            onToggle: () => setOpenAiCompatibleEmbeddingsEnabled(!openAiCompatibleEmbeddingsEnabled),
                                            ariaLabel: 'OpenAI互換APIのembeddings利用を切り替え',
                                        })}
                                        {renderDebugToggle({
                                            Icon: Image,
                                            label: '画像生成モデルを使う',
                                            enabled: openAiCompatibleImageGenerationEnabled,
                                            onToggle: () => setOpenAiCompatibleImageGenerationEnabled(!openAiCompatibleImageGenerationEnabled),
                                            ariaLabel: 'OpenAI互換APIの画像生成利用を切り替え',
                                        })}
                                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                                            エンドポイントは環境変数 <code style={{ fontSize: '0.7rem' }}>OPENAI_COMPAT_BASE_URL</code> で設定してください。
                                            APIキーを使用する必要がある場合、環境変数 <code style={{ fontSize: '0.7rem' }}>OPENAI_COMPAT_API_KEY</code> で設定してください。
                                        </p>
                                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                                            互換APIでは一部の機能が制限されます。OpenRouterで全ての機能をご利用いただけます。
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Conversation Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                                既定のモデル
                            </h3>
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '1rem',
                            }}>

                                {/* Default chat model */}
                                <div>
                                    <label
                                        htmlFor="default-chat-model-input"
                                        style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}
                                    >
                                        会話
                                    </label>
                                    <input
                                        id="default-chat-model-input"
                                        type="text"
                                        className="input"
                                        value={defaultChatModel}
                                        onChange={(e) => setDefaultChatModel(e.target.value)}
                                        onBlur={handleDefaultChatModelBlur}
                                        placeholder={`例: ${DEFAULT_CHAT_MODEL}`}
                                    />
                                </div>

                                {/* Default director model */}
                                <div>
                                    <label
                                        htmlFor="default-director-model-input"
                                        style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}
                                    >
                                        シチュエーション管理
                                    </label>
                                    <input
                                        id="default-director-model-input"
                                        type="text"
                                        className="input"
                                        value={defaultDirectorModel}
                                        onChange={(e) => setDefaultDirectorModel(e.target.value)}
                                        onBlur={handleDefaultDirectorModelBlur}
                                        placeholder={`例: ${DEFAULT_DIRECTOR_MODEL}`}
                                    />
                                </div>

                                {/* Default auto generation model */}
                                <div>
                                    <label
                                        htmlFor="default-auto-generation-model-input"
                                        style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}
                                    >
                                        設定の自動生成
                                    </label>
                                    <input
                                        id="default-auto-generation-model-input"
                                        type="text"
                                        className="input"
                                        value={defaultAutoGenerationModel}
                                        onChange={(e) => setDefaultAutoGenerationModel(e.target.value)}
                                        onBlur={handleDefaultAutoGenerationModelBlur}
                                        placeholder={`例: ${DEFAULT_AUTO_GENERATION_MODEL}`}
                                    />
                                </div>

                                {/* Title generation model */}
                                <div>
                                    <label
                                        htmlFor="title-generation-model-input"
                                        style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}
                                    >
                                        タイトル生成
                                    </label>
                                    <input
                                        id="title-generation-model-input"
                                        type="text"
                                        className="input"
                                        value={titleGenerationModel}
                                        onChange={(e) => setTitleGenerationModel(e.target.value)}
                                        onBlur={handleTitleGenerationModelBlur}
                                        placeholder={`例: ${DEFAULT_TITLE_GENERATION_MODEL}`}
                                    />
                                </div>

                                {/* Summary model */}
                                <div>
                                    <label
                                        htmlFor="summary-model-input"
                                        style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}
                                    >
                                        コンテキスト圧縮
                                    </label>
                                    <input
                                        id="summary-model-input"
                                        type="text"
                                        className="input"
                                        value={summaryModel}
                                        onChange={(e) => setSummaryModel(e.target.value)}
                                        onBlur={handleSummaryModelBlur}
                                        placeholder={`例: ${DEFAULT_SUMMARY_MODEL}`}
                                    />
                                </div>

                                {/* Default image model */}
                                <div>
                                    <label
                                        htmlFor="default-image-model-input"
                                        style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}
                                    >
                                        画像生成
                                    </label>
                                    <input
                                        id="default-image-model-input"
                                        type="text"
                                        className="input"
                                        value={defaultImageModel}
                                        onChange={(e) => setDefaultImageModel(e.target.value)}
                                        onBlur={handleDefaultImageModelBlur}
                                        placeholder={`例: ${DEFAULT_IMAGE_MODEL}`}
                                    />
                                </div>

                                {/* Memory extraction model */}
                                <div>
                                    <label
                                        htmlFor="memory-extraction-model-input"
                                        style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}
                                    >
                                        メモリ保存
                                    </label>
                                    <input
                                        id="memory-extraction-model-input"
                                        type="text"
                                        className="input"
                                        value={memoryExtractionModel}
                                        onChange={(e) => setMemoryExtractionModel(e.target.value)}
                                        onBlur={handleMemoryExtractionModelBlur}
                                        placeholder={`例: ${DEFAULT_MEMORY_EXTRACTION_MODEL}`}
                                    />
                                </div>

                                {/* Memory embedding model */}
                                <div>
                                    <label
                                        htmlFor="memory-embedding-model-input"
                                        style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem' }}
                                    >
                                        メモリ検索
                                    </label>
                                    <input
                                        id="memory-embedding-model-input"
                                        type="text"
                                        className="input"
                                        value={memoryEmbeddingModel}
                                        onChange={(e) => setMemoryEmbeddingModel(e.target.value)}
                                        onBlur={handleMemoryEmbeddingModelBlur}
                                        placeholder={`例: ${DEFAULT_MEMORY_EMBEDDING_MODEL}`}
                                    />
                                </div>
                            </div>
                        </div>

                            </>
                        )}

                        {activeTab === 'debug' && (
                        /* Debug Section */
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                                デバッグ
                            </h3>
                            <div>
                                {renderDebugToggle({
                                    Icon: Brain,
                                    label: '考えを表示',
                                    enabled: thinkDebugEnabled,
                                    onToggle: () => setThinkDebugEnabled(!thinkDebugEnabled),
                                    ariaLabel: '考えの表示を有効化',
                                })}
                                <div style={{ height: 1, margin: '0.875rem 0' }} />
                                {renderDebugToggle({
                                    Icon: Braces,
                                    label: '完全なJSONを表示',
                                    enabled: fullJsonDebugEnabled,
                                    onToggle: () => setFullJsonDebugEnabled(!fullJsonDebugEnabled),
                                    ariaLabel: '完全なJSON表示を有効化',
                                })}
                                <button
                                    className="btn btn-secondary"
                                    onClick={handleClearDebugLogs}
                                    disabled={debugLogCount === 0}
                                    style={{ marginTop: '1.50rem' }}
                                >
                                    <Trash2 size={16} />
                                    ログを消去
                                </button>
                            </div>
                        </div>
                        )}

                        {activeTab === 'statistics' && <StatisticsPanel />}

                        {activeTab === 'general' && (
                            <>
                        {/* Title Generation Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                                機能
                            </h3>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                        タイトルの自動生成
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setGenerateTitleOnFirstReply(!generateTitleOnFirstReply)}
                                        style={{
                                            position: 'relative',
                                            width: '44px',
                                            height: '24px',
                                            borderRadius: '12px',
                                            border: 'none',
                                            cursor: 'pointer',
                                            background: generateTitleOnFirstReply ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                            transition: 'background 0.2s ease',
                                            padding: 0,
                                            flexShrink: 0,
                                        }}
                                        aria-label="最初の回答後にタイトルを生成"
                                    >
                                        <span style={{
                                            position: 'absolute',
                                            top: '2px',
                                            left: generateTitleOnFirstReply ? '22px' : '2px',
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
                        </div>

                        {/* Backup Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                                データ管理
                            </h3>
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <button className="btn btn-secondary" onClick={handleExport}>
                                    <Download size={16} />
                                    エクスポート
                                </button>
                                <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} disabled={isImporting}>
                                    <Upload size={16} />
                                    インポート
                                </button>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".json"
                                    disabled={isImporting}
                                    style={{ display: 'none' }}
                                    onChange={handleFileSelect}
                                />
                            </div>

                            {importError && (
                                <div style={{
                                    marginTop: '0.75rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.375rem',
                                    fontSize: '0.75rem',
                                    color: 'var(--error)',
                                    padding: '0.5rem 0.75rem',
                                    background: 'rgba(239, 68, 68, 0.1)',
                                    borderRadius: '0.5rem',
                                    border: '1px solid rgba(239, 68, 68, 0.3)',
                                }}>
                                    <AlertTriangle size={14} />
                                    {importError}
                                </div>
                            )}

                            {importData && (
                                <div className="card" aria-busy={isImporting} style={{ marginTop: '0.75rem', background: 'rgba(59, 130, 246, 0.1)', borderColor: 'rgba(59, 130, 246, 0.4)' }}>
                                    <p style={{ fontSize: '0.875rem', marginBottom: '0.5rem', fontWeight: 500 }}>
                                        インポート内容
                                    </p>
                                    <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                        キャラクター {importData.characters.length} 件 / ルーム {importData.rooms.length} 件 / 使用記録 {importData.usageRecords.length} 件
                                    </p>
                                    {isImporting && (
                                        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                            インポート中です。完了までこの画面を閉じずにお待ちください。
                                        </p>
                                    )}
                                    {showRestoreConfirm ? (
                                        <div>
                                            <p style={{ fontSize: '0.8rem', color: '#f59e0b', marginBottom: '0.5rem' }}>
                                                現在のデータはすべて置き換えられます。本当によろしいですか？
                                            </p>
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                <button className="btn btn-danger" onClick={handleRestore} disabled={isImporting}>
                                                    {isImporting ? '置き換え中...' : '置き換える'}
                                                </button>
                                                <button className="btn btn-secondary" onClick={() => setShowRestoreConfirm(false)} disabled={isImporting}>
                                                    戻る
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                            <button className="btn btn-primary" onClick={handleMerge} disabled={isImporting}>
                                                {isImporting ? 'マージ中...' : 'マージ（追加）'}
                                            </button>
                                            <button className="btn btn-danger" onClick={() => setShowRestoreConfirm(true)} disabled={isImporting}>
                                                置き換え
                                            </button>
                                            <button className="btn btn-secondary" onClick={() => setImportData(null)} disabled={isImporting}>
                                                キャンセル
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Data Management Section */}
                        <div>
                            {historyError && (
                                <div style={{
                                    marginBottom: '0.75rem',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.375rem',
                                    fontSize: '0.75rem',
                                    color: 'var(--error)',
                                    padding: '0.5rem 0.75rem',
                                    background: 'rgba(239, 68, 68, 0.1)',
                                    borderRadius: '0.5rem',
                                    border: '1px solid rgba(239, 68, 68, 0.3)',
                                }}>
                                    <AlertTriangle size={14} />
                                    {historyError}
                                </div>
                            )}
                            {showClearConfirm ? (
                                <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'var(--error)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                        <AlertTriangle size={20} style={{ color: 'var(--error)' }} />
                                        <span style={{ fontWeight: 500 }}>本当に削除しますか？</span>
                                    </div>
                                    <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                        全てのチャットルームのメッセージ履歴が削除されます。この操作は元に戻せません。
                                    </p>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        <button className="btn btn-danger" onClick={handleClearHistory} disabled={isClearingHistory}>
                                            {isClearingHistory ? '削除中...' : '削除する'}
                                        </button>
                                        <button className="btn btn-secondary" onClick={() => setShowClearConfirm(false)} disabled={isClearingHistory}>
                                            キャンセル
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button className="btn btn-danger" onClick={() => setShowClearConfirm(true)} disabled={isClearingHistory}>
                                    <Trash2 size={16} />
                                    全ての会話履歴を削除
                                </button>
                            )}
                        </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
            </div>
        </div>
    );
}
