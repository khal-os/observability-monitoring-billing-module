/**
 * Architecture fitness tests for @observability/module — the module sees only traces
 * already ingested; the trace source lives entirely in @observability/connector:
 *
 * 1. The module is VENDOR-BLIND BY PACKAGE: no trace-source vendor name may
 *    appear anywhere here. Stronger than the pre-split rule, which had to
 *    allow the adapter directory — the split moved it out wholesale.
 * 2. @observability/connector may be imported by TESTS ONLY (the route harness seeds
 *    through the real ingestion; the pipeline test proves invariant 3
 *    end-to-end) — never by production files, so the shipped module has no
 *    path to a trace source.
 * 3. Dependency direction: application must not reach infrastructure,
 *    presentation or main; presentation only domain (+ its own layer and
 *    common). Cross-package imports count: '@observability/core/<layer>/...' is
 *    treated as that layer — the package boundary must not launder a
 *    forbidden dependency.
 * 4. Storage backend containment (decision 56): storage lives in
 *    @observability/core/infrastructure/database; it counts as "storage" here.
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
    // Static imports/re-exports, single or double quotes.
    ...content.matchAll(/from\s+['"]([^'"]+)['"]/g),
    // Dynamic import() and require() — same rules apply.
    ...content.matchAll(/(?:\bimport|\brequire)\(\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1] as string);
};

/**
 * Path of an import relative to a src tree — local relative imports AND
 * workspace imports of @observability/core (whose src mirrors the same layer
 * layout). Both must obey the same layer rules: '@observability/core/…' is not a
 * loophole around them.
 */
const resolvedPathOf = (file: string, specifier: string): string | null => {
  if (specifier.startsWith('@observability/core/')) {
    return specifier
      .slice('@observability/core/'.length)
      .replace(/\.js$/, '.ts');
  }

  if (!specifier.startsWith('.')) return null;

  const resolved = resolve(dirname(file), specifier);
  const relativeToSrc = relative(SRC, resolved).split(/[\\/]/).join('/');

  return relativeToSrc.startsWith('..') ? null : relativeToSrc;
};

const layerOfImport = (file: string, specifier: string): string | null =>
  resolvedPathOf(file, specifier)?.split('/')[0] ?? null;

const VENDOR = /langwatch|clickhouse/i;

describe('Architecture boundaries (@observability/module)', () => {
  it('MUST declare no trace-source vendor dependency in package.json (audit C-3/C-4 — the src grep cannot see node_modules)', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(manifest.dependencies ?? {});

    // The connector may only ever be a devDependency (test seeding) — a
    // production dependency would ship the LangWatch adapters into the
    // vendor-blind image, and --omit=dev does NOT prune workspace links.
    expect(deps).not.toContain('@observability/connector');
    // No vendor SDK: @clickhouse/client shipped here unused for weeks,
    // invisible to the src-only grep above.
    expect(deps.filter((dep) => VENDOR.test(dep))).toEqual([]);
  });

  it('MUST keep the whole package vendor-blind (the adapter lives in the connector)', () => {
    const offenders = allFiles
      .filter(
        (file) =>
          posixRelative(file) !== 'architecture-boundaries.spec.ts' &&
          VENDOR.test(readFileSync(file, 'utf-8')),
      )
      .map(posixRelative);

    expect(offenders).toEqual([]);
  });

  it('MUST confine @observability/connector to test files — production code has no path to a trace source', () => {
    const offenders = allFiles
      .filter((file) => {
        const path = posixRelative(file);

        // The harness is test-support (imported by route suites only) and
        // excluded from the build like every spec/test file.
        if (/\.(spec|test)\.ts$/.test(path)) return false;
        if (path === 'main/server/routes/v1/helpers/route-db-harness.ts')
          return false;

        return importsOf(file).some((specifier) =>
          specifier.startsWith('@observability/connector/'),
        );
      })
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

    it('application MUST NOT depend on infrastructure, presentation or main', () => {
      expect(
        violations('application', ['infrastructure', 'presentation', 'main']),
      ).toEqual([]);
    });

    it('presentation MUST NOT depend on application implementations, infrastructure or main', () => {
      expect(
        violations('presentation', ['application', 'infrastructure', 'main']),
      ).toEqual([]);
    });

    it('infrastructure MUST NOT depend on presentation or main (adapters implement application ports only)', () => {
      expect(violations('infrastructure', ['presentation', 'main'])).toEqual(
        [],
      );
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

    it('MUST keep application, presentation and common storage-blind — tests included', () => {
      const offenders = allFiles
        .filter((file) => {
          const path = posixRelative(file);

          if (!/^(application|presentation|common)\//.test(path)) return false;

          // main/ is forbidden too: importing anything from main (e.g. the
          // storage-aware route harness) would make a business layer
          // storage-reachable transitively.
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

    it('MUST keep the infrastructure barrel storage-free (main imports it freely)', () => {
      const barrel = allFiles.find(
        (file) => posixRelative(file) === 'infrastructure/index.ts',
      ) as string;

      const storageImports = importsOf(barrel).filter((specifier) => {
        const resolved = resolvedPathOf(barrel, specifier);

        return (
          resolved !== null && resolved.startsWith('infrastructure/database')
        );
      });

      expect(storageImports).toEqual([]);
    });

    it("MUST confine main's storage imports to the composition root", () => {
      // The route-db-harness is the ONE storage-aware test helper behind
      // the route suites (imported by tests only) — the deliberate seam a
      // backend swap rewrites.
      const allowed = [
        'main/factories/',
        'main/server/routes/v1/helpers/route-db-harness.ts',
      ];

      const offenders = allFiles
        .filter((file) => {
          const path = posixRelative(file);

          // Tests included: main's route suites reach storage ONLY through
          // the allow-listed harness — that seam is enforced, not advisory.
          if (!path.startsWith('main/')) return false;
          if (allowed.some((prefix) => path.startsWith(prefix))) return false;

          return importsOf(file).some((specifier) => {
            const resolved = resolvedPathOf(file, specifier);

            return (
              resolved !== null &&
              resolved.startsWith('infrastructure/database/')
            );
          });
        })
        .map(posixRelative);

      expect(offenders).toEqual([]);
    });
  });
});
