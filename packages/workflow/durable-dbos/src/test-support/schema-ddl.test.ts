/**
 * Drift guard (no DB) for the cron product-table DDL.
 *
 * `buildCronProductSchemaSql` interpolates the injected tenancy/GDPR columns DERIVED from the
 * single-source generator descriptor (`injectedColumnLinesSql`), so a NEW injected column can never
 * silently drift the `cron_marks` fixture. This proves the emitted table carries EXACTLY the injected
 * columns + its one business column (`note`), failing the fix RED if that interpolation is dropped.
 */
import { INJECTED_COLUMN_NAMES } from '@rayspec/db';
import { parseCreateTableColumnNames } from '@rayspec/db/testing';
import { describe, expect, it } from 'vitest';
import { buildCronProductSchemaSql } from './schema-ddl.js';

describe('buildCronProductSchemaSql — injected-column drift guard', () => {
  it('cron_marks carries exactly the injected columns + the one business column (note)', () => {
    const sql = buildCronProductSchemaSql('some_schema');
    const columns = new Set(parseCreateTableColumnNames(sql, 'cron_marks'));
    expect(columns).toEqual(new Set([...INJECTED_COLUMN_NAMES, 'note']));
  });
});
