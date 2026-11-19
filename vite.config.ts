import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('.', import.meta.url)),
        },
    },
    server: {
        host: '127.0.0.1',
        port: 3000,
        strictPort: true,
        watch: { ignored: ['**/target/**'] },
        proxy: {
            '/api': {
                // 開発用サーバーは通常版と同時に起動できるよう別ポートで待ち受ける。
                target: 'http://127.0.0.1:37372',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'out',
        emptyOutDir: true,
    },
});
