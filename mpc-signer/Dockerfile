# Builds mpc-node and mpc-coordinator.
#   docker build -t mpc-signer .                              # pure-Rust big integers (default)
#   docker build -t mpc-signer --build-arg BIGINT=bigint-rug .  # GMP: faster presigning, LGPL dependency
FROM rust:1-bookworm AS build
ARG BIGINT=bigint-num
RUN apt-get update && apt-get install -y --no-install-recommends m4 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked --no-default-features --features "$BIGINT" --bins

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /data mpc && mkdir -p /data && chown mpc /data
COPY --from=build /src/target/release/mpc-node /src/target/release/mpc-coordinator /usr/local/bin/
USER mpc
VOLUME ["/data"]
ENV MPC_DATA_DIR=/data
