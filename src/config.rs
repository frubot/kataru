use std::{
    env,
    net::{IpAddr, Ipv6Addr, SocketAddr},
    path::PathBuf,
};

#[cfg(any(windows, test))]
use std::path::Path;

use directories::ProjectDirs;

use crate::error::{AppError, AppResult};

pub const DEFAULT_PORT: u16 = 37371;
pub const DEFAULT_HOST: &str = "127.0.0.1";

/// データディレクトリと、そこに置く機密ファイルの権限を締めるための補助。
///
/// Unixではディレクトリを `0700`、ファイルを `0600` にする。umaskが `022` の環境では
/// ディレクトリが `0755`・ファイルが `0644` になり、同じマシンの他ユーザーが会話履歴・記憶・
/// 画像・認証トークンを読めてしまうため、umaskに依存せず明示的に設定する。
///
/// WindowsにはPOSIXの権限ビットが無いため、ここでは作成だけを行う（従来の挙動を変えない）。
/// 共有フォルダ（UNCパス）などをデータ保存先にした場合は、起動時に警告する。
pub(crate) mod permissions {
    use std::{fs, io, path::Path};

    /// データディレクトリの権限。所有者だけが一覧・読み書きできる。
    #[cfg(unix)]
    const DIRECTORY_MODE: u32 = 0o700;
    /// 機密ファイルの権限。所有者だけが読み書きできる。
    #[cfg(unix)]
    const FILE_MODE: u32 = 0o600;

    /// ディレクトリを作成し、所有者だけが使える権限にする（既存なら締め直す）。
    #[cfg(unix)]
    pub(crate) fn create_private_directory(path: &Path) -> io::Result<()> {
        use std::os::unix::fs::DirBuilderExt as _;

        fs::DirBuilder::new()
            .recursive(true)
            .mode(DIRECTORY_MODE)
            .create(path)?;
        tighten_directory(path);
        Ok(())
    }

    #[cfg(not(unix))]
    pub(crate) fn create_private_directory(path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)
    }

    /// 既存のディレクトリを所有者だけが使える権限に締め直す。
    ///
    /// 権限を扱えないファイルシステム（FAT、一部のネットワークマウントなど）でも起動を
    /// 止めないよう、失敗は警告だけにする。
    #[cfg(unix)]
    pub(crate) fn tighten_directory(path: &Path) {
        use std::os::unix::fs::PermissionsExt as _;

        match fs::set_permissions(path, fs::Permissions::from_mode(DIRECTORY_MODE)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "ディレクトリの権限を制限できませんでした。");
            }
        }
    }

    /// 既存の機密ファイルを所有者だけが読み書きできる権限に締め直す。
    ///
    /// `-wal` / `-shm` のようにまだ存在しないファイルもあるため、無い場合は何もしない。
    #[cfg(unix)]
    pub(crate) fn tighten_file(path: &Path) {
        use std::os::unix::fs::PermissionsExt as _;

        match fs::set_permissions(path, fs::Permissions::from_mode(FILE_MODE)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "ファイルの権限を制限できませんでした。");
            }
        }
    }

    #[cfg(not(unix))]
    pub(crate) fn tighten_file(_path: &Path) {}

    /// これから作成するファイルを所有者だけが読み書きできる権限で作る。
    /// 作成のたびにchmodするのではなく、最初から `0600` で作るための補助。
    #[cfg(unix)]
    pub(crate) fn restrict_new_file_mode(options: &mut fs::OpenOptions) {
        use std::os::unix::fs::OpenOptionsExt as _;

        options.mode(FILE_MODE);
    }

    #[cfg(not(unix))]
    pub(crate) fn restrict_new_file_mode(_options: &mut fs::OpenOptions) {}

    /// 機密ファイルを所有者だけが読み書きできる権限で書き込む。
    ///
    /// 一時ファイルを書いて置き換える方式で使うことを想定しており、
    /// 作成したファイルは最初から `0600` になる。
    pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
        use std::io::Write as _;

        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        restrict_new_file_mode(&mut options);
        options.open(path)?.write_all(bytes)
    }
}

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

/// bind先が平文HTTPで傍受されうるときに表示する警告文。不要なら `None`。
///
/// KataruはTLSに対応しておらず、`--host` にLAN IPを指定すると通信は平文HTTPになる。
/// 同じネットワーク上の第三者は、起動URLのトークンと会話内容をそのまま傍受できる。
/// loopbackとTailscaleのアドレスは経路が外へ平文で出ないため警告しない。
pub fn plaintext_http_warning(host: &str, port: u16) -> Option<String> {
    if is_loopback_host(host) || is_tailscale_host(host) {
        return None;
    }
    Some(format!(
        "[警告] {host}:{port} の通信は暗号化されない平文HTTPです。信頼できるネットワークでのみ使用してください。\n  外出先からは Tailscale を利用してください（README.md「LAN内の端末・スマートフォンから使う場合」）。"
    ))
}

