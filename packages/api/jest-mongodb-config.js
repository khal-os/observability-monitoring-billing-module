/**
 * @shelf/jest-mongodb options. The memory server must run as a
 * single-node REPLICA SET (not the preset's standalone default) because
 * the repositories use multi-document transactions (decision 81) — a
 * standalone mongod rejects them, and the integration suites must
 * exercise the same transactional writes production runs.
 */
module.exports = {
  mongodbMemoryServerOptions: {
    binary: {
      skipMD5: true,
    },
    autoStart: false,
    instance: {},
    replSet: {
      count: 1,
      storageEngine: 'wiredTiger',
    },
  },
};
