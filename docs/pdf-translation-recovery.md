# PDF translation recovery (2026-09-30)

The reported 18-page VLN survey retained all translated PDFs on disk but reopened at 0/18. Three recovery failures were found:

1. `PdfReader.loadSource` computed SHA-256 after `pdfjsLib.getDocument` transferred the original ArrayBuffer to its worker. The buffer was detached, hashing returned an empty string, and source validation rejected the saved task. Capture the hash and byte length before passing the buffer to PDF.js.
2. Reading saved output reused model, configuration fingerprint and engine validation intended for translation generation. Separate historical reading from generation: verify paper ID, source SHA-256, language, assist mode and usable PDF output. Generation and resume retain strict identity checks.
3. A newer task with fewer translated pages could hide an older partial task. For historical reading, choose the matching task with the most usable completed pages, then the most recent update. Legacy missing assist metadata means the original unassisted mode.

Builds and shallow display-state tests did not exercise ArrayBuffer ownership transfer or the complete reopen chain. The browser regression in `scripts/pdf-translation-recovery-smoke.mjs` uses real locally saved papers, deliberately changes model configuration, restores the 18-page survey and a 6-page partial translation, switches translated/bilingual views, reopens the reader and verifies nonempty SHA-256 requests with no new translation submission. Unit coverage rejects wrong paper/source/language/mode, missing outputs and newer tasks with less progress.

Other `getDocument` calls were checked: layout-PDF rendering consumes a disposable buffer and does not hash it afterward. Keep worker-owned buffers out of subsequent source identity or byte-count computations.

Local rollback copies of cache metadata and the survey job were retained under `tmp/translation-recovery-20260930`. No API credentials belong in recovery reports or logs. The memory-bridge tools were unavailable in this session, so no bridge read/write is claimed.

Final validation: production build passed; all 200 tests passed with `node --test --test-concurrency=1 "src/**/*.test.js" "server/**/*.test.js"`; browser reopen regression passed; the actual Electron window restored 18/18 and 6/32, displayed Chinese output, and submitted no translation requests. Parallel full-suite runs hit an existing Windows EPERM during a fake translator's fixture cleanup; serial execution passed without changing that test. The desktop was left on the survey's translated first page.
