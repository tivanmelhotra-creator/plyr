/**
 * RemoteConsent — in-browser consent flow for the remote browser mode.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * When an operator targets a field in the Remote Browser, no Authorization Code
 * is issued (remote browser sessions are direct and authenticated via the server's
 * loopback token). However, the extension popup running inside the remote browser
 * needs to know WHICH target field it is inspecting and armed for.
 *
 * Without a consent / targeting handoff:
 *   1. The operator clicks "Target This Field" in the web dashboard.
 *   2. The remote browser opens with loopback API credentials.
 *   3. The popup inspector shows "Connected" to the backend, but the target
 *      field ID is missing or empty.
 *   4. The send button remains disabled / dimmed.
 *   5. Selecting elements cannot route back to the intended workflow node field.
 *
 * With RemoteConsent:
 *   1. When targeting begins for environment = 'remote', the server creates an
 *      active consent offer for that user and target field.
 *   2. The content script (`consent.js`) injected into the remote browser polls
 *      `/inspector/consent/pending` (or receives a broadcast).
 *   3. A non-intrusive banner / prompt appears in the remote browser indicating
 *      which Node and Field are requesting element inspection.
 *   4. When accepted, the extension receives the target field metadata, sets
 *      `ab_targetFieldId` in storage, and arms the inspector.
 *   5. Switching to a different node/field supersedes previous pending consents
 *      without requiring the remote browser to restart.
 */

import crypto from 'crypto';

export type ConsentStatus = 'pending' | 'accepted' | 'rejected' | 'superseded' | 'expired';

export interface ConsentTarget {
  targetFieldId: string;
  nodeId: string;
  fieldKey: string;
  workflowId?: string;
  nodeName?: string;
  fieldName?: string;
  label?: string;
}

export interface ConsentOffer {
  id: string;
  userId: string;
  target: ConsentTarget;
  createdAt: number;
  expiresAt: number;
  status: ConsentStatus;
}

export type ConsentRefusal =
  | 'CONSENT_NOT_FOUND'
  | 'CONSENT_EXPIRED'
  | 'CONSENT_SUPERSEDED'
  | 'FORBIDDEN_PEER';

export const CONSENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class RemoteConsentRegistry {
  private offers = new Map<string, ConsentOffer>();
  private userActive = new Map<string, string>(); // userId -> offerId

  /**
   * Open a new consent offer for a user targeting a field in the remote browser.
   * Supersedes any existing pending offer for this user.
   */
  open(userId: string, target: ConsentTarget, ttlMs: number = CONSENT_TTL_MS, now: number = Date.now()): ConsentOffer {
    const existingId = this.userActive.get(userId);
    if (existingId) {
      const existing = this.offers.get(existingId);
      if (existing && existing.status === 'pending') {
        existing.status = 'superseded';
      }
    }

    const offer: ConsentOffer = {
      id: 'rc_' + crypto.randomBytes(12).toString('hex'),
      userId,
      target: { ...target },
      createdAt: now,
      expiresAt: now + ttlMs,
      status: 'pending'
    };

    this.offers.set(offer.id, offer);
    this.userActive.set(userId, offer.id);
    this.purgeStale(now);
    return offer;
  }

  /**
   * Get the current pending consent offer for a user.
   */
  getPending(userId: string, now: number = Date.now()): ConsentOffer | null {
    const id = this.userActive.get(userId);
    if (!id) return null;
    const offer = this.offers.get(id);
    if (!offer) return null;

    if (offer.status !== 'pending') return null;
    if (offer.expiresAt <= now) {
      offer.status = 'expired';
      return null;
    }
    return offer;
  }

  /**
   * Accept a pending consent offer.
   */
  accept(userId: string, offerId: string, now: number = Date.now()): { success: true; offer: ConsentOffer } | { success: false; reason: ConsentRefusal } {
    const offer = this.offers.get(offerId);
    if (!offer || offer.userId !== userId) {
      return { success: false, reason: 'CONSENT_NOT_FOUND' };
    }
    if (offer.status === 'superseded') {
      return { success: false, reason: 'CONSENT_SUPERSEDED' };
    }
    if (offer.expiresAt <= now || offer.status === 'expired') {
      offer.status = 'expired';
      return { success: false, reason: 'CONSENT_EXPIRED' };
    }

    offer.status = 'accepted';
    return { success: true, offer };
  }

  /**
   * Reject / dismiss a pending consent offer.
   */
  reject(userId: string, offerId: string): boolean {
    const offer = this.offers.get(offerId);
    if (!offer || offer.userId !== userId) return false;
    if (offer.status === 'pending') {
      offer.status = 'rejected';
      return true;
    }
    return false;
  }

  /**
   * Clear all records (useful for testing).
   */
  clear(): void {
    this.offers.clear();
    this.userActive.clear();
  }

  private purgeStale(now: number): void {
    for (const [id, offer] of this.offers.entries()) {
      if (offer.expiresAt + 3600000 < now) {
        this.offers.delete(id);
      }
    }
  }
}

export const remoteConsent = new RemoteConsentRegistry();

/**
 * Check whether a request comes from the local server host (loopback).
 */
export function isSameHostPeer(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const clean = remoteAddress.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}
