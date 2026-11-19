#[tokio::main]
async fn main() {
    if let Err(error) = kataru::run_cli().await {
        eprintln!("Kataruを起動できませんでした: {error}");
        std::process::exit(1);
    }
}
