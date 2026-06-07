// ── Local development type shim for `n8n-workflow` ──────────────────────────
//
// `n8n-workflow` is a PEER dependency of this community node: at install time
// inside a real n8n instance, the genuine package (and its full, authoritative
// types) is resolved from node_modules and takes precedence over this file.
//
// This shim exists ONLY so the package can be type-checked / compiled in a
// standalone environment (CI, this sandbox) without installing n8n-workflow,
// whose transitive native deps (isolated-vm) require a C++ toolchain. It
// declares just the subset of the API surface this node uses. Keep it minimal.
//
// NOTE: When the real n8n-workflow is present, TypeScript uses it instead, so
// this never masks upstream type changes in production builds.

declare module 'n8n-workflow' {
  export type IHttpRequestMethods = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

  export interface IDataObject {
    [key: string]: unknown;
  }

  export interface IHttpRequestOptions {
    url: string;
    method?: IHttpRequestMethods;
    baseURL?: string;
    headers?: IDataObject;
    qs?: IDataObject;
    body?: unknown;
    json?: boolean;
    [key: string]: unknown;
  }

  export interface INodePropertyOptions {
    name: string;
    value: string | number | boolean;
    description?: string;
    action?: string;
  }

  export interface INodePropertyTypeOptions {
    password?: boolean;
    [key: string]: unknown;
  }

  export interface IDisplayOptions {
    show?: { [key: string]: Array<string | number | boolean> };
    hide?: { [key: string]: Array<string | number | boolean> };
  }

  export interface INodePropertyCollection {
    displayName: string;
    name: string;
    values: INodeProperties[];
  }

  export interface INodeProperties {
    displayName: string;
    name: string;
    type: string;
    default: unknown;
    description?: string;
    hint?: string;
    placeholder?: string;
    required?: boolean;
    noDataExpression?: boolean;
    options?: Array<INodePropertyOptions | INodePropertyCollection>;
    typeOptions?: INodePropertyTypeOptions;
    displayOptions?: IDisplayOptions;
  }

  export interface ICredentialTestRequest {
    request: {
      baseURL?: string;
      url: string;
      method?: IHttpRequestMethods;
    };
  }

  export interface IAuthenticateGeneric {
    type: 'generic';
    properties: {
      headers?: IDataObject;
      qs?: IDataObject;
      body?: IDataObject;
    };
  }

  export interface ICredentialType {
    name: string;
    displayName: string;
    documentationUrl?: string;
    properties: INodeProperties[];
    authenticate?: IAuthenticateGeneric;
    test?: ICredentialTestRequest;
  }

  export interface INodeExecutionData {
    json: IDataObject;
    pairedItem?: { item: number } | { item: number }[];
    [key: string]: unknown;
  }

  export interface IWebhookDescription {
    name: string;
    httpMethod: string;
    responseMode: string;
    path: string;
  }

  export interface INodeTypeDescription {
    displayName: string;
    name: string;
    icon?: string;
    group: string[];
    version: number;
    subtitle?: string;
    description: string;
    defaults: { name: string; [key: string]: unknown };
    inputs: string[];
    outputs: string[];
    credentials?: Array<{ name: string; required?: boolean }>;
    webhooks?: IWebhookDescription[];
    properties: INodeProperties[];
  }

  export interface IExecuteFunctions {
    getInputData(): INodeExecutionData[];
    getNodeParameter(name: string, itemIndex: number, fallback?: unknown): unknown;
    getCredentials(name: string): Promise<IDataObject>;
    getNode(): IDataObject;
    continueOnFail(): boolean;
    helpers: {
      httpRequestWithAuthentication: {
        call(context: unknown, credentialsType: string, options: IHttpRequestOptions): Promise<unknown>;
      };
      returnJsonArray(data: IDataObject[]): INodeExecutionData[];
    };
  }

  // Context passed to `methods.loadOptions.*` handlers. n8n calls these to
  // populate a dropdown (e.g. the list of saved workflows) before execution.
  export interface ILoadOptionsFunctions {
    getCredentials(name: string): Promise<IDataObject>;
    getNodeParameter(name: string, fallback?: unknown): unknown;
    getNode(): IDataObject;
    helpers: {
      httpRequestWithAuthentication: {
        call(context: unknown, credentialsType: string, options: IHttpRequestOptions): Promise<unknown>;
      };
      httpRequest: {
        call(context: unknown, options: IHttpRequestOptions): Promise<unknown>;
      };
    };
  }

  export interface IWebhookResponseData {
    workflowData?: INodeExecutionData[][];
    webhookResponse?: unknown;
    noWebhookResponse?: boolean;
  }

  export interface IncomingHttpHeaders {
    [key: string]: string | string[] | undefined;
  }

  export interface IWebhookRequestObject {
    headers: IncomingHttpHeaders;
    rawBody?: Buffer | string;
    [key: string]: unknown;
  }

  export interface IWebhookResponseObject {
    status(code: number): IWebhookResponseObject;
    json(body: unknown): IWebhookResponseObject;
  }

  export interface IWebhookFunctions {
    getRequestObject(): IWebhookRequestObject;
    getResponseObject(): IWebhookResponseObject;
    getBodyData(): IDataObject;
    getNodeParameter(name: string, fallback?: unknown): unknown;
    getCredentials(name: string): Promise<IDataObject>;
    getNode(): IDataObject;
    helpers: {
      returnJsonArray(data: IDataObject[]): INodeExecutionData[];
    };
  }

  export interface INodeType {
    description: INodeTypeDescription;
    methods?: {
      loadOptions?: {
        [methodName: string]: (this: ILoadOptionsFunctions) => Promise<INodePropertyOptions[]>;
      };
    };
    execute?(this: IExecuteFunctions): Promise<INodeExecutionData[][]>;
    webhook?(this: IWebhookFunctions): Promise<IWebhookResponseData>;
  }

  export class NodeOperationError extends Error {
    constructor(node: unknown, message: string, options?: { itemIndex?: number });
  }

  export class NodeApiError extends Error {
    constructor(node: unknown, error: IDataObject, options?: IDataObject);
  }
}
