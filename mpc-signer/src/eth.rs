//! Minimal Ethereum helpers: legacy EIP-155 transaction encoding, keccak, address
//! derivation and recovery-id computation for a threshold (r, s) signature.

use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

pub type Address = [u8; 20];

pub fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// Ethereum address from a SEC1 *uncompressed* public key (65 bytes, 0x04 prefix).
pub fn address_from_uncompressed(pk: &[u8]) -> Result<Address> {
    ensure!(pk.len() == 65 && pk[0] == 4, "expected 65-byte uncompressed public key");
    let h = keccak(&pk[1..]);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    Ok(a)
}

pub fn address_hex(a: &Address) -> String {
    format!("0x{}", hex::encode(a))
}

pub fn parse_address(s: &str) -> Result<Address> {
    let b = hex::decode(strip0x(s)).context("address is not hex")?;
    ensure!(b.len() == 20, "address must be 20 bytes");
    let mut a = [0u8; 20];
    a.copy_from_slice(&b);
    Ok(a)
}

fn strip0x(s: &str) -> &str {
    s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s)
}

/// Parse a JSON-RPC quantity ("0x1a", or a decimal string) into minimal big-endian bytes
/// (no leading zeros, empty for zero), max 32 bytes.
pub fn parse_quantity(s: &str) -> Result<Vec<u8>> {
    let s = s.trim();
    let bytes = if s.starts_with("0x") || s.starts_with("0X") {
        let h = strip0x(s);
        if h.is_empty() {
            vec![]
        } else {
            let h = if h.len() % 2 == 1 { format!("0{h}") } else { h.to_string() };
            hex::decode(h).context("invalid hex quantity")?
        }
    } else {
        ensure!(!s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()), "invalid quantity {s:?}");
        // decimal -> big-endian
        let mut out: Vec<u8> = vec![];
        for d in s.bytes().map(|c| c - b'0') {
            let mut carry = d as u32;
            for b in out.iter_mut().rev() {
                let v = (*b as u32) * 10 + carry;
                *b = (v & 0xff) as u8;
                carry = v >> 8;
            }
            while carry > 0 {
                out.insert(0, (carry & 0xff) as u8);
                carry >>= 8;
            }
        }
        out
    };
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    let trimmed = bytes[first..].to_vec();
    ensure!(trimmed.len() <= 32, "quantity exceeds 256 bits");
    Ok(trimmed)
}

pub fn quantity_to_u64(q: &[u8]) -> Result<u64> {
    ensure!(q.len() <= 8, "quantity exceeds u64");
    Ok(q.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64))
}

pub fn u64_be(v: u64) -> Vec<u8> {
    let b = v.to_be_bytes();
    let first = b.iter().position(|x| *x != 0).unwrap_or(8);
    b[first..].to_vec()
}

/// Compare two minimal big-endian quantities.
pub fn cmp_quantity(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

// ---------------------------------------------------------------- RLP

fn rlp_len_prefix(out: &mut Vec<u8>, len: usize, short: u8, long: u8) {
    if len <= 55 {
        out.push(short + len as u8);
    } else {
        let lb = u64_be(len as u64);
        out.push(long + lb.len() as u8);
        out.extend_from_slice(&lb);
    }
}

pub fn rlp_bytes(out: &mut Vec<u8>, b: &[u8]) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else {
        rlp_len_prefix(out, b.len(), 0x80, 0xb7);
        out.extend_from_slice(b);
    }
}

pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.concat();
    let mut out = Vec::with_capacity(payload.len() + 9);
    rlp_len_prefix(&mut out, payload.len(), 0xc0, 0xf7);
    out.extend_from_slice(&payload);
    out
}

fn enc(b: &[u8]) -> Vec<u8> {
    let mut v = vec![];
    rlp_bytes(&mut v, b);
    v
}

// ---------------------------------------------------------------- transactions

/// A fully specified legacy (EIP-155) transaction. Nodes rebuild and hash this themselves,
/// so a signer never signs an opaque hash it has not seen the preimage of.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TxIntent {
    pub chain_id: u64,
    pub nonce: u64,
    #[serde(with = "hexbytes")]
    pub gas_price: Vec<u8>,
    pub gas: u64,
    #[serde(with = "opt_addr")]
    pub to: Option<Address>,
    #[serde(with = "hexbytes")]
    pub value: Vec<u8>,
    #[serde(with = "hexbytes")]
    pub data: Vec<u8>,
}

