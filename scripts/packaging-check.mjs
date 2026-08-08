#!/usr/bin/env node
// The packaging contract, exercised through Node's REAL resolver (audit
// C-2). Jest maps @observability/* straight to sibling SOURCE, so the whole
// suite structurally cannot see a broken exports map, a file missing from a
// dist, or absent type declarations — C-1 shipped exactly that way: 637
// green tests while `tsc --noEmit` was red in two packages. This script
// runs AFTER `npm run build` (root test:ci wires the order) and fails on
// the classes the suite cannot.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const fail = (message) => {
  console.error(`packaging-check: ${message}`);
  process.exitCode = 1;
};

// 1. Runtime resolution through the exports maps — the exact specifiers
//    production code imports, resolved the way a container resolves them.
const RESOLVABLE = [
  '@observability/core/domain/models/trace-model.js',
  '@observability/core/common/helpers/money/money.js',
  '@observability/core/infrastructure/database/mongodb/helpers/assert-ingestion-indexes.js',
  // The C-1 regression pinned: test support consumed across the package
  // boundary must ship in core's dist like everything else.
  '@observability/core/application/testSupport/billing-test-fakes.js',
  '@observability/connector/application/interfaces/trace-source-client.js',
];

for (const specifier of RESOLVABLE) {
  try {
    await import(specifier);
  } catch (error) {
    fail(
      `cannot import ${specifier} through the real resolver: ${error.message}`,
    );
  }
}

// 2. Type declarations beside the emitted JS — consumers typecheck against
//    dist, so a package that emits none erases every interface it exports.
const DECLARATIONS = [
  ['packages/core/dist/domain/models/trace-model.d.ts', 'TraceModel'],
  [
    'packages/core/dist/application/testSupport/billing-test-fakes.d.ts',
    'StubBillingQueryRepository',
  ],
  [
    'packages/connector/dist/application/interfaces/trace-source-client.d.ts',
    'SourceTrace',
  ],
  [
    'packages/connector/dist/main/factories/sync-factory.d.ts',
    'makeTraceSourceClient',
  ],
  ['packages/module/dist/main/index.d.ts', ''],
];

for (const [path, symbol] of DECLARATIONS) {
  const absolute = join(ROOT, path);

  if (!existsSync(absolute)) {
    fail(`missing declaration file: ${path}`);
    continue;
  }

  if (symbol && !readFileSync(absolute, 'utf-8').includes(symbol)) {
    fail(`${path} no longer declares ${symbol}`);
  }
}

if (process.exitCode !== 1) {
  console.log(
    `packaging-check: ${RESOLVABLE.length} specifiers resolve, ` +
      `${DECLARATIONS.length} declaration files present — the packaging contract holds.`,
  );
}
