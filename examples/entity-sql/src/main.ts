/**
 * Entity state that survives sleep, stored in the entity's own SQLite.
 *
 * Every entity actor has its own SQLite database. `ActorSqlClient` is an
 * `SqlClient` on that database, so state written there outlives the actor
 * going to sleep, a deploy, or a crash. Its writes commit in the same storage
 * as the entity's mailbox.
 *
 * Run with `pnpm example:entity-sql`. To deploy it to Rivet Cloud, see
 * `server.ts`.
 */
import { RivetCluster } from "@rivet-dev/effect-cluster";
import { Effect } from "effect";
import { Account, AccountLive } from "./account.ts";

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
	yield* Effect.sleep("12 seconds");
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
