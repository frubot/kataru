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
    type AiConnectionKind,
} from '@/lib/aiApi';
import {
    updateAiConnection,
    useAiConnections,
    type UpdateAiConnectionInput,
} from '@/lib/aiConnections';
import { modelRefsEqual, serializeModelRef } from '@/lib/modelDefaults';
import { useStore } from '@/lib/store';

interface FirstRunGuideProps {
    onOpenSidebar: () => void;
    onComplete: () => void;
    onSkip: () => void;
}

type GuideStep = 'api-type' | 'connection' | 'character';
type ConnectionState = 'idle' | 'checking' | 'error';

interface ConnectionStatusResponse {
    ready?: boolean;
    message?: string;
}

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

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
        setSummaryModel,
        setMemoryExtractionModel,
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
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [anthropicModel, setAnthropicModel] = useState(DEFAULT_ANTHROPIC_TEXT_MODEL);
    const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
    const [connectionMessage, setConnectionMessage] = useState('');
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [speechStyle, setSpeechStyle] = useState('');
    const [relationship, setRelationship] = useState('');
    const [isGenerating, setGenerating] = useState(false);
    const [generationError, setGenerationError] = useState('');

    const connection = connections.find((candidate) => candidate.id === selectedConnectionId) ?? null;

    useEffect(() => {
        if (step !== 'connection') return;
        setConnectionState('idle');
        setConnectionMessage('');
        setApiKey('');
        setBaseUrl(connection?.baseUrl ?? '');
        setAnthropicModel(
            defaultChatModel.connectionId === 'anthropic' && defaultChatModel.model.startsWith('claude-')
                ? defaultChatModel.model
                : DEFAULT_ANTHROPIC_TEXT_MODEL,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, connection?.id, connection?.baseUrl]);

    const selectConnection = (connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setConnectionState('idle');
        setConnectionMessage('');
    };

    const saveAndCheckConnection = async () => {
        if (connectionState === 'checking' || !connection) return;

        const kind = connection.kind;
        const trimmedApiKey = apiKey.trim();
        const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
        const baseChanged = connection.baseUrlEditable
            && trimmedBaseUrl !== (connection.baseUrl ?? '');
        const trimmedAnthropicModel = anthropicModel.trim();

        if (kind === 'openrouter' && !connection.apiKey.configured && !trimmedApiKey) {
            setConnectionState('error');
            setConnectionMessage('OpenRouter APIキーを入力してください。');
            return;
        }
        if (kind !== 'openrouter' && connection.baseUrlEditable && !trimmedBaseUrl) {
            setConnectionState('error');
            setConnectionMessage('エンドポイントを入力してください。');
            return;
        }
        if (kind === 'anthropic' && !trimmedAnthropicModel) {
            setConnectionState('error');
            setConnectionMessage('Anthropicで使用するモデルIDを入力してください。');
            return;
        }
        if (
            kind === 'anthropic'
            && (!connection.apiKey.configured || baseChanged)
            && !trimmedApiKey
        ) {
            setConnectionState('error');
            setConnectionMessage('Anthropic APIキーを入力してください。');
            return;
        }
        if (
            kind === 'openai-compatible'
            && trimmedBaseUrl === OPENAI_DEFAULT_BASE_URL
            && (!connection.apiKey.configured || baseChanged)
            && !trimmedApiKey
        ) {
            setConnectionState('error');
            setConnectionMessage('OpenAI公式APIを使うにはAPIキーを入力してください。');
            return;
        }

        setConnectionState('checking');
        setConnectionMessage('');

        try {
            const update: UpdateAiConnectionInput = {};
            if (baseChanged) update.baseUrl = trimmedBaseUrl;
            if (connection.apiKey.editable && trimmedApiKey) update.apiKey = trimmedApiKey;
            if (Object.keys(update).length > 0) {
                await updateAiConnection(connection.id, update);
            }
            if (kind === 'anthropic') {
                const modelRef = { connectionId: connection.id, model: trimmedAnthropicModel };
                setDefaultChatModel(modelRef);
                setDefaultDirectorModel(modelRef);
                setDefaultAutoGenerationModel(modelRef);
                setTitleGenerationModel(modelRef);
                setSummaryModel(modelRef);
                setMemoryExtractionModel(modelRef);
            }
            setApiKey('');

            const response = await fetch('/api/ai/status', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    aiApiConfig: { ...getAiApiConfig(), connectionId: connection.id },
                }),
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

    const stepNumber = step === 'api-type' ? 1 : step === 'connection' ? 2 : 3;
    const connectionKind = connection?.kind ?? 'openrouter';
    const baseChanged = connection != null
        && connection.baseUrlEditable
        && baseUrl.trim().replace(/\/+$/, '') !== (connection.baseUrl ?? '');
    const hasConnectionChanges = connection == null
        ? false
        : connectionKind === 'openrouter'
            ? apiKey.trim().length > 0
            : connectionKind === 'anthropic'
                ? baseChanged
                    || apiKey.trim().length > 0
                    || !modelRefsEqual(defaultChatModel, {
                        connectionId: connection.id,
                        model: anthropicModel.trim(),
                    })
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
                <span style={{ fontWeight: 500 }}>Kataru</span>
                <div style={{ width: 36 }} />
            </div>

            <div className="onboarding-scroll">
                <div className={`onboarding-card ${step !== 'character' ? 'is-connection-step' : ''}`}>
                    <div className="onboarding-navigation">
                        {step !== 'api-type' ? (
                            <button
                                type="button"
                                className="btn btn-ghost onboarding-back"
                                onClick={() => setStep(step === 'character' ? 'connection' : 'api-type')}
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
                        <span className="onboarding-back-placeholder" aria-hidden="true" />
                    </div>

                    {step === 'api-type' ? (
                        <>
                            <div className="onboarding-heading">
                                <div>
                                    <p className="onboarding-step-label">1 / 3 · APIの種類を選ぶ</p>
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
                                    <p className="onboarding-step-label">2 / 3 · 接続設定</p>
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
                            ) : !connection ? (
                                <div className="onboarding-status error" role="alert">
                                    <span>{connectionsError || 'AI接続設定を読み込めませんでした。'}</span>
                                    <button type="button" onClick={() => void reloadConnections()}>
                                        再読み込み
                                    </button>
                                </div>
                            ) : (
                                <div className="ai-connection-card onboarding-connection-card">

                                    {!secretStoreAvailable && !connection.apiKey.configured && (
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
                                                disabled={!connection.baseUrlEditable || connectionBusy}
                                                spellCheck={false}
                                                onChange={(event) => setBaseUrl(event.target.value)}
                                            />
                                            {!connection.baseUrlEditable && (
                                                <p className="ai-connection-help">
                                                    環境変数が設定されているため、変更できません。
                                                </p>
                                            )}
                                            {baseChanged && connection.apiKey.configured && (
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
                                        disabled={!connection.apiKey.editable || connectionBusy}
                                        autoComplete="new-password"
                                        spellCheck={false}
                                        autoFocus={connection.apiKey.editable && !connection.apiKey.configured}
                                        placeholder={connection.apiKey.configured
                                            ? '変更する場合のみ入力'
                                            : connectionKind === 'openai-compatible'
                                                ? 'APIキーを入力（ローカルAPIでは省略可）'
                                                : `${AI_CONNECTION_KIND_LABELS[connectionKind]} APIキーを入力`}
                                        onChange={(event) => setApiKey(event.target.value)}
                                    />
                                    {!connection.apiKey.editable && (
                                        <p className="ai-connection-help">
                                            環境変数が設定されているため、変更できません。
                                        </p>
                                    )}

                                    {connectionKind === 'anthropic' && (
                                        <>
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
                                    disabled={!connection || connectionBusy}
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
