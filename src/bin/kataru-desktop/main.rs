//! Kataruのデスクトップ版。サーバーを同じプロセスで起動し、ネイティブウインドウのWebViewで画面を表示する。

// 開発用のデバッグビルドでは、ログを見られるようにコンソールを残す。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
use std::path::PathBuf;
use std::{
    io::ErrorKind,
    thread,
    time::{Duration, Instant},
};

use kataru::{AppError, Config, Server};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy},
    window::{Window, WindowBuilder},
};
use tokio::{runtime::Runtime, sync::oneshot};
use wry::{NewWindowResponse, WebContext, WebView, WebViewBuilder};

#[cfg(windows)]
mod downloads;
#[cfg(windows)]
mod keys;
#[cfg(windows)]
mod title_bar;

/// 二重起動時に既存のウインドウを探すためのクラス名。
#[cfg(windows)]
const WINDOW_CLASS: &str = "KataruDesktopWindow";
/// 開発版のクラス名。通常版と同時に起動しても、互いのウインドウを前面に出さないよう分ける。
#[cfg(windows)]
const DEVELOPMENT_WINDOW_CLASS: &str = "KataruDesktopDevelopmentWindow";
/// ウインドウを閉じてから、処理中のリクエストを待つ最大時間。
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
/// 終了処理中・起動処理中の既存インスタンスとポートが競合したときに待つ最大時間。
const BIND_RETRY_TIMEOUT: Duration = Duration::from_secs(6);

enum UserEvent {
    ServerStopped(Result<(), String>),
    ForceExit,
    #[cfg(windows)]
    TitleBar(title_bar::Command),
    #[cfg(windows)]
    AppView(title_bar::AppViewMessage),
    #[cfg(windows)]
    DownloadFinished {
        path: Option<PathBuf>,
        success: bool,
    },
}

fn main() {
    kataru::update::set_asset_prefix("kataru-desktop");
    if let Err(message) = run() {
        show_error(&message);
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Kataruを起動できませんでした: {error}"))?;
    kataru::init_process();
    // 自動更新の適用処理は、ダウンロードした新しい実行ファイル自身が内部コマンドとして行う。
    if runtime
        .block_on(kataru::update::run_special_command_if_requested())
        .map_err(|error| error.to_string())?
    {
        return Ok(());
    }

    let config = Config::from_args().map_err(|error| error.to_string())?;
    let Some(server) = bind_or_focus_existing(&runtime, &config)? else {
        return Ok(());
    };
    let launch_url = server.launch_url().to_owned();
    let mut app_origins = vec![config.origin()];
    app_origins.extend(config.development_origin.clone());

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let (shutdown_sender, shutdown_receiver) = oneshot::channel::<()>();
    {
        let proxy = proxy.clone();
        runtime.spawn(async move {
            let result = server
                .serve(async {
                    let _ = shutdown_receiver.await;
                })
                .await
                .map_err(|error| error.to_string());
            let _ = proxy.send_event(UserEvent::ServerStopped(result));
        });
    }

    let window = build_window(&event_loop, config.development_origin.is_some())?;
    let mut web_context = WebContext::new(Some(config.data_dir.join("webview")));
    #[cfg(windows)]
    let mut title_bar = title_bar::TitleBar::build(&window, &mut web_context, proxy.clone())
        .map_err(webview_error)?;
    let mut webview = Some(build_webview(
        &window,
        &mut web_context,
        &launch_url,
        app_origins,
        proxy.clone(),
    )?);
    let mut shutdown_sender = Some(shutdown_sender);
    #[cfg(windows)]
    let mut downloads = downloads::Downloads::default();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let close_requested = matches!(
            event,
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            }
        );
        #[cfg(windows)]
        let close_requested = close_requested
            || matches!(
                event,
                Event::UserEvent(UserEvent::TitleBar(title_bar::Command::Close))
            );
        if close_requested {
            // WebViewを先に破棄して接続を切り、サーバーの終了待ちが長引かないようにする。
            window.set_visible(false);
            webview.take();
            if let Some(sender) = shutdown_sender.take() {
                let _ = sender.send(());
            }
            let proxy = proxy.clone();
            thread::spawn(move || {
                thread::sleep(SHUTDOWN_TIMEOUT);
                let _ = proxy.send_event(UserEvent::ForceExit);
            });
            return;
        }
        match event {
            // 画面からの更新要求でもサーバーが止まるため、そのときもウインドウを閉じて終了する。
            Event::UserEvent(UserEvent::ServerStopped(result)) => {
                if let Err(message) = result {
                    show_error(&format!("Kataruのサーバーが停止しました: {message}"));
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::ForceExit) => *control_flow = ControlFlow::Exit,
            #[cfg(windows)]
            Event::WindowEvent {
                event: WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. },
                ..
            } => {
                title_bar.layout(&window);
                if let Some(view) = &webview {
                    let _ = view.set_bounds(title_bar::app_bounds(&window));
                }
            }
            #[cfg(windows)]
            Event::WindowEvent {
                event: WindowEvent::Focused(_),
                ..
            } => update_activation(&window, &title_bar, webview.as_ref()),
            #[cfg(windows)]
            Event::UserEvent(UserEvent::TitleBar(command)) => {
                handle_title_bar_command(command, &window, &title_bar, webview.as_ref());
            }
            #[cfg(windows)]
            Event::UserEvent(UserEvent::AppView(message)) => {
                handle_app_view_message(
                    message,
                    &window,
                    &mut title_bar,
                    &downloads,
                    webview.as_ref(),
                );
            }
            #[cfg(windows)]
            Event::UserEvent(UserEvent::DownloadFinished { path, success }) => {
                downloads.finished(webview.as_ref(), path, success);
            }
            _ => {}
        }
    });
}

