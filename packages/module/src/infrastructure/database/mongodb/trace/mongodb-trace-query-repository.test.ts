import { MongoDb } from '../mongo-db.js';
import {
  MongoDbTraceQueryRepository,
  TOTAL_CAP,
} from './mongodb-trace-query-repository.js';
import { TRACES_COLLECTION } from '../collections.js';
import { MAX_PAGINATION_SKIP } from '../../../../domain/models/pagination.js';

/**
 * ONE horizon for counting and for navigating (decisions 77/79): the list
 * may not advertise pages the depth guard refuses to serve.
 *
 * The unfiltered branch used to escape the cap — it counts collection
 * metadata, which is cheap, so `totalCapped` was hardcoded false there. On
 * a real archive (invariant 6: it grows past 10.000 by design) that made
 * GET /traces answer `total_pages: 2500` with NO "+" while every page past
 * 500 answered 400, and the UI's "Próxima" turned that into a false
 * "A API do cliente está no ar?".
 */
describe('MongoDbTraceQueryRepository — capped counting horizon', () => {
  const repository = new MongoDbTraceQueryRepository();
  const OVER_CAP = TOTAL_CAP + 1;

  const wipe = (): Promise<unknown> =>
    MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
    await wipe();

    // Minimal documents: this suite is about counting, not projection.
    const traces = MongoDb.getCollection(TRACES_COLLECTION);
    const CHUNK = 2_000;

    for (let start = 0; start < OVER_CAP; start += CHUNK) {
      await traces.insertMany(
        Array.from({ length: Math.min(CHUNK, OVER_CAP - start) }, (_, i) => ({
          traceId: `cap-${start + i}`,
          startedAt: new Date(Date.UTC(2026, 6, 1) + (start + i) * 1000),
        })),
      );
    }
  });

  afterAll(async () => {
    // Suites share ONE database (--runInBand): leaving 10.001 traces behind
    // would silently poison every later trace/session/billing assertion.
    await wipe();
    await MongoDb.disconnect();
  });

  it('MUST cap the UNFILTERED total at the horizon the depth guard serves', async () => {
    const page = await repository.findTraces({}, { page: 1, pageSize: 20 });

    expect(page.total).toBe(TOTAL_CAP);
    expect(page.totalCapped).toBe(true);
  });

  it('MUST never advertise a page whose skip the depth guard would reject', async () => {
    // exceedsPaginationDepth: (page - 1) * page_size >= MAX_PAGINATION_SKIP.
    for (const pageSize of [1, 20, 50, 100]) {
      const page = await repository.findTraces({}, { page: 1, pageSize });
      const lastAdvertisedPage = Math.ceil(page.total / page.pageSize);

      expect((lastAdvertisedPage - 1) * pageSize).toBeLessThan(
        MAX_PAGINATION_SKIP,
      );
    }
  });

  it('MUST still report a FILTERED total exactly when it fits under the cap', async () => {
    const page = await repository.findTraces(
      { search: 'cap-7' },
      { page: 1, pageSize: 20 },
    );

    expect(page.total).toBe(1);
    expect(page.totalCapped).toBe(false);
  });
});
