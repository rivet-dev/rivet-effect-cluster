import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseOpts } from "./main";
import { assert } from "./utils";

/** Sets the version of the package at the repository root. */
export async function updateVersion(opts: ReleaseOpts) {
	const packageJsonPath = join(opts.repoRoot, "package.json");
	const content = await fs.readFile(packageJsonPath, "utf-8");

	const versionPattern = /"version": ".*"/;
	assert(versionPattern.test(content), "No version field in package.json");

	const updated = content.replace(
		versionPattern,
		`"version": "${opts.version}"`,
	);
	if (updated !== content) {
		await fs.writeFile(packageJsonPath, updated);
		console.log(`✅ package.json version set to ${opts.version}`);
	} else {
		console.log(`package.json is already at ${opts.version}`);
	}
}
