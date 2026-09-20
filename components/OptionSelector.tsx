import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface OptionSelectorOption {
    value: string;
    label: string;
    /** Secondary line rendered like the model ID in ModelSelector. */
    detail?: string;
    /** Leading content such as an icon or a palette preview. */
    icon?: ReactNode;
}

export interface OptionSelectorGroup {
    label: string;
    options: readonly OptionSelectorOption[];
}

export type OptionSelectorItem = OptionSelectorOption | OptionSelectorGroup;

interface OptionSelectorProps {
    value: string;
    onChange: (value: string) => void;
    options: readonly OptionSelectorItem[];
    id?: string;
    disabled?: boolean;
    placeholder?: string;
    ariaLabel?: string;
    /** Show the search field inside the menu (for long option lists). */
    searchable?: boolean;
    searchPlaceholder?: string;
    searchAriaLabel?: string;
    /** Show a loading status inside the menu instead of the options. */
    loading?: boolean;
    loadingLabel?: string;
    /** Status shown when there are no options to list. */
    emptyLabel?: string;
    /** Tooltip on the trigger button. */
    title?: string;
    style?: CSSProperties;
    triggerStyle?: CSSProperties;
    menuStyle?: CSSProperties;
    chevronSize?: number;
}

function isGroup(item: OptionSelectorItem): item is OptionSelectorGroup {
    return 'options' in item;
}

function optionMatches(option: OptionSelectorOption, normalizedQuery: string): boolean {
    return option.label.toLocaleLowerCase().includes(normalizedQuery)
        || option.value.toLocaleLowerCase().includes(normalizedQuery)
        || (option.detail?.toLocaleLowerCase().includes(normalizedQuery) ?? false);
}

/** Generic single-value dropdown sharing the ModelSelector look:
 * an input-like trigger with a chevron and a floating option list. */
export default function OptionSelector({
    value,
    onChange,
    options,
    id,
    disabled = false,
    placeholder = '選択してください',
    ariaLabel = '選択肢',
    searchable = false,
    searchPlaceholder = '検索',
    searchAriaLabel = '選択肢を検索',
    loading = false,
    loadingLabel = '読み込んでいます…',
    emptyLabel = '選択肢がありません。',
    title,
    style,
    triggerStyle,
    menuStyle,
    chevronSize = 16,
}: OptionSelectorProps) {
    const generatedId = useId();
    const triggerId = id ?? `option-selector-${generatedId}`;
    const listboxId = `${triggerId}-listbox`;
    const [isOpen, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const rootRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

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
        if (!isOpen || !searchable) return;
        const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
        return () => window.cancelAnimationFrame(frame);
    }, [isOpen, searchable]);

    const filteredItems = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery) return options;
        return options.flatMap((item): OptionSelectorItem[] => {
            if (!isGroup(item)) {
                return optionMatches(item, normalizedQuery) ? [item] : [];
            }
            if (item.label.toLocaleLowerCase().includes(normalizedQuery)) return [item];
            const matched = item.options.filter((option) => optionMatches(option, normalizedQuery));
            return matched.length > 0 ? [{ ...item, options: matched }] : [];
        });
    }, [options, query]);

    const filteredOptions = useMemo<OptionSelectorOption[]>(() => filteredItems.flatMap((item) => (
        isGroup(item) ? [...item.options] : [item]
    )), [filteredItems]);

    const selectedOption = useMemo(() => {
        for (const item of options) {
            const candidates: readonly OptionSelectorOption[] = isGroup(item) ? item.options : [item];
            const found = candidates.find((option) => option.value === value);
            if (found) return found;
        }
        return null;
    }, [options, value]);

    const hasSelection = selectedOption !== null || value !== '';
    const selectedLabel = selectedOption?.label ?? value;

    const openMenu = () => {
        if (disabled) return;
        setQuery('');
        setOpen(true);
    };

    const selectOption = (option: OptionSelectorOption) => {
        onChange(option.value);
        setOpen(false);
        setQuery('');
    };

    const renderOption = (option: OptionSelectorOption) => {
        const selected = option.value === value;
        return (
            <button
                key={option.value}
                type="button"
                className={selected ? 'model-selector-option selected' : 'model-selector-option'}
                role="option"
                aria-selected={selected}
                onClick={() => selectOption(option)}
            >
                {option.icon}
                <span className="model-selector-option-copy">
                    <span className="model-selector-option-name">{option.label}</span>
                    {option.detail && (
                        <span className="model-selector-option-id">{option.detail}</span>
                    )}
                </span>
                {selected && <Check size={16} aria-hidden="true" />}
            </button>
        );
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
                title={title}
                style={triggerStyle}
                onClick={() => isOpen ? setOpen(false) : openMenu()}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        openMenu();
                    } else if (event.key === 'Escape' && isOpen) {
                        event.preventDefault();
                        setOpen(false);
                    }
                }}
            >
                <span className={hasSelection ? 'model-selector-value' : 'model-selector-placeholder'}>
                    {hasSelection ? selectedLabel : placeholder}
                </span>
                <ChevronDown
                    size={chevronSize}
                    aria-hidden="true"
                    className={isOpen ? 'model-selector-chevron open' : 'model-selector-chevron'}
                />
            </button>

            {isOpen && (
                <div
                    className="model-selector-menu"
                    style={menuStyle}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            setOpen(false);
                        }
                    }}
                >
                    {searchable && (
                        <div className="model-selector-search-row">
                            <div className="model-selector-search">
                                <Search size={15} aria-hidden="true" />
                                <input
                                    ref={searchRef}
                                    type="search"
                                    value={query}
                                    aria-label={searchAriaLabel}
                                    placeholder={searchPlaceholder}
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
                        </div>
                    )}

                    <div id={listboxId} className="model-selector-options" role="listbox" aria-label={ariaLabel}>
                        {loading ? (
                            <p className="model-selector-status" role="status">{loadingLabel}</p>
                        ) : filteredItems.length === 0 ? (
                            <p className="model-selector-status">
                                {query.trim() ? '一致する項目がありません。' : emptyLabel}
                            </p>
                        ) : filteredItems.map((item) => {
                            if (!isGroup(item)) return renderOption(item);
                            return (
                                <div
                                    key={item.label}
                                    className="model-selector-group"
                                    role="group"
                                    aria-label={item.label}
                                >
                                    {filteredItems.length > 1 && (
                                        <div className="model-selector-group-header">
                                            <span className="model-selector-group-name">{item.label}</span>
                                        </div>
                                    )}
                                    {item.options.map(renderOption)}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
