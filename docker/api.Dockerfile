# Platform API image. Build context = workspace ROOT (the npm-workspaces root):
#
#   docker build -f docker/api.Dockerfile -t platform-api:local .
#
# Notes that shaped this file (from the pre-dockerization audit):
# - Only the ROOT package-lock.json exists and is authoritative — installs
#   always run from the workspace root (npm workspaces).
# - Runtime deps hoist to the root node_modules, so the image preserves the
#   root/packages nesting and Node resolves imports by walking up from
#   packages/module/dist to /app/node_modules.
# - packages/module/package.json ("type":"module") must sit next to dist/, or Node
#   parses the ESM output (top-level await) as CommonJS and crashes.
# - The local dist/ is often stale — tsc ALWAYS runs in-image.
# - The fake LangWatch client fast-globs '**/src/infrastructure/traceSource/
#   fixtures/*.json' from cwd; tsc does not emit JSON, so the fixtures are
#   copied in explicitly to keep offline (fixture-backed) sync working.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/module/package.json packages/module/
COPY packages/ui/package.json packages/ui/
RUN npm ci --workspace=module
COPY packages/module/tsconfig.json packages/module/tsconfig.build.json packages/module/
COPY packages/module/src packages/module/src
RUN npm run build --workspace=module \
  && find packages/module/dist \
       \( -name '*.spec.js' -o -name '*.test.js' -o -name '*.map' \) -delete

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    DOTENV_CONFIG_QUIET=true
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/module/package.json packages/module/
COPY packages/ui/package.json packages/ui/
RUN npm ci --workspace=module --omit=dev && npm cache clean --force
COPY --from=build /app/packages/module/dist packages/module/dist
COPY packages/module/src/infrastructure/traceSource/fixtures \
     packages/module/src/infrastructure/traceSource/fixtures

# cwd matters: dotenv (.env.<ENVIRONMENT>) and the fixture glob resolve from here.
WORKDIR /app/packages/module
EXPOSE 3000
# The app handles SIGTERM/SIGINT itself (graceful drain, C-5.4); compose
# still sets init: true — PID-1 zombie reaping, plus a backstop if node is
# ever wrapped in a shell that would swallow signals. Required env:
# ENVIRONMENT, SERVER_PORT (+ MONGO_DB_* to be useful). MONGO_DB_ATLAS takes
# the strings 'true'/'false' (mapped to boolean by environment-setup.ts).
CMD ["node", "dist/main/index.js"]
