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

/// Path of the public-input order contract of the batch-open circuit.
pub const PUBLIC_INPUTS_PATH: &str = "fixtures/protocol/batch-open-public-inputs.json";
/// Path of the full gate witness (circuit inputs by ABI name) for the browser gate page.
pub const GATE_WITNESS_PATH: &str = "artifacts/batch-open/gate-witness.json";

/// Tree size and leaf index of the gate witness.
pub const GATE_TREE: (u32, u32) = (100, 37);

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

// The gate witness uses the deployment of fixtures/protocol/deployment-id.json (a deployment ID
// from the real 242-byte encoding) and a real Ed25519 session key (RFC 8032 test 1 public key).
const DEPLOYMENT_ID_FIXTURE: &str =
    include_str!("../../../../fixtures/protocol/deployment-id.json");
const RFC8032_TEST1_PUBLIC_KEY: &str =
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
// Testnet epochs (30 s) near 2026-11: the purchase epoch, and the epoch of the proof.
const GATE_PURCHASE_EPOCH: u64 = 59_000_000;
const GATE_PROOF_EPOCH: u64 = 59_010_000;

#[derive(serde::Deserialize)]
struct DeploymentIdFixture {
    cases: Vec<DeploymentIdCase>,
}

#[derive(serde::Deserialize)]
struct DeploymentIdCase {
    input: DeploymentIdInput,
    expected: DeploymentIdExpected,
}

#[derive(serde::Deserialize)]
struct DeploymentIdInput {
    gateway_id: String,
}

#[derive(serde::Deserialize)]
struct DeploymentIdExpected {
    deployment_id: String,
}

fn parse_hex32(text: &str) -> Result<[u8; 32], RenderError> {
    let digits = text.strip_prefix("0x").unwrap_or(text);
    let mut bytes = [0_u8; 32];
    hex::decode_to_slice(digits, &mut bytes)?;
    Ok(bytes)
}

// The deployment ID and gateway ID of the first case of deployment-id.json.
fn gate_identity() -> Result<([u8; 32], [u8; 32]), RenderError> {
    let fixture: DeploymentIdFixture = serde_json::from_str(DEPLOYMENT_ID_FIXTURE)?;
    let case = fixture
        .cases
        .first()
        .ok_or("deployment-id.json has no case")?;
    Ok((
        parse_hex32(&case.expected.deployment_id)?,
        parse_hex32(&case.input.gateway_id)?,
    ))
}

