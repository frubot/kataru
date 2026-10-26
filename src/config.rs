use std::{
    env,
    net::{IpAddr, Ipv6Addr, SocketAddr},
    path::PathBuf,
};

use directories::ProjectDirs;

use crate::error::{AppError, AppResult};

pub const DEFAULT_PORT: u16 = 37371;
pub const DEFAULT_HOST: &str = "127.0.0.1";

pub fn default_data_dir() -> AppResult<PathBuf> {
    ProjectDirs::from("", "", "Kataru")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .ok_or_else(|| {
            AppError::Internal("ユーザーデータ保存先を決定できませんでした。".to_owned())
        })
}

pub fn portable_data_dir() -> AppResult<PathBuf> {
    let executable = env::current_exe()?;
    executable
        .parent()
        .map(|parent| parent.join("kataru-data"))
        .ok_or_else(|| {
            AppError::Internal("実行ファイルの保存先を取得できませんでした。".to_owned())
        })
}

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub open_browser: bool,
    pub development_origin: Option<String>,
    /// `--token` で固定したアクセストークン。未指定ならデータディレクトリの値を使う。
    pub fixed_token: Option<String>,
    pub auth_disabled: bool,
}

/// `--host` に指定できるのはIPアドレスか `localhost` だけ。
///
/// 0.0.0.0 / :: のような全アドレス待受は、意図せずLAN全体へ公開されるため拒否する。
/// 任意のホスト名も、名前解決で全アドレスを指す抜け道になるため受け付けない。
pub fn validate_host(host: &str) -> AppResult<()> {
    if host.eq_ignore_ascii_case("localhost") {
        return Ok(());
    }
    let address = host.parse::<IpAddr>().map_err(|_| {
        AppError::BadRequest(format!(
            "--host にはIPアドレスか localhost を指定してください: {host}"
        ))
    })?;
    if address.to_canonical().is_unspecified() {
        return Err(AppError::BadRequest(
            "--host に 0.0.0.0 / :: は指定できません。LANから使う場合はこのPCのIPアドレスを指定してください。"
                .to_owned(),
        ));
    }
    Ok(())
}

pub fn parse_port(value: &str) -> AppResult<u16> {
    let port = value
        .parse::<u16>()
        .map_err(|_| AppError::BadRequest(format!("不正なポート番号です: {value}")))?;
    if port == 0 {
        return Err(AppError::BadRequest(
            "ポート番号には1以上を指定してください。".to_owned(),
        ));
    }
    Ok(port)
}

impl Config {
    pub fn from_args() -> AppResult<Self> {
        let mut host = DEFAULT_HOST.to_owned();
        let mut port = DEFAULT_PORT;
        let mut data_dir = default_data_dir()?;
        let mut open_browser = true;
        let mut development_origin = None;
        let mut fixed_token = None;
        let mut auth_disabled = false;

        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--host" => {
                    host = args.next().ok_or_else(|| {
                        AppError::BadRequest("--host には値が必要です。".to_owned())
                    })?;
                    validate_host(&host)?;
                }
                "--port" => {
                    let value = args.next().ok_or_else(|| {
                        AppError::BadRequest("--port には値が必要です。".to_owned())
                    })?;
                    port = parse_port(&value)?;
                }
                "--data-dir" => {
                    let value = args.next().ok_or_else(|| {
                        AppError::BadRequest("--data-dir には値が必要です。".to_owned())
                    })?;
                    data_dir = PathBuf::from(value);
                }
                "--portable" => {
                    data_dir = portable_data_dir()?;
                }
                "--no-open" => open_browser = false,
                "--token" => {
                    let value = args.next().ok_or_else(|| {
                        AppError::BadRequest("--token には値が必要です。".to_owned())
                    })?;
                    crate::auth::validate_token(&value)?;
                    fixed_token = Some(value);
                }
                "--no-auth" => auth_disabled = true,
                "--verbose" => {}
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
                        "Kataru\n\n  version, --version, -V 現在のバージョンを表示\n  update                 最新版を確認して自動更新\n  config                 AI接続設定を表示・変更\n  models                 モデル一覧キャッシュを更新\n  doctor                 DB・設定・AI疎通を一括診断\n\n  --host <HOST>          待受ホスト（既定: {DEFAULT_HOST}）\n  --port <PORT>          待受ポート（既定: {DEFAULT_PORT}）\n  --data-dir <PATH>      データ保存先\n  --portable             実行ファイル横の kataru-data を使用\n  --no-open              ブラウザを自動で開かない\n  --dev-origin <ORIGIN>  開発UI用のloopbackオリジンを許可\n  --verbose              詳細な診断ログを出力\n\n  環境変数は .env ファイルからも読み込めます\n  （カレントディレクトリと実行ファイルの隣を順に探索。OSの環境変数が優先）"
                    );
                    std::process::exit(0);
                }
                _ => {
                    return Err(AppError::BadRequest(format!("未対応の引数です: {arg}")));
                }
            }
        }
        if auth_disabled && !is_loopback_host(&host) {
            return Err(AppError::BadRequest(
                "--no-auth はloopbackアドレスで待ち受けるときだけ指定できます。".to_owned(),
            ));
        }
        if auth_disabled && fixed_token.is_some() {
            return Err(AppError::BadRequest(
                "--no-auth と --token は同時に指定できません。".to_owned(),
            ));
        }
        std::fs::create_dir_all(&data_dir)?;
        Ok(Self {
            host,
            port,
            data_dir: data_dir.clone(),
            database_path: data_dir.join("kataru.db"),
            open_browser,
            development_origin,
            fixed_token,
            auth_disabled,
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

    pub fn origin(&self) -> String {
        origin_for(&self.host, self.port)
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.to_canonical().is_loopback())
}

pub fn origin_for(host: &str, port: u16) -> String {
    if host.parse::<Ipv6Addr>().is_ok() {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(host: &str) -> Config {
        Config {
            host: host.to_owned(),
            port: DEFAULT_PORT,
            data_dir: PathBuf::from("."),
            database_path: PathBuf::from("kataru.db"),
            open_browser: false,
            development_origin: None,
            fixed_token: None,
            auth_disabled: false,
        }
    }

    #[test]
    fn hostnames_and_ipv6_have_valid_authorities() {
        assert_eq!(config("localhost").authority(), "localhost:37371");
        assert_eq!(config("::1").authority(), "[::1]:37371");
    }

    #[test]
    fn wildcard_and_hostname_hosts_are_rejected() {
        assert!(validate_host("0.0.0.0").is_err());
        assert!(validate_host("::").is_err());
        assert!(validate_host("::ffff:0.0.0.0").is_err());
        assert!(validate_host("example.com").is_err());
        assert!(validate_host("127.0.0.1").is_ok());
        assert!(validate_host("192.168.1.20").is_ok());
        assert!(validate_host("::1").is_ok());
        assert!(validate_host("LocalHost").is_ok());
    }

    #[test]
    fn only_loopback_hosts_count_as_loopback() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(!is_loopback_host("192.168.1.20"));
    }
}
