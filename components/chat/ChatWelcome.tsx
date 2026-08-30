import { Menu, Sparkles } from 'lucide-react';

type ChatWelcomeProps = {
    isMobile: boolean;
    onOpenSidebar: () => void;
    onCreateCharacter: () => void;
};

export default function ChatWelcome({ isMobile, onOpenSidebar, onCreateCharacter }: ChatWelcomeProps) {
    return (
        <div className="chat-container">
            <div className="chat-header mobile-only">
                {isMobile && (
                    <button
                        type="button"
                        className="btn btn-ghost mobile-sidebar-trigger"
                        onClick={onOpenSidebar}
                        title="サイドバーを開く"
                        aria-label="サイドバーを開く"
                    >
                        <Menu size={20} />
                    </button>
                )}
                <span style={{ fontWeight: 500 }}>Kataru</span>
                <div style={{ width: 36 }} />
            </div>
            <div className="empty-state">
                <Sparkles size={64} className="empty-state-icon" />
                <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                    会話をはじめよう
                </h2>
                <button type="button" className="btn btn-primary" onClick={onCreateCharacter}>
                    キャラクターを作る
                </button>
            </div>
        </div>
    );
}
