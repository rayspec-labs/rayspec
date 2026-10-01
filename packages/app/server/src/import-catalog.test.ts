/**
 * How an import target's catalog is compared with what its restore plan creates: equal holds, and
 * each kind of difference is named without naming the object.
 */
import { describe, expect, it } from 'vitest';
import {
  type CatalogExpectation,
  type CatalogState,
  catalogDifference,
  catalogDigest,
} from './import-catalog.js';

const EXPECTED: CatalogExpectation = {
  extensions: ['uuid-ossp'],
  schemas: ['dbos'],
  functions: ['dbos.notifications_function()', 'dbos.enqueue_workflow(text, json)'],
  triggers: 2,
  defaultPrivileges: 'migrator 0 r runtime SELECT false',
  roleSettings: '',
};

function state(over: Partial<CatalogState> = {}): CatalogState {
  return {
    extensions: ['uuid-ossp'],
    schemas: ['dbos'],
    functions: ['dbos.enqueue_workflow', 'dbos.notifications_function'],
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

  it('digests equal states equally and different states differently', () => {
    expect(catalogDigest([state()])).toBe(catalogDigest([state()]));
    expect(catalogDigest([state()])).not.toBe(catalogDigest([state({ triggers: 3 })]));
    expect(catalogDigest([state()])).toMatch(/^[0-9a-f]{64}$/);
  });
});
