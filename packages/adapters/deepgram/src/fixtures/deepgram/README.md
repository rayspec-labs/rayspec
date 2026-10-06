# Deepgram wire-shape golden fixtures

Sanitized, synthetic Deepgram `/v1/listen` pre-recorded response bodies used to contract-test the
provider-neutral mapping in `../../deepgram-response.ts`. They mirror the real Deepgram response schema
(`metadata.request_id` / `metadata.duration`, `results.channels[].detected_language`,
`alternatives[].{transcript, confidence, words[], paragraphs}`) exactly enough to exercise the reference
segment derivation, but contain **no real API keys, request ids, customer audio, or PII** — every
`request_id` is a fixed all-zero-prefixed UUID and every transcript is invented text. Gitleaks-safe.

| Fixture | Exercises |
|---|---|
| `normal-paragraphs.json` | Multi-paragraph response → `segmentsFromParagraphs`; `punctuated_word`; `request_id` → `provider_run_id`. |
| `word-gap-no-paragraphs.json` | No paragraphs → `segmentsFromWords` word-gap splitting (> 1.0s). |
| `empty-silent.json` | Silent recording (empty transcript, no words) → valid completed transcript. |
| `missing-confidence-words.json` | Absent confidence/language → honest `null` degradation (no fabricated `0`). |
| `mixed-confidence-words.json` | A run with SOME words missing confidence → present-only mean (flagged divergence: neutral averages the present confidences, denominator = present count, vs a naive `run.length`). |
| `multichannel.json` | Two channels → only `channels[0]` is mapped (reference behavior). |
| `multi-sentence-paragraphs.json` | Two paragraphs of three and two sentences, each word inside its sentence's bounds → one segment per paragraph by default, one per sentence under sentence granularity (`segmentsFromSentences`). |

`default-transcripts/<fixture>` is the transcript each fixture maps to when no span granularity is
given. The mapping test compares against it key for key, so the default mapping cannot change
unnoticed.
