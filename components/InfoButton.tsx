import { useState } from 'react';
import { Info } from 'lucide-react';

export interface InfoButtonProps {
    text: string;
    ariaLabel?: string;
}

export default function InfoButton({ text, ariaLabel = '説明を表示' }: InfoButtonProps) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <button
                type="button"
                aria-label={ariaLabel}
                aria-expanded={isOpen}
                title={ariaLabel}
                onClick={(e) => {
                    e.stopPropagation();
                    setIsOpen((prev) => !prev);
                }}
                onBlur={() => setIsOpen(false)}
                style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    border: '1px solid var(--border-color)',
                    background: isOpen ? 'rgba(var(--accent-primary-rgb), 0.12)' : 'var(--bg-secondary)',
                    color: isOpen ? 'var(--accent-primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                    flexShrink: 0,
                }}
            >
                <Info size={13} />
            </button>
            {isOpen && (
                <span
                    role="tooltip"
                    style={{
                        position: 'absolute',
                        top: 'calc(100% + 0.375rem)',
                        left: 0,
                        zIndex: 30,
                        width: 'min(240px, 70vw)',
                        padding: '0.625rem 0.75rem',
                        borderRadius: '0.5rem',
                        border: '1px solid var(--border-color)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-secondary)',
                        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
                        fontSize: '0.75rem',
                        lineHeight: 1.5,
                        fontWeight: 400,
                        textAlign: 'left',
                        whiteSpace: 'normal',
                    }}
                >
                    {text}
                </span>
            )}
        </span>
    );
}
