import { createHmac, timingSafeEqual } from 'crypto';
import type {
  IWebhookFunctions,
  IWebhookResponseData,
  INodeType,
  INodeTypeDescription,
  IDataObject,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Constant-time verification of the backend's `X-Signature` header.
 *
 * Mirrors src/utils/signature.ts on the backend: HMAC-SHA256 over the EXACT raw
 * request body, hex-encoded, optionally prefixed with `sha256=`. Returns false
 * on any length/format mismatch instead of throwing.
 */
function verifySignature(body: string, secret: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const provided = signature.startsWith(SIGNATURE_PREFIX)
    ? signature.slice(SIGNATURE_PREFIX.length)
    : signature;
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export class AutomationBackendTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Automation Backend Trigger',
    name: 'automationBackendTrigger',
    icon: 'file:automationBackendTrigger.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["events"]}}',
    description: 'Starts a workflow when the Automation Backend sends a job- or step-level webhook (with optional HMAC verification)',
    defaults: {
      name: 'Automation Backend Trigger',
    },
    inputs: [],
    outputs: ['main'],
    credentials: [
      {
        // Optional: only needed when you want HMAC signature verification.
        name: 'automationBackendApi',
        required: false,
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName:
          'Set the backend job <code>webhookUrl</code> (or the Run/Schedule node Webhook URL) to this node\'s Production URL.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        options: [
          { name: 'Job Completed', value: 'job.completed' },
          { name: 'Job Failed', value: 'job.failed' },
          { name: 'Job Cancelled', value: 'job.cancelled' },
          { name: 'Job Blocked', value: 'job.blocked' },
          { name: 'Quota Exhausted', value: 'job.quota_exhausted' },
          // Step 29: per-step live events (two-channel reporting). These
          // arrive when the backend has STEP_WEBHOOK_ENABLED=true and a
          // webhookUrl is set on the job.
          { name: 'Step Started', value: 'step.start' },
          { name: 'Step Done', value: 'step.done' },
          { name: 'Step Error', value: 'step.error' },
          { name: 'Step Retry', value: 'step.retry' },
        ],
        default: ['job.completed', 'job.failed'],
        description:
          'Only emit for these events. Includes job-level and (Step 29) per-step events. Leave empty to accept all events.',
      },
      {
        displayName: 'Verify Signature',
        name: 'verifySignature',
        type: 'boolean',
        default: true,
        description:
          'Whether to verify the X-Signature (HMAC-SHA256) header using the Webhook Secret from the credential. Unsigned/invalid requests are rejected with 401.',
      },
    ],
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject();
    const resp = this.getResponseObject();
    const bodyData = this.getBodyData() as IDataObject;

    const verify = this.getNodeParameter('verifySignature', true) as boolean;
    const selectedEvents = this.getNodeParameter('events', []) as string[];

    // ── 1. Optional HMAC verification ──
    if (verify) {
      const credentials = await this.getCredentials('automationBackendApi').catch(() => null);
      const secret = (credentials?.webhookSecret as string) || '';

      if (!secret) {
        throw new NodeOperationError(
          this.getNode(),
          'Verify Signature is enabled but no Webhook Secret is configured in the Automation Backend API credential.',
        );
      }

      // n8n parses JSON bodies; re-serialize to recover the bytes the backend
      // signed. The backend signs JSON.stringify(payload) with no extra spaces,
      // which matches JSON.stringify here for the same object.
      const rawBody =
        typeof (req as unknown as { rawBody?: Buffer | string }).rawBody !== 'undefined' &&
        (req as unknown as { rawBody?: Buffer | string }).rawBody
          ? (req as unknown as { rawBody: Buffer | string }).rawBody.toString()
          : JSON.stringify(bodyData);

      const headerSig = (req.headers['x-signature'] || req.headers['X-Signature']) as
        | string
        | undefined;

      if (!verifySignature(rawBody, secret, headerSig)) {
        resp.status(401).json({ success: false, error: 'Invalid signature' });
        return { noWebhookResponse: true };
      }
    }

    // ── 2. Optional event filtering ──
    const event = (bodyData.event as string) || '';
    if (selectedEvents.length > 0 && event && !selectedEvents.includes(event)) {
      // Acknowledge but do not start the workflow for unselected events.
      return { webhookResponse: { success: true, ignored: true }, noWebhookResponse: false };
    }

    // ── 3. Emit the payload into the workflow ──
    return {
      workflowData: [this.helpers.returnJsonArray([bodyData])],
    };
  }
}
