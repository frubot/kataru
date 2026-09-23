fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let icon = manifest_dir.join("public").join("favicon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());

    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let rc_path = out_dir.join("icon.rc");
    let icon_literal = icon.display().to_string().replace('\\', "\\\\");
    std::fs::write(&rc_path, format!("1 ICON \"{icon_literal}\"")).unwrap();
    match embed_resource::compile(&rc_path, embed_resource::NONE) {
        embed_resource::CompilationResult::Failed(e) => {
            panic!("failed to embed icon resource: {e}");
        }
        embed_resource::CompilationResult::NotAttempted(e) => {
            println!("cargo:warning=icon resource not compiled: {e}");
        }
        _ => {}
    }
}
