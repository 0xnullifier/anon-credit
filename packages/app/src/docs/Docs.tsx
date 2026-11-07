// The docs view: the system, for a technical reader. Every number comes from the repository
// documents and artifacts named under each section. Nothing here is measured by the page.

import architecture from "../../public/docs/architecture.png";
import { DOCS_SECTIONS, sectionHash, type DocsSection } from "./sections.ts";
import { DocSection, Source, Table } from "./parts.tsx";

const SEPOLIA = {
  creditSale: "0x121f911867ac81aeba7d41ddfbfadec2a1787acb",
  rootRegistry: "0xa7804062bfe4b4205b8597a477e3b039981fb7e8",
  issuer: "0xaf2ad5789a697a927cdd7cadb84b4fe7da199e95",
  block: 12080365,
  deployedAt: "2026-11-07T01:20:18Z",
};

const PROVEKIT_REV = "201b7b639f5dd5632c01561fcb2a96c2fc8851f3";

function section(id: string): DocsSection {
  return DOCS_SECTIONS.find((item) => item.id === id) ?? { id, title: id };
}

function Etherscan({ address }: { readonly address: string }) {
  return (
    <a href={`https://sepolia.etherscan.io/address/${address}`} target="_blank" rel="noreferrer">
      {address}
    </a>
  );
}

