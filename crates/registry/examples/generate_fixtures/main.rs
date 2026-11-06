//! Write the MMR and batch-open fixtures, the Noir witness vectors, and Prover.toml.
//!
//! Usage: `cargo run -p anon-credit-registry --example generate_fixtures`

mod render;

use std::path::PathBuf;

fn main() -> Result<(), render::RenderError> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (path, text) in render::render_all()? {
        std::fs::write(root.join(path), text)?;
        println!("wrote {path}");
    }
    Ok(())
}
