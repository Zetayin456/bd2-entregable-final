# syntax=docker/dockerfile:1.7
FROM rust:1.90-bookworm AS builder
WORKDIR /app
ENV CARGO_BUILD_JOBS=2

# Keep dependency compilation in a cached layer. Cargo's registry cache is
# shared by BuildKit even when a layer must be rebuilt.
COPY Cargo.toml Cargo.lock ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    mkdir src && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release --locked

COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release --locked

# Optional CI/local verification target: docker build --target verify ./backend
FROM builder AS verify
RUN rustup component add clippy
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo check --all-targets --locked \
    && cargo clippy --all-targets --locked -- -D warnings

FROM debian:bookworm-slim AS runtime
WORKDIR /app
COPY --from=builder /app/target/release/backend /app/backend
EXPOSE 8080
CMD ["./backend"]
