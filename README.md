# @rivet-dev/effect-cluster

> [!WARNING]
> **Experimental. Use at your own risk.** If you choose to adopt it, we recommend forking this repository and patching issues yourself.

Run [Effect Cluster](https://effect.website) entities, workflows, persisted queues, and singletons on Rivet Actors. Your Effect code stays the same; only the layer that provides `Sharding` changes.

Every entity instance is its own Rivet Actor, with its own SQLite database for its mailbox and state. There is no Postgres, no shard ring, and no storage polling.

## Why Rivet

- **Scales horizontally:** no hash ring, no shard locks, no single database to outgrow.
- **Own SQLite per entity:** state and mailbox commit together, through `ActorSqlClient`.
- **Idle entities sleep:** millions of entities cost nothing until they get a message.
- **On-time timers:** `DeliverAt` and workflow clocks fire on schedule, with no polling.
- **Cheap storage:** about 10x cheaper than Postgres for long-term state and history.
- **Nothing to operate:** run on [Rivet Cloud](https://rivet.dev) or self-host the open-source Rivet Engine.

## Quickstart

### 1. Create a project

```sh
mkdir my-cluster && cd my-cluster
npm init -y
npm pkg set type=module
npm install @rivet-dev/effect-cluster effect@~4.1.4 rivetkit@next tsx
```

`effect` and `rivetkit` are peer dependencies. This package requires `effect` 4.1 and `rivetkit` 3.1.2 or later.

### 2. Define an entity

Define entities with Effect Cluster as usual. Each entity instance runs as its own Rivet Actor.

```ts
// src/counter.ts
import { Effect, Ref, Schema } from "effect";
import { ClusterSchema, Entity } from "effect/cluster";
import { Rpc } from "effect/rpc";

export const Counter = Entity.make("Counter", [
	// A persisted request with a primary key runs at most once per key.
	Rpc.make("Increment", {
		payload: { op: Schema.String },
		primaryKey: ({ op }) => op,
		success: Schema.Number,
	}).annotate(ClusterSchema.Persisted, true),
]);

export const CounterLive = Counter.toLayer(
	Effect.gen(function* () {
		// In-memory state: lost when the entity sleeps.
		const count = yield* Ref.make(0);
		return Counter.of({
			Increment: () => Ref.updateAndGet(count, (n) => n + 1),
		});
	}),
);
```

### 3. Add a durable SQLite database per entity (optional)

To keep state across sleeps, deploys, and crashes, give the entity its own SQLite database with `ActorSqlClient`. Its writes commit in the same storage as the entity's mailbox. Replace `CounterLive`:

```ts
// src/counter.ts
import { ActorSqlClient } from "@rivet-dev/effect-cluster";

export const CounterLive = Counter.toLayer(
	Effect.gen(function* () {
		const sql = yield* ActorSqlClient.orDie;
		yield* sql`CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)`.pipe(
			Effect.orDie,
		);
		return Counter.of({
			Increment: () =>
				sql<{ readonly value: number }>`
					INSERT INTO counter (id, value) VALUES (1, 1)
					ON CONFLICT (id) DO UPDATE SET value = value + 1
					RETURNING value`.pipe(
					Effect.map((rows) => rows[0]!.value),
					Effect.orDie,
				),
		});
	}),
);
```

### 4. Start a server

Host the entities in a server next to your HTTP API. Locally, RivetKit starts a development engine for you. When `RIVET_ENDPOINT` is set, as it is on Rivet Cloud, it connects to that engine instead.

```ts
// src/server.ts
import { createServer } from "node:http";
import { RivetCluster } from "@rivet-dev/effect-cluster";
import { Effect, ManagedRuntime } from "effect";
import { Counter, CounterLive } from "./counter.ts";

const runtime = ManagedRuntime.make(
	RivetCluster.serve(CounterLive, {
		entities: [Counter],
	}),
);
await runtime.runPromise(Effect.void);

createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://localhost");
	const op = url.searchParams.get("op") ?? crypto.randomUUID();
	runtime
		.runPromise(
			Effect.gen(function* () {
				const counter = (yield* Counter.client)("counter-1");
				return yield* counter.Increment({ op });
			}),
		)
		.then(
			(value) => response.end(String(value)),
			(error) => {
				console.error(error);
				response.writeHead(500).end();
			},
		);
}).listen(Number(process.env.PORT ?? 8080));
```

Run it and call it:

```sh
npx tsx src/server.ts
```

```sh
curl "localhost:8080/?op=a"   # 1
curl "localhost:8080/?op=a"   # 1: same op, so the stored reply is returned
curl "localhost:8080/?op=b"   # 2
```

### 5. Deploy

<details>
<summary><b>Rivet Cloud</b></summary>

Add a `Dockerfile` and a `.dockerignore`:

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
	&& rm -rf node_modules/@rivet-dev/agentos-* node_modules/@rivet-dev/agent-os-* node_modules/@agentos-software node_modules/@rivetkit/engine-cli-* \
	&& npm cache clean --force
COPY . .
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "src/server.ts"]
```

```
node_modules
*.tar
.env*
```

Create a cluster in the [Rivet dashboard](https://dashboard.rivet.dev), then deploy with the [Rivet CLI](https://rivet.dev/docs/cli/) (Docker must be running):

```sh
npx @rivetkit/cli login
npx @rivetkit/cli deploy --cluster <cluster> --org <org>
```

The deploy prints your app's public URL. See the [Rivet Cloud docs](https://rivet.dev/docs/deploy/cloud/) for environment variables, secrets, rollbacks, and calling your entities from other backends with `RivetCluster.layer`.

</details>

<details>
<summary><b>Self-host</b></summary>

[Self-host the Rivet Engine](https://rivet.dev/docs/deploy/self-host/control-plane/), then run `src/server.ts` (or the Docker image) with `RIVET_ENDPOINT` and `RIVET_TOKEN` set to your engine.

</details>

## How it works

Every entity is its own Rivet Actor, keyed by the entity id, with its own SQLite database for its mailbox and state. Workflow executions and durable queues work the same way. A call goes straight to the entity's actor, and Rivet places actors across your nodes and sleeps them when idle.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/bc89812f-8570-47fe-b021-79bfea05d4e1">
  <img alt="Your Effect app calls the Order entity's actor, which stores the request and reply in its own SQLite. Workflow executions and durable queues are actors too." src="https://github.com/user-attachments/assets/be35f34b-d1a9-4f62-a4b1-c39c9e0c4d75">
</picture>

### Compared with Postgres

Effect's default backend splits entities into 300 shards on a hash ring across runners, and every message, reply, and lock goes through one shared Postgres database.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/612ac91b-e7a5-4285-a743-cabe7e987221">
  <img alt="Effect's default backend: the caller inserts the request into Postgres and sends it to the runner that owns the shard, which claims the row and writes the reply to Postgres." src="https://github.com/user-attachments/assets/192b9632-69a7-4a4d-848a-ae5e19b9ad71">
</picture>

| | Postgres backend | Rivet |
| --- | --- | --- |
| Placement | A shard on a runner | An actor per entity |
| Storage | One shared database | SQLite per entity |
| Scaling | Rebalance shards; all writes go to one database | Add machines |
| `DeliverAt` | Found by a 10 s poll | Fires on time |
| Idle entities | In memory until `maxIdleTime` | Sleep and cost nothing |

## Examples

Runnable examples for entities, entity SQLite, workflows, durable queues, cron, and singletons are in [`examples/`](./examples). Workflows and queues need no extra layers: `RivetCluster.serve` and `RivetCluster.layer` already provide the `WorkflowEngine` and `PersistedQueueFactory`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `entities` | | Every entity type this process calls or hosts |
| `client` | RivetKit defaults | RivetKit client configuration |
| `registry` | RivetKit defaults | RivetKit registry configuration (`serve` only); `use` adds your other actors |
| `keepAliveHeartbeat` | 30 s | How often a busy entity re-arms its recovery schedule; bounds how long it stays down after its node is lost |
| `actionTimeout` | 15 min | Upper bound of one entity action, and so of one ask |

## Known limitations

- **Long asks are bounded.** An ask waits inside one actor action, so an ask that runs longer than `actionTimeout` (default 15 minutes) fails.
- **Some APIs are missing.** `Sharding.getSnowflake`, `PersistedQueue` cleanup, and the `WithTransaction` annotation are not supported.
- **Naming is fixed.** Entity type names must fit Rivet's 64-byte actor name limit, and renaming an entity type leaves its existing data behind under the old name.

Bug reports and feedback are welcome in [GitHub issues](https://github.com/rivet-dev/rivet-effect-cluster/issues).

## License

Apache-2.0. Portions are adapted from [Effect](https://github.com/Effect-TS/effect) under the MIT License; see [`LICENSE-effect`](./LICENSE-effect).
