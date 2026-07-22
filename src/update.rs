use std::{
    cmp::Ordering,
    env,
    ffi::{OsStr, OsString},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{self, Command},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::http::StatusCode;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

const LATEST_RELEASE_API_URL: &str = "https://api.github.com/repos/frubot/kataru/releases/latest";
const RELEASE_PAGE_BASE_URL: &str = "https://github.com/frubot/kataru/releases/tag/";
const RELEASE_DOWNLOAD_BASE_URL: &str = "https://github.com/frubot/kataru/releases/download/";
const MAX_UPDATE_SIZE: u64 = 128 * 1024 * 1024;
const UPDATE_TIMEOUT: Duration = Duration::from_secs(120);
const INTERNAL_APPLY_COMMAND: &str = "__apply-update";
const INTERNAL_CLEANUP_COMMAND: &str = "__cleanup-update";

#[derive(Clone, Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    #[serde(flatten)]
    pub status: UpdateStatus,
    pub installing: bool,
}

pub struct PreparedUpdate {
    pub result: UpdateResult,
    pub ready_marker: Option<PathBuf>,
}

pub async fn run_special_command_if_requested() -> AppResult<bool> {
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    let Some(command) = args.first().and_then(|arg| arg.to_str()) else {
        return Ok(false);
    };

    match command {
        "update" => {
            if args.len() != 1 {
                return Err(AppError::BadRequest(
                    "update コマンドに引数は指定できません。".to_owned(),
                ));
            }
            run_update_command().await?;
            Ok(true)
        }
        INTERNAL_APPLY_COMMAND => {
            apply_staged_update(&args[1..])?;
            Ok(true)
        }
        INTERNAL_CLEANUP_COMMAND => {
            cleanup_staged_update(&args[1..])?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

async fn run_update_command() -> AppResult<()> {
    println!("Kataruの更新を確認しています...");
    let client = Client::builder()
        .user_agent(format!("Kataru/{}", env!("CARGO_PKG_VERSION")))
        .build()?;
    let prepared = install_latest(&client, None, false).await?;
    if let Some(marker) = &prepared.ready_marker {
        mark_update_ready(marker)?;
        println!(
            "v{}をダウンロードしました。更新を適用しています...",
            prepared.result.status.latest_version
        );
    } else {
        println!(
            "v{}は最新バージョンです。",
            prepared.result.status.current_version
        );
    }
    Ok(())
}

pub async fn check_for_update(client: &Client) -> AppResult<UpdateStatus> {
    let release = fetch_latest_release(client).await?;
    status_from_release(&release)
}

pub async fn install_latest(
    client: &Client,
    restart_args: Option<Vec<OsString>>,
    hide_helper: bool,
) -> AppResult<PreparedUpdate> {
    let release = fetch_latest_release(client).await?;
    let status = status_from_release(&release)?;
    if !status.update_available {
        return Ok(PreparedUpdate {
            result: UpdateResult {
                status,
                installing: false,
            },
            ready_marker: None,
        });
    }

    let asset = select_update_asset(&release)?;
    let target = env::current_exe()?;
    ensure_update_permission(&target)?;
    let (stage_dir, staged_binary, ready_marker) = download_update(client, &release, asset).await?;

    if let Err(error) = spawn_update_helper(
        &staged_binary,
        &target,
        &stage_dir,
        &ready_marker,
        restart_args.as_deref(),
        hide_helper,
    ) {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(error);
    }

    Ok(PreparedUpdate {
        result: UpdateResult {
            status,
            installing: true,
        },
        ready_marker: Some(ready_marker),
    })
}

pub fn mark_update_ready(marker: &Path) -> AppResult<()> {
    fs::write(marker, b"ready")?;
    Ok(())
}

fn current_server_args() -> Vec<OsString> {
    env::args_os().skip(1).collect()
}

pub fn server_restart_args() -> Vec<OsString> {
    let mut args = current_server_args();
    // 更新前のタブが再接続するため、再起動時に別のブラウザーを開かないようにします。
    args.push(OsString::from("--no-open"));
    args
}

async fn fetch_latest_release(client: &Client) -> AppResult<GitHubRelease> {
    let response = client
        .get(LATEST_RELEASE_API_URL)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| {
            AppError::Upstream(
                format!("最新バージョンを確認できませんでした: {error}"),
                StatusCode::BAD_GATEWAY,
            )
        })?;

    if !response.status().is_success() {
        return Err(AppError::Upstream(
            "最新バージョンを確認できませんでした。時間をおいてもう一度お試しください。".to_owned(),
            StatusCode::BAD_GATEWAY,
        ));
    }

    response.json::<GitHubRelease>().await.map_err(|error| {
        AppError::Upstream(
            format!("最新バージョンの応答を読み取れませんでした: {error}"),
            StatusCode::BAD_GATEWAY,
        )
    })
}

fn status_from_release(release: &GitHubRelease) -> AppResult<UpdateStatus> {
    let latest_version = parse_release_version(&release.tag_name)
        .ok_or_else(|| AppError::Internal("最新リリースのバージョン形式が不正です。".to_owned()))?;
    let current_version = parse_release_version(env!("CARGO_PKG_VERSION"))
        .ok_or_else(|| AppError::Internal("実行中のバージョン形式が不正です。".to_owned()))?;
    let latest_version_text = version_text(&latest_version);

    Ok(UpdateStatus {
        current_version: env!("CARGO_PKG_VERSION").to_owned(),
        latest_version: latest_version_text,
        update_available: compare_versions(&latest_version, &current_version).is_gt(),
        release_url: format!("{RELEASE_PAGE_BASE_URL}{}", release.tag_name),
    })
}

fn select_update_asset(release: &GitHubRelease) -> AppResult<&GitHubAsset> {
    let asset_name = update_asset_name().ok_or_else(|| {
        AppError::BadRequest(format!(
            "{}-{}向けの自動更新には対応していません。",
            env::consts::OS,
            env::consts::ARCH
        ))
    })?;
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == asset_name)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "この環境向けの更新ファイル（{asset_name}）が見つかりません。"
            ))
        })?;
    validate_asset(release, asset)?;
    Ok(asset)
}

