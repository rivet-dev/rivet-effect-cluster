#!/usr/bin/env tsx

import * as path from "node:path";
import * as url from "node:url";
import { program } from "commander";
import { $ } from "execa";
import * as semver from "semver";
import {
	commitAndPush,
	configureVcs,
	createAndPushTag,
	createGitHubRelease,
	getCurrentBookmark,
	getCurrentRevision,
	validateGit,
} from "./git";
import { publishNpm } from "./npm";
import { updateVersion } from "./update_version";
import { assert, assertEquals } from "./utils";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
// The repository is a single npm package, released from the repository root.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export interface ReleaseOpts {
	/** Repository root. Git operations and the package resolve here. */
	repoRoot: string;
	version: string;
	latest: boolean;
	minorVersionChannel: string;
	/** Commit to publish release for. */
	commit: string;
}

async function getAllGitVersions(): Promise<string[]> {
	try {
		// Fetch tags to ensure we have the latest
		// Use --force to overwrite local tags that conflict with remote
		try {
			await $`git fetch --tags --force --quiet`;
		} catch (_fetchError) {
			console.warn(
				"Warning: Could not fetch remote tags, using local tags only",
			);
		}

		// Get all version tags
		const result = await $`git tag -l v*`;
		const tags = result.stdout.trim().split("\n").filter(Boolean);

		if (tags.length === 0) {
			return [];
		}

		// Parse and sort all versions (newest first)
		const versions = tags
			.map((tag) => tag.replace(/^v/, ""))
			.filter((v) => semver.valid(v))
			.sort((a, b) => semver.rcompare(a, b));

		return versions;
	} catch (error) {
		console.warn("Warning: Could not get git tags:", error);
		return [];
	}
}

async function getLatestGitVersion(): Promise<string | null> {
	const versions = await getAllGitVersions();

	if (versions.length === 0) {
		return null;
	}

	// Find the latest version (excluding prereleases)
	const stableVersions = versions.filter((v) => {
		const parsed = semver.parse(v);
		return parsed && parsed.prerelease.length === 0;
	});

	return stableVersions[0] || null;
}

async function shouldTagAsLatest(newVersion: string): Promise<boolean> {
	// Check if version has prerelease identifier
	const parsedVersion = semver.parse(newVersion);
	if (!parsedVersion) {
		throw new Error(`Invalid semantic version: ${newVersion}`);
	}

	// If it has a prerelease identifier, it's not latest
	if (parsedVersion.prerelease.length > 0) {
		return false;
	}

	// Get the latest version from git tags
	const latestGitVersion = await getLatestGitVersion();

	// If no previous versions exist, this is the latest
	if (!latestGitVersion) {
		return true;
	}

	// Check if new version is greater than the latest git version
	return semver.gt(newVersion, latestGitVersion);
}

/** Type-checks, lints, and builds the package. */
async function runChecks(opts: ReleaseOpts) {
	for (const script of ["check-types", "lint", "build"]) {
		console.log(`Running pnpm ${script}...`);
		try {
			await $({ stdio: "inherit", cwd: opts.repoRoot })`pnpm ${script}`;
			console.log(`✅ pnpm ${script} passed`);
		} catch (err) {
			console.error(`❌ pnpm ${script} failed`);
			throw err;
		}
	}
	console.log("✅ All checks passed");
}

async function getVersionFromArgs(opts: {
	version?: string;
	major?: boolean;
	minor?: boolean;
	patch?: boolean;
}): Promise<string> {
	// Check if explicit version is provided via --version flag
	if (opts.version) {
		return opts.version;
	}

	// Check for version bump flags
	if (!opts.major && !opts.minor && !opts.patch) {
		throw new Error(
			"Must provide either --version, --major, --minor, or --patch",
		);
	}

	// Get latest version from git tags and calculate new one
	const latestVersion = await getLatestGitVersion();
	if (!latestVersion) {
		throw new Error(
			"No existing version tags found. Use --version to set an explicit version.",
		);
	}
	console.log(`Latest git version: ${latestVersion}`);

	let newVersion: string | null = null;

	if (opts.major) {
		newVersion = semver.inc(latestVersion, "major");
	} else if (opts.minor) {
		newVersion = semver.inc(latestVersion, "minor");
	} else if (opts.patch) {
		newVersion = semver.inc(latestVersion, "patch");
	}

	if (!newVersion) {
		throw new Error("Failed to calculate new version");
	}

	return newVersion;
}

