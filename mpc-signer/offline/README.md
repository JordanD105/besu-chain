# Offline build archive

`cargo-vendor.tgz`: the Rust crates of `../Cargo.lock` (`cargo vendor`), made by
`offline/make-offline.sh`. When it is here, the Dockerfile builds with `cargo --offline`. See
`offline/README.md`.
