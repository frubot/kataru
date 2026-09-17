import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react';

import { AI_CONNECTION_KIND_LABELS } from '@/lib/aiApi';
import { useAiConnections } from '@/lib/aiConnections';
import {
    getAvailableModelsForConnections,
    type AiConnectionModelsResult,
    type AvailableModel,
    type ModelOutputModality,
} from '@/lib/availableModels';
import { modelRefsEqual, type ModelRef } from '@/lib/modelDefaults';

interface ModelSelectorProps {
    value: ModelRef;
    onChange: (model: ModelRef) => void;
    outputModality: ModelOutputModality;
    id?: string;
    disabled?: boolean;
    placeholder?: string;
    ariaLabel?: string;
    style?: CSSProperties;
}

type ModelOption = {
    connectionId: string;
    model: AvailableModel;
};

function connectionMatchesQuery(result: AiConnectionModelsResult, normalizedQuery: string): boolean {
    const connection = result.connection;
    return connection.name.toLocaleLowerCase().includes(normalizedQuery)
        || connection.id.toLocaleLowerCase().includes(normalizedQuery)
        || AI_CONNECTION_KIND_LABELS[connection.kind].toLocaleLowerCase().includes(normalizedQuery);
}

export default function ModelSelector({
    value,
    onChange,
    outputModality,
    id,
    disabled = false,
    placeholder = 'モデルを選択',
    ariaLabel = 'モデル',
    style,
}: ModelSelectorProps) {
    const generatedId = useId();
    const triggerId = id ?? `model-selector-${generatedId}`;
    const listboxId = `${triggerId}-listbox`;
    const {
        connections,
        loading: connectionsLoading,
        error: connectionsError,
        reload: reloadConnections,
    } = useAiConnections();
    const [isOpen, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<AiConnectionModelsResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const requestIdRef = useRef(0);

    const loadModels = useCallback(async (force = false) => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        if (connections.length === 0) {
            setResults([]);
            setLoading(false);
            setError(null);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const nextResults = await getAvailableModelsForConnections(connections, outputModality, { force });
            if (requestId === requestIdRef.current) setResults(nextResults);
        } catch (caught) {
            if (requestId === requestIdRef.current) {
                setResults([]);
                setError(caught instanceof Error ? caught.message : '利用可能なモデルを取得できませんでした。');
            }
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, [connections, outputModality]);

    useEffect(() => {
        requestIdRef.current += 1;
        setResults([]);
        setLoading(false);
        setError(null);
        void loadModels();
    }, [loadModels]);

    useEffect(() => {
        if (isOpen) void loadModels();
    }, [isOpen, loadModels]);

    useEffect(() => {
        if (!isOpen) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('pointerdown', handlePointerDown);
        return () => document.removeEventListener('pointerdown', handlePointerDown);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [isOpen]);

    const filteredResults = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery) return results;
        return results.flatMap((result) => {
            if (connectionMatchesQuery(result, normalizedQuery)) return [result];
            if ('error' in result) return [];
            const models = result.models.filter((model) => (
                model.id.toLocaleLowerCase().includes(normalizedQuery)
                || model.name.toLocaleLowerCase().includes(normalizedQuery)
            ));
            return models.length > 0 ? [{ connection: result.connection, models }] : [];
        });
    }, [results, query]);

    const filteredOptions = useMemo<ModelOption[]>(() => filteredResults.flatMap((result) => (
        'error' in result
            ? []
            : result.models.map((model) => ({ connectionId: result.connection.id, model }))
    )), [filteredResults]);

    const selectedOption = useMemo(() => {
        if (!value.model) return null;
        const result = results.find((entry) => (
            !('error' in entry) && entry.connection.id === value.connectionId
        ));
        if (!result || 'error' in result) return null;
        const model = result.models.find((candidate) => candidate.id === value.model);
        return model ? { connection: result.connection, model } : null;
    }, [results, value]);

    const selectedConnection = useMemo(() => (
        value.model ? connections.find((connection) => connection.id === value.connectionId) ?? null : null
    ), [connections, value]);

    const showConnectionName = connections.length > 1;
    const selectedLabel = value.model
        ? showConnectionName
            ? `${(selectedOption?.connection ?? selectedConnection)?.name ?? value.connectionId} / ${selectedOption?.model.name ?? value.model}`
            : selectedOption?.model.name ?? value.model
        : '';
    const selectedTitle = value.model
        ? `${(selectedOption?.connection ?? selectedConnection)?.name ?? value.connectionId} / ${value.model}`
        : undefined;

    const openMenu = () => {
        if (disabled) return;
        setQuery('');
        setOpen(true);
    };

    const selectOption = (option: ModelOption) => {
        onChange({ connectionId: option.connectionId, model: option.model.id });
        setOpen(false);
        setQuery('');
    };

    return (
        <div className="model-selector" ref={rootRef} style={style}>
            <button
                id={triggerId}
                type="button"
                className="input model-selector-trigger"
                role="combobox"
                aria-label={ariaLabel}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                aria-controls={isOpen ? listboxId : undefined}
                disabled={disabled}
                onClick={() => isOpen ? setOpen(false) : openMenu()}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        openMenu();
                    }
                }}
                title={value.model && selectedOption?.model.name !== value.model ? selectedTitle : undefined}
            >
                <span className={value.model ? 'model-selector-value' : 'model-selector-placeholder'}>
                    {selectedLabel || placeholder}
                </span>
                <ChevronDown
                    size={16}
                    aria-hidden="true"
                    className={isOpen ? 'model-selector-chevron open' : 'model-selector-chevron'}
                />
            </button>

            {isOpen && (
                <div className="model-selector-menu">
                    <div className="model-selector-search-row">
                        <div className="model-selector-search">
                            <Search size={15} aria-hidden="true" />
                            <input
                                ref={searchRef}
                                type="search"
                                value={query}
                                aria-label="モデルを検索"
                                placeholder="モデル名・ID・接続先で検索"
                                spellCheck={false}
                                onChange={(event) => setQuery(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setOpen(false);
                                    } else if (event.key === 'Enter' && filteredOptions.length === 1) {
                                        event.preventDefault();
                                        selectOption(filteredOptions[0]);
                                    }
                                }}
                            />
                        </div>
                        <button
                            type="button"
                            className="model-selector-refresh"
                            aria-label="モデル一覧を再取得"
                            title="モデル一覧を再取得"
                            disabled={loading}
                            onClick={() => void loadModels(true)}
                        >
                            <RefreshCw size={15} className={loading ? 'spin' : undefined} aria-hidden="true" />
                        </button>
                    </div>

                    <div id={listboxId} className="model-selector-options" role="listbox" aria-label="利用可能なモデル">
                        {connectionsError && results.length === 0 ? (
                            <div className="model-selector-status error" role="alert">
                                <span>{connectionsError}</span>
                                <button type="button" onClick={() => void reloadConnections()}>再試行</button>
                            </div>
                        ) : (loading || connectionsLoading) && results.length === 0 ? (
                            <p className="model-selector-status" role="status">モデル一覧を読み込んでいます…</p>
                        ) : error ? (
                            <div className="model-selector-status error" role="alert">
                                <span>{error}</span>
                                <button type="button" onClick={() => void loadModels(true)}>再試行</button>
                            </div>
                        ) : filteredResults.length === 0 ? (
                            <p className="model-selector-status">
                                {results.length === 0
                                    ? connections.length === 0
                                        ? '接続先が設定されていません。'
                                        : '利用可能なモデルがありません。'
                                    : '一致するモデルがありません。'}
                            </p>
                        ) : filteredResults.map((result) => (
                            <div
                                key={result.connection.id}
                                className="model-selector-group"
                                role="group"
                                aria-label={result.connection.name}
                            >
                                {filteredResults.length > 1 && (
                                    <div className="model-selector-group-header">
                                        <span className="model-selector-group-name">{result.connection.name}</span>
                                    </div>
                                )}
                                {'error' in result ? (
                                    <p className="model-selector-group-error" role="status">{result.error}</p>
                                ) : result.models.map((model) => {
                                    const option: ModelOption = { connectionId: result.connection.id, model };
                                    const selected = modelRefsEqual(
                                        { connectionId: result.connection.id, model: model.id },
                                        value,
                                    );
                                    return (
                                        <button
                                            key={model.id}
                                            type="button"
                                            className={selected ? 'model-selector-option selected' : 'model-selector-option'}
                                            role="option"
                                            aria-selected={selected}
                                            onClick={() => selectOption(option)}
                                        >
                                            <span className="model-selector-option-copy">
                                                <span className="model-selector-option-name">{model.name}</span>
                                                {model.name !== model.id && (
                                                    <span className="model-selector-option-id">{model.id}</span>
                                                )}
                                            </span>
                                            {selected && <Check size={16} aria-hidden="true" />}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
