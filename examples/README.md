# Examples

Each example is a single file that hosts its entities and workflows with `RivetCluster.serve`, runs a short program against them, and exits.

| Example | Shows |
| --- | --- |
| [`entities.ts`](./entities.ts) | Entities, volatile and persisted messages, `Rpc.fork`, and `maxIdleTime`. Adapted from Effect's cluster example. |
| [`entity-sql.ts`](./entity-sql.ts) | Entity state in the entity's own SQLite through `ActorSqlClient`, deduplicated persisted requests, and state that survives sleep. |
| [`workflows.ts`](./workflows.ts) | Durable workflows with activities, a `DurableDeferred` signal, and a `DurableClock` sleep. |
| [`queue-and-cron.ts`](./queue-and-cron.ts) | A `DurableQueue` with workers, `ClusterCron`, and a `Singleton`. |

## Running

```sh
pnpm install
pnpm example:entities
pnpm example:entity-sql
pnpm example:workflows
pnpm example:queue-and-cron
```

No setup is needed. In development, RivetKit starts a local Rivet Engine on `http://127.0.0.1:6420` from the `@rivetkit/engine-cli` package that `rivetkit` installs. The local engine keeps its data between runs. To use another engine or Rivet Cloud, set `RIVET_ENDPOINT`.
