//! Non-exportable 2-of-3 threshold ECDSA signer for Besu, built on CGGMP24
//! (LFDT Lockness, successor of the `cggmp21` crate).
//!
//! * `mpc-node`        – holds one key share, checks policy, runs MPC protocols, issues partial signatures
//! * `mpc-coordinator` – stateless; relays protocol messages, keeps the presignature pool,
//!                       exposes a Web3Signer-compatible JSON-RPC API
//!
//! The full private key never exists anywhere: not at key generation, not at signing.

pub mod api;
pub mod cluster;
pub mod eth;
pub mod policy;
pub mod store;
pub mod transport;

pub use cggmp24;

pub type E = cggmp24::supported_curves::Secp256k1;
pub type L = cggmp24::security_level::SecurityLevel128;
/// Hash used *inside* the MPC protocols (transcripts, commitments).
pub type ProtoDigest = sha2::Sha256;
/// Hash of the message being signed (Ethereum).
pub type MsgDigest = sha3::Keccak256;

pub type KeyShare = cggmp24::KeyShare<E, L>;
pub type AuxInfo = cggmp24::key_share::AuxInfo<L>;
pub type AuxMsg = cggmp24::key_refresh::msg::Msg<ProtoDigest, L>;
pub type KeygenMsg = cggmp24::keygen::ThresholdMsg<E, L, ProtoDigest>;
pub type SigningMsg = cggmp24::signing::msg::Msg<E, ProtoDigest>;

/// Data an Ethereum signer signs: the RLP signing payload, hashed with keccak256 by the library.
pub fn data_to_sign(tx: &eth::TxIntent) -> cggmp24::DataToSign<E> {
    cggmp24::DataToSign::digest::<MsgDigest>(&tx.signing_payload())
}
