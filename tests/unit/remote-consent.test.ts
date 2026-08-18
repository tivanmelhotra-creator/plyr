import { describe, it, expect, beforeEach } from 'vitest';
import { RemoteConsentRegistry, type ConsentTarget } from '../../src/core/RemoteConsent';

describe('RemoteConsentRegistry', () => {
  let registry: RemoteConsentRegistry;

  const sampleTarget: ConsentTarget = {
    targetFieldId: 'tf_123',
    nodeId: 'node_abc',
    fieldKey: 'selector',
    workflowId: 'wf_1',
    nodeName: 'Click Element',
    fieldName: 'Target Selector'
  };

  beforeEach(() => {
    registry = new RemoteConsentRegistry();
  });

  it('opens a pending consent offer and retrieves it', () => {
    const offer = registry.open('user_1', sampleTarget);
    expect(offer.id).toMatch(/^rc_/);
    expect(offer.status).toBe('pending');
    expect(offer.target.targetFieldId).toBe('tf_123');

    const pending = registry.getPending('user_1');
    expect(pending).not.toBeNull();
    expect(pending?.id).toBe(offer.id);
  });

  it('accepts a pending offer', () => {
    const offer = registry.open('user_1', sampleTarget);
    const result = registry.accept('user_1', offer.id);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.offer.status).toBe('accepted');
    }

    expect(registry.getPending('user_1')).toBeNull();
  });

  it('supersedes previous offer when opening a new one', () => {
    const offer1 = registry.open('user_1', sampleTarget);
    const offer2 = registry.open('user_1', { ...sampleTarget, targetFieldId: 'tf_456' });

    expect(registry.getPending('user_1')?.id).toBe(offer2.id);

    const accept1 = registry.accept('user_1', offer1.id);
    expect(accept1.success).toBe(false);
    if (!accept1.success) {
      expect(accept1.reason).toBe('CONSENT_SUPERSEDED');
    }
  });

  it('expires offers past TTL', () => {
    const now = 100000;
    const offer = registry.open('user_1', sampleTarget, 5000, now);
    expect(registry.getPending('user_1', now + 6000)).toBeNull();

    const result = registry.accept('user_1', offer.id, now + 6000);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('CONSENT_EXPIRED');
    }
  });

  it('rejects an offer', () => {
    const offer = registry.open('user_1', sampleTarget);
    const ok = registry.reject('user_1', offer.id);
    expect(ok).toBe(true);
    expect(registry.getPending('user_1')).toBeNull();
  });
});
