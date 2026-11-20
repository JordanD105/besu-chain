# Offline build archives

Everything needed to build the images (MPC signer, proxy, chainlens, documentation site, Remix)
on an operator machine **without internet**. Full guide: [docs/deployment/offline-build.md](../docs/deployment/offline-build.md).

| Archive | Where | Made from | Size |
|---|---|---|---|
| npm packages of chainlens | `chainlens/offline/npm-cache.tgz` (git) | `chainlens/package-lock.json` | ~5 MB |
| npm packages of the proxy | `proxy/offline/npm-cache.tgz` (git) | `proxy/package-lock.json` | ~5 MB |
| Python wheels of the documentation site | `docs-site/offline/wheels.tgz` (git) | `docs-site/requirements.txt` | ~25 MB |
| Rust crates of the MPC signer | `mpc-signer/offline/cargo-vendor.tgz` (git) | `mpc-signer/Cargo.lock` | ~41 MB |
| Remix site | `remix-live-<remix_commit>.tgz` in `image_archives_dir` | `remix_repo` at `remix_commit` | ~175 MB |
| Remix's Solidity compilers | `remix-solc-npm-cache.tgz` in `image_archives_dir` | `remix_solc_versions` + Remix's default | ~13 MB |
| Base images (node, python, nginx, rust, debian) | `base-<image>.tar` in `image_archives_dir` | the `FROM` lines of the Dockerfiles | ~2 GB |

`SHA256SUMS` lists the checksums of the archives in git; `02-images.yml` checks them when
`offline_build: true`.

**Make or refresh them** (on a machine with internet and Docker):

```bash
offline/make-offline.sh --remix /path/to/image_archives_dir
```

```bash
cd ansible && ansible-playbook save-images.yml
```

Then commit the archives in git (`git add -A */offline offline`). Refresh after a change to a
`package-lock.json`, `requirements.txt`, `Cargo.lock`, `remix_commit`, `remix_solc_versions` or a
`FROM` line: an offline build stops with an error when an archive is stale.

The archives in git are plain files, not Git LFS: `01-hosts.yml` packs the repository with
`git archive`, which would put LFS pointers in place of the files.
