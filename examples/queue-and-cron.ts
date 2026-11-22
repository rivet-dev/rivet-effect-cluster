/**
 * Durable queues, singletons, and cron jobs.
 *
 * - A `DurableQueue` hands work from a workflow to workers and returns the
 *   result to the workflow. Items are stored in a Rivet Actor per queue and
 *   redelivered if a worker dies.
 * - `ClusterCron` runs a job on a schedule, once per scheduled time across
 *   the whole cluster.
 * - A `Singleton` runs one long-lived instance across the cluster.
 *
 * Run with `pnpm example:queue-and-cron`.
 */
import { RivetCluster } from "@rivetkit/effect-cluster";
import { Cron, DateTime, Effect, Layer, Schema } from "effect";
import { ClusterCron, Singleton } from "effect/cluster";
import { DurableQueue, Workflow } from "effect/workflow";

// A queue of thumbnail jobs.
export const Thumbnails = DurableQueue.make({
	name: "Thumbnails",
	payload: { imageId: Schema.String },
	success: Schema.String,
	idempotencyKey: ({ imageId }) => imageId,
});

// Workers take jobs from the queue. Run them on as many nodes as you like.
export const ThumbnailWorkerLive = DurableQueue.worker(
	Thumbnails,
	({ imageId }) =>
		Effect.sync(() => {
			console.log(`[worker] rendering a thumbnail for ${imageId}`);
			return `${imageId}-thumb.png`;
		}),
);

// A workflow that enqueues a job and waits for the worker's result.
export const UploadWorkflow = Workflow.make("UploadWorkflow", {
	payload: { imageId: Schema.String },
	success: Schema.String,
	idempotencyKey: ({ imageId }) => imageId,
});

export const UploadWorkflowLive = UploadWorkflow.toLayer(({ imageId }) =>
	DurableQueue.process(Thumbnails, { imageId }),
);

// Runs every two seconds, once per scheduled time across the cluster.
export const CleanupCronLive = ClusterCron.make({
	name: "Cleanup",
	cron: Cron.parseUnsafe("*/2 * * * * *", "UTC"),
	execute: Effect.gen(function* () {
		const scheduled = yield* ClusterCron.CurrentScheduledTime;
		console.log(`[cron] cleanup for ${DateTime.formatIso(scheduled)}`);
	}),
});

// One instance across the cluster, restarted if its node is lost.
export const HeartbeatSingletonLive = Singleton.make(
	"Heartbeat",
	Effect.gen(function* () {
		console.log("[singleton] started");
		yield* Effect.never;
	}),
);

const program = Effect.gen(function* () {
	const thumbnail = yield* UploadWorkflow.execute({ imageId: "image-7" });
	console.log("thumbnail:", thumbnail);

	// Let the cron job fire a few times.
	yield* Effect.sleep("5 seconds");
});

const ClusterLayer = RivetCluster.serve(
	Layer.mergeAll(
		ThumbnailWorkerLive,
		UploadWorkflowLive,
		CleanupCronLive,
		HeartbeatSingletonLive,
	),
	{ entities: [] },
);

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
