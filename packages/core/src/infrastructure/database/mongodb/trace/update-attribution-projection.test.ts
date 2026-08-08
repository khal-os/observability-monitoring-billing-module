import { MongoDb } from '../mongo-db.js';
import { runMigrations } from '../helpers/migration-runner.js';
import { migrations } from '../migrations/index.js';
import { MongoDbTraceRepository } from './mongodb-trace-repository.js';
import { TRACES_COLLECTION } from '../collections.js';
import { makeContractTrace } from '../../../../application/interfaces/trace-repository.contract.js';

/**
 * audit F-2: the re-sync attribution refresh must (a) project the reads —
 * never pull the embedded transcript/spans — and (b) issue ZERO update
 * commands when nothing changed. The old code read the whole document
 * twice and rewrote `unclassified` unconditionally, so a 1M-trace backfill
 * churned ~6.8GB of cache and 1M pointless writes. monitorCommands is the
 * only way to prove both from outside.
 */
describe('updateAttribution projection + no-op guard (audit F-2)', () => {
  const started: { commandName: string; command: Record<string, unknown> }[] =
    [];

  beforeAll(async () => {
    // Monitor the client that ACTUALLY issues the ops (a separate
    // connection would never see them). MONGO_URL enables monitorCommands
    // via connectWithUri's dedicated test flag.
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string, {
      monitorCommands: true,
    });
    MongoDb.getClient().on('commandStarted', (event) => {
      if (['find', 'update'].includes(event.commandName)) {
        started.push({
          commandName: event.commandName,
          command: event.command as Record<string, unknown>,
        });
      }
    });
    await runMigrations(MongoDb.getClient().db(), migrations);
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    started.length = 0;
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  it('MUST project both reads (no transcript/spans) and issue ZERO updates when attribution is unchanged', async () => {
    const repository = new MongoDbTraceRepository();
    await repository.insertIfAbsent(makeContractTrace({ traceId: 'f2-trace' }));
    started.length = 0;

    // Re-sync with the SAME attribution the trace already carries.
    await repository.updateAttribution('f2-trace', {
      agent: {
        id: 'agent-atendimento',
        version: '1.4.2',
        instance: 'agent-atendimento-7d9f4b-k2xp8',
      },
      domain: 'varejo',
    });

    const finds = started.filter((e) => e.commandName === 'find');
    const updates = started.filter((e) => e.commandName === 'update');

    // Both callback reads carry the projection — the payload never rides.
    const projectedTraceFinds = finds.filter(
      (e) =>
        (e.command['filter'] as Record<string, unknown>)?.['traceId'] ===
        'f2-trace',
    );
    expect(projectedTraceFinds.length).toBeGreaterThanOrEqual(1);
    for (const find of projectedTraceFinds) {
      const projection = find.command['projection'] as Record<string, number>;
      expect(projection).toBeDefined();
      expect(projection['input']).toBeUndefined();
      expect(projection['spans']).toBeUndefined();
    }

    // Nothing changed → no write.
    const traceUpdates = updates.filter((e) =>
      JSON.stringify(e.command).includes('f2-trace'),
    );
    expect(traceUpdates).toHaveLength(0);
  });
});
