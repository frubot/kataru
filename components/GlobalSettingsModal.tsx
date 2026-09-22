import { useState, useEffect, useRef, type ReactNode } from 'react';
import { X, Trash2, AlertTriangle, Download, Upload, Sun, Moon, Check, ChevronDown, RefreshCw, ExternalLink, Plus, type LucideIcon } from 'lucide-react';
import { useStore, ThemeMode, ThemePalette, VnTypingSpeed, RoomViewMode, VOICEVOX_TTS_MODEL, getDefaultModelDefaults, TTS_CHUNK_MIN_CHARS_MAX, TTS_CHUNK_MIN_CHARS_MIN, TTS_FIRST_CHUNK_MIN_CHARS_MAX, TTS_FIRST_CHUNK_MIN_CHARS_MIN } from '@/lib/store';
import { AI_CONNECTION_KIND_LABELS, isAiConnectionKind, type AiConnectionKind } from '@/lib/aiApi';
import { useAiConnections, type AiConnectionStatus } from '@/lib/aiConnections';
import { MODEL_DEFAULT_FIELDS, modelRefsEqual, type ModelRef, type ModelRoleKey } from '@/lib/modelDefaults';
import type { ModelOutputModality } from '@/lib/availableModels';
import { createFullBackup, downloadJson, parseImportFile, reassignIds, type ParsedImport } from '@/lib/importExport';
import { resizeToMaxEdgeAsJpeg } from '@/lib/imageUtils';
import { isIrodoriTtsModel } from '@/lib/tts';
import StatisticsPanel from '@/components/StatisticsPanel';
import AiConnectionSettings from '@/components/AiConnectionSettings';
import ModelSelector from '@/components/ModelSelector';
import OptionSelector from '@/components/OptionSelector';
import TtsVoiceField from '@/components/TtsVoiceField';
import TtsSpeedSlider, { formatTtsSpeed } from '@/components/TtsSpeedSlider';
import TtsVolumeSlider, { formatTtsVolume } from '@/components/TtsVolumeSlider';
import TtsCaptionCfgScaleSlider, { formatTtsCaptionCfgScale } from '@/components/TtsCaptionCfgScaleSlider';
import TtsChunkMinCharsSlider from '@/components/TtsChunkMinCharsSlider';
import TtsPreviewButton from '@/components/TtsPreviewButton';
import KeyboardSettingsPanel from '@/components/KeyboardSettingsPanel';
import SituationBackgroundModal from '@/components/SituationBackgroundModal';
import StoredImage from '@/components/StoredImage';
import { useModalKeyboard } from '@/components/useModalKeyboard';

interface GlobalSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onShowOnboarding: () => void;
}

interface UpdateStatus {
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
    releaseUrl: string;
    installing: boolean;
}

interface HealthStatus {
    version: string;
}

function isHealthStatus(value: unknown): value is HealthStatus {
    return Boolean(
        value
        && typeof value === 'object'
        && 'version' in value
        && typeof value.version === 'string',
    );
}

function isUpdateStatus(value: unknown): value is UpdateStatus {
    if (!value || typeof value !== 'object') return false;
    const status = value as Record<string, unknown>;
    return typeof status.currentVersion === 'string'
        && typeof status.latestVersion === 'string'
        && typeof status.updateAvailable === 'boolean'
        && typeof status.releaseUrl === 'string'
        && typeof status.installing === 'boolean';
}

async function waitForUpdatedServer(version: string): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        try {
            const response = await fetch('/api/health', { cache: 'no-store' });
            if (!response.ok) continue;
            const body: unknown = await response.json();
            if (body && typeof body === 'object' && 'version' in body && body.version === version) {
                return;
            }
        } catch {
            // 更新中はサーバーが一時的に停止します。
        }
    }
    throw new Error('更新後のKataruを起動できませんでした。手動でKataruを起動してください。');
}

type SettingsTab = 'general' | 'models' | 'keyboard' | 'debug' | 'statistics';

const SETTINGS_TABS = [
    { id: 'general', label: '一般' },
    { id: 'models', label: 'モデル' },
    { id: 'keyboard', label: 'キーボード' },
    { id: 'debug', label: '開発者' },
    { id: 'statistics', label: '統計' },
] as const satisfies readonly { id: SettingsTab; label: string }[];

const THEME_MODE_OPTIONS = [
    { id: 'light', label: 'ライト', Icon: Sun },
    { id: 'dark', label: 'ダーク', Icon: Moon },
] as const satisfies readonly { id: ThemeMode; label: string; Icon: LucideIcon }[];

