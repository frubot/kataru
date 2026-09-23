import { Menu } from 'lucide-react';

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
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 500 }}>
                    <img src="/logo.png" alt="" style={{ height: 24, width: 'auto' }} />
                    Kataru
                </span>
                <div style={{ width: 36 }} />
            </div>
            <div className="empty-state">
                <img
                    src="/logo.png"
                    alt="Kataru"
                    className="empty-state-icon"
                    style={{ width: 'auto', height: 72, opacity: 0.9 }}
                />
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
