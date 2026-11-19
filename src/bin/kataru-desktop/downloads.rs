//! アプリ画面からのダウンロード（キャラクターの共有やバックアップ）の完了を画面に知らせる。
//!
//! wryは既定でダウンロードを処理済みにするため、WebView2標準のダウンロード表示は出ない。

use std::{ffi::OsString, os::windows::process::CommandExt, path::PathBuf, process::Command};

use serde_json::json;
use wry::WebView;

use crate::title_bar::emit_to_app_view;

/// 完了したダウンロードのうち、最後に保存できたファイル。
#[derive(Default)]
pub struct Downloads {
    last_saved: Option<PathBuf>,
}

impl Downloads {
    /// ダウンロードの結果を記録し、アプリ画面に通知する。
    pub fn finished(&mut self, view: Option<&WebView>, path: Option<PathBuf>, success: bool) {
        let path = path.filter(|_| success);
        let file_name = path
            .as_ref()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned());
        if path.is_some() {
            self.last_saved = path;
        }
        if let Some(view) = view {
            emit_to_app_view(
                view,
                &json!({
                    "type": "download-finished",
                    "success": success,
                    "fileName": file_name,
                }),
            );
        }
    }

    /// 最後に保存したファイルを、エクスプローラーで選択した状態で開く。
    pub fn reveal_last(&self) {
        let Some(path) = self.last_saved.as_ref().filter(|path| path.exists()) else {
            return;
        };
        // Windowsのパスに `"` は含まれないため、そのまま引用符で囲める。
        let mut argument = OsString::from("/select,\"");
        argument.push(path);
        argument.push("\"");
        if let Err(error) = Command::new("explorer.exe").raw_arg(argument).spawn() {
            tracing::warn!(%error, "failed to reveal downloaded file");
        }
    }
}
