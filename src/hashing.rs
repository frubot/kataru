//! ハッシュ値の16進表記ユーティリティ。

use sha2::{Digest, Sha256};

/// バイト列のSHA-256を小文字16進文字列で返す。
pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
