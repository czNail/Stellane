import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { StellaneCore } from '../src/core/index.ts';
import { NeonProvider } from '../src/providers/neon.ts';
import { encodeResource, StelloProvider } from '../src/providers/stello.ts';
import type { Actor, BranchRemoval, Cell, Environment, Run } from '../src/shared/models.ts';
import type { NeonRemoval } from '../src/shared/neon-models.ts';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const datasetName = 'telemetry';
const { values, positionals } = parseArgs({ options: {
  stello: { type: 'string' }, neon: { type: 'string' }, dataset: { type: 'string', default: datasetName },
  'state-dir': { type: 'string' }, help: { type: 'boolean' },
}, allowPositionals: true });
const command = positionals[0] ?? 'run';
if (values.help) {
  console.log(`Usage:
  pnpm demo:branches --stello /absolute/provider.json
  pnpm demo:branches --neon /absolute/source.json
  pnpm demo:branches status --state-dir /absolute/run-directory
  pnpm demo:branches reconcile --state-dir /absolute/run-directory
  pnpm demo:branches cleanup --state-dir /absolute/run-directory

Use a dedicated source loaded with the telemetry setup.sql and drift.sql first.
The run creates one shared baseline and two independent experiments; source data stays read-only.
Results are retained until cleanup. Neon resources may incur charges.
This deterministic check uses Stellane Core; it is not a model conversation.`);
  process.exit(0);
}
if (!['run', 'status', 'reconcile', 'cleanup'].includes(command) || positionals.length > 1) throw new Error('Unknown command. Use --help.');

type Rows = Record<string, Cell>[];
interface Manifest {
  name: string; schema: string; metricSql: string; fingerprintSql: string;
  expected: { baseline: Rows; drift: Rows; variantA: Rows; variantB: Rows };
}
interface Variant {
  name: 'A' | 'B'; experimentId: string; baselineId: string; workId: string;
  resultId?: string; evidenceRunId?: string; rows?: Rows; retentionNote?: string;
  capacityRows?: Rows; capacityRunId?: string; fingerprintRunId?: string;
}
interface Report {
  version: 1; kind: 'deterministic-core-branch-demo'; dataset: string; provider: 'stello' | 'neon';
  stateDirectory: string; startedAt: string; status: 'running' | 'passed' | 'failed-needs-review' | 'reviewed' | 'cleaning' | 'cleaned';
  sourceId?: string; baselineId?: string; baselineRunId?: string; sourceBeforeRunId?: string; sourceAfterRunId?: string;
  baselineRows?: Rows; variants: Variant[]; checks: string[]; failure?: string; finishedAt?: string;
  failures?: { stage: string; at: string; message: string }[];
  recovery?: { reason: string; startedAt: string; finishedAt?: string; originalFailedWriteId?: string; newWriteRunId?: string; unchangedBeforeWriteRunId?: string };
  unresolved?: { kind: string; id: string; status: string; error?: string }[];
  observations?: Record<string, { environment: Environment; observedAt: string }>;
  reconciliation?: { at: string; unresolved: NonNullable<Report['unresolved']> }[];
  cleaned: string[]; removals: Record<string, BranchRemoval | NeonRemoval>;
}
const owner: Actor = { kind: 'user', id: 'owner' };

