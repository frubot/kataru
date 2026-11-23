use std::{
    cmp::Ordering,
    env,
    ffi::{OsStr, OsString},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    process::{self, Command},
    sync::OnceLock,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use axum::http::StatusCode;
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    hashing::sha256_hex,
};

const LATEST_RELEASE_API_URL: &str = "https://api.github.com/repos/frubot/kataru/releases/latest";
const RELEASE_PAGE_BASE_URL: &str = "https://github.com/frubot/kataru/releases/tag/";
const RELEASE_DOWNLOAD_BASE_URL: &str = "https://github.com/frubot/kataru/releases/download/";
const MAX_UPDATE_SIZE: u64 = 128 * 1024 * 1024;
const UPDATE_TIMEOUT: Duration = Duration::from_secs(120);
const INTERNAL_APPLY_COMMAND: &str = "__apply-update";
const INTERNAL_CLEANUP_COMMAND: &str = "__cleanup-update";
/// 更新用の一時ディレクトリ名の接頭辞。内部コマンドの検証でも同じ値を使います。
const STAGE_DIR_PREFIX: &str = "kataru-update-";
/// 更新準備完了を示すマーカーファイル名と、その内容。
const READY_MARKER_NAME: &str = "ready";
const READY_MARKER_CONTENT: &[u8] = b"ready";

static ASSET_PREFIX: OnceLock<&'static str> = OnceLock::new();

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
    let args = env::args_os()
        .skip(1)
        .filter(|arg| arg != "--verbose")
        .collect::<Vec<_>>();
    let Some(command) = args.first().and_then(|arg| arg.to_str()) else {
        return Ok(false);
    };

    match command {
        "version" | "--version" | "-V" => {
            if args.len() != 1 {
                return Err(AppError::BadRequest(
                    "version コマンドに引数は指定できません。".to_owned(),
                ));
            }
            println!("Kataru {}", env!("CARGO_PKG_VERSION"));
            Ok(true)
        }
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
    fs::write(marker, READY_MARKER_CONTENT)?;
    Ok(())
}

fn current_server_args() -> Vec<OsString> {
    env::args_os().skip(1).collect()
}

