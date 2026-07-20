import { forwardRef, type ImgHTMLAttributes } from 'react';
import { resolveStoredImageUrl } from '@/lib/imageSource';

type StoredImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
    src?: string;
};

const StoredImage = forwardRef<HTMLImageElement, StoredImageProps>(function StoredImage(props, ref) {
    const {
        alt = '',
        src,
        decoding = 'async',
        loading = 'lazy',
        ...imageProps
    } = props;

    return (
        <img
            ref={ref}
            alt={alt}
            src={src ? resolveStoredImageUrl(src) : undefined}
            decoding={decoding}
            loading={loading}
            {...imageProps}
        />
    );
});

export default StoredImage;
