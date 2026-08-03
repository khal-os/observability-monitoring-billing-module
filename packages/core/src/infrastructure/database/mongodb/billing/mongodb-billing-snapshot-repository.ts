import { ClientSession } from 'mongodb';
import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../../../domain/models/billing-snapshot-model.js';
import { BillingPeriodAuditEntry } from '../../../../domain/models/billing-period-model.js';
import { BillingPeriodStateError } from '../../../../domain/useCases/close-billing-period-use-case.js';
import { BillingSnapshotRepository } from '../../../../application/interfaces/billing-snapshot-repository.js';
import { MongoDb } from '../mongo-db.js';
import { isDuplicateKeyError } from '../helpers/is-duplicate-key-error.js';
import { applyMarkClosed } from './mongodb-billing-period-repository.js';

export const BILLING_SNAPSHOTS_COLLECTION = 'billing_snapshots';
export const BILLING_SNAPSHOT_USAGE_COLLECTION = 'billing_snapshot_usage';

/**
 * Bounded batch for the usage-row write (re-audit): one insertMany per
 * chunk, ~0.5 KB per record → ~0.5 MB per command, far below the 16MB
 * command ceiling. The month's record count is unbounded (one per stamped
 * trace), so the write MUST be chunked — see the two-phase note on
 * insertWithPeriodClose.
 */
const USAGE_WRITE_CHUNK_SIZE = 1_000;

/**
 * MongoDB 388 — TransactionTooLargeForCache ("transaction is too large and
 * will not fit in the storage engine cache"). It carries NO
 * TransientTransactionError label, so withTransaction never retries it,
 * and it is deterministic, so every retry of the close would fail
 * identically. The two-phase write below keeps the close transaction at
 * two documents, but the mapping stays so the runbook prints a clean,
 * actionable message instead of a raw driver stack if it ever fires.
 */
const isTransactionTooLargeError = (error: unknown): boolean =>
  (error as { code?: number } | null)?.code === 388;

/** Twin of the trace repository's chunker — same 16MB-safe discipline. */
const chunksOf = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

/** Natural key of a snapshot — also the usage records' parent reference. */
const snapshotKey = (year: number, month: number, version: number): string =>
  `${year}-${String(month).padStart(2, '0')}-v${version}`;

/**
 * Staging key of ONE close attempt's usage rows: the snapshot key plus the
 * attempt's write token. Attempt-scoped and not merely version-scoped
 * because two concurrent closes of a never-closed month compute the SAME
 * version — sharing a key would let one attempt's deletes/inserts mix into
 * the other's rows under the winner's header. `#` (0x23) sorts before `$`
 * (0x24), which gives the sweep a clean prefix range over the indexed
 * `snapshotKey` field.
 */
const usageStagingKey = (key: string, writeToken: string): string =>
  `${key}#${writeToken}`;

const toSnapshotModel = <T>(
  document: T & { _id?: unknown; usageWriteToken?: string },
): BillingSnapshotModel => {
  // `usageWriteToken` is persistence-only (the header's pointer at the
  // staging area it published) — it never crosses into the domain model.
  const { _id, usageWriteToken, ...rest } = document;

  return rest as unknown as BillingSnapshotModel;
};

/** Transaction-internal sentinel: aborts the close txn on a lost race. */
class PeriodFlipConflict extends Error {
  constructor() {
    super('billing period flip lost the close race');
    this.name = 'PeriodFlipConflict';
  }
}

export class MongoDbBillingSnapshotRepository implements BillingSnapshotRepository {
  private readonly usageWriteChunkSize: number;

  constructor(
    // Parameterized (default: the bounded constant) so the chunking logic
    // itself is testable with a tiny size — same seam as the trace
    // repository's reconcileQuarantineAfterClose chunkSize.
    usageWriteChunkSize: number = USAGE_WRITE_CHUNK_SIZE,
  ) {
    this.usageWriteChunkSize = usageWriteChunkSize;
  }

  async insert(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
  ): Promise<void> {
    // Storage-only op (tests/tooling) — the close flow uses
    // insertWithPeriodClose. Same two-phase shape: staged usage rows
    // FIRST, header LAST, because the header is the commit mark.
    const key = snapshotKey(snapshot.year, snapshot.month, snapshot.version);
    const writeToken = MongoDb.generateUUID();
    const stagingKey = usageStagingKey(key, writeToken);

    await this.stageUsagePage(stagingKey, usageRecords);

    try {
      await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION).insertOne({
        ...snapshot,
        usageWriteToken: writeToken,
      });
    } catch (error) {
      // Same rule as the close (re-audit iteration 3): no header, no
      // reason for the rows to exist — and no later sweep would reach
      // them once the next write computes a different version.
      await this.discardStaging(stagingKey);

      throw error;
    }

