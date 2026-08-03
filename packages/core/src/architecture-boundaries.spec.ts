/**
 * Architecture fitness tests for @khal/core — the store and its rules.
 *
 * 1. Core is VENDOR-BLIND BY PACKAGE: no trace-source vendor name may
 *    appear anywhere in this package (the vendor adapter lives in
 *    @khal/connector). Stronger than the old single-package rule, which
 *    had to allow the adapter directory.
 * 2. Core is the BOTTOM of the workspace graph: it must not import any
 *    workspace package (@khal/*) — module and connector depend on core,
 *    never the reverse.
 * 3. Dependency direction inside the package: domain depends on nothing
 *    outer; application only on domain; common on nothing.
 * 4. Storage backend containment (decision 56): the mongodb driver only
 *    inside infrastructure/database/mongodb/; domain/application/common
 *    storage-blind, tests included.
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

const resolvedPathOf = (file: string, specifier: string): string | null => {
  if (!specifier.startsWith('.')) return null;

  const resolved = resolve(dirname(file), specifier);
  const relativeToSrc = relative(SRC, resolved).split(/[\\/]/).join('/');

  return relativeToSrc.startsWith('..') ? null : relativeToSrc;
};

const layerOfImport = (file: string, specifier: string): string | null =>
  resolvedPathOf(file, specifier)?.split('/')[0] ?? null;

const VENDOR = /langwatch/i;

describe('Architecture boundaries (@khal/core)', () => {
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

  it('MUST NOT import any workspace package — core is the bottom of the graph', () => {
    const offenders = allFiles
      .filter((file) =>
        importsOf(file).some((specifier) => specifier.startsWith('@khal/')),
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
        violations('domain', ['application', 'infrastructure']),
      ).toEqual([]);
    });

    it('application MUST NOT depend on infrastructure', () => {
      expect(violations('application', ['infrastructure'])).toEqual([]);
    });

    it('common MUST stay dependency-free towards every layer', () => {
      expect(
        violations('common', ['domain', 'application', 'infrastructure']),
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

    it('MUST keep domain, application and common storage-blind — tests included', () => {
      const offenders = allFiles
        .filter((file) => {
          const path = posixRelative(file);

          if (!/^(domain|application|common)\//.test(path)) return false;

          return importsOf(file).some((specifier) => {
            const resolved = resolvedPathOf(file, specifier);

            return resolved !== null && resolved.startsWith('infrastructure/');
          });
        })
        .map(posixRelative);

      expect(offenders).toEqual([]);
    });
  });
});
