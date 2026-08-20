use std::{
    env, fs,
    fs::OpenOptions,
    path::{Path, PathBuf},
    process,
    time::Duration,
};

use reqwest::{Client, Url};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    ai::{AiApiClient, AiApiConfig},
    ai_config::{
        AiConfigManager, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENAI_BASE_URL, EffectiveAiConfig,
    },
    config::{default_data_dir, portable_data_dir},
    db::CURRENT_SCHEMA_VERSION,
    error::{AppError, AppResult},
};

const DOCTOR_SCHEMA_VERSION: u32 = 1;
const AI_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
enum CheckStatus {
    Ok,
    Warning,
    Error,
}

impl CheckStatus {
    fn label(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::Warning => "WARN",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorCheck {
    name: &'static str,
    status: CheckStatus,
    message: String,
    details: Value,
}

impl DoctorCheck {
    fn new(
        name: &'static str,
        status: CheckStatus,
        message: impl Into<String>,
        details: Value,
    ) -> Self {
        Self {
            name,
            status,
            message: message.into(),
            details,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildInfo {
    profile: &'static str,
    operating_system: &'static str,
    architecture: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorPaths {
    data_directory: String,
    database: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    schema_version: u32,
    status: &'static str,
    exit_code: i32,
    version: &'static str,
    build: BuildInfo,
    paths: DoctorPaths,
    checks: Vec<DoctorCheck>,
}

impl DoctorReport {
    fn new(data_dir: &Path, database_path: &Path, checks: Vec<DoctorCheck>) -> Self {
        let worst = checks
            .iter()
            .map(|check| check.status)
            .max()
            .unwrap_or(CheckStatus::Ok);
        let (status, exit_code) = match worst {
            CheckStatus::Ok => ("ok", 0),
            CheckStatus::Warning => ("warning", 2),
            CheckStatus::Error => ("failure", 1),
        };
        Self {
            schema_version: DOCTOR_SCHEMA_VERSION,
            status,
            exit_code,
            version: env!("CARGO_PKG_VERSION"),
            build: BuildInfo {
                profile: if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                },
                operating_system: env::consts::OS,
                architecture: env::consts::ARCH,
            },
            paths: DoctorPaths {
                data_directory: data_dir.display().to_string(),
                database: database_path.display().to_string(),
            },
            checks,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct DoctorOptions {
    data_dir: PathBuf,
    json: bool,
    network: bool,
}

#[derive(Debug)]
enum DoctorCommand {
    Run(DoctorOptions),
    Help,
}

pub async fn run_cli_command_if_requested() -> AppResult<Option<i32>> {
    let args = env::args()
        .skip(1)
        .filter(|arg| arg != "--verbose")
        .collect::<Vec<_>>();
    if args.first().map(String::as_str) != Some("doctor") {
        return Ok(None);
    }

    match parse_doctor_args(&args[1..])? {
        DoctorCommand::Help => {
            print_help();
            Ok(Some(0))
        }
        DoctorCommand::Run(options) => {
            let report = run_checks(&options).await;
            if options.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print_human_report(&report);
            }
            Ok(Some(report.exit_code))
        }
    }
}

fn parse_doctor_args(args: &[String]) -> AppResult<DoctorCommand> {
    let mut data_dir = None;
    let mut portable = false;
    let mut json_output = false;
    let mut network = true;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--help" | "-h" => return Ok(DoctorCommand::Help),
            "--json" => json_output = true,
            "--no-network" => network = false,
            "--data-dir" => {
                if portable || data_dir.is_some() {
                    return Err(AppError::BadRequest(
                        "--data-dir と --portable は同時または複数回指定できません。".to_owned(),
                    ));
                }
                index += 1;
                let path = args.get(index).ok_or_else(|| {
                    AppError::BadRequest("--data-dir には値が必要です。".to_owned())
                })?;
                data_dir = Some(PathBuf::from(path));
            }
            "--portable" => {
                if portable || data_dir.is_some() {
                    return Err(AppError::BadRequest(
                        "--data-dir と --portable は同時または複数回指定できません。".to_owned(),
                    ));
                }
                portable = true;
            }
            value => {
                return Err(AppError::BadRequest(format!(
                    "doctor コマンドの未対応の引数です: {value}"
                )));
            }
        }
        index += 1;
    }

    let data_dir = if portable {
        portable_data_dir()?
    } else {
        data_dir.map_or_else(default_data_dir, Ok)?
    };
    Ok(DoctorCommand::Run(DoctorOptions {
        data_dir,
        json: json_output,
        network,
    }))
}

async fn run_checks(options: &DoctorOptions) -> DoctorReport {
    let database_path = options.data_dir.join("kataru.db");
    let mut checks = vec![check_data_directory(&options.data_dir)];
    let database_exists = database_path.is_file();
    checks.push(check_database_file(&database_path));
    if database_exists {
        let (sqlite, migrations) = check_sqlite(&database_path);
        checks.push(sqlite);
        checks.push(migrations);
    } else {
        checks.push(DoctorCheck::new(
            "sqlite",
            CheckStatus::Warning,
            "DBがまだ作成されていないため、SQLite検査を省略しました。",
            json!({ "checked": false }),
        ));
        checks.push(DoctorCheck::new(
            "migrations",
            CheckStatus::Warning,
            "DBがまだ作成されていないため、migration状態を確認できません。",
            json!({
                "checked": false,
                "expectedSchemaVersion": CURRENT_SCHEMA_VERSION,
            }),
        ));
    }

    if options.data_dir.is_dir() {
        match AiConfigManager::open(&options.data_dir) {
            Ok(manager) => {
                let effective = manager.effective();
                let providers = configured_providers(&effective);
                checks.push(ai_configuration_check(&manager, &effective, &providers));
                if options.network {
                    checks.push(check_ai_connectivity(&effective, &providers).await);
                } else {
                    checks.push(DoctorCheck::new(
                        "ai_connectivity",
                        CheckStatus::Warning,
                        "--no-network が指定されたため、AI API疎通確認を省略しました。",
                        json!({ "checked": false, "reason": "disabled" }),
                    ));
                }
            }
            Err(error) => {
                checks.push(DoctorCheck::new(
                    "ai_configuration",
                    CheckStatus::Error,
                    "AI接続設定を読み取れません。設定ファイルを確認してください。",
                    json!({ "errorClass": error.diagnostic_class() }),
                ));
                checks.push(DoctorCheck::new(
                    "ai_connectivity",
                    CheckStatus::Warning,
                    "AI接続設定を読み取れないため、疎通確認を省略しました。",
                    json!({ "checked": false, "reason": "invalid_configuration" }),
                ));
            }
        }
    } else {
        checks.push(DoctorCheck::new(
            "ai_configuration",
            CheckStatus::Warning,
            "データ保存先が未作成のため、保存済みAI設定を確認できません。",
            json!({ "checked": false }),
        ));
        checks.push(DoctorCheck::new(
            "ai_connectivity",
            CheckStatus::Warning,
            "AI接続設定を確認できないため、疎通確認を省略しました。",
            json!({ "checked": false, "reason": "data_directory_missing" }),
        ));
    }

    DoctorReport::new(&options.data_dir, &database_path, checks)
}

fn check_data_directory(path: &Path) -> DoctorCheck {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DoctorCheck::new(
                "data_directory",
                CheckStatus::Warning,
                "データ保存先はまだ作成されていません。初回起動時に作成されます。",
                json!({ "exists": false, "readable": false, "writable": false }),
            );
        }
        Err(error) => {
            return DoctorCheck::new(
                "data_directory",
                CheckStatus::Error,
                "データ保存先の状態を取得できません。",
                json!({ "exists": false, "errorKind": io_error_kind(&error) }),
            );
        }
    };
    if !metadata.is_dir() {
        return DoctorCheck::new(
            "data_directory",
            CheckStatus::Error,
            "データ保存先と同名のファイルが存在します。",
            json!({ "exists": true, "directory": false }),
        );
    }

    let readable = fs::read_dir(path).is_ok();
    let writable = write_probe(path);
    let (status, message) = match (readable, writable) {
        (true, true) => (
            CheckStatus::Ok,
            "データ保存先を読み書きできます。".to_owned(),
        ),
        (false, _) => (
            CheckStatus::Error,
            "データ保存先を読み取れません。権限を確認してください。".to_owned(),
        ),
        (_, false) => (
            CheckStatus::Error,
            "データ保存先へ書き込めません。権限と空き容量を確認してください。".to_owned(),
        ),
    };
    DoctorCheck::new(
        "data_directory",
        status,
        message,
        json!({
            "exists": true,
            "directory": true,
            "readable": readable,
            "writable": writable,
        }),
    )
}

fn write_probe(directory: &Path) -> bool {
    for sequence in 0..16_u8 {
        let path = directory.join(format!(
            ".kataru-doctor-write-test-{}-{sequence}",
            process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return fs::remove_file(path).is_ok();
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return false,
        }
    }
    false
}

fn check_database_file(path: &Path) -> DoctorCheck {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DoctorCheck::new(
                "database_file",
                CheckStatus::Warning,
                "DBファイルはまだ作成されていません。初回起動時に作成されます。",
                json!({ "exists": false, "readable": false, "writable": false }),
            );
        }
        Err(error) => {
            return DoctorCheck::new(
                "database_file",
                CheckStatus::Error,
                "DBファイルの状態を取得できません。",
                json!({ "exists": false, "errorKind": io_error_kind(&error) }),
            );
        }
    };
    if !metadata.is_file() {
        return DoctorCheck::new(
            "database_file",
            CheckStatus::Error,
            "DBパスが通常ファイルではありません。",
            json!({ "exists": true, "file": false }),
        );
    }
    let readable = OpenOptions::new().read(true).open(path).is_ok();
    let writable = OpenOptions::new().write(true).open(path).is_ok();
    let status = if readable && writable {
        CheckStatus::Ok
    } else {
        CheckStatus::Error
    };
    DoctorCheck::new(
        "database_file",
        status,
        if status == CheckStatus::Ok {
            "DBファイルを読み書きできます。"
        } else {
            "DBファイルを読み書きできません。権限を確認してください。"
        },
        json!({
            "exists": true,
            "file": true,
            "readable": readable,
            "writable": writable,
            "sizeBytes": metadata.len(),
        }),
    )
}

fn check_sqlite(path: &Path) -> (DoctorCheck, DoctorCheck) {
    let connection = match Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            let details = json!({ "connected": false, "errorCode": sqlite_error_code(&error) });
            return (
                DoctorCheck::new(
                    "sqlite",
                    CheckStatus::Error,
                    "SQLiteへ接続できません。",
                    details,
                ),
                DoctorCheck::new(
                    "migrations",
                    CheckStatus::Error,
                    "SQLiteへ接続できないため、migration状態を確認できません。",
                    json!({
                        "checked": false,
                        "expectedSchemaVersion": CURRENT_SCHEMA_VERSION,
                    }),
                ),
            );
        }
    };
    let _ = connection.busy_timeout(Duration::from_secs(5));
    let integrity =
        connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0));
    let sqlite = match integrity {
        Ok(value) if value.eq_ignore_ascii_case("ok") => DoctorCheck::new(
            "sqlite",
            CheckStatus::Ok,
            "SQLite接続と整合性検査に成功しました。",
            json!({ "connected": true, "integrity": "ok" }),
        ),
        Ok(_) => DoctorCheck::new(
            "sqlite",
            CheckStatus::Error,
            "SQLite整合性検査で破損が検出されました。自動バックアップからの復元を検討してください。",
            json!({ "connected": true, "integrity": "failed" }),
        ),
        Err(error) => DoctorCheck::new(
            "sqlite",
            CheckStatus::Error,
            "SQLite整合性検査を実行できません。",
            json!({
                "connected": true,
                "integrity": "unknown",
                "errorCode": sqlite_error_code(&error),
            }),
        ),
    };

    let migrations =
        match connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0)) {
            Ok(version) if version == CURRENT_SCHEMA_VERSION => DoctorCheck::new(
                "migrations",
                CheckStatus::Ok,
                "DB schemaは現在のバージョンです。",
                json!({
                    "schemaVersion": version,
                    "expectedSchemaVersion": CURRENT_SCHEMA_VERSION,
                }),
            ),
            Ok(version) if version < CURRENT_SCHEMA_VERSION => DoctorCheck::new(
                "migrations",
                CheckStatus::Warning,
                "DB schemaは古く、次回起動時にmigrationが必要です。",
                json!({
                    "schemaVersion": version,
                    "expectedSchemaVersion": CURRENT_SCHEMA_VERSION,
                }),
            ),
            Ok(version) => DoctorCheck::new(
                "migrations",
                CheckStatus::Error,
                "DB schemaがこのKataruより新しいため、互換性がありません。",
                json!({
                    "schemaVersion": version,
                    "expectedSchemaVersion": CURRENT_SCHEMA_VERSION,
                }),
            ),
            Err(error) => DoctorCheck::new(
                "migrations",
                CheckStatus::Error,
                "DB schemaのバージョンを確認できません。",
                json!({
                    "expectedSchemaVersion": CURRENT_SCHEMA_VERSION,
                    "errorCode": sqlite_error_code(&error),
                }),
            ),
        };
    (sqlite, migrations)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ProviderKind {
    OpenRouter,
    OpenAiCompatible,
    Anthropic,
}

