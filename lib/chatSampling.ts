import type { ChatSampling } from './store/types';

export interface ChatSamplingParam {
    label: string;
    hint: string;
    min: number;
    max: number;
    step: number;
    /** 未設定のときにスライダーへ表示する値。 */
    defaultValue: number;
}

export type ChatSamplingKey = keyof ChatSampling;

/** 会話生成の生成パラメータ。全体設定で1組だけ持つ。 */
export const CHAT_SAMPLING_PARAMS: Record<ChatSamplingKey, ChatSamplingParam> = {
    temperature: { label: 'Temperature', hint: '値が高いほどランダム性が増します', min: 0, max: 2, step: 0.001, defaultValue: 0.8 },
    topP: { label: 'Top P', hint: '核サンプリングの確率閾値', min: 0, max: 1, step: 0.001, defaultValue: 1 },
    topK: { label: 'Top K', hint: '上位K個の候補からサンプリング。0で無効。OpenRouter、Anthropic API、ローカルのOpenAI互換サーバー（llama.cppなど）で有効です。', min: 0, max: 100, step: 1, defaultValue: 0 },
    minP: { label: 'Min P', hint: '最も確率の高い候補に対する比率がこの値未満の候補を除外します。0で無効。OpenRouterとローカルのOpenAI互換サーバー（llama.cppなど）の対応モデルのみ有効です。', min: 0, max: 1, step: 0.001, defaultValue: 0 },
    frequencyPenalty: { label: 'Frequency Penalty', hint: '出現回数に応じて同じ語句の繰り返しを抑えます。0で無効、負の値で繰り返しを促します。対応モデルのみ有効で、Anthropic APIでは使用しません。', min: -2, max: 2, step: 0.001, defaultValue: 0 },
    presencePenalty: { label: 'Presence Penalty', hint: '一度出現した語句の再使用を抑えます。0で無効、負の値で再使用を促します。対応モデルのみ有効で、Anthropic APIでは使用しません。', min: -2, max: 2, step: 0.001, defaultValue: 0 },
    repetitionPenalty: { label: 'Repetition Penalty', hint: '1で無効、1より大きい値で繰り返しを抑え、1未満で促します。OpenRouterとローカルのOpenAI互換サーバー（llama.cppなど）の対応モデルのみ有効です。', min: 0, max: 2, step: 0.001, defaultValue: 1 },
};

export const CHAT_SAMPLING_KEYS = Object.keys(CHAT_SAMPLING_PARAMS) as ChatSamplingKey[];

/** 保存値を検証する。範囲外は丸め、数値でない項目は未設定として捨てる。 */
export function normalizeChatSampling(value: unknown): ChatSampling {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const sampling: ChatSampling = {};
    for (const key of CHAT_SAMPLING_KEYS) {
        const raw = record[key];
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        const param = CHAT_SAMPLING_PARAMS[key];
        const clamped = Math.max(param.min, Math.min(param.max, raw));
        sampling[key] = param.step >= 1 ? Math.round(clamped) : clamped;
    }
    return sampling;
}
