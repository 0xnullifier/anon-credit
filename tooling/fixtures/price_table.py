#!/usr/bin/env python3
"""Write the price table, its hash, and the open signatures that sign the hash into the
shared fixtures.

This program is independent of the encoders under test. It uses byte concatenation, a
pure-Python Keccak-256, and the `cryptography` package for Ed25519. Ed25519 signatures are
deterministic, thus a second run gives the same bytes.

Files that it writes:

- fixtures/protocol/gateway-api.json: the `price_table` vector, each `price_table_hash` and
  `price_table` value of the examples that has the previous table, and the signatures of the
  open request examples.
- fixtures/protocol/open-message.json: each case input that has the previous table hash, and
  the expected message, digest, and signature of each case.
- packages/dashboard/dev/fixtures/mock-admin.json: each `price_table_hash` and `price_table`
  value that has the previous table.

Run from the repository root:

    python3 tooling/fixtures/price_table.py          # write the files
    python3 tooling/fixtures/price_table.py --check  # fail if a file is out of date
"""

import base64
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ROOT = Path(__file__).resolve().parents[2]

# The current price table (implementation.md section 12).
PRICE_TABLE = {
    "units": {
        "eth_blockNumber": 1,
        "eth_call": 3,
        "eth_chainId": 1,
        "eth_getBalance": 2,
        "eth_getTransactionReceipt": 2,
    },
    "version": 2,
}

PROTOCOL_VERSION = 1
OPEN_DOMAIN = b"anon-credit/open".ljust(32, b"\0")

# ----- Keccak-256 (the original Keccak padding 0x01, not SHA3 0x06) ----------------------

_RC = [
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
]
_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
]
_MASK = (1 << 64) - 1


def _rol(value, shift):
    shift %= 64
    return ((value << shift) | (value >> (64 - shift))) & _MASK


def _permute(state):
    for rc in _RC:
        c = [state[x][0] ^ state[x][1] ^ state[x][2] ^ state[x][3] ^ state[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            for y in range(5):
                state[x][y] ^= d[x]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(state[x][y], _ROT[x][y])
        for x in range(5):
            for y in range(5):
                state[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y])
        state[0][0] ^= rc


def keccak256(data):
    rate = 136
    padded = bytearray(data)
    padded.append(0x01)
    while len(padded) % rate != 0:
        padded.append(0)
    padded[-1] |= 0x80
    state = [[0] * 5 for _ in range(5)]
    for offset in range(0, len(padded), rate):
        block = padded[offset:offset + rate]
        for i in range(rate // 8):
            lane = int.from_bytes(block[8 * i:8 * i + 8], "little")
            state[i % 5][i // 5] ^= lane
        _permute(state)
    out = b"".join(state[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


# ----- Encodings ---------------------------------------------------------------------------


def hex0x(data):
    return "0x" + data.hex()


def unhex(text):
    assert text.startswith("0x"), text
    return bytes.fromhex(text[2:])


def canonical_json(table):
    entries = ",".join(f'"{name}":{units}' for name, units in sorted(table["units"].items(), key=lambda item: item[0].encode()))
    return '{"units":{' + entries + '},"version":' + str(table["version"]) + "}"


def open_message(fields):
    parts = [
        OPEN_DOMAIN,
        PROTOCOL_VERSION.to_bytes(2, "big"),
        unhex(fields["deployment_id"]),
        unhex(fields["gateway_id"]),
        unhex(fields["batch_id"]),
        unhex(fields["root"]),
        int(fields["leaf_count"]).to_bytes(4, "big"),
        int(fields["proof_epoch"]).to_bytes(8, "big"),
        unhex(fields["session_pub"]),
        unhex(fields["price_table_hash"]),
    ]
    message = b"".join(parts)
    assert len(message) == 238
    return message


def test_key(seed_hex):
    key = Ed25519PrivateKey.from_private_bytes(unhex(seed_hex))
    public = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return key, public


# ----- File updates ------------------------------------------------------------------------


def replace_previous(value, previous_hash, new_hash):
    """Replace each `price_table_hash` equal to the previous hash and each `price_table`."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key == "price_table_hash" and item == previous_hash:
                out[key] = new_hash
            elif key == "price_table" and isinstance(item, dict) and "units" in item:
                out[key] = json.loads(json.dumps(PRICE_TABLE))
            else:
                out[key] = replace_previous(item, previous_hash, new_hash)
        return out
    if isinstance(value, list):
        return [replace_previous(item, previous_hash, new_hash) for item in value]
    return value


def update_gateway_api(data, previous_hash, new_hash, key, public):
    data = replace_previous(data, previous_hash, new_hash)
    data["price_table"] = {
        "table": json.loads(json.dumps(PRICE_TABLE)),
        "canonical_json": canonical_json(PRICE_TABLE),
        "price_table_hash": new_hash,
    }
    for name, example in data["valid"].items():
        if not name.startswith("open_request"):
            continue
        assert unhex(example["session_pub"]) == public, name
        digest = keccak256(open_message(example))
        example["signature"] = base64.b64encode(key.sign(digest)).decode()
    return data


def update_open_message(data, previous_hash, new_hash):
    key, public = test_key(data["test_signing_key"]["seed"])
    assert hex0x(public) == data["test_signing_key"]["public_key"]
    for case in data["cases"]:
        if case["input"]["price_table_hash"] == previous_hash:
            case["input"]["price_table_hash"] = new_hash
        message = open_message(case["input"])
        digest = keccak256(message)
        case["expected"] = {
            "message": hex0x(message),
            "digest": hex0x(digest),
            "signature": hex0x(key.sign(digest)),
        }
    return data, key, public


def render(path, data):
    original = path.read_text()
    text = json.dumps(data, indent=2, ensure_ascii=False)
    return text + "\n" if original.endswith("\n") else text


def main():
    check = "--check" in sys.argv[1:]
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    new_hash = hex0x(keccak256(canonical_json(PRICE_TABLE).encode("ascii")))

    api_path = ROOT / "fixtures/protocol/gateway-api.json"
    open_path = ROOT / "fixtures/protocol/open-message.json"
    mock_path = ROOT / "packages/dashboard/dev/fixtures/mock-admin.json"

    api = json.loads(api_path.read_text())
    previous_hash = api["price_table"]["price_table_hash"]

    open_data, key, public = update_open_message(json.loads(open_path.read_text()), previous_hash, new_hash)
    outputs = {
        open_path: open_data,
        api_path: update_gateway_api(api, previous_hash, new_hash, key, public),
        mock_path: replace_previous(json.loads(mock_path.read_text()), previous_hash, new_hash),
    }

    stale = []
    for path, data in outputs.items():
        text = render(path, data)
        if text == path.read_text():
            continue
        stale.append(path.relative_to(ROOT))
        if not check:
            path.write_text(text)
    print(f"canonical_json {canonical_json(PRICE_TABLE)}")
    print(f"price_table_hash {new_hash}")
    if check and stale:
        print("out of date: " + ", ".join(str(path) for path in stale))
        sys.exit(1)
    names = stale or [path.relative_to(ROOT) for path in outputs]
    print(("written: " if stale else "up to date: ") + ", ".join(str(name) for name in names))


if __name__ == "__main__":
    main()
