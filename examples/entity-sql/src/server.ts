/**
 * The account example as a long-running server, for deploying to Rivet Cloud.
 *
 * The process hosts the `Account` entity as Rivet Actors and serves a small
 * HTTP API on `PORT` that calls it:
 *
 * - `GET /` answers `ok`.
 * - `POST /accounts/:id/deposits` with `{ "requestId": "...", "amount": 10 }`
 *   deposits and returns the balance. Repeating a request id is a no-op.
 * - `GET /accounts/:id/history` lists the deposits.
 *
 * On Rivet Cloud the runner pool sets `RIVET_ENDPOINT`, `RIVET_TOKEN`,
 * `RIVET_POOL`, `PORT`, and `RIVETKIT_METRICS_PORT`; nothing else is needed.
 * Deploy from the repository root with:
 *
 *     rivet deploy --cluster <cluster> --org <org> \
 *       --dockerfile examples/entity-sql/Dockerfile --build-context .
 */
import { createServer, type IncomingMessage } from "node:http";
import { RivetCluster } from "@rivet-dev/effect-cluster";
import { Effect, ManagedRuntime } from "effect";
import { Account, AccountLive } from "./account.ts";

const ClusterLayer = RivetCluster.serve(AccountLive, {
	entities: [Account],
	// Connect to the cluster's engine instead of starting a local one.
	registry: {
		use: {},
		startEngine: false,
		startServices: false,
		runtime: "native",
	},
});

const runtime = ManagedRuntime.make(ClusterLayer);

const readJson = async (request: IncomingMessage): Promise<unknown> => {
	const chunks: Array<Buffer> = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return chunks.length === 0
		? {}
		: JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const route = async (request: IncomingMessage): Promise<[number, unknown]> => {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (request.method === "GET" && url.pathname === "/") return [200, "ok"];

	const deposit = url.pathname.match(/^\/accounts\/([^/]+)\/deposits$/);
	if (request.method === "POST" && deposit) {
		const body = (await readJson(request)) as {
			readonly requestId?: unknown;
			readonly amount?: unknown;
		};
		if (
			typeof body.requestId !== "string" ||
			typeof body.amount !== "number" ||
			!Number.isInteger(body.amount)
		) {
			return [
				400,
				{ error: "expected { requestId: string, amount: integer }" },
			];
		}
		const balance = await runtime.runPromise(
			Effect.gen(function* () {
				const account = (yield* Account.client)(
					decodeURIComponent(deposit[1]),
				);
				return yield* account.Deposit({
					requestId: body.requestId as string,
					amount: body.amount as number,
				});
			}),
		);
		return [200, { balance }];
	}

	const history = url.pathname.match(/^\/accounts\/([^/]+)\/history$/);
	if (request.method === "GET" && history) {
		const deposits = await runtime.runPromise(
			Effect.gen(function* () {
				const account = (yield* Account.client)(
					decodeURIComponent(history[1]),
				);
				return yield* account.History();
			}),
		);
		return [200, { deposits }];
	}

	return [404, { error: "not found" }];
};

// Start the cluster node before accepting requests.
await runtime.runPromise(Effect.void);

const port = Number(process.env.PORT ?? 8080);
createServer((request, response) => {
	route(request).then(
		([status, body]) => {
			response.writeHead(status, {
				"content-type":
					typeof body === "string"
						? "text/plain"
						: "application/json",
			});
			response.end(
				typeof body === "string" ? body : JSON.stringify(body),
			);
		},
		(error) => {
			console.error(error);
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "internal error" }));
		},
	);
}).listen(port, "0.0.0.0", () => {
	console.log(`listening on :${port}`);
});
