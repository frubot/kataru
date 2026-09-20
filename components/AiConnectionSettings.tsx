import { useEffect, useState } from 'react';
import { Pencil, RefreshCw, Save, Trash2 } from 'lucide-react';

import { AI_CONNECTION_KIND_LABELS, type AiConnectionKind } from '@/lib/aiApi';
import {
    createAiConnection,
    deleteAiConnection,
    updateAiConnection,
    useAiConnections,
    type AiConnectionStatus,
    type UpdateAiConnectionInput,
} from '@/lib/aiConnections';
import ProviderSelector from './ProviderSelector';
import OptionSelector from './OptionSelector';

const CONNECTION_KIND_OPTIONS: readonly AiConnectionKind[] = [
    'openrouter',
    'openai-compatible',
    'anthropic',
    'typesafe',
    'voicevox',
    'irodori',
];

const ENV_API_KEY_NAMES: Record<AiConnectionKind, string> = {
    openrouter: 'OPENROUTER_API_KEY',
    'openai-compatible': 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    typesafe: 'TYPESAFE_API_KEY',
    voicevox: 'VOICEVOX_API_KEY',
    irodori: 'IRODORI_API_KEY',
};

const ENV_BASE_URL_NAMES: Partial<Record<AiConnectionKind, string>> = {
    'openai-compatible': 'OPENAI_BASE_URL',
    anthropic: 'ANTHROPIC_BASE_URL',
    typesafe: 'TYPESAFE_BASE_URL',
    irodori: 'IRODORI_BASE_URL',
};

function apiKeyPlaceholder(connection: AiConnectionStatus): string {
    if (connection.apiKey.configured) return '変更する場合のみ入力';
    if (connection.kind === 'openai-compatible') return 'APIキーを入力（ローカルAPIでは省略可）';
    if (connection.kind === 'irodori') return 'APIキーを入力（サーバー側で有効時のみ）';
    return 'APIキーを入力';
}

