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
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
