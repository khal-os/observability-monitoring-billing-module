import config from './jest.config.mjs';

config.testMatch = ['**/*.spec.ts'];

// Unit suites test against in-memory stubs only — no store. Dropping the
// mongodb preset here means `test:unit` never boots mongodb-memory-server
// (the preset stays in the base config: `npm test` also runs the *.test.ts
// integration suites, which do need it).
delete config.preset;

export default config;
