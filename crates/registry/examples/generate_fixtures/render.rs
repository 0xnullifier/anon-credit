//! Fixture rendering. `main.rs` writes the files. `tests/fixtures.rs` compares them with disk.

use anon_credit_crypto::batch::{commitment, leaf};
use anon_credit_crypto::{FieldElement, keccak256};
use anon_credit_registry::proof::check_proof;
use anon_credit_registry::{BatchOpenWitness, MembershipProof, MemoryStore, Mmr, OpenSecrets};
use serde::Serialize;

/// Path of the MMR fixture.
pub const MMR_PATH: &str = "fixtures/protocol/mmr.json";
/// Path of the batch-open fixture.
pub const BATCH_OPEN_PATH: &str = "fixtures/protocol/batch-open.json";
/// Path of the generated Noir witness file.
pub const NOIR_WITNESS_PATH: &str = "circuits/batch-open/src/witness_vectors.nr";
/// Path of the Prover.toml of the circuit.
pub const PROVER_TOML_PATH: &str = "circuits/batch-open/Prover.toml";

/// Tree sizes of the batch-open witnesses, with the leaf index of each witness.
pub const WITNESS_TREES: [(u32, u32); 6] = [(1, 0), (2, 0), (3, 2), (7, 4), (8, 5), (100, 37)];

/// Fixture error.
pub type RenderError = Box<dyn std::error::Error>;

fn tagged(label: &str, index: u32) -> [u8; 32] {
    let mut input = label.as_bytes().to_vec();
    input.extend_from_slice(&index.to_be_bytes());
    keccak256(&input)
}

fn deployment_id() -> [u8; 32] {
    keccak256(b"anon-credit fixture deployment")
}

fn gateway_id() -> [u8; 32] {
    keccak256(b"anon-credit fixture gateway")
}

const BASE_EPOCH: u64 = 1_000;
const LIFETIME_EPOCHS: u64 = 35_040;

fn secrets(index: u32) -> OpenSecrets {
    let expiry = BASE_EPOCH + LIFETIME_EPOCHS + u64::from(index);
    OpenSecrets {
        deployment_id: deployment_id(),
        gateway_id: gateway_id(),
        k: tagged("anon-credit fixture k", index),
        session_pub: tagged("anon-credit fixture session", index),
        expiry,
        proof_epoch: BASE_EPOCH + 5 + u64::from(index),
    }
}

fn batch_leaf(index: u32) -> FieldElement {
    let s = secrets(index);
    leaf(commitment(&s.deployment_id, &s.k), s.expiry)
}

