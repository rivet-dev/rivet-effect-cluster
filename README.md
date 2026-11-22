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

Define entities with Effect Cluster as usual. Each entity instance runs as its own Rivet Actor, and `ActorSqlClient` gives it its own SQLite database.

```ts
// src/counter.ts
import { ActorSqlClient } from "@rivet-dev/effect-cluster";
import { Effect, Schema } from "effect";
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

### 3. Run it locally

`RivetCluster.serve` hosts the entities on this process. In development, RivetKit starts a local Rivet Engine for you.

```ts
// src/main.ts
import { RivetCluster } from "@rivet-dev/effect-cluster";
import { Effect } from "effect";
import { Counter, CounterLive } from "./counter.ts";

const program = Effect.gen(function* () {
	const counter = (yield* Counter.client)("counter-1");
	console.log(yield* counter.Increment({ op: "a" }));
	console.log(yield* counter.Increment({ op: "a" })); // same op: not applied twice
	console.log(yield* counter.Increment({ op: "b" }));
});

const ClusterLive = RivetCluster.serve(CounterLive, { entities: [Counter] });

Effect.runPromise(program.pipe(Effect.provide(ClusterLive))).then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
```

```sh
npx tsx src/main.ts
```

It prints `1`, `1`, `2`: the second `Increment` repeats the primary key `a`, so it returns the stored reply instead of running again. The local engine keeps its data between runs, so running the program again prints the same stored replies.

### 4. Add a server

To deploy, run the entities in a long-lived server next to your HTTP API. With `startEngine: false`, it connects to the engine of the cluster it is deployed to instead of starting a local one.

```ts
// src/server.ts
import { createServer } from "node:http";
import { RivetCluster } from "@rivet-dev/effect-cluster";
import { Effect, ManagedRuntime } from "effect";
import { Counter, CounterLive } from "./counter.ts";

const runtime = ManagedRuntime.make(
	RivetCluster.serve(CounterLive, {
		entities: [Counter],
		// Connect to the cluster's engine instead of starting a local one.
		registry: {
			use: {},
			startEngine: false,
			startServices: false,
			runtime: "native",
		},
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

### 5. Deploy to Rivet Cloud

Create a cluster in the [Rivet dashboard](https://dashboard.rivet.dev), then deploy with the [Rivet CLI](https://rivet.dev/docs/cli/) (Docker must be running):

```sh
npx @rivetkit/cli login
npx @rivetkit/cli deploy --cluster <cluster> --org <org>
```

The deploy prints your app's public URL. See the [Rivet Cloud docs](https://rivet.dev/docs/deploy/cloud/) for environment variables, secrets, rollbacks, and calling your entities from other backends with `RivetCluster.layer`.

### Self-hosting

To run on your own infrastructure, [self-host the Rivet Engine](https://rivet.dev/docs/deploy/self-host/control-plane/), then run `src/server.ts` (or the Docker image) with `RIVET_ENDPOINT` and `RIVET_TOKEN` set to your engine.

## How it works

![One Rivet Actor per entity](https://github.com/user-attachments/assets/4cf7233c-09f7-446f-b172-833f8b57c3b0)

| Effect Cluster | Rivet Actor |
| --- | --- |
| Entity instance | One actor named after the entity type, keyed by the entity id |
| Workflow execution | One `Workflow/<name>` actor per execution id |
| Persisted queue | One `effect.queue` actor per queue name |
| Singleton and `ClusterCron` | One `effect.singleton` actor per singleton |
| `DeliverAt`, durable clocks | Actor schedules, with a recurring heartbeat that replays missed work |
| `maxIdleTime` | The actor's sleep timeout |

A persisted ask is one action through the gateway. The actor stores the request, runs the handler, and stores the reply in its own SQLite before it responds:

![A persisted ask on Rivet](https://github.com/user-attachments/assets/185886ed-f982-412d-9a01-4e7eb37e0883)

## Compared with the SQL backend

Effect's SQL backend coordinates a fleet of runners through one Postgres database:

![Effect SQL backend on Postgres](https://github.com/user-attachments/assets/df90e4dd-2776-412d-bcaf-30bf33c1afeb)

The same persisted ask on each backend:

![The persisted ask on Postgres and on Rivet](https://github.com/user-attachments/assets/15293c63-da48-4e03-ae82-c32fe4b485e8)

| | SQL backend (Postgres) | Rivet |
| --- | --- | --- |
| Placement | Shard (300 per group) on a runner | Actor per entity |
| Ownership | Advisory locks and a hash ring each runner computes | Rivet runs one instance per key |
| You operate | Postgres 14+, a lock session per runner | Nothing on Rivet Cloud; the Rivet Engine if self-hosted |
| `DeliverAt` precision | About 10 s (poll interval) | Milliseconds (actor schedule) |
| Idle entities | In memory until `maxIdleTime` | Sleep after `maxIdleTime`, with no limit on count |
| Storage | One shared database | One SQLite database per entity |

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

- **Failure recovery is unproven.** Recovery after a node crash or a deploy drain is implemented but has only been tested with nodes in a single process.
- **Performance is unmeasured.** Every call goes through the Rivet gateway, and a persisted ask costs two to three durable writes. There are no benchmarks against the SQL backend yet.
- **Entity actions are reachable with a namespace token.** Anyone holding a token for the namespace can call an entity's actor directly, bypassing your application's authorization.
- **Long asks are bounded.** An ask waits inside one actor action, so an ask that runs longer than `actionTimeout` (default 15 minutes) fails.
- **Some APIs are missing.** `Sharding.getSnowflake`, `PersistedQueue` cleanup, and the `WithTransaction` annotation are not supported.
- **Naming is fixed.** Entity type names must fit Rivet's 64-byte actor name limit, and renaming an entity type leaves its existing data behind under the old name.
- **Registry-wide limits.** `serve` raises RivetKit's message size limits to about 2 MB for every actor in the registry.

Bug reports and feedback are welcome in [GitHub issues](https://github.com/rivet-dev/rivet-effect-cluster/issues).

## License

Apache-2.0. Portions are adapted from [Effect](https://github.com/Effect-TS/effect) under the MIT License; see [`LICENSE-effect`](./LICENSE-effect).
