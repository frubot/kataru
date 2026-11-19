//! 枠なしウインドウに表示する独自のタイトルバー。アプリ画面とは別のWebViewで描画する。

use serde_json::{Map, Value, json};
use tao::{
    event_loop::EventLoopProxy,
    window::{ResizeDirection, Window},
};
use wry::{
    Rect, WebContext, WebView, WebViewBuilder,
    dpi::{LogicalPosition, LogicalSize},
};

use crate::UserEvent;
use crate::keys::Shortcut;

/// タイトルバーの高さ（論理ピクセル）。
const HEIGHT: f64 = 40.0;
const HTML: &str = include_str!("title_bar.html");
/// アプリ画面に注入し、テーマ色やメニュー操作をタイトルバー側へ送るスクリプト。
pub const APP_VIEW_SCRIPT: &str = include_str!("app_view.js");
const THEME_MESSAGE_PREFIX: &str = "theme:";
const ACTIVATION_MESSAGE: &str = "activation";
const THEME_KEYS: [&str; 5] = ["bg", "text", "muted", "border", "hover"];
const MAX_THEME_VALUE_LENGTH: usize = 200;
/// テーマ受信前の背景色。既定テーマの `--bg-primary` に合わせる。
const DEFAULT_BACKGROUND: (u8, u8, u8, u8) = (0x0f, 0x11, 0x17, 0xff);

/// タイトルバーのメニュー。中身はアプリ画面側で表示する。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Menu {
    Edit,
    View,
    Help,
}

impl Menu {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "edit" => Self::Edit,
            "view" => Self::View,
            "help" => Self::Help,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::View => "view",
            Self::Help => "help",
        }
    }
}

/// タイトルバーから届く操作。
#[derive(Debug, PartialEq)]
pub enum Command {
    Ready,
    /// どちらかのWebViewのフォーカスが変わった。
    ActivationChanged,
    Drag,
    Minimize,
    ToggleMaximize,
    Close,
    Resize(ResizeDirection),
    ToggleSidebar,
    /// メニューを開く。`left` はタイトルバー上のボタンの左端（論理ピクセル）。
    OpenMenu {
        menu: Menu,
        left: f64,
    },
    CloseMenu,
}

impl Command {
    fn parse(message: &str) -> Option<Self> {
        if let Some(rest) = message.strip_prefix("menu:") {
            let (name, left) = rest.split_once(':')?;
            let left: f64 = left.parse().ok()?;
            return (left.is_finite() && left >= 0.0).then_some(Self::OpenMenu {
                menu: Menu::parse(name)?,
                left,
            });
        }
        Some(match message {
            "ready" => Self::Ready,
            ACTIVATION_MESSAGE => Self::ActivationChanged,
            "drag" => Self::Drag,
            "minimize" => Self::Minimize,
            "toggle-maximize" => Self::ToggleMaximize,
            "close" => Self::Close,
            "resize-n" => Self::Resize(ResizeDirection::North),
            "resize-nw" => Self::Resize(ResizeDirection::NorthWest),
            "resize-ne" => Self::Resize(ResizeDirection::NorthEast),
            "toggle-sidebar" => Self::ToggleSidebar,
            "menu-close" => Self::CloseMenu,
            _ => return None,
        })
    }
}

/// アプリ画面から届いたメッセージのうち、デスクトップ版で扱うもの。
#[derive(Debug, PartialEq)]
pub enum AppViewMessage {
    Theme(String),
    ActivationChanged,
    MenuClosed,
    Shortcut(Shortcut),
    /// 最後にダウンロードしたファイルをエクスプローラーで表示する。
    RevealDownload,
}

impl AppViewMessage {
    fn parse(message: &str) -> Option<Self> {
        if let Some(name) = message.strip_prefix("shortcut:") {
            return Shortcut::parse(name).map(Self::Shortcut);
        }
        match message {
            ACTIVATION_MESSAGE => Some(Self::ActivationChanged),
            "menu-closed" => Some(Self::MenuClosed),
            "reveal-download" => Some(Self::RevealDownload),
            _ => parse_theme_message(message).map(Self::Theme),
        }
    }
}

