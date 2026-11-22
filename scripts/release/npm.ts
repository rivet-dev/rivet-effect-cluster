import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "execa";
import type { ReleaseOpts } from "./main";

async function npmVersionExists(
	packageName: string,
	version: string,
): Promise<boolean> {
	console.log(
		`==> Checking if NPM version exists: ${packageName}@${version}`,
	);
	try {
		await $({
			stdout: "ignore",
			stderr: "pipe",
		})`npm view ${packageName}@${version} version`;
		return true;
	} catch (error: any) {
		if (error.stderr) {
			const stderr = error.stderr;
			// Expected errors when version or package doesn't exist
			const expected =
				stderr.includes(`No match found for version ${version}`) ||
				stderr.includes(
					`'${packageName}@${version}' is not in this registry.`,
				) ||
				stderr.includes("404 Not Found") ||
				stderr.includes("is not in the npm registry");
			if (!expected) {
				throw new Error(
					`unexpected npm view version output: ${stderr}`,
				);
			}
		}
		return false;
	}
}

/** Builds and publishes the package at the repository root. */
export async function publishNpm(opts: ReleaseOpts) {
	const pkg = JSON.parse(
		await fs.readFile(join(opts.repoRoot, "package.json"), "utf-8"),
	);

	if (await npmVersionExists(pkg.name, opts.version)) {
		console.log(
			`Version ${opts.version} of ${pkg.name} already exists. Skipping...`,
		);
		return;
	}

	const isReleaseCandidate = opts.version.includes("-rc.");
	const tag = isReleaseCandidate
		? "rc"
		: opts.latest
			? "latest"
			: opts.minorVersionChannel;

	console.log(`==> Building ${pkg.name}`);
	await $({ stdio: "inherit", cwd: opts.repoRoot })`rm -rf dist`;
	await $({ stdio: "inherit", cwd: opts.repoRoot })`pnpm build`;

	// pnpm pack applies publishConfig, so the tarball's exports point at dist.
	// npm publishes it, because npm handles trusted publishing (OIDC).
	const packDir = await fs.mkdtemp(join(tmpdir(), "effect-cluster-pack-"));
	await $({
		stdio: "inherit",
		cwd: opts.repoRoot,
	})`pnpm pack --pack-destination ${packDir}`;
	const [tarball] = (await fs.readdir(packDir)).filter((file) =>
		file.endsWith(".tgz"),
	);
	if (tarball === undefined) throw new Error("pnpm pack produced no tarball");

	console.log(
		`==> Publishing to NPM: ${pkg.name}@${opts.version} (tag ${tag})`,
	);
	try {
		await $({
			stdio: "inherit",
			cwd: opts.repoRoot,
		})`npm publish ${join(packDir, tarball)} --access public --tag ${tag} --provenance`;
		console.log(`✅ Published ${pkg.name}@${opts.version}`);
	} catch (err: any) {
		if (
			err.stderr?.includes(
				"You cannot publish over the previously published versions",
			)
		) {
			console.log(
				`⚠️ ${pkg.name}@${opts.version} already published (npm registry). Skipping.`,
			);
		} else {
			throw err;
		}
	}
}