impl TxIntent {
    fn fields(&self) -> Vec<Vec<u8>> {
        vec![
            enc(&u64_be(self.nonce)),
            enc(&self.gas_price),
            enc(&u64_be(self.gas)),
            enc(self.to.as_ref().map(|a| &a[..]).unwrap_or(&[])),
            enc(&self.value),
            enc(&self.data),
        ]
    }

    /// RLP payload that is hashed and signed (EIP-155).
    pub fn signing_payload(&self) -> Vec<u8> {
        let mut f = self.fields();
        f.push(enc(&u64_be(self.chain_id)));
        f.push(enc(&[]));
        f.push(enc(&[]));
        rlp_list(&f)
    }

    pub fn signing_hash(&self) -> [u8; 32] {
        keccak(&self.signing_payload())
    }

    /// Raw signed transaction for `eth_sendRawTransaction`.
    pub fn encode_signed(&self, recid: u8, r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
        let v = self.chain_id * 2 + 35 + recid as u64;
        let trim = |x: &[u8; 32]| {
            let i = x.iter().position(|b| *b != 0).unwrap_or(32);
            x[i..].to_vec()
        };
        let mut f = self.fields();
        f.push(enc(&u64_be(v)));
        f.push(enc(&trim(r)));
        f.push(enc(&trim(s)));
        rlp_list(&f)
    }
}

/// Find the recovery id (0/1) such that ecrecover(hash, r, s, id) == public key.
/// `pubkey_sec1` may be compressed or uncompressed.
pub fn recovery_id(pubkey_sec1: &[u8], hash: &[u8; 32], r: &[u8; 32], s: &[u8; 32]) -> Result<u8> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    let vk = VerifyingKey::from_sec1_bytes(pubkey_sec1).map_err(|e| anyhow!("bad pubkey: {e}"))?;
    let sig = Signature::from_scalars(*r, *s).map_err(|e| anyhow!("bad signature: {e}"))?;
    ensure!(sig.normalize_s().is_none(), "signature is not low-s");
    for id in 0u8..2 {
        let rid = RecoveryId::from_byte(id).expect("0/1 valid");
        if let Ok(rec) = VerifyingKey::recover_from_prehash(hash, &sig, rid) {
            if rec == vk {
                return Ok(id);
            }
        }
    }
    bail!("signature does not recover to the expected public key")
}

// ---------------------------------------------------------------- serde helpers

pub mod hexbytes {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(v)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        let h = s.strip_prefix("0x").unwrap_or(&s);
        hex::decode(h).map_err(serde::de::Error::custom)
    }
}

pub mod opt_addr {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &Option<super::Address>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(a) => s.serialize_some(&super::address_hex(a)),
            None => s.serialize_none(),
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<super::Address>, D::Error> {
        let s: Option<String> = Option::deserialize(d)?;
        match s {
            None => Ok(None),
            Some(s) if s.is_empty() || s == "0x" => Ok(None),
            Some(s) => super::parse_address(&s).map(Some).map_err(serde::de::Error::custom),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities() {
        assert_eq!(parse_quantity("0x0").unwrap(), Vec::<u8>::new());
        assert_eq!(parse_quantity("0x5208").unwrap(), vec![0x52, 0x08]);
        assert_eq!(parse_quantity("21000").unwrap(), vec![0x52, 0x08]);
        assert_eq!(parse_quantity("1000000000000000000").unwrap(), hex::decode("0de0b6b3a7640000").unwrap());
    }

    /// EIP-155 example vector from the EIP text.
    #[test]
    fn eip155_vector() {
        let tx = TxIntent {
            chain_id: 1,
            nonce: 9,
            gas_price: parse_quantity("20000000000").unwrap(),
            gas: 21000,
            to: Some(parse_address("0x3535353535353535353535353535353535353535").unwrap()),
            value: parse_quantity("1000000000000000000").unwrap(),
            data: vec![],
        };
        assert_eq!(
            hex::encode(tx.signing_payload()),
            "ec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080"
        );
        assert_eq!(
            hex::encode(tx.signing_hash()),
            "daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53"
        );
    }
}
