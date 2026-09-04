import { create } from 'zustand';

import { createBackupSlice } from './store/backup';
import { createCharacterSlice } from './store/characters';
import { createConversationSlice } from './store/conversations';
import { createLifecycleSlice } from './store/lifecycle';
import { createMemorySlice } from './store/memories';
import { createSettingsSlice } from './store/settings';
import type { AppState } from './store/types';
import { createUsageSlice } from './store/usage';

export {
    DEFAULT_AUTO_GENERATION_MODEL,
    DEFAULT_CHAT_MODEL,
    DEFAULT_DIRECTOR_MODEL,
    DEFAULT_EXPRESSION_DETECTION_MODEL,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_MEMORY_EMBEDDING_MODEL,
    DEFAULT_MEMORY_EXTRACTION_MODEL,
    DEFAULT_REPLY_SUGGESTION_MODEL,
    DEFAULT_SUMMARY_MODEL,
    DEFAULT_TITLE_GENERATION_MODEL,
    getDefaultModelDefaults,
} from './modelDefaults';
export {
    DEFAULT_AI_API_TYPE,
    DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    DEFAULT_OPENAI_COMPATIBLE_EMBEDDINGS_ENABLED,
    DEFAULT_OPENAI_COMPATIBLE_IMAGE_GENERATION_ENABLED,
    DEFAULT_OPENROUTER_IGNORED_PROVIDERS,
    type AiApiConfig,
    type AiApiType,
} from './aiApi';
export {
    CURRENT_AI_SETTINGS_SCHEMA_VERSION,
    CURRENT_ONBOARDING_VERSION,
} from './store/lifecycle';
export {
    DEFAULT_CHARACTER_MAX_HISTORY,
    DEFAULT_CHARACTER_MAX_CHARACTERS,
    DEFAULT_CHARACTER_TEMPERATURE,
    DEFAULT_CHARACTER_TOP_K,
    DEFAULT_CHARACTER_TOP_P,
    DEFAULT_CHARACTER_FREQUENCY_PENALTY,
    DEFAULT_CHARACTER_PRESENCE_PENALTY,
    DEFAULT_CHARACTER_REPETITION_PENALTY,
    DEFAULT_CONVERSATION_COMPRESSION_ENABLED,
    THEME_LS_KEY,
    getThemeClassName,
} from './store/settings';
export { resolveSituationParticipants } from './store/situations';
export {
    DEFAULT_KEYBOARD_SHORTCUTS,
    getKeyboardShortcutLabels,
    keyboardShortcutListEquals,
    type KeyboardShortcut,
    type KeyboardShortcutAction,
    type KeyboardShortcutSettings,
} from './keyboardShortcuts';
export type {
    AddMemoryOptions,
    Character,
    Costume,
    CreateSituationInput,
    Expression,
    FullJsonDebugLog,
    MemoryKind,
    MemoryRecord,
    MemoryScope,
    MemorySearchParams,
    Message,
    Room,
    RoomCompressionSnapshot,
    RoomReplySuggestions,
    Situation,
    SituationActor,
    SituationDirector,
    SituationMemoryMode,
    SituationParticipant,
    SituationPriorMessage,
    SummaryRevision,
    ThemeMode,
    ThemePalette,
    UsageRecord,
    VnTypingSpeed,
} from './store/types';

export const useStore = create<AppState>()((set, get) => ({
    ...createSettingsSlice(set, get),
    ...createCharacterSlice(set, get),
    ...createMemorySlice(set, get),
    ...createConversationSlice(set, get),
    ...createUsageSlice(set, get),
    ...createBackupSlice(set, get),
    ...createLifecycleSlice(set, get),
}));
