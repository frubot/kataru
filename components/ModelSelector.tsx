import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react';

import {
    getAvailableModels,
    type AvailableModel,
    type ModelOutputModality,
} from '@/lib/availableModels';
import { useStore } from '@/lib/store';

interface ModelSelectorProps {
    value: string;
    onChange: (model: string) => void;
    outputModality: ModelOutputModality;
    id?: string;
    disabled?: boolean;
    placeholder?: string;
    ariaLabel?: string;
    style?: CSSProperties;
    refreshToken?: number;
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
    refreshToken = 0,
}: ModelSelectorProps) {
    const generatedId = useId();
    const triggerId = id ?? `model-selector-${generatedId}`;
    const listboxId = `${triggerId}-listbox`;
    const aiApiType = useStore((state) => state.aiApiType);
    const getAiApiConfig = useStore((state) => state.getAiApiConfig);
    const [isOpen, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [models, setModels] = useState<AvailableModel[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const requestIdRef = useRef(0);

    const loadModels = useCallback(async (force = false) => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        setLoading(true);
        setError(null);
        try {
            const nextModels = await getAvailableModels(getAiApiConfig(), outputModality, { force });
            if (requestId === requestIdRef.current) setModels(nextModels);
        } catch (caught) {
            if (requestId === requestIdRef.current) {
                setModels([]);
                setError(caught instanceof Error ? caught.message : '利用可能なモデルを取得できませんでした。');
            }
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, [getAiApiConfig, outputModality]);

    useEffect(() => {
        requestIdRef.current += 1;
        setModels([]);
        setLoading(false);
        setError(null);
        void loadModels();
    }, [aiApiType, loadModels, refreshToken]);

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

    const filteredModels = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery) return models;
        return models.filter((model) => (
            model.id.toLocaleLowerCase().includes(normalizedQuery)
            || model.name.toLocaleLowerCase().includes(normalizedQuery)
        ));
    }, [models, query]);

    const selectedModel = useMemo(
        () => models.find((model) => model.id === value),
        [models, value],
    );

    const openMenu = () => {
        if (disabled) return;
        setQuery('');
        setOpen(true);
    };

    const selectModel = (model: AvailableModel) => {
        onChange(model.id);
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
                title={selectedModel && selectedModel.name !== value ? value : undefined}
            >
                <span className={value ? 'model-selector-value' : 'model-selector-placeholder'}>
                    {selectedModel?.name || value || placeholder}
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
                                placeholder="モデル名またはIDで検索"
                                spellCheck={false}
                                onChange={(event) => setQuery(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setOpen(false);
                                    } else if (event.key === 'Enter' && filteredModels.length === 1) {
                                        event.preventDefault();
                                        selectModel(filteredModels[0]);
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
                        {loading && models.length === 0 ? (
                            <p className="model-selector-status" role="status">モデル一覧を読み込んでいます…</p>
                        ) : error ? (
                            <div className="model-selector-status error" role="alert">
                                <span>{error}</span>
                                <button type="button" onClick={() => void loadModels(true)}>再試行</button>
                            </div>
                        ) : filteredModels.length === 0 ? (
                            <p className="model-selector-status">
                                {models.length === 0 ? '利用可能なモデルがありません。' : '一致するモデルがありません。'}
                            </p>
                        ) : filteredModels.map((model) => {
                            const selected = model.id === value;
                            return (
                                <button
                                    key={model.id}
                                    type="button"
                                    className={selected ? 'model-selector-option selected' : 'model-selector-option'}
                                    role="option"
                                    aria-selected={selected}
                                    onClick={() => selectModel(model)}
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
                </div>
            )}
        </div>
    );
}
