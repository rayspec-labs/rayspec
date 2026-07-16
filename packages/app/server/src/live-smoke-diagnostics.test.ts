import { describe, expect, it } from 'vitest';
import {
  formatRedactedRunFailure,
  type NodeFailureRow,
  type RunFailureRow,
  redact,
} from './live-smoke-diagnostics.js';

// Deliberately fake, planted "secrets" — never real credentials. If redaction is removed, these
// substrings survive into the diagnostic and the assertions below fail (the fail-the-fix property).
const FAKE_SK = 'sk-THISISAFAKEKEY0123456789abcdef';
const FAKE_BEARER_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlLXBsYWNlaG9sZGVy';

describe('redact', () => {
  it('masks an sk- key and a Bearer token, and never leaks the secret substrings', () => {
    const clean = redact(`boom key=${FAKE_SK} header: Bearer ${FAKE_BEARER_TOKEN}`);
    expect(clean).not.toContain(FAKE_SK);
    expect(clean).not.toContain(FAKE_BEARER_TOKEN);
    expect(clean).toContain('[REDACTED]');
  });

  it('bounds the length of a long message', () => {
    const clean = redact('word '.repeat(400));
    expect(clean.length).toBeLessThanOrEqual(320);
    expect(clean).toContain('[truncated]');
  });

  it('collapses to a single line', () => {
    expect(redact('line one\nline two\ttabbed')).not.toContain('\n');
  });
});

describe('formatRedactedRunFailure', () => {
  const run: RunFailureRow = {
    status: 'terminal_failure',
    error: { code: 'validation_failed', message: `provider said: ${FAKE_SK}`, retryable: false },
  };
  const failedNode: NodeFailureRow = {
    node_id: 'extract',
    status: 'terminal_failure',
    error: {
      code: 'model_error',
      message: `upstream rejected: Bearer ${FAKE_BEARER_TOKEN}`,
      retryable: false,
    },
    skipped_reason: null,
  };

  it('includes the status + codes, redacts the planted secrets, marks them, and stays one line', () => {
    const line = formatRedactedRunFailure('run-1', run, [failedNode]);
    // (i) contains the run status and the error codes.
    expect(line).toContain('status=terminal_failure');
    expect(line).toContain('code=validation_failed');
    expect(line).toContain('code=model_error');
    // (ii) does NOT contain either planted secret.
    expect(line).not.toContain(FAKE_SK);
    expect(line).not.toContain(FAKE_BEARER_TOKEN);
    // (iii) contains the redaction marker.
    expect(line).toContain('[REDACTED]');
    // ONE line only.
    expect(line).not.toContain('\n');
  });

  it('never logs a node output, attempts, or input event field name', () => {
    const line = formatRedactedRunFailure('run-1', run, [failedNode]);
    expect(line).not.toContain('output');
    expect(line).not.toContain('attempts');
    expect(line).not.toContain('input_event');
  });

  it('reports a missing run row without throwing', () => {
    expect(formatRedactedRunFailure('run-2', undefined, [])).toContain('status=<no run row found>');
  });

  it('picks the first non-completed node, skipping completed ones', () => {
    const completed: NodeFailureRow = {
      node_id: 'parse',
      status: 'completed',
      error: null,
      skipped_reason: null,
    };
    const line = formatRedactedRunFailure('run-3', run, [completed, failedNode]);
    expect(line).toContain('node id=extract');
    expect(line).not.toContain('node id=parse');
  });
});
