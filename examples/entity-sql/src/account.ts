/**
 * An account entity whose deposits live in the entity's own SQLite.
 *
 * Every entity actor has its own SQLite database. `ActorSqlClient` is an
 * `SqlClient` on that database, so state written there outlives the actor
 * going to sleep, a deploy, or a crash.
 */
import { ActorSqlClient } from "@rivet-dev/effect-cluster";
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
	// Sleep after ten idle seconds; the rows outlive the actor.
	{ maxIdleTime: "10 seconds" },
);
