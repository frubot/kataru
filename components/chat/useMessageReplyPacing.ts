import { useLayoutEffect, useRef, useState } from 'react';
import {
    describeReplyPacing,
    stepReplyPacing,
    type ReplyPacingState,
    type ReplyPacingView,
} from '@/lib/messageReplyPacing';

type UseMessageReplyPacingOptions = {
    enabled: boolean;
    epochKey: string;
    bubbleLengths: readonly number[];
    isLoading: boolean;
};

function sameView(left: ReplyPacingView, right: ReplyPacingView): boolean {
    return left.epochKey === right.epochKey
        && left.revealedCount === right.revealedCount
        && left.readVisible === right.readVisible
        && left.typingVisible === right.typingVisible
        && left.holding === right.holding;
}

/** メッセージモードの返信を人が打つような間で見せる。詳細は `lib/messageReplyPacing.ts`。 */
export function useMessageReplyPacing({
    enabled,
    epochKey,
    bubbleLengths,
    isLoading,
}: UseMessageReplyPacingOptions): ReplyPacingView {
    const stateRef = useRef<ReplyPacingState | null>(null);
    const [view, setView] = useState<ReplyPacingView | null>(null);
    const [tick, setTick] = useState(0);
    const lengthsKey = bubbleLengths.join(',');

    // 描画前に進めて、吹き出しが一瞬見えてから隠れるのを防ぐ。
    useLayoutEffect(() => {
        if (!enabled) {
            stateRef.current = null;
            setView(null);
            return;
        }
        const input = {
            epochKey,
            bubbleLengths: lengthsKey === '' ? [] : lengthsKey.split(',').map(Number),
            isLoading,
        };
        const now = Date.now();
        const { state, wakeAt } = stepReplyPacing(stateRef.current, input, now);
        stateRef.current = state;
        const next = describeReplyPacing(state, input, now);
        setView((current) => (current && sameView(current, next) ? current : next));
        if (wakeAt === null) return;
        const timer = setTimeout(() => setTick((value) => value + 1), Math.max(0, wakeAt - now));
        return () => clearTimeout(timer);
    }, [enabled, epochKey, isLoading, lengthsKey, tick]);

    // 返信のまとまりが変わった直後の描画では、前の状態を使わずにすべて見せる。
    if (!enabled || !view || view.epochKey !== epochKey) {
        return {
            epochKey,
            revealedCount: bubbleLengths.length,
            readVisible: true,
            typingVisible: false,
            holding: false,
        };
    }
    return view;
}
