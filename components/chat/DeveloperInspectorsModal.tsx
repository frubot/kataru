import { useEffect, useRef, useState } from 'react';
import { Brain, FileText, X } from 'lucide-react';

import type { Room } from '@/lib/store';
import { useModalKeyboard } from '@/components/useModalKeyboard';
import MemoryInspectorPanel from './MemoryInspectorPanel';
import SummaryInspectorPanel from './SummaryInspectorPanel';

type InspectorTab = 'memory' | 'summary';

type DeveloperInspectorsModalProps = {
    room: Room;
    memoryEnabled: boolean;
    summaryEnabled: boolean;
    onClose: () => void;
};

function enabledTabs(memoryEnabled: boolean, summaryEnabled: boolean): InspectorTab[] {
    return [
        ...(memoryEnabled ? ['memory' as const] : []),
        ...(summaryEnabled ? ['summary' as const] : []),
    ];
}

export default function DeveloperInspectorsModal({
    room,
    memoryEnabled,
    summaryEnabled,
    onClose,
}: DeveloperInspectorsModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);
    const tabs = enabledTabs(memoryEnabled, summaryEnabled);
    const [activeTab, setActiveTab] = useState<InspectorTab>(tabs[0] ?? 'memory');
    useEffect(() => {
        if (!tabs.includes(activeTab) && tabs[0]) setActiveTab(tabs[0]);
    }, [activeTab, tabs]);
    useModalKeyboard({ isOpen: true, containerRef: modalRef, onClose });

    return (
        <div className="modal-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <div
                ref={modalRef}
                className="modal-content settings-form-modal"
                onClick={(event) => event.stopPropagation()}
                style={{ maxWidth: 900 }}
                role="dialog"
                aria-modal="true"
                aria-label="開発者インスペクター"
            >
                <div className="settings-form-modal-actions">
                    <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="閉じる" title="閉じる">
                        <X size={20} />
                    </button>
                </div>
                <div className="modal-body">
                    <div role="tablist" aria-label="インスペクター" style={{ display: 'flex', gap: '0.375rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        {memoryEnabled && (
                            <button type="button" role="tab" aria-selected={activeTab === 'memory'} className={`btn ${activeTab === 'memory' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('memory')}>
                                <Brain size={15} />メモリ
                            </button>
                        )}
                        {summaryEnabled && (
                            <button type="button" role="tab" aria-selected={activeTab === 'summary'} className={`btn ${activeTab === 'summary' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setActiveTab('summary')}>
                                <FileText size={15} />要約
                            </button>
                        )}
                    </div>
                    {activeTab === 'memory' && memoryEnabled && <MemoryInspectorPanel room={room} />}
                    {activeTab === 'summary' && summaryEnabled && <SummaryInspectorPanel room={room} />}
                </div>
            </div>
        </div>
    );
}
