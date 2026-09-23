import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, Menu, Sparkles } from 'lucide-react';
import {
    formatGeneratedCharacterPrompt,
    formatGeneratedProtagonistPrompt,
    formatGeneratedSpeechStyle,
    normalizeGeneratedCharacterProfile,
} from '@/lib/characterGeneration';
import {
    AI_CONNECTION_KIND_LABELS,
    DEFAULT_ANTHROPIC_TEXT_MODEL,
    isAiConnectionKind,
    type AiConnectionKind,
} from '@/lib/aiApi';
import {
    createAiConnection,
    updateAiConnection,
    useAiConnections,
    type UpdateAiConnectionInput,
} from '@/lib/aiConnections';
import { getAvailableModels, type AvailableModel } from '@/lib/availableModels';
import { serializeModelRef } from '@/lib/modelDefaults';
import { useStore } from '@/lib/store';
import OptionSelector from '@/components/OptionSelector';
import TtsVoiceField from '@/components/TtsVoiceField';

interface FirstRunGuideProps {
    onOpenSidebar: () => void;
    onComplete: () => void;
    onSkip: () => void;
}

type GuideStep = 'api-type' | 'connection' | 'tts' | 'character';
type ConnectionState = 'idle' | 'checking' | 'error';

interface ConnectionStatusResponse {
    ready?: boolean;
    message?: string;
}

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';

/** Endpoint prefill used when the picked kind has no connection yet. */
const KIND_DEFAULT_BASE_URL: Record<AiConnectionKind, string> = {
    openrouter: '',
    'openai-compatible': OPENAI_DEFAULT_BASE_URL,
    anthropic: ANTHROPIC_DEFAULT_BASE_URL,
    typesafe: TYPESAFE_DEFAULT_BASE_URL,
    voicevox: 'http://127.0.0.1:50021',
    irodori: 'http://127.0.0.1:8088',
};

const CONNECTION_OPTIONS: readonly {
    id: AiConnectionKind;
    title: string;
}[] = [
    {
        id: 'openrouter',
        title: 'OpenRouter'
    },
    {
        id: 'openai-compatible',
        title: 'OpenAI / 互換API'
    },
    {
        id: 'anthropic',
        title: 'Anthropic'
    },
];

