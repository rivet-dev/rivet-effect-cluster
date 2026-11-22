/**
 * Entity state that survives sleep, stored in the entity's own SQLite.
 *
 * Every entity actor has its own SQLite database. `ActorSqlClient` is an
 * `SqlClient` on that database, so state written there outlives the actor
 * going to sleep, a deploy, or a crash. Its writes commit in the same storage
 * as the entity's mailbox.
 *
 * Run with `pnpm example:entity-sql`.
 */
import { ActorSqlClient, RivetCluster } from "@rivetkit/effect-cluster";
import { Effect, Schema } from "effect";
import { ClusterSchema, Entity } from "effect/cluster";
import { Rpc } from "effect/rpc";

export const Account = Entity.make("Account", [
	// A persisted request with a primary key runs at most once per key, so a
	// retried deposit is not applied twice.
	Rpc.make("Deposit", {
		payload: { requestId: Schema.String, amount: Schema.Int },
		primaryKey: ({ requestId }) => requestId,
		success: Schema.Int,
	}).annotate(ClusterSchema.Persisted, true),
	Rpc.make("History", {
		success: Schema.Array(Schema.Struct({ amount: Schema.Int })),
	}),
]);

export const AccountLive = Account.toLayer(
	Effect.gen(function* () {
		const sql = yield* ActorSqlClient.orDie;
		// Runs each time the entity wakes; the table persists between wakes.
		yield* sql`CREATE TABLE IF NOT EXISTS deposits (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			amount INTEGER NOT NULL
		)`.pipe(Effect.orDie);

		return Account.of({
			Deposit: ({ payload }) =>
				sql
					.withTransaction(
						sql`INSERT INTO deposits (amount) VALUES (${payload.amount})`.pipe(
							Effect.andThen(
								sql<{
									readonly balance: number;
								}>`SELECT COALESCE(SUM(amount), 0) AS balance FROM deposits`,
							),
						),
					)
					.pipe(
						Effect.map((rows) => rows[0]?.balance ?? 0),
						Effect.orDie,
					),
			History: () =>
				sql<{ readonly amount: number }>`
					SELECT amount FROM deposits ORDER BY seq`.pipe(
					Effect.orDie,
				),
		});
	}),
	// Sleep after one idle second, to show that the rows outlive the actor.
	{ maxIdleTime: "1 second" },
);

const program = Effect.gen(function* () {
	// The local engine keeps data between runs, so each run uses a new account.
	const account = (yield* Account.client)(`account-${Date.now()}`);

	console.log(
		"balance:",
		yield* account.Deposit({ requestId: "a", amount: 50 }),
	);
	console.log(
		"balance:",
		yield* account.Deposit({ requestId: "b", amount: 25 }),
	);
	// The same request id again: the stored reply is returned and the deposit
	// is not applied a second time.
	console.log(
		"balance:",
		yield* account.Deposit({ requestId: "b", amount: 25 }),
	);

	// Let the actor go to sleep, then read the rows back after it wakes.
	yield* Effect.sleep("3 seconds");
	console.log("history after sleep:", yield* account.History());
});

const ClusterLayer = RivetCluster.serve(AccountLive, { entities: [Account] });

// Closing the layer drains this node and stops the local engine RivetKit
// started. RivetKit can keep the process alive afterwards for actors with
// pending schedules, so exit once the program is done.
Effect.runPromise(program.pipe(Effect.provide(ClusterLayer))).then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