fn gate_secrets(index: u32) -> Result<OpenSecrets, RenderError> {
    let (deployment_id, gateway_id) = gate_identity()?;
    Ok(OpenSecrets {
        deployment_id,
        gateway_id,
        k: tagged("anon-credit gate k", index),
        session_pub: parse_hex32(RFC8032_TEST1_PUBLIC_KEY)?,
        expiry: GATE_PURCHASE_EPOCH + LIFETIME_EPOCHS + u64::from(index),
        proof_epoch: GATE_PROOF_EPOCH,
    })
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

// The gate case: a tree of 100 leaves of the gate deployment, and a witness for one leaf.
fn gate_case() -> Result<BatchOpenCase, RenderError> {
    let (count, index) = GATE_TREE;
    let mut mmr = Mmr::new(MemoryStore::new());
    for leaf_index in 0..count {
        let s = gate_secrets(leaf_index)?;
        mmr.append(leaf(commitment(&s.deployment_id, &s.k), s.expiry))?;
    }
    let s = gate_secrets(index)?;
    let witness = BatchOpenWitness::from_mmr(&mmr, count, index, &s)?;
    Ok(BatchOpenCase {
        name: format!("gate_tree_{count}_index_{index}"),
        input: BatchOpenInput {
            deployment_id: hex32(&s.deployment_id),
            gateway_id: hex32(&s.gateway_id),
            k: hex32(&s.k),
            session_pub: hex32(&s.session_pub),
            expiry: s.expiry.to_string(),
            proof_epoch: s.proof_epoch.to_string(),
        },
        leaf: leaf(commitment(&s.deployment_id, &s.k), s.expiry),
        root: mmr.root_at(count)?,
        proof: mmr.membership_proof_at(index, count)?,
        public_inputs: witness.public_inputs().to_vec(),
        witness,
    })
}

#[derive(Serialize)]
struct PublicInputsFixture {
    description: &'static str,
    circuit: &'static str,
    encoding: &'static str,
    count: usize,
    order: Vec<PublicInputEntry>,
    circuit_id: FieldElement,
    gate_case: PublicInputsCase,
}

#[derive(Serialize)]
struct PublicInputEntry {
    index: usize,
    name: &'static str,
    noir_parameter: &'static str,
    source: &'static str,
}

#[derive(Serialize)]
struct PublicInputsCase {
    name: String,
    input: PublicInputsCaseInput,
    public_inputs: Vec<FieldElement>,
}

#[derive(Serialize)]
struct PublicInputsCaseInput {
    deployment_id: String,
    gateway_id: String,
    session_pub: String,
    root: FieldElement,
    leaf_count: u32,
    proof_epoch: String,
    batch_id: FieldElement,
}

// The canonical public-input order. This list is written by hand from the parameters of main
// in circuits/batch-open/src/main.nr. It is not taken from the Rust or TypeScript code, so the
// tests of those implementations check them against an independent list.
const PUBLIC_INPUT_ORDER: [(&str, &str, &str); 10] = [
    (
        "circuit_id",
        "circuit_id",
        "DeploymentConfig.circuit_id; equal to CIRCUIT_ID",
    ),
    (
        "deployment_id_hi",
        "deployment_id[0]",
        "DeploymentConfig.deployment_id(), bytes 0..16",
    ),
    (
        "deployment_id_lo",
        "deployment_id[1]",
        "DeploymentConfig.deployment_id(), bytes 16..32",
    ),
    (
        "gateway_id_hi",
        "gateway_id[0]",
        "DeploymentConfig.gateway_id, bytes 0..16",
    ),
    (
        "gateway_id_lo",
        "gateway_id[1]",
        "DeploymentConfig.gateway_id, bytes 16..32",
    ),
    (
        "root",
        "root",
        "accepted root record that the open request selects",
    ),
    (
        "leaf_count",
        "leaf_count",
        "leaf count of the same root record",
    ),
    (
        "proof_epoch",
        "proof_epoch",
        "open request; the gateway checks that it is fresh",
    ),
    ("batch_id", "batch_id", "open request"),
    (
        "binding",
        "binding",
        "H(DOM_BINDING, gateway_id_hi, gateway_id_lo, session_pub_hi, session_pub_lo), calculated by the gateway from the session key of the open request",
    ),
];

fn public_inputs_fixture(case: &BatchOpenCase) -> PublicInputsFixture {
    PublicInputsFixture {
        description: "Canonical public-input vector of circuits/batch-open: the exact field elements that the ProveKit verifier receives, in this order. The gateway (phase 3) and the SDK (phase 4) must build this vector; anon_credit_crypto::public_inputs and packages/crypto/src/public-inputs.ts check it against this file, and crates/prover checks it against a real proof. gate_case is the witness that the ProveKit gate proves (tree of 100 leaves; deployment and gateway of deployment-id.json; RFC 8032 test 1 public key as the session key). Generated by: cargo run -p anon-credit-registry --example generate_fixtures.",
        circuit: "circuits/batch-open",
        encoding: "Each value is a canonical BN254 scalar field element: 0x and 64 lowercase hex digits, big-endian. A 32-byte value is two 128-bit limbs [hi, lo]. The ProveKit JSON proof stores the same values as little-endian hex.",
        count: PUBLIC_INPUT_ORDER.len(),
        order: PUBLIC_INPUT_ORDER
            .iter()
            .enumerate()
            .map(|(index, (name, noir_parameter, source))| PublicInputEntry {
                index,
                name,
                noir_parameter,
                source,
            })
            .collect(),
        circuit_id: case.witness.circuit_id,
        gate_case: PublicInputsCase {
            name: case.name.clone(),
            input: PublicInputsCaseInput {
                deployment_id: case.input.deployment_id.clone(),
                gateway_id: case.input.gateway_id.clone(),
                session_pub: case.input.session_pub.clone(),
                root: case.root,
                leaf_count: case.witness.leaf_count,
                proof_epoch: case.input.proof_epoch.clone(),
                batch_id: case.witness.batch_id,
            },
            public_inputs: case.public_inputs.clone(),
        },
    }
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
    let gate = gate_case()?;
    let prover = format!(
        "# Generated by `cargo run -p anon-credit-registry --example generate_fixtures`.\n# Valid witness: {} (the ProveKit gate witness).\n{}",
        gate.name,
        gate.witness.to_prover_toml()
    );
    let public_inputs = public_inputs_fixture(&gate);
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
        (
            PUBLIC_INPUTS_PATH,
            format!("{}\n", serde_json::to_string_pretty(&public_inputs)?),
        ),
        (
            GATE_WITNESS_PATH,
            format!("{}\n", serde_json::to_string_pretty(&gate.witness)?),
        ),
    ])
}
