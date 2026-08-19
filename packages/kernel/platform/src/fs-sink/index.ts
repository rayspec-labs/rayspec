/**
 * The platform's fs-sink backend — the WRITE-ONLY, path-jailed, byte-bounded fs `FsSink` impl + its
 * composition-root factory. The neutral `FsSink` INTERFACE lives in `@rayspec/handler-sdk` (open-core,
 * type-only); this is the concrete impl the deployer injects (like the blob / fs-source backends).
 */
export {
  DEFAULT_MAX_SINK_BYTES_PER_FILE,
  DEFAULT_MAX_SINK_FILES,
  DEFAULT_MAX_SINK_TOTAL_BYTES,
  FsSinkConfigError,
  FsSinkJailError,
  type FsSinkQuotaConfig,
  FsSinkQuotaError,
  makeFsSinkFactory,
} from './fs-sink.js';