/// アクティブ状態をタイトルバーに反映する。ほかのウインドウへ移ったら、開いているメニューも閉じる。
#[cfg(windows)]
fn update_activation(window: &Window, title_bar: &title_bar::TitleBar, app_view: Option<&WebView>) {
    if !title_bar.update_active(window)
        && let Some(view) = app_view
    {
        title_bar::close_menu(view);
    }
}

#[cfg(windows)]
fn handle_title_bar_command(
    command: title_bar::Command,
    window: &Window,
    title_bar: &title_bar::TitleBar,
    app_view: Option<&WebView>,
) {
    use title_bar::Command;

    match command {
        Command::Ready => title_bar.sync(window),
        Command::ActivationChanged => update_activation(window, title_bar, app_view),
        Command::Drag => {
            let _ = window.drag_window();
        }
        Command::Minimize => window.set_minimized(true),
        Command::ToggleMaximize => window.set_maximized(!window.is_maximized()),
        Command::Resize(direction) => {
            let _ = window.drag_resize_window(direction);
        }
        Command::ToggleSidebar => {
            if let Some(view) = app_view {
                title_bar::toggle_sidebar(view);
            }
        }
        Command::OpenMenu { menu, left } => {
            if let Some(view) = app_view {
                title_bar::open_menu(view, window, menu, left);
            }
        }
        Command::CloseMenu => {
            if let Some(view) = app_view {
                title_bar::close_menu(view);
            }
        }
        // 閉じる操作はイベントループの先頭で処理している。
        Command::Close => {}
    }
}

#[cfg(windows)]
fn handle_app_view_message(
    message: title_bar::AppViewMessage,
    window: &Window,
    title_bar: &mut title_bar::TitleBar,
    downloads: &downloads::Downloads,
    app_view: Option<&WebView>,
) {
    use title_bar::AppViewMessage;

    match message {
        AppViewMessage::Theme(theme) => title_bar.set_theme(theme),
        AppViewMessage::ActivationChanged => update_activation(window, title_bar, app_view),
        AppViewMessage::MenuClosed => title_bar.clear_open_menu(),
        AppViewMessage::Shortcut(shortcut) => {
            // メニューの項目を押した時点でアプリ画面にフォーカスは戻っているが、確実に戻してから送る。
            if let Some(view) = app_view {
                let _ = view.focus();
            }
            shortcut.send();
        }
        AppViewMessage::RevealDownload => downloads.reveal_last(),
    }
}

/// ポートを確保する。すでにデスクトップ版が起動していれば、そのウインドウを前面に出して `None` を返す。
fn bind_or_focus_existing(runtime: &Runtime, config: &Config) -> Result<Option<Server>, String> {
    let deadline = Instant::now() + BIND_RETRY_TIMEOUT;
    loop {
        match runtime.block_on(Server::bind(config)) {
            Ok(server) => return Ok(Some(server)),
            Err(AppError::Io(error)) if error.kind() == ErrorKind::AddrInUse => {
                if focus_existing_window(config.development_origin.is_some()) {
                    return Ok(None);
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "ポート{}が使用中のため起動できませんでした。ブラウザ版のKataruを起動している場合は終了してから開いてください。",
                        config.port
                    ));
                }
                thread::sleep(Duration::from_millis(200));
            }
            Err(error) => return Err(format!("Kataruを起動できませんでした: {error}")),
        }
    }
}

fn build_window(event_loop: &EventLoop<UserEvent>, development: bool) -> Result<Window, String> {
    let builder = WindowBuilder::new()
        .with_title(if development {
            "Kataru（開発版）"
        } else {
            "Kataru"
        })
        .with_inner_size(LogicalSize::new(1280.0, 820.0))
        .with_min_inner_size(LogicalSize::new(480.0, 600.0));
    #[cfg(windows)]
    let builder = {
        use tao::platform::windows::{IconExtWindows, WindowBuilderExtWindows};
        // build.rsで実行ファイルに埋め込んだアイコン（リソースID 1）を使う。
        let icon = tao::window::Icon::from_resource(1, None).ok();
        // タイトルバーは独自に描画する。影を残すと、左右と下の縁はOS標準の方法でリサイズできる。
        builder
            .with_window_classname(window_class(development))
            .with_window_icon(icon)
            .with_decorations(false)
            .with_undecorated_shadow(true)
    };
    builder
        .build(event_loop)
        .map_err(|error| format!("ウインドウを作成できませんでした: {error}"))
}

