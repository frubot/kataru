use std::{
    env,
    net::{IpAddr, Ipv6Addr, SocketAddr},
    path::PathBuf,
};

use directories::ProjectDirs;

use crate::error::{AppError, AppResult};

pub const DEFAULT_PORT: u16 = 37371;
pub const DEFAULT_HOST: &str = "127.0.0.1";

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub database_path: PathBuf,
    pub open_browser: bool,
    pub development_origin: Option<String>,
}

impl Config {
    pub fn from_args() -> AppResult<Self> {
        let project_dirs = ProjectDirs::from("", "", "Kataru").ok_or_else(|| {
            AppError::Internal("ユーザーデータ保存先を決定できませんでした。".to_owned())
        })?;
        let mut host = DEFAULT_HOST.to_owned();
        let mut port = DEFAULT_PORT;
        let mut data_dir = project_dirs.data_local_dir().to_path_buf();
        let mut open_browser = false;
        let mut development_origin = None;

        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--host" => {
                    host = args.next().ok_or_else(|| {
                        AppError::BadRequest("--host には値が必要です。".to_owned())
                    })?;
                }
                "--port" => {
                    let value = args.next().ok_or_else(|| {
                        AppError::BadRequest("--port には値が必要です。".to_owned())
                    })?;
                    port = value.parse().map_err(|_| {
                        AppError::BadRequest(format!("不正なポート番号です: {value}"))
                    })?;
                    if port == 0 {
                        return Err(AppError::BadRequest(
                            "ポート番号には1以上を指定してください。".to_owned(),
                        ));
                    }
                }
                "--data-dir" => {
                    let value = args.next().ok_or_else(|| {
                        AppError::BadRequest("--data-dir には値が必要です。".to_owned())
                    })?;
                    data_dir = PathBuf::from(value);
                }
                "--portable" => {
                    let executable = env::current_exe()?;
                    data_dir = executable
                        .parent()
                        .ok_or_else(|| {
                            AppError::Internal(
                                "実行ファイルの保存先を取得できませんでした。".to_owned(),
                            )
                        })?
                        .join("kataru-data");
                }
                "--open" => open_browser = true,
                "--no-open" => open_browser = false,
                "--dev-origin" => {
                    let value = args.next().ok_or_else(|| {
                        AppError::BadRequest("--dev-origin には値が必要です。".to_owned())
                    })?;
                    let address = value
                        .strip_prefix("http://")
                        .and_then(|authority| authority.parse::<SocketAddr>().ok())
                        .ok_or_else(|| {
                            AppError::BadRequest(
                                "--dev-origin は http://<loopback IP>:<port> 形式で指定してください。"
                                    .to_owned(),
                            )
                        })?;
                    if !address.ip().is_loopback() {
                        return Err(AppError::BadRequest(
                            "--dev-origin にはloopbackアドレスだけを指定できます。".to_owned(),
                        ));
                    }
                    development_origin = Some(value);
                }
                "--help" | "-h" => {
                    println!(
                        "Kataru\n\n  version, --version, -V 現在のバージョンを表示\n  update                 最新版を確認して自動更新\n\n  --host <HOST>          待受ホスト（既定: {DEFAULT_HOST}）\n  --port <PORT>          待受ポート（既定: {DEFAULT_PORT}）\n  --data-dir <PATH>      データ保存先\n  --portable             実行ファイル横の kataru-data を使用\n  --open                 ブラウザを自動で開く\n  --no-open              ブラウザを自動で開かない\n  --dev-origin <ORIGIN>  開発UI用のloopbackオリジンを許可"
                    );
                    std::process::exit(0);
                }
                _ => {
                    return Err(AppError::BadRequest(format!("未対応の引数です: {arg}")));
                }
            }
        }
        std::fs::create_dir_all(&data_dir)?;
        Ok(Self {
            host,
            port,
            database_path: data_dir.join("kataru.db"),
            open_browser,
            development_origin,
        })
    }

    pub fn bind_address(&self) -> (&str, u16) {
        (&self.host, self.port)
    }

    pub fn authority(&self) -> String {
        if self.host.parse::<Ipv6Addr>().is_ok() {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    pub fn is_wildcard_host(&self) -> bool {
        self.host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_unspecified())
    }

    pub fn origin(&self) -> String {
        format!("http://{}", self.authority())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(host: &str) -> Config {
        Config {
            host: host.to_owned(),
            port: DEFAULT_PORT,
            database_path: PathBuf::from("kataru.db"),
            open_browser: false,
            development_origin: None,
        }
    }

    #[test]
    fn hostnames_and_ipv6_have_valid_authorities() {
        assert_eq!(config("localhost").authority(), "localhost:37371");
        assert_eq!(config("::1").authority(), "[::1]:37371");
    }

    #[test]
    fn only_unspecified_ip_addresses_are_wildcards() {
        assert!(config("0.0.0.0").is_wildcard_host());
        assert!(config("::").is_wildcard_host());
        assert!(!config("localhost").is_wildcard_host());
        assert!(!config("192.168.1.20").is_wildcard_host());
    }
}