async function save(directory: string, report: Report) {
  const temporary = join(directory, 'report.json.tmp');
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, join(directory, 'report.json'));
}
async function readReport(directory: string): Promise<Report> {
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as Report;
  if (report.kind !== 'deterministic-core-branch-demo' || report.version !== 1 || report.stateDirectory !== directory) {
    throw new Error('This is not the original branch demo directory.');
  }
  return report;
}
function printReport(report: Report) {
  console.log(JSON.stringify({ status: report.status, provider: report.provider, dataset: report.dataset,
    baseline: report.baselineRows, variants: report.variants.map(({ name, rows, capacityRows, retentionNote }) => ({ name, rows, capacityRows, retentionNote })),
    checks: report.checks, failure: report.failure, failures: report.failures, recovery: report.recovery,
    unresolved: report.unresolved, stateDirectory: report.stateDirectory }, null, 2));
}
async function lock(directory: string) {
  const filename = join(directory, 'runner.lock');
  const handle = await open(filename, 'wx', 0o600).catch(() => { throw new Error('A run or cleanup already owns this directory. Inspect runner.lock before recovery.'); });
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
  return async () => { await handle.close(); await unlink(filename); };
}
async function query(core: StellaneCore, environmentId: string, sql: string, actor = owner): Promise<Run> {
  const run = await core.query({ environmentId, sql }, actor);
  assert.equal(run.status, 'succeeded', run.error);
  assert(run.preview && !run.preview.truncated, 'Evidence must be complete.');
  return run;
}
function originalRemoval(directory: string, environment: Environment): BranchRemoval | NeonRemoval | undefined {
  const database = new DatabaseSync(join(directory, 'core', 'state.sqlite'), { readOnly: true });
  try {
    const table = environment.neon ? 'neonRemovals' : 'removals';
    const row = database.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(environment.id);
    if (!row) return undefined;
    const removal = JSON.parse(row.body as string) as BranchRemoval | NeonRemoval;
    return 'kind' in removal && removal.kind === 'compute' ? undefined : removal;
  } finally { database.close(); }
}