fn validate_asset(release: &GitHubRelease, asset: &GitHubAsset) -> AppResult<()> {
    let expected_url = format!(
        "{RELEASE_DOWNLOAD_BASE_URL}{}/{}",
        release.tag_name, asset.name
    );
    if asset.browser_download_url != expected_url {
        return Err(AppError::Internal(
            "更新ファイルのダウンロード先が不正です。".to_owned(),
        ));
    }
    if asset.size == 0 || asset.size > MAX_UPDATE_SIZE {
        return Err(AppError::Internal(
            "更新ファイルのサイズが許容範囲外です。".to_owned(),
        ));
    }
    expected_sha256(asset)?;
    Ok(())
}

fn expected_sha256(asset: &GitHubAsset) -> AppResult<String> {
    let digest = asset
        .digest
        .as_deref()
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            AppError::Internal("更新ファイルのSHA-256ダイジェストがありません。".to_owned())
        })?;
    Ok(digest.to_ascii_lowercase())
}

async fn download_update(
    client: &Client,
    release: &GitHubRelease,
    asset: &GitHubAsset,
) -> AppResult<(PathBuf, PathBuf, PathBuf)> {
    let response = client
        .get(&asset.browser_download_url)
        .timeout(UPDATE_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            AppError::Upstream(
                format!("更新ファイルをダウンロードできませんでした: {error}"),
                StatusCode::BAD_GATEWAY,
            )
        })?;
    if !response.status().is_success() {
        return Err(AppError::Upstream(
            "更新ファイルをダウンロードできませんでした。".to_owned(),
            StatusCode::BAD_GATEWAY,
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_UPDATE_SIZE)
    {
        return Err(AppError::Internal(
            "更新ファイルが大きすぎます。".to_owned(),
        ));
    }

    let mut bytes = Vec::with_capacity(asset.size as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            AppError::Upstream(
                format!("更新ファイルを読み取れませんでした: {error}"),
                StatusCode::BAD_GATEWAY,
            )
        })?;
        let next_size = bytes.len().saturating_add(chunk.len()) as u64;
        if next_size > asset.size || next_size > MAX_UPDATE_SIZE {
            return Err(AppError::Internal(
                "更新ファイルのサイズがリリース情報と一致しません。".to_owned(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() as u64 != asset.size {
        return Err(AppError::Internal(
            "更新ファイルのサイズがリリース情報と一致しません。".to_owned(),
        ));
    }

    let actual_digest = format!("{:x}", Sha256::digest(&bytes));
    if actual_digest != expected_sha256(asset)? {
        return Err(AppError::Internal(
            "更新ファイルのSHA-256検証に失敗しました。".to_owned(),
        ));
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Internal(format!("システム時刻が不正です: {error}")))?
        .as_millis();
    let stage_dir = env::temp_dir().join(format!(
        "kataru-update-{}-{timestamp}-{}",
        process::id(),
        release.tag_name
    ));
    fs::create_dir(&stage_dir)?;
    let staged_binary = stage_dir.join(&asset.name);
    let write_result = (|| -> AppResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged_binary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        set_executable_permission(&staged_binary)?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&stage_dir);
        return Err(error);
    }
    let ready_marker = stage_dir.join("ready");
    Ok((stage_dir, staged_binary, ready_marker))
}

fn ensure_update_permission(target: &Path) -> AppResult<()> {
    let parent = target.parent().ok_or_else(|| {
        AppError::Internal("実行ファイルの保存先を取得できませんでした。".to_owned())
    })?;
    let probe = parent.join(format!(".kataru-update-write-test-{}", process::id()));
    let result = OpenOptions::new().write(true).create_new(true).open(&probe);
    match result {
        Ok(file) => {
            drop(file);
            fs::remove_file(&probe)?;
            Ok(())
        }
        Err(error) => Err(AppError::Internal(format!(
            "実行ファイルの保存先に書き込めないため、自動更新できません: {error}"
        ))),
    }
}

fn spawn_update_helper(
    staged_binary: &Path,
    target: &Path,
    stage_dir: &Path,
    ready_marker: &Path,
    restart_args: Option<&[OsString]>,
    hide_helper: bool,
) -> AppResult<()> {
    let mut command = Command::new(staged_binary);
    command
        .arg(INTERNAL_APPLY_COMMAND)
        .arg(ready_marker)
        .arg(target)
        .arg(stage_dir);
    if let Some(args) = restart_args {
        command.arg("--").args(args);
    }
    if hide_helper {
        hide_window(&mut command);
    }
    command.spawn().map_err(|error| {
        AppError::Internal(format!("更新プロセスを起動できませんでした: {error}"))
    })?;
    Ok(())
}

fn apply_staged_update(args: &[OsString]) -> AppResult<()> {
    if args.len() < 3 {
        return Err(AppError::BadRequest(
            "内部更新コマンドの引数が不足しています。".to_owned(),
        ));
    }
    let ready_marker = PathBuf::from(&args[0]);
    let target = PathBuf::from(&args[1]);
    let stage_dir = PathBuf::from(&args[2]);
    let restart_args = match args.get(3) {
        None => None,
        Some(separator) if separator == OsStr::new("--") => Some(&args[4..]),
        Some(_) => {
            return Err(AppError::BadRequest(
                "内部更新コマンドの区切りが不正です。".to_owned(),
            ));
        }
    };
    wait_for_ready(&ready_marker)?;
    thread::sleep(Duration::from_millis(300));

    let staged_binary = env::current_exe()?;
    let file_name = target.file_name().ok_or_else(|| {
        AppError::Internal("更新対象のファイル名を取得できませんでした。".to_owned())
    })?;
    let backup = target.with_file_name(format!(
        "{}.old-{}",
        file_name.to_string_lossy(),
        process::id()
    ));
    move_target_to_backup(&target, &backup)?;

    if let Err(error) = copy_new_binary(&staged_binary, &target) {
        let _ = fs::rename(&backup, &target);
        return Err(error);
    }

    if let Some(restart_args) = restart_args {
        let mut child = match Command::new(&target).args(restart_args).spawn() {
            Ok(child) => child,
            Err(error) => {
                rollback_update(&target, &backup);
                return Err(AppError::Internal(format!(
                    "更新後のKataruを起動できませんでした: {error}"
                )));
            }
        };
        thread::sleep(Duration::from_millis(750));
        if let Some(status) = child.try_wait().map_err(|error| {
            AppError::Internal(format!("更新後の起動状態を確認できませんでした: {error}"))
        })? {
            rollback_update(&target, &backup);
            return Err(AppError::Internal(format!(
                "更新後のKataruが起動直後に終了しました: {status}"
            )));
        }
    }

    spawn_cleanup_process(&target, &stage_dir, &backup)?;
    println!("Kataruの更新が完了しました。");
    Ok(())
}

fn wait_for_ready(marker: &Path) -> AppResult<()> {
    let started = Instant::now();
    while !marker.is_file() {
        if started.elapsed() >= UPDATE_TIMEOUT {
            return Err(AppError::Internal(
                "更新の適用待ちがタイムアウトしました。".to_owned(),
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

fn move_target_to_backup(target: &Path, backup: &Path) -> AppResult<()> {
    let started = Instant::now();
    loop {
        match fs::rename(target, backup) {
            Ok(()) => return Ok(()),
            Err(error) if started.elapsed() < UPDATE_TIMEOUT => {
                thread::sleep(Duration::from_millis(100));
                if !target.exists() {
                    return Err(AppError::Internal(
                        "更新対象の実行ファイルが見つかりません。".to_owned(),
                    ));
                }
                let _ = error;
            }
            Err(error) => {
                return Err(AppError::Internal(format!(
                    "実行中のKataruを更新用に退避できませんでした: {error}"
                )));
            }
        }
    }
}

fn copy_new_binary(source: &Path, target: &Path) -> AppResult<()> {
    fs::copy(source, target)?;
    set_executable_permission(target)?;
    Ok(())
}

fn rollback_update(target: &Path, backup: &Path) {
    let _ = fs::remove_file(target);
    let _ = fs::rename(backup, target);
}

fn spawn_cleanup_process(target: &Path, stage_dir: &Path, backup: &Path) -> AppResult<()> {
    let mut cleanup = Command::new(target);
    cleanup
        .arg(INTERNAL_CLEANUP_COMMAND)
        .arg(stage_dir)
        .arg(backup);
    hide_window(&mut cleanup);
    cleanup.spawn().map_err(|error| {
        rollback_update(target, backup);
        AppError::Internal(format!(
            "更新後の一時ファイルを処理できませんでした: {error}"
        ))
    })?;
    Ok(())
}

fn cleanup_staged_update(args: &[OsString]) -> AppResult<()> {
    if args.len() != 2 {
        return Err(AppError::BadRequest(
            "内部クリーンアップコマンドの引数が不正です。".to_owned(),
        ));
    }
    let stage_dir = PathBuf::from(&args[0]);
    let backup = PathBuf::from(&args[1]);
    let started = Instant::now();
    loop {
        let stage_removed = !stage_dir.exists() || fs::remove_dir_all(&stage_dir).is_ok();
        let backup_removed = !backup.exists() || fs::remove_file(&backup).is_ok();
        if stage_removed && backup_removed {
            return Ok(());
        }
        if started.elapsed() >= Duration::from_secs(30) {
            return Err(AppError::Internal(
                "更新後の一時ファイルを削除できませんでした。".to_owned(),
            ));
        }
        thread::sleep(Duration::from_millis(200));
    }
}

fn parse_release_version(value: &str) -> Option<Vec<u64>> {
    let value = value.strip_prefix('v').unwrap_or(value);
    let parts = value
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    (parts.len() >= 2).then_some(parts)
}

fn compare_versions(left: &[u64], right: &[u64]) -> Ordering {
    let length = left.len().max(right.len());
    (0..length)
        .map(|index| {
            left.get(index)
                .copied()
                .unwrap_or_default()
                .cmp(&right.get(index).copied().unwrap_or_default())
        })
        .find(|ordering| !ordering.is_eq())
        .unwrap_or(Ordering::Equal)
}

fn version_text(version: &[u64]) -> String {
    version
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(".")
}

fn update_asset_name() -> Option<&'static str> {
    match (env::consts::OS, env::consts::ARCH) {
        ("windows", "x86_64") => Some("kataru-windows-x64.exe"),
        ("linux", "x86_64") => Some("kataru-linux-x64"),
        ("macos", "aarch64") => Some("kataru-macos-arm64"),
        _ => None,
    }
}

#[cfg(unix)]
fn set_executable_permission(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable_permission(_path: &Path) -> AppResult<()> {
    Ok(())
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn release_with_asset(asset: GitHubAsset) -> GitHubRelease {
        GitHubRelease {
            tag_name: "v0.1.10".to_owned(),
            assets: vec![asset],
        }
    }

    #[test]
    fn release_versions_are_parsed_and_compared() {
        assert_eq!(parse_release_version("v0.1.10"), Some(vec![0, 1, 10]));
        assert_eq!(parse_release_version("0.1.9"), Some(vec![0, 1, 9]));
        assert_eq!(parse_release_version("release-1.0"), None);
        assert_eq!(compare_versions(&[0, 1, 10], &[0, 1, 9]), Ordering::Greater);
        assert_eq!(compare_versions(&[1, 0], &[1, 0, 0]), Ordering::Equal);
        assert_eq!(compare_versions(&[0, 9, 9], &[1, 0, 0]), Ordering::Less);
    }

    #[test]
    fn update_asset_requires_expected_url_size_and_sha256() {
        let name = update_asset_name().expect("supported test target");
        let release = release_with_asset(GitHubAsset {
            name: name.to_owned(),
            browser_download_url: format!(
                "https://github.com/frubot/kataru/releases/download/v0.1.10/{name}"
            ),
            size: 1024,
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        });
        assert!(select_update_asset(&release).is_ok());

        let mut invalid_release = release.clone();
        invalid_release.assets[0].browser_download_url =
            "https://example.com/kataru.exe".to_owned();
        assert!(select_update_asset(&invalid_release).is_err());

        let mut missing_digest = release;
        missing_digest.assets[0].digest = None;
        assert!(select_update_asset(&missing_digest).is_err());
    }
}
