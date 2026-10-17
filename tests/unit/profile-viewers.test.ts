/**
 * core/ProfileViewers — closing the viewer tab detaches the operator from the
 * profile's BROWSER (after a grace period), and never touches the hold.
 */
import { describe, it, expect, vi } from 'vitest';
import { ProfileViewers, viewerOf } from '../../src/core/ProfileViewers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('ProfileViewers', () => {
  it('maps a profile view socket to its lease and operator dependent', () => {
    expect(viewerOf('?profile=prf_ab12&workflowId=wf_abc123')).toEqual({ leaseId: 'named:prf_ab12', dependent: 'operator:wf_abc123' });
    expect(viewerOf('?profile=default')).toEqual({ leaseId: 'default', dependent: 'operator:operator' });
    expect(viewerOf('?x=1')).toBeNull();
  });

  it('detaches only after the LAST socket closed and the grace period passed', () => {
    vi.useFakeTimers();
    const detached: string[] = [];
    const v = new ProfileViewers(1000, (l, d) => detached.push(`${l}|${d}`));
    const a = v.connected('?profile=p1&workflowId=wf_abc123');
    const b = v.connected('?profile=p1&workflowId=wf_abc123');
    a();
    vi.advanceTimersByTime(5000);
    expect(detached).toEqual([]); // b is still connected
    b();
    vi.advanceTimersByTime(999);
    expect(detached).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(detached).toEqual(['named:p1|operator:wf_abc123']);
    vi.useRealTimers();
  });

  it('a reload (reconnect within the grace period) does not detach', () => {
    vi.useFakeTimers();
    const detached: string[] = [];
    const v = new ProfileViewers(1000, (l, d) => detached.push(`${l}|${d}`));
    v.connected('?profile=p2')();
    vi.advanceTimersByTime(500);
    const again = v.connected('?profile=p2');
    vi.advanceTimersByTime(5000);
    expect(detached).toEqual([]);
    expect(v.count('?profile=p2')).toBe(1);
    again(); again(); // idempotent close
    vi.advanceTimersByTime(1000);
    expect(detached.length).toBe(1);
    vi.useRealTimers();
  });

  it('the profile view puts profile + workflowId on its VNC socket; DesktopProxy reports it', () => {
    const cv = readFileSync(join(__dirname, '../../src/core/ChromeView.ts'), 'utf8');
    expect(cv).toMatch(/\/desktop\/websockify' \+ wsViewQuery/);
    const dp = readFileSync(join(__dirname, '../../src/core/DesktopProxy.ts'), 'utf8');
    expect(dp).toContain('profileViewers.connected(search)');
    // The module never releases a hold: only the browser dependent is detached.
    const pv = readFileSync(join(__dirname, '../../src/core/ProfileViewers.ts'), 'utf8');
    expect(pv).not.toMatch(/releaseHold\(/);
  });
});
