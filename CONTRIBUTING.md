# Contributing

Stellane is a DeepSeek Harness plugin for understanding PostgreSQL data and exploring alternative changes in independent database branches. Start with the [quick start](README.md), [runnable demos](examples/README.md) and [product decisions](PRODUCT.md).

## Run locally

Use Node.js 24.9+, pnpm 11.1.2 and DSH Web 0.2.2-rc.1–rc.3 (development dependencies use rc.3).

```sh
corepack pnpm install
corepack pnpm check
```

For real PostgreSQL integration tests, Docker is required:

```sh
corepack pnpm dev:db
corepack pnpm test:integration
corepack pnpm dev:db stop
```

The database helper manages only its labeled development resources. Use synthetic data; do not commit connection secrets, private queries or generated evidence containing user data.

Neon API contract tests do not require cloud credentials:

```sh
corepack pnpm test:neon
```

For real Neon development without cloud charges, use [the Docker setup](docs/local-neon.md). It runs actual open-source services with a Stellane local controller; contract checks, live local-provider checks and DSH chat demonstrations are separate evidence. Cloud API support is experimental and is not required to contribute or validate this preview.

Stello integration tests need a separate test instance and copied build artifacts. Never run the test fixture against someone else's active Stello deployment or build in a shared checkout. Setup and validation details are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Keep the demos useful

The [demo guide](examples/README.md) connects setup, ordinary chat prompts, deliberate data changes and expected outcomes. It is the first path for someone who does not have a suitable database. The [experiment walkthrough](docs/experiments.md) shows how to use one baseline for separate trial paths.

When adding a scenario:

- Use synthetic data and a replaceable schema. Do not put business-specific table names or repair rules into Core or the bundled Skill.
- Include setup SQL, the controlled change, each proposed variant and independently computed expected outputs. State which assumptions are supplied by the user and which relationships the Agent should discover.
- Explain the question and the benefit: what a plain answer could miss, what should be reused, or which changes need independent branches.
- For A/B comparisons, verify the shared starting state, the same metric definition, source preservation and variant isolation. Cover cleanup or retained dependencies as well as the successful query.
- Keep prompts free of answer spoilers. Expected-output files are for the person checking the demo; they should not be injected into the Agent's conversation as evidence.

Demonstrations and regressions serve different readers. A demo should be easy to follow in DSH, while a regression checks a specific contract without depending on the model producing exact prose. Document which checks used an actual Agent, a real database or a simulated provider API.

## Where changes belong

| Area | Location |
| --- | --- |
| Access checks, context, memory, metrics and experiment lifecycle | `src/core/` |
| PostgreSQL queries and provider-specific branch operations | `src/providers/` |
| Shared models, capabilities and Host/client API | `src/shared/` |
| Harness tools, embedded Skill and integration | `src/host/` |
| The inspection and management panel | `src/client/` |
| Regressions and real-database tests | `tests/` |
| Synthetic datasets, scenario prompts and expected outcomes | `examples/` |
| Branch workflow and provider guidance | `docs/experiments.md` |

Keep analysis, lineage and memory available on ordinary PostgreSQL. Make independent trial paths from a common baseline understandable and traceable. Gate branch operations by capabilities. Preserve provider-specific guarantees: a read-only Neon branch is not an immutable Stello snapshot. Unknown writes or branch creation must be reconciled against the original operation before any repeat action.

Use replaceable schemas and business examples in tests. A feature should work because of table structure, claims and evidence, rather than special handling of demonstration table names.

## Before opening a change

Describe the user problem, resulting behavior and validation. Include screenshots for interaction changes. Distinguish simulated API tests, actual PostgreSQL/local Neon/Stello runs and model-driven chat acceptance. Do not call a local controller the official Neon cloud API. Keep the English and Chinese quick starts aligned when the user path changes.

Run `corepack pnpm check` plus the integration tests relevant to the change. For release/distribution changes, run `corepack pnpm test:package`: it installs the built archive into a fresh directory with no source checkout. CI checks Node 24.9.0 and current 24.x on Ubuntu, plus a real PostgreSQL fixture and the archive. Keep maintenance/privacy guidance aligned with new persistence or deletion behavior. Do not claim an unrun provider test passed. If an API or database fails during a test, preserve enough evidence to explain the failure without publishing credentials.

Use the issue templates with a minimal synthetic reproduction. Read [SECURITY.md](SECURITY.md) before reporting a suspected vulnerability. Never post state databases, backup files, full chats or credentials publicly.
