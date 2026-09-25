use std::{
    env, io,
    path::{Path, PathBuf},
};

/// `.env` をプロセス環境へ読み込み、実際に読み込んだパスを返す。
/// dotenvyは設定済みの環境変数を上書きしないため、OSの環境変数が常に優先される。
pub fn load() -> Vec<PathBuf> {
    let mut loaded = Vec::new();
    for path in candidates() {
        match dotenvy::from_path(&path) {
            Ok(()) => loaded.push(path),
            Err(dotenvy::Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                eprintln!("warning: {} を読み込めませんでした: {error}", path.display());
            }
        }
    }
    loaded
}

fn candidates() -> Vec<PathBuf> {
    let cwd = env::current_dir().ok();
    let exe_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    search_dirs(cwd, exe_dir)
        .iter()
        .map(|dir| dir.join(".env"))
        .collect()
}

/// 環境変数ファイルを探すディレクトリ。カレントディレクトリを優先し、
/// 実行ファイルと同じ場所も対象にする（ポータブル利用ではcwdが別場所になり得るため）。
fn search_dirs(cwd: Option<PathBuf>, exe_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = cwd {
        dirs.push(dir);
    }
    if let Some(dir) = exe_dir
        && !dirs.contains(&dir)
    {
        dirs.push(dir);
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_is_checked_before_exe_dir() {
        assert_eq!(
            search_dirs(
                Some(PathBuf::from("/work")),
                Some(PathBuf::from("/opt/app"))
            ),
            vec![PathBuf::from("/work"), PathBuf::from("/opt/app")]
        );
    }

    #[test]
    fn exe_dir_is_skipped_when_same_as_cwd() {
        assert_eq!(
            search_dirs(Some(PathBuf::from("/app")), Some(PathBuf::from("/app"))),
            vec![PathBuf::from("/app")]
        );
    }

    #[test]
    fn missing_dirs_are_tolerated() {
        assert!(search_dirs(None, None).is_empty());
        assert_eq!(
            search_dirs(None, Some(PathBuf::from("/opt/app"))),
            vec![PathBuf::from("/opt/app")]
        );
    }
}
