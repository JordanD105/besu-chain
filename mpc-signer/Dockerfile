# Builds mpc-node and mpc-coordinator.
#   docker build -t mpc-signer .                                # pure-Rust big integers (default)
#   docker build -t mpc-signer --build-arg BIGINT=bigint-rug .  # GMP: faster presigning, LGPL dependency
# No apt-get: the rust image already ships the toolchain (incl. m4 for GMP) and CA certificates.
FROM rust:1.100.0-bookworm AS build
ARG BIGINT=bigint-num
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# Offline: when offline/cargo-vendor.tgz is in the context (offline/make-offline.sh), the crates of
# Cargo.lock come from that vendor directory and cargo runs --offline; otherwise from crates.io.
RUN --mount=type=bind,source=offline,target=/offline \
    if [ -f /offline/cargo-vendor.tgz ]; then \
      tar -xzf /offline/cargo-vendor.tgz -C /src && mkdir -p .cargo \
      && printf '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "vendor"\n' > .cargo/config.toml \
      && offline=--offline; \
    fi \
    && cargo build --release --locked $offline --no-default-features --features "$BIGINT" --bins

FROM debian:bookworm-slim
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN useradd --system --uid 10001 --home /data mpc && mkdir -p /data && chown mpc /data
COPY --from=build /src/target/release/mpc-node /src/target/release/mpc-coordinator /usr/local/bin/
USER mpc
VOLUME ["/data"]
ENV MPC_DATA_DIR=/data
