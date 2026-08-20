import { useEffect, useEffectEvent } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const openModalStack: symbol[] = [];

function isVisible(element: HTMLElement): boolean {
    return element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.getAttribute('aria-hidden') !== 'true' && isVisible(element));
}

function isTopModal(token: symbol): boolean {
    return openModalStack.at(-1) === token;
}

function removeFromStack(token: symbol) {
    const index = openModalStack.lastIndexOf(token);
    if (index >= 0) openModalStack.splice(index, 1);
}

export function isModalEnterSubmitTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (!target.closest('[data-modal-enter-submit="true"]')) return false;
    return target.tagName !== 'TEXTAREA'
        && target.tagName !== 'SELECT'
        && !target.isContentEditable;
}

type UseModalKeyboardOptions = {
    isOpen: boolean;
    containerRef: RefObject<HTMLElement | null>;
    onClose: () => void;
    canClose?: boolean;
    initialFocusRef?: RefObject<HTMLElement | null>;
    onEnter?: () => void;
};

/**
 * Keeps keyboard focus inside the foremost modal, closes it with Escape, restores the
 * launcher's focus, and optionally handles Enter on explicitly marked controls.
 */
export function useModalKeyboard({
    isOpen,
    containerRef,
    onClose,
    canClose = true,
    initialFocusRef,
    onEnter,
}: UseModalKeyboardOptions) {
    const closeLatest = useEffectEvent(onClose);
    const canCloseLatest = useEffectEvent(() => canClose);
    const submitLatest = useEffectEvent(() => onEnter?.());
    const hasEnterHandlerLatest = useEffectEvent(() => onEnter != null);

    useEffect(() => {
        if (!isOpen) return;

        const token = Symbol('modal');
        const previouslyFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        openModalStack.push(token);

        const focusFrame = requestAnimationFrame(() => {
            if (!isTopModal(token)) return;
            const container = containerRef.current;
            if (!container) return;
            const target = initialFocusRef?.current
                ?? container.querySelector<HTMLElement>('[autofocus]')
                ?? getFocusableElements(container)[0]
                ?? container;
            if (target === container && !container.hasAttribute('tabindex')) {
                container.setAttribute('tabindex', '-1');
            }
            target.focus({ preventScroll: true });
        });

        const handleKeyDown = (event: KeyboardEvent) => {
            if (!isTopModal(token)) return;
            if (event.defaultPrevented) return;
            const container = containerRef.current;
            if (!container) return;

            if (event.key === 'Escape' && canCloseLatest()) {
                event.preventDefault();
                event.stopPropagation();
                closeLatest();
                return;
            }

            if (event.key === 'Enter'
                && !event.shiftKey
                && !event.ctrlKey
                && !event.metaKey
                && !event.altKey
                && !event.isComposing
                && hasEnterHandlerLatest()
                && isModalEnterSubmitTarget(event.target)) {
                event.preventDefault();
                submitLatest();
                return;
            }

            if (event.key !== 'Tab') return;
            const focusable = getFocusableElements(container);
            if (focusable.length === 0) {
                event.preventDefault();
                if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
                container.focus({ preventScroll: true });
                return;
            }

            const activeElement = document.activeElement;
            const activeIndex = focusable.indexOf(activeElement as HTMLElement);
            if (event.shiftKey && (activeIndex <= 0 || !container.contains(activeElement))) {
                event.preventDefault();
                focusable.at(-1)?.focus({ preventScroll: true });
            } else if (!event.shiftKey && (activeIndex === focusable.length - 1 || activeIndex < 0)) {
                event.preventDefault();
                focusable[0].focus({ preventScroll: true });
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            cancelAnimationFrame(focusFrame);
            document.removeEventListener('keydown', handleKeyDown);
            removeFromStack(token);
            requestAnimationFrame(() => {
                if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
            });
        };
    }, [containerRef, initialFocusRef, isOpen]);
}