async function runDemo() {
  if (!!values.stello === !!values.neon) throw new Error('Choose exactly one --stello or --neon configuration.');
  if (values.dataset !== datasetName) throw new Error('The branch demo dataset is telemetry.');
  const datasetDirectory = join(repository, 'examples', 'datasets', datasetName);
  const manifest = JSON.parse(await readFile(join(datasetDirectory, 'manifest.json'), 'utf8')) as Manifest;
  const configuration = JSON.parse(await readFile(resolve(values.stello ?? values.neon!), 'utf8'));
  const staging = join(repository, '.stellane-dev');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const directory = values['state-dir'] ? resolve(values['state-dir']) : await mkdtemp(join(staging, 'branch-demo-'));
  if (values['state-dir']) await mkdir(directory, { mode: 0o700 }); // Existing state is never reused as a new run.
  const release = await lock(directory);
  const report: Report = { version: 1, kind: 'deterministic-core-branch-demo', dataset: datasetName,
    provider: values.stello ? 'stello' : 'neon', stateDirectory: directory, startedAt: new Date().toISOString(),
    status: 'running', variants: [], checks: [], cleaned: [], removals: {} };
  await save(directory, report);
  const core = new StellaneCore(join(directory, 'core'));
  try {
    const source = values.stello ? await core.saveStello(configuration) : await core.saveNeon(configuration);
    report.sourceId = source.id;
    await save(directory, report);
    const original = await query(core, source.id, manifest.fingerprintSql);
    report.sourceBeforeRunId = original.id;
    const initial = await query(core, source.id, manifest.metricSql);
    assert.deepEqual(initial.preview!.rows, manifest.expected.drift,
      'Source does not match the synthetic drift scenario. Load setup.sql and drift.sql into a dedicated source first.');
    report.checks.push('Source matches the published drift-scenario totals before branching');

    const baseline = await core.derive('checkpoint', { environmentId: source.id, name: `${datasetName} shared baseline` },
      { ...owner, callId: `shared-baseline-${randomUUID()}` });
    report.baselineId = baseline.id;
    await save(directory, report);
    const baselineRun = await query(core, baseline.id, manifest.metricSql);
    assert.deepEqual(baselineRun.preview!.rows, manifest.expected.drift);
    assert.deepEqual((await query(core, baseline.id, manifest.fingerprintSql)).preview!.rows, original.preview!.rows);
    report.baselineRunId = baselineRun.id;
    report.baselineRows = baselineRun.preview!.rows;
    report.checks.push('One baseline is captured before either variant runs');
    await save(directory, report);

    const actors = new Map<string, Actor>();
    for (const name of ['A', 'B'] as const) {
      const actor: Actor = { kind: 'agent', id: `demo-${name}-${randomUUID()}`, projectPath: source.projectPath, callId: `start-${name}` };
      const detail = await core.startConversationExperiment({ environmentId: baseline.id, name: `${datasetName} path ${name}` }, actor);
      if (detail.experiment.status !== 'active' || !detail.work) throw new Error(detail.experiment.error ?? 'Experiment preparation did not finish.');
      assert.equal(detail.baseline?.id, baseline.id);
      report.variants.push({ name, experimentId: detail.experiment.id, baselineId: baseline.id, workId: detail.work.id });
      actors.set(name, actor);
      await save(directory, report);
    }
    const [a, b] = report.variants;
    assert(a && b && a.workId !== b.workId);
    await assert.rejects(core.query({ environmentId: b.workId, sql: 'SELECT 1' }, actors.get('A')!), /无权/);
    await assert.rejects(core.query({ environmentId: a.workId, sql: 'SELECT 1' }, actors.get('B')!), /无权/);
    report.checks.push('A and B use the same baseline ID, different work branches and separate session access');
    for (const variant of report.variants) {
      const actor = actors.get(variant.name)!;
      const sql = await readFile(join(datasetDirectory, `variant-${variant.name.toLowerCase()}.sql`), 'utf8');
      const write = await core.write({ environmentId: variant.workId, sql }, { ...actor, callId: `change-${variant.name}` });
      assert.equal(write.status, 'succeeded', write.error);
      if (variant.name === 'A') {
        const untouchedB = await query(core, b.workId, manifest.metricSql, actors.get('B'));
        assert.deepEqual(untouchedB.preview!.rows, manifest.expected.drift, 'A must not change B.');
        assert.deepEqual((await query(core, b.workId, manifest.fingerprintSql, actors.get('B'))).preview!.rows, original.preview!.rows);
        report.checks.push('Changing A leaves the not-yet-modified B at the shared baseline');
      }
      const result = await core.captureExperiment({ id: variant.experimentId, summary: `Synthetic path ${variant.name}; compare assumptions before choosing.`,
        sql: manifest.metricSql }, undefined, actor);
      if (!result.delivered || !result.result) throw new Error(result.experiment.error ?? 'Evidence delivery did not finish.');
      variant.resultId = result.result.id;
      variant.evidenceRunId = result.delivered.run.id;
      variant.rows = result.delivered.run.preview?.rows;
      await save(directory, report);
      assert.deepEqual(variant.rows, variant.name === 'A' ? manifest.expected.variantA : manifest.expected.variantB);
      variant.fingerprintRunId = (await query(core, result.result.id, manifest.fingerprintSql)).id;
      const finished = await core.finishExperiment(variant.experimentId, undefined, actor);
      assert.equal(finished.experiment.status, 'closed', finished.experiment.error);
      variant.retentionNote = finished.experiment.retentionNote;
      await save(directory, report);
    }
    const aAgain = await query(core, a.resultId!, manifest.metricSql);
    assert.deepEqual(aAgain.preview!.rows, manifest.expected.variantA, 'Changing B must not change the saved A result.');
    assert.deepEqual((await query(core, a.resultId!, manifest.fingerprintSql)).preview!.rows, core.evidence(a.fingerprintRunId!).preview!.rows);
    const after = await query(core, source.id, manifest.fingerprintSql);
    assert.deepEqual(after.preview!.rows, original.preview!.rows, 'The source dataset must remain unchanged.');
    report.sourceAfterRunId = after.id;
    report.checks.push('Both result branches match the independent expected results using identical evidence SQL',
      'The saved A result remains unchanged after B runs', 'The complete source dataset fingerprint is unchanged',
      'Experiment work access is closed; results and shared baseline are retained until explicit cleanup');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed-needs-review';
    report.failure = error instanceof Error ? error.message : 'Run did not complete.';
    report.failures = [{ stage: 'run', at: new Date().toISOString(), message: report.failure }];
    const snapshot = core.snapshot();
    report.unresolved = [
      ...snapshot.experiments.filter(item => item.status !== 'closed').map(item => ({ kind: 'experiment', id: item.id, status: item.status, error: item.error })),
      ...snapshot.operations.filter(item => item.status !== 'succeeded').map(item => ({ kind: 'branch', id: item.id, status: item.status, error: item.error })),
      ...snapshot.runs.filter(item => item.status === 'unknown').map(item => ({ kind: 'write', id: item.id, status: item.status, error: item.error })),
    ];
    process.exitCode = 1;
    console.error('Run stopped. Original operations and evidence are retained; inspect this state before another run.');
  } finally {
    await core.close();
    report.finishedAt = new Date().toISOString();
    await save(directory, report);
    await release();
    printReport(report);
    console.log(`Report: ${join(directory, 'report.json')}`);
  }
}

