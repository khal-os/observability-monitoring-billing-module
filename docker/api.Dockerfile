# Platform API image. Build context = workspace ROOT (the npm-workspaces root):
#
#   docker build -f docker/api.Dockerfile -t platform-api:local .
#
# Notes that shaped this file (from the pre-dockerization audit):
# - Only the ROOT package-lock.json is authoritative; packages/api/package-lock.json
#   is a stale lockfileVersion-1 relic and must never drive an install.
# - Runtime deps hoist to the root node_modules, so the image preserves the
#   root/packages nesting and Node resolves imports by walking up from
#   packages/api/dist to /app/node_modules.
# - packages/api/package.json ("type":"module") must sit next to dist/, or Node
#   parses the ESM output (top-level await) as CommonJS and crashes.
# - The local dist/ is often stale — tsc ALWAYS runs in-image.
# - The fake LangWatch client fast-globs '**/src/infrastructure/traceSource/
#   fixtures/*.json' from cwd; tsc does not emit JSON, so the fixtures are
#   copied in explicitly to keep offline (fixture-backed) sync working.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/ui/package.json packages/ui/
RUN npm ci --workspace=api
COPY packages/api/tsconfig.json packages/api/
COPY packages/api/src packages/api/src
RUN npm run build --workspace=api \
  && find packages/api/dist \
       \( -name '*.spec.js' -o -name '*.test.js' -o -name '*.map' \) -delete

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    DOTENV_CONFIG_QUIET=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/ui/package.json packages/ui/
RUN npm ci --workspace=api --omit=dev && npm cache clean --force
COPY --from=build /app/packages/api/dist packages/api/dist
COPY packages/api/src/infrastructure/traceSource/fixtures \
     packages/api/src/infrastructure/traceSource/fixtures

# cwd matters: dotenv (.env.<ENVIRONMENT>) and the fixture glob resolve from here.
WORKDIR /app/packages/api
EXPOSE 3000
# The app has no signal handlers; compose sets init: true so PID 1 forwards
# SIGTERM to node. Required env: ENVIRONMENT, SERVER_PORT (+ MONGO_DB_* to be
# useful). MONGO_DB_ATLAS takes the strings 'true'/'false' (mapped to boolean
# by environment-setup.ts).
CMD ["node", "dist/main/index.js"]
