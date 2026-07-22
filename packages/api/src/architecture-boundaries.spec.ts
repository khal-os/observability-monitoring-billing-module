/**
 * Architecture fitness tests — these ENFORCE that swapping the trace
 * source vendor (LangWatch today) can never touch business rules:
 *
 * 1. The vendor name may only appear inside its adapter
 *    (infrastructure/traceSource/langwatch/), the environment wiring
 *    (infrastructure/configuration/) and the composition root
 *    (main/factories/sync-factory.ts). domain/application/presentation/common
 *    are vendor-blind by test, not by convention.
 * 2. Dependency direction: domain depends on nothing outer; application only
 *    on domain; presentation only on domain (+ its own layer and common).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const findSrcDir = (): string => {
  const candidates = [
    join(process.cwd(), 'src'),
    join(process.cwd(), 'packages', 'api', 'src'),
  ];
  const srcDir = candidates.find((candidate) =>
    existsSync(join(candidate, 'domain')),
  );

  if (!srcDir) {
    throw new Error('architecture-boundaries: src directory not found');
  }

  return srcDir;
};

const SRC = findSrcDir();

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

const resolvedPathOf = (file: string, specifier: string): string | null => {
  if (!specifier.startsWith('.')) return null;

  const resolved = resolve(dirname(file), specifier);
  const relativeToSrc = relative(SRC, resolved).split(/[\\/]/).join('/');

  return relativeToSrc.startsWith('..') ? null : relativeToSrc;
};

const layerOfImport = (file: string, specifier: string): string | null => {
  if (!specifier.startsWith('.')) return null;

  const resolved = resolve(dirname(file), specifier);
  const relativeToSrc = relative(SRC, resolved).split(/[\\/]/).join('/');

  if (relativeToSrc.startsWith('..')) return null;

  return relativeToSrc.split('/')[0] ?? null;
};

const VENDOR = /langwatch/i;

const VENDOR_ALLOWED_PREFIXES = [
  'infrastructure/traceSource/langwatch/',
  'infrastructure/configuration/',
  'main/factories/sync-factory.ts',
  'architecture-boundaries.spec.ts',
];

describe('Architecture boundaries', () => {
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
        violations('domain', [
          'application',
          'infrastructure',
          'presentation',
          'main',
        ]),
      ).toEqual([]);
    });

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

    it('common MUST stay dependency-free towards every layer', () => {
      expect(
        violations('common', [
          'domain',
          'application',
          'infrastructure',
          'presentation',
          'main',
        ]),
      ).toEqual([]);
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

    it('MUST keep domain, application, presentation and common storage-blind — tests included', () => {
      const offenders = allFiles
        .filter((file) => {
          const path = posixRelative(file);

          if (!/^(domain|application|presentation|common)\//.test(path)) return false;

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

        return resolved !== null && resolved.startsWith('infrastructure/database');
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