function AiConnectionCard({ connection }: { connection: AiConnectionStatus }) {
    const [name, setName] = useState(connection.name);
    const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? '');
    const [apiKey, setApiKey] = useState('');
    const [embeddingsEnabled, setEmbeddingsEnabled] = useState(connection.embeddingsEnabled);
    const [imageGenerationEnabled, setImageGenerationEnabled] = useState(connection.imageGenerationEnabled);
    const [ttsEnabled, setTtsEnabled] = useState(connection.ttsEnabled);
    const [ignoredProviders, setIgnoredProviders] = useState(connection.ignoredProviders);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setName(connection.name);
        setBaseUrl(connection.baseUrl ?? '');
        setApiKey('');
        setEmbeddingsEnabled(connection.embeddingsEnabled);
        setImageGenerationEnabled(connection.imageGenerationEnabled);
        setTtsEnabled(connection.ttsEnabled);
        setIgnoredProviders(connection.ignoredProviders);
    }, [connection]);

    const nameChanged = connection.editable && name.trim().length > 0 && name.trim() !== connection.name;
    const baseUrlChanged = connection.baseUrlEditable
        && baseUrl.trim() !== (connection.baseUrl ?? '');
    const apiKeyChanged = connection.apiKey.editable && apiKey.trim().length > 0;
    const flagsChanged = connection.kind === 'openai-compatible'
        && (embeddingsEnabled !== connection.embeddingsEnabled
            || imageGenerationEnabled !== connection.imageGenerationEnabled
            || ttsEnabled !== connection.ttsEnabled);
    const providersChanged = connection.kind === 'openrouter'
        && (ignoredProviders.length !== connection.ignoredProviders.length
            || ignoredProviders.some((slug, index) => slug !== connection.ignoredProviders[index]));
    const canSave = nameChanged || baseUrlChanged || apiKeyChanged || flagsChanged || providersChanged;

    const runUpdate = async (
        operation: () => Promise<unknown>,
        successMessage: string,
    ) => {
        if (saving) return;
        setSaving(true);
        setError(null);
        setMessage(null);
        try {
            await operation();
            setMessage(successMessage);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'AI接続設定を更新できませんでした。');
        } finally {
            setSaving(false);
        }
    };

    const handleSave = () => void runUpdate(async () => {
        const update: UpdateAiConnectionInput = {};
        if (nameChanged) update.name = name;
        if (baseUrlChanged) update.baseUrl = baseUrl;
        if (apiKeyChanged) update.apiKey = apiKey;
        if (flagsChanged) {
            update.embeddingsEnabled = embeddingsEnabled;
            update.imageGenerationEnabled = imageGenerationEnabled;
            update.ttsEnabled = ttsEnabled;
        }
        if (providersChanged) update.ignoredProviders = ignoredProviders;
        await updateAiConnection(connection.id, update);
    }, '接続設定を保存しました。');

    const handleDelete = () => {
        if (!window.confirm(`接続先「${connection.name}」を削除しますか？`)) return;
        void runUpdate(
            () => deleteAiConnection(connection.id),
            '接続先を削除しました。',
        );
    };

    const baseUrlLockedHelp = connection.kind === 'openrouter'
        ? 'OpenRouterのエンドポイントは固定です。'
        : connection.builtin && ENV_BASE_URL_NAMES[connection.kind]
            ? `環境変数 ${ENV_BASE_URL_NAMES[connection.kind]} または ${ENV_API_KEY_NAMES[connection.kind]} が設定されているため、変更できません。`
            : 'この接続のエンドポイントは変更できません。';

    return (
        <div className="card ai-connection-card">
            <div className="ai-connection-heading">
                <div>
                    <strong>{connection.name}</strong>
                    <span>{connection.baseUrl ?? AI_CONNECTION_KIND_LABELS[connection.kind]}</span>
                </div>
                <span className="ai-connection-heading-side">
                    <span className="ai-connection-badges">
                        <span className="ai-connection-badge">{AI_CONNECTION_KIND_LABELS[connection.kind]}</span>
                        {connection.builtin && <span className="ai-connection-badge muted">組み込み</span>}
                    </span>
                    <span className="ai-connection-icon-actions">
                        <button
                            type="button"
                            className={editing ? 'ai-connection-icon-button edit active' : 'ai-connection-icon-button edit'}
                            title={editing ? '編集を閉じる' : '設定を編集'}
                            aria-label={`${connection.name}の設定を編集`}
                            aria-expanded={editing}
                            onClick={() => setEditing((prev) => !prev)}
                        >
                            <Pencil size={14} aria-hidden="true" />
                        </button>
                        {connection.deletable && (
                            <button
                                type="button"
                                className="ai-connection-icon-button danger"
                                disabled={saving}
                                title="接続先を削除"
                                aria-label={`${connection.name}を削除`}
                                onClick={handleDelete}
                            >
                                <Trash2 size={14} aria-hidden="true" />
                            </button>
                        )}
                    </span>
                </span>
            </div>

            {editing && (
                <div className="ai-connection-details">
                    {!connection.builtin && (
                        <>
                            <label className="ai-connection-label" htmlFor={`ai-connection-name-${connection.id}`}>
                                接続名
                            </label>
                            <input
                                id={`ai-connection-name-${connection.id}`}
                                className="input"
                                type="text"
                                value={name}
                                disabled={!connection.editable || saving}
                                spellCheck={false}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </>
                    )}

                    <label className="ai-connection-label" htmlFor={`ai-connection-base-url-${connection.id}`}>
                        エンドポイント
                    </label>
                    <input
                        id={`ai-connection-base-url-${connection.id}`}
                        className="input"
                        type="url"
                        value={baseUrl}
                        disabled={!connection.baseUrlEditable || saving}
                        spellCheck={false}
                        onChange={(event) => setBaseUrl(event.target.value)}
                    />
                    {!connection.baseUrlEditable && (
                        <p className="ai-connection-help">{baseUrlLockedHelp}</p>
                    )}
                    {baseUrlChanged && connection.apiKey.configured && connection.kind !== 'voicevox' && (
                        <p className="ai-connection-help warning">
                            接続先を変更すると、現在保存されているAPIキーは解除されます。
                        </p>
                    )}

                    {connection.kind === 'voicevox' ? (
                        <p className="ai-connection-help">VOICEVOXエンジンにはAPIキーは不要です。</p>
                    ) : (
                        <>
                            <label className="ai-connection-label" htmlFor={`ai-connection-api-key-${connection.id}`}>
                                APIキー
                            </label>
                            <input
                                id={`ai-connection-api-key-${connection.id}`}
                                className="input"
                                type="password"
                                value={apiKey}
                                disabled={!connection.apiKey.editable || saving}
                                autoComplete="new-password"
                                spellCheck={false}
                                placeholder={apiKeyPlaceholder(connection)}
                                onChange={(event) => setApiKey(event.target.value)}
                            />
                            {!connection.apiKey.editable ? (
                                <p className="ai-connection-help">
                                    環境変数 {ENV_API_KEY_NAMES[connection.kind]} が設定されているため、変更できません。
                                </p>
                            ) : connection.apiKey.configured && connection.apiKey.source === 'environment' ? (
                                <p className="ai-connection-help">環境変数のAPIキーを使用中です。</p>
                            ) : !connection.apiKey.configured && connection.kind === 'irodori' ? (
                                <p className="ai-connection-help">
                                    Irodori TTS Server側でAPIキー認証を有効にしている場合のみ設定します。
                                </p>
                            ) : !connection.apiKey.configured && connection.kind !== 'openai-compatible' ? (
                                <p className="ai-connection-help">APIキーが未設定です。</p>
                            ) : null}
                        </>
                    )}

                    {connection.kind === 'openai-compatible' && (
                        <>
                            <label className="ai-connection-option">
                                <input
                                    type="checkbox"
                                    checked={embeddingsEnabled}
                                    disabled={!connection.editable || saving}
                                    onChange={(event) => setEmbeddingsEnabled(event.target.checked)}
                                />
                                埋め込みモデルを利用する（メモリ検索）
                            </label>
                            <label className="ai-connection-option">
                                <input
                                    type="checkbox"
                                    checked={imageGenerationEnabled}
                                    disabled={!connection.editable || saving}
                                    onChange={(event) => setImageGenerationEnabled(event.target.checked)}
                                />
                                画像生成を利用する
                            </label>
                            <label className="ai-connection-option">
                                <input
                                    type="checkbox"
                                    checked={ttsEnabled}
                                    disabled={!connection.editable || saving}
                                    onChange={(event) => setTtsEnabled(event.target.checked)}
                                />
                                音声合成（TTS）を利用する
                            </label>
                        </>
                    )}

                    {connection.kind === 'openrouter' && (
                        <div>
                            <span className="ai-connection-label">使用しないプロバイダー</span>
                            <ProviderSelector
                                connectionId={connection.id}
                                value={ignoredProviders}
                                onChange={setIgnoredProviders}
                            />
                            <p className="ai-connection-help" style={{ marginTop: '0.375rem' }}>
                                選択したプロバイダーをOpenRouterのルーティング候補から除外します。
                            </p>
                        </div>
                    )}

                    <div className="ai-connection-actions">
                        <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={!canSave || saving}
                            onClick={handleSave}
                        >
                            <Save size={15} aria-hidden="true" />
                            保存
                        </button>
                        {connection.apiKey.configured && connection.apiKey.editable && (
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={saving}
                                onClick={() => void runUpdate(
                                    () => updateAiConnection(connection.id, { clearApiKey: true }),
                                    'APIキーを削除しました。',
                                )}
                            >
                                <Trash2 size={15} aria-hidden="true" />
                                キーを削除
                            </button>
                        )}
                    </div>
                </div>
            )}

            {message && <p className="ai-connection-message success" role="status">{message}</p>}
            {error && <p className="ai-connection-message error" role="alert">{error}</p>}
        </div>
    );
}

