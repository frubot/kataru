import type { NextConfig } from "next";

const productionConfig: NextConfig = {
    output: 'export',
    images: {
        unoptimized: true,
    },
};

const developmentConfig: NextConfig = {
    images: {
        unoptimized: true,
    },
    async rewrites() {
        return [
            {
                source: '/api/:path*',
                destination: 'http://127.0.0.1:37371/api/:path*',
            },
        ];
    },
};

const nextConfig = process.env.NODE_ENV === 'development'
    ? developmentConfig
    : productionConfig;

export default nextConfig;
