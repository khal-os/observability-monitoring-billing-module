import { BSON, Document } from 'mongodb';
import { EstimateDocumentBytes } from '../../../../application/interfaces/ingest-failure-repository.js';

/**
 * audit B-3 size guard — the storage side of the EstimateDocumentBytes
 * port. BSON.calculateObjectSize walks the exact serialization the driver
 * would produce, so the pre-insert estimate and the server's 16MB verdict
 * cannot drift apart the way a JSON-length heuristic would (BSON overhead
 * per field, Date/binary encodings). Lives in the mongodb module because
 * the driver import must not leak past it (architecture-boundaries).
 */
export const estimateBsonBytes: EstimateDocumentBytes = (document) =>
  BSON.calculateObjectSize(document as Document);
