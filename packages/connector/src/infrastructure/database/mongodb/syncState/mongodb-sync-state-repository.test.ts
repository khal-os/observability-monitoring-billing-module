import { MongoDb } from '@observability/core/infrastructure/database/mongodb/mongo-db.js';
import {
  MongoDbSyncStateRepository,
  SYNC_STATE_COLLECTION,
} from './mongodb-sync-state-repository.js';
import { RecordingLogger } from '@observability/core/common/logging/logging-test-fakes.js';

describe('MongoDbSyncStateRepository (watermark, decision 78 guard)', () => {
  const repository = new MongoDbSyncStateRepository();

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  beforeEach(async () => {
    await MongoDb.getCollection(SYNC_STATE_COLLECTION).deleteMany({});
  });

  it('returns null on a fresh deployment', async () => {
    expect(await repository.getTraceCursor()).toBeNull();
  });

  it('creates the watermark on first set and reads it back', async () => {
    const cursor = {
      updatedAt: new Date('2026-07-01T10:00:00.000Z'),
      traceId: 'trace-001',
    };

    await repository.setTraceCursor(cursor);

    expect(await repository.getTraceCursor()).toEqual(cursor);
  });

  it('advances on a newer updatedAt', async () => {
    await repository.setTraceCursor({
      updatedAt: new Date('2026-07-01T10:00:00.000Z'),
      traceId: 'trace-001',
    });

    const newer = {
      updatedAt: new Date('2026-07-01T11:00:00.000Z'),
      traceId: 'trace-000',
    };
    await repository.setTraceCursor(newer);

    expect(await repository.getTraceCursor()).toEqual(newer);
  });

  it('advances on the traceId tiebreaker at the same updatedAt', async () => {
    const updatedAt = new Date('2026-07-01T10:00:00.000Z');
    await repository.setTraceCursor({ updatedAt, traceId: 'trace-001' });

    await repository.setTraceCursor({ updatedAt, traceId: 'trace-002' });

    expect(await repository.getTraceCursor()).toEqual({
      updatedAt,
      traceId: 'trace-002',
    });
  });

  it('is idempotent when re-setting the identical cursor', async () => {
    const cursor = {
      updatedAt: new Date('2026-07-01T10:00:00.000Z'),
      traceId: 'trace-001',
    };
    await repository.setTraceCursor(cursor);

    await repository.setTraceCursor(cursor);

    expect(await repository.getTraceCursor()).toEqual(cursor);
  });

  it('MUST NOT move the watermark backwards on an older updatedAt', async () => {
    const ahead = {
      updatedAt: new Date('2026-07-01T11:00:00.000Z'),
      traceId: 'trace-100',
    };
    await repository.setTraceCursor(ahead);

    await repository.setTraceCursor({
      updatedAt: new Date('2026-07-01T10:00:00.000Z'),
      traceId: 'trace-999',
    });

    expect(await repository.getTraceCursor()).toEqual(ahead);
  });

  it('MUST NOT move the watermark backwards on the traceId tiebreaker', async () => {
    const updatedAt = new Date('2026-07-01T10:00:00.000Z');
    const ahead = { updatedAt, traceId: 'trace-002' };
    await repository.setTraceCursor(ahead);

    await repository.setTraceCursor({ updatedAt, traceId: 'trace-001' });

    expect(await repository.getTraceCursor()).toEqual(ahead);
  });

  describe('ASCII collation guard (audit C-7.6)', () => {
    it('MUST warn ONCE on a non-ASCII trace id, still persisting the cursor', async () => {
      const logger = new RecordingLogger();
      const freshRepository = new MongoDbSyncStateRepository({ logger });

      const cursor = {
        updatedAt: new Date('2026-07-01T10:00:00.000Z'),
        traceId: 'traço-001',
      };

      await freshRepository.setTraceCursor(cursor);
      await freshRepository.setTraceCursor({
        updatedAt: new Date('2026-07-01T11:00:00.000Z'),
        traceId: 'traço-002',
      });

      // Safety property intact: the watermark advanced normally.
      expect(await freshRepository.getTraceCursor()).toEqual({
        updatedAt: new Date('2026-07-01T11:00:00.000Z'),
        traceId: 'traço-002',
      });
      // ... and the collation caveat was surfaced exactly once.
      expect(logger.at('warn')).toHaveLength(1);
      expect(logger.messages('warn')[0]).toContain('non-ASCII cursorTraceId');
    });

    it('MUST stay silent for ASCII trace ids', async () => {
      const logger = new RecordingLogger();
      const freshRepository = new MongoDbSyncStateRepository({ logger });

      await freshRepository.setTraceCursor({
        updatedAt: new Date('2026-07-01T10:00:00.000Z'),
        traceId: 'trace-001',
      });

      expect(logger.lines).toEqual([]);
    });
  });
});