pub struct TitleBar {
    view: WebView,
    /// 検証済みのテーマJSON。タイトルバーの読み込み完了後にも送り直す。
    theme: Option<String>,
}

impl TitleBar {
    pub fn build(
        window: &Window,
        web_context: &mut WebContext,
        proxy: EventLoopProxy<UserEvent>,
    ) -> Result<Self, wry::Error> {
        let view = WebViewBuilder::new_with_web_context(web_context)
            .with_html(HTML)
            .with_bounds(title_bar_bounds(window))
            .with_background_color(DEFAULT_BACKGROUND)
            .with_ipc_handler(move |request| {
                if let Some(command) = Command::parse(request.body()) {
                    let _ = proxy.send_event(UserEvent::TitleBar(command));
                }
            })
            .build_as_child(window)?;
        Ok(Self { view, theme: None })
    }

    /// ウインドウの大きさに合わせてタイトルバーの位置を更新し、最大化状態を反映する。
    pub fn layout(&self, window: &Window) {
        let _ = self.view.set_bounds(title_bar_bounds(window));
        self.call(&format!("setMaximized({})", window.is_maximized()));
    }

    /// ウインドウがアクティブかどうかを確認し、文字色に反映する。アクティブかどうかを返す。
    ///
    /// フォーカスがWebView側にあると親ウインドウのFocusedはfalseになるため、前面のウインドウで判定する。
    pub fn update_active(&self, window: &Window) -> bool {
        let active = is_foreground(window);
        self.call(&format!("setActive({active})"));
        active
    }

    pub fn set_theme(&mut self, theme: String) {
        self.call(&format!("setTheme({theme})"));
        self.theme = Some(theme);
    }

    /// アプリ画面側でメニューが閉じたことを反映する。
    pub fn clear_open_menu(&self) {
        self.call("setOpenMenu(null)");
    }

    /// 読み込み完了時に、それまでに受け取った状態をまとめて反映する。
    pub fn sync(&self, window: &Window) {
        if let Some(theme) = &self.theme {
            self.call(&format!("setTheme({theme})"));
        }
        self.layout(window);
        self.update_active(window);
    }

    fn call(&self, expression: &str) {
        let _ = self
            .view
            .evaluate_script(&format!("window.titleBar?.{expression}"));
    }
}

/// アプリ画面のWebViewを作る設定を加える。
pub fn configure_app_view<'a>(
    builder: WebViewBuilder<'a>,
    window: &Window,
    proxy: EventLoopProxy<UserEvent>,
) -> WebViewBuilder<'a> {
    let download_proxy = proxy.clone();
    builder
        .with_bounds(app_bounds(window))
        .with_initialization_script(APP_VIEW_SCRIPT)
        .with_hotkeys_zoom(true)
        .with_download_completed_handler(move |_url, path, success| {
            let _ = download_proxy.send_event(UserEvent::DownloadFinished { path, success });
        })
        .with_ipc_handler(move |request| {
            if let Some(message) = AppViewMessage::parse(request.body()) {
                let _ = proxy.send_event(UserEvent::AppView(message));
            }
        })
}

/// アプリ画面へ、タイトルバーの操作を通知する。
pub fn emit_to_app_view(view: &WebView, detail: &Value) {
    let _ = view.evaluate_script(&format!(
        "window.dispatchEvent(new CustomEvent('kataru-desktop', {{ detail: {detail} }}))"
    ));
}

pub fn toggle_sidebar(view: &WebView) {
    emit_to_app_view(view, &json!({ "type": "toggle-sidebar" }));
}

/// アプリ画面にメニューを開かせる。位置は物理ピクセルで渡し、アプリ画面側で拡大率に合わせて換算する。
pub fn open_menu(view: &WebView, window: &Window, menu: Menu, left: f64) {
    emit_to_app_view(
        view,
        &json!({
            "type": "open-menu",
            "menu": menu.name(),
            "left": left * window.scale_factor(),
        }),
    );
}

