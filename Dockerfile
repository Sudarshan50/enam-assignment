# One image for the API, web app and worker; each compose service picks its own command.
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm ci --no-audit --no-fund
# Next.js bakes rewrites in at build time, so the in-network API address is a build arg.
ARG API_ORIGIN=http://finn-api:4000
RUN API_ORIGIN=$API_ORIGIN npm run build -w @finn/web

FROM node:24-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
USER node
