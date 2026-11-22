/**
 * Defining cluster entities.
 *
 * Adapted from Effect's cluster entities example (MIT License, Copyright (c)
 * 2023 Effectful Technologies Inc). See `LICENSE-effect`. The entity code is
 * unchanged; only the cluster layer is replaced with `RivetCluster.serve`.
 *
 * Run with `pnpm example:entities`.
 */
import { RivetCluster } from "@rivetkit/effect-cluster";
import { Effect, Layer, Ref, Schema } from "effect";
import { ClusterSchema, Entity } from "effect/cluster";
import { Rpc } from "effect/rpc";

export const Increment = Rpc.make("Increment", {
	payload: { amount: Schema.Int },
	success: Schema.Int,
});

export const GetCount = Rpc.make("GetCount", {
	success: Schema.Int,
})
	// If you want GetCount messages to be persisted, you can annotate the RPC
	// schema with `ClusterSchema.Persisted`.
	//
	// By default, messages are volatile and only sent over a network.
	.annotate(ClusterSchema.Persisted, true);

// `Entity.make` takes an array of Rpc definitions
export const Counter = Entity.make("Counter", [Increment, GetCount]);

// Entity handlers can keep in-memory state while the entity is active.
// `maxIdleTime` controls passivation: if the entity is idle long enough, its
// actor goes to sleep and the in-memory state is lost. See `entity-sql.ts` for
// state that survives sleep.
export const CounterEntityLayer = Counter.toLayer(
	Effect.gen(function* () {
		const count = yield* Ref.make(0);

		return Counter.of({
			Increment: ({ payload }) =>
				Ref.updateAndGet(count, (current) => current + payload.amount),
			GetCount: () =>
				Ref.get(count).pipe(
					// Add Rpc.fork to allow the GetCount handler to run concurrently
					// with Increment handlers.
					//
					// This opts-out of the default behavior where all handlers for a
					// given entity run sequentially.
					Rpc.fork,
				),
		});
	}),
	{ maxIdleTime: "5 minutes" },
);

// If you ever need to access an entity client, you can use the `client`
// property on the entity definition.
export const useCounter = Effect.gen(function* () {
	const clientFor = yield* Counter.client;
	const counter = clientFor("counter-123");

	const afterIncrement = yield* counter.Increment({ amount: 1 });
	const currentCount = yield* counter.GetCount();

	console.log(
		`Count after increment: ${afterIncrement}, current count: ${currentCount}`,
	);
});

// Merge all your entity layers together.
const EntitiesLayer = Layer.mergeAll(CounterEntityLayer);

// `RivetCluster.serve` hosts the entities on this process as Rivet Actors. In
// development, RivetKit starts a local Rivet Engine automatically; set
// `RIVET_ENDPOINT` to use another engine or Rivet Cloud.
const ClusterLayer = RivetCluster.serve(EntitiesLayer, {
	entities: [Counter],
});

// Closing the layer drains this node and stops the local engine RivetKit
// started. RivetKit can keep the process alive afterwards for actors with
// pending schedules, so exit once the program is done.
Effect.runPromise(useCounter.pipe(Effect.provide(ClusterLayer))).then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