/// Tailscaleが割り当てるアドレス（100.64.0.0/10、fd7a:115c:a1e0::/48）か。
/// Tailscale上の通信はWireGuardで暗号化される。
fn is_tailscale_host(host: &str) -> bool {
    match host.parse::<IpAddr>().map(|address| address.to_canonical()) {
        Ok(IpAddr::V4(address)) => {
            let [first, second, ..] = address.octets();
            first == 100 && (64..128).contains(&second)
        }
        Ok(IpAddr::V6(address)) => {
            let segments = address.segments();
            segments[..3] == [0xfd7a, 0x115c, 0xa1e0]
        }
        Err(_) => false,
    }
}

/// bind先がloopback以外なら、平文HTTPで公開される旨を起動時に表示する。
fn warn_if_plaintext_http(host: &str, port: u16) {
    let Some(warning) = plaintext_http_warning(host, port) else {
        return;
    };
    eprintln!("\n{warning}\n");
    tracing::warn!(host, port, "平文HTTPでLANに公開されています");
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
                        "Kataru\n\n  version, --version, -V 現在のバージョンを表示\n  update                 最新版を確認して自動更新\n  config                 AI接続設定を表示・変更\n  models                 モデル一覧キャッシュを更新\n  doctor                 DB・設定・AI疎通を一括診断\n\n  --host <HOST>          待受ホスト（既定: {DEFAULT_HOST}。loopback以外は平文HTTPのため信頼できるネットワーク限定）\n  --port <PORT>          待受ポート（既定: {DEFAULT_PORT}）\n  --data-dir <PATH>      データ保存先\n  --portable             実行ファイル横の kataru-data を使用\n  --no-open              ブラウザを自動で開かない\n  --dev-origin <ORIGIN>  開発UI用のloopbackオリジンを許可\n  --verbose              詳細な診断ログを出力\n  --token <TOKEN>        アクセストークンを固定（引数に残るため共有環境では非推奨。kataru token を推奨）\n\n  環境変数は .env ファイルからも読み込めます\n  （カレントディレクトリと実行ファイルの隣を順に探索。OSの環境変数が優先）"
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
        // 平文HTTPでLANへ公開される構成なら、待受を開始する前に警告する。
        warn_if_plaintext_http(&host, port);
        // データ保存先は自分だけが読める権限で作成し、既存なら締め直す。
        // 共有フォルダなど他ユーザーから読める場所なら、その旨を警告する。
        #[cfg(windows)]
        warn_if_data_dir_is_shared(&data_dir);
        permissions::create_private_directory(&data_dir)?;
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

/// データ保存先が、同じマシンの他ユーザーから読める可能性がある場所なら、その理由を返す。
///
/// Windowsでは `\\server\share` 形式のUNCパスが共有フォルダ。`--portable` は実行ファイルの
/// 隣（多くの場合USBメモリ）を使うため、機械的に判別するのが難しいぶん保守的に警告する。
#[cfg(any(windows, test))]
fn shared_storage_reason(data_dir: &Path, portable: bool) -> Option<&'static str> {
    if is_unc_path(data_dir) {
        Some("共有フォルダ（ネットワークパス）")
    } else if portable {
        Some("実行ファイルの隣（USBメモリなどのリムーバブル媒体）")
    } else {
        None
    }
}

/// `\\server\share` 形式（UNC）のパスか。
///
/// `\\?\UNC\server\share` はUNCの別表記として扱い、`\\?\C:\...` や `\\.\pipe\...` のような
/// デバイス名前空間はローカルパスとして扱う。
#[cfg(any(windows, test))]
fn is_unc_path(path: &Path) -> bool {
    let text = path.as_os_str().to_string_lossy().replace('\\', "/");
    let text = text.trim();
    if text.starts_with("//?/UNC/") || text.starts_with("//./UNC/") {
        return true;
    }
    text.starts_with("//") && !text.starts_with("//?/") && !text.starts_with("//./")
}

/// データ保存先が共有フォルダやリムーバブル媒体のとき、起動時に目立つ形で警告する。
///
/// この保存先にはアクセストークン・会話履歴・記憶・画像が入るため、他ユーザーから読める
/// 場所では利用者に知らせる必要がある。デスクトップ版のリリースビルドはコンソールを
/// 持たないため、この警告が画面に残らない点は既知の制限。
#[cfg(windows)]
fn warn_if_data_dir_is_shared(data_dir: &Path) {
    // `--portable` は実行ファイルの隣の `kataru-data` を使う。
    let portable = portable_data_dir().is_ok_and(|directory| directory == data_dir);
    let Some(reason) = shared_storage_reason(data_dir, portable) else {
        return;
    };
    eprintln!(
        "\n[警告] データ保存先が{reason}です。\n\
         この保存先にはアクセストークン・会話履歴・記憶・画像が保存されます。\n\
         USBメモリや共有フォルダでは、同じPCの他ユーザーや同じネットワークの他のPCから\n\
         これらを読める可能性があります。\n\
         心当たりがない場合は --data-dir でローカルのフォルダを指定してください。\n"
    );
    tracing::warn!(
        data_dir = %data_dir.display(),
        reason,
        "データ保存先が他ユーザーから読める可能性があります"
    );
}

