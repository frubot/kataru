export default function WaitingEllipsis({ className }: { className?: string }) {
    const classes = className ? `waiting-ellipsis ${className}` : 'waiting-ellipsis';

    return (
        <span className={classes} role="status" aria-live="polite" aria-label="返答中…">
            <span className="waiting-ellipsis-dots" aria-hidden="true">
                <span className="waiting-ellipsis-dot">.</span>
                <span className="waiting-ellipsis-dot">.</span>
                <span className="waiting-ellipsis-dot">.</span>
            </span>
        </span>
    );
}
