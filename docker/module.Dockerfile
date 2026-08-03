# Platform MODULE image (@observability/module + @observability/core) — the read API. Build
# context = workspace ROOT (the npm-workspaces root):
#
#   docker build -f docker/module.Dockerfile -t platform-module:local .
#
# Notes that shaped this file (from the pre-dockerization audit + the split):
# - Only the ROOT package-lock.json exists and is authoritative — installs
#   always run from the workspace root (npm workspaces).
# - Runtime deps hoist to the root node_modules, so the image preserves the
#   root/packages nesting and Node resolves imports by walking up from
#   packages/module/dist to /app/node_modules. @observability/core resolves through
#   its workspace symlink + exports map into packages/core/dist.
# - packages/{core,module}/package.json ("type":"module") must sit next to
#   each dist/, or Node parses the ESM output (top-level await) as CommonJS
#   and crashes.
# - The local dist/ is often stale — tsc ALWAYS runs in-image (tsc -b builds
#   core first via project references).
# - This image is VENDOR-FREE BY CONSTRUCTION: no trace-source code, no
#   fixtures — ingestion ships in platform-connector (connector.Dockerfile).
#   @observability/connector is a devDependency (test seeding only); --omit=dev keeps
#   it out of the runtime stage.
# - Every workspace package.json must be present for npm ci to resolve the
#   workspace graph, even packages this image never runs.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/module/package.json packages/module/
COPY packages/connector/package.json packages/connector/
COPY packages/ui/package.json packages/ui/
RUN npm ci --workspace=@observability/module
COPY packages/core/tsconfig.json packages/core/tsconfig.build.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/module/tsconfig.json packages/module/tsconfig.build.json packages/module/
COPY packages/module/src packages/module/src
RUN npm run build --workspace=@observability/module \
  && find packages/core/dist packages/module/dist \
       \( -name '*.spec.js' -o -name '*.test.js' -o -name '*.map' \) -delete

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    DOTENV_CONFIG_QUIET=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/module/package.json packages/module/
COPY packages/connector/package.json packages/connector/
COPY packages/ui/package.json packages/ui/
RUN npm ci --workspace=@observability/module --omit=dev && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/module/dist packages/module/dist

# cwd matters: dotenv (.env.<ENVIRONMENT>) resolves from here.
WORKDIR /app/packages/module
EXPOSE 3000
# The app handles SIGTERM/SIGINT itself (graceful drain, C-5.4); compose
# still sets init: true — PID-1 zombie reaping, plus a backstop if node is
# ever wrapped in a shell that would swallow signals. Required env:
# ENVIRONMENT, SERVER_PORT (+ MONGO_DB_* to be useful). MONGO_DB_ATLAS takes
# the strings 'true'/'false' (mapped to boolean by environment-setup.ts).
CMD ["node", "dist/main/index.js"]
