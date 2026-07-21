import { useState } from 'react';
import { ArrowLeft, CheckCircle2, Cloud, Cpu, Loader2, Menu, Sparkles } from 'lucide-react';
import {
    formatGeneratedCharacterPrompt,
    formatGeneratedProtagonistPrompt,
    normalizeGeneratedCharacterProfile,
} from '@/lib/characterGeneration';
import { useStore, type AiProvider } from '@/lib/store';

interface FirstRunGuideProps {
    onOpenSidebar: () => void;
    onComplete: () => void;
    onSkip: () => void;
}

type GuideStep = 'connection' | 'character';
type ConnectionState = 'idle' | 'checking' | 'error';

interface ConnectionStatusResponse {
    ready?: boolean;
    message?: string;
}

const PROVIDER_OPTIONS: readonly {
    id: AiProvider;
    title: string;
    description: string;
    Icon: typeof Cloud;
}[] = [
    {
        id: 'openrouter',
        title: 'OpenRouter',
        description: 'OpenRouterを使います。いろいろなAIから選べます。',
        Icon: Cloud,
    },
    {
        id: 'openai-compatible',
        title: 'OpenAI Completions 互換API',
        description: '上級者向け: 他のプロパイダーに接続します。',
        Icon: Cpu,
    },
];

export default function FirstRunGuide({ onOpenSidebar, onComplete, onSkip }: FirstRunGuideProps) {
    const {
        aiProvider,
        setAiProvider,
        getAiProviderConfig,
        defaultChatModel,
        defaultAutoGenerationModel,
        createCharacter,
        createRoom,
    } = useStore();
    const [step, setStep] = useState<GuideStep>('connection');
    const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
    const [connectionMessage, setConnectionMessage] = useState('');
    const [showConnectionHelp, setShowConnectionHelp] = useState(false);
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [relationship, setRelationship] = useState('');
    const [isGenerating, setGenerating] = useState(false);
    const [generationError, setGenerationError] = useState('');

    const selectProvider = (provider: AiProvider) => {
        setAiProvider(provider);
        setConnectionState('idle');
        setConnectionMessage('');
        setShowConnectionHelp(false);
    };

    const checkConnection = async () => {
        if (connectionState === 'checking') return;
        setConnectionState('checking');
        setConnectionMessage('');
        setShowConnectionHelp(false);

        try {
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
                <div className="onboarding-card">
                    <div className={`onboarding-navigation ${step === 'character' ? 'has-back' : ''}`}>
                        {step === 'character' && (
                            <button
                                type="button"
                                className="btn btn-ghost onboarding-back"
                                onClick={() => setStep('connection')}
                                aria-label="前へ戻る"
                                title="前へ戻る"
                            >
                                <ArrowLeft size={19} />
                            </button>
                        )}
                        <div
                            className={`onboarding-progress ${step === 'character' ? 'has-completed-step' : ''}`}
                            role="progressbar"
                            aria-label={step === 'connection' ? '1 / 2' : '2 / 2'}
                            aria-valuemin={0}
                            aria-valuemax={2}
                            aria-valuenow={step === 'connection' ? 0 : 1}
                        >
                            <span className="onboarding-progress-fill" />
                        </div>
                    </div>

                    {step === 'connection' ? (
                        <>
                            <div className="onboarding-heading">
                                <div>
                                    <p className="onboarding-step-label">1 / 2 · 会話の準備</p>
                                    <h1>Kataruへようこそ</h1>
                                </div>
                            </div>
                            <p className="onboarding-lead">
                                AIキャラクターと自由に会話しましょう。まず、会話に使うプロパイダーを選んでください。
                            </p>

                            <div className="onboarding-provider-list" role="radiogroup" aria-label="会話に使うAI">
                                {PROVIDER_OPTIONS.map(({ id, title, description: optionDescription, Icon }) => {
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
                                            <span className="onboarding-provider-icon"><Icon size={20} /></span>
                                            <span className="onboarding-provider-copy">
                                                <span className="onboarding-provider-title">{title}</span>
                                                <span className="onboarding-provider-description">{optionDescription}</span>
                                            </span>
                                            <span className="onboarding-radio" aria-hidden="true">
                                                {selected && <span />}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>

                            <p className="onboarding-note">
                                会話データはこのパソコンに保存されます。
                            </p>

                            {connectionState === 'error' && (
                                <div className="onboarding-status error" role="alert">
                                    <span>{connectionMessage}</span>
                                    <button type="button" onClick={() => setShowConnectionHelp((show) => !show)}>
                                        {showConnectionHelp ? '設定方法を閉じる' : '設定方法を見る'}
                                    </button>
                                    {showConnectionHelp && (
                                        <p>
                                            {aiProvider === 'openrouter'
                                                ? 'APIキーが設定されていないようです。OPENROUTER_API_KEY を設定し、Kataruを再起動してください。'
                                                : 'OpenAI Completions 互換APIに接続できません。接続先を変える場合は、Kataruを起動する前に OPENAI_COMPAT_BASE_URL を設定します。'}
                                        </p>
                                    )}
                                </div>
                            )}

                            <div className="onboarding-actions">
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    onClick={onSkip}
                                    disabled={connectionState === 'checking'}
                                >
                                    初期設定をスキップ
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={checkConnection}
                                    disabled={connectionState === 'checking'}
                                >
                                    {connectionState === 'checking' && <Loader2 size={16} className="animate-spin" />}
                                    {connectionState === 'error' ? 'もう一度確認' : '次へ'}
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="onboarding-heading">
                                <div>
                                    <p className="onboarding-step-label">2 / 2 · 話す相手を作る</p>
                                    <h1>誰と話しますか？</h1>
                                </div>
                            </div>
                            <p className="onboarding-lead">
                                名前と、性格や話し方を簡単に書くだけで始められます。あとから変更できます。
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
