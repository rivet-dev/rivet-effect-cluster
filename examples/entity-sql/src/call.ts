/**
 * Calls the deployed `Account` entity through the cluster's engine.
 *
 * Set `RIVET_ENDPOINT` to the cluster's API endpoint and `RIVET_TOKEN` to a
 * token for it, then run `pnpm --filter example-entity-sql call`. This uses
 * `RivetCluster.layer`, which only calls entities; the deployed runners host
 * them.
 */
import { RivetCluster } from "@rivet-dev/effect-cluster";
import { Effect } from "effect";
import { Account } from "./account.ts";

const endpoint = process.env.RIVET_ENDPOINT;
const token = process.env.RIVET_TOKEN;
if (!endpoint || !token) {
	throw new Error("Set RIVET_ENDPOINT and RIVET_TOKEN");
}

const program = Effect.gen(function* () {
	const id = `account-${Date.now()}`;
	const account = (yield* Account.client)(id);
	console.log(
		id,
		"balance:",
		yield* account.Deposit({ requestId: "a", amount: 40 }),
	);
	console.log(
		id,
		"balance:",
		yield* account.Deposit({ requestId: "b", amount: 2 }),
	);
	console.log(id, "history:", yield* account.History());
});

Effect.runPromise(
	program.pipe(
		Effect.provide(
			RivetCluster.layer({
				entities: [Account],
				client: { endpoint, token },
			}),
		),
	),
).then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