const PALETTE_OPTIONS = [
    {
        id: 'indigo',
        label: 'インディゴ',
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

const VIEW_MODE_OPTIONS = [
    { id: 'chat', label: 'ベーシック' },
    { id: 'message', label: 'メッセージ' },
    { id: 'vn', label: 'ゲーム' },
] as const satisfies readonly { id: RoomViewMode; label: string }[];

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
    const optionStep = 100 / VN_SPEED_OPTIONS.length;
    const optionInset = optionStep / 2;
    const optionPosition = (index + 0.5) * optionStep;
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
        <div className="settings-select-anchor" ref={speedMenuRef}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                <label style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
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
                        width: 'fit-content',
                        minHeight: '2.25rem',
                        padding: '0.5rem 0.625rem',
                        borderRadius: '0.5rem',
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        fontSize: '0.875rem',
                        transition: 'background 0.15s ease, border-color 0.15s ease',
                    }}
                >
                    <span style={{ whiteSpace: 'nowrap' }}>
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
                            left: `${optionInset}%`,
                            width: `${100 - optionStep}%`,
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
                                left: `${optionInset}%`,
                                width: `${100 - optionStep}%`,
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
                            left: `calc(${optionPosition}% - 8px)`,
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

                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${VN_SPEED_OPTIONS.length}, minmax(0, 1fr))`, marginTop: '0.25rem' }}>
                        {VN_SPEED_OPTIONS.map((option) => (
                            <span
                                key={option.id}
                                style={{
                                    fontSize: '0.7rem',
                                    lineHeight: '1rem',
                                    whiteSpace: 'nowrap',
                                    textAlign: 'center',
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

interface RoleModelFieldProps {
    role: ModelRoleKey;
    label: string;
    inputId: string;
    value: ModelRef;
    onChange: (model: ModelRef) => void;
    outputModality?: ModelOutputModality | readonly ModelOutputModality[];
    capability?: 'embeddings' | 'imageGeneration';
}

/** 指揮役は通常のLLMとJev（decisions）の両方を取りうる。 */
const DIRECTOR_OUTPUT_MODALITIES: readonly ModelOutputModality[] = ['text', 'decisions'];

function connectionSupportsCapability(
    kind: AiConnectionKind | null,
    connection: AiConnectionStatus | null,
    capability: 'embeddings' | 'imageGeneration' | 'tts',
): boolean {
    return kind === 'openrouter'
        || ((kind === 'voicevox' || kind === 'irodori') && capability === 'tts')
        || (kind === 'openai-compatible'
            && (capability === 'embeddings'
                ? connection?.embeddingsEnabled ?? true
                : capability === 'imageGeneration'
                    ? connection?.imageGenerationEnabled === true
                    : connection?.ttsEnabled === true));
}

/** A role's model selector row for the models settings tab. */
function RoleModelField({
    role,
    label,
    inputId,
    value,
    onChange,
    outputModality = 'text',
    capability,
}: RoleModelFieldProps) {
    const { connections } = useAiConnections();
    const connection = connections.find((candidate) => candidate.id === value.connectionId) ?? null;
    const kind = connection?.kind ?? (isAiConnectionKind(value.connectionId) ? value.connectionId : null);
    const capabilitySupported = !capability
        || connectionSupportsCapability(kind, connection, capability)
        || connections.some((candidate) => connectionSupportsCapability(candidate.kind, candidate, capability));

    return (
        <div className="global-settings-selector-row global-settings-selector-row-divider">
            <label
                htmlFor={inputId}
                style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
            >
                {label}
            </label>
            <div className="global-settings-selector-control global-settings-model-selector-control">
                {capabilitySupported ? (
                    <ModelSelector
                        id={inputId}
                        value={value}
                        onChange={onChange}
                        outputModality={outputModality}
                        placeholder={`例: ${getDefaultModelDefaults()[role].model}`}
                    />
                ) : (
                    <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                        {kind ? AI_CONNECTION_KIND_LABELS[kind] : 'この接続先'} では{capability === 'embeddings' ? '埋め込み' : '画像生成'}を利用できません。
                    </p>
                )}
            </div>
        </div>
    );
}

export default function GlobalSettingsModal({ isOpen, onClose, onShowOnboarding }: GlobalSettingsModalProps) {
    const {
        themeMode, themePalette, chatWallpaper, defaultViewMode, vnTypingSpeed,
        summaryModel, setSummaryModel,
        defaultChatModel, setDefaultChatModel,
        defaultDirectorModel, setDefaultDirectorModel,
        defaultAutoGenerationModel, setDefaultAutoGenerationModel,
        titleGenerationModel, setTitleGenerationModel,
        replySuggestionModel, setReplySuggestionModel,
        defaultImageModel, setDefaultImageModel,
        expressionDetectionModel, setExpressionDetectionModel,
        memoryExtractionModel, setMemoryExtractionModel,
        memoryEmbeddingModel, setMemoryEmbeddingModel,
        ttsEnabled, setTtsEnabled,
        ttsConnectionId, setTtsConnectionId,
        ttsModel, setTtsModel,
        ttsVoice, setTtsVoice,
        ttsSpeed, setTtsSpeed,
        ttsVolume, setTtsVolume,
        ttsAutoPlay, setTtsAutoPlay,
        ttsActionCaption, setTtsActionCaption,
        ttsCaptionCfgScale, setTtsCaptionCfgScale,
        ttsChunkMinChars, setTtsChunkMinChars,
        ttsFirstChunkMinChars, setTtsFirstChunkMinChars,
        ttsNarrationEnabled, setTtsNarrationEnabled,
        ttsNarratorVoice, setTtsNarratorVoice,
        resetModelDefaults,
        conversationCompressionEnabled, setConversationCompressionEnabled,
        generateTitleOnFirstReply, setGenerateTitleOnFirstReply,
        replySuggestionsEnabled, setReplySuggestionsEnabled,
        fullJsonDebugEnabled, detailedErrorLoggingEnabled, fullJsonDebugLogs,
        memoryInspectorEnabled, summaryInspectorEnabled,
        setThemeMode, setThemePalette, setChatWallpaper, setDefaultViewMode, setVnTypingSpeed,
        setFullJsonDebugEnabled, setDetailedErrorLoggingEnabled, clearFullJsonDebugLogs,
        setMemoryInspectorEnabled, setSummaryInspectorEnabled,
        clearAllHistory, resetApplication, mergeBackup, restoreBackup,
    } = useStore();
    const { connections } = useAiConnections();
    const ttsConnection = connections.find((connection) => connection.id === ttsConnectionId) ?? null;
    const ttsConnectionKind = ttsConnection?.kind
        ?? (isAiConnectionKind(ttsConnectionId) ? ttsConnectionId : null)
        // 接続先が未設定・未解決でも、選んだモデル名からIrodoriを推測する。
        ?? (isIrodoriTtsModel(ttsModel) ? 'irodori' : null);
    const effectiveTtsModel = ttsConnectionKind === 'voicevox' ? VOICEVOX_TTS_MODEL : ttsModel;
    const ttsCapableConnections = connections.filter((connection) => (
        connectionSupportsCapability(connection.kind, connection, 'tts')
    ));
    const modelDefaultsAreUnchanged = MODEL_DEFAULT_FIELDS.every((role) => {
        const current = {
            summaryModel,
            defaultChatModel,
            defaultDirectorModel,
            defaultAutoGenerationModel,
            titleGenerationModel,
            replySuggestionModel,
            defaultImageModel,
            expressionDetectionModel,
            memoryExtractionModel,
            memoryEmbeddingModel,
        }[role];
        return modelRefsEqual(current, getDefaultModelDefaults()[role]);
    });
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [showResetConfirm, setShowResetConfirm] = useState(false);
    const [importData, setImportData] = useState<ParsedImport | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
    const [dataError, setDataError] = useState<string | null>(null);
    const [isClearingHistory, setIsClearingHistory] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [applicationVersion, setApplicationVersion] = useState<string | null>(null);
    const [versionError, setVersionError] = useState<string | null>(null);
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
    const [updateError, setUpdateError] = useState<string | null>(null);
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [activeTab, setActiveTab] = useState<SettingsTab>('general');
    const [isAiConnectionAddOpen, setAiConnectionAddOpen] = useState(false);
    const [isWallpaperEditorOpen, setWallpaperEditorOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const handleKeyboardClose = () => {
        if (showClearConfirm) {
            setShowClearConfirm(false);
            return;
        }
        if (showResetConfirm) {
            setShowResetConfirm(false);
            return;
        }
        if (showRestoreConfirm) {
            setShowRestoreConfirm(false);
            return;
        }
        onClose();
    };

    useModalKeyboard({
        isOpen,
        containerRef: modalRef,
        onClose: handleKeyboardClose,
        canClose: !isImporting
            && !isClearingHistory
            && !isResetting
            && !isWallpaperEditorOpen,
    });

    useEffect(() => {
        if (!isOpen) return;

        const controller = new AbortController();
        const loadApplicationVersion = async () => {
            setVersionError(null);
            try {
                const response = await fetch('/api/health', {
                    cache: 'no-store',
                    signal: controller.signal,
                });
                const body: unknown = await response.json();
                if (!response.ok || !isHealthStatus(body)) {
                    throw new Error('バージョン情報の応答形式が不正です。');
                }
                setApplicationVersion(body.version);
            } catch (error) {
                if (controller.signal.aborted) return;
                setApplicationVersion(null);
                setVersionError(error instanceof Error
                    ? error.message
                    : 'バージョン情報を取得できませんでした。');
            }
        };

        void loadApplicationVersion();
        return () => controller.abort();
    }, [isOpen]);

    if (!isOpen) return null;

    const handleCheckForUpdates = async () => {
        if (isCheckingUpdate) return;
        setUpdateError(null);
        setIsCheckingUpdate(true);
        try {
            const response = await fetch('/api/update', { method: 'POST' });
            const body: unknown = await response.json();
            if (!response.ok) {
                const message = body && typeof body === 'object' && 'error' in body
                    && typeof body.error === 'string'
                    ? body.error
                    : 'アップデートを確認できませんでした。';
                throw new Error(message);
            }
            if (!isUpdateStatus(body)) {
                throw new Error('アップデート確認の応答形式が不正です。');
            }
            setUpdateStatus(body);
            if (body.installing) {
                await waitForUpdatedServer(body.latestVersion);
                window.location.reload();
            }
        } catch (error) {
            setUpdateStatus(null);
            setUpdateError(error instanceof Error ? error.message : 'アップデートを確認できませんでした。');
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handleClearHistory = async () => {
        if (isClearingHistory) return;
        setDataError(null);
        setIsClearingHistory(true);
        try {
            await clearAllHistory();
            setShowClearConfirm(false);
        } catch (err) {
            setDataError(err instanceof Error ? err.message : '会話履歴の削除に失敗しました');
        } finally {
            setIsClearingHistory(false);
        }
    };

    const handleResetApplication = async () => {
        if (isResetting) return;
        setDataError(null);
        setIsResetting(true);
        try {
            await resetApplication();
            setShowResetConfirm(false);
            onClose();
        } catch (err) {
            setDataError(err instanceof Error ? err.message : '初期化に失敗しました');
        } finally {
            setIsResetting(false);
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
                const parsed = parseImportFile(ev.target?.result as string);
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
            const data = importData.type === 'full'
                ? reassignIds(importData.data)
                : importData.data;
            await mergeBackup(data);
            setImportData(null);
        } catch (err) {
            setImportError(err instanceof Error ? err.message : 'インポートに失敗しました');
        } finally {
            setIsImporting(false);
        }
    };

    const handleRestore = async () => {
        if (!importData || importData.type !== 'full') return;
        setImportError(null);
        setIsImporting(true);
        try {
            await restoreBackup(importData.data);
            setImportData(null);
            setShowRestoreConfirm(false);
        } catch (err) {
            setImportError(err instanceof Error ? err.message : 'インポートに失敗しました');
        } finally {
            setIsImporting(false);
        }
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

    const debugLogCount = fullJsonDebugLogs.length;
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
        clearFullJsonDebugLogs();
    };
    const renderToggleButton = ({
        enabled,
        onToggle,
        ariaLabel,
    }: {
        enabled: boolean;
        onToggle: () => void;
        ariaLabel: string;
    }) => (
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
            aria-pressed={enabled}
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
    );
    const renderDebugToggle = ({
        label,
        enabled,
        onToggle,
        ariaLabel,
        beforeToggle,
    }: {
        label: string;
        enabled: boolean;
        onToggle: () => void;
        ariaLabel: string;
        beforeToggle?: ReactNode;
    }) => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
            <div style={{ minWidth: 0 }}>
                <div>
                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                        {label}
                    </span>
                </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                {beforeToggle}
                {renderToggleButton({ enabled, onToggle, ariaLabel })}
            </div>
        </div>
    );

    return (
        <div
            className="modal-overlay"
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div
                ref={modalRef}
                className="modal-content settings-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="グローバル設定"
            >
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
                        <div>

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
                                        {applicationVersion ? `v${applicationVersion}` : versionError ?? '取得中…'}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.875rem' }}>
                                    <button
                                        type="button"
                                        className="btn btn-secondary"
                                        onClick={handleCheckForUpdates}
                                        disabled={isCheckingUpdate}
                                    >
                                        <RefreshCw size={16} className={isCheckingUpdate ? 'animate-spin' : undefined} />
                                        {isCheckingUpdate ? '確認・更新中...' : 'アップデートを確認'}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-secondary"
                                        onClick={onShowOnboarding}
                                    >
                                        初期設定をもう一度見る
                                    </button>
                                </div>
                                {updateError && (
                                    <div style={{
                                        marginTop: '0.75rem',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.375rem',
                                        fontSize: '0.75rem',
                                        color: 'var(--error)',
                                    }}>
                                        <AlertTriangle size={14} />
                                        {updateError}
                                    </div>
                                )}
                                {updateStatus && (
                                    <div
                                        className="card"
                                        style={{
                                            marginTop: '0.75rem',
                                            padding: '0.75rem',
                                            background: updateStatus.updateAvailable
                                                ? 'rgba(59, 130, 246, 0.1)'
                                                : 'rgba(34, 197, 94, 0.1)',
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.8125rem' }}>
                                            {updateStatus.installing ? <RefreshCw size={15} className="animate-spin" /> : updateStatus.updateAvailable ? <Download size={15} /> : <Check size={15} />}
                                            <span>
                                                {updateStatus.installing
                                                    ? `v${updateStatus.latestVersion}をインストールしています。Kataruを再起動中です…`
                                                    : updateStatus.updateAvailable
                                                    ? `新しいバージョン v${updateStatus.latestVersion} が利用できます。`
                                                    : `v${updateStatus.currentVersion} は最新バージョンです。`}
                                            </span>
                                        </div>
                                        {updateStatus.updateAvailable && !updateStatus.installing && (
                                            <a
                                                className="btn btn-primary"
                                                href={updateStatus.releaseUrl}
                                                target="_blank"
                                                rel="noreferrer"
                                                style={{ marginTop: '0.75rem', width: 'fit-content' }}
                                            >
                                                <ExternalLink size={16} />
                                                リリースページを開く
                                            </a>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Appearance Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.75rem',
                            }}>
                                <div className="global-settings-selector-row">
                                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                        外観
                                    </span>
                                    <div className="global-settings-selector-control global-settings-model-selector-control">
                                        <OptionSelector
                                            ariaLabel="外観"
                                            value={themeMode}
                                            onChange={(id) => setThemeMode(id as ThemeMode)}
                                            options={THEME_MODE_OPTIONS.map(({ id, label, Icon }) => ({
                                                value: id,
                                                label,
                                                icon: <Icon size={15} aria-hidden="true" style={{ flexShrink: 0 }} />,
                                            }))}
                                        />
                                    </div>
                                </div>

                                <div className="global-settings-selector-row">
                                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                        色
                                    </span>
                                    <div className="global-settings-selector-control global-settings-model-selector-control">
                                        <OptionSelector
                                            ariaLabel="色"
                                            value={themePalette}
                                            onChange={(id) => setThemePalette(id as ThemePalette)}
                                            options={PALETTE_OPTIONS.map(({ id, label, preview }) => ({
                                                value: id,
                                                label,
                                                icon: renderPaletteDots(preview[themeMode]),
                                            }))}
                                        />
                                    </div>
                                </div>

                                <div className="global-settings-selector-row">
                                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                        既定の表示モード
                                    </span>
                                    <div className="global-settings-selector-control global-settings-model-selector-control">
                                        <OptionSelector
                                            ariaLabel="既定の表示モード"
                                            value={defaultViewMode}
                                            onChange={(id) => setDefaultViewMode(id as RoomViewMode)}
                                            options={VIEW_MODE_OPTIONS.map((option) => ({
                                                value: option.id,
                                                label: option.label,
                                            }))}
                                        />
                                    </div>
                                </div>

                                <VnSpeedSlider value={vnTypingSpeed} onChange={setVnTypingSpeed} />

                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                                        <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                            壁紙
                                        </span>
                                        <button
                                            type="button"
                                            className="btn btn-secondary"
                                            onClick={() => setWallpaperEditorOpen(true)}
                                        >
                                            {chatWallpaper ? '変更' : '設定'}
                                        </button>
                                    </div>
                                    {chatWallpaper ? (
                                        <div style={{
                                            width: 'min(100%, 22rem)',
                                            aspectRatio: '16 / 9',
                                            overflow: 'hidden',
                                            border: '1px solid var(--border-color)',
                                            borderRadius: '0.625rem',
                                            background: 'var(--bg-secondary)',
                                        }}>
                                            <StoredImage
                                                src={chatWallpaper}
                                                alt="設定中の壁紙"
                                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                            />
                                        </div>
                                    ) : (
                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                            設定されていません
                                        </span>
                                    )}
                                    <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                                        チャット画面の背景として表示されます。ゲームモードではシチュエーションの背景が優先されます。
                                    </p>
                                </div>
                            </div>
                        </div>

                            </>
                        )}

                        {activeTab === 'models' && (
                            <>
                        {/* AI connections section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <div className="global-settings-model-heading-row">
                                <h3 style={{ fontSize: '0.875rem', fontWeight: 700 }}>
                                    接続先
                                </h3>
                                <button
                                    type="button"
                                    className="ai-connection-icon-button"
                                    disabled={isAiConnectionAddOpen}
                                    title="接続先を追加"
                                    aria-label="接続先を追加"
                                    onClick={() => setAiConnectionAddOpen(true)}
                                >
                                    <Plus size={16} aria-hidden="true" />
                                </button>
                            </div>
                            <AiConnectionSettings
                                addOpen={isAiConnectionAddOpen}
                                onAddOpenChange={setAiConnectionAddOpen}
                            />
                            <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                                OpenRouter以外の接続先では一部の機能が制限されます。全ての機能を利用するにはOpenRouterを使用してください。
                            </p>
                        </div>

                        {/* Conversation Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <div className="global-settings-model-heading-row">
                                <h3 style={{ fontSize: '0.875rem', fontWeight: 700 }}>
                                    既定のモデル
                                </h3>
                                <button
                                    type="button"
                                    className="btn btn-secondary global-settings-model-reset"
                                    onClick={resetModelDefaults}
                                    disabled={modelDefaultsAreUnchanged}
                                    title="モデル設定を初期値に戻す"
                                >
                                    リセット
                                </button>
                            </div>
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '1rem',
                            }}>

                                <RoleModelField
                                    role="defaultChatModel"
                                    label="会話"
                                    inputId="default-chat-model-input"
                                    value={defaultChatModel}
                                    onChange={setDefaultChatModel}
                                />
                                <RoleModelField
                                    role="defaultDirectorModel"
                                    label="シチュエーション管理"
                                    inputId="default-director-model-input"
                                    value={defaultDirectorModel}
                                    onChange={setDefaultDirectorModel}
                                    outputModality={DIRECTOR_OUTPUT_MODALITIES}
                                />
                                <RoleModelField
                                    role="defaultAutoGenerationModel"
                                    label="設定の自動生成"
                                    inputId="default-auto-generation-model-input"
                                    value={defaultAutoGenerationModel}
                                    onChange={setDefaultAutoGenerationModel}
                                />
                                <RoleModelField
                                    role="titleGenerationModel"
                                    label="タイトル生成"
                                    inputId="title-generation-model-input"
                                    value={titleGenerationModel}
                                    onChange={setTitleGenerationModel}
                                />
                                <RoleModelField
                                    role="replySuggestionModel"
                                    label="返答の提案"
                                    inputId="reply-suggestion-model-input"
                                    value={replySuggestionModel}
                                    onChange={setReplySuggestionModel}
                                />
                                <RoleModelField
                                    role="summaryModel"
                                    label="コンテキスト圧縮"
                                    inputId="summary-model-input"
                                    value={summaryModel}
                                    onChange={setSummaryModel}
                                />
                                <RoleModelField
                                    role="defaultImageModel"
                                    label="画像生成"
                                    inputId="default-image-model-input"
                                    value={defaultImageModel}
                                    onChange={setDefaultImageModel}
                                    outputModality="image"
                                    capability="imageGeneration"
                                />
                                <RoleModelField
                                    role="expressionDetectionModel"
                                    label="表情の自動判定"
                                    inputId="expression-detection-model-input"
                                    value={expressionDetectionModel}
                                    onChange={setExpressionDetectionModel}
                                />
                                <RoleModelField
                                    role="memoryExtractionModel"
                                    label="メモリ保存"
                                    inputId="memory-extraction-model-input"
                                    value={memoryExtractionModel}
                                    onChange={setMemoryExtractionModel}
                                />
                                <RoleModelField
                                    role="memoryEmbeddingModel"
                                    label="メモリ検索"
                                    inputId="memory-embedding-model-input"
                                    value={memoryEmbeddingModel}
                                    onChange={setMemoryEmbeddingModel}
                                    outputModality="embeddings"
                                    capability="embeddings"
                                />
                            </div>
                        </div>

                        {/* TTS Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <div className="global-settings-model-heading-row">
                                <h3 style={{ fontSize: '0.875rem', fontWeight: 700 }}>
                                    音声合成（TTS）
                                </h3>
                                {renderToggleButton({
                                    enabled: ttsEnabled,
                                    onToggle: () => setTtsEnabled(!ttsEnabled),
                                    ariaLabel: '音声合成（TTS）を有効化',
                                })}
                            </div>
                            <fieldset
                                disabled={!ttsEnabled}
                                style={{
                                    border: 'none',
                                    padding: 0,
                                    margin: 0,
                                    minWidth: 0,
                                    opacity: ttsEnabled ? 1 : 0.55,
                                    transition: 'opacity 0.15s ease',
                                }}
                            >
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '1rem',
                            }}>
                                <div className="global-settings-selector-row">
                                    <label
                                        htmlFor="tts-model-input"
                                        style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
                                    >
                                        モデル
                                    </label>
                                    <div className="global-settings-selector-control global-settings-model-selector-control">
                                        <ModelSelector
                                            id="tts-model-input"
                                            value={{ connectionId: ttsConnectionId, model: effectiveTtsModel }}
                                            onChange={(ref) => {
                                                setTtsConnectionId(ref.connectionId);
                                                setTtsModel(ref.model);
                                            }}
                                            outputModality="speech"
                                            placeholder="例: VOICEVOX / deepgram/aura-2"
                                        />
                                    </div>
                                </div>
                                <div className="global-settings-selector-row">
                                    <label
                                        htmlFor="tts-voice-input"
                                        style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
                                    >
                                        声
                                    </label>
                                    <div className="global-settings-selector-control">
                                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <TtsVoiceField
                                                    id="tts-voice-input"
                                                    connectionId={ttsConnectionId}
                                                    value={ttsVoice}
                                                    onChange={setTtsVoice}
                                                    emptyLabel="なし"
                                                />
                                            </div>
                                            <TtsPreviewButton
                                                previewId="tts-preview-global"
                                                profile={{
                                                    connectionId: ttsConnectionId,
                                                    model: effectiveTtsModel,
                                                    voice: ttsVoice,
                                                    speed: ttsSpeed,
                                                    volume: ttsVolume,
                                                }}
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="global-settings-selector-row">
                                    <label
                                        htmlFor="tts-speed-input"
                                        style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
                                    >
                                        速度
                                    </label>
                                    <div
                                        className="global-settings-selector-control"
                                        style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}
                                    >
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <TtsSpeedSlider
                                                id="tts-speed-input"
                                                value={ttsSpeed}
                                                ariaLabel="読み上げ速度"
                                                onChange={setTtsSpeed}
                                            />
                                        </div>
                                        <span style={{
                                            fontSize: '0.8125rem',
                                            fontWeight: 600,
                                            color: 'var(--accent-primary)',
                                            minWidth: '3.5rem',
                                            textAlign: 'right',
                                            fontVariantNumeric: 'tabular-nums',
                                        }}>
                                            {formatTtsSpeed(ttsSpeed)}
                                        </span>
                                    </div>
                                </div>
                                <div className="global-settings-selector-row">
                                    <label
                                        htmlFor="tts-volume-input"
                                        style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
                                    >
                                        音量
                                    </label>
                                    <div
                                        className="global-settings-selector-control"
                                        style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}
                                    >
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <TtsVolumeSlider
                                                id="tts-volume-input"
                                                value={ttsVolume}
                                                ariaLabel="読み上げ音量"
                                                onChange={setTtsVolume}
                                            />
                                        </div>
                                        <span style={{
                                            fontSize: '0.8125rem',
                                            fontWeight: 600,
                                            color: 'var(--accent-primary)',
                                            minWidth: '3.5rem',
                                            textAlign: 'right',
                                            fontVariantNumeric: 'tabular-nums',
                                        }}>
                                            {formatTtsVolume(ttsVolume)}
                                        </span>
                                    </div>
                                </div>
                                {renderDebugToggle({
                                    label: '新しい返答を自動で読み上げる',
                                    enabled: ttsAutoPlay,
                                    onToggle: () => setTtsAutoPlay(!ttsAutoPlay),
                                    ariaLabel: '新しい返答を自動で読み上げる',
                                })}
                                {renderDebugToggle({
                                    label: '地の文・動作描写もナレーションとして読み上げる',
                                    enabled: ttsNarrationEnabled,
                                    onToggle: () => setTtsNarrationEnabled(!ttsNarrationEnabled),
                                    ariaLabel: '地の文・動作描写もナレーションとして読み上げる',
                                })}
                                {ttsNarrationEnabled && (
                                    <div className="global-settings-selector-row">
                                        <label
                                            htmlFor="tts-narrator-voice-input"
                                            style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
                                        >
                                            ナレーションの声
                                        </label>
                                        <div className="global-settings-selector-control">
                                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <TtsVoiceField
                                                        id="tts-narrator-voice-input"
                                                        connectionId={ttsConnectionId}
                                                        value={ttsNarratorVoice}
                                                        onChange={setTtsNarratorVoice}
                                                        emptyLabel="既定の声"
                                                    />
                                                </div>
                                                <TtsPreviewButton
                                                    previewId="tts-preview-narrator"
                                                    profile={{
                                                        connectionId: ttsConnectionId,
                                                        model: effectiveTtsModel,
                                                        voice: ttsNarratorVoice || ttsVoice,
                                                        speed: ttsSpeed,
                                                        volume: ttsVolume,
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {ttsConnectionKind === 'irodori' && (
                                    <>
                                        {renderDebugToggle({
                                            label: '動作描写を声の演技指示に使う',
                                            enabled: ttsActionCaption,
                                            onToggle: () => setTtsActionCaption(!ttsActionCaption),
                                            ariaLabel: '動作描写を声の演技指示に使う',
                                        })}
                                        <div className="global-settings-selector-row">
                                            <label
                                                htmlFor="tts-caption-cfg-scale-input"
                                                style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
                                            >
                                                演技指示の強さ
                                            </label>
                                            <div
                                                className="global-settings-selector-control"
                                                style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}
                                            >
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <TtsCaptionCfgScaleSlider
                                                        id="tts-caption-cfg-scale-input"
                                                        value={ttsCaptionCfgScale}
                                                        ariaLabel="演技指示の強さ"
                                                        disabled={!ttsActionCaption}
                                                        onChange={setTtsCaptionCfgScale}
                                                    />
                                                </div>
                                                <span style={{
                                                    fontSize: '0.8125rem',
                                                    fontWeight: 600,
                                                    color: 'var(--accent-primary)',
                                                    minWidth: '3.5rem',
                                                    textAlign: 'right',
                                                    fontVariantNumeric: 'tabular-nums',
                                                }}>
                                                    {formatTtsCaptionCfgScale(ttsCaptionCfgScale)}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="global-settings-selector-row">
                                            <label
                                                htmlFor="tts-chunk-min-chars-input"
                                                style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
                                            >
                                                読み上げ分割の最小文字数
                                            </label>
                                            <div
                                                className="global-settings-selector-control"
                                                style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}
                                            >
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <TtsChunkMinCharsSlider
                                                        id="tts-chunk-min-chars-input"
                                                        min={TTS_CHUNK_MIN_CHARS_MIN}
                                                        max={TTS_CHUNK_MIN_CHARS_MAX}
                                                        value={ttsChunkMinChars}
                                                        ariaLabel="読み上げ分割の最小文字数"
                                                        onChange={setTtsChunkMinChars}
                                                    />
                                                </div>
                                                <span style={{
                                                    fontSize: '0.8125rem',
                                                    fontWeight: 600,
                                                    color: 'var(--accent-primary)',
                                                    minWidth: '3.5rem',
                                                    textAlign: 'right',
                                                    fontVariantNumeric: 'tabular-nums',
                                                }}>
                                                    {ttsChunkMinChars}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="global-settings-selector-row">
                                            <label
                                                htmlFor="tts-first-chunk-min-chars-input"
                                                style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}
                                            >
                                                最初の分割の最小文字数
                                            </label>
                                            <div
                                                className="global-settings-selector-control"
                                                style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}
                                            >
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <TtsChunkMinCharsSlider
                                                        id="tts-first-chunk-min-chars-input"
                                                        min={TTS_FIRST_CHUNK_MIN_CHARS_MIN}
                                                        max={TTS_FIRST_CHUNK_MIN_CHARS_MAX}
                                                        value={ttsFirstChunkMinChars}
                                                        ariaLabel="最初の分割の最小文字数"
                                                        onChange={setTtsFirstChunkMinChars}
                                                    />
                                                </div>
                                                <span style={{
                                                    fontSize: '0.8125rem',
                                                    fontWeight: 600,
                                                    color: 'var(--accent-primary)',
                                                    minWidth: '3.5rem',
                                                    textAlign: 'right',
                                                    fontVariantNumeric: 'tabular-nums',
                                                }}>
                                                    {ttsFirstChunkMinChars}
                                                </span>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                            {ttsCapableConnections.length === 0 && (
                                <p style={{ marginTop: '0.75rem', marginBottom: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                                    音声合成にはVOICEVOXまたはIrodori TTSの接続先、または「音声合成（TTS）を利用する」を有効にしたOpenAI互換の接続先が必要です。
                                </p>
                            )}
                            </fieldset>
                        </div>

                            </>
                        )}

                        {activeTab === 'debug' && (
                        /* Debug Section */
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                                デバッグ
                            </h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {renderDebugToggle({
                                    label: '入出力ログの有効化',
                                    enabled: fullJsonDebugEnabled,
                                    onToggle: () => setFullJsonDebugEnabled(!fullJsonDebugEnabled),
                                    ariaLabel: '完全なJSON表示を有効化',
                                    beforeToggle: fullJsonDebugEnabled ? (
                                        <button
                                            type="button"
                                            className="btn btn-ghost"
                                            onClick={handleClearDebugLogs}
                                            disabled={debugLogCount === 0}
                                            aria-label="ログを削除"
                                            title="ログを削除"
                                            style={{ padding: '0.5rem', color: 'var(--error)' }}
                                        >
                                            <Trash2 size={16} aria-hidden="true" />
                                        </button>
                                    ) : null,
                                })}
                                <div>
                                    {renderDebugToggle({
                                        label: '詳細なエラー表示の有効化',
                                        enabled: detailedErrorLoggingEnabled,
                                        onToggle: () => setDetailedErrorLoggingEnabled(!detailedErrorLoggingEnabled),
                                        ariaLabel: '詳細なエラー表示を有効化',
                                    })}
                                </div>
                                <div>
                                    {renderDebugToggle({
                                        label: 'メモリインスペクター',
                                        enabled: memoryInspectorEnabled,
                                        onToggle: () => setMemoryInspectorEnabled(!memoryInspectorEnabled),
                                        ariaLabel: 'メモリインスペクターを有効化',
                                    })}
                                    <p style={{ margin: '0.375rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                                        応答で参照されたメモリを確認し、編集・削除・優先固定できます。
                                    </p>
                                </div>
                                <div>
                                    {renderDebugToggle({
                                        label: '要約インスペクター',
                                        enabled: summaryInspectorEnabled,
                                        onToggle: () => setSummaryInspectorEnabled(!summaryInspectorEnabled),
                                        ariaLabel: '要約インスペクターを有効化',
                                    })}
                                    <p style={{ margin: '0.375rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                                        現在の要約、圧縮範囲、履歴を確認して手動編集できます。
                                    </p>
                                </div>
                            </div>
                        </div>
                        )}

                        {activeTab === 'keyboard' && <KeyboardSettingsPanel />}

                        {activeTab === 'statistics' && <StatisticsPanel />}

                        {activeTab === 'general' && (
                            <>
                        {/* Feature Section */}
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '0.875rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                                機能
                            </h3>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                                    <div>
                                        <div style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                            会話圧縮
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setConversationCompressionEnabled(!conversationCompressionEnabled)}
                                        style={{
                                            position: 'relative',
                                            width: '44px',
                                            height: '24px',
                                            borderRadius: '12px',
                                            border: 'none',
                                            cursor: 'pointer',
                                            background: conversationCompressionEnabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                            transition: 'background 0.2s ease',
                                            padding: 0,
                                            flexShrink: 0,
                                        }}
                                        aria-label="会話圧縮を有効化"
                                        aria-pressed={conversationCompressionEnabled}
                                    >
                                        <span style={{
                                            position: 'absolute',
                                            top: '2px',
                                            left: conversationCompressionEnabled ? '22px' : '2px',
                                            width: '20px',
                                            height: '20px',
                                            borderRadius: '50%',
                                            background: '#fff',
                                            transition: 'left 0.2s ease',
                                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                                        }} />
                                    </button>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginTop: '1rem' }}>
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
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginTop: '1rem' }}>
                                    <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                        返答の選択肢を表示
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setReplySuggestionsEnabled(!replySuggestionsEnabled)}
                                        style={{
                                            position: 'relative',
                                            width: '44px',
                                            height: '24px',
                                            borderRadius: '12px',
                                            border: 'none',
                                            cursor: 'pointer',
                                            background: replySuggestionsEnabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                                            transition: 'background 0.2s ease',
                                            padding: 0,
                                            flexShrink: 0,
                                        }}
                                        aria-label="返答の選択肢を表示"
                                        aria-pressed={replySuggestionsEnabled}
                                    >
                                        <span style={{
                                            position: 'absolute',
                                            top: '2px',
                                            left: replySuggestionsEnabled ? '22px' : '2px',
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
                                    accept=".json,application/json"
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
                                        {importData.type === 'character' ? 'キャラクターを追加' : 'インポート内容'}
                                    </p>
                                    <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                        {importData.type === 'character'
                                            ? `「${importData.data.characters[0]?.name ?? '名称不明'}」の設定と画像を読み込みます。会話履歴やメモリは含まれません。`
                                            : `キャラクター ${importData.data.characters.length} 件 / ルーム ${importData.data.rooms.length} 件 / 使用記録 ${importData.data.usageRecords.length} 件`}
                                    </p>
                                    {isImporting && (
                                        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                            インポート中です。完了までこの画面を閉じずにお待ちください。
                                        </p>
                                    )}
                                    {importData.type === 'full' && showRestoreConfirm ? (
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
                                                {importData.type === 'character'
                                                    ? (isImporting ? '追加中...' : '追加する')
                                                    : (isImporting ? 'マージ中...' : 'マージ（追加）')}
                                            </button>
                                            {importData.type === 'full' && (
                                                <button className="btn btn-danger" onClick={() => setShowRestoreConfirm(true)} disabled={isImporting}>
                                                    置き換え
                                                </button>
                                            )}
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
                            {dataError && (
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
                                    {dataError}
                                </div>
                            )}
                            {showClearConfirm ? (
                                <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'var(--error)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                        <AlertTriangle size={20} style={{ color: 'var(--error)' }} />
                                        <span style={{ fontWeight: 500 }}>本当に削除しますか？</span>
                                    </div>
                                    <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                        全てのチャットルーム、メッセージ履歴、ルームに紐づくメモリが削除されます。キャラクターとシチュエーションの設定は削除されません。この操作は元に戻せません。
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
                                <button className="btn btn-danger" onClick={() => {
                                    setShowResetConfirm(false);
                                    setShowClearConfirm(true);
                                }} disabled={isClearingHistory || isResetting}>
                                    <Trash2 size={16} />
                                    全ての会話履歴を削除
                                </button>
                            )}
                            <div style={{ marginTop: '0.75rem' }}>
                                {showResetConfirm ? (
                                    <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'var(--error)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                            <AlertTriangle size={20} style={{ color: 'var(--error)' }} />
                                            <span style={{ fontWeight: 500 }}>本当に初期化しますか？</span>
                                        </div>
                                        <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                            DBに保存されたキャラクター、シチュエーション、会話履歴、メモリ、使用記録、各種設定、画像をすべて削除し、Kataruを初期状態に戻します。この操作は元に戻せません。
                                        </p>
                                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                                            <button className="btn btn-danger" onClick={handleResetApplication} disabled={isResetting}>
                                                {isResetting ? '初期化中...' : '初期化する'}
                                            </button>
                                            <button className="btn btn-secondary" onClick={() => setShowResetConfirm(false)} disabled={isResetting}>
                                                キャンセル
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <button className="btn btn-danger" onClick={() => {
                                        setShowClearConfirm(false);
                                        setShowResetConfirm(true);
                                    }} disabled={isClearingHistory || isResetting}>
                                        <RefreshCw size={16} />
                                        アプリを初期化
                                    </button>
                                )}
                            </div>
                        </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
            </div>
            {isWallpaperEditorOpen && (
                <SituationBackgroundModal
                    isOpen
                    currentImage={chatWallpaper}
                    title="壁紙を編集"
                    usageHint="チャット画面の背景として表示されます。ゲームモードではシチュエーションの背景が優先されます。"
                    generationHint="人物や文字を含まない、チャット画面用の横長背景として生成します。"
                    removeConfirmMessage="設定中の壁紙を削除しますか？"
                    onClose={() => setWallpaperEditorOpen(false)}
                    onComplete={(image) => {
                        if (!image) {
                            setChatWallpaper(undefined);
                            return;
                        }
                        void resizeToMaxEdgeAsJpeg(image, 1920)
                            .then((jpeg) => setChatWallpaper(jpeg))
                            .catch(() => setChatWallpaper(image));
                    }}
                />
            )}
        </div>
    );
}