export default function FirstRunGuide({ onOpenSidebar, onComplete, onSkip }: FirstRunGuideProps) {
    const {
        getAiApiConfig,
        defaultChatModel,
        defaultAutoGenerationModel,
        setDefaultChatModel,
        setDefaultDirectorModel,
        setDefaultAutoGenerationModel,
        setTitleGenerationModel,
        setReplySuggestionModel,
        setSummaryModel,
        setExpressionDetectionModel,
        setMemoryExtractionModel,
        setTtsConnectionId,
        setTtsVoice,
        createCharacter,
        createRoom,
    } = useStore();
    const {
        connections,
        secretStoreAvailable,
        loading: connectionsLoading,
        error: connectionsError,
        reload: reloadConnections,
    } = useAiConnections();
    const [step, setStep] = useState<GuideStep>('api-type');
    const [selectedConnectionId, setSelectedConnectionId] = useState<string>('openrouter');
    const [createdConnectionId, setCreatedConnectionId] = useState<string | null>(null);
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [anthropicModel, setAnthropicModel] = useState(DEFAULT_ANTHROPIC_TEXT_MODEL);
    const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
    const [connectionMessage, setConnectionMessage] = useState('');
    const [checkSucceeded, setCheckSucceeded] = useState(false);
    const [availableTextModels, setAvailableTextModels] = useState<AvailableModel[]>([]);
    const [modelListFailed, setModelListFailed] = useState(false);
    const [selectedGuideModel, setSelectedGuideModel] = useState('');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [speechStyle, setSpeechStyle] = useState('');
    const [relationship, setRelationship] = useState('');
    const [isGenerating, setGenerating] = useState(false);
    const [generationError, setGenerationError] = useState('');
    const [ttsBaseUrl, setTtsBaseUrl] = useState('');
    const [ttsState, setTtsState] = useState<ConnectionState>('idle');
    const [ttsMessage, setTtsMessage] = useState('');
    const [ttsChecked, setTtsChecked] = useState(false);
    const [guideTtsVoice, setGuideTtsVoice] = useState('');

    // The picked kind may not have a connection yet; in that case the guide
    // creates it on demand when the user checks the connection.
    const connection = (createdConnectionId
        ? connections.find((candidate) => candidate.id === createdConnectionId)
        : undefined)
        ?? connections.find((candidate) => candidate.id === selectedConnectionId)
        ?? connections.find((candidate) => candidate.kind === selectedConnectionId)
        ?? null;
    const connectionKind: AiConnectionKind = connection?.kind
        ?? (isAiConnectionKind(selectedConnectionId) ? selectedConnectionId : 'openrouter');
    const baseUrlEditable = connection?.baseUrlEditable ?? connectionKind !== 'openrouter';
    const apiKeyEditable = connection?.apiKey.editable ?? true;
    const apiKeyConfigured = connection?.apiKey.configured ?? false;

    const resetCheckResult = () => {
        setCheckSucceeded(false);
        setAvailableTextModels([]);
        setModelListFailed(false);
        setSelectedGuideModel('');
    };

    useEffect(() => {
        if (step !== 'connection') return;
        setConnectionState('idle');
        setConnectionMessage('');
        resetCheckResult();
        setApiKey('');
        setBaseUrl(connection?.baseUrl ?? KIND_DEFAULT_BASE_URL[connectionKind]);
        setAnthropicModel(
            defaultChatModel.connectionId === 'anthropic' && defaultChatModel.model.startsWith('claude-')
                ? defaultChatModel.model
                : DEFAULT_ANTHROPIC_TEXT_MODEL,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, connection?.id, connection?.baseUrl]);

    // The built-in VOICEVOX connection resolves server-side even while it is
    // unlisted, so 'voicevox' works as the fallback id before it is configured.
    const voicevoxConnection = connections.find((candidate) => candidate.kind === 'voicevox') ?? null;
    const ttsConnectionId = voicevoxConnection?.id ?? 'voicevox';

    useEffect(() => {
        if (step !== 'tts') return;
        setTtsState('idle');
        setTtsMessage('');
        setTtsChecked(false);
        setGuideTtsVoice('');
        setTtsBaseUrl(voicevoxConnection?.baseUrl ?? KIND_DEFAULT_BASE_URL.voicevox);
    }, [step, voicevoxConnection?.id, voicevoxConnection?.baseUrl]);

    const selectConnection = (connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setCreatedConnectionId(null);
        setConnectionState('idle');
        setConnectionMessage('');
        resetCheckResult();
    };

    const saveAndCheckConnection = async () => {
        if (connectionState === 'checking') return;

        const kind = connectionKind;
        const trimmedApiKey = apiKey.trim();
        const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
        const baseChanged = baseUrlEditable
            && trimmedBaseUrl !== (connection?.baseUrl ?? '');

        if (kind === 'openrouter' && !apiKeyConfigured && !trimmedApiKey) {
            setConnectionState('error');
            setConnectionMessage('OpenRouter APIキーを入力してください。');
            return;
        }
        if (kind !== 'openrouter' && baseUrlEditable && !trimmedBaseUrl) {
            setConnectionState('error');
            setConnectionMessage('エンドポイントを入力してください。');
            return;
        }
        if (
            kind === 'anthropic'
            && (!apiKeyConfigured || baseChanged)
            && !trimmedApiKey
        ) {
            setConnectionState('error');
            setConnectionMessage('Anthropic APIキーを入力してください。');
            return;
        }
        if (
            kind === 'openai-compatible'
            && trimmedBaseUrl === OPENAI_DEFAULT_BASE_URL
            && (!apiKeyConfigured || baseChanged)
            && !trimmedApiKey
        ) {
            setConnectionState('error');
            setConnectionMessage('OpenAI公式APIを使うにはAPIキーを入力してください。');
            return;
        }

        setConnectionState('checking');
        setConnectionMessage('');

        try {
            let connectionId: string;
            if (connection) {
                const update: UpdateAiConnectionInput = {};
                if (baseChanged) update.baseUrl = trimmedBaseUrl;
                if (apiKeyEditable && trimmedApiKey) update.apiKey = trimmedApiKey;
                if (Object.keys(update).length > 0) {
                    await updateAiConnection(connection.id, update);
                }
                connectionId = connection.id;
            } else {
                const beforeIds = new Set(connections.map((candidate) => candidate.id));
                const created = (await createAiConnection({
                    name: AI_CONNECTION_KIND_LABELS[kind],
                    kind,
                    ...(kind === 'openrouter' ? {} : { baseUrl: trimmedBaseUrl }),
                    ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
                })).connections.find((candidate) => !beforeIds.has(candidate.id));
                if (!created) throw new Error('接続先を作成できませんでした。');
                setCreatedConnectionId(created.id);
                connectionId = created.id;
            }
            setApiKey('');

            const response = await fetch('/api/ai/status', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    aiApiConfig: { ...getAiApiConfig(), connectionId },
                }),
            });
            const data = await response.json().catch(() => ({})) as ConnectionStatusResponse;
            if (!response.ok) {
                throw new Error(data.message || `接続の確認に失敗しました (${response.status})`);
            }
            if (data.ready === true) {
                if (kind === 'openrouter') {
                    setStep('tts');
                    setConnectionState('idle');
                    return;
                }
                const models = await getAvailableModels(connectionId, 'text', { force: true })
                    .catch(() => [] as AvailableModel[]);
                setAvailableTextModels(models);
                setModelListFailed(models.length === 0);
                setSelectedGuideModel(
                    models[0]?.id ?? (kind === 'anthropic' ? anthropicModel.trim() : ''),
                );
                setCheckSucceeded(true);
                setConnectionState('idle');
                return;
            }
            setConnectionState('error');
            setConnectionMessage(data.message || 'AIに接続できませんでした。設定を確認してください。');
        } catch (error) {
            setConnectionState('error');
            setConnectionMessage(error instanceof Error ? error.message : '接続の確認に失敗しました。');
        }
    };

    const applyModelAndAdvance = () => {
        const model = selectedGuideModel.trim();
        if (!connection || !model) return;
        const modelRef = { connectionId: connection.id, model };
        setDefaultChatModel(modelRef);
        setDefaultDirectorModel(modelRef);
        setDefaultAutoGenerationModel(modelRef);
        setTitleGenerationModel(modelRef);
        setReplySuggestionModel(modelRef);
        setSummaryModel(modelRef);
        setExpressionDetectionModel(modelRef);
        setMemoryExtractionModel(modelRef);
        setStep('tts');
    };

    const checkVoicevoxConnection = async () => {
        if (ttsState === 'checking') return;

        const trimmedBaseUrl = ttsBaseUrl.trim().replace(/\/+$/, '');
        if (!trimmedBaseUrl) {
            setTtsState('error');
            setTtsMessage('エンドポイントを入力してください。');
            return;
        }

        setTtsState('checking');
        setTtsMessage('');

        try {
            // Persisting the endpoint also lists the built-in connection, so it
            // shows up in the settings connection list once configured here.
            if (!voicevoxConnection || trimmedBaseUrl !== voicevoxConnection.baseUrl) {
                await updateAiConnection(ttsConnectionId, { baseUrl: trimmedBaseUrl });
            }

            const response = await fetch('/api/ai/status', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    aiApiConfig: { ...getAiApiConfig(), connectionId: ttsConnectionId },
                }),
            });
            const data = await response.json().catch(() => ({})) as ConnectionStatusResponse;
            if (!response.ok) {
                throw new Error(data.message || `接続の確認に失敗しました (${response.status})`);
            }
            if (data.ready === true) {
                setTtsChecked(true);
                setTtsState('idle');
                return;
            }
            setTtsState('error');
            setTtsMessage('VOICEVOXエンジンに接続できませんでした。エンジンが起動しているか確認してください。');
        } catch (error) {
            setTtsState('error');
            setTtsMessage(error instanceof Error ? error.message : '接続の確認に失敗しました。');
        }
    };

    const applyTtsAndAdvance = () => {
        setTtsConnectionId(ttsConnectionId);
        setTtsVoice(guideTtsVoice);
        setStep('character');
    };

    const generateCharacter = async () => {
        if (isGenerating) return;
        setGenerating(true);
        setGenerationError('');

        try {
            const response = await fetch('/api/generate-character', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    direction: description.trim(),
                    model: serializeModelRef(defaultAutoGenerationModel),
                    aiApiConfig: {
                        ...getAiApiConfig(),
                        connectionId: defaultAutoGenerationModel.connectionId,
                    },
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                const message = typeof data?.error === 'string' ? data.error : `作成に失敗しました (${response.status})`;
                throw new Error(message);
            }
            const generated = normalizeGeneratedCharacterProfile(data?.character);
            if (!generated) throw new Error('作成結果を読み取れませんでした。');
            setName(generated.name);
            setDescription(formatGeneratedCharacterPrompt(generated));
            setSpeechStyle(formatGeneratedSpeechStyle(generated));
            setRelationship(formatGeneratedProtagonistPrompt(generated));
        } catch (error) {
            setGenerationError(error instanceof Error ? error.message : 'キャラクターを作成できませんでした。');
        } finally {
            setGenerating(false);
        }
    };

    const startConversation = () => {
        const trimmedName = name.trim();
        if (!trimmedName) return;
        const characterId = createCharacter(trimmedName, description.trim(), defaultChatModel, {
            speechStyle: speechStyle.trim() || undefined,
            protagonistPrompt: relationship.trim() || undefined,
        });
        createRoom(characterId);
        onComplete();
    };

    const stepNumber = step === 'api-type' ? 1 : step === 'connection' ? 2 : step === 'tts' ? 3 : 4;
    const ttsBusy = connectionsLoading || ttsState === 'checking';
    const ttsBaseChanged = voicevoxConnection == null
        || ttsBaseUrl.trim().replace(/\/+$/, '') !== (voicevoxConnection.baseUrl ?? KIND_DEFAULT_BASE_URL.voicevox);
    const baseChanged = baseUrlEditable
        && baseUrl.trim().replace(/\/+$/, '') !== (connection?.baseUrl ?? '');
    const hasConnectionChanges = connection == null
        ? true
        : connectionKind === 'openrouter'
            ? apiKey.trim().length > 0
            : baseChanged || apiKey.trim().length > 0;
    const connectionBusy = connectionsLoading || connectionState === 'checking';
    return (
        <section className="chat-container onboarding-container" aria-label="はじめ方">
            <div className="chat-header mobile-only onboarding-mobile-header">
                <button
                    type="button"
                    className="btn btn-ghost mobile-sidebar-trigger"
                    onClick={onOpenSidebar}
                    title="サイドバーを開く"
                    aria-label="サイドバーを開く"
                >
                    <Menu size={20} />
                </button>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 500 }}>
                    <img src="/logo.png" alt="" style={{ height: 24, width: 'auto' }} />
                    Kataru
                </span>
                <div style={{ width: 36 }} />
            </div>

            <div className="onboarding-scroll">
                <div className={`onboarding-card ${step !== 'character' ? 'is-connection-step' : ''}`}>
                    <div className="onboarding-navigation">
                        {step !== 'api-type' ? (
                            <button
                                type="button"
                                className="btn btn-ghost onboarding-back"
                                onClick={() => setStep(
                                    step === 'character' ? 'tts' : step === 'tts' ? 'connection' : 'api-type',
                                )}
                                aria-label="前へ戻る"
                                title="前へ戻る"
                            >
                                <ArrowLeft size={19} />
                            </button>
                        ) : (
                            <span className="onboarding-back-placeholder" aria-hidden="true" />
                        )}
                        <div
                            className={`onboarding-progress is-${step}-step`}
                            role="progressbar"
                            aria-label={`${stepNumber} / 4`}
                            aria-valuemin={1}
                            aria-valuemax={4}
                            aria-valuenow={stepNumber}
                        >
                            <span className="onboarding-progress-fill" />
                        </div>
                        <span className="onboarding-back-placeholder" aria-hidden="true" />
                    </div>

                    {step === 'api-type' ? (
                        <>
                            <div className="onboarding-heading">
                                <img
                                    src="/logo.png"
                                    alt=""
                                    style={{ height: 44, width: 'auto', flexShrink: 0 }}
                                />
                                <div>
                                    <p className="onboarding-step-label">1 / 4 · APIの種類を選ぶ</p>
                                    <h1>Kataruへようこそ</h1>
                                </div>
                            </div>
                            <p className="onboarding-lead">
                                AIキャラクターと話しましょう。利用するAPIを選んでください。
                            </p>

                            <div className="onboarding-api-type-list" role="radiogroup" aria-label="会話に使うAIのAPIの種類">
                                {CONNECTION_OPTIONS.map(({ id, title }) => {
                                    const selected = selectedConnectionId === id;
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            role="radio"
                                            aria-checked={selected}
                                            className={`onboarding-api-type ${selected ? 'selected' : ''}`}
                                            onClick={() => selectConnection(id)}
                                        >
                                            <span className="onboarding-api-type-copy">
                                                <span className="onboarding-api-type-title">{title}</span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="onboarding-actions">
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={onSkip}
                                >
                                    初期設定をスキップ
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={() => setStep('connection')}
                                >
                                    次へ
                                </button>
                            </div>
                        </>
                    ) : step === 'connection' ? (
                        <>
                            <div className="onboarding-heading">
                                <div>
                                    <p className="onboarding-step-label">2 / 4 · 接続設定</p>
                                    <h1>
                                        {connection ? connection.name : AI_CONNECTION_KIND_LABELS[connectionKind]}
                                    </h1>
                                </div>
                            </div>
                            <p className="onboarding-lead">
                                {connectionKind === 'openrouter'
                                    ? 'OpenRouterのAPIキーを保存して、会話できるか確認します。'
                                    : connectionKind === 'anthropic'
                                        ? 'Claude APIまたは互換APIのエンドポイントとAPIキーを設定します。'
                                        : 'OpenAI APIまたは互換APIのエンドポイントとAPIキーを設定します。'}
                            </p>

                            {connectionsLoading && !connection ? (
                                <div className="ai-connection-card ai-connection-loading onboarding-connection-card" aria-live="polite">
                                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                                    AI接続設定を読み込んでいます…
                                </div>
                            ) : connectionsError && !connection ? (
                                <div className="onboarding-status error" role="alert">
                                    <span>{connectionsError}</span>
                                    <button type="button" onClick={() => void reloadConnections()}>
                                        再読み込み
                                    </button>
                                </div>
                            ) : (
                                <div className="ai-connection-card onboarding-connection-card">

                                    {!secretStoreAvailable && !apiKeyConfigured && (
                                        <p className="ai-connection-message error" role="alert">
                                            OSの資格情報ストアを利用できません。環境変数でAPIキーを設定してください。
                                        </p>
                                    )}

                                    {connectionKind !== 'openrouter' && (
                                        <>
                                            <label className="ai-connection-label" htmlFor="onboarding-base-url">
                                                エンドポイント
                                            </label>
                                            <input
                                                id="onboarding-base-url"
                                                className="input"
                                                type="url"
                                                value={baseUrl}
                                                disabled={!baseUrlEditable || connectionBusy}
                                                spellCheck={false}
                                                onChange={(event) => {
                                                    setBaseUrl(event.target.value);
                                                    if (checkSucceeded) resetCheckResult();
                                                }}
                                            />
                                            {!baseUrlEditable && (
                                                <p className="ai-connection-help">
                                                    環境変数が設定されているため、変更できません。
                                                </p>
                                            )}
                                            {baseChanged && apiKeyConfigured && (
                                                <p className="ai-connection-help warning">
                                                    接続先を変更すると、現在保存されているAPIキーは解除されます。
                                                </p>
                                            )}
                                        </>
                                    )}

                                    <label className="ai-connection-label" htmlFor="onboarding-api-key">
                                        APIキー
                                    </label>
                                    <input
                                        id="onboarding-api-key"
                                        className="input"
                                        type="password"
                                        value={apiKey}
                                        disabled={!apiKeyEditable || connectionBusy}
                                        autoComplete="new-password"
                                        spellCheck={false}
                                        autoFocus={apiKeyEditable && !apiKeyConfigured}
                                        placeholder={apiKeyConfigured
                                            ? '変更する場合のみ入力'
                                            : connectionKind === 'openai-compatible'
                                                ? 'APIキーを入力（ローカルAPIでは省略可）'
                                                : `${AI_CONNECTION_KIND_LABELS[connectionKind]} APIキーを入力`}
                                        onChange={(event) => {
                                            setApiKey(event.target.value);
                                            if (checkSucceeded) resetCheckResult();
                                        }}
                                    />
                                    {!apiKeyEditable && (
                                        <p className="ai-connection-help">
                                            環境変数が設定されているため、変更できません。
                                        </p>
                                    )}

                                    {checkSucceeded && (
                                        <>
                                            <p className="ai-connection-message success" role="status">
                                                接続を確認しました。使用するモデルを選んでください。
                                            </p>
                                            <label className="ai-connection-label" htmlFor="onboarding-guide-model">
                                                使用するモデル
                                            </label>
                                            {modelListFailed ? (
                                                <>
                                                    <input
                                                        id="onboarding-guide-model"
                                                        className="input"
                                                        type="text"
                                                        value={selectedGuideModel}
                                                        spellCheck={false}
                                                        placeholder={connectionKind === 'anthropic'
                                                            ? DEFAULT_ANTHROPIC_TEXT_MODEL
                                                            : 'モデルIDを入力'}
                                                        onChange={(event) => setSelectedGuideModel(event.target.value)}
                                                    />
                                                    <p className="ai-connection-help">
                                                        モデル一覧を取得できなかったため、モデルIDを入力してください。
                                                    </p>
                                                </>
                                            ) : (
                                                <OptionSelector
                                                    id="onboarding-guide-model"
                                                    value={selectedGuideModel}
                                                    onChange={setSelectedGuideModel}
                                                    ariaLabel="使用するモデル"
                                                    searchable
                                                    searchPlaceholder="モデル名・IDで検索"
                                                    searchAriaLabel="モデルを検索"
                                                    options={availableTextModels.map((model) => ({
                                                        value: model.id,
                                                        label: model.name,
                                                        detail: model.name !== model.id ? model.id : undefined,
                                                    }))}
                                                />
                                            )}
                                            <p className="ai-connection-help">
                                                既定モデルに設定されます。あとから変更できます。
                                            </p>
                                        </>
                                    )}
                                </div>
                            )}

                            {connectionState === 'error' && (
                                <div className="onboarding-status error" role="alert">
                                    <span>{connectionMessage}</span>
                                    <p>入力内容と接続先の起動状態を確認して、もう一度お試しください。</p>
                                </div>
                            )}

                            <div className="onboarding-actions">
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={onSkip}
                                    disabled={connectionBusy}
                                >
                                    初期設定をスキップ
                                </button>
                                {checkSucceeded ? (
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={applyModelAndAdvance}
                                        disabled={!selectedGuideModel.trim()}
                                    >
                                        次へ
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={() => void saveAndCheckConnection()}
                                        disabled={connectionBusy || (connection == null && connectionsError != null)}
                                    >
                                        {connectionState === 'checking' && <Loader2 size={16} className="animate-spin" />}
                                        {connectionState === 'checking'
                                            ? '保存・確認中…'
                                            : hasConnectionChanges
                                                ? '保存して接続確認'
                                                : '接続を確認'}
                                    </button>
                                )}
                            </div>
                        </>
                    ) : step === 'tts' ? (
                        <>
                            <div className="onboarding-heading">
                                <div>
                                    <p className="onboarding-step-label">3 / 4 · 音声読み上げ（任意）</p>
                                    <h1>AIの返答を音声で楽しむ</h1>
                                </div>
                            </div>
                            <p className="onboarding-lead">
                                音声合成エンジン「VOICEVOX」を使えば、AIの返答を音声で楽しむことができます。
                            </p>

                            {connectionsLoading && !voicevoxConnection ? (
                                <div className="ai-connection-card ai-connection-loading onboarding-connection-card" aria-live="polite">
                                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                                    AI接続設定を読み込んでいます…
                                </div>
                            ) : connectionsError && !voicevoxConnection ? (
                                <div className="onboarding-status error" role="alert">
                                    <span>{connectionsError}</span>
                                    <button type="button" onClick={() => void reloadConnections()}>
                                        再読み込み
                                    </button>
                                </div>
                            ) : (
                                <div className="ai-connection-card onboarding-connection-card">
                                    <p className="ai-connection-help">
                                        VOICEVOXエンジンを起動してから接続を確認してください。
                                        まだインストールしていない場合は
                                        <a href="https://voicevox.hiroshiba.jp/" target="_blank" rel="noreferrer">
                                            VOICEVOX公式サイト
                                        </a>
                                        から入手できます。
                                    </p>

                                    <label className="ai-connection-label" htmlFor="onboarding-tts-base-url">
                                        エンドポイント
                                    </label>
                                    <input
                                        id="onboarding-tts-base-url"
                                        className="input"
                                        type="url"
                                        value={ttsBaseUrl}
                                        disabled={ttsBusy || (voicevoxConnection != null && !voicevoxConnection.baseUrlEditable)}
                                        spellCheck={false}
                                        onChange={(event) => {
                                            setTtsBaseUrl(event.target.value);
                                            if (ttsChecked) setTtsChecked(false);
                                        }}
                                    />
                                    {voicevoxConnection != null && !voicevoxConnection.baseUrlEditable && (
                                        <p className="ai-connection-help">
                                            環境変数が設定されているため、変更できません。
                                        </p>
                                    )}

                                    {ttsChecked && (
                                        <>
                                            <p className="ai-connection-message success" role="status">
                                                VOICEVOXエンジンに接続しました。読み上げに使う声を選んでください。
                                            </p>
                                            <label className="ai-connection-label" htmlFor="onboarding-tts-voice">
                                                声
                                            </label>
                                            <TtsVoiceField
                                                id="onboarding-tts-voice"
                                                connectionId={ttsConnectionId}
                                                value={guideTtsVoice}
                                                onChange={setGuideTtsVoice}
                                                emptyLabel="あとで選ぶ"
                                            />
                                            <p className="ai-connection-help">
                                                「設定」→「モデル」→「音声合成（TTS）」でいつでも変更できます。
                                            </p>
                                        </>
                                    )}
                                </div>
                            )}

                            {ttsState === 'error' && (
                                <div className="onboarding-status error" role="alert">
                                    <span>{ttsMessage}</span>
                                    <p>VOICEVOXエンジンの起動状態とエンドポイントを確認して、もう一度お試しください。</p>
                                </div>
                            )}

                            <div className="onboarding-actions">
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={() => setStep('character')}
                                    disabled={ttsBusy}
                                >
                                    いいえ、結構です
                                </button>
                                {ttsChecked ? (
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={applyTtsAndAdvance}
                                    >
                                        次へ
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        onClick={() => void checkVoicevoxConnection()}
                                        disabled={ttsBusy || (voicevoxConnection == null && connectionsError != null)}
                                    >
                                        {ttsState === 'checking' && <Loader2 size={16} className="animate-spin" />}
                                        {ttsState === 'checking'
                                            ? '保存・確認中…'
                                            : ttsBaseChanged
                                                ? '保存して接続確認'
                                                : '接続を確認'}
                                    </button>
                                )}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="onboarding-heading">
                                <div>
                                    <p className="onboarding-step-label">4 / 4 · 話す相手を作る</p>
                                    <h1>キャラクターについて教えてください</h1>
                                </div>
                            </div>
                            <p className="onboarding-lead">
                                簡単に設定を書くだけで始められます。あとから変更できます。
                            </p>

                            <div className="onboarding-form">
                                <label>
                                    <span>名前</span>
                                    <input
                                        type="text"
                                        className="input"
                                        value={name}
                                        onChange={(event) => setName(event.target.value)}
                                        placeholder="例：ミナ"
                                        autoFocus
                                    />
                                </label>
                                <label>
                                    <span>どんなキャラクター？</span>
                                    <textarea
                                        className="input textarea"
                                        value={description}
                                        onChange={(event) => setDescription(event.target.value)}
                                        placeholder="例：明るくて面倒見のよい先輩。少しくだけた話し方をする。"
                                        rows={4}
                                    />
                                </label>
                                <label>
                                    <span>あなたとの関係 <small>任意</small></span>
                                    <textarea
                                        className="input textarea"
                                        value={relationship}
                                        onChange={(event) => setRelationship(event.target.value)}
                                        placeholder="例：同じ学校に通う幼なじみ"
                                        rows={3}
                                    />
                                </label>
                            </div>

                            <button
                                type="button"
                                className="btn btn-secondary onboarding-generate"
                                onClick={generateCharacter}
                                disabled={isGenerating}
                            >
                                {isGenerating ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                {isGenerating ? '考えています…' : 'AIに考えてもらう'}
                            </button>
                            {generationError && <p className="onboarding-generation-error" role="alert">{generationError}</p>}

                            <div className="onboarding-actions">
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={onSkip}
                                    disabled={isGenerating}
                                >
                                    今はしない
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={startConversation}
                                    disabled={!name.trim() || isGenerating}
                                >
                                    <CheckCircle2 size={16} />
                                    この相手と話す
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </section>
    );
}
