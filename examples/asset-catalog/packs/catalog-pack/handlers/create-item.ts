/**
 * POST /api/items — add a file to the tenant's catalog.
 *
 * The body is `{ name, file_name }`. The handler derives the content type from the file name with
 * the third-party `mime-types` package (whose own dependency, `mime-db`, holds the table), asks the
 * classification service for the category of that content type, and writes the row through the
 * injected, tenant-bound `init.db` — the handler never names a tenant and cannot reach another's
 * rows.
 *
 * The classification service is `https://classifier.example.com`, the one host the deployment
 * declares in `deployment.egressHosts`. The declaration is what the host's network policy is
 * programmed from; the call is bounded by a timeout, and a failed call is a 502 that writes nothing.
 */
import { httpResponse, type RouteHandler, type RouteHandlerInit } from '@rayspec/handler-sdk';
import mime from 'mime-types';

const STORE = 'catalog_items';
const CLASSIFIER = 'https://classifier.example.com/v1/classify';
const CLASSIFIER_TIMEOUT_MS = 5_000;
const MAX_TEXT = 200;

function text(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TEXT ? trimmed : undefined;
}

/** The category the classification service gives a content type. */
async function classify(contentType: string): Promise<string> {
  const url = `${CLASSIFIER}?${new URLSearchParams({ content_type: contentType })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`the classification service answered ${res.status}`);
  const answer = (await res.json()) as { category?: unknown };
  if (typeof answer.category !== 'string' || answer.category.length === 0) {
    throw new Error('the classification service answered without a category');
  }
  return answer.category.slice(0, MAX_TEXT);
}

export const createItem: RouteHandler = async (init: RouteHandlerInit) => {
  const name = text(init.body, 'name');
  const fileName = text(init.body, 'file_name');
  if (name === undefined || fileName === undefined) {
    return httpResponse({
      status: 400,
      body: { error: 'bad_request', detail: `name and file_name are 1-${MAX_TEXT} characters.` },
    });
  }
  const contentType = mime.lookup(fileName) || 'application/octet-stream';
  let category: string;
  try {
    category = await classify(contentType);
  } catch {
    return httpResponse({
      status: 502,
      body: { error: 'classification_unavailable', detail: 'the item was not added.' },
    });
  }
  const row = await init.db.insert(STORE, {
    name,
    file_name: fileName,
    content_type: contentType,
    category,
  });
  return httpResponse({ status: 201, body: row });
};
