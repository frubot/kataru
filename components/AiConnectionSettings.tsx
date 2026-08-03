import { useCallback, useEffect, useState } from 'react';
import { KeyRound, RefreshCw, Save, Trash2 } from 'lucide-react';

import type { AiProvider } from '@/lib/aiProvider';
import {
    deleteAnthropicApiKey,
    deleteOpenAiApiKey,
    deleteOpenRouterApiKey,
    getServerAiConfig,
    setAnthropicConfig,
    setOpenAiConfig,
    setOpenRouterApiKey,
    type AiConfigSource,
    type ServerAiConfigStatus,
} from '@/lib/serverAiConfig';

interface AiConnectionSettingsProps {
    provider: AiProvider;
}


export default function AiConnectionSettings({ provider }: AiConnectionSettingsProps) {
    const [status, setStatus] = useState<ServerAiConfigStatus | null>(null);
    const [openRouterApiKey, setOpenRouterApiKeyInput] = useState('');
    const [openAiBaseUrl, setOpenAiBaseUrl] = useState('');
    const [openAiApiKey, setOpenAiApiKeyInput] = useState('');
    const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('');
    const [anthropicApiKey, setAnthropicApiKeyInput] = useState('');
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const applyStatus = useCallback((next: ServerAiConfigStatus) => {
        setStatus(next);
        setOpenAiBaseUrl(next.openai.baseUrl);
        setAnthropicBaseUrl(next.anthropic.baseUrl);
        setOpenRouterApiKeyInput('');
        setOpenAiApiKeyInput('');
        setAnthropicApiKeyInput('');
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            applyStatus(await getServerAiConfig());
        } catch (caught) {
            setStatus(null);
            setError(caught instanceof Error ? caught.message : 'AI接続設定を読み込めませんでした。');
        } finally {
            setLoading(false);
        }
    }, [applyStatus]);

    useEffect(() => {
        void load();
    }, [load]);

    const runUpdate = async (
        operation: () => Promise<ServerAiConfigStatus>,
        successMessage: string,
    ) => {
        if (saving) return;
        setSaving(true);
        setError(null);
        setMessage(null);
        try {
            applyStatus(await operation());
            setMessage(successMessage);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'AI接続設定を更新できませんでした。');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="ai-connection-card ai-connection-loading" aria-live="polite">
                <RefreshCw size={16} className="spin" aria-hidden="true" />
                AI接続設定を読み込んでいます…
            </div>
        );
    }

    if (!status) {
        return (
            <div className="ai-connection-card">
                <p className="ai-connection-message error" role="alert">{error}</p>
                <button type="button" className="btn btn-secondary" onClick={() => void load()}>
                    再読み込み
                </button>
            </div>
        );
    }

    const selectedApiKeyStatus = provider === 'openrouter'
        ? status.openrouter
        : provider === 'anthropic'
            ? status.anthropic.apiKey
            : status.openai.apiKey;
    const providerLabel = provider === 'openrouter'
        ? 'OpenRouter'
        : provider === 'anthropic'
            ? 'Anthropic / 互換API'
            : 'OpenAI / 互換API';
    const openAiBaseChanged = openAiBaseUrl.trim() !== status.openai.baseUrl;
    const canSaveOpenAi = (status.openai.baseUrlEditable && openAiBaseChanged)
        || (status.openai.apiKey.editable && openAiApiKey.trim().length > 0);
    const anthropicBaseChanged = anthropicBaseUrl.trim() !== status.anthropic.baseUrl;
    const canSaveAnthropic = (status.anthropic.baseUrlEditable && anthropicBaseChanged)
        || (status.anthropic.apiKey.editable && anthropicApiKey.trim().length > 0);

    return (
        <div className="ai-connection-card">
            <div className="ai-connection-heading">
                <div>
                    <strong>{providerLabel} 接続設定</strong>
                </div>
                <KeyRound size={18} aria-hidden="true" />
            </div>

            {!status.secretStoreAvailable && !selectedApiKeyStatus.configured && (
                <p className="ai-connection-message error" role="alert">
                    問題が発生しました: OSの資格情報ストアが利用できません。環境変数でAPIキーを設定してださい。
                </p>
            )}

            {provider === 'openrouter' ? (
                <>
                    <label className="ai-connection-label" htmlFor="openrouter-api-key-input">
                        APIキー
                    </label>
                    <input
                        id="openrouter-api-key-input"
                        className="input"
                        type="password"
                        value={openRouterApiKey}
                        disabled={!status.openrouter.editable || saving}
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={status.openrouter.configured ? '変更する場合のみ入力' : 'APIキーを入力'}
                        onChange={(event) => setOpenRouterApiKeyInput(event.target.value)}
                    />
                    {!status.openrouter.editable && (
                        <p className="ai-connection-help">環境変数 OPENROUTER_API_KEY が優先されています。</p>
                    )}
                    <div className="ai-connection-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={!status.openrouter.editable || !openRouterApiKey.trim() || saving}
                            onClick={() => void runUpdate(
                                () => setOpenRouterApiKey(openRouterApiKey),
                                'OpenRouter APIキーを保存しました。',
                            )}
                        >
                            <Save size={15} aria-hidden="true" />
                            保存
                        </button>
                        {status.openrouter.configured && status.openrouter.editable && (
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={saving}
                                onClick={() => void runUpdate(
                                    deleteOpenRouterApiKey,
                                    'OpenRouter APIキーを削除しました。',
                                )}
                            >
                                <Trash2 size={15} aria-hidden="true" />
                                削除
                            </button>
                        )}
                    </div>
                </>
            ) : provider === 'anthropic' ? (
                <>
                    <label className="ai-connection-label" htmlFor="anthropic-base-url-input">
                        Base URL
                    </label>
                    <input
                        id="anthropic-base-url-input"
                        className="input"
                        type="url"
                        value={anthropicBaseUrl}
                        disabled={!status.anthropic.baseUrlEditable || saving}
                        spellCheck={false}
                        onChange={(event) => setAnthropicBaseUrl(event.target.value)}
                    />
                    {!status.anthropic.baseUrlEditable && (
                        <p className="ai-connection-help">
                            環境変数 ANTHROPIC_BASE_URL またはANTHROPIC_API_KEY が優先されています。
                        </p>
                    )}
                    {anthropicBaseChanged && status.anthropic.apiKey.configured && (
                        <p className="ai-connection-help warning">
                            接続先を変更すると、現在保存されているAPIキーは解除されます。
                        </p>
                    )}

                    <label className="ai-connection-label" htmlFor="anthropic-api-key-input">
                        APIキー
                    </label>
                    <input
                        id="anthropic-api-key-input"
                        className="input"
                        type="password"
                        value={anthropicApiKey}
                        disabled={!status.anthropic.apiKey.editable || saving}
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={status.anthropic.apiKey.configured ? '変更する場合のみ入力' : 'APIキーを入力'}
                        onChange={(event) => setAnthropicApiKeyInput(event.target.value)}
                    />
                    {!status.anthropic.apiKey.editable && (
                        <p className="ai-connection-help">環境変数 ANTHROPIC_API_KEY が優先されています。</p>
                    )}
                    <div className="ai-connection-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={!canSaveAnthropic || saving}
                            onClick={() => void runUpdate(
                                () => setAnthropicConfig({
                                    ...(status.anthropic.baseUrlEditable && anthropicBaseChanged
                                        ? { baseUrl: anthropicBaseUrl }
                                        : {}),
                                    ...(status.anthropic.apiKey.editable && anthropicApiKey.trim()
                                        ? { apiKey: anthropicApiKey }
                                        : {}),
                                }),
                                'Anthropic接続設定を保存しました。',
                            )}
                        >
                            <Save size={15} aria-hidden="true" />
                            保存
                        </button>
                        {status.anthropic.apiKey.configured && status.anthropic.apiKey.editable && (
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={saving}
                                onClick={() => void runUpdate(
                                    deleteAnthropicApiKey,
                                    'Anthropic APIキーを削除しました。',
                                )}
                            >
                                <Trash2 size={15} aria-hidden="true" />
                                キーを削除
                            </button>
                        )}
                    </div>
                </>
            ) : (
                <>
                    <label className="ai-connection-label" htmlFor="openai-base-url-input">
                        Base URL
                    </label>
                    <input
                        id="openai-base-url-input"
                        className="input"
                        type="url"
                        value={openAiBaseUrl}
                        disabled={!status.openai.baseUrlEditable || saving}
                        spellCheck={false}
                        onChange={(event) => setOpenAiBaseUrl(event.target.value)}
                    />
                    {!status.openai.baseUrlEditable && (
                        <p className="ai-connection-help">
                            環境変数 OPENAI_BASE_URL またはOPENAI_API_KEY が優先されています。
                        </p>
                    )}
                    {openAiBaseChanged && status.openai.apiKey.configured && (
                        <p className="ai-connection-help warning">
                            接続先を変更すると、現在保存されているAPIキーは解除されます。
                        </p>
                    )}

                    <label className="ai-connection-label" htmlFor="openai-api-key-input">
                        APIキー
                    </label>
                    <input
                        id="openai-api-key-input"
                        className="input"
                        type="password"
                        value={openAiApiKey}
                        disabled={!status.openai.apiKey.editable || saving}
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={status.openai.apiKey.configured ? '変更する場合のみ入力' : 'APIキーを入力'}
                        onChange={(event) => setOpenAiApiKeyInput(event.target.value)}
                    />
                    {!status.openai.apiKey.editable && (
                        <p className="ai-connection-help">環境変数 OPENAI_API_KEY が優先されています。</p>
                    )}
                    <div className="ai-connection-actions">
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={!canSaveOpenAi || saving}
                            onClick={() => void runUpdate(
                                () => setOpenAiConfig({
                                    ...(status.openai.baseUrlEditable && openAiBaseChanged
                                        ? { baseUrl: openAiBaseUrl }
                                        : {}),
                                    ...(status.openai.apiKey.editable && openAiApiKey.trim()
                                        ? { apiKey: openAiApiKey }
                                        : {}),
                                }),
                                'OpenAI接続設定を保存しました。',
                            )}
                        >
                            <Save size={15} aria-hidden="true" />
                            保存
                        </button>
                        {status.openai.apiKey.configured && status.openai.apiKey.editable && (
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={saving}
                                onClick={() => void runUpdate(
                                    deleteOpenAiApiKey,
                                    'OpenAI APIキーを削除しました。',
                                )}
                            >
                                <Trash2 size={15} aria-hidden="true" />
                                キーを削除
                            </button>
                        )}
                    </div>
                </>
            )}

            {message && <p className="ai-connection-message success" role="status">{message}</p>}
            {error && <p className="ai-connection-message error" role="alert">{error}</p>}
        </div>
    );
}
