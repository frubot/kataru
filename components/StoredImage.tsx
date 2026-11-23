import { forwardRef, type ImgHTMLAttributes } from 'react';
import { resolveStoredImageUrl } from '@/lib/imageSource';
import { isAllowedMarkdownImageSource } from '@/lib/imageSourcePolicy';

type StoredImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
    src?: string;
};

/** 外部画像の読み込みを止めたときに出す文言。 */
const BLOCKED_IMAGE_LABEL = '外部画像は表示されません';

const StoredImage = forwardRef<HTMLImageElement, StoredImageProps>(function StoredImage(props, ref) {
    const {
        alt = '',
        src,
        decoding = 'async',
        loading = 'lazy',
        ...imageProps
    } = props;

    // 旧データには外部URLが残っている可能性があるため、描画前に許可リストで判定する。
    // そのまま描画すると外部サイトへ自動リクエストが飛び、IPアドレスや会話内容の漏えいにつながる。
    const resolvedSrc = src && isAllowedMarkdownImageSource(src) ? resolveStoredImageUrl(src) : undefined;
    const blocked = Boolean(src) && !resolvedSrc;

    return (
        <img
            ref={ref}
            alt={blocked ? alt || BLOCKED_IMAGE_LABEL : alt}
            src={resolvedSrc}
            decoding={decoding}
            loading={loading}
            {...(blocked ? { title: BLOCKED_IMAGE_LABEL } : {})}
            {...imageProps}
        />
    );
});

export default StoredImage;
