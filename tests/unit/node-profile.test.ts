/** core/NodeProfile — the profile chosen on a Launch Browser node. */
import { describe, it, expect } from 'vitest';
import { launchProfilesOf, runProfileIdOf } from '../../src/core/NodeProfile';
import { validateSteps } from '../../src/validation';
import { config } from '../../src/config';

const launch = (profileId?: string, extra: Record<string, unknown> = {}) => ({ action: 'launch', params: profileId ? { profileId } : {}, ...extra });

describe('NodeProfile', () => {
  it('no Launch profile -> the workflow profile; one -> that one (nested too)', () => {
    expect(runProfileIdOf([launch()], 'shop')).toBe('shop');
    expect(runProfileIdOf([launch('prf_ab')], 'shop')).toBe('prf_ab');
    expect(runProfileIdOf([{ action: 'if', then: [launch('prf_n')] }], null)).toBe('prf_n');
    expect(runProfileIdOf([{ action: 'click', errorSteps: [launch('prf_e')] }], null)).toBe('prf_e');
    expect(runProfileIdOf([launch('prf_x', { disabled: true })], 'shop')).toBe('shop');
    expect(runProfileIdOf([], null)).toBeNull();
  });
  it('the same profile twice is one; garbage ids are dropped', () => {
    expect(launchProfilesOf([launch('a1'), launch('a1')])).toEqual(['a1']);
    expect(launchProfilesOf([launch('../../etc')]).every((id) => !id.includes('/'))).toBe(true);
  });
  it('validation refuses Launch nodes that name different profiles', () => {
    expect(() => validateSteps([launch('p1'), launch('p2')] as never, config.FULL_ACCESS_PLAN)).toThrow(/different profiles/);
    expect(validateSteps([launch('p1'), launch('p1')] as never, config.FULL_ACCESS_PLAN)).toHaveLength(2);
  });
});
