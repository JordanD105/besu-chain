# GPG key for the node-key backups

> **What:** The GPG key that encrypts the node-key backups: create it, give Ansible the public half, keep the private half offline, check and decrypt backups.
> **For:** operators.
> **Related:** [Ansible](ansible.md) · [disaster recovery](../operations/disaster-recovery.md) · [restore](../operations/restore.md)

**Contents**
- [1. Create the key pair](#1-create-the-key-pair)
- [2. Export the public key for Ansible](#2-export-the-public-key-for-ansible)
- [3. Move the private key off the operator (if you created it there)](#3-move-the-private-key-off-the-operator-if-you-created-it-there)
- [4. Run the backups and check them](#4-run-the-backups-and-check-them)
- [5. Decrypt a key for a restore](#5-decrypt-a-key-for-a-restore)
- [Notes](#notes)

---

Phase 10 (`10-backups.yml`) backs up the 6 Besu node keys (val1–val4, rpc1, rpc2). Each key is
copied out of its data volume (`backup-key.sh`) into a private temporary directory, encrypted
**on its own host** with your GPG **public** key (Ansible installs GnuPG there when
`install_packages` is true), the plain copy is shredded, and only the encrypted file is kept,
in `ansible/state/key-backups/<node>.key.gpg`. Only the matching **private** key (and its
passphrase) can decrypt them. So:

- the **public key** goes on the operator, for Ansible (`key_backup_gpg_public_key`);
- the **private key** goes to your offline vault, never next to the encrypted backups.

Best is to create the key pair on a machine that stays offline. If you create it on the operator,
move the private key off it afterwards (step 3).

## 1. Create the key pair

On a server without a desktop, GPG can't open its usual passphrase window ("No pinentry"), so
let it ask in the terminal:

```bash
gpg --pinentry-mode loopback --quick-gen-key 'besu-chain key backups' rsa4096 encr never
```

It asks for a passphrase twice. Choose a strong one and store it in your vault: the private key
and this passphrase together decrypt the node key backups.

(Alternative: install the terminal pinentry with `dnf install -y pinentry` or
`apt install -y pinentry-curses`, then run the same command without `--pinentry-mode loopback`.)

## 2. Export the public key for Ansible

```bash
mkdir -p /opt/000 && gpg --armor --export 'besu-chain key backups' > /opt/000/backup-pub.asc
```

```bash
head -1 /opt/000/backup-pub.asc
```

It must print `-----BEGIN PGP PUBLIC KEY BLOCK-----`. Then, in
`ansible/group_vars/all/settings.yml`:

```yaml
key_backup_gpg_public_key: /opt/000/backup-pub.asc
```

## 3. Move the private key off the operator (if you created it there)

1. Export the private key to a file (asks for the passphrase):

   ```bash
   gpg --pinentry-mode loopback --armor --export-secret-keys 'besu-chain key backups' > besu-backup-private.asc
   ```

2. Copy `besu-backup-private.asc` to your offline vault (USB key, password manager file, safe),
   and check the copy is readable there.

3. Remove it from the operator: the file, then the secret key from GPG's keyring (confirm when
   GPG asks):

   ```bash
   shred -u besu-backup-private.asc
   ```

   ```bash
   gpg --pinentry-mode loopback --delete-secret-keys 'besu-chain key backups'
   ```

The public key stays, and it's all Ansible needs:

```bash
gpg --list-keys 'besu-chain key backups'
```

`gpg --list-secret-keys` must no longer list it.

## 4. Run the backups and check them

```bash
cd ansible && ansible-playbook 10-backups.yml
```

```bash
ls -l state/key-backups/
```

Six files, `val1.key.gpg` … `val4.key.gpg`, `rpc1.key.gpg`, `rpc2.key.gpg`. Each backup is also
recorded for monitoring on its host, so the `ValidatorKeyBackupMissing` alert
([Alerts](../operations/alerts.md)) clears once all four validator keys are recorded. Each must be encrypted
to your key (this check works without the private key). The `keyid` in the first line:

```bash
gpg --list-packets state/key-backups/val1.key.gpg 2>&1 | grep -i 'pubkey enc packet'
```

must be the one after `rsa4096/` here:

```bash
gpg --list-keys --keyid-format long 'besu-chain key backups'
```

Then copy `ansible/state/` (with `key-backups/`) to your vault. Once in a while, test a restore
on the offline machine (step 5) without using the result.

## 5. Decrypt a key for a restore

On the machine that holds the private key (import it from the vault first if needed):

```bash
gpg --pinentry-mode loopback --import besu-backup-private.asc
```

```bash
gpg --pinentry-mode loopback --decrypt val3.key.gpg > val3.key
```

Copy `val3.key` to the node's host over SSH, restore it there with `./restore-key.sh` in that
node's folder (see [Disaster recovery](../operations/disaster-recovery.md), 6.1), then
shred every plain copy:

```bash
shred -u val3.key
```

## Notes

- **Lost private key or passphrase:** the existing backups can't be read anymore. Make a new key
  pair (steps 1–3), set the new public key, delete `state/key-backups/` and rerun
  `10-backups.yml`: the keys are backed up again, encrypted to the new key.
- **New key pair, old backups:** the same as above. Keep the old private key as long as you keep
  the old backups.
- The backups are made once per key (node keys never change). Delete a file in
  `state/key-backups/` to make Ansible back up that node again.
- **Rebuilt host:** the record for monitoring is on the host, so after a rebuild the
  `ValidatorKeyBackupMissing` alert fires although `state/key-backups/` is complete. Move the files
  aside and rerun `10-backups.yml` ([Restore with Ansible](../operations/restore.md), step 5).
- Without `key_backup_gpg_public_key`, phase 10 skips the key backups and the alert stays.
