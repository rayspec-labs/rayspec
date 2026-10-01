/**
 * How an import target's catalog is compared with what its restore plan creates: equal holds, and
 * each kind of difference is named without naming the object.
 */
import { describe, expect, it } from 'vitest';
import type { FunctionDefinition } from './dump-policy.js';
import {
  type CatalogExpectation,
  type CatalogState,
  catalogDifference,
  catalogDigest,
  describeFunction,
  storedSetting,
} from './import-catalog.js';

const NOTIFY: FunctionDefinition = {
  name: 'dbos.notifications_function',
  language: 'plpgsql',
  securityDefiner: false,
  config: ['search_path=["pg_catalog","pg_temp"]'],
  bodySha256: 'a'.repeat(64),
};
const ENQUEUE: FunctionDefinition = { ...NOTIFY, name: 'dbos.enqueue_workflow' };

const EXPECTED: CatalogExpectation = {
  extensions: ['uuid-ossp'],
  schemas: ['dbos'],
  functions: [NOTIFY, ENQUEUE],
  triggers: 2,
  defaultPrivileges: 'migrator 0 r runtime SELECT false',
  roleSettings: '',
};

function state(over: Partial<CatalogState> = {}): CatalogState {
  return {
    extensions: ['uuid-ossp'],
    schemas: ['dbos'],
    functions: ['dbos.enqueue_workflow', 'dbos.notifications_function'],
    functionDefinitions: [describeFunction(ENQUEUE), describeFunction(NOTIFY)],
    triggers: 2,
    foreign: { views: 0, 'large objects': 0 },
    strangerGrants: 0,
    defaultPrivileges: 'migrator 0 r runtime SELECT false',
    roleSettings: '',
    ...over,
  };
}

describe('catalogDifference', () => {
  it('finds none when the catalog holds exactly the plan, in any order', () => {
    expect(catalogDifference(state(), EXPECTED)).toBeNull();
    expect(
      catalogDifference(
        state({ functions: ['dbos.notifications_function', 'dbos.enqueue_workflow'] }),
        EXPECTED,
      ),
    ).toBeNull();
  });

  it('names each kind of difference', () => {
    for (const [over, words] of [
      [{ extensions: ['uuid-ossp', 'pgcrypto'] }, 'other extensions'],
      [{ schemas: ['dbos', 'extra'] }, 'other schemas'],
      [{ functions: ['dbos.enqueue_workflow'] }, 'other functions'],
      [
        { functions: ['dbos.enqueue_workflow', 'dbos.notifications_function', 'public.x'] },
        'other functions',
      ],
      [{ triggers: 3 }, 'other triggers'],
      [{ foreign: { views: 1, 'large objects': 0 } }, 'holds views'],
      [{ foreign: { views: 0, 'large objects': 2 } }, 'holds large objects'],
      [{ strangerGrants: 1 }, 'grants privileges to a role'],
      [
        { defaultPrivileges: `${EXPECTED.defaultPrivileges}\nmigrator 0 r public INSERT false` },
        'default privileges',
      ],
      [
        { roleSettings: 'migrator 0 {search_path=evil}' },
        'settings of its migration or runtime role',
      ],
    ] as const) {
      expect(catalogDifference(state(over as Partial<CatalogState>), EXPECTED), words).toContain(
        words,
      );
    }
  });

  it('finds a function redefined under its own name: security mode, body, settings or language', () => {
    for (const [over, what] of [
      [{ securityDefiner: true }, 'made SECURITY DEFINER'],
      [{ bodySha256: 'b'.repeat(64) }, 'another body'],
      [{ config: [] }, 'its search path dropped'],
      [{ config: ['search_path=["public"]'] }, 'another search path'],
      [{ language: 'sql' }, 'another language'],
    ] as const) {
      const changed = describeFunction({ ...NOTIFY, ...over });
      expect(changed, what).not.toBe(describeFunction(NOTIFY));
      expect(
        catalogDifference(
          state({ functionDefinitions: [describeFunction(ENQUEUE), changed] }),
          EXPECTED,
        ),
        what,
      ).toBe('a function is not defined as its dump entry defines it');
    }
    // A setting list read back in another order of settings is the same definition.
    expect(describeFunction({ ...NOTIFY, config: ['b=1', 'a=2'] })).toBe(
      describeFunction({ ...NOTIFY, config: ['a=2', 'b=1'] }),
    );
  });

  it('reads a stored setting the way the restore plan records it', () => {
    expect(storedSetting('search_path=pg_catalog, pg_temp')).toBe(
      'search_path=["pg_catalog","pg_temp"]',
    );
    expect(storedSetting('search_path=""')).toBe('search_path=[""]');
    expect(storedSetting('search_path="my ""odd"" schema", public')).toBe(
      'search_path=["my \\"odd\\" schema","public"]',
    );
    expect(storedSetting('work_mem=64MB')).toBe('work_mem=["64MB"]');
    // Unreadable as a list: kept as stored, so it compares unequal to anything the plan records.
    expect(storedSetting('search_path="open')).toBe('search_path="open');
    expect(storedSetting('search_path="a" b')).toBe('search_path="a" b');
    expect(storedSetting('no-equals')).toBe('no-equals');
  });

  it('digests equal states equally and different states differently', () => {
    expect(catalogDigest([state()])).toBe(catalogDigest([state()]));
    expect(catalogDigest([state()])).not.toBe(catalogDigest([state({ triggers: 3 })]));
    expect(catalogDigest([state()])).not.toBe(
      catalogDigest([
        state({
          functionDefinitions: [
            describeFunction(ENQUEUE),
            describeFunction({ ...NOTIFY, securityDefiner: true }),
          ],
        }),
      ]),
    );
    expect(catalogDigest([state()])).toMatch(/^[0-9a-f]{64}$/);
    // The same catalog read back with its lists in another order digests equally.
    const reordered = state({
      functions: ['dbos.notifications_function', 'dbos.enqueue_workflow'],
      functionDefinitions: [describeFunction(NOTIFY), describeFunction(ENQUEUE)],
    });
    expect(reordered.functionDefinitions).not.toEqual(state().functionDefinitions);
    expect(catalogDigest([reordered])).toBe(catalogDigest([state()]));
  });
});
