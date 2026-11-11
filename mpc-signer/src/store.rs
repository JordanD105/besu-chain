//! Encrypted-at-rest storage for a node's secrets (identity seed, aux info, key shares).
//! Files are sealed with XChaCha20-Poly1305 under a key derived from the node passphrase
//! with Argon2id. A stolen disk image alone reveals nothing; a stolen share alone is useless.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, ensure, Context, Result};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"MPCSEAL1";

pub struct SecretStore {
    dir: PathBuf,
    passphrase: Zeroizing<String>,
}

impl SecretStore {
    pub fn open(dir: &Path, passphrase: String) -> Result<Self> {
        ensure!(passphrase.len() >= 12, "node passphrase must be at least 12 characters");
        std::fs::create_dir_all(dir.join("keys"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { dir: dir.to_path_buf(), passphrase: Zeroizing::new(passphrase) })
    }

    fn derive(&self, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
        let mut k = Zeroizing::new([0u8; 32]);
        argon2::Argon2::default()
            .hash_password_into(self.passphrase.as_bytes(), salt, &mut k[..])
            .map_err(|e| anyhow!("argon2: {e}"))?;
        Ok(k)
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn exists(&self, name: &str) -> bool {
        self.path(name).exists()
    }

    pub fn put(&self, name: &str, plaintext: &[u8]) -> Result<()> {
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce);
        let key = self.derive(&salt)?;
        let ct = XChaCha20Poly1305::new((&*key).into())
            .encrypt(XNonce::from_slice(&nonce), plaintext)
            .map_err(|_| anyhow!("encrypt failed"))?;
        let mut out = Vec::with_capacity(8 + 16 + 24 + ct.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&salt);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        let path = self.path(name);
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &out)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn get(&self, name: &str) -> Result<Zeroizing<Vec<u8>>> {
        let raw = std::fs::read(self.path(name)).with_context(|| format!("read {name}"))?;
        ensure!(raw.len() > 48 && &raw[..8] == MAGIC, "{name}: not a sealed file");
        let key = self.derive(&raw[8..24])?;
        let pt = XChaCha20Poly1305::new((&*key).into())
            .decrypt(XNonce::from_slice(&raw[24..48]), &raw[48..])
            .map_err(|_| anyhow!("{name}: wrong passphrase or corrupted file"))?;
        Ok(Zeroizing::new(pt))
    }

    pub fn list_keys(&self) -> Result<Vec<String>> {
        let mut v = vec![];
        for e in std::fs::read_dir(self.dir.join("keys"))? {
            let n = e?.file_name().to_string_lossy().to_string();
            if let Some(id) = n.strip_suffix(".share") {
                v.push(id.to_string());
            }
        }
        v.sort();
        Ok(v)
    }
}
