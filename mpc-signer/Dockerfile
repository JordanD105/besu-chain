# Builds mpc-node and mpc-coordinator.
#   docker build -t mpc-signer .                                # pure-Rust big integers (default)
#   docker build -t mpc-signer --build-arg BIGINT=bigint-rug .  # GMP: faster presigning, LGPL dependency
# No apt-get: the rust image already ships the toolchain (incl. m4 for GMP) and CA certificates.
FROM rust:1-bookworm AS build
ARG BIGINT=bigint-num
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked --no-default-features --features "$BIGINT" --bins

FROM debian:bookworm-slim
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN useradd --system --uid 10001 --home /data mpc && mkdir -p /data && chown mpc /data
COPY --from=build /src/target/release/mpc-node /src/target/release/mpc-coordinator /usr/local/bin/
USER mpc
VOLUME ["/data"]
ENV MPC_DATA_DIR=/data