pub fn close_menu(view: &WebView) {
    emit_to_app_view(view, &json!({ "type": "close-menu" }));
}

fn is_foreground(window: &Window) -> bool {
    use tao::platform::windows::WindowExtWindows;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    // SAFETY: 引数を取らず、前面のウインドウハンドル（またはnull）を返すだけ。
    let foreground = unsafe { GetForegroundWindow() };
    foreground as isize == window.hwnd()
}

/// アプリ画面を表示する領域（タイトルバーの下）。
pub fn app_bounds(window: &Window) -> Rect {
    let (width, height) = logical_inner_size(window);
    Rect {
        position: LogicalPosition::new(0.0, HEIGHT).into(),
        size: LogicalSize::new(width, (height - HEIGHT).max(0.0)).into(),
    }
}

fn title_bar_bounds(window: &Window) -> Rect {
    let (width, _) = logical_inner_size(window);
    Rect {
        position: LogicalPosition::new(0.0, 0.0).into(),
        size: LogicalSize::new(width, HEIGHT).into(),
    }
}

fn logical_inner_size(window: &Window) -> (f64, f64) {
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    (size.width, size.height)
}

/// アプリ画面から届いたテーマ通知を検証し、タイトルバーへ渡せるJSONにする。
///
/// 値はスクリプトとして評価されるため、既知のキーの文字列だけを再シリアライズする。
fn parse_theme_message(message: &str) -> Option<String> {
    let body = message.strip_prefix(THEME_MESSAGE_PREFIX)?;
    let received: Map<String, Value> = serde_json::from_str(body).ok()?;
    let theme: Map<String, Value> = THEME_KEYS
        .iter()
        .filter_map(|key| {
            let value = received.get(*key)?.as_str()?;
            (!value.is_empty() && value.len() <= MAX_THEME_VALUE_LENGTH)
                .then(|| ((*key).to_owned(), Value::String(value.to_owned())))
        })
        .collect();
    (!theme.is_empty()).then(|| Value::Object(theme).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_parsed_from_known_messages_only() {
        assert_eq!(Command::parse("drag"), Some(Command::Drag));
        assert_eq!(
            Command::parse("resize-ne"),
            Some(Command::Resize(ResizeDirection::NorthEast))
        );
        assert_eq!(
            Command::parse("menu:view:52.5"),
            Some(Command::OpenMenu {
                menu: Menu::View,
                left: 52.5
            })
        );
        assert_eq!(Command::parse("menu:file:0"), None);
        assert_eq!(Command::parse("menu:edit:NaN"), None);
        assert_eq!(Command::parse("menu:edit:-1"), None);
        assert_eq!(Command::parse("resize-s"), None);
        assert_eq!(Command::parse("eval"), None);
    }

    #[test]
    fn app_view_messages_are_parsed_from_known_messages_only() {
        assert_eq!(
            AppViewMessage::parse("shortcut:paste"),
            Some(AppViewMessage::Shortcut(Shortcut::Paste))
        );
        assert_eq!(
            AppViewMessage::parse("menu-closed"),
            Some(AppViewMessage::MenuClosed)
        );
        assert_eq!(
            AppViewMessage::parse("reveal-download"),
            Some(AppViewMessage::RevealDownload)
        );
        assert_eq!(AppViewMessage::parse("shortcut:alt-f4"), None);
        assert_eq!(AppViewMessage::parse("close"), None);
    }

    #[test]
    fn theme_message_keeps_only_known_string_values() {
        let theme = parse_theme_message(
            r##"theme:{"bg":"#fff","text":"</script>","evil":"x","border":1,"muted":""}"##,
        )
        .expect("valid theme");
        assert_eq!(theme, r##"{"bg":"#fff","text":"</script>"}"##);
        assert_eq!(parse_theme_message(r#"theme:{"evil":"x"}"#), None);
        assert_eq!(parse_theme_message("theme:alert(1)"), None);
        assert_eq!(parse_theme_message(r##"{"bg":"#fff"}"##), None);
    }
}