fn hex32(bytes: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

#[derive(Serialize)]
struct MmrFixture {
    description: &'static str,
    leaves: Vec<FieldElement>,
    snapshots: Vec<Snapshot>,
    proofs: Vec<ProofCase>,
    invalid_proofs: Vec<InvalidProofCase>,
}

#[derive(Serialize)]
struct Snapshot {
    leaf_count: u32,
    peak_heights: Vec<u8>,
    peaks: Vec<FieldElement>,
    root: FieldElement,
}

#[derive(Serialize)]
struct ProofCase {
    root: FieldElement,
    leaf: FieldElement,
    proof: MembershipProof,
}

#[derive(Serialize)]
struct InvalidProofCase {
    name: &'static str,
    reason: &'static str,
    root: FieldElement,
    leaf: FieldElement,
    proof: MembershipProof,
}

#[derive(Serialize)]
struct BatchOpenFixture {
    description: &'static str,
    cases: Vec<BatchOpenCase>,
}

#[derive(Serialize)]
struct BatchOpenCase {
    name: String,
    input: BatchOpenInput,
    leaf: FieldElement,
    root: FieldElement,
    proof: MembershipProof,
    public_inputs: Vec<FieldElement>,
    witness: BatchOpenWitness,
}

#[derive(Serialize)]
struct BatchOpenInput {
    deployment_id: String,
    gateway_id: String,
    k: String,
    session_pub: String,
    expiry: String,
    proof_epoch: String,
}

fn build_tree(count: u32) -> Result<Mmr<MemoryStore>, RenderError> {
    let mut mmr = Mmr::new(MemoryStore::new());
    for index in 0..count {
        mmr.append(batch_leaf(index))?;
    }
    Ok(mmr)
}

fn bump(value: FieldElement) -> Result<FieldElement, RenderError> {
    let mut bytes = value.to_bytes_be();
    bytes[31] ^= 1;
    Ok(FieldElement::from_bytes_be(&bytes)?)
}

fn mmr_fixture() -> Result<MmrFixture, RenderError> {
    let mmr = build_tree(100)?;
    let leaves: Vec<FieldElement> = (0..100).map(batch_leaf).collect();
    let mut snapshots = Vec::new();
    for count in [0u32, 1, 2, 3, 4, 5, 7, 8, 11, 64, 100] {
        let peaks = mmr.peaks_at(count)?;
        snapshots.push(Snapshot {
            leaf_count: count,
            peak_heights: peaks.iter().map(|peak| peak.height).collect(),
            peaks: peaks.iter().map(|peak| peak.hash).collect(),
            root: mmr.root_at(count)?,
        });
    }
    let mut proofs = Vec::new();
    for (index, count) in [
        (0u32, 1u32),
        (0, 2),
        (1, 2),
        (2, 3),
        (4, 7),
        (6, 7),
        (5, 8),
        (10, 11),
        (63, 64),
        (0, 100),
        (37, 100),
        (99, 100),
        (20, 37),
    ] {
        proofs.push(ProofCase {
            root: mmr.root_at(count)?,
            leaf: leaves[index as usize],
            proof: mmr.membership_proof_at(index, count)?,
        });
    }
    let base_root = mmr.root_at(100)?;
    let base = mmr.membership_proof_at(37, 100)?;
    let leaf37 = leaves[37];
    let mut invalid_proofs = Vec::new();
    let mut push = |name, reason, root, leaf, proof: MembershipProof| {
        invalid_proofs.push(InvalidProofCase {
            name,
            reason,
            root,
            leaf,
            proof,
        });
    };
    push(
        "wrong_leaf",
        "peak_mismatch",
        base_root,
        leaves[36],
        base.clone(),
    );
    push(
        "wrong_root",
        "root_mismatch",
        bump(base_root)?,
        leaf37,
        base.clone(),
    );
    let mut changed = base.clone();
    changed.siblings[2] = bump(changed.siblings[2])?;
    push(
        "changed_sibling",
        "peak_mismatch",
        base_root,
        leaf37,
        changed,
    );
    let mut changed = base.clone();
    changed.leaf_index = 36;
    push("wrong_index", "peak_mismatch", base_root, leaf37, changed);
    let mut changed = base.clone();
    changed.leaf_index = 100;
    push(
        "index_not_below_count",
        "index_out_of_range",
        base_root,
        leaf37,
        changed,
    );
    let mut changed = base.clone();
    changed.leaf_count = 101;
    push(
        "wrong_leaf_count",
        "wrong_peak_count",
        base_root,
        leaf37,
        changed,
    );
    let mut changed = base.clone();
    changed.peak_position = 1;
    push(
        "wrong_peak_position",
        "wrong_peak_position",
        base_root,
        leaf37,
        changed,
    );
    let mut changed = base.clone();
    changed.siblings.push(FieldElement::ZERO);
    push(
        "extra_sibling",
        "wrong_sibling_count",
        base_root,
        leaf37,
        changed,
    );
    let mut changed = base.clone();
    changed.peaks.swap(0, 1);
    push("swapped_peaks", "peak_mismatch", base_root, leaf37, changed);
    let older = mmr.membership_proof_at(20, 37)?;
    push(
        "proof_of_older_snapshot",
        "root_mismatch",
        base_root,
        leaves[20],
        older,
    );
    for case in &invalid_proofs {
        if check_proof(case.root, &case.proof, case.leaf).is_ok() {
            return Err(format!("invalid case {} verifies", case.name).into());
        }
    }
    Ok(MmrFixture {
        description: "MMR vectors. leaves[i] is the batch leaf of fixture batch i (see batch-open.json). Peaks are in descending height order. root = H(DOM_MMR_ROOT, leaf_count, slot[31], ..., slot[0]) with slot[h] the peak of height h or zero. Generated by: cargo run -p anon-credit-registry --example generate_fixtures.",
        leaves,
        snapshots,
        proofs,
        invalid_proofs,
    })
}

fn witness_case(count: u32, index: u32) -> Result<BatchOpenCase, RenderError> {
    let mmr = build_tree(count)?;
    let s = secrets(index);
    let witness = BatchOpenWitness::from_mmr(&mmr, count, index, &s)?;
    Ok(BatchOpenCase {
        name: format!("tree_{count}_index_{index}"),
        input: BatchOpenInput {
            deployment_id: hex32(&s.deployment_id),
            gateway_id: hex32(&s.gateway_id),
            k: hex32(&s.k),
            session_pub: hex32(&s.session_pub),
            expiry: s.expiry.to_string(),
            proof_epoch: s.proof_epoch.to_string(),
        },
        leaf: batch_leaf(index),
        root: mmr.root_at(count)?,
        proof: mmr.membership_proof_at(index, count)?,
        public_inputs: witness.public_inputs().to_vec(),
        witness,
    })
}

fn noir_list(values: &[FieldElement]) -> String {
    let items: Vec<String> = values.iter().map(ToString::to_string).collect();
    format!("[{}]", items.join(", "))
}

fn render_noir(cases: &[BatchOpenCase]) -> String {
    let mut out = String::new();
    out.push_str("// Generated from fixtures/protocol/batch-open.json.\n");
    out.push_str(
        "// Do not edit. Run `cargo run -p anon-credit-registry --example generate_fixtures`.\n",
    );
    out.push_str(
        "// Valid batch-open witnesses. tests.nr runs main with them and with changed values.\n\n",
    );
    out.push_str("pub struct TestWitness {\n");
    for (name, ty) in [
        ("circuit_id", "Field"),
        ("deployment_id", "[Field; 2]"),
        ("gateway_id", "[Field; 2]"),
        ("root", "Field"),
        ("leaf_count", "Field"),
        ("proof_epoch", "u64"),
        ("batch_id", "Field"),
        ("binding", "Field"),
        ("k", "[Field; 2]"),
        ("expiry", "u64"),
        ("leaf_index", "Field"),
        ("siblings", "[Field; 32]"),
        ("peaks", "[Field; 32]"),
        ("session_pub", "[Field; 2]"),
    ] {
        out.push_str(&format!("    pub {name}: {ty},\n"));
    }
    out.push_str("}\n");
    for case in cases {
        let w = &case.witness;
        out.push_str(&format!(
            "\n// Tree of {} leaves, leaf index {}.\npub fn {}() -> TestWitness {{\n    TestWitness {{\n",
            w.leaf_count, w.leaf_index, case.name
        ));
        out.push_str(&format!("        circuit_id: {},\n", w.circuit_id));
        out.push_str(&format!(
            "        deployment_id: {},\n",
            noir_list(&w.deployment_id)
        ));
        out.push_str(&format!(
            "        gateway_id: {},\n",
            noir_list(&w.gateway_id)
        ));
        out.push_str(&format!("        root: {},\n", w.root));
        out.push_str(&format!("        leaf_count: {},\n", w.leaf_count));
        out.push_str(&format!("        proof_epoch: {},\n", w.proof_epoch));
        out.push_str(&format!("        batch_id: {},\n", w.batch_id));
        out.push_str(&format!("        binding: {},\n", w.binding));
        out.push_str(&format!("        k: {},\n", noir_list(&w.k)));
        out.push_str(&format!("        expiry: {},\n", w.expiry));
        out.push_str(&format!("        leaf_index: {},\n", w.leaf_index));
        out.push_str(&format!("        siblings: {},\n", noir_list(&w.siblings)));
        out.push_str(&format!("        peaks: {},\n", noir_list(&w.peaks)));
        out.push_str(&format!(
            "        session_pub: {},\n",
            noir_list(&w.session_pub)
        ));
        out.push_str("    }\n}\n");
    }
    out
}

/// Render all fixture files as (repository path, text).
pub fn render_all() -> Result<Vec<(&'static str, String)>, RenderError> {
    let mmr = mmr_fixture()?;
    let cases = WITNESS_TREES
        .iter()
        .map(|(count, index)| witness_case(*count, *index))
        .collect::<Result<Vec<_>, _>>()?;
    let noir = render_noir(&cases);
    let prover_case = cases
        .iter()
        .find(|case| case.witness.leaf_count == 7)
        .ok_or("no witness of 7 leaves")?;
    let prover = format!(
        "# Generated by `cargo run -p anon-credit-registry --example generate_fixtures`.\n# Valid witness: {}.\n{}",
        prover_case.name,
        prover_case.witness.to_prover_toml()
    );
    let batch = BatchOpenFixture {
        description: "Batch-open witnesses. Each case has the client inputs, the leaf, the selected root and membership proof, the public-input vector in circuit order, and the full circuit witness (field names are the parameters of main in circuits/batch-open/src/main.nr). k_i = keccak256(\"anon-credit fixture k\" || u32_be(i)); session_pub_i = keccak256(\"anon-credit fixture session\" || u32_be(i)); the session keys are test bytes, not Ed25519 points. Generated by: cargo run -p anon-credit-registry --example generate_fixtures.",
        cases,
    };
    Ok(vec![
        (
            MMR_PATH,
            format!("{}\n", serde_json::to_string_pretty(&mmr)?),
        ),
        (
            BATCH_OPEN_PATH,
            format!("{}\n", serde_json::to_string_pretty(&batch)?),
        ),
        (NOIR_WITNESS_PATH, noir),
        (PROVER_TOML_PATH, prover),
    ])
}
