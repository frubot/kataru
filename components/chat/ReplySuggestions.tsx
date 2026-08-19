import { Sparkles } from 'lucide-react';
import type { ReplySuggestionState } from './useReplySuggestions';

type ReplySuggestionsProps = {
    state: ReplySuggestionState;
    visualNovelMode: boolean;
    disabled: boolean;
    onSelect: (suggestion: string) => void;
};

export default function ReplySuggestions({
    state,
    visualNovelMode,
    disabled,
    onSelect,
}: ReplySuggestionsProps) {
    return (
        <div
            className={`reply-suggestions${visualNovelMode ? ' vn-reply-suggestions' : ''}`}
            aria-label="主人公の返答候補"
        >
            {state.loading && (
                <div className="reply-suggestions-heading">
                    <Sparkles size={14} aria-hidden="true" />
                    <span>返答を考えています…</span>
                </div>
            )}
            {!state.loading && (
                <div className="reply-suggestions-list">
                    {state.suggestions.map((suggestion, index) => (
                        <button
                            key={`${index}:${suggestion}`}
                            type="button"
                            className="reply-suggestion-button"
                            onClick={() => onSelect(suggestion)}
                            disabled={disabled}
                            title={`${suggestion}（選択して送信）`}
                        >
                            <span className="reply-suggestion-text">{suggestion}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
