# Examples

Each example is its own package. Its `src/main.ts` hosts the example's entities and workflows with `RivetCluster.serve`, runs a short program against them, and exits.

| Example | Shows |
| --- | --- |
| [`entities`](./entities) | Entities, volatile and persisted messages, `Rpc.fork`, and `maxIdleTime`. Adapted from Effect's cluster example. |
| [`entity-sql`](./entity-sql) | Entity state in the entity's own SQLite through `ActorSqlClient`, deduplicated persisted requests, and state that survives sleep. Also deploys to Rivet Cloud. |
| [`workflows`](./workflows) | Durable workflows with activities, a `DurableDeferred` signal, and a `DurableClock` sleep. |
| [`queue-and-cron`](./queue-and-cron) | A `DurableQueue` with workers, `ClusterCron`, and a `Singleton`. |

## Running locally

From the repository root:

```sh
pnpm install
pnpm example:entities
pnpm example:entity-sql
pnpm example:workflows
pnpm example:queue-and-cron
```

No setup is needed. In development, RivetKit starts a local Rivet Engine on `http://127.0.0.1:6420` from the `@rivetkit/engine-cli` package that `rivetkit` installs. The local engine keeps its data between runs. To use another engine, set `RIVET_ENDPOINT`.

## Deploying to Rivet Cloud

The `entity-sql` example also runs as a server (`src/server.ts`) with a small HTTP API that calls the `Account` entity. Deploy it to a Rivet Cloud cluster from the repository root with the [Rivet CLI](https://rivet.dev/docs):

```sh
rivet deploy --cluster <cluster> --org <org> \
  --dockerfile examples/entity-sql/Dockerfile --build-context .
```

Then call it through the pool's public URL:

```sh
curl -X POST https://<pool-url>/accounts/alice/deposits \
  -H 'content-type: application/json' -d '{"requestId":"r1","amount":10}'
curl https://<pool-url>/accounts/alice/history
```

Or call the entity directly through the cluster's engine. Set `RIVET_ENDPOINT` to the cluster's API endpoint (not the pool URL) and `RIVET_TOKEN` to a token for it, then run:

```sh
pnpm --filter example-entity-sql call
```
