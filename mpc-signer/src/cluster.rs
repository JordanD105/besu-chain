//! Cluster membership (public, shared by every node and the coordinator) and node identity
//! (secret, one per node). Identities authenticate and encrypt MPC protocol messages end-to-end,
//! so the coordinator / relay never sees secret protocol material.

use std::path::Path;

use anyhow::{bail, ensure, Context, Result};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::policy::Policy;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClusterConfig {
    /// Signatures need `threshold` of the `parties.len()` nodes.
    pub threshold: u16,
    pub parties: Vec<PartyInfo>,
    pub policy: Policy,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PartyInfo {
    /// Index of the node at key generation (0..n).
    pub id: u16,
    /// Node API base URL, reached by the coordinator.
    pub url: String,
    /// Ed25519 public key (hex), authenticates every protocol message from this node.
    pub sign_pk: String,
    /// X25519 public key (hex), used to encrypt p2p protocol messages to this node.
    pub kx_pk: String,
}

impl ClusterConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let s = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let c: Self = serde_json::from_str(&s).context("parse cluster config")?;
        c.validate()?;
        Ok(c)
    }

    pub fn n(&self) -> u16 {
        self.parties.len() as u16
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(self.threshold >= 2, "threshold must be >= 2");
        ensure!(self.threshold <= self.n(), "threshold must be <= number of parties");
        for (i, p) in self.parties.iter().enumerate() {
            ensure!(p.id as usize == i, "parties must be listed in id order 0..n");
        }
        Ok(())
    }

    pub fn party(&self, id: u16) -> Result<&PartyInfo> {
        match self.parties.get(id as usize) {
            Some(p) => Ok(p),
            None => bail!("unknown party {id}"),
        }
    }

    pub fn sign_pk(&self, id: u16) -> Result<ed25519_dalek::VerifyingKey> {
        let b: [u8; 32] = hex::decode(&self.party(id)?.sign_pk)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("sign_pk must be 32 bytes"))?;
        Ok(ed25519_dalek::VerifyingKey::from_bytes(&b)?)
    }

    pub fn kx_pk(&self, id: u16) -> Result<x25519_dalek::PublicKey> {
        let b: [u8; 32] = hex::decode(&self.party(id)?.kx_pk)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("kx_pk must be 32 bytes"))?;
        Ok(x25519_dalek::PublicKey::from(b))
    }
}

/// A node's long-term identity, derived from a 32-byte seed stored (encrypted) on the node.
pub struct Identity {
    pub sign: ed25519_dalek::SigningKey,
    pub kx: x25519_dalek::StaticSecret,
}

impl Identity {
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(b"mpc-signer/identity/v1"), seed);
        let mut a = Zeroizing::new([0u8; 32]);
        let mut b = Zeroizing::new([0u8; 32]);
        hk.expand(b"ed25519", &mut a[..]).expect("len ok");
        hk.expand(b"x25519", &mut b[..]).expect("len ok");
        Identity {
            sign: ed25519_dalek::SigningKey::from_bytes(&a),
            kx: x25519_dalek::StaticSecret::from(*b),
        }
    }

    pub fn generate_seed() -> Zeroizing<[u8; 32]> {
        let mut s = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(&mut s[..]);
        s
    }

    pub fn sign_pk_hex(&self) -> String {
        hex::encode(self.sign.verifying_key().to_bytes())
    }

    pub fn kx_pk_hex(&self) -> String {
        hex::encode(x25519_dalek::PublicKey::from(&self.kx).to_bytes())
    }
}
