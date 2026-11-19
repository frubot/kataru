// アプリ画面に注入し、タイトルバーの表示に必要な状態を伝える。
(() => {
  if (window.top !== window) return;
  // 画面側で、タイトルバーと重なる操作（サイドバーの開閉ボタンなど）を出し分けるための目印。
  window.kataruDesktop = true;
  // ウインドウの切り替えでフォーカスが移ったら、アクティブ状態を確認し直してもらう。
  window.addEventListener('focus', () => window.ipc.postMessage('activation'));
  window.addEventListener('blur', () => window.ipc.postMessage('activation'));

  // ブラウザ既定のコンテキストメニューは出さない。入力欄の編集メニューは画面側で表示する。
  window.addEventListener('contextmenu', (event) => event.preventDefault());

  // テーマはhtml要素のclassで切り替わる。
  const properties = {
    bg: '--bg-primary',
    text: '--text-primary',
    muted: '--text-muted',
    border: '--border-color',
    hover: '--bg-hover',
  };
  let lastReported = '';
  const report = () => {
    const style = getComputedStyle(document.documentElement);
    const theme = {};
    for (const [name, property] of Object.entries(properties)) {
      theme[name] = style.getPropertyValue(property).trim();
    }
    const message = JSON.stringify(theme);
    if (message === lastReported) return;
    lastReported = message;
    window.ipc.postMessage(`theme:${message}`);
  };
  const start = () => {
    report();
    new MutationObserver(report).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
