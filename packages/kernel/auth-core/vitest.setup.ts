/**
 * auth-core test setup: provision a dev api-key pepper so the positive HMAC tests run. The
 * boot-fails-closed test (api-key.test.ts) explicitly unsets it to prove getApiKeyPepper()
 * throws when it is missing. We do NOT overwrite a pepper already supplied by the env.
 */
if (!process.env.RAYSPEC_API_KEY_PEPPER) {
  process.env.RAYSPEC_API_KEY_PEPPER = 'dev-pepper-for-tests-only';
}
