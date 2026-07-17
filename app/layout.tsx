import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Kataru',
    description: 'A simple roleplay chat application using OpenRouter or OpenAI-compatible APIs',
    robots: {
        index: false,
        follow: false,
    },
};

export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
};

const THEME_INIT_SCRIPT = `(function(){try{var key='kataru-theme';var raw=localStorage.getItem(key)||'';if(!raw){raw=localStorage.getItem('roleplay-gui-theme')||'';if(raw)localStorage.setItem(key,raw)}var a=raw.split(':');var m=a[0];var p=a[1];var okM=m==='light'||m==='dark';var okP=p==='classic'||p==='sakura'||p==='sage'||p==='sky'||p==='amber'||p==='mono';document.documentElement.className='mode-'+(okM?m:'dark')+' palette-'+(okP?p:'classic')}catch(_){document.documentElement.className='mode-dark palette-classic'}})();`;

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="ja" suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
            </head>
            <body className="antialiased">
                {children}
            </body>
        </html>
    );
}
