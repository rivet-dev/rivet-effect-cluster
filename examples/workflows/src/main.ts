/**
 * Durable workflows: activities, durable clocks, and durable deferreds.
 *
 * Each workflow execution runs as its own Rivet Actor. Activity results,
 * clocks, and deferred results are stored in that actor's SQLite, so an
 * execution resumes where it left off after a restart, and a workflow waiting
 * on a clock or a signal can sleep.
 *
 * Run with `pnpm example:workflows`.
 */
import { RivetCluster } from "@rivet-dev/effect-cluster";
import { Effect, Layer, Option, Schedule, Schema } from "effect";
import {
	Activity,
	DurableClock,
	DurableDeferred,
	Workflow,
} from "effect/workflow";

// A signal the workflow waits for: an approval decision.
export const Approval = DurableDeferred.make("Approval", {
	success: Schema.Boolean,
});

export const RefundWorkflow = Workflow.make("RefundWorkflow", {
	payload: { orderId: Schema.String, amount: Schema.Number },
	success: Schema.String,
	// Executions with the same key are the same execution.
	idempotencyKey: ({ orderId }) => orderId,
});

export const RefundWorkflowLive = RefundWorkflow.toLayer(
	Effect.fnUntraced(function* ({ orderId, amount }) {
		// An activity runs once per execution; on replay its stored result is
		// used instead of running it again.
		const ticket = yield* Activity.make({
			name: "OpenTicket",
			success: Schema.String,
			execute: Effect.sync(() => {
				console.log(`[activity] opening a ticket for ${orderId}`);
				return `ticket-${orderId}`;
			}),
		});

		// Wait for an approval. The execution suspends until it arrives.
		const approved = yield* DurableDeferred.await(Approval);
		if (!approved) return `${ticket}: refund rejected`;

		// A durable clock: the workflow can sleep for minutes or days and
		// resumes on schedule, even across restarts.
		yield* DurableClock.sleep({
			name: "CoolingOff",
			duration: "2 seconds",
		});

		yield* Activity.make({
			name: "IssueRefund",
			execute: Effect.sync(() => {
				console.log(`[activity] refunding ${amount} for ${orderId}`);
			}),
		});
		return `${ticket}: refunded ${amount}`;
	}),
);

const program = Effect.gen(function* () {
	// The local engine keeps data between runs, so each run uses a new order.
	const payload = { orderId: `order-${Date.now()}`, amount: 30 };
	const executionId = yield* RefundWorkflow.executionId(payload);

	// Start the execution without waiting for its result.
	yield* RefundWorkflow.execute(payload, { discard: true });

	// Wait until it suspends on the approval.
	yield* RefundWorkflow.poll(executionId).pipe(
		Effect.repeat({
			until: (result) =>
				Option.isSome(result) && result.value._tag === "Suspended",
			schedule: Schedule.spaced("100 millis"),
		}),
	);
	console.log("waiting for approval...");

	// Send the approval, from anywhere that knows the execution id.
	const token = DurableDeferred.tokenFromExecutionId(Approval, {
		workflow: RefundWorkflow,
		executionId,
	});
	yield* DurableDeferred.succeed(Approval, { token, value: true });

	// Executing again with the same payload attaches to the same execution and
	// returns its result once it completes.
	const result = yield* RefundWorkflow.execute(payload);
	console.log("result:", result);
});

const ClusterLayer = RivetCluster.serve(Layer.mergeAll(RefundWorkflowLive), {
	entities: [],
});

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
