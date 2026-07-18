export default function AppSkeleton() {
    return (
        <main
            style={{
                display: 'flex',
                height: '100vh',
                overflow: 'hidden',
                background: 'var(--bg-primary)',
            }}
            aria-busy="true"
            aria-label="読み込み中"
        >
            <aside
                style={{
                    width: 280,
                    borderRight: '1px solid var(--border-color)',
                    background: 'var(--bg-secondary)',
                    padding: '1rem 0.75rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                }}
                className="desktop-only"
            >
                <SkeletonLine width="60%" height={20} />
                <SkeletonLine width="100%" height={36} />
                <div style={{ height: 12 }} />
                {Array.from({ length: 6 }).map((_, i) => (
                    <SkeletonLine key={i} width="100%" height={28} />
                ))}
            </aside>
            <section
                style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    padding: '1rem',
                    gap: '0.75rem',
                }}
            >
                <SkeletonLine width="40%" height={24} />
                <div style={{ flex: 1 }} />
                <SkeletonLine width="100%" height={46} />
            </section>
        </main>
    );
}

function SkeletonLine({ width, height }: { width: string | number; height: number }) {
    return (
        <div
            style={{
                width,
                height,
                borderRadius: 8,
                background: 'var(--bg-hover)',
            }}
        />
    );
}
