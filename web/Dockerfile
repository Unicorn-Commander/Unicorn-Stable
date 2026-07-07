# Stage 1: Build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm install` instead of `npm ci` so adding deps to package.json without
# regenerating the lockfile locally still builds.
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine AS production
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

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