function AddAiConnectionCard({ onClose }: { onClose: () => void }) {
    const [name, setName] = useState('');
    const [kind, setKind] = useState<AiConnectionKind>('openai-compatible');
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [embeddingsEnabled, setEmbeddingsEnabled] = useState(true);
    const [imageGenerationEnabled, setImageGenerationEnabled] = useState(false);
    const [ttsEnabled, setTtsEnabled] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const baseUrlFixed = kind === 'openrouter';
    const baseUrlOptional = kind === 'typesafe' || kind === 'voicevox' || kind === 'irodori';
    const canCreate = name.trim().length > 0 && (baseUrlFixed || baseUrlOptional || baseUrl.trim().length > 0);

    const reset = () => {
        setName('');
        setKind('openai-compatible');
        setBaseUrl('');
        setApiKey('');
        setEmbeddingsEnabled(true);
        setImageGenerationEnabled(false);
        setTtsEnabled(false);
        setError(null);
    };

    const handleCreate = async () => {
        if (!canCreate || saving) return;
        setSaving(true);
        setError(null);
        try {
            await createAiConnection({
                name,
                kind,
                ...(baseUrlFixed ? {} : { baseUrl }),
                ...(apiKey.trim() ? { apiKey } : {}),
                ...(kind === 'openai-compatible'
                    ? { embeddingsEnabled, imageGenerationEnabled, ttsEnabled }
                    : {}),
            });
            reset();
            onClose();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : '接続先を作成できませんでした。');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="card ai-connection-card">
            <div className="ai-connection-heading">
                <div>
                    <strong>新しい接続先</strong>
                    <span>カスタム接続を追加します。</span>
                </div>
            </div>

            <label className="ai-connection-label" htmlFor="ai-connection-new-name">接続名</label>
            <input
                id="ai-connection-new-name"
                className="input"
                type="text"
                value={name}
                disabled={saving}
                spellCheck={false}
                placeholder="例: ローカルLLM"
                onChange={(event) => setName(event.target.value)}
            />

            <label className="ai-connection-label" htmlFor="ai-connection-new-kind">APIの種類</label>
            <OptionSelector
                id="ai-connection-new-kind"
                value={kind}
                disabled={saving}
                ariaLabel="APIの種類"
                onChange={(next) => setKind(next as AiConnectionKind)}
                options={CONNECTION_KIND_OPTIONS.map((option) => ({
                    value: option,
                    label: AI_CONNECTION_KIND_LABELS[option],
                }))}
            />

            <label className="ai-connection-label" htmlFor="ai-connection-new-base-url">エンドポイント</label>
            <input
                id="ai-connection-new-base-url"
                className="input"
                type="url"
                value={baseUrl}
                disabled={baseUrlFixed || saving}
                spellCheck={false}
                placeholder={baseUrlFixed
                    ? 'OpenRouterのエンドポイントは固定です'
                    : kind === 'typesafe'
                        ? '空欄で https://api.typesafe.ai/v1 を使用'
                        : kind === 'voicevox'
                            ? '空欄で http://127.0.0.1:50021 を使用'
                            : kind === 'irodori'
                                ? '空欄で http://127.0.0.1:8088 を使用'
                                : '例: http://localhost:1234/v1'}
                onChange={(event) => setBaseUrl(event.target.value)}
            />

            {kind === 'voicevox' ? (
                <p className="ai-connection-help">VOICEVOXエンジンにはAPIキーは不要です。</p>
            ) : (
                <>
                    <label className="ai-connection-label" htmlFor="ai-connection-new-api-key">APIキー</label>
                    <input
                        id="ai-connection-new-api-key"
                        className="input"
                        type="password"
                        value={apiKey}
                        disabled={saving}
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={kind === 'openai-compatible'
                            ? 'APIキーを入力（ローカルAPIでは省略可）'
                            : kind === 'irodori'
                                ? 'APIキーを入力（省略可）'
                                : 'APIキーを入力'}
                        onChange={(event) => setApiKey(event.target.value)}
                    />
                    {kind === 'irodori' && (
                        <p className="ai-connection-help">
                            Irodori TTS Server側でAPIキー認証を有効にしている場合のみ設定します。
                        </p>
                    )}
                </>
            )}

            {kind === 'openai-compatible' && (
                <>
                    <label className="ai-connection-option">
                        <input
                            type="checkbox"
                            checked={embeddingsEnabled}
                            disabled={saving}
                            onChange={(event) => setEmbeddingsEnabled(event.target.checked)}
                        />
                        埋め込みモデルを利用する（メモリ検索）
                    </label>
                    <label className="ai-connection-option">
                        <input
                            type="checkbox"
                            checked={imageGenerationEnabled}
                            disabled={saving}
                            onChange={(event) => setImageGenerationEnabled(event.target.checked)}
                        />
                        画像生成を利用する
                    </label>
                    <label className="ai-connection-option">
                        <input
                            type="checkbox"
                            checked={ttsEnabled}
                            disabled={saving}
                            onChange={(event) => setTtsEnabled(event.target.checked)}
                        />
                        音声合成（TTS）を利用する
                    </label>
                </>
            )}

            <div className="ai-connection-actions">
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!canCreate || saving}
                    onClick={() => void handleCreate()}
                >
                    {saving ? '追加中…' : '追加'}
                </button>
                <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={saving}
                    onClick={() => {
                        reset();
                        onClose();
                    }}
                >
                    キャンセル
                </button>
            </div>

            {error && <p className="ai-connection-message error" role="alert">{error}</p>}
        </div>
    );
}