fn build_webview(
    window: &Window,
    web_context: &mut WebContext,
    launch_url: &str,
    app_origins: Vec<String>,
    #[cfg_attr(not(windows), allow(unused_variables))] proxy: EventLoopProxy<UserEvent>,
) -> Result<WebView, String> {
    let builder = WebViewBuilder::new_with_web_context(web_context)
        .with_url(launch_url)
        .with_devtools(cfg!(debug_assertions))
        // アプリ外のページはWebView内で開かず、既定のブラウザに渡す。
        .with_navigation_handler(move |url| {
            if is_external_web_url(&url, &app_origins) {
                open_in_browser(&url);
                return false;
            }
            true
        })
        .with_new_window_req_handler(|url, _features| {
            if url.starts_with("http://") || url.starts_with("https://") {
                open_in_browser(&url);
            }
            NewWindowResponse::Deny
        });

    #[cfg(target_os = "linux")]
    let result = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let container = window
            .default_vbox()
            .ok_or_else(|| "ウインドウを作成できませんでした。".to_owned())?;
        builder.build_gtk(container)
    };
    #[cfg(windows)]
    let result = title_bar::configure_app_view(builder, window, proxy).build_as_child(window);
    #[cfg(not(any(windows, target_os = "linux")))]
    let result = builder.build(window);

    result.map_err(webview_error)
}

fn webview_error(error: wry::Error) -> String {
    if cfg!(windows) {
        format!(
            "画面を表示できませんでした。Microsoft Edge WebView2ランタイムがインストールされているか確認してください。\n\n{error}"
        )
    } else {
        format!("画面を表示できませんでした: {error}")
    }
}

/// アプリ画面のオリジン（開発版ではVite開発サーバーも含む）以外のWebページかどうか。
fn is_external_web_url(url: &str, app_origins: &[String]) -> bool {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    !app_origins.iter().any(|origin| {
        url.strip_prefix(origin.as_str())
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '?', '#']))
    })
}

fn open_in_browser(url: &str) {
    if let Err(error) = webbrowser::open(url) {
        tracing::warn!(%error, "failed to open external link");
    }
}

#[cfg(windows)]
fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn window_class(development: bool) -> &'static str {
    if development {
        DEVELOPMENT_WINDOW_CLASS
    } else {
        WINDOW_CLASS
    }
}

/// 表示中のデスクトップ版ウインドウがあれば前面に出す。
#[cfg(windows)]
fn focus_existing_window(development: bool) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, IsIconic, IsWindowVisible, SW_RESTORE, SetForegroundWindow, ShowWindow,
    };

    let class_name = to_wide(window_class(development));
    // SAFETY: class_nameはNUL終端済みで、呼び出し中は有効なバッファを指している。
    let window = unsafe { FindWindowW(class_name.as_ptr(), std::ptr::null()) };
    // SAFETY: windowはFindWindowWが返したハンドルで、各APIは無効なハンドルに対して失敗を返すだけ。
    unsafe {
        if window.is_null() || IsWindowVisible(window) == 0 {
            return false;
        }
        if IsIconic(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        }
        SetForegroundWindow(window);
    }
    true
}

#[cfg(not(windows))]
fn focus_existing_window(_development: bool) -> bool {
    false
}

#[cfg(windows)]
fn show_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};

    let text = to_wide(message);
    let caption = to_wide("Kataru");
    // SAFETY: どちらの文字列もNUL終端済みで、呼び出し中は有効なバッファを指している。
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_error(message: &str) {
    eprintln!("{message}");
}

#[cfg(test)]
mod tests {
    use super::is_external_web_url;

    #[test]
    fn only_other_web_origins_are_external() {
        let origins = ["http://127.0.0.1:37371".to_owned()];
        let origins = origins.as_slice();
        assert!(!is_external_web_url("http://127.0.0.1:37371/", origins));
        assert!(!is_external_web_url("http://127.0.0.1:37371", origins));
        assert!(!is_external_web_url(
            "http://127.0.0.1:37371/?token=x",
            origins
        ));
        assert!(!is_external_web_url("about:blank", origins));
        assert!(!is_external_web_url(
            "blob:http://127.0.0.1:37371/abc",
            origins
        ));
        assert!(is_external_web_url("http://127.0.0.1:373710/", origins));
        assert!(is_external_web_url("https://openrouter.ai/", origins));
    }

    #[test]
    fn development_ui_origin_is_not_external() {
        let origins = [
            "http://127.0.0.1:37372".to_owned(),
            "http://127.0.0.1:3000".to_owned(),
        ];
        assert!(!is_external_web_url("http://127.0.0.1:3000/", &origins));
        assert!(!is_external_web_url(
            "http://127.0.0.1:37372/?token=x",
            &origins
        ));
        assert!(is_external_web_url("http://127.0.0.1:30000/", &origins));
    }
}