async function reconcile(directory: string, report: Report) {
  if (['cleaned', 'cleaning', 'passed'].includes(report.status)) { printReport(report); return; }
  const release = await lock(directory);
  const core = new StellaneCore(join(directory, 'core'));
  const unresolved: NonNullable<Report['unresolved']> = [];
  try {
    report.observations ??= {};
    const snapshot = core.snapshot();
    for (const operation of snapshot.operations.filter(item => ['unknown', 'pending'].includes(item.status))) {
      try {
        const binding = operation.providerKind === 'neon'
          ? await new NeonProvider().reconcile(snapshot.neonSources!.find(item => item.id === operation.providerId)!, operation, new AbortController().signal)
          : await new StelloProvider().reconcile(snapshot.providers.find(item => item.id === operation.providerId)!, operation, new AbortController().signal);
        if (!binding) throw new Error('The original branch is still incomplete.');
        const environment: Environment = { ...operation.environment, ...('branchId' in binding ? { neon: binding } : { stello: binding }) };
        report.observations[operation.id] = { environment, observedAt: new Date().toISOString() };
        await save(directory, report);
      } catch (error) {
        delete report.observations[operation.id];
        unresolved.push({ kind: 'branch', id: operation.id, status: operation.status,
          error: error instanceof Error ? error.message : 'Observation failed.' });
      }
    }
    for (const run of snapshot.runs.filter(item => item.status === 'unknown')) {
      try {
        const checked = await core.reconcileRun(run.id, owner);
        if (checked.status === 'unknown') unresolved.push({ kind: 'write', id: checked.id, status: checked.status, error: checked.error });
      } catch (error) {
        unresolved.push({ kind: 'write', id: run.id, status: run.status, error: error instanceof Error ? error.message : 'Receipt check failed.' });
      }
    }
    report.unresolved = unresolved;
    report.reconciliation ??= [];
    report.reconciliation.push({ at: new Date().toISOString(), unresolved });
    report.status = unresolved.length ? 'failed-needs-review' : 'reviewed';
    if (unresolved.length) process.exitCode = 1;
    console.log(unresolved.length ? 'Original outcomes remain unknown; no SQL or branch creation was replayed.'
      : 'Original outcomes are known. The demo is still incomplete; explicit cleanup is now available.');
  } finally { await core.close(); await save(directory, report); await release(); printReport(report); }
}

