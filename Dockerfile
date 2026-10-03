# The Olien service image.
#
# The build context is the repository root, not service/, for two reasons. The binary
# compiles deployments/v1/creation.json into itself, which is how it knows at boot that
# the contracts it is pointed at are Olien v1. And the runtime reads its chain from
# deployments/<chain>.json, so pointing an instance at another chain is DEPLOYMENTS_PATH
# and not a rebuild.

# ---- Build stage ----
FROM rust:1-bookworm AS builder
WORKDIR /app/service

# Dependencies first, against a stub main, so this layer survives source edits. alloy is
# a large tree and recompiling it on every deploy is the slow part.
COPY service/Cargo.toml service/Cargo.lock ./
RUN mkdir src \
    && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src

# include_str! reaches ../../deployments/v1/creation.json from service/src, and
# sqlx::migrate! embeds ./migrations, both at compile time.
COPY deployments /app/deployments
COPY service/migrations ./migrations
COPY service/src ./src
# Cargo decides freshness by mtime. The sources arrive stamped with when they were last
# edited, which can be older than the stub built a moment ago, and then cargo keeps the
# stub: a main that exits at once, prints nothing and fails every healthcheck with no
# log to say why. Touching them forces the real build.
RUN find src -type f -exec touch {} + && cargo build --release --locked

# ---- Runtime stage ----
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/service/target/release/olien-service /usr/local/bin/olien-service
COPY deployments ./deployments
ENV DEPLOYMENTS_PATH=/app/deployments/10143.json \
    PORT=8080
EXPOSE 8080
CMD ["olien-service"]
