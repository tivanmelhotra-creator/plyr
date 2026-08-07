import { describe, it, expect } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../../src/core/RemoteUploads';

describe('§3 — Remote Upload & Download parity and edge cases', () => {
  it('defines MAX_UPLOAD_BYTES correctly as 32MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(32 * 1024 * 1024);
  });
});

