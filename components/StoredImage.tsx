import { forwardRef, type ImgHTMLAttributes } from 'react';

type StoredImageProps = ImgHTMLAttributes<HTMLImageElement>;

const StoredImage = forwardRef<HTMLImageElement, StoredImageProps>(function StoredImage(props, ref) {
    const { alt = '', ...imageProps } = props;

    // Stored/generated images are already local data URLs or previews.
    return <img ref={ref} alt={alt} {...imageProps} />;
});

export default StoredImage;
