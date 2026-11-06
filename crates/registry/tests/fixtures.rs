//! Check that the generated fixture files are up to date with the registry and crypto code.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

#[path = "../examples/generate_fixtures/render.rs"]
mod render;

#[test]
fn generated_fixtures_are_up_to_date() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (path, text) in render::render_all().unwrap() {
        let on_disk = std::fs::read_to_string(root.join(path)).unwrap_or_default();
        assert!(
            on_disk == text,
            "{path} is out of date. Run: cargo run -p anon-credit-registry --example generate_fixtures"
        );
    }
}