// Available steps
const STEPS = [
	"confirm-release",
	"update-version",
	"run-local-checks",
	"git-commit",
	"git-push",
	"trigger-workflow",
	"run-ci-checks",
	"publish-npm",
	"push-tag",
	"create-github-release",
] as const;

const PHASES = ["setup-local", "setup-ci", "complete-ci"] as const;

type Step = (typeof STEPS)[number];
type Phase = (typeof PHASES)[number];

// Map phases to individual steps
const PHASE_MAP: Record<Phase, Step[]> = {
	// These steps modify the source code, so they need to be ran & committed
	// locally. CI cannot push commits.
	//
	// run-local-checks type-checks, lints, and builds to fail fast before
	// committing/pushing.
	"setup-local": [
		"confirm-release",
		"update-version",
		"run-local-checks",
		"git-commit",
		"git-push",
		"trigger-workflow",
	],
	// These steps validate the repository before publishing.
	"setup-ci": ["run-ci-checks"],
	// These steps publish the package and record the release.
	"complete-ci": [
		"update-version",
		"publish-npm",
		"push-tag",
		"create-github-release",
	],
};

async function main() {
	if (await configureVcs(REPO_ROOT)) {
		const { stdout } = await $({ cwd: REPO_ROOT })`jj git root`;
		// Git metadata and gh must use this workspace's backing repository,
		// while revision and bookmark selection use jj explicitly.
		process.env.GIT_DIR = stdout.trim();
	}
	// Setup commander
	program
		.name("release")
		.description("Release a new version of @rivetkit/effect-cluster")
		.option("--major", "Bump major version")
		.option("--minor", "Bump minor version")
		.option("--patch", "Bump patch version")
		.option("--version <version>", "Set specific version")
		.option(
			"--override-commit <commit>",
			"Override the commit to pull artifacts from (defaults to current commit)",
		)
		.option("--latest", "Tag version as the latest version", true)
		.option("--no-latest", "Do not tag version as the latest version")
		.option("--no-validate-git", "Skip git validation (for testing)")
		.option(
			"--only-steps <steps>",
			`Run specific steps (comma-separated). Available: ${STEPS.join(", ")}`,
		)
		.option(
			"--phase <phase>",
			`Run a release phase (comma-separated). Available: ${PHASES.join(", ")}`,
		)
		.parse();

	const opts = program.opts();

	// Parse requested steps
	if (!opts.phase && !opts.onlySteps) {
		opts.phase = "setup-local";
	}

	if (opts.phase && opts.onlySteps) {
		throw new Error("Cannot use both --phase and --only-steps together");
	}

	const requestedSteps = new Set<Step>();
	if (opts.onlySteps) {
		const steps = opts.onlySteps.split(",").map((s: string) => s.trim());
		for (const step of steps) {
			if (!STEPS.includes(step as Step)) {
				throw new Error(
					`Invalid step: ${step}. Available steps: ${STEPS.join(", ")}`,
				);
			}
			requestedSteps.add(step as Step);
		}
	} else if (opts.phase) {
		const phases = opts.phase.split(",").map((s: string) => s.trim());
		for (const phase of phases) {
			if (!PHASES.includes(phase as Phase)) {
				throw new Error(
					`Invalid phase: ${phase}. Available phases: ${PHASES.join(", ")}`,
				);
			}
			const steps = PHASE_MAP[phase as Phase];
			for (const step of steps) {
				requestedSteps.add(step);
			}
		}
	}

	// Helper function to check if a step should run
	const shouldRunStep = (step: Step): boolean => {
		return requestedSteps.has(step);
	};

	// Get version from arguments or calculate based on flags
	const version = await getVersionFromArgs({
		version: opts.version,
		major: opts.major,
		minor: opts.minor,
		patch: opts.patch,
	});

	assert(
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(
			version,
		),
		"version must be a valid semantic version",
	);

	// Automatically determine if this should be tagged as latest
	// Can be overridden by --latest or --no-latest flags
	let isLatest: boolean;
	if (opts.latest !== undefined) {
		// User explicitly set the flag
		isLatest = opts.latest;
	} else {
		// Auto-determine based on version
		isLatest = await shouldTagAsLatest(version);
		console.log(
			`Auto-determined latest flag: ${isLatest} (version: ${version})`,
		);
	}

	const parsedVersion = semver.parse(version);
	assert(parsedVersion !== null, "version must be parseable");
	const minorVersionChannel = `${parsedVersion.major}.${parsedVersion.minor}.x`;

	// Setup opts
	let commit: string;
	if (opts.overrideCommit) {
		// Manually override commit
		commit = opts.overrideCommit;
	} else {
		// Read commit
		commit = await getCurrentRevision(REPO_ROOT);
	}

	const releaseOpts: ReleaseOpts = {
		repoRoot: REPO_ROOT,
		version: version,
		latest: isLatest,
		minorVersionChannel,
		commit,
	};

	if (releaseOpts.commit.length === 40) {
		releaseOpts.commit = releaseOpts.commit.slice(0, 7);
	}

	assertEquals(releaseOpts.commit.length, 7, "must use 7 char short commit");

	if (opts.validateGit && !shouldRunStep("run-ci-checks")) {
		// HACK: Skip setup-ci because for some reason there's changes in the setup step but only in GitHub Actions
		await validateGit(releaseOpts);
	}

	if (shouldRunStep("confirm-release")) {
		console.log("==> Release Confirmation");
		console.log(`\nRelease Details:`);
		console.log(`  Version: ${releaseOpts.version}`);
		console.log(`  Latest: ${releaseOpts.latest}`);
		console.log(`  Minor channel: ${releaseOpts.minorVersionChannel}`);
		console.log(`  Commit: ${releaseOpts.commit}`);

		// Get current branch
		const branch = await getCurrentBookmark(REPO_ROOT);
		console.log(`  Branch: ${branch}`);

		// Get and display recent versions
		const allVersions = await getAllGitVersions();

		if (allVersions.length > 0) {
			// Find the latest stable version (excluding prereleases)
			const stableVersions = allVersions.filter((v) => {
				const parsed = semver.parse(v);
				return parsed && parsed.prerelease.length === 0;
			});
			const latestStableVersion = stableVersions[0] || null;

			console.log(`\nRecent versions:`);
			const recentVersions = allVersions.slice(0, 10);
			for (const version of recentVersions) {
				const isLatest = version === latestStableVersion;
				const marker = isLatest ? " (latest)" : "";
				console.log(`  - ${version}${marker}`);
			}
		}

		// Prompt for confirmation
		const readline = await import("node:readline");
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		const answer = await new Promise<string>((resolve) => {
			rl.question("\nProceed with release? (yes/no): ", resolve);
		});
		rl.close();

		if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
			console.log("Release cancelled");
			process.exit(0);
		}

		console.log("✅ Release confirmed");
	}

	if (shouldRunStep("update-version")) {
		console.log("==> Updating Version");
		await updateVersion(releaseOpts);
	}

	if (shouldRunStep("run-local-checks")) {
		console.log("==> Running Local Checks");
		await runChecks(releaseOpts);
	}

	if (shouldRunStep("git-commit")) {
		assert(opts.validateGit, "cannot commit without git validation");
		console.log("==> Committing Changes");
		await commitAndPush(releaseOpts, false);
	}

	if (shouldRunStep("git-push")) {
		assert(opts.validateGit, "cannot push without git validation");
		console.log("==> Pushing Commits");
		await commitAndPush(releaseOpts, true);
	}

	if (shouldRunStep("trigger-workflow")) {
		console.log("==> Triggering Workflow");
		const branch = await getCurrentBookmark(REPO_ROOT);
		const latestFlag = releaseOpts.latest ? "true" : "false";

		// Build workflow command
		let workflowCmd = `gh workflow run .github/workflows/release.yaml -f version=${releaseOpts.version} -f latest=${latestFlag}`;
		workflowCmd += ` --ref ${branch}`;

		await $({ stdio: "inherit", shell: true })`${workflowCmd}`;

		// Get repository info and print workflow link
		const repoResult =
			await $`gh repo view --json nameWithOwner -q .nameWithOwner`;
		const repo = repoResult.stdout.trim();
		console.log(
			`\nWorkflow triggered: https://github.com/${repo}/actions/workflows/release.yaml`,
		);
		console.log(`View all runs: https://github.com/${repo}/actions`);
	}

	if (shouldRunStep("run-ci-checks")) {
		console.log("==> Running CI Checks");
		await runChecks(releaseOpts);
	}

	if (shouldRunStep("publish-npm")) {
		console.log("==> Publishing NPM Package");
		await publishNpm(releaseOpts);
	}

	if (shouldRunStep("push-tag")) {
		console.log("==> Pushing Tag");
		await createAndPushTag(releaseOpts);
	}

	if (shouldRunStep("create-github-release")) {
		console.log("==> Creating GitHub Release");
		await createGitHubRelease(releaseOpts);
	}

	console.log("==> Complete");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
