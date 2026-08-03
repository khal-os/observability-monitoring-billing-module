/**
 * Architecture fitness tests for @khal/connector — the trace-source side.
 * These ENFORCE that swapping the vendor (LangWatch today) can never touch
 * business rules:
 *
 * 1. The vendor name may only appear inside its adapter
 *    (infrastructure/traceSource/langwatch/), the environment wiring
 *    (infrastructure/configuration/) and the composition root
 *    (main/factories/sync-factory.ts). domain/application are vendor-blind
 *    by test, not by convention — a different connector fills the same
 *    slot by replacing the adapter, not the sync logic.
 * 2. The connector depends on @khal/core ONLY: importing @khal/module
 *    (even in tests) would make the source side depend on the read API.
 * 3. Dependency direction: domain depends on nothing outer; application
 *    must not reach infrastructure or main. Cross-package imports count:
 *    '@khal/core/<layer>/...' is treated as that layer.
 * 4. Storage backend containment (decision 56): the mongodb driver only
 *    inside infrastructure/database/mongodb/ (this package's ingestion
 *    bookkeeping repos); core's repos count as storage for layer rules.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = join(process.cwd(), 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return walk(path);

    return entry.name.endsWith('.ts') ? [path] : [];
  });

const allFiles = walk(SRC);

const posixRelative = (file: string): string =>
  relative(SRC, file).split(/[\\/]/).join('/');

const importsOf = (file: string): string[] => {
  const content = readFileSync(file, 'utf-8');

  return [
    ...content.matchAll(/from\s+['"]([^'"]+)['"]/g),
    ...content.matchAll(/(?:\bimport|\brequire)\(\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1] as string);
};

/**
 * Path of an import relative to a src tree — local relative imports AND
 * workspace imports of @khal/core (whose src mirrors the same layer
 * layout). Both must obey the same layer rules.
 */
const resolvedPathOf = (file: string, specifier: string): string | null => {
  if (specifier.startsWith('@khal/core/')) {
    return specifier.slice('@khal/core/'.length).replace(/\.js$/, '.ts');
  }

  if (!specifier.startsWith('.')) return null;

  const resolved = resolve(dirname(file), specifier);
  const relativeToSrc = relative(SRC, resolved).split(/[\\/]/).join('/');

  return relativeToSrc.startsWith('..') ? null : relativeToSrc;
};

const layerOfImport = (file: string, specifier: string): string | null =>
  resolvedPathOf(file, specifier)?.split('/')[0] ?? null;

const VENDOR = /langwatch/i;

const VENDOR_ALLOWED_PREFIXES = [
  'infrastructure/traceSource/langwatch/',
  'infrastructure/configuration/',
  'main/factories/sync-factory.ts',
  'architecture-boundaries.spec.ts',
];

describe('Architecture boundaries (@khal/connector)', () => {
  it('MUST keep every layer outside the adapter vendor-blind (swap-safe)', () => {
    const offenders = allFiles
      .filter((file) => {
        const path = posixRelative(file);

        return (
          !VENDOR_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
          VENDOR.test(readFileSync(file, 'utf-8'))
        );
      })
      .map(posixRelative);

    expect(offenders).toEqual([]);
  });

  it('MUST NOT import @khal/module — the source side never depends on the read API', () => {
    const offenders = allFiles
      .filter((file) =>
        importsOf(file).some((specifier) =>
          specifier.startsWith('@khal/module'),
        ),
      )
      .map(posixRelative);

    expect(offenders).toEqual([]);
  });

  describe('Dependency direction (production files)', () => {
    const productionFiles = allFiles.filter(
      (file) => !file.endsWith('.spec.ts') && !file.endsWith('.test.ts'),
    );

    const violations = (layer: string, forbidden: string[]): string[] =>
      productionFiles
        .filter((file) => posixRelative(file).startsWith(`${layer}/`))
        .flatMap((file) =>
          importsOf(file)
            .map((specifier) => layerOfImport(file, specifier))
            .filter(
              (imported): imported is string =>
                imported !== null && forbidden.includes(imported),
            )
            .map((imported) => `${posixRelative(file)} -> ${imported}`),
        );

    it('domain MUST NOT depend on any outer layer', () => {
      expect(
        violations('domain', ['application', 'infrastructure', 'main']),
      ).toEqual([]);
    });

    it('application MUST NOT depend on infrastructure or main', () => {
      expect(violations('application', ['infrastructure', 'main'])).toEqual(
        [],
      );
    });

    it('infrastructure MUST NOT depend on main (adapters implement application ports only)', () => {
      expect(violations('infrastructure', ['main'])).toEqual([]);
    });
  });

  describe('Storage backend containment (decision 56 — swap-safe by test)', () => {
    it('MUST keep the mongodb driver inside its adapter', () => {
      const offenders = allFiles
        .filter((file) => {
          const path = posixRelative(file);

          if (path.startsWith('infrastructure/database/mongodb/')) {
            return false;
          }

          return importsOf(file).some(
            (specifier) =>
              specifier === 'mongodb' || specifier.startsWith('mongodb/'),
          );
        })
        .map(posixRelative);

      expect(offenders).toEqual([]);
    });

    it('MUST keep domain and application storage-blind — tests included', () => {
      const offenders = allFiles
        .filter((file) => {
          const path = posixRelative(file);

          if (!/^(domain|application)\//.test(path)) return false;

          return importsOf(file).some((specifier) => {
            const resolved = resolvedPathOf(file, specifier);

            return (
              resolved !== null &&
              (resolved.startsWith('infrastructure/') ||
                resolved.startsWith('main/'))
            );
          });
        })
        .map(posixRelative);

      expect(offenders).toEqual([]);
    });
  });
});
