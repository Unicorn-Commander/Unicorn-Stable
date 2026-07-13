# =============================================================================
# Stable Agent Runtime — LiveKit Agents SDK (Python 3.12)
# =============================================================================
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps for Pillow (image rendering for stage track) and audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libjpeg62-turbo-dev \
    libpng-dev \
    libfreetype6-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml .
RUN pip install --no-cache-dir .

COPY . .

# --- build provenance (stamped by scripts/deploy.sh / compose build args) ---
ARG GIT_SHA=unknown
ARG GIT_SHA_FULL=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.revision="${GIT_SHA_FULL}" \
      org.opencontainers.image.version="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.title="unicorn-stable-agent-runtime"
ENV STABLE_GIT_SHA="${GIT_SHA}"

# Non-root user
RUN groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid agent --shell /bin/bash --create-home agent \
    && chown -R agent:agent /app

USER agent

ENTRYPOINT ["python", "-m", "main"]