async function cleanup(directory: string, report: Report) {
  if (!['passed', 'reviewed', 'cleaning', 'cleaned'].includes(report.status)) {
    throw new Error('Run reconcile --state-dir with this directory first. Unknown outcomes cannot be cleaned up automatically.');
  }
  if (report.status === 'cleaned') { printReport(report); return; }
  const release = await lock(directory);
  const core = new StellaneCore(join(directory, 'core'));
  report.failures ??= report.failure ? [{ stage: 'run', at: report.finishedAt ?? report.startedAt, message: report.failure }] : [];
  try {
    const snapshot = core.snapshot();
    if (snapshot.operations.some(operation => ['pending', 'unknown'].includes(operation.status) && !report.observations?.[operation.id])
      || snapshot.runs.some(run => run.status === 'unknown')) throw new Error('Unresolved operations remain; inspect the original state.');
    report.status = 'cleaning';
    await save(directory, report);
    if (!report.sourceId) {
      assert.equal(snapshot.operations.length, 0, 'No recorded source exists for these operations.');
      report.status = 'cleaned';
      return;
    }
    const source = core.environment(report.sourceId);
    const provider = source.neon ? snapshot.neonSources?.find(item => item.id === source.neon!.providerId)
      : snapshot.providers.find(item => item.id === source.stello?.providerId);
    assert(provider, 'Original provider is unavailable.');
    const resources = new Map<string, Environment>();
    for (const operation of snapshot.operations) {
      const environment = operation.status === 'succeeded' ? core.environment(operation.environment.id)
        : report.observations?.[operation.id]?.environment;
      if (!environment) continue;
      assert.equal(environment.id, operation.environment.id);
      assert.equal(environment.parentEnvironmentId, operation.parentEnvironmentId);
      assert.equal(environment.projectPath, source.projectPath);
      resources.set(environment.id, environment);
    }
    const depth = (environment: Environment) => {
      let parent = environment.parentEnvironmentId;
      for (let distance = 1; distance <= 16 && parent; distance++) {
        if (parent === source.id) return distance;
        parent = resources.get(parent)?.parentEnvironmentId;
      }
      throw new Error('A recorded branch is not a descendant of this demo source.');
    };
    const ordered = [...resources.values()].map(environment => ({ environment, depth: depth(environment) }))
      .sort((left, right) => right.depth - left.depth);
    for (const { environment } of ordered) {
      const id = environment.id;
      if (report.cleaned.includes(id)) continue;
      assert.notEqual(id, source.id);
      assert(environment.parentEnvironmentId, 'The source cannot be cleaned up.');
      // Providers require synchronous durable intent before a DELETE. Write the
      // JSON synchronously in the callback; the regular report uses atomic rename.
      const persist = (removal: BranchRemoval | NeonRemoval) => {
        report.removals[id] = removal;
        writeFileSync(join(directory, 'report.json.tmp'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        renameSync(join(directory, 'report.json.tmp'), join(directory, 'report.json'));
      };
      // finishExperiment may have persisted a DELETE before a lost response.
      // Reuse that exact intent, including for a branch already absent remotely.
      const inherited = originalRemoval(directory, environment);
      if (inherited) {
        const recorded = report.removals[id];
        if (recorded && 'kind' in inherited) {
          assert('kind' in recorded, 'Conflicting removal providers.');
          for (const key of ['id', 'kind', 'projectId', 'branchId', 'endpointId'] as const) {
            assert.equal(recorded[key], inherited[key], 'Conflicting removal identities.');
          }
          if (inherited.operationIds?.length) assert.deepEqual(recorded.operationIds, inherited.operationIds, 'Conflicting removal operations.');
        } else if (recorded) assert.deepEqual(recorded, inherited, 'Conflicting removal identities.');
        else persist(inherited);
      }
      if (environment.neon && 'apiKeyRef' in provider) {
        assert(environment.neon.managed && environment.neon.providerId === provider.id);
        await new NeonProvider().remove(provider, environment.neon, id, report.removals[id] as NeonRemoval | undefined,
          persist, new AbortController().signal, 'branch');
      } else if (environment.stello && 'configPath' in provider) {
        assert(environment.stello.managed && environment.stello.providerId === provider.id);
        const removal = report.removals[id] as BranchRemoval | undefined;
        if (removal) {
          assert.equal(removal.id, id);
          assert.equal(removal.name, encodeResource(environment.stello.resource));
          assert.deepEqual(removal.identity, environment.stello.identity);
        }
        if (!environment.removedAt) await new StelloProvider().remove(provider, environment.stello, id,
          removal, persist, new AbortController().signal);
      } else throw new Error('Provider identity does not match the recorded environment.');
      report.cleaned.push(id);
      await save(directory, report);
    }
    report.status = 'cleaned';
    delete report.failure;
    report.checks.push('Explicit cleanup removed only this demo’s recorded branches; local evidence is retained');
  } catch (error) {
    report.failure = error instanceof Error ? error.message : 'Cleanup did not complete.';
    report.failures.push({ stage: 'cleanup', at: new Date().toISOString(), message: report.failure });
    process.exitCode = 1;
    console.error('Cleanup paused. Run the same cleanup command to reconcile the saved removal intents.');
  } finally { await core.close(); await save(directory, report); await release(); printReport(report); }
}

if (command === 'run') await runDemo();
else {
  if (!values['state-dir']) throw new Error('Use --state-dir with the original reported directory.');
  const directory = resolve(values['state-dir']);
  const report = await readReport(directory);
  if (command === 'status') printReport(report);
  else if (command === 'reconcile') await reconcile(directory, report);
  else await cleanup(directory, report);
}
