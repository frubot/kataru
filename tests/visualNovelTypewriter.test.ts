import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { VisualNovelTypewriter, type VisualNovelTypingSnapshot } from '../lib/visualNovelTypewriter';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function createTypewriter() {
    const frames: VisualNovelTypingSnapshot[] = [];
    const writer = new VisualNovelTypewriter((frame) => frames.push(frame), 'default');
    return { writer, frames };
}

test('reveals streamed sentences character by character and appends without resetting the timer', async () => {
    const { writer, frames } = createTypewriter();
    const first = writer.play('page', 'こんにちは。', true);
    expect(frames.at(-1)?.content).toBe('こ');
    await vi.advanceTimersByTimeAsync(12);
    const extended = writer.play('page', 'こんにちは。次の文。', true);
    expect(extended).toBe(first);
    expect(frames.at(-1)?.content).toBe('こ');
    await vi.advanceTimersByTimeAsync(12);
    expect(frames.at(-1)?.content).toBe('こん');
    await vi.runAllTimersAsync();
    await extended;
    expect(frames.at(-1)).toMatchObject({ content: 'こんにちは。次の文。', active: false });
    frames.forEach((frame, index) => {
        if (index > 0) expect(frame.content.startsWith(frames[index - 1].content)).toBe(true);
    });
});

test('resumes after waiting for another sentence and keeps emoji and actions intact', async () => {
    const { writer, frames } = createTypewriter();
    void writer.play('page', 'はい。', true);
    await vi.runAllTimersAsync();
    void writer.play('page', 'はい。😊*微笑む*続き。', true);
    expect(frames.at(-1)?.content).toBe('はい。😊');
    await vi.advanceTimersByTimeAsync(24);
    expect(frames.at(-1)?.content).toBe('はい。😊*微笑む*');
    await vi.runAllTimersAsync();
    expect(frames.at(-1)?.active).toBe(false);
});

test('continues from the read prefix when persistence removes the surrounding quotation', async () => {
    const { writer, frames } = createTypewriter();
    void writer.play('page', '「こんにちは。」', true);
    await vi.advanceTimersByTimeAsync(48);
    expect(frames.at(-1)?.content).toBe('「こん');
    void writer.play('page', 'こんにちは。', true);
    expect(frames.at(-1)?.content).toBe('こん');
    await vi.runAllTimersAsync();
    expect(frames.at(-1)).toMatchObject({ content: 'こんにちは。', active: false });
});

test('reveals the available text on skip and cancels old page updates on navigation', async () => {
    const { writer, frames } = createTypewriter();
    const skipped = writer.play('first', '最初のページ。', true);
    expect(writer.stop(true)).toBe(true);
    await skipped;
    expect(frames.at(-1)).toMatchObject({ content: '最初のページ。', active: false });
    void writer.play('first', '最初のページ。続き。', true);
    expect(frames.at(-1)?.content).toBe('最初のページ。続');
    const next = writer.play('second', '次のページ。', true);
    expect(frames.at(-1)?.content).toBe('次');
    writer.dispose();
    const count = frames.length;
    await vi.runAllTimersAsync();
    await next;
    expect(frames).toHaveLength(count);
});
