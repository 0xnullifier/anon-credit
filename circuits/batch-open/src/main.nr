// Phase 0 placeholder. It only proves that the Noir toolchain builds this package.
// Phase 1 replaces it with the batch-open statement from implementation.md section 8.
// Do not add hash constants before phase 1 pins the Poseidon2 parameters.

fn main(secret: Field, public_value: pub Field) {
    assert(secret * secret == public_value);
}

#[test]
fn accepts_square() {
    main(3, 9);
}

#[test(should_fail)]
fn rejects_non_square() {
    main(3, 10);
}
