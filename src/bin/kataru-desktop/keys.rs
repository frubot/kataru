//! メニューから、編集や拡大縮小のキーボードショートカットを送る。
//!
//! 貼り付けなどはWebViewのスクリプトから実行できないため、キー入力としてアプリ画面に送る。

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
    VK_CONTROL, VK_OEM_MINUS, VK_OEM_PLUS,
};

/// メニューから送れるショートカット。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shortcut {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    ZoomIn,
    ZoomOut,
    ZoomReset,
}

impl Shortcut {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "undo" => Self::Undo,
            "redo" => Self::Redo,
            "cut" => Self::Cut,
            "copy" => Self::Copy,
            "paste" => Self::Paste,
            "select-all" => Self::SelectAll,
            "zoom-in" => Self::ZoomIn,
            "zoom-out" => Self::ZoomOut,
            "zoom-reset" => Self::ZoomReset,
            _ => return None,
        })
    }

    /// Ctrlと組み合わせるキー。
    fn key(self) -> VIRTUAL_KEY {
        match self {
            Self::Undo => VIRTUAL_KEY::from(b'Z'),
            Self::Redo => VIRTUAL_KEY::from(b'Y'),
            Self::Cut => VIRTUAL_KEY::from(b'X'),
            Self::Copy => VIRTUAL_KEY::from(b'C'),
            Self::Paste => VIRTUAL_KEY::from(b'V'),
            Self::SelectAll => VIRTUAL_KEY::from(b'A'),
            Self::ZoomIn => VK_OEM_PLUS,
            Self::ZoomOut => VK_OEM_MINUS,
            Self::ZoomReset => VIRTUAL_KEY::from(b'0'),
        }
    }

    /// 前面のウインドウ（フォーカス中のアプリ画面）へCtrl+キーを送る。
    pub fn send(self) {
        let inputs = [
            key_input(VK_CONTROL, false),
            key_input(self.key(), false),
            key_input(self.key(), true),
            key_input(VK_CONTROL, true),
        ];
        // SAFETY: inputsは呼び出し中有効な配列で、要素数と要素サイズを正しく渡している。
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            );
        }
    }
}

fn key_input(key: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
