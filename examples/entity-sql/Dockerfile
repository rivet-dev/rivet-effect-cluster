# Runner image for the entity-sql example. Build from the repository root:
#
#   rivet deploy --cluster <cluster> --org <org> \
#     --dockerfile examples/entity-sql/Dockerfile --build-context .
FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY examples/entity-sql/package.json examples/entity-sql/
# Install the example and the library it uses from this workspace. A runner
# never uses RivetKit's local engine or dev services, so drop them.
RUN CI=true pnpm install --frozen-lockfile --filter example-entity-sql... \
	&& rm -rf node_modules/.pnpm/@rivetkit+engine-cli* \
		node_modules/.pnpm/@rivet-dev+services* \
		node_modules/.pnpm/@rivet-dev+agentos-* \
		node_modules/.pnpm/@rivet-dev+agent-os-* \
		node_modules/.pnpm/@agentos-software* \
		node_modules/.pnpm/@biomejs* \
	&& pnpm store prune
COPY LICENSE LICENSE-effect ./
COPY src ./src
COPY examples/entity-sql/src examples/entity-sql/src
ENV NODE_ENV=production
WORKDIR /app/examples/entity-sql
CMD ["node", "--import", "tsx", "src/server.ts"]
