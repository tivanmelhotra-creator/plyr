import { describe, it, expect } from 'vitest';
import { validateBackgroundHeadless } from '../../src/validation';

// docs/uiux/new ui.md §9: Active / background runs are hidden by default,
// regardless of DEFAULT_HEADLESS; an explicit value still wins.
describe('validateBackgroundHeadless', () => {
  it('defaults to headless when nothing is specified', () => {
    expect(validateBackgroundHeadless(undefined)).toBe(true);
    expect(validateBackgroundHeadless(null)).toBe(true);
    expect(validateBackgroundHeadless('garbage')).toBe(true);
  });
  it('honours an explicit choice', () => {
    expect(validateBackgroundHeadless(false)).toBe(false);
    expect(validateBackgroundHeadless('false')).toBe(false);
    expect(validateBackgroundHeadless(true)).toBe(true);
  });
});