#[cfg(test)]
mod data_dir_tests {
    use super::*;
    #[cfg(unix)]
    use std::fs;

    #[test]
    fn network_share_paths_are_detected() {
        assert!(is_unc_path(Path::new(r"\\fileserver\share\kataru")));
        assert!(is_unc_path(Path::new(r"\\fileserver\share")));
        assert!(is_unc_path(Path::new("//fileserver/share/kataru")));
        assert!(is_unc_path(Path::new(r"\\?\UNC\fileserver\share\kataru")));
        assert!(!is_unc_path(Path::new(r"\\?\C:\Users\me\Kataru")));
        assert!(!is_unc_path(Path::new(r"\\.\pipe\kataru")));
        assert!(!is_unc_path(Path::new(r"C:\Users\me\AppData\Kataru")));
        assert!(!is_unc_path(Path::new(r"E:\kataru-data")));
        assert!(!is_unc_path(Path::new("kataru-data")));
        assert!(!is_unc_path(Path::new(".")));
    }

    #[test]
    fn shared_data_dirs_are_reported_with_a_reason() {
        let share = shared_storage_reason(Path::new(r"\\fileserver\share\kataru"), false)
            .expect("UNC path should be reported");
        assert!(share.contains("共有フォルダ"));

        let portable = shared_storage_reason(Path::new(r"E:\kataru-data"), true)
            .expect("portable data dir should be reported");
        assert!(portable.contains("USBメモリ"));

        assert!(shared_storage_reason(Path::new(r"C:\Users\me\AppData\Kataru"), false).is_none());
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt as _;

        fs::metadata(path)
            .expect("read metadata")
            .permissions()
            .mode()
            & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn data_directory_is_created_private_and_tightened_on_reuse() {
        use std::os::unix::fs::PermissionsExt as _;

        let directory = tempfile::tempdir().expect("create temp directory");
        let data_dir = directory.path().join("kataru").join("data");

        // 中間ディレクトリも含めて0700で作成する。
        permissions::create_private_directory(&data_dir).expect("create data directory");
        assert_eq!(mode(&data_dir), 0o700);
        assert_eq!(mode(&directory.path().join("kataru")), 0o700);

        // 以前のバージョンが既定のumask（0755）で作ったディレクトリも締め直す。
        fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o755))
            .expect("relax permissions");
        permissions::create_private_directory(&data_dir).expect("tighten data directory");
        assert_eq!(mode(&data_dir), 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn files_created_with_the_private_mode_are_owner_only() {
        let directory = tempfile::tempdir().expect("create temp directory");
        let path = directory.path().join("auth-token");

        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        permissions::restrict_new_file_mode(&mut options);
        options.open(&path).expect("create private file");
        assert_eq!(mode(&path), 0o600);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("relax permissions");
        permissions::tighten_file(&path);
        assert_eq!(mode(&path), 0o600);

        // 存在しないファイルは黙って何もしない（WAL/SHMがまだ無い場合）。
        permissions::tighten_file(&directory.path().join("missing.db-wal"));
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

    #[test]
    fn loopback_hosts_do_not_warn_about_plaintext_http() {
        assert!(plaintext_http_warning("127.0.0.1", DEFAULT_PORT).is_none());
        assert!(plaintext_http_warning("::1", DEFAULT_PORT).is_none());
        assert!(plaintext_http_warning("localhost", DEFAULT_PORT).is_none());
    }

    #[test]
    fn tailscale_hosts_do_not_warn_about_plaintext_http() {
        assert!(plaintext_http_warning("100.64.0.1", DEFAULT_PORT).is_none());
        assert!(plaintext_http_warning("100.101.102.103", DEFAULT_PORT).is_none());
        assert!(plaintext_http_warning("100.127.255.254", DEFAULT_PORT).is_none());
        assert!(plaintext_http_warning("fd7a:115c:a1e0::1", DEFAULT_PORT).is_none());
        assert!(plaintext_http_warning("100.63.255.255", DEFAULT_PORT).is_some());
        assert!(plaintext_http_warning("100.128.0.1", DEFAULT_PORT).is_some());
    }

    #[test]
    fn network_hosts_warn_about_plaintext_http() {
        let warning = plaintext_http_warning("192.168.1.20", DEFAULT_PORT)
            .expect("LAN IP should produce a warning");
        assert!(warning.contains("192.168.1.20:37371"));
        assert!(warning.contains("[警告]"));
        assert!(warning.contains("平文HTTP"));
        assert!(warning.contains("信頼できるネットワーク"));
        assert!(warning.contains("Tailscale"));
    }
}