    await this.sweepSupersededStaging(key, writeToken);
  }

  /**
   * The single-page form of insertWithPeriodCloseStaged: the caller
   * already holds the month's records. Storage-only ops and small months
   * use it; the close (T6) uses the staged form, which never materializes
   * the month.
   */
  async insertWithPeriodClose(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
    close: { closedAt: Date; audit: BillingPeriodAuditEntry },
  ): Promise<'closed' | 'conflict'> {
    return this.insertWithPeriodCloseStaged(
      {
        year: snapshot.year,
        month: snapshot.month,
        version: snapshot.version,
      },
      async (stage) => {
        await stage(usageRecords);

        return snapshot;
      },
      close,
    );
  }

  /**
   * audit B-2 / re-audit: THE close write, in TWO phases.
   *
   * Phase 1 stages the month's usage rows OUTSIDE any transaction, in
   * bounded batches, under a key private to this attempt. Phase 2 commits
   * the header + the period flip in ONE small transaction (two documents).
   *
   * The whole write used to ride a single transaction, which made the
   * close UNREACHABLE at real volume: the usage set is one document per
   * stamped trace and unbounded, so `insertMany` aborted with
   * TransactionTooLargeForCache (388) — unlabelled, therefore never
   * retried, and deterministic, therefore fatal for every retry.
   *
   * re-audit iteration 3: bounding the TRANSACTION left the PROCESS
   * unbounded — the caller still had to hand over the whole month as one
   * array. Phase 1 is therefore driven by the caller through `stage`: it
   * pushes one page at a time and returns the finished header, so nothing
   * bigger than a page is ever resident on either side of the port.
   *
   * Atomicity is preserved where it is actually load-bearing, because the
   * HEADER is the commit mark and it names the staging area it published:
   * - a reader can never observe an incomplete snapshot — staged rows are
   *   unreachable until a header points at them (findUsageRecords /
   *   findUsageTraceIds resolve the key THROUGH the header), and the
   *   header only exists once the committed transaction also flipped the
   *   period;
   * - a crash in phase 1, between the phases, or inside the phase-2
   *   transaction leaves NO header and NO flip: the retry recomputes the
   *   same version, stages a fresh area and commits;
   * - a concurrent double close stages into two distinct areas and is
   *   decided by the unique (year, month, version) header index plus the
   *   guarded period flip — exactly one winner, whose header names only
   *   its OWN rows.
   *
   * re-audit iteration 3: the loser's rows are no longer merely
   * unreachable — every exit that does NOT publish DELETES this attempt's
   * area before returning or rethrowing. The version-keyed sweep could
   * never collect them (after a lost race the next close computes v+1 and
   * sweeps only v+1's prefix), so each non-publishing close used to leak
   * one full month of rows, permanently. The area is attempt-private, so
   * dropping it can never touch another attempt's rows.
   *
   * Returns 'conflict' when the period is already closed (nothing
   * published). A duplicate (year, month, version) header surfaces as a
   * typed BillingPeriodStateError, never a raw driver error.
   */
  async insertWithPeriodCloseStaged(
    identity: { year: number; month: number; version: number },
    stageAndBuild: (
      stage: (page: BillingUsageRecord[]) => Promise<void>,
    ) => Promise<BillingSnapshotModel>,
    close: { closedAt: Date; audit: BillingPeriodAuditEntry },
  ): Promise<'closed' | 'conflict'> {
    const key = snapshotKey(identity.year, identity.month, identity.version);
    const writeToken = MongoDb.generateUUID();
    const stagingKey = usageStagingKey(key, writeToken);

    try {
      // PHASE 1 — the caller pages the inputs in. Nothing written here is
      // reachable by any reader (no header names this area yet).
      const snapshot = await stageAndBuild(async (page) => {
        await this.stageUsagePage(stagingKey, page);
      });

      if (
        snapshot.year !== identity.year ||
        snapshot.month !== identity.month ||
        snapshot.version !== identity.version
      ) {
        // The header would be published pointing at an area keyed for a
        // different snapshot — its rows would be unreachable forever.
        throw new Error(
          `Billing snapshot ${key}: o header devolvido é de ` +
            `${snapshotKey(snapshot.year, snapshot.month, snapshot.version)} ` +
            '— identidade da área de staging e do header devem coincidir.',
        );
      }

      // PHASE 2 — publish: header + period flip, atomically and bounded.
      await MongoDb.withTransaction(async (session) => {
        // The (year, month, version) unique index makes snapshots
        // immutable: re-inserting an existing version is an error, never
        // an overwrite.
        await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION).insertOne(
          { ...snapshot, usageWriteToken: writeToken },
          { session },
        );

        let outcome: 'closed' | 'conflict';
        try {
          outcome = await this.flipPeriodClosed(session, {
            year: snapshot.year,
            month: snapshot.month,
            closedAt: close.closedAt,
            snapshotVersion: snapshot.version,
            audit: close.audit,
          });
        } catch (error) {
          // The guarded upsert's E11000 on (year, month) — the period doc
          // already exists as 'closed', or a concurrent close created it
          // first. Same meaning markClosed maps standalone: conflict. The
          // op error already aborted the transaction server-side; the
          // sentinel makes the driver finish the abort cleanly.
          if (isDuplicateKeyError(error)) {
            throw new PeriodFlipConflict();
          }

          throw error;
        }

        if (outcome === 'conflict') {
          // Abort — the header above must not survive a lost race (it
          // would sit under a period that never flipped).
          throw new PeriodFlipConflict();
        }
      });
    } catch (error) {
      // NOTHING was published on this path, so this attempt's staging area
      // is dead the moment we leave — drop it here, the only place that
      // still knows its key (re-audit iteration 3).
      await this.discardStaging(stagingKey);

      if (error instanceof PeriodFlipConflict) {
        return 'conflict';
      }

      // The (year, month, version) unique header index — or the period
      // upsert race — fired inside the transaction: a concurrent close
      // won. Typed, so the runbook prints a clean 409-class message.
      if (isDuplicateKeyError(error)) {
        throw new BillingPeriodStateError(
          `Snapshot ${key} já existe — fechamento concorrente detectado; ` +
            'nada foi sobrescrito.',
        );
      }

      if (isTransactionTooLargeError(error)) {
        throw new BillingPeriodStateError(
          `Fechamento de ${identity.year}-${String(identity.month).padStart(2, '0')} ` +
            'abortado: a transação de commit não coube no cache do WiredTiger ' +
            '(TransactionTooLargeForCache). Aumente MONGO_MEMORY_LIMIT e ' +
            'repita o fechamento — nada foi publicado.',
        );
      }

      throw error;
    }

    await this.sweepSupersededStaging(key, writeToken);

    return 'closed';
  }

  /** Overridable seam for the crash-between-writes-and-flip test (M8). */
  protected async flipPeriodClosed(
    session: ClientSession,
    args: {
      year: number;
      month: number;
      closedAt: Date;
      snapshotVersion: number;
      audit: BillingPeriodAuditEntry;
    },
  ): Promise<'closed' | 'conflict'> {
    return applyMarkClosed(args, session);
  }

  /**
   * Phase 1: ONE page into the attempt's private staging area. No session
   * on purpose — this is precisely the write that must NOT sit in the
   * transaction — and no pre-delete, because a fresh write token means the
   * area is empty by construction (which is also what keeps a concurrent
   * attempt from deleting rows this attempt is about to publish).
   *
   * The page is written in bounded chunks (the 16MB command ceiling); the
   * chunker now slices a PAGE, not a month, so its slice bookkeeping is
   * bounded too (re-audit iteration 3).
   */
  private async stageUsagePage(
    stagingKey: string,
    page: BillingUsageRecord[],
  ): Promise<void> {
    for (const chunk of chunksOf(page, this.usageWriteChunkSize)) {
      await this.insertUsageChunk(stagingKey, chunk);
    }
  }

  /**
   * Drops ONE attempt's staging area — the close did not publish, so the
   * rows are dead (re-audit iteration 3: they used to stay forever, since
   * the version-keyed sweep only ever reaches the version the NEXT close
   * computes). Best-effort: the caller is already returning 'conflict' or
   * rethrowing the real failure, and a cleanup error must not replace it.
   */
  private async discardStaging(stagingKey: string): Promise<void> {
    try {
      await MongoDb.getCollection(
        BILLING_SNAPSHOT_USAGE_COLLECTION,
      ).deleteMany({ snapshotKey: stagingKey });
    } catch (error) {
      console.warn(
        `Billing snapshot staging ${stagingKey}: discard failed — nothing was ` +
          'published and no header names these rows:',
        error,
      );
    }
  }

  /** Overridable seam for the chunked-staging test (re-audit). */
  protected async insertUsageChunk(
    stagingKey: string,
    chunk: BillingUsageRecord[],
  ): Promise<void> {
    await MongoDb.getCollection(BILLING_SNAPSHOT_USAGE_COLLECTION).insertMany(
      chunk.map((record) => ({ snapshotKey: stagingKey, ...record })),
      { ordered: true },
    );
  }

  /**
   * Drops the staging areas of this version that this header did NOT
   * publish. Since re-audit iteration 3 an attempt that RETURNS cleans up
   * after itself (discardStaging), so what is left for the sweep is the
   * one case no catch block can handle: a process killed mid-attempt.
   * Runs only AFTER the header is durable, so it can never delete rows a
   * live header names. Best-effort: the close is already committed and the
   * leftovers are unreachable by every reader, so a sweep failure must
   * never turn a committed close into a failed one.
   */
  private async sweepSupersededStaging(
    key: string,
    writeToken: string,
  ): Promise<void> {
    try {
      await MongoDb.getCollection(
        BILLING_SNAPSHOT_USAGE_COLLECTION,
      ).deleteMany({
        // Prefix range over the indexed snapshotKey, minus the published
        // area (`#` 0x23 < `$` 0x24 bounds every `${key}#<token>`).
        snapshotKey: {
          $gte: `${key}#`,
          $lt: `${key}$`,
          $ne: usageStagingKey(key, writeToken),
        },
      });
    } catch (error) {
      console.warn(
        `Billing snapshot ${key}: staging sweep failed — the close IS durable ` +
          'and the leftover rows are unreachable (no header names them):',
        error,
      );
    }
  }

  /**
   * The key of the usage rows a stored snapshot actually published, or
   * null when no header exists for the version. The header is the commit
   * mark: staged rows of a crashed or losing attempt live under a key no
   * header names, so they are invisible here by construction.
   */
  private async publishedUsageKey(
    year: number,
    month: number,
    version: number,
  ): Promise<string | null> {
    const header = await MongoDb.getCollection(
      BILLING_SNAPSHOTS_COLLECTION,
    ).findOne(
      { year, month, version },
      { projection: { _id: 0, usageWriteToken: 1 } },
    );

    if (!header) {
      return null;
    }

    const key = snapshotKey(year, month, version);
    const writeToken = header['usageWriteToken'] as string | undefined;

    // Snapshots written before the two-phase write stored their rows
    // under the bare snapshot key.
    return writeToken ? usageStagingKey(key, writeToken) : key;
  }

  async findCurrent(
    year: number,
    month: number,
  ): Promise<BillingSnapshotModel | null> {
    const document = await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION)
      .find({ year, month })
      .sort({ version: -1 })
      .limit(1)
      .next();

    return document ? toSnapshotModel(document) : null;
  }

  async findVersion(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingSnapshotModel | null> {
    const document = await MongoDb.getCollection(
      BILLING_SNAPSHOTS_COLLECTION,
    ).findOne({ year, month, version });

    return document ? toSnapshotModel(document) : null;
  }

  async listVersions(
    year: number,
    month: number,
  ): Promise<{ version: number; createdAt: Date }[]> {
    // audit C-7.3: one indexed find over (year, month, version) — replaces
    // the sequential findVersion(1..n) probing.
    const documents = await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION)
      .find(
        { year, month },
        { projection: { _id: 0, version: 1, createdAt: 1 } },
      )
      .sort({ version: 1 })
      .toArray();

    return documents.map((document) => ({
      version: document['version'] as number,
      createdAt: document['createdAt'] as Date,
    }));
  }

  async findUsageTraceIds(
    year: number,
    month: number,
    version: number,
  ): Promise<string[]> {
    // Projected read of the durable inputs — the close's reconcile-repair
    // diet (re-audit): ids only, never the full records.
    const publishedKey = await this.publishedUsageKey(year, month, version);

    if (!publishedKey) {
      return [];
    }

    const documents = await MongoDb.getCollection(
      BILLING_SNAPSHOT_USAGE_COLLECTION,
    )
      .find({ snapshotKey: publishedKey }, { projection: { _id: 0, traceId: 1 } })
      .toArray();

    return documents.map((document) => document['traceId'] as string);
  }

  async findUsageRecords(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingUsageRecord[]> {
    const publishedKey = await this.publishedUsageKey(year, month, version);

    if (!publishedKey) {
      return [];
    }

    const documents = await MongoDb.getCollection(
      BILLING_SNAPSHOT_USAGE_COLLECTION,
    )
      .find({ snapshotKey: publishedKey })
      .sort({ traceId: 1 })
      .toArray();

    return documents.map((document) => {
      const { _id, snapshotKey: _key, ...record } = document;

      return record as unknown as BillingUsageRecord;
    });
  }
}