interface AiConnectionSettingsProps {
    addOpen: boolean;
    onAddOpenChange: (open: boolean) => void;
}

export default function AiConnectionSettings({ addOpen, onAddOpenChange }: AiConnectionSettingsProps) {
    const { connections, secretStoreAvailable, loading, error, reload } = useAiConnections();

    if (loading && connections.length === 0) {
        return (
            <div className="ai-connection-card ai-connection-loading" aria-live="polite">
                <RefreshCw size={16} className="spin" aria-hidden="true" />
                AI接続設定を読み込んでいます…
            </div>
        );
    }

    if (error && connections.length === 0) {
        return (
            <div className="ai-connection-card">
                <p className="ai-connection-message error" role="alert">{error}</p>
                <button type="button" className="btn btn-secondary" onClick={() => void reload()}>
                    再読み込み
                </button>
            </div>
        );
    }

    return (
        <div className="ai-connection-list">
            {!secretStoreAvailable && (
                <p className="ai-connection-message error" role="alert">
                    OSの資格情報ストアを利用できません。環境変数でAPIキーを設定してください。
                </p>
            )}
            {connections.map((connection) => (
                <AiConnectionCard key={connection.id} connection={connection} />
            ))}
            {connections.length === 0 && !addOpen && (
                <div className="card ai-connection-card">
                    <p className="ai-connection-message">
                        接続先がまだありません。「+」から利用するAIサービスを追加してください。
                    </p>
                </div>
            )}
            {addOpen && <AddAiConnectionCard onClose={() => onAddOpenChange(false)} />}
        </div>
    );
}
