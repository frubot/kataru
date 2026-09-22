import type { VnTypingSpeed } from './store/types';
import {
    alignVisualNovelTypedContent,
    buildVisualNovelTypingSegments,
    getVisualNovelTypingDelay,
} from './visualNovelPresentation';

export type VisualNovelTypingSnapshot = {
    messageId: string | null;
    content: string;
    active: boolean;
};

type TypingRun = {
    messageId: string;
    fullContent: string;
    finished: Promise<void>;
    resolve: () => void;
};

/** A page can gain sentences while its already received text is still being typed. */
export class VisualNovelTypewriter {
    private snapshot: VisualNovelTypingSnapshot = { messageId: null, content: '', active: false };
    private targetContent = '';
    private run: TypingRun | null = null;
    private delay: { timeout: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;

    constructor(
        private readonly onChange: (snapshot: VisualNovelTypingSnapshot) => void,
        private speed: VnTypingSpeed,
    ) {}

    setSpeed(speed: VnTypingSpeed) {
        this.speed = speed;
    }

    private publish(messageId: string | null, content: string, active: boolean) {
        this.snapshot = { messageId, content, active };
        this.onChange(this.snapshot);
    }

    private cancel() {
        const run = this.run;
        this.run = null;
        if (this.delay) {
            clearTimeout(this.delay.timeout);
            this.delay.resolve();
            this.delay = null;
        }
        run?.resolve();
        return run;
    }

    stop(revealFull: boolean): boolean {
        const run = this.cancel();
        if (run || !revealFull) {
            this.publish(revealFull && run ? run.messageId : null, revealFull && run ? run.fullContent : '', false);
        }
        return run != null;
    }

    dispose() {
        this.cancel();
    }

    play(messageId: string, fullContent: string, incremental = false): Promise<void> {
        const content = incremental && this.snapshot.messageId === messageId
            ? alignVisualNovelTypedContent(this.targetContent, fullContent, this.snapshot.content)
            : '';
        this.targetContent = fullContent;
        if (incremental && this.run?.messageId === messageId) {
            this.run.fullContent = fullContent;
            this.publish(messageId, content, true);
            return this.run.finished;
        }
        this.cancel();
        if (!fullContent || content === fullContent) {
            this.publish(messageId, fullContent, false);
            return Promise.resolve();
        }
        let resolve!: () => void;
        const finished = new Promise<void>((done) => { resolve = done; });
        const run = { messageId, fullContent, finished, resolve };
        this.run = run;
        this.publish(messageId, content, true);
        void this.type(run);
        return finished;
    }

    private async type(run: TypingRun) {
        while (this.run === run) {
            let end = 0;
            const next = buildVisualNovelTypingSegments(run.fullContent).find((segment) => {
                end += segment.length;
                return end > this.snapshot.content.length;
            });
            if (!next) break;
            this.publish(run.messageId, run.fullContent.slice(0, end), true);
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    this.delay = null;
                    resolve();
                }, getVisualNovelTypingDelay(next, this.speed));
                this.delay = { timeout, resolve };
            });
        }
        if (this.run !== run) return;
        this.run = null;
        this.publish(run.messageId, run.fullContent, false);
        run.resolve();
    }
}