impl ProviderKind {
    fn api_type(self) -> Option<String> {
        match self {
            Self::OpenRouter => None,
            Self::OpenAiCompatible => Some("openai-compatible".to_owned()),
            Self::Anthropic => Some("anthropic".to_owned()),
        }
    }

    fn models_path(self) -> &'static str {
        match self {
            Self::OpenRouter => "models?output_modalities=text",
            Self::OpenAiCompatible => "models",
            Self::Anthropic => "models?limit=1",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ConfiguredProvider {
    kind: ProviderKind,
    endpoint: &'static str,
    credential_configured: bool,
}

fn configured_providers(config: &EffectiveAiConfig) -> Vec<ConfiguredProvider> {
    let mut providers = Vec::new();
    if config.openrouter_api_key.is_some() {
        providers.push(ConfiguredProvider {
            kind: ProviderKind::OpenRouter,
            endpoint: "default-https",
            credential_configured: true,
        });
    }
    let openai_is_custom = config.openai_base_url != DEFAULT_OPENAI_BASE_URL;
    if config.openai_api_key.is_some() || openai_is_custom {
        providers.push(ConfiguredProvider {
            kind: ProviderKind::OpenAiCompatible,
            endpoint: endpoint_class(&config.openai_base_url),
            credential_configured: config.openai_api_key.is_some(),
        });
    }
    if config.anthropic_api_key.is_some() {
        providers.push(ConfiguredProvider {
            kind: ProviderKind::Anthropic,
            endpoint: if config.anthropic_base_url == DEFAULT_ANTHROPIC_BASE_URL {
                "default-https"
            } else {
                endpoint_class(&config.anthropic_base_url)
            },
            credential_configured: true,
        });
    }
    providers
}

fn endpoint_class(value: &str) -> &'static str {
    let Ok(url) = Url::parse(value) else {
        return "invalid";
    };
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    match (url.scheme(), loopback) {
        ("http", true) => "custom-loopback-http",
        ("https", true) => "custom-loopback-https",
        ("https", false) => "custom-https",
        _ => "invalid",
    }
}

fn ai_configuration_check(
    manager: &AiConfigManager,
    config: &EffectiveAiConfig,
    providers: &[ConfiguredProvider],
) -> DoctorCheck {
    let provider_details = providers
        .iter()
        .map(|provider| {
            json!({
                "provider": provider.kind,
                "endpoint": provider.endpoint,
                "credentialConfigured": provider.credential_configured,
            })
        })
        .collect::<Vec<_>>();
    let secret_store_available = manager.secret_store_available();
    let (status, message) = if providers.is_empty() {
        (
            CheckStatus::Warning,
            "利用可能なAI接続設定がありません。設定画面または kataru config を使用してください。",
        )
    } else if !secret_store_available
        && config.openrouter_api_key.is_none()
        && config.openai_api_key.is_none()
        && config.anthropic_api_key.is_none()
    {
        (
            CheckStatus::Warning,
            "AI接続先はありますが、OSの資格情報ストアを利用できません。",
        )
    } else {
        (CheckStatus::Ok, "AI接続設定は有効です。")
    };
    DoctorCheck::new(
        "ai_configuration",
        status,
        message,
        json!({
            "configuredProviders": provider_details,
            "secretStoreAvailable": secret_store_available,
        }),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiProbeResult {
    provider: ProviderKind,
    status: CheckStatus,
    code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_status: Option<u16>,
}

async fn check_ai_connectivity(
    config: &EffectiveAiConfig,
    providers: &[ConfiguredProvider],
) -> DoctorCheck {
    if providers.is_empty() {
        return DoctorCheck::new(
            "ai_connectivity",
            CheckStatus::Warning,
            "AIが未設定のため、疎通確認を実行しませんでした。",
            json!({ "checked": false, "reason": "not_configured" }),
        );
    }

    let client = match Client::builder()
        .user_agent(format!("Kataru/{} doctor", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return DoctorCheck::new(
                "ai_connectivity",
                CheckStatus::Error,
                "HTTPクライアントを初期化できません。",
                json!({ "checked": false, "reason": "client_initialization" }),
            );
        }
    };

    let mut results = Vec::with_capacity(providers.len());
    for provider in providers {
        results.push(probe_provider(&client, config, provider.kind).await);
    }
    let successes = results
        .iter()
        .filter(|result| result.status == CheckStatus::Ok)
        .count();
    let worst = results
        .iter()
        .map(|result| result.status)
        .max()
        .unwrap_or(CheckStatus::Warning);
    let status = if successes == results.len() {
        CheckStatus::Ok
    } else if successes > 0 {
        CheckStatus::Warning
    } else {
        worst
    };
    let message = match status {
        CheckStatus::Ok => "設定済みAI APIへ接続できました。",
        CheckStatus::Warning if successes > 0 => {
            "一部のAI APIへ接続できません。probe結果を確認してください。"
        }
        CheckStatus::Warning => {
            "AI APIへ接続できません。オフライン状態または上流サービスの障害が考えられます。"
        }
        CheckStatus::Error => {
            "AI APIに接続しましたが設定を拒否されました。認証情報と接続先を確認してください。"
        }
    };
    DoctorCheck::new(
        "ai_connectivity",
        status,
        message,
        json!({ "checked": true, "probes": results }),
    )
}

async fn probe_provider(
    client: &Client,
    server_config: &EffectiveAiConfig,
    kind: ProviderKind,
) -> AiProbeResult {
    let api_config = AiApiConfig {
        ai_api_type: kind.api_type(),
        ..AiApiConfig::default()
    };
    let api_client = match AiApiClient::resolve(
        client.clone(),
        "http://127.0.0.1",
        server_config,
        Some(api_config),
    ) {
        Ok(client) => client,
        Err(_) => {
            return AiProbeResult {
                provider: kind,
                status: CheckStatus::Error,
                code: "invalid_configuration",
                http_status: None,
            };
        }
    };
    match api_client
        .get(kind.models_path(), AI_PROBE_TIMEOUT)
        .send()
        .await
    {
        Ok(response) => probe_http_status(kind, response.status().as_u16()),
        Err(error) => AiProbeResult {
            provider: kind,
            status: CheckStatus::Warning,
            code: if error.is_timeout() {
                "timeout"
            } else if error.is_connect() {
                "unreachable"
            } else {
                "network_error"
            },
            http_status: None,
        },
    }
}

fn probe_http_status(provider: ProviderKind, status: u16) -> AiProbeResult {
    let (severity, code) = match status {
        200..=299 => (CheckStatus::Ok, "ready"),
        401 | 403 => (CheckStatus::Error, "authentication_rejected"),
        429 => (CheckStatus::Warning, "rate_limited"),
        400..=499 => (CheckStatus::Error, "configuration_rejected"),
        500..=599 => (CheckStatus::Warning, "upstream_unavailable"),
        _ => (CheckStatus::Warning, "unexpected_status"),
    };
    AiProbeResult {
        provider,
        status: severity,
        code,
        http_status: Some(status),
    }
}

fn io_error_kind(error: &std::io::Error) -> String {
    format!("{:?}", error.kind()).to_ascii_lowercase()
}

fn sqlite_error_code(error: &rusqlite::Error) -> Option<String> {
    error
        .sqlite_error_code()
        .map(|code| format!("{code:?}").to_ascii_lowercase())
}

fn print_human_report(report: &DoctorReport) {
    println!(
        "Kataru doctor: {} (exit {})",
        report.status.to_ascii_uppercase(),
        report.exit_code
    );
    println!(
        "version: {} ({} / {} / {})",
        report.version,
        report.build.profile,
        report.build.operating_system,
        report.build.architecture
    );
    println!("data directory: {}", report.paths.data_directory);
    println!("database: {}", report.paths.database);
    println!();
    for check in &report.checks {
        println!(
            "[{}] {}: {}",
            check.status.label(),
            check.name,
            check.message
        );
    }
}

fn print_help() {
    println!(
        "Kataru doctor\n\n  doctor [--json] [--no-network]\n\n  --json             機械可読なJSONをstdoutへ出力\n  --no-network       AI APIへの疎通確認を省略\n  --data-dir <PATH>  診断対象のデータ保存先\n  --portable         実行ファイル横の kataru-data を診断\n  --verbose          詳細な診断ログをstderrへ出力\n\n終了コード: 0=正常、1=修復が必要、2=警告（未設定・オフライン等）"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_json_and_data_directory_options() {
        let command = parse_doctor_args(&[
            "--json".to_owned(),
            "--data-dir".to_owned(),
            "diagnostic-data".to_owned(),
            "--no-network".to_owned(),
        ])
        .expect("parse doctor options");
        let DoctorCommand::Run(options) = command else {
            panic!("expected run command");
        };
        assert_eq!(options.data_dir, PathBuf::from("diagnostic-data"));
        assert!(options.json);
        assert!(!options.network);
    }

    #[test]
    fn rejects_conflicting_data_directory_options() {
        let error = parse_doctor_args(&[
            "--portable".to_owned(),
            "--data-dir".to_owned(),
            "diagnostic-data".to_owned(),
        ])
        .expect_err("reject conflicting options");
        assert_eq!(error.diagnostic_class(), "bad_request");
    }

    #[test]
    fn missing_data_directory_is_a_warning_without_creating_it() {
        let parent = tempdir().expect("create test directory");
        let path = parent.path().join("missing");

        let check = check_data_directory(&path);

        assert_eq!(check.status, CheckStatus::Warning);
        assert!(!path.exists());
    }

    #[test]
    fn data_directory_probe_is_removed_after_a_successful_check() {
        let directory = tempdir().expect("create test directory");

        let check = check_data_directory(directory.path());

        assert_eq!(check.status, CheckStatus::Ok);
        assert_eq!(
            fs::read_dir(directory.path())
                .expect("read test directory")
                .count(),
            0
        );
    }

    #[test]
    fn current_sqlite_schema_and_integrity_are_healthy() {
        let directory = tempdir().expect("create test directory");
        let path = directory.path().join("kataru.db");
        {
            let connection = Connection::open(&path).expect("open database");
            connection
                .execute_batch(&format!("PRAGMA user_version = {CURRENT_SCHEMA_VERSION};"))
                .expect("set schema version");
        }

        let (sqlite, migrations) = check_sqlite(&path);

        assert_eq!(sqlite.status, CheckStatus::Ok);
        assert_eq!(migrations.status, CheckStatus::Ok);
    }

    #[test]
    fn older_sqlite_schema_is_reported_as_a_warning() {
        let directory = tempdir().expect("create test directory");
        let path = directory.path().join("kataru.db");
        {
            let connection = Connection::open(&path).expect("open database");
            connection
                .execute_batch("PRAGMA user_version = 1;")
                .expect("set old schema version");
        }

        let (_, migrations) = check_sqlite(&path);

        assert_eq!(migrations.status, CheckStatus::Warning);
    }

    #[test]
    fn corrupt_database_is_reported_without_echoing_contents() {
        let directory = tempdir().expect("create test directory");
        let path = directory.path().join("kataru.db");
        fs::write(&path, b"super-secret invalid sqlite payload").expect("write corrupt database");

        let (sqlite, _) = check_sqlite(&path);
        let serialized = serde_json::to_string(&sqlite).expect("serialize check");

        assert_eq!(sqlite.status, CheckStatus::Error);
        assert!(!serialized.contains("super-secret"));
    }

    #[test]
    fn provider_details_never_contain_api_keys_or_base_urls() {
        let config = EffectiveAiConfig {
            openrouter_api_key: Some("openrouter-super-secret".to_owned()),
            openai_base_url: "http://127.0.0.1:1234/v1/private-name".to_owned(),
            openai_api_key: Some("openai-super-secret".to_owned()),
            anthropic_base_url: DEFAULT_ANTHROPIC_BASE_URL.to_owned(),
            anthropic_api_key: None,
        };

        let serialized = serde_json::to_string(
            &configured_providers(&config)
                .iter()
                .map(|provider| {
                    json!({
                        "provider": provider.kind,
                        "endpoint": provider.endpoint,
                        "credentialConfigured": provider.credential_configured,
                    })
                })
                .collect::<Vec<_>>(),
        )
        .expect("serialize provider summary");

        assert!(!serialized.contains("super-secret"));
        assert!(!serialized.contains("private-name"));
        assert!(serialized.contains("custom-loopback-http"));
    }

    #[test]
    fn http_probe_statuses_distinguish_configuration_and_offline_warnings() {
        assert_eq!(
            probe_http_status(ProviderKind::OpenRouter, 200).status,
            CheckStatus::Ok
        );
        assert_eq!(
            probe_http_status(ProviderKind::OpenRouter, 401).status,
            CheckStatus::Error
        );
        assert_eq!(
            probe_http_status(ProviderKind::OpenRouter, 429).status,
            CheckStatus::Warning
        );
        assert_eq!(
            probe_http_status(ProviderKind::OpenRouter, 503).status,
            CheckStatus::Warning
        );
    }

    #[test]
    fn report_exit_codes_follow_the_worst_check() {
        for (check_status, report_status, exit_code) in [
            (CheckStatus::Ok, "ok", 0),
            (CheckStatus::Warning, "warning", 2),
            (CheckStatus::Error, "failure", 1),
        ] {
            let report = DoctorReport::new(
                Path::new("data"),
                Path::new("data/kataru.db"),
                vec![DoctorCheck::new(
                    "test",
                    check_status,
                    "test status",
                    json!({}),
                )],
            );
            assert_eq!(report.status, report_status);
            assert_eq!(report.exit_code, exit_code);
            let json = serde_json::to_value(report).expect("serialize report");
            assert_eq!(json["schemaVersion"], 1);
            assert_eq!(json["exitCode"], exit_code);
        }
    }
}