export function Docs({ activeSection }: { readonly activeSection: string }) {
  return (
    <div className="docs">
      <nav className="doc-index" aria-label="sections">
        <p className="doc-index-title">
          <a href="#">← app</a>
        </p>
        <ol>
          {DOCS_SECTIONS.map((item, index) => (
            <li key={item.id} className={item.id === activeSection ? "active" : ""}>
              <a href={sectionHash(item.id)}>
                <span className="n">{index + 1}</span> {item.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <article className="doc-body">
        <header className="doc-head">
          <h1>anon-credit: how the system works</h1>
          <p>
            Prepaid credit for JSON-RPC without an identity. One proof per batch of 100 units, signed requests inside the batch, and a
            gateway that never learns who paid. This page describes the protocol and the code as they are in the repository, with the
            measured numbers and the targets that were missed.
          </p>
        </header>

        <DocSection section={section("claim")} n={1}>
          <p>
            An RPC provider sees the IP address and the wallet addresses of every request. An API key travels inside each request. The key
            is a stable identifier tied to a billing account, an email, and a card. An anonymity network hides the IP address; the key still
            names the customer. Nobody can pay for RPC without an identity.
          </p>
          <p>anon-credit replaces the key with prepaid credit that has no identity. The gateway holds, per session:</p>
          <Table
            head={["the gateway holds", "the gateway does not hold"]}
            rows={[
              ["batch_id: a hash of the batch secret, under the id domain", "the payer address and the payment transaction"],
              ["the session public key (Ed25519) and its binding", "the commitment c, the leaf, the leaf index"],
              ["remaining units, cumulative units, next sequence", "the batch secret k, the session secret key"],
              ["open epoch, deadline epoch, the frozen price table hash", "the client IP address, when the session runs through Nox"],
            ]}
          />
          <p>The privacy boundary is exact. The product breaks one link: the link between the person who paid and the session that spends.</p>
          <Table
            head={["link", "broken by", "what remains"]}
            rows={[
              ["payer to session", "the open proof (this product)", "a batch id that matches no customer record"],
              ["network location to session", "Anon-RPC (Nox), Tor, or a mixnet", "an exit node address"],
              ["query content to person", "nothing", "whatever the questions reveal"],
            ]}
          />
          <p>
            Requests inside one batch are linkable by design: one batch id, one session key, one sequence. K = 100 is the privacy dial.
            The gateway sees the content of every query. A client whose queries identify it is identified by content.
          </p>
          <Source files={["PRD.md sections 2, 3, 6, 10", "FUTURE.md section 8"]} />
        </DocSection>

        <DocSection section={section("architecture")} n={2}>
          <p>Four parties. The browser holds every secret. The chain holds payments and roots. The issuer holds the tree. The gateway holds sessions.</p>
          <img className="doc-figure" src={architecture} alt="architecture sketch: browser, CreditSale and RootRegistry on Sepolia, issuer, gateway with the verifier sidecar" />
          <Table
            head={["party", "runs", "holds", "what crosses its boundary"]}
            rows={[
              [
                "browser (SDK, prover, Nox worker)",
                "the customer's page",
                "k, session keys, leaf metadata, open request, journal; AES-256-GCM in IndexedDB under a passphrase",
                "out: commitments c to the chain; proof and signed requests to the gateway; path reads to the issuer on a separate isolation key",
              ],
              [
                "CreditSale and RootRegistry (Sepolia)",
                "the chain",
                "Purchased(payer, purchaseId, commitments[], amount) events; one root per epoch, postRoot(epoch, root, leaf_count) by the issuer key only",
                "in: buy(commitments) with exactly batch_price_wei * n; postRoot from the issuer. out: logs and rootAt(epoch) to anyone",
              ],
              [
                "issuer",
                "Rust service, /v1 API",
                "the MMR (SQLite), payments keyed by (chain_id, tx_hash, log_index), root publications, the payer list",
                "in: Purchased logs at the block tag. out: leaves, paths, roots, config. It never sees a batch id or a request",
              ],
              [
                "gateway and verifier sidecar",
                "Rust service, /v1 API; ProveKit verifier on 127.0.0.1",
                "one row per session (batch_id, session_pub, remaining, next_seq, epochs), receipts, a cache of accepted roots",
                "in: proofs, signed spends, signed status. out: raw JSON-RPC bytes from the upstream node. It reads roots from the contract, not from the issuer",
              ],
            ]}
          />
          <p>Live Sepolia deployment (contracts/deployments/sepolia.json, deployed {SEPOLIA.deployedAt}, block {SEPOLIA.block.toLocaleString("en-US")}):</p>
          <Table
            head={["contract", "address"]}
            rows={[
              ["CreditSale", <Etherscan address={SEPOLIA.creditSale} />],
              ["RootRegistry", <Etherscan address={SEPOLIA.rootRegistry} />],
              ["issuer (deployer and root publisher)", <Etherscan address={SEPOLIA.issuer} />],
              ["batch price", "100000000000000 wei (0.0001 ETH); epoch 30 s"],
            ]}
          />
          <p>
            The deployment identity binds all of it: deployment_id = keccak256 of a 242-byte encoding of chain id, both contract addresses, the
            issuer address, gateway_id, batch size, epoch length, credit lifetime, circuit id, verifier hash, and prover manifest hash. The
            client checks at connect that the issuer and the gateway report the same deployment_id, gateway_id, circuit_id, verifier hash,
            and epoch, and that the served prover manifest has the pinned digest.
          </p>
          <Source files={["Architecture.md section 1", "REFERENCE.md: Protocol encodings, Credit issuance, Gateway", "contracts/deployments/sepolia.json"]} />
        </DocSection>

        <DocSection section={section("credentials")} n={3}>
          <p>Every credential value is a Poseidon2 hash over the BN254 scalar field with a domain tag. The same function runs in Noir, Rust, and TypeScript; shared vectors prove that they agree.</p>
          <pre>{`H(x_1, ..., x_n) = Poseidon2 over BN254 scalar field p
p = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
permutation: width 4, S-box x^5, 8 full rounds, 56 partial rounds
sponge: state [0, 0, 0, n * 2^64], rate 3, capacity 1
absorb in order; when the cache has 3 values and one more comes,
add the cache to state words 0..3 and permute
squeeze: add the zero-padded cache, permute, return word 0
n inputs use max(1, ceil(n / 3)) permutations

a 32-byte value enters as two 128-bit limbs [hi, lo]: hi = bytes 0..16, lo = bytes 16..32
the limbs are never reduced; the circuit constrains each to 128 bits`}</pre>
          <pre>{`k        = 32 random bytes (crypto.getRandomValues), never shared
c        = H(DOM_COMMITMENT, deployment_id_hi, deployment_id_lo, k_hi, k_lo)   sent at purchase
leaf     = H(DOM_LEAF, c, K, expiry)                 K = 100; built by the issuer
batch_id = H(DOM_BATCH_ID, deployment_id_hi, deployment_id_lo, k_hi, k_lo)   revealed at open
binding  = H(DOM_BINDING, gateway_id_hi, gateway_id_lo, session_pub_hi, session_pub_lo)`}</pre>
          <p>
            The issuer knows c and the leaf. It cannot compute batch_id, because that needs k. The gateway knows batch_id. It cannot compute c
            or the leaf, because that needs k. The two halves meet only inside the open proof. The deployment id is inside c and batch_id, so
            credit does not move between deployments.
          </p>
          <Table
            head={["tag", "text", "field value"]}
            rows={[
              ["DOM_COMMITMENT", "anon-credit/v1/commitment", "0x616e6f6e2d6372656469742f76312f636f6d6d69746d656e74"],
              ["DOM_LEAF", "anon-credit/v1/leaf", "0x616e6f6e2d6372656469742f76312f6c656166"],
              ["DOM_BATCH_ID", "anon-credit/v1/batch-id", "0x616e6f6e2d6372656469742f76312f62617463682d6964"],
              ["DOM_BINDING", "anon-credit/v1/binding", "0x616e6f6e2d6372656469742f76312f62696e64696e67"],
              ["DOM_MMR_LEAF", "anon-credit/v1/mmr-leaf", "0x616e6f6e2d6372656469742f76312f6d6d722d6c656166"],
              ["DOM_MMR_NODE", "anon-credit/v1/mmr-node", "0x616e6f6e2d6372656469742f76312f6d6d722d6e6f6465"],
              ["DOM_MMR_ROOT", "anon-credit/v1/mmr-root", "0x616e6f6e2d6372656469742f76312f6d6d722d726f6f74"],
              ["CIRCUIT_ID", "anon-credit/v1/batch-open", "0x616e6f6e2d6372656469742f76312f62617463682d6f70656e"],
            ]}
          />
          <p>A tag value is the big-endian integer of its ASCII text, at most 27 bytes. The 260 permutation constants are the standard BN254 set, copied from the Noir ACVM solver.</p>
          <Source files={["REFERENCE.md: Circuit hash, MMR, and batch-open statement", "fixtures/protocol/domains.json", "circuits/batch-open/src/main.nr"]} />
        </DocSection>

        <DocSection section={section("tree")} n={4}>
          <p>
            The issuer keeps the leaves in an append-only Merkle Mountain Range. A fixed-depth tree would change the root of every subtree on
            each insert and would need the full tree to rebuild a path. In the MMR, leaves are never changed or removed; a completed subtree
            never changes, so a stored path stays valid inside it. The issuer serves the tree as contract-shaped events,
            LeafAppended(index, leaf) and RootUpdated(index, root), so a client can sync from events when the registry moves on chain.
            An on-chain append costs one hash per level and amortizes to two hashes per leaf. The root commits to the leaf count, so a proof
            against an old root cannot claim a leaf that did not exist.
          </p>
          <pre>{`leaf_node = H(DOM_MMR_LEAF, leaf)
node      = H(DOM_MMR_NODE * 2^32 + height, left, right)   height = parent height, 1..31
root      = H(DOM_MMR_ROOT, leaf_count, slot[31], slot[30], ..., slot[0])
slot[h]   = the peak of height h if bit h of leaf_count is 1, else 0
empty MMR: H(DOM_MMR_ROOT, 0, 0, ..., 0)

path rule: leaf i of n is under the peak of height h = the highest bit in which i and n differ
           at level j < h, bit j of i is 1 if the node is the right child
proof    = {leaf_index, leaf_count, peak_position, siblings[h], peaks[]}`}</pre>
          <Table
            head={["bound", "value", "why"]}
            rows={[
              ["leaves", "at most 2^32 - 1", "leaf_index and leaf_count decompose into 32 bits inside the circuit; MAX_HEIGHT and MAX_PEAKS are 32"],
              ["node domain", "DOM_MMR_NODE * 2^32 + height", "less than 2^248 and never equal to a plain tag; a node cannot pose as a leaf or a root"],
              ["root window", "96 source epochs", "the gateway accepts roots of the last 96 epochs: 48 minutes at 30 s, one day at 900 s"],
              ["snapshots", "one per closed epoch, all kept", "GET /v1/tree/path/:leaf_index?root=R answers against any kept root"],
            ]}
          />
          <p>
            Each epoch e the issuer records the snapshot of e (leaves with insertion epoch at most e), signs postRoot(e, root, leaf_count), and
            sends it. Leaves of epoch e are eligible from e + 1. The issuer publishes every epoch, also with no new leaves: 2,880 transactions
            a day at 30 s epochs, 96 at 900 s.
          </p>
          <Source files={["REFERENCE.md: MMR rules, How issuance timing works", "implementation.md section 8", "FUTURE.md section 3"]} />
        </DocSection>

        <DocSection section={section("proving")} n={5}>
          <p>The statement is a Noir circuit, circuits/batch-open, compiled with Noir 1.0.0-beta.26, the version that ProveKit links.</p>
          <pre>{`the prover knows k, expiry, leaf_index, siblings[32], peaks[32], session_pub such that
  c        = H(DOM_COMMITMENT, deployment_id, k)
  leaf     = H(DOM_LEAF, c, 100, expiry)
  leaf is in the MMR with the public root and leaf_count, at the private leaf_index
  batch_id = H(DOM_BATCH_ID, deployment_id, k)
  binding  = H(DOM_BINDING, gateway_id, session_pub)
  proof_epoch <= expiry
  every 32-byte limb is 128 bits; leaf_index and leaf_count decompose into 32 bits;
  the peak height and each left/right decision come from those bits (so leaf_index < leaf_count);
  sibling padding and empty peak slots are zero`}</pre>
          <Table
            head={["#", "public input", "meaning"]}
            rows={[
              ["0", "circuit_id", "must equal CIRCUIT_ID: names protocol version 1 and the statement"],
              ["1, 2", "deployment_id [hi, lo]", "the deployment; inside c and batch_id"],
              ["3, 4", "gateway_id [hi, lo]", "the gateway this open is for; inside the binding"],
              ["5", "root", "the MMR root the gateway accepts"],
              ["6", "leaf_count", "leaves under that root: the anonymity set"],
              ["7", "proof_epoch", "the current or the previous epoch; compared with the private expiry"],
              ["8", "batch_id", "H(k) under the id domain: the only name the gateway has for the batch"],
              ["9", "binding", "H(gateway_id, session_pub): ties the proof to one Ed25519 session key"],
            ]}
          />
          <p>The gateway builds this vector itself from the request and its configuration. It never accepts public inputs supplied with the proof.</p>
          <Table
            head={["circuit size", "value"]}
            rows={[
              ["ACIR opcodes (nargo info)", "819 (25 Brillig)"],
              ["Poseidon2 permutation calls", "52"],
              ["range checks", "75"],
              ["ProveKit R1CS constraints", "14,416 (15,031 before Gaussian elimination)"],
              ["ProveKit R1CS witnesses", "14,672 (19,866 before)"],
              ["public inputs", "10"],
            ]}
          />
          <p>
            The proof system is ProveKit (worldfnd/provekit) at commit {PROVEKIT_REV.slice(0, 12)}, 2026-11-04: a Spartan-based protocol over
            R1CS with WHIR hash commitments and the Skyscraper hash, prepared with --hash skyscraper --witness-mode zk. It is not a trusted-setup
            system and not a pairing-based wrapper; the optional Groth16 wrapper is not used, so the credential layer keeps hash-based,
            post-quantum assumptions. The artifact formats are PKP 3.0, PKV 3.0, binary proof 3.0.
          </p>
          <p>
            The published npm SDK (@worldcoin/provekit 0.1.1) was not usable: it comes from a commit on Noir beta.20 where the witness
            commitment is not hiding ("Witness ZK is off ... WHIR openings leak witness values"), and it rejects PKP/PKV 3.0 artifacts. No
            ProveKit branch has both the JS SDK and the hiding mode. The repository builds the first-party tooling/provekit-wasm bindings from
            the pinned commit, with one patch that adds an optional threads feature, and runs them in its own worker. It is the same prover.
          </p>
          <Table
            head={["measurement (Apple M4 Pro, 12 cores, HeadlessChrome 149)", "scalar WASM", "threaded WASM (8 threads)", "native CLI"]}
            rows={[
              ["warm proof (witness and proving)", "504 ms", "172 ms", "100 ms wall"],
              ["witness generation (noir_js), warm", "7 ms", "6 ms", ""],
              ["cold first proof (worker start, download, checks, init, proof)", "720 ms", "391 ms", ""],
              ["WASM linear memory after proving", "25.9 MiB", "42.1 MiB", "68.5 MiB peak RSS"],
              ["artifact download, raw / gzip", "5.54 MB / 1.49 MB", "5.70 MB / 1.52 MB", ""],
            ]}
          />
          <Table
            head={["artifact, proof, verification", "value"]}
            rows={[
              ["PKP (prover key, xz-compressed)", "326,077 bytes"],
              ["PKV (verifier key)", "178,694 bytes"],
              ["browser proof (JSON encoding)", "477 KB; 318,335 bytes gzip"],
              ["native proof (binary .np, zstd)", "305,826 bytes"],
              ["Rust verify, browser proof, 1 thread", "26.2 ms median"],
              ["Rust verify, browser proof, 12 threads", "13.4 ms median"],
              ["sidecar POST /verify duration_ms (decode and verify)", "14 to 16 ms"],
            ]}
          />
          <p>
            The threaded build needs a cross-origin isolated page (COOP same-origin, COEP require-corp) and SharedArrayBuffer; the scalar build
            runs anywhere. The page is served with those headers, and Nox runs on the same isolated page.
          </p>
          <p>
            Why a sidecar: the gateway uses stable Rust 1.98.1; ProveKit needs the nightly toolchain (nightly-2026-03-04). The gateway does
            not link ProveKit. It sends each proof to anon-credit-prover serve, a separate process on 127.0.0.1 that loads the PKV only if its
            SHA-256 is the pinned digest and the key is hiding, verifies at most 2 proofs at a time, and queues at most 32.
          </p>
          <p>
            Hiding mode: prepare --witness-mode zk makes a hiding witness commitment (WHIR "zook" commitment in Mode::ZeroKnowledge); the
            Spartan sumcheck is masked by a committed blinding polynomial; each proof uses fresh randomness, so two proofs of one witness
            differ. The verifier rejects a key in Mode::Standard. The caveat, in the words of REFERENCE.md: the ProveKit source says that a
            hiding commitment alone is not full proof zero knowledge: "the alpha, public-input, and challenge evaluations are still sent in
            the clear". Phase 1 does not establish full zero knowledge for the batch-open statement. A review of this leakage for the full
            circuit is necessary before the protocol freeze.
          </p>
          <Source files={["PROVER.md", "REFERENCE.md: ProveKit, Hiding mode, Batch-open circuit, Verifier sidecar", "artifacts/batch-open/prepare.json, nargo-info.txt, prover-manifest.json"]} />
        </DocSection>

        <DocSection section={section("epochs")} n={6}>
          <p>Time is cut into epochs: epoch = floor(unix seconds / epoch_seconds). The issuer posts one root per epoch; a leaf inserted in epoch e opens from e + 1.</p>
          <Table
            head={["setting", "Sepolia testnet", "production"]}
            rows={[
              ["epoch length", "30 s", "900 s"],
              ["first-use random delay", "0 to 3 epochs (the demo profile caps it at 1)", "0 to 3 epochs"],
              ["root window", "96 epochs (48 minutes)", "96 epochs (one day)"],
              ["credit activation lifetime", "35,040 epochs (about 12 days)", "35,040 epochs (one year)"],
              ["session deadline after open", "35,040 epochs", "35,040 epochs"],
              ["proof epoch accepted", "current or previous epoch", "current or previous epoch"],
            ]}
          />
          <p>
            The block tag decides when a payment or a root counts. At finalized, the issuer indexes a purchase only when the RPC's finalized
            block covers it (about 13 minutes on Sepolia), and the gateway reads roots at the finalized tag: a first open waits for payment
            finality, one epoch boundary, root publication, and root finality. The testnet demo runs both services at latest: a purchase can
            open after one epoch plus chain latency. latest trades reorg safety for speed: a reorganization can remove a purchase or a root
            that the services already used. The page shows the tag it read from GET /v1/config as "block tag latest (demo)".
          </p>
          <p>
            The random first-use delay exists against insertion-to-open timing: without it, the first open after an insertion would point at
            the newest leaf. The client chooses the delay once per batch, in the browser, and keeps it in the encrypted store.
          </p>
          <pre>{`root selection (SDK selectRoot):
  wait until current epoch >= eligible_epoch + delay
  take the gateway's accepted roots (GET /v1/roots), newest first
  keep a root with source_epoch >= eligible_epoch and leaf_count > leaf_index
  the issuer must report the same epoch as finalized with the same root and leaf count
  fetch the path on isolation key registry:<batch_id>; check it locally; prove`}</pre>
          <Source files={["implementation.md sections 6 and 7", "REFERENCE.md: SDK rules, How issuance timing works", "config/testnet-demo.env.example"]} />
        </DocSection>

        <DocSection section={section("sessions")} n={7}>
          <p>
            One Ed25519 key pair per batch, made in the browser. The open proof binds to it through the binding public input. All signatures are
            Ed25519 over keccak256(message); integers are big-endian.
          </p>
          <pre>{`open message (238 bytes): domain "anon-credit/open" (32) | version u16 | deployment_id (32) |
  gateway_id (32) | batch_id (32) | root (32) | leaf_count u32 | proof_epoch u64 |
  session_pub (32) | price_table_hash (32)
status message (162 bytes): domain "anon-credit/status" (32) | version u16 | deployment_id (32) |
  gateway_id (32) | batch_id (32) | nonce (32)`}</pre>
          <p>A spend is one signed debit: a 182-byte header and then the exact bytes of one JSON-RPC object (id = seq).</p>
          <Table
            head={["offset", "size", "field"]}
            rows={[
              ["0", "32", "operation domain anon-credit/spend (ASCII, zero padded)"],
              ["32", "2", "protocol version (u16)"],
              ["34", "32", "deployment_id"],
              ["66", "32", "gateway_id"],
              ["98", "32", "batch_id"],
              ["130", "32", "price_table_hash (frozen at open)"],
              ["162", "8", "seq (u64), starts at 0, increases by one"],
              ["170", "8", "units_total (u64), cumulative units including this request"],
              ["178", "4", "rpc_byte_length (u32)"],
              ["182", "n", "rpc_bytes: the exact UTF-8 JSON-RPC object"],
            ]}
          />
          <p>
            Because units_total is signed, the latest request is a receipt: "the holder of batch_id owes gateway_id units_total units". The
            gateway forwards the exact client bytes upstream, and commits the debit, the receipt, and the response bytes in one transaction.
            A JSON-RPC result or error object with HTTP 200 is charged; a transport failure, a non-200 status, a malformed response, or more
            than 1 MiB is upstream_failed and changes nothing.
          </p>
          <Table
            head={["price table version 2", "units", "params"]}
            rows={[
              ["eth_chainId", "1", "none"],
              ["eth_blockNumber", "1", "none"],
              ["eth_getBalance", "2", "[address, block]"],
              ["eth_call", "3", "[{to, from?, data or input?, value?, gas?, gasPrice?}, block]; data at most 8 KiB"],
              ["eth_getTransactionReceipt", "2", "[transaction hash]"],
            ]}
          />
          <pre>{`canonical JSON, sorted keys, no white space:
{"units":{"eth_blockNumber":1,"eth_call":3,"eth_chainId":1,"eth_getBalance":2,"eth_getTransactionReceipt":2},"version":2}
price_table_hash = keccak256 of it = 0x5a43e7886a8b605be5873140f6682098b51d69af2c46f2ccc5ac6670a8408f08`}</pre>
          <Table
            head={["rule", "behavior"]}
            rows={[
              ["seq lower, same digest", "the stored response, no charge, X-Anon-Replayed: true; after 60 s response_expired with the receipt"],
              ["seq lower, different digest", "sequence_conflict"],
              ["seq higher", "sequence_gap"],
              ["bad signature", "signature_invalid (401), checked before the lock and before any state change"],
              ["units left below the method price", "insufficient_units (402)"],
              ["one request per batch at a time", "a per-batch lock of 5 s, then busy"],
              ["exact retry of a successful open", "the stored session, existing: true; units and sequence do not reset"],
              ["lost response", "the SDK sends the same bytes and signature again (3 sends); the journal is written before the first send"],
            ]}
          />
          <Source files={["REFERENCE.md: Signing messages, Spend pipeline, Open pipeline", "crates/protocol/src/spend.rs", "packages/protocol/src/price.ts", "FUTURE.md section 4.2"]} />
        </DocSection>

        <DocSection section={section("transport")} n={8}>
          <p>
            The paid flow runs through Nox, an Anon-RPC worker: @anon-rpc/browser-harness 0.4.0 loads a bundle pinned by keccak256 from a
            specifier contract on Sepolia, runs it in a sandboxed iframe, and opens TLS to the gateway inside the sandbox. The exit node relays
            bytes it cannot read; the gateway sees the exit address, not the client's. One isolation key per batch for open, spend, and
            status; a separate key, registry:&lt;batch_id&gt;, for path reads; "config" for configuration reads.
          </p>
          <Table
            head={["measured (live Nox, headless Chromium 149, 2026-11-07)", "value"]}
            rows={[
              ["Nox ready", "4 to 5 s typical; two runs took about 79 s (the SDK timeout is 120 s, the app uses 180 s)"],
              ["one GET through Nox", "about 2 s"],
              ["POST body through Nox", "48,000 bytes passed; 60,000 and above failed with a TLS record buffering error"],
              ["X-Anon-* response headers", "readable through the harness"],
            ]}
          />
          <p>
            An open request with an inline proof is about 640 KB, so the proof goes first in chunks. The browser gzips the JSON proof
            (CompressionStream): 477,325 bytes become 318,335 bytes, 8 raw chunks of at most 40,000 bytes (7 of 40,000 and 1 of 38,335). Each
            chunk is one PUT with the raw bytes as body (application/octet-stream); the metadata is in the URL path, which has no secret:
          </p>
          <pre>{`PUT /v1/open/chunks/{batch_id}/{proof_sha256}/{total_bytes}/{chunk_count}/{chunk_index}
  -> {received_chunks, complete}
POST /v1/open with proof_upload: {proof_sha256, total_bytes, proof_encoding: "json+gzip"}`}</pre>
          <p>
            The SDK sends 8 chunks at the same time with one attempt each, then the failed ones one at a time with up to 3 attempts of the same
            bytes, 500 ms apart. Chunks can arrive in any order; a duplicate with the same bytes has no effect; when the last chunk arrives the
            gateway checks the length and the SHA-256. An upload lives 10 minutes in memory, at most 4 MiB, at most 256 chunks, 1,000 pending
            uploads and 512 MiB pending. The open signature does not cover the proof, so the pipeline does not change.
          </p>
          <Table
            head={["chunk probe (8 chunks of a real proof, httpbingo.org echo)", "8 in flight", "4 in flight", "1 at a time", "direct, no Nox"]}
            rows={[
              ["8 chunks, total", "4.4 / 5.7 / 6.6 s (min / median / max, 9 runs; 72 of 72 delivered in the first pass)", "6.4 s", "19.7 s", "2.5 s"],
              ["per chunk", "2.2 / 4.4 / 6.6 s", "2.0 / 2.8 / 3.4 s", "1.9 / 2.4 / 4.5 s", "2.1 / 2.5 / 2.5 s"],
            ]}
          />
          <p>
            Expect about 5 to 7 s for the proof upload of one open through Nox, plus the open request. The earlier format (24 KiB as base64
            in JSON, 13 chunks) took 19 to 38 s: raw bytes give 33 % more data per request.
          </p>
          <p>
            The direct transport is a plain fetch from the browser. The gateway then sees the browser's IP address next to the batch id, which
            undoes the second link of section 1. The SDK refuses it unless the caller allows it by name; the page labels it "direct: not
            private" and uses it only against a local stack, because Nox exits cannot reach localhost.
          </p>
          <Source files={["REFERENCE.md: Transport notes (Nox), Chunked open upload", "anon-rpc-demo/LEARNINGS.md entries 6, 9, 15, 17", "Architecture.md section 7"]} />
        </DocSection>

        <DocSection section={section("threats")} n={9}>
          <Table
            head={["party", "learns", "does not learn"]}
            rows={[
              ["entry relay", "the user's IP, packet sizes, timing", "content, batch ids, destination"],
              ["exit relay", "the gateway hostname, packet sizes", "content, batch ids, the user's IP"],
              ["gateway", "query content, batch ids, timing, all requests inside one session", "IP, identity, app, which payment bought the batch"],
              ["issuer", "who paid, how many batches, which leaves are theirs, when", "batch ids, any request"],
              ["chain observer", "one root per epoch, on-chain payers", "leaf contents, any request"],
            ]}
          />
          <p>Guarantee: payer-to-session unlinkability, and unlinkability between sessions. Not guaranteed: unlinkability inside a session, or any protection when content identifies the client. Anonymity set: every unexpired leaf under the root used.</p>
          <Table
            head={["residual risk", "state"]}
            rows={[
              ["small anonymity set at launch", "the set is the leaf count under the root; one test purchase gives a set of one. It grows with every batch sold"],
              ["insertion-to-open timing", "mitigated by the epoch delay and the random first-use delay; not removed"],
              ["timing and content correlation", "different observed addresses are evidence of routing, not proof against timing or content analysis"],
              ["issuer and gateway run by one operator", "the proof plus a large set; early on this is a guess, not a proof"],
              ["operator exit with prepaid funds", "accepted in version 1; per-epoch unlock and per-batch claims are later work"],
              ["session key theft", "scope: one batch, K units"],
              ["spam with invalid proofs or chunks", "size and shape checks first; the chunk store is bounded (512 MiB, 1,000 uploads, 10 minutes)"],
              ["hiding is not full zero knowledge", "see section 5: a review of the clear-text evaluations is necessary before the protocol freeze"],
              ["DEMO_IP_LOGGING=true", "the demo profile records the observed source IP in the gateway's in-memory event stream; the normal profile does not read the peer address"],
            ]}
          />
          <Table
            head={["target", "measured", "state"]}
            rows={[
              ["open proof verification, one core", "26.2 ms median (sidecar 14 to 16 ms with default threads)", "misses the 20 ms target"],
              ["open proof size", "305,826 bytes binary, 318,335 bytes gzip JSON", "above the 50 to 200 KB target"],
              ["spend latency at the gateway, p95", "2.220 ms at 8 clients; 32 clients exceed 5 ms (local database contention)", "misses the 5 ms target at 32 clients"],
              ["gateway open, end to end with the real sidecar", "25.1 ms median, 26.1 ms p99", "misses the 50 ms target only in the one-thread verifier timer"],
            ]}
          />
          <Source files={["PRD.md section 10", "REFERENCE.md: Batch-open circuit, Chunked open upload", "docs/measurements.md", "implementation.md section 14"]} />
        </DocSection>

        <DocSection section={section("road")} n={10}>
          <p>
            The beta has two trusted parties: the issuer builds leaves, posts roots, and holds the payer list; one gateway holds every session
            and all prepaid funds. Neither is the end state.
          </p>
          <p>
            Stage A moves the registry on chain. A contract function buy(c[]) takes the payment and appends the leaves itself, with expiry =
            block time + lifetime. The chain is the finality. No party can mint a leaf without payment, delay an insertion, censor a payer,
            or hold a private payer list; every gateway and client reads the same roots. The costs: the payer address becomes public (answer:
            pay from a fresh address or a privacy pool; the payer-to-session link is still broken by the proof), each append costs one hash per
            level, depth 32 (answer: an L2), and a client syncs from events (answer: the Mountain Range already limits this to one path per leaf
            plus the peaks). The beta prepares for it with rules C1 to C9: the same leaf and batch id formats, gateway_id as a public input,
            units_total inside every spend, event-shaped issuer endpoints, a root source interface with two implementations, and a circuit
            free of any issuer key.
          </p>
          <p>
            Stage B adds many gateways through a registry contract with stake, price table, endpoint, and certificate hash. The client picks
            a gateway by price, latency, and reputation through Anon-RPC. Every spend request is already a receipt; a gateway claims payment
            per batch with the client's last signature, batched under a Merkle root. The open proof is never verified on chain. Operator
            exit then loses at most the open batches at that gateway; a double open across two gateways loses at most one batch of K units.
            Rotation between gateways and reputation are deferred.
          </p>
          <p>zkAPI (Ethereum Foundation and the Open Anonymity Project, mainnet 2026-10-01) has the same shape. The MVP does not use it; it is named as one production route.</p>
          <Table
            head={["", "this design", "zkAPI"]}
            rows={[
              ["proof system", "STARK-style, hash-based, transparent setup", "Groth16 on BN254, trusted setup (single-party dev keys at launch)"],
              ["post-quantum", "yes, for the payer link", "no"],
              ["amounts", "fixed K per batch", "variable per session, the server learns the total"],
              ["on-chain verification", "not affordable, settlement by signature", "cheap, enables trustless exit"],
              ["browser proving", "immature, sidecar in the MVP", "works today"],
              ["machinery", "one proof, one row", "signed state chain, challenge service, indexer, paymaster"],
              ["target", "RPC gateway, Anon-RPC worker, dispenser", "AI inference, RPC named as a use case"],
            ]}
          />
          <p>What never changes: the gateway sees query content; requests inside a session are linkable; the open proof is the only zero-knowledge step and stays off chain.</p>
          <Source files={["FUTURE.md sections 1 to 8"]} />
        </DocSection>

        <DocSection section={section("stack")} n={11}>
          <Table
            head={["item", "pin"]}
            rows={[
              ["Rust (issuer, gateway, protocol, registry, crypto)", "stable 1.98.1, rust-toolchain.toml"],
              ["Rust for ProveKit (crates/prover, separate workspace)", "nightly-2026-03-04 (rustc 1.96.0-nightly d9563937f)"],
              ["ProveKit", `worldfnd/provekit main at ${PROVEKIT_REV} (2026-11-04)`],
              ["WHIR (from ProveKit)", "worldfnd/whir at d2b16529d0a4fad4f53d088281e9062898d35f5b"],
              ["Noir", "1.0.0-beta.26 (40d6574); noir_js, acvm_js, noirc_abi 1.0.0-beta.26"],
              ["wasm-bindgen-cli", "0.2.113 (the crate version in ProveKit's Cargo.lock)"],
              ["prepare options", "--hash skyscraper --witness-mode zk; PKP 3.0, PKV 3.0, binary proof 3.0"],
              ["Foundry", "forge 1.7.1 (4072e48); Solidity 0.8.30, EVM cancun"],
              ["Node and pnpm", "Node 26.12.0, pnpm 12.18.0"],
              ["TypeScript", "7.0.2, strict, verbatimModuleSyntax, no emit; vitest 5.1.0; zod 4.6.7"],
              ["React and Vite", "react and react-dom 19.3.1, vite 8.3.6, @vitejs/plugin-react 6.2.1"],
              ["viem", "2.57.11 (purchase calldata, wallet and key signers, receipts)"],
              ["@anon-rpc/browser-harness", "0.4.0 (Nox worker)"],
              ["@noble/hashes, @noble/curves", "2.4.0 (keccak, SHA-256, Ed25519)"],
              ["Rust crates", "tokio 1.54.1, axum 0.8.9, sqlx 0.9.0, alloy 2.5.0, ed25519-dalek 3.0.0, reqwest 0.13.5, sha3 0.12.0"],
            ]}
          />
          <Source files={["REFERENCE.md: Tools, Pinned versions, ProveKit pins", "artifacts/batch-open/prover-manifest.json"]} />
        </DocSection>
      </article>
    </div>
  );
}
