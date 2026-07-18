import { useState, useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useStore, Character, getThemeClassName, resolveSituationParticipants } from '@/lib/store';
import ChatSidebar from '@/components/ChatSidebar';
import ChatWindow from '@/components/ChatWindow';
import GlobalSettingsModal from '@/components/GlobalSettingsModal';
import CharacterSettingsModal from '@/components/CharacterSettingsModal';
import MemoryListModal from '@/components/MemoryListModal';
import ErrorBoundary from '@/components/ErrorBoundary';
import AppSkeleton from '@/components/AppSkeleton';

const HYDRATE_TIMEOUT_MS = 15_000;

function formatHydrationError(error: unknown): string {
    if (error instanceof DOMException) {
        return `${error.name}: ${error.message}`;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return '保存データの読み込みに失敗しました';
}

function HydrationErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <main
            style={{
                minHeight: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
                background: 'var(--bg-primary)',
                color: 'var(--text-primary)',
            }}
        >
            <section
                className="card"
                style={{
                    width: 'min(100%, 520px)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.875rem',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                    <AlertTriangle size={22} style={{ color: 'var(--error)' }} />
                    <h1 style={{ fontSize: '1rem', fontWeight: 600 }}>
                        データを読み込めませんでした
                    </h1>
                </div>
                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                    インポート後の読み込みに失敗しました。データは残っている可能性があります。
                    まず「もう一度読み込む」を押してください。直らない場合は、ページを再読み込みしてください。
                </p>
                <p
                    style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        wordBreak: 'break-word',
                        lineHeight: 1.6,
                    }}
                >
                    {message}
                </p>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" onClick={onRetry}>
                        <RefreshCw size={16} />
                        もう一度読み込む
                    </button>
                    <button className="btn btn-secondary" onClick={() => window.location.reload()}>
                        ページを再読み込み
                    </button>
                </div>
            </section>
        </main>
    );
}

export default function Home() {
    const { themeMode, themePalette, groups, rooms, characters, currentRoomId, hydrated, hydrate, defaultChatModel } = useStore();
    const [showSettings, setShowSettings] = useState(false);
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
    const [mounted, setMounted] = useState(false);
    const [hydrateError, setHydrateError] = useState<string | null>(null);
    const [hydrateAttempt, setHydrateAttempt] = useState(0);

    // Character settings modal state
    const [characterModalOpen, setCharacterModalOpen] = useState(false);
    const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
    const [isNewCharacter, setIsNewCharacter] = useState(false);

    // Memory list modal state
    const [memoryListOpen, setMemoryListOpen] = useState(false);
    const [memoryCharacter, setMemoryCharacter] = useState<Character | null>(null);

    useEffect(() => {
        let cancelled = false;
        const timeoutId = window.setTimeout(() => {
            if (!cancelled && !useStore.getState().hydrated) {
                setHydrateError('読み込みに時間がかかっています。もう一度読み込むか、ページを再読み込みしてください。');
            }
        }, HYDRATE_TIMEOUT_MS);

        setMounted(true);
        setHydrateError(null);
        hydrate()
            .then(() => {
                if (!cancelled) setHydrateError(null);
            })
            .catch((error) => {
                console.error('[hydrate]', error);
                if (!cancelled) setHydrateError(formatHydrationError(error));
            })
            .finally(() => {
                window.clearTimeout(timeoutId);
            });

        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [hydrate, hydrateAttempt]);

    useEffect(() => {
        if (mounted && hydrated) {
            document.documentElement.className = getThemeClassName(themeMode, themePalette);
        }
    }, [themeMode, themePalette, mounted, hydrated]);

    const currentRoom = rooms.find((r) => r.id === currentRoomId) || null;
    const currentSituation = currentRoom?.groupId
        ? groups.find((g) => g.id === currentRoom.groupId) || null
        : null;
    const isSituation = currentSituation != null;
    const currentCharacter = currentRoom
        ? characters.find((c) => c.id === currentRoom.characterId) || null
        : null;
    const situationParticipants = isSituation && currentSituation
        ? resolveSituationParticipants(currentSituation, characters, defaultChatModel)
        : null;

    const handleOpenCharacterSettings = (character: Character | null, isNew: boolean) => {
        setEditingCharacter(character);
        setIsNewCharacter(isNew);
        setCharacterModalOpen(true);
    };

    const handleCloseCharacterSettings = () => {
        setCharacterModalOpen(false);
        setEditingCharacter(null);
        setIsNewCharacter(false);
    };

    const handleOpenMemoryList = (character?: Character | null) => {
        setMemoryCharacter(character || currentCharacter);
        setMemoryListOpen(true);
    };

    if (!mounted || (!hydrated && !hydrateError)) {
        return <AppSkeleton />;
    }

    if (!hydrated && hydrateError) {
        return (
            <HydrationErrorScreen
                message={hydrateError}
                onRetry={() => {
                    setHydrateError(null);
                    setHydrateAttempt((attempt) => attempt + 1);
                }}
            />
        );
    }

    return (
        <main className={`app-layout ${desktopSidebarOpen ? '' : 'sidebar-collapsed'}`}>
            <ErrorBoundary fallbackMessage="サイドバーでエラーが発生しました">
                <ChatSidebar
                    onOpenSettings={() => setShowSettings(true)}
                    onOpenCharacterSettings={handleOpenCharacterSettings}
                    isOpen={mobileSidebarOpen}
                    isDesktopOpen={desktopSidebarOpen}
                    onClose={() => setMobileSidebarOpen(false)}
                    onToggleDesktop={() => setDesktopSidebarOpen((open) => !open)}
                />
            </ErrorBoundary>
            <ErrorBoundary fallbackMessage="チャット画面でエラーが発生しました">
                <ChatWindow
                    room={currentRoom}
                    character={currentCharacter}
                    situation={currentSituation}
                    groupName={currentSituation?.name ?? (isSituation ? currentRoom?.name : undefined)}
                    groupCharacters={situationParticipants}
                    onOpenSidebar={() => setMobileSidebarOpen(true)}
                    onOpenMemoryList={handleOpenMemoryList}
                />
            </ErrorBoundary>
            <ErrorBoundary>
                <GlobalSettingsModal
                    isOpen={showSettings}
                    onClose={() => setShowSettings(false)}
                />
            </ErrorBoundary>
            <ErrorBoundary>
                <CharacterSettingsModal
                    isOpen={characterModalOpen}
                    onClose={handleCloseCharacterSettings}
                    character={editingCharacter}
                    isNew={isNewCharacter}
                    onOpenMemoryList={() => handleOpenMemoryList(editingCharacter)}
                />
            </ErrorBoundary>
            <ErrorBoundary>
                <MemoryListModal
                    isOpen={memoryListOpen}
                    onClose={() => setMemoryListOpen(false)}
                    character={memoryCharacter}
                />
            </ErrorBoundary>
        </main>
    );
}
