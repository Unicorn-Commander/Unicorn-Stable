# Stage 1: Build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm install` instead of `npm ci` so adding deps to package.json without
# regenerating the lockfile locally still builds.
RUN npm install --no-audit --no-fund
COPY . .
# Vite only bakes VITE_*-prefixed vars that exist in the build env. Pass the
# Sentry DSN + git sha through as build args so frontend error capture and the
# release tag are compiled in (no-op when VITE_SENTRY_DSN is empty).
ARG VITE_SENTRY_DSN=
ARG GIT_SHA=unknown
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    VITE_GIT_SHA=${GIT_SHA}
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine AS production
COPY --from=build /app/dist /usr/share/nginx/html
# Installed as a TEMPLATE: the nginx image's entrypoint envsubsts
# /etc/nginx/templates/*.template -> /etc/nginx/conf.d/*.conf at start,
# substituting only DEFINED env vars (nginx's own $vars are untouched).
# STABLE_BACKEND_HOST defaults to the compose service name for single-stack
# deploys; multi-stack hosts override it with the unique container name.
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV STABLE_BACKEND_HOST=backend \
    STABLE_CSP_EXTRA_SCRIPT= \
    STABLE_CSP_EXTRA_FRAME=

# --- build provenance (stamped by scripts/deploy.sh / compose build args) ---
ARG GIT_SHA=unknown
ARG GIT_SHA_FULL=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.revision="${GIT_SHA_FULL}" \
      org.opencontainers.image.version="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.title="unicorn-stable-web"
# Surface the built revision at /version.txt for quick "what's deployed" checks.
RUN printf 'sha=%s\nbuilt=%s\n' "${GIT_SHA}" "${BUILD_TIME}" > /usr/share/nginx/html/version.txt

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