pub fn server_restart_args() -> Vec<OsString> {
    current_server_args()
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

    let actual_digest = sha256_hex(&bytes);
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
        "{STAGE_DIR_PREFIX}{}-{timestamp}-{}",
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
    let ready_marker = stage_dir.join(READY_MARKER_NAME);
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

/// 内部コマンド `__apply-update` の本体。
///
/// 引数は親のKataruだけが生成しますが、昇格実行されたKataruを介して任意の
/// ファイルを置き換えられないよう、更新用ディレクトリ・完了マーカー・更新対象を
/// 適用前に検証します。
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

    let canonical_stage_dir = validate_stage_dir(&stage_dir)?;
    validate_ready_marker(&ready_marker, &canonical_stage_dir)?;
    let canonical_target = validate_update_target(&target)?;
    // 更新プログラムは必ず検証済みの更新用ディレクトリ内（ダウンロードした
    // 新しい実行ファイル）から動いている必要があります。インストール済みの
    // Kataruから直接呼ばれた場合は、更新対象だけが任意に指定できてしまうため
    // ここで拒否します。
    let staged_binary = validate_staged_binary(&canonical_stage_dir)?;
    ensure_target_outside_stage(&canonical_target, &canonical_stage_dir)?;

    wait_for_ready(&ready_marker)?;
    verify_ready_marker(&ready_marker)?;
    thread::sleep(Duration::from_millis(300));

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

/// 内部更新コマンドのパス検証で共通に使う拒否エラー。
///
/// 不正なパスは「引数の形式誤り」ではなく、昇格実行時の意図しないファイル操作に
/// つながる指定なので `Forbidden` として区別します。
fn reject_internal_update(message: impl Into<String>) -> AppError {
    AppError::Forbidden(format!(
        "内部更新コマンドを拒否しました: {}",
        message.into()
    ))
}

/// 更新用の一時ディレクトリを検証し、正規化したパスを返します。
///
/// 許可するのは `std::env::temp_dir()` の直下にある `kataru-update-` 接頭辞の
/// ディレクトリだけです。親ディレクトリの実体も比較するため、`..` を含む指定や
/// 別の場所へのシンボリックリンクは通りません。
fn validate_stage_dir(stage_dir: &Path) -> AppResult<PathBuf> {
    if !stage_dir.is_absolute() {
        return Err(reject_internal_update(format!(
            "更新用ディレクトリは絶対パスで指定してください: {}",
            stage_dir.display()
        )));
    }
    let metadata = fs::symlink_metadata(stage_dir).map_err(|error| {
        reject_internal_update(format!(
            "更新用ディレクトリを読み取れません: {} ({error})",
            stage_dir.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(reject_internal_update(format!(
            "更新用ディレクトリではありません: {}",
            stage_dir.display()
        )));
    }
    let canonical_stage_dir = fs::canonicalize(stage_dir).map_err(|error| {
        reject_internal_update(format!(
            "更新用ディレクトリを解決できません: {} ({error})",
            stage_dir.display()
        ))
    })?;
    let name = canonical_stage_dir
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    if !name.starts_with(STAGE_DIR_PREFIX) || name.len() == STAGE_DIR_PREFIX.len() {
        return Err(reject_internal_update(format!(
            "更新用ディレクトリの名前が不正です: {}",
            canonical_stage_dir.display()
        )));
    }
    let temp_dir = fs::canonicalize(env::temp_dir()).map_err(|error| {
        AppError::Internal(format!("一時ディレクトリを解決できませんでした: {error}"))
    })?;
    if canonical_stage_dir.parent() != Some(temp_dir.as_path()) {
        return Err(reject_internal_update(format!(
            "更新用ディレクトリの場所が不正です: {}",
            canonical_stage_dir.display()
        )));
    }
    Ok(canonical_stage_dir)
}

/// 完了マーカーが更新用ディレクトリ直下の `ready` を指していることを検証します。
fn validate_ready_marker(ready_marker: &Path, stage_dir: &Path) -> AppResult<()> {
    if ready_marker.file_name() != Some(OsStr::new(READY_MARKER_NAME)) {
        return Err(reject_internal_update(format!(
            "更新マーカーの名前が不正です: {}",
            ready_marker.display()
        )));
    }
    let parent = ready_marker.parent().ok_or_else(|| {
        reject_internal_update(format!(
            "更新マーカーの保存先を取得できません: {}",
            ready_marker.display()
        ))
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        reject_internal_update(format!(
            "更新マーカーの保存先を解決できません: {} ({error})",
            parent.display()
        ))
    })?;
    if canonical_parent != stage_dir {
        return Err(reject_internal_update(format!(
            "更新マーカーが更新用ディレクトリの外にあります: {}",
            ready_marker.display()
        )));
    }
    Ok(())
}

/// マーカーが通常ファイルで、親のKataruが書いた内容と一致することを検証します。
///
/// マーカーは親のKataruが更新準備の完了後に `ready` という内容で書き込みます。
fn verify_ready_marker(ready_marker: &Path) -> AppResult<()> {
    let metadata = fs::symlink_metadata(ready_marker).map_err(|error| {
        reject_internal_update(format!(
            "更新マーカーを確認できません: {} ({error})",
            ready_marker.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(reject_internal_update(format!(
            "更新マーカーが通常ファイルではありません: {}",
            ready_marker.display()
        )));
    }
    if fs::read(ready_marker)? != READY_MARKER_CONTENT {
        return Err(reject_internal_update(format!(
            "更新マーカーの内容が不正です: {}",
            ready_marker.display()
        )));
    }
    Ok(())
}

/// 更新対象の実行ファイルを検証し、正規化したパスを返します。
fn validate_update_target(target: &Path) -> AppResult<PathBuf> {
    if !target.is_absolute() {
        return Err(reject_internal_update(format!(
            "更新対象は絶対パスで指定してください: {}",
            target.display()
        )));
    }
    if target
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(reject_internal_update(format!(
            "更新対象に親ディレクトリ参照は指定できません: {}",
            target.display()
        )));
    }
    let metadata = fs::symlink_metadata(target).map_err(|error| {
        reject_internal_update(format!(
            "更新対象を読み取れません: {} ({error})",
            target.display()
        ))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(reject_internal_update(format!(
            "更新対象が通常ファイルではありません: {}",
            target.display()
        )));
    }
    fs::canonicalize(target).map_err(|error| {
        reject_internal_update(format!(
            "更新対象を解決できません: {} ({error})",
            target.display()
        ))
    })
}

/// 更新対象が更新用ディレクトリの内側を指していないことを検証します。
fn ensure_target_outside_stage(target: &Path, stage_dir: &Path) -> AppResult<()> {
    if target.starts_with(stage_dir) {
        return Err(reject_internal_update(format!(
            "更新対象が更新用ディレクトリ内にあります: {}",
            target.display()
        )));
    }
    Ok(())
}

/// 実行中のプロセスが検証済みの更新用ディレクトリ内のファイルであることを
/// 検証し、正規化したパスを返します。
///
/// 更新を適用するのはダウンロードした新しい実行ファイル自身なので、
/// `current_exe` は更新用ディレクトリ直下にあります。インストール済みの
/// Kataruから直接呼ばれた場合はここで弾かれます。
fn validate_staged_binary(stage_dir: &Path) -> AppResult<PathBuf> {
    let current_exe = env::current_exe()?;
    let canonical_current_exe = fs::canonicalize(&current_exe).map_err(|error| {
        reject_internal_update(format!(
            "更新プログラムの場所を解決できません: {} ({error})",
            current_exe.display()
        ))
    })?;
    if canonical_current_exe.parent() != Some(stage_dir) {
        return Err(reject_internal_update(format!(
            "更新プログラムが更新用ディレクトリから実行されていません: {}",
            canonical_current_exe.display()
        )));
    }
    Ok(canonical_current_exe)
}

/// バックアップが更新対象の隣に作られた `<ファイル名>.old-<PID>` であることを
/// 検証します（任意のファイルを削除させないため）。
fn validate_update_backup(target: &Path, backup: &Path) -> AppResult<()> {
    let file_name = target.file_name().ok_or_else(|| {
        reject_internal_update(format!(
            "更新対象のファイル名を取得できません: {}",
            target.display()
        ))
    })?;
    let expected_prefix = format!("{}.old-", file_name.to_string_lossy());
    let backup_name = backup
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    let valid_backup_name = backup_name
        .strip_prefix(&expected_prefix)
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        });
    if !valid_backup_name {
        return Err(reject_internal_update(format!(
            "更新後のバックアップ名が不正です: {}",
            backup.display()
        )));
    }
    let target_parent = fs::canonicalize(target.parent().ok_or_else(|| {
        reject_internal_update(format!(
            "更新対象の保存先を取得できません: {}",
            target.display()
        ))
    })?)?;
    let backup_parent = fs::canonicalize(backup.parent().ok_or_else(|| {
        reject_internal_update(format!(
            "バックアップの保存先を取得できません: {}",
            backup.display()
        ))
    })?)?;
    if target_parent != backup_parent {
        return Err(reject_internal_update(format!(
            "バックアップが更新対象と同じ場所にありません: {}",
            backup.display()
        )));
    }
    Ok(())
}

fn wait_for_ready(marker: &Path) -> AppResult<()> {
    let started = Instant::now();
    loop {
        // 親のKataruは `ready` を書き込んでから完了するため、内容まで一致する
        // ことを待ちます（旧バージョンからの更新では書き込み途中に見えることが
        // あります）。
        if marker.is_file()
            && fs::read(marker).is_ok_and(|contents| contents == READY_MARKER_CONTENT)
        {
            return Ok(());
        }
        if started.elapsed() >= UPDATE_TIMEOUT {
            return Err(AppError::Internal(
                "更新の適用待ちがタイムアウトしました。".to_owned(),
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
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
        .arg(target)
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

/// 内部コマンド `__cleanup-update` の本体。
///
/// 更新後の実行ファイル自身から呼ばれた場合だけ、検証済みの更新用ディレクトリと
/// バックアップを削除します。
fn cleanup_staged_update(args: &[OsString]) -> AppResult<()> {
    if args.len() != 3 {
        return Err(AppError::BadRequest(
            "内部クリーンアップコマンドの引数が不正です。".to_owned(),
        ));
    }
    let stage_dir = PathBuf::from(&args[0]);
    let target = PathBuf::from(&args[1]);
    let backup = PathBuf::from(&args[2]);

    let canonical_target = validate_update_target(&target)?;
    let current_exe = fs::canonicalize(env::current_exe()?)?;
    if current_exe != canonical_target {
        return Err(reject_internal_update(format!(
            "クリーンアップは更新後の実行ファイルから実行してください: {}",
            target.display()
        )));
    }
    validate_update_backup(&target, &backup)?;

    // 更新用ディレクトリが既に無い場合は削除済みとして扱います。存在する場合だけ
    // 検証し、正規化したパスを削除対象にします。
    let stage_dir = if stage_dir.exists() {
        let canonical_stage_dir = validate_stage_dir(&stage_dir)?;
        ensure_target_outside_stage(&canonical_target, &canonical_stage_dir)?;
        Some(canonical_stage_dir)
    } else {
        None
    };

    let started = Instant::now();
    loop {
        let stage_removed = stage_dir
            .as_ref()
            .is_none_or(|directory| !directory.exists() || fs::remove_dir_all(directory).is_ok());
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

/// 更新ファイル名の接頭辞を設定する。デスクトップ版は `kataru-desktop` を使う。
pub fn set_asset_prefix(prefix: &'static str) {
    let _ = ASSET_PREFIX.set(prefix);
}

fn update_asset_name() -> Option<String> {
    let platform = match (env::consts::OS, env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x64.exe",
        ("linux", "x86_64") => "linux-x64",
        ("macos", "aarch64") => "macos-arm64",
        _ => return None,
    };
    let prefix = ASSET_PREFIX.get().copied().unwrap_or("kataru");
    Some(format!("{prefix}-{platform}"))
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

    /// `std::env::temp_dir()` の直下に、指定した接頭辞の一時ディレクトリを作ります。
    fn stage_dir_with_prefix(prefix: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(std::env::temp_dir())
            .expect("temporary stage directory")
    }

    fn canonical_stage_dir(stage_dir: &Path) -> PathBuf {
        validate_stage_dir(stage_dir).expect("valid stage directory")
    }

    #[test]
    fn stage_dir_must_be_a_prefixed_dir_directly_under_temp_dir() {
        let stage = stage_dir_with_prefix("kataru-update-test-");
        let canonical = canonical_stage_dir(stage.path());
        let temp_dir = fs::canonicalize(std::env::temp_dir()).expect("temp dir");
        assert_eq!(canonical.parent(), Some(temp_dir.as_path()));

        // 接頭辞が違うディレクトリは拒否する。
        let wrong_prefix = stage_dir_with_prefix("kataru-test-");
        assert!(validate_stage_dir(wrong_prefix.path()).is_err());

        // 接頭辞は正しくても、一時ディレクトリの直下でなければ拒否する。
        let nested_root = stage_dir_with_prefix("kataru-update-nested-root-");
        let nested = nested_root.path().join("kataru-update-nested");
        fs::create_dir(&nested).expect("nested stage directory");
        assert!(validate_stage_dir(&nested).is_err());

        // 存在しないパス・相対パスは拒否する。
        let missing = std::env::temp_dir().join("kataru-update-missing-directory");
        assert!(validate_stage_dir(&missing).is_err());
        assert!(validate_stage_dir(Path::new("kataru-update-relative")).is_err());

        // 接頭辞だけの名前は拒否する。
        let empty_suffix = std::env::temp_dir().join(STAGE_DIR_PREFIX);
        let _ = fs::remove_dir_all(&empty_suffix);
        fs::create_dir(&empty_suffix).expect("prefix-only stage directory");
        let result = validate_stage_dir(&empty_suffix);
        let _ = fs::remove_dir_all(&empty_suffix);
        assert!(result.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn stage_dir_symlink_is_rejected() {
        use std::os::unix::fs::symlink;

        let target = stage_dir_with_prefix("kataru-update-link-target-");
        let link_root = stage_dir_with_prefix("kataru-update-link-root-");
        let link = link_root.path().join("kataru-update-link");
        symlink(target.path(), &link).expect("symlink to stage directory");
        assert!(validate_stage_dir(&link).is_err());
    }

    #[test]
    fn ready_marker_must_be_inside_stage_dir_and_contain_ready() {
        let stage = stage_dir_with_prefix("kataru-update-marker-");
        let canonical = canonical_stage_dir(stage.path());
        let marker = canonical.join(READY_MARKER_NAME);

        validate_ready_marker(&marker, &canonical).expect("marker inside stage directory");
        fs::write(&marker, READY_MARKER_CONTENT).expect("write ready marker");
        verify_ready_marker(&marker).expect("ready marker contents");

        // 別のディレクトリの `ready` は拒否する。
        let other = stage_dir_with_prefix("kataru-update-marker-other-");
        let outside = canonical_stage_dir(other.path()).join(READY_MARKER_NAME);
        fs::write(&outside, READY_MARKER_CONTENT).expect("write outside marker");
        assert!(validate_ready_marker(&outside, &canonical).is_err());

        // マーカー名が `ready` でなければ拒否する。
        let wrong_name = canonical.join("done");
        assert!(validate_ready_marker(&wrong_name, &canonical).is_err());

        // 内容が `ready` でない・通常ファイルでないマーカーは拒否する。
        fs::write(&marker, b"nope").expect("overwrite marker");
        assert!(verify_ready_marker(&marker).is_err());
        fs::remove_file(&marker).expect("remove marker");
        assert!(verify_ready_marker(&marker).is_err());
        fs::create_dir(&marker).expect("marker directory");
        assert!(verify_ready_marker(&marker).is_err());
    }

    #[test]
    fn update_target_must_be_an_existing_file_outside_stage_dir() {
        let current_exe = std::env::current_exe().expect("current executable");
        let canonical_target = validate_update_target(&current_exe).expect("existing file");
        let stage = stage_dir_with_prefix("kataru-update-target-");
        let canonical = canonical_stage_dir(stage.path());
        ensure_target_outside_stage(&canonical_target, &canonical)
            .expect("outside stage directory");

        let inside = canonical.join("kataru-windows-x64.exe");
        fs::write(&inside, b"staged").expect("staged binary");
        let canonical_inside = validate_update_target(&inside).expect("staged binary is a file");
        assert!(ensure_target_outside_stage(&canonical_inside, &canonical).is_err());

        // 相対パス・存在しないパス・ディレクトリ・親ディレクトリ参照は拒否する。
        assert!(validate_update_target(Path::new("kataru.exe")).is_err());
        assert!(validate_update_target(&canonical.join("missing.exe")).is_err());
        assert!(validate_update_target(&canonical).is_err());
        assert!(validate_update_target(&canonical.join("..").join("kataru.exe")).is_err());
    }

    #[test]
    fn cleanup_backup_must_be_a_sibling_of_the_updated_binary() {
        let current_exe = fs::canonicalize(std::env::current_exe().expect("current executable"))
            .expect("canonical executable");
        let file_name = current_exe
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .to_string();
        let parent = current_exe
            .parent()
            .expect("parent directory")
            .to_path_buf();

        let valid = parent.join(format!("{file_name}.old-1234"));
        validate_update_backup(&current_exe, &valid).expect("sibling backup");

        for invalid in [
            parent.join(format!("{file_name}.old-")),
            parent.join(format!("{file_name}.old-12ab")),
            parent.join(format!("{file_name}.backup-1234")),
            parent.join("other-binary.old-1234"),
        ] {
            assert!(validate_update_backup(&current_exe, &invalid).is_err());
        }

        let other_dir = tempfile::tempdir().expect("other directory");
        let other = other_dir.path().join(format!("{file_name}.old-1234"));
        assert!(validate_update_backup(&current_exe, &other).is_err());
    }

    #[test]
    fn internal_update_commands_reject_untrusted_arguments() {
        let current_exe = fs::canonicalize(std::env::current_exe().expect("current executable"))
            .expect("canonical executable");
        let stage = stage_dir_with_prefix("kataru-update-apply-");
        let canonical = canonical_stage_dir(stage.path());
        let marker = canonical.join(READY_MARKER_NAME);
        fs::write(&marker, READY_MARKER_CONTENT).expect("write ready marker");

        // 更新用ディレクトリが正しくても、そこから実行されていないプロセスは拒否する。
        let apply_args = vec![
            marker.clone().into_os_string(),
            current_exe.clone().into_os_string(),
            canonical.clone().into_os_string(),
        ];
        assert!(matches!(
            apply_staged_update(&apply_args),
            Err(AppError::Forbidden(_))
        ));

        // マーカーが別の更新用ディレクトリにある場合は拒否する。
        let other = stage_dir_with_prefix("kataru-update-other-");
        let other_stage = canonical_stage_dir(other.path());
        let outside_marker_args = vec![
            marker.clone().into_os_string(),
            current_exe.clone().into_os_string(),
            other_stage.into_os_string(),
        ];
        assert!(matches!(
            apply_staged_update(&outside_marker_args),
            Err(AppError::Forbidden(_))
        ));

        // 引数の数が足りない内部クリーンアップコマンドは拒否する。
        assert!(cleanup_staged_update(&[]).is_err());
        let short_cleanup = vec![
            canonical.clone().into_os_string(),
            current_exe.clone().into_os_string(),
        ];
        assert!(cleanup_staged_update(&short_cleanup).is_err());

        // 更新対象と同名で始まらないバックアップは拒否する。
        let file_name = current_exe
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .to_string();
        let parent = current_exe.parent().expect("parent directory");
        let bad_backup_args = vec![
            canonical.clone().into_os_string(),
            current_exe.clone().into_os_string(),
            parent
                .join(format!("{file_name}.old-abcdef"))
                .into_os_string(),
        ];
        assert!(matches!(
            cleanup_staged_update(&bad_backup_args),
            Err(AppError::Forbidden(_))
        ));

        // 更新後の実行ファイル（このテストバイナリ）から呼ばれた正しい形式は通る。
        let cleanup_stage = stage_dir_with_prefix("kataru-update-cleanup-");
        fs::create_dir(cleanup_stage.path().join("leftover")).expect("leftover directory");
        let valid_cleanup_args = vec![
            cleanup_stage.path().as_os_str().to_os_string(),
            current_exe.clone().into_os_string(),
            parent
                .join(format!("{file_name}.old-{}", std::process::id()))
                .into_os_string(),
        ];
        cleanup_staged_update(&valid_cleanup_args).expect("valid cleanup");
        assert!(!cleanup_stage.path().exists());
    }
}
