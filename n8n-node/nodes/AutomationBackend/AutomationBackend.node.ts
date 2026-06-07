import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  IDataObject,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  IHttpRequestMethods,
  IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeOperationError, NodeApiError } from 'n8n-workflow';

// ── Helpers ────────────────────────────────────────────────────────────────

// Strip a trailing slash so we can safely concatenate paths.
export function normalizeBase(url: string): string {
  return (url || '').trim().replace(/\/+$/, '');
}

// Parse the `steps` parameter, which may be supplied as JSON text or already an
// array/object (when wired from a previous node). Always returns an array.
function parseSteps(this: IExecuteFunctions, raw: unknown, itemIndex: number): IDataObject[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (err) {
      throw new NodeOperationError(
        this.getNode(),
        `Steps must be valid JSON: ${(err as Error).message}`,
        { itemIndex },
      );
    }
  }
  if (!Array.isArray(value)) {
    throw new NodeOperationError(this.getNode(), 'Steps must be a JSON array', { itemIndex });
  }
  return value as IDataObject[];
}

// Parse the optional trigger-data JSON (object). Empty / blank -> undefined.
// Used by the Saved-Workflow operation to inject the first node's input items.
export function parseTriggerData(raw: unknown): IDataObject | undefined {
  if (raw === undefined || raw === null) return undefined;
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '{}') return undefined;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Trigger Data must be valid JSON object: ${(err as Error).message}`);
    }
  }
  if (Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Trigger Data must be a JSON object');
  }
  const obj = value as IDataObject;
  return Object.keys(obj).length ? obj : undefined;
}

// ── Pure request builder (unit-testable, no n8n runtime needed) ─────────────
//
// Translates the node's resolved parameters into the exact HTTP request the
// backend expects. Kept side-effect-free so the payload contract can be
// asserted in CI against the documented endpoints without booting n8n.
export interface BuildRequestParams {
  operation: string;
  userId: string;
  // run / schedule
  steps?: IDataObject[];
  headless?: boolean;
  webhookUrl?: string;
  // run / runSaved
  wait?: boolean;
  idempotencyKey?: string;
  // runSaved
  workflowId?: string;
  triggerData?: IDataObject;
  // schedule
  cron?: string;
  scheduleName?: string;
  // getJob / cancel
  jobId?: string;
  closeBrowser?: boolean;
  closeTab?: boolean;
}

export interface BuiltRequest {
  method: IHttpRequestMethods;
  url: string;
  qs: IDataObject;
  headers: IDataObject;
  body?: IDataObject;
}

export function buildRequestOptions(baseUrl: string, p: BuildRequestParams): BuiltRequest {
  const base = normalizeBase(baseUrl);
  const enc = encodeURIComponent;
  const qs: IDataObject = {};
  const headers: IDataObject = {};

  switch (p.operation) {
    case 'run': {
      const body: IDataObject = {
        userId: p.userId,
        steps: p.steps ?? [],
        headless: p.headless ?? true,
      };
      if (p.webhookUrl) body.webhookUrl = p.webhookUrl;
      if (p.wait) qs.wait = 'true';
      if (p.idempotencyKey) headers['Idempotency-Key'] = p.idempotencyKey;
      return { method: 'POST', url: `${base}/run`, qs, headers, body };
    }

    case 'runSaved': {
      // Model B: run a previously SAVED, versioned workflow by id.
      // POST /workflows/:userId/:workflowId/run  (same ?wait + Idempotency-Key
      // contract as /run). Body optionally overrides headless/webhookUrl and
      // injects triggerData for the first node.
      const body: IDataObject = {};
      if (p.headless !== undefined) body.headless = p.headless;
      if (p.webhookUrl) body.webhookUrl = p.webhookUrl;
      if (p.triggerData) body.triggerData = p.triggerData;
      if (p.wait) qs.wait = 'true';
      if (p.idempotencyKey) headers['Idempotency-Key'] = p.idempotencyKey;
      return {
        method: 'POST',
        url: `${base}/workflows/${enc(p.userId)}/${enc(p.workflowId ?? '')}/run`,
        qs,
        headers,
        body,
      };
    }

    case 'schedule': {
      const body: IDataObject = {
        userId: p.userId,
        steps: p.steps ?? [],
        headless: p.headless ?? true,
        cron: p.cron ?? '',
      };
      if (p.scheduleName) body.name = p.scheduleName;
      if (p.webhookUrl) body.webhookUrl = p.webhookUrl;
      return { method: 'POST', url: `${base}/schedule`, qs, headers, body };
    }

    case 'getJob': {
      return {
        method: 'GET',
        url: `${base}/job/${enc(p.userId)}/${enc(p.jobId ?? '')}`,
        qs,
        headers,
      };
    }

    case 'cancel': {
      if (p.closeBrowser) qs.closeBrowser = 'true';
      if (p.closeTab) qs.closeTab = 'true';
      return {
        method: 'DELETE',
        url: `${base}/cancel/${enc(p.userId)}/${enc(p.jobId ?? '')}`,
        qs,
        headers,
      };
    }

    default:
      throw new Error(`Unknown operation: ${p.operation}`);
  }
}

export class AutomationBackend implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Automation Backend',
    name: 'automationBackend',
    icon: 'file:automationBackend.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Run, schedule, and manage browser-automation jobs on a self-hosted Automation Backend',
    defaults: {
      name: 'Automation Backend',
    },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      {
        name: 'automationBackendApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Run Saved Workflow',
            value: 'runSaved',
            action: 'Run a saved workflow',
            description: 'Run a previously saved & versioned workflow by id (POST /workflows/:userId/:workflowId/run) — the recommended "Model B" integration',
          },
          {
            name: 'Run Inline Workflow',
            value: 'run',
            action: 'Run an inline workflow',
            description: 'Submit an inline steps array to POST /run (optionally wait for the result)',
          },
          {
            name: 'Get Job Result',
            value: 'getJob',
            action: 'Get a job result',
            description: 'Fetch a job status / result from GET /job/:userId/:jobId',
          },
          {
            name: 'Create Schedule',
            value: 'schedule',
            action: 'Create a recurring schedule',
            description: 'Create a cron schedule via POST /schedule',
          },
          {
            name: 'Cancel Job',
            value: 'cancel',
            action: 'Cancel a job',
            description: 'Cancel a queued / running job via DELETE /cancel/:userId/:jobId',
          },
        ],
        default: 'runSaved',
      },

      // ── Common: userId ──
      {
        displayName: 'User ID',
        name: 'userId',
        type: 'string',
        default: '',
        required: true,
        description: 'Backend user the job belongs to (e.g. "local" in single-user mode)',
      },

      // ── runSaved: workflow selector (loadOptions from /workflows) ──
      {
        displayName: 'Workflow Name or ID',
        name: 'workflowId',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getWorkflows',
          loadOptionsDependsOn: ['userId'],
        },
        default: '',
        required: true,
        description:
          'Choose a saved workflow from the list, or specify its id using an expression. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: {
          show: { operation: ['runSaved'] },
        },
      },
      {
        displayName: 'Trigger Data (JSON)',
        name: 'triggerData',
        type: 'json',
        default: '{}',
        description:
          'Optional JSON object injected as the first node\'s input items (Manual/Webhook trigger data). Leave as {} for none.',
        displayOptions: {
          show: { operation: ['runSaved'] },
        },
      },

      // ── run / schedule: steps ──
      {
        displayName: 'Steps (JSON)',
        name: 'steps',
        type: 'json',
        default: '[\n  { "action": "goto", "params": { "url": "https://example.com" } }\n]',
        required: true,
        description: 'Array of automation steps ({ action, params }). JSON array.',
        displayOptions: {
          show: { operation: ['run', 'schedule'] },
        },
      },

      // ── headless / webhookUrl: shared by run / runSaved / schedule ──
      {
        displayName: 'Headless',
        name: 'headless',
        type: 'boolean',
        default: true,
        description: 'Whether to run the browser headless',
        displayOptions: {
          show: { operation: ['run', 'runSaved', 'schedule'] },
        },
      },
      {
        displayName: 'Webhook URL',
        name: 'webhookUrl',
        type: 'string',
        default: '',
        placeholder: 'https://my-n8n/webhook/automation',
        description: 'Optional URL the backend notifies on completion (e.g. an Automation Backend Trigger node). For Run Saved Workflow this overrides the stored value for this run only.',
        displayOptions: {
          show: { operation: ['run', 'runSaved', 'schedule'] },
        },
      },

      // ── run / runSaved: sync + idempotency ──
      {
        displayName: 'Wait for Completion',
        name: 'wait',
        type: 'boolean',
        default: false,
        description: 'Whether to block until the job finishes and return its result inline (?wait=true)',
        displayOptions: {
          show: { operation: ['run', 'runSaved'] },
        },
      },
      {
        displayName: 'Idempotency Key',
        name: 'idempotencyKey',
        type: 'string',
        default: '',
        description: 'Optional. Retrying with the same key returns the original job instead of creating a duplicate.',
        displayOptions: {
          show: { operation: ['run', 'runSaved'] },
        },
      },

      // ── schedule: cron + name ──
      {
        displayName: 'Cron Expression',
        name: 'cron',
        type: 'string',
        default: '0 9 * * *',
        required: true,
        placeholder: '0 9 * * *',
        description: '5- or 6-field cron expression',
        displayOptions: {
          show: { operation: ['schedule'] },
        },
      },
      {
        displayName: 'Schedule Name',
        name: 'scheduleName',
        type: 'string',
        default: '',
        description: 'Optional human-readable name for the schedule',
        displayOptions: {
          show: { operation: ['schedule'] },
        },
      },

      // ── getJob / cancel: jobId ──
      {
        displayName: 'Job ID',
        name: 'jobId',
        type: 'string',
        default: '',
        required: true,
        description: 'The job identifier returned by Run Workflow',
        displayOptions: {
          show: { operation: ['getJob', 'cancel'] },
        },
      },

      // ── cancel: extra options ──
      {
        displayName: 'Close Browser',
        name: 'closeBrowser',
        type: 'boolean',
        default: false,
        description: 'Whether to force-close the whole browser context',
        displayOptions: {
          show: { operation: ['cancel'] },
        },
      },
      {
        displayName: 'Close Tab',
        name: 'closeTab',
        type: 'boolean',
        default: false,
        description: 'Whether to close only the job tab/page',
        displayOptions: {
          show: { operation: ['cancel'] },
        },
      },
    ],
  };

  // ── loadOptions: populate the Saved-Workflow dropdown ─────────────────────
  // Calls GET /workflows/:userId and maps each record to { name, value }.
  // The label shows the workflow name + version; the value is its id.
  methods = {
    loadOptions: {
      async getWorkflows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials('automationBackendApi');
        const baseUrl = normalizeBase(credentials.baseUrl as string);
        const userId = String(this.getNodeParameter('userId', '') || '').trim();
        if (!userId) {
          // Without a userId we cannot list workflows; show a hint entry.
          return [{ name: '⚠ Set "User ID" first', value: '' }];
        }

        const response = (await this.helpers.httpRequestWithAuthentication.call(
          this,
          'automationBackendApi',
          {
            method: 'GET',
            url: `${baseUrl}/workflows/${encodeURIComponent(userId)}`,
            json: true,
          } as IHttpRequestOptions,
        )) as IDataObject;

        const list = Array.isArray((response as IDataObject)?.workflows)
          ? ((response as IDataObject).workflows as IDataObject[])
          : [];

        const options: INodePropertyOptions[] = list
          .filter((wf) => wf && typeof wf.id === 'string')
          .map((wf) => {
            const name = (wf.name as string) || (wf.id as string);
            const version = wf.version !== undefined ? ` (v${wf.version})` : '';
            return {
              name: `${name}${version}`,
              value: wf.id as string,
              description: (wf.description as string) || undefined,
            };
          });

        if (!options.length) {
          return [{ name: 'No saved workflows found', value: '' }];
        }
        return options;
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    const credentials = await this.getCredentials('automationBackendApi');
    const baseUrl = normalizeBase(credentials.baseUrl as string);

    for (let i = 0; i < items.length; i++) {
      try {
        const operation = this.getNodeParameter('operation', i) as string;
        const userId = this.getNodeParameter('userId', i) as string;

        // Collect the parameters relevant to this operation, then delegate the
        // payload shaping to the pure builder so behaviour matches the tests.
        const params: BuildRequestParams = { operation, userId };

        if (operation === 'run') {
          params.steps = parseSteps.call(this, this.getNodeParameter('steps', i), i);
          params.headless = this.getNodeParameter('headless', i) as boolean;
          params.webhookUrl = this.getNodeParameter('webhookUrl', i, '') as string;
          params.wait = this.getNodeParameter('wait', i, false) as boolean;
          params.idempotencyKey = this.getNodeParameter('idempotencyKey', i, '') as string;
        } else if (operation === 'runSaved') {
          const workflowId = String(this.getNodeParameter('workflowId', i) || '').trim();
          if (!workflowId) {
            throw new NodeOperationError(this.getNode(), 'No workflow selected', { itemIndex: i });
          }
          params.workflowId = workflowId;
          params.headless = this.getNodeParameter('headless', i, true) as boolean;
          params.webhookUrl = this.getNodeParameter('webhookUrl', i, '') as string;
          params.wait = this.getNodeParameter('wait', i, false) as boolean;
          params.idempotencyKey = this.getNodeParameter('idempotencyKey', i, '') as string;
          try {
            params.triggerData = parseTriggerData(this.getNodeParameter('triggerData', i, '{}'));
          } catch (err) {
            throw new NodeOperationError(this.getNode(), (err as Error).message, { itemIndex: i });
          }
        } else if (operation === 'schedule') {
          params.steps = parseSteps.call(this, this.getNodeParameter('steps', i), i);
          params.headless = this.getNodeParameter('headless', i) as boolean;
          params.webhookUrl = this.getNodeParameter('webhookUrl', i, '') as string;
          params.cron = this.getNodeParameter('cron', i) as string;
          params.scheduleName = this.getNodeParameter('scheduleName', i, '') as string;
        } else if (operation === 'getJob') {
          params.jobId = this.getNodeParameter('jobId', i) as string;
        } else if (operation === 'cancel') {
          params.jobId = this.getNodeParameter('jobId', i) as string;
          params.closeBrowser = this.getNodeParameter('closeBrowser', i, false) as boolean;
          params.closeTab = this.getNodeParameter('closeTab', i, false) as boolean;
        } else {
          throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
            itemIndex: i,
          });
        }

        const built = buildRequestOptions(baseUrl, params);

        const options: IHttpRequestOptions = {
          method: built.method,
          url: built.url,
          qs: built.qs,
          headers: built.headers,
          json: true,
        };
        if (built.body !== undefined) options.body = built.body;

        const response = (await this.helpers.httpRequestWithAuthentication.call(
          this,
          'automationBackendApi',
          options,
        )) as IDataObject;

        returnData.push({
          json: response,
          pairedItem: { item: i },
        });
      } catch (error) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: (error as Error).message },
            pairedItem: { item: i },
          });
          continue;
        }
        if (error instanceof NodeOperationError) throw error;
        throw new NodeApiError(this.getNode(), error as IDataObject);
      }
    }

    return [returnData];
  }
}
