import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, Menu, Sparkles } from 'lucide-react';
import {
    formatGeneratedCharacterPrompt,
    formatGeneratedProtagonistPrompt,
    normalizeGeneratedCharacterProfile,
} from '@/lib/characterGeneration';
import {
    getServerAiConfig,
    setAnthropicConfig,
    setOpenAiConfig,
    setOpenRouterApiKey,
    type ServerAiConfigStatus,
} from '@/lib/serverAiConfig';
import {
    DEFAULT_ANTHROPIC_BASE_URL,
    DEFAULT_ANTHROPIC_TEXT_MODEL,
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
} from '@/lib/aiProvider';
import { useStore, type AiProvider } from '@/lib/store';

interface FirstRunGuideProps {
    onOpenSidebar: () => void;
    onComplete: () => void;
    onSkip: () => void;
}

type GuideStep = 'provider' | 'connection' | 'character';
type ConnectionState = 'idle' | 'checking' | 'error';

interface ConnectionStatusResponse {
    ready?: boolean;
    message?: string;
}

const PROVIDER_OPTIONS: readonly {
    id: AiProvider;
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
        aiProvider,
        setAiProvider,
        getAiProviderConfig,
        defaultChatModel,
        defaultAutoGenerationModel,
        setDefaultChatModel,
        setDefaultDirectorModel,
        setDefaultAutoGenerationModel,
        setTitleGenerationModel,
        setSummaryModel,
        setMemoryExtractionModel,
        createCharacter,
        createRoom,
    } = useStore();
    const [step, setStep] = useState<GuideStep>('provider');
    const [serverConfig, setServerConfig] = useState<ServerAiConfigStatus | null>(null);
    const [configLoading, setConfigLoading] = useState(false);
    const [configLoadAttempt, setConfigLoadAttempt] = useState(0);
    const [configError, setConfigError] = useState('');
    const [openRouterApiKey, setOpenRouterApiKeyInput] = useState('');
    const [openAiBaseUrl, setOpenAiBaseUrl] = useState('');
    const [openAiApiKey, setOpenAiApiKeyInput] = useState('');
    const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('');
    const [anthropicApiKey, setAnthropicApiKeyInput] = useState('');
    const [anthropicModel, setAnthropicModel] = useState(
        defaultChatModel.startsWith('claude-') ? defaultChatModel : DEFAULT_ANTHROPIC_TEXT_MODEL,
    );
    const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
    const [connectionMessage, setConnectionMessage] = useState('');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [relationship, setRelationship] = useState('');
    const [isGenerating, setGenerating] = useState(false);
    const [generationError, setGenerationError] = useState('');

    useEffect(() => {
        if (step !== 'connection') return;

        let cancelled = false;
        setConfigLoading(true);
        setConfigError('');
        setConnectionState('idle');
        setConnectionMessage('');

        void getServerAiConfig()
            .then((status) => {
                if (cancelled) return;
                setServerConfig(status);
                setOpenAiBaseUrl(status.openai.baseUrl);
                setAnthropicBaseUrl(status.anthropic.baseUrl);
                setOpenRouterApiKeyInput('');
                setOpenAiApiKeyInput('');
                setAnthropicApiKeyInput('');
            })
            .catch((error) => {
                if (cancelled) return;
                setServerConfig(null);
                setConfigError(error instanceof Error ? error.message : 'AI接続設定を読み込めませんでした。');
            })
            .finally(() => {
                if (!cancelled) setConfigLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [aiProvider, configLoadAttempt, step]);

    const selectProvider = (provider: AiProvider) => {
        setAiProvider(provider);
        setConnectionState('idle');
        setConnectionMessage('');
    };

    const saveAndCheckConnection = async () => {
        if (connectionState === 'checking' || !serverConfig) return;

        const trimmedOpenRouterKey = openRouterApiKey.trim();
        const trimmedOpenAiKey = openAiApiKey.trim();
        const trimmedOpenAiBaseUrl = openAiBaseUrl.trim().replace(/\/+$/, '');
        const openAiBaseChanged = trimmedOpenAiBaseUrl !== serverConfig.openai.baseUrl;
        const trimmedAnthropicKey = anthropicApiKey.trim();
        const trimmedAnthropicBaseUrl = anthropicBaseUrl.trim().replace(/\/+$/, '');
        const anthropicBaseChanged = trimmedAnthropicBaseUrl !== serverConfig.anthropic.baseUrl;
        const trimmedAnthropicModel = anthropicModel.trim();

        if (aiProvider === 'openrouter' && !serverConfig.openrouter.configured && !trimmedOpenRouterKey) {
            setConnectionState('error');
            setConnectionMessage('OpenRouter APIキーを入力してください。');
            return;
        }
        if (
            aiProvider === 'openai-compatible'
            && !trimmedOpenAiBaseUrl
            && serverConfig.openai.baseUrlEditable
        ) {
            setConnectionState('error');
            setConnectionMessage('エンドポイントを入力してください。');
            return;
        }
        if (
            aiProvider === 'anthropic'
            && !trimmedAnthropicBaseUrl
            && serverConfig.anthropic.baseUrlEditable
        ) {
            setConnectionState('error');
            setConnectionMessage('エンドポイントを入力してください。');
            return;
        }
        if (aiProvider === 'anthropic' && !trimmedAnthropicModel) {
            setConnectionState('error');
            setConnectionMessage('Anthropicで使用するモデルIDを入力してください。');
            return;
        }
        if (
            aiProvider === 'anthropic'
            && (!serverConfig.anthropic.apiKey.configured || anthropicBaseChanged)
            && !trimmedAnthropicKey
        ) {
            setConnectionState('error');
            setConnectionMessage('Anthropic APIキーを入力してください。');
            return;
        }
        if (
            aiProvider === 'openai-compatible'
            && trimmedOpenAiBaseUrl === DEFAULT_OPENAI_COMPATIBLE_BASE_URL
            && (!serverConfig.openai.apiKey.configured || openAiBaseChanged)
            && !trimmedOpenAiKey
        ) {
            setConnectionState('error');
            setConnectionMessage('OpenAI公式APIを使うにはAPIキーを入力してください。');
            return;
        }

        setConnectionState('checking');
        setConnectionMessage('');

        try {
            let nextServerConfig = serverConfig;
            if (aiProvider === 'openrouter' && serverConfig.openrouter.editable && trimmedOpenRouterKey) {
                nextServerConfig = await setOpenRouterApiKey(trimmedOpenRouterKey);
            } else if (aiProvider === 'openai-compatible') {
                const update = {
                    ...(serverConfig.openai.baseUrlEditable && openAiBaseChanged
                        ? { baseUrl: trimmedOpenAiBaseUrl }
                        : {}),
                    ...(serverConfig.openai.apiKey.editable && trimmedOpenAiKey
                        ? { apiKey: trimmedOpenAiKey }
                        : {}),
                };
                if (Object.keys(update).length > 0) {
                    nextServerConfig = await setOpenAiConfig(update);
                }
            } else if (aiProvider === 'anthropic') {
                const update = {
                    ...(serverConfig.anthropic.baseUrlEditable && anthropicBaseChanged
                        ? { baseUrl: trimmedAnthropicBaseUrl }
                        : {}),
                    ...(serverConfig.anthropic.apiKey.editable && trimmedAnthropicKey
                        ? { apiKey: trimmedAnthropicKey }
                        : {}),
                };
                if (Object.keys(update).length > 0) {
                    nextServerConfig = await setAnthropicConfig(update);
                }
                setDefaultChatModel(trimmedAnthropicModel);
                setDefaultDirectorModel(trimmedAnthropicModel);
                setDefaultAutoGenerationModel(trimmedAnthropicModel);
                setTitleGenerationModel(trimmedAnthropicModel);
                setSummaryModel(trimmedAnthropicModel);
                setMemoryExtractionModel(trimmedAnthropicModel);
            }

            setServerConfig(nextServerConfig);
            setOpenAiBaseUrl(nextServerConfig.openai.baseUrl);
            setAnthropicBaseUrl(nextServerConfig.anthropic.baseUrl);
            setOpenRouterApiKeyInput('');
            setOpenAiApiKeyInput('');
            setAnthropicApiKeyInput('');

            const response = await fetch('/api/ai/status', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aiProviderConfig: getAiProviderConfig() }),
            });
            const data = await response.json().catch(() => ({})) as ConnectionStatusResponse;
            if (!response.ok) {
                throw new Error(data.message || `接続の確認に失敗しました (${response.status})`);
            }
            if (data.ready === true) {
                setStep('character');
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
                    model: defaultAutoGenerationModel,
                    aiProviderConfig: getAiProviderConfig(),
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
            protagonistPrompt: relationship.trim() || undefined,
        });
        createRoom(characterId);
        onComplete();
    };

    const stepNumber = step === 'provider' ? 1 : step === 'connection' ? 2 : 3;
    const selectedApiKeyStatus = serverConfig
        ? aiProvider === 'openrouter'
            ? serverConfig.openrouter
            : aiProvider === 'anthropic'
                ? serverConfig.anthropic.apiKey
                : serverConfig.openai.apiKey
        : null;
    const openAiBaseChanged = serverConfig != null
        && openAiBaseUrl.trim().replace(/\/+$/, '') !== serverConfig.openai.baseUrl;
    const anthropicBaseChanged = serverConfig != null
        && anthropicBaseUrl.trim().replace(/\/+$/, '') !== serverConfig.anthropic.baseUrl;
    const hasConnectionChanges = aiProvider === 'openrouter'
        ? openRouterApiKey.trim().length > 0
        : aiProvider === 'anthropic'
            ? anthropicBaseChanged
                || anthropicApiKey.trim().length > 0
                || anthropicModel.trim() !== defaultChatModel
            : openAiBaseChanged || openAiApiKey.trim().length > 0;
    const connectionBusy = configLoading || connectionState === 'checking';
    const providerLabel = aiProvider === 'openrouter'
        ? 'OpenRouter'
        : aiProvider === 'anthropic'
            ? 'Anthropic / 互換API'
            : 'OpenAI / 互換API';

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
                <span style={{ fontWeight: 500 }}>Kataru</span>
                <div style={{ width: 36 }} />
            </div>

            <div className="onboarding-scroll">
                <div className={`onboarding-card ${step !== 'character' ? 'is-connection-step' : ''}`}>
                    <div className="onboarding-navigation">
                        {step !== 'provider' ? (
                            <button
                                type="button"
                                className="btn btn-ghost onboarding-back"
                                onClick={() => setStep(step === 'character' ? 'connection' : 'provider')}
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
                            aria-label={`${stepNumber} / 3`}
                            aria-valuemin={1}
                            aria-valuemax={3}
                            aria-valuenow={stepNumber}
                        >
                            <span className="onboarding-progress-fill" />
                        </div>
                    </div>

                    {step === 'provider' ? (
                        <>
                            <div className="onboarding-heading">
                                <div>
                                    <p className="onboarding-step-label">1 / 3 · プロパイダーを選ぶ</p>
                                    <h1>Kataruへようこそ</h1>
                                </div>
                            </div>
                            <p className="onboarding-lead">
                                AIキャラクターと話しましょう。プロパイダーを選んでください。
                            </p>

                            <div className="onboarding-provider-list" role="radiogroup" aria-label="会話に使うAI">
                                {PROVIDER_OPTIONS.map(({ id, title}) => {
                                    const selected = aiProvider === id;
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            role="radio"
                                            aria-checked={selected}
                                            className={`onboarding-provider ${selected ? 'selected' : ''}`}
                                            onClick={() => selectProvider(id)}
                                        >
                                            <span className="onboarding-provider-copy">
                                                <span className="onboarding-provider-title">{title}</span>
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
                                    <p className="onboarding-step-label">2 / 3 · 接続設定</p>
                                    <h1>
                                        {aiProvider === 'openrouter'
                                            ? 'OpenRouterを設定'
                                            : aiProvider === 'anthropic'
                                                ? 'Claude API'
                                                : 'OpenAI API'}
                                    </h1>
                                </div>
                            </div>
                            <p className="onboarding-lead">
                                {aiProvider === 'openrouter'
                                    ? 'OpenRouterのAPIキーを保存して、会話できるか確認します。'
                                    : aiProvider === 'anthropic'
                                        ? 'Claude APIまたは互換APIのエンドポイントとAPIキーを設定します。'
                                        : 'OpenAI APIまたは互換APIのエンドポイントとAPIキーを設定します。'}
                            </p>

                            {configLoading ? (
                                <div className="ai-connection-card ai-connection-loading onboarding-connection-card" aria-live="polite">
                                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                                    AI接続設定を読み込んでいます…
                                </div>
                            ) : !serverConfig ? (
                                <div className="onboarding-status error" role="alert">
                                    <span>{configError || 'AI接続設定を読み込めませんでした。'}</span>
                                    <button type="button" onClick={() => setConfigLoadAttempt((attempt) => attempt + 1)}>
                                        再読み込み
                                    </button>
                                </div>
                            ) : (
                                <div className="ai-connection-card onboarding-connection-card">

                                    {!serverConfig.secretStoreAvailable && !selectedApiKeyStatus?.configured && (
                                        <p className="ai-connection-message error" role="alert">
                                            OSの資格情報ストアを利用できません。環境変数でAPIキーを設定してください。
                                        </p>
                                    )}

                                    {aiProvider === 'openrouter' ? (
                                        <>
                                            <label className="ai-connection-label" htmlFor="onboarding-openrouter-api-key">
                                                APIキー
                                            </label>
                                            <input
                                                id="onboarding-openrouter-api-key"
                                                className="input"
                                                type="password"
                                                value={openRouterApiKey}
                                                disabled={!serverConfig.openrouter.editable || connectionBusy}
                                                autoComplete="new-password"
                                                spellCheck={false}
                                                autoFocus={serverConfig.openrouter.editable && !serverConfig.openrouter.configured}
                                                placeholder={serverConfig.openrouter.configured
                                                    ? '変更する場合のみ入力'
                                                    : 'OpenRouter APIキーを入力'}
                                                onChange={(event) => setOpenRouterApiKeyInput(event.target.value)}
                                            />
                                            {!serverConfig.openrouter.editable && (
                                                <p className="ai-connection-help">
                                                    環境変数 OPENROUTER_API_KEY が設定されているため、変更できません。
                                                </p>
                                            )}
                                        </>
                                    ) : aiProvider === 'anthropic' ? (
                                        <>
                                            <label className="ai-connection-label" htmlFor="onboarding-anthropic-base-url">
                                                エンドポイント
                                            </label>
                                            <input
                                                id="onboarding-anthropic-base-url"
                                                className="input"
                                                type="url"
                                                value={anthropicBaseUrl}
                                                disabled={!serverConfig.anthropic.baseUrlEditable || connectionBusy}
                                                spellCheck={false}
                                                placeholder={DEFAULT_ANTHROPIC_BASE_URL}
                                                onChange={(event) => setAnthropicBaseUrl(event.target.value)}
                                            />
                                            <p className="ai-connection-help">
                                                {!serverConfig.anthropic.baseUrlEditable && '環境変数 ANTHROPIC_BASE_URL またはANTHROPIC_API_KEY が設定されているため、変更できません。'}
                                            </p>
                                            {anthropicBaseChanged && serverConfig.anthropic.apiKey.configured && (
                                                <p className="ai-connection-help warning">
                                                    接続先を変更すると、現在保存されているAPIキーは解除されます。
                                                </p>
                                            )}

                                            <label className="ai-connection-label" htmlFor="onboarding-anthropic-api-key">
                                                APIキー
                                            </label>
                                            <input
                                                id="onboarding-anthropic-api-key"
                                                className="input"
                                                type="password"
                                                value={anthropicApiKey}
                                                disabled={!serverConfig.anthropic.apiKey.editable || connectionBusy}
                                                autoComplete="new-password"
                                                spellCheck={false}
                                                autoFocus={serverConfig.anthropic.apiKey.editable && !serverConfig.anthropic.apiKey.configured}
                                                placeholder={serverConfig.anthropic.apiKey.configured
                                                    ? '変更する場合のみ入力'
                                                    : 'Anthropic APIキーを入力'}
                                                onChange={(event) => setAnthropicApiKeyInput(event.target.value)}
                                            />
                                            {!serverConfig.anthropic.apiKey.editable && (
                                                <p className="ai-connection-help">
                                                    環境変数 ANTHROPIC_API_KEY が設定されているため、変更できません。
                                                </p>
                                            )}

                                            <label className="ai-connection-label" htmlFor="onboarding-anthropic-model">
                                                使用するモデル
                                            </label>
                                            <input
                                                id="onboarding-anthropic-model"
                                                className="input"
                                                type="text"
                                                value={anthropicModel}
                                                disabled={connectionBusy}
                                                spellCheck={false}
                                                placeholder={DEFAULT_ANTHROPIC_TEXT_MODEL}
                                                onChange={(event) => setAnthropicModel(event.target.value)}
                                            />
                                            <p className="ai-connection-help">
                                                既定モデルに設定されます。あとから変更できます。
                                            </p>
                                        </>
                                    ) : (
                                        <>
                                            <label className="ai-connection-label" htmlFor="onboarding-openai-base-url">
                                                エンドポイント
                                            </label>
                                            <input
                                                id="onboarding-openai-base-url"
                                                className="input"
                                                type="url"
                                                value={openAiBaseUrl}
                                                disabled={!serverConfig.openai.baseUrlEditable || connectionBusy}
                                                spellCheck={false}
                                                placeholder={DEFAULT_OPENAI_COMPATIBLE_BASE_URL}
                                                onChange={(event) => setOpenAiBaseUrl(event.target.value)}
                                            />
                                            <p className="ai-connection-help">
                                                {!serverConfig.openai.baseUrlEditable && '環境変数 OPENAI_BASE_URL またはOPENAI_API_KEY が設定されているため、変更できません。'}
                                            </p>
                                            {openAiBaseChanged && serverConfig.openai.apiKey.configured && (
                                                <p className="ai-connection-help warning">
                                                    接続先を変更すると、現在保存されているAPIキーは解除されます。
                                                </p>
                                            )}

                                            <label className="ai-connection-label" htmlFor="onboarding-openai-api-key">
                                                APIキー
                                            </label>
                                            <input
                                                id="onboarding-openai-api-key"
                                                className="input"
                                                type="password"
                                                value={openAiApiKey}
                                                disabled={!serverConfig.openai.apiKey.editable || connectionBusy}
                                                autoComplete="new-password"
                                                spellCheck={false}
                                                placeholder={serverConfig.openai.apiKey.configured
                                                    ? '変更する場合のみ入力'
                                                    : 'APIキーを入力（ローカルAPIでは省略可）'}
                                                onChange={(event) => setOpenAiApiKeyInput(event.target.value)}
                                            />
                                            {!serverConfig.openai.apiKey.editable && (
                                                <p className="ai-connection-help">
                                                    環境変数 OPENAI_API_KEY が設定されているため、変更できません。
                                                </p>
                                            )}
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
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={() => void saveAndCheckConnection()}
                                    disabled={!serverConfig || connectionBusy}
                                >
                                    {connectionState === 'checking' && <Loader2 size={16} className="animate-spin" />}
                                    {connectionState === 'checking'
                                        ? '保存・確認中…'
                                        : hasConnectionChanges
                                            ? '保存して接続確認'
                                            : '接続を確認'}
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="onboarding-heading">
                                <div>
                                    <p className="onboarding-step-label">3 / 3 · 話す相手を作る</p>
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
