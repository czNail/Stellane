# Contributing

Stellane is a DeepSeek Harness plugin for understanding PostgreSQL data and exploring alternative changes in independent database branches. Start with the [quick start](README.md), [runnable demos](examples/README.md) and [product decisions](PRODUCT.md).

## Run locally

Use Node.js 24.9+, pnpm 11.1.2 and DSH 0.2.2-rc.1.

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

For an opt-in cloud run, prepare a dedicated Neon test source JSON and run `STELLANE_NEON_CONFIG=/absolute/path/to/neon-test.json corepack pnpm test:neon:live`. Without the variable, the test explicitly skips. It creates billable test branches, preserves state on failure, and removes its exact resources after a successful run. See the test-source format and recovery instructions in [DEVELOPMENT.md](DEVELOPMENT.md).

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

Describe the user problem, resulting behavior and validation. Include screenshots for interaction changes. Distinguish simulated API tests, real PostgreSQL tests and cloud-account validation. Keep the English and Chinese quick starts aligned when the user path changes.

Run `corepack pnpm check` plus the integration tests relevant to the change. Do not claim an unrun provider test passed. If an API or database fails during a test, preserve enough evidence to explain the failure without publishing credentials.
