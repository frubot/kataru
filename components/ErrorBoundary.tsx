'use client';

import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
    children: React.ReactNode;
    fallbackMessage?: string;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('ErrorBoundary caught:', error, errorInfo);
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '2rem',
                    gap: '1rem',
                    height: '100%',
                    minHeight: '200px',
                }}>
                    <AlertTriangle size={40} style={{ color: 'var(--error, #ef4444)' }} />
                    <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                        {this.props.fallbackMessage || 'コンポーネントでエラーが発生しました'}
                    </p>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: '400px', textAlign: 'center' }}>
                        {this.state.error?.message}
                    </p>
                    <button
                        className="btn btn-secondary"
                        onClick={this.handleReset}
                        style={{ gap: '0.375rem' }}
                    >
                        <RefreshCw size={14} />
                        再試行
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
