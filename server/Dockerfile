FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --gid 1000 stable && \
    useradd --uid 1000 --gid stable --shell /bin/bash --create-home stable

WORKDIR /home/stable/server

FROM base AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc libpq-dev && \
    rm -rf /var/lib/apt/lists/*

COPY pyproject.toml .
RUN pip install --prefix=/install .

FROM base AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends libpq5 curl && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /install /usr/local

COPY --chown=stable:stable . .

# --- build provenance (stamped by scripts/deploy.sh / compose build args) ---
ARG GIT_SHA=unknown
ARG GIT_SHA_FULL=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.revision="${GIT_SHA_FULL}" \
      org.opencontainers.image.version="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.title="unicorn-stable-backend"
ENV STABLE_GIT_SHA="${GIT_SHA}" \
    STABLE_BUILD_TIME="${BUILD_TIME}"

USER stable

EXPOSE 8400

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8400/live || exit 1

CMD ["./entrypoint.sh"]
