// Integration-test environment bootstrap.
// Force a deterministic config BEFORE any src module (which imports
// src/config.ts -> dotenv) is loaded. vitest's `setupFiles` runs this first.
// One install = one owner: the instance is protected by ONE access token.
// `test_key_123` is that token for every integration suite. NODE_ENV=test is
// not development, so keyless local access is OFF: every request must carry it.
process.env.API_TOKEN = 'test_key_123';
process.env.CORS_ALLOWED_ORIGINS = '*';
process.env.NODE_ENV = 'test';
// Step 29: deterministic secret for shareable live-view tokens.
process.env.LIVE_SHARE_SECRET = 'test_live_share_secret';
// Keep Redis URL pointing at the default local instance; integration tests that
// need Redis probe it and self-skip when it is unavailable.
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
