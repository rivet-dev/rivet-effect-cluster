# Release the package. See scripts/release/main.ts for the phases.
[group('release')]
release *ARGS:
	pnpm exec tsx ./scripts/release/main.ts {{ ARGS }}
