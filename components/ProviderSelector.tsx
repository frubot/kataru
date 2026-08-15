import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react';

import { getAvailableProviders, type AvailableProvider } from '@/lib/availableProviders';
import { useStore } from '@/lib/store';

interface ProviderSelectorProps {
    value: string[];
    onChange: (providers: string[]) => void;
    id?: string;
}

export default function ProviderSelector({ value, onChange, id }: ProviderSelectorProps) {
    const generatedId = useId();
    const triggerId = id ?? `provider-selector-${generatedId}`;
    const listboxId = `${triggerId}-listbox`;
    const getAiApiConfig = useStore((state) => state.getAiApiConfig);
    const [isOpen, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [providers, setProviders] = useState<AvailableProvider[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const requestIdRef = useRef(0);

    const loadProviders = useCallback(async (force = false) => {
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        setLoading(true);
        setError(null);
        try {
            const nextProviders = await getAvailableProviders(getAiApiConfig(), { force });
            if (requestId === requestIdRef.current) setProviders(nextProviders);
        } catch (caught) {
            if (requestId === requestIdRef.current) {
                setProviders([]);
                setError(caught instanceof Error ? caught.message : 'プロバイダー一覧を取得できませんでした。');
            }
        } finally {
            if (requestId === requestIdRef.current) setLoading(false);
        }
    }, [getAiApiConfig]);

    useEffect(() => {
        if (isOpen) void loadProviders();
    }, [isOpen, loadProviders]);

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

    const allProviders = useMemo(() => {
        const knownSlugs = new Set(providers.map((provider) => provider.slug));
        return [
            ...providers,
            ...value
                .filter((slug) => !knownSlugs.has(slug))
                .map((slug) => ({ slug, name: slug })),
        ];
    }, [providers, value]);

    const filteredProviders = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery) return allProviders;
        return allProviders.filter((provider) => (
            provider.slug.toLocaleLowerCase().includes(normalizedQuery)
            || provider.name.toLocaleLowerCase().includes(normalizedQuery)
        ));
    }, [allProviders, query]);

    const toggleProvider = (provider: AvailableProvider) => {
        onChange(value.includes(provider.slug)
            ? value.filter((slug) => slug !== provider.slug)
            : [...value, provider.slug]);
    };

    return (
        <div className="model-selector provider-selector" ref={rootRef}>
            <button
                id={triggerId}
                type="button"
                className="input model-selector-trigger"
                role="combobox"
                aria-label="使用しないプロバイダー"
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                aria-controls={isOpen ? listboxId : undefined}
                onClick={() => {
                    setQuery('');
                    setOpen((open) => !open);
                }}
            >
                <span className={value.length > 0 ? 'model-selector-value' : 'model-selector-placeholder'}>
                    {value.length > 0 ? `${value.length}件を除外` : '指定なし'}
                </span>
                <ChevronDown
                    size={16}
                    aria-hidden="true"
                    className={isOpen ? 'model-selector-chevron open' : 'model-selector-chevron'}
                />
            </button>

            {isOpen && (
                <div className="model-selector-menu provider-selector-menu">
                    <div className="model-selector-search-row">
                        <div className="model-selector-search">
                            <Search size={15} aria-hidden="true" />
                            <input
                                ref={searchRef}
                                type="search"
                                value={query}
                                aria-label="プロバイダーを検索"
                                placeholder="名前またはslugで検索"
                                spellCheck={false}
                                onChange={(event) => setQuery(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Escape') {
                                        event.preventDefault();
                                        setOpen(false);
                                    } else if (event.key === 'Enter' && filteredProviders.length === 1) {
                                        event.preventDefault();
                                        toggleProvider(filteredProviders[0]);
                                    }
                                }}
                            />
                        </div>
                        <button
                            type="button"
                            className="model-selector-refresh"
                            aria-label="プロバイダー一覧を再取得"
                            title="プロバイダー一覧を再取得"
                            disabled={loading}
                            onClick={() => void loadProviders(true)}
                        >
                            <RefreshCw size={15} className={loading ? 'spin' : undefined} aria-hidden="true" />
                        </button>
                    </div>

                    {value.length > 0 && (
                        <button
                            type="button"
                            className="provider-selector-clear"
                            onClick={() => onChange([])}
                        >
                            選択をすべて解除
                        </button>
                    )}

                    <div
                        id={listboxId}
                        className="model-selector-options"
                        role="listbox"
                        aria-label="OpenRouterプロバイダー"
                        aria-multiselectable="true"
                    >
                        {loading && providers.length === 0 ? (
                            <p className="model-selector-status" role="status">プロバイダー一覧を読み込んでいます…</p>
                        ) : error ? (
                            <div className="model-selector-status error" role="alert">
                                <span>{error}</span>
                                <button type="button" onClick={() => void loadProviders(true)}>再試行</button>
                            </div>
                        ) : filteredProviders.length === 0 ? (
                            <p className="model-selector-status">
                                {allProviders.length === 0
                                    ? '利用可能なプロバイダーがありません。'
                                    : '一致するプロバイダーがありません。'}
                            </p>
                        ) : filteredProviders.map((provider) => {
                            const selected = value.includes(provider.slug);
                            return (
                                <button
                                    key={provider.slug}
                                    type="button"
                                    className={selected ? 'model-selector-option selected' : 'model-selector-option'}
                                    role="option"
                                    aria-selected={selected}
                                    onClick={() => toggleProvider(provider)}
                                >
                                    <span className="model-selector-option-copy">
                                        <span className="model-selector-option-name">{provider.name}</span>
                                        {provider.name !== provider.slug && (
                                            <span className="model-selector-option-id">{provider.slug}</span>
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
