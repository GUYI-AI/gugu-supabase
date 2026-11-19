# Build context: repository root. No provider configuration belongs in the image.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/push services/push
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @gugu-supabase/push...
FROM ${NODE_IMAGE}
ENV NODE_ENV=production GUGU_PUSH_HEALTH_PATH=/tmp/push-health.json
COPY --from=build --chown=node:node /src/node_modules /app/node_modules
COPY --from=build --chown=node:node /src/services/push /app/services/push
WORKDIR /app/services/push
USER node
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const s=JSON.parse(require('fs').readFileSync(process.env.GUGU_PUSH_HEALTH_PATH));process.exit(Date.now()-s.progressAt<60000?0:1)"]
CMD ["node", "--use-env-proxy", "src/main.mjs"]
