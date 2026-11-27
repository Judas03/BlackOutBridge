import { z } from 'zod';
import {
  CatalogSnapshot,
  CatalogSnapshotSchema,
  ConfirmedSale,
  ConfirmedSaleSchema,
  ImportResult,
  ImportResultSchema,
  ISSUE_CODES,
  IssueCode,
  PosConnector,
  PreviewItem,
  PreviewItemSchema,
} from '../domain';

export const UNKNOWN_BACKEND_ISSUE = 'UNKNOWN_BACKEND_ISSUE' as const;

export type SanitizedIssueCode = IssueCode | typeof UNKNOWN_BACKEND_ISSUE;

const ALLOWED_ISSUE_CODE_SET: ReadonlySet<string> = new Set(ISSUE_CODES);

/**
 * Maps an arbitrary backend issue code to the canonical ISSUE_CODES allowlist or UNKNOWN_BACKEND_ISSUE.
 */
export function sanitizeIssueCode(code: string): SanitizedIssueCode {
  return ALLOWED_ISSUE_CODE_SET.has(code) ? (code as IssueCode) : UNKNOWN_BACKEND_ISSUE;
}

/**
 * Sanitizes and deduplicates an array of issue codes while preserving order.
 */
export function sanitizeIssueCodes(codes: readonly string[]): SanitizedIssueCode[] {
  const seen = new Set<SanitizedIssueCode>();
  const sanitized: SanitizedIssueCode[] = [];
  for (const code of codes) {
    const mapped = sanitizeIssueCode(code);
    if (!seen.has(mapped)) {
      seen.add(mapped);
      sanitized.push(mapped);
    }
  }
  return sanitized;
}

export type ConnectorErrorCode =
  | 'AUTH_REQUIRED'
  | 'ACCESS_DENIED'
  | 'NOT_FOUND'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'SERVER_ERROR'
  | 'INVALID_RESPONSE'
  | 'INVALID_REQUEST';

const SAFE_CODE_DESCRIPTIONS: Record<SanitizedIssueCode | ConnectorErrorCode, string> = {
  UNKNOWN_ITEM: 'An item in this sale no longer matches the POS catalog. Review and map manually.',
  UNSUPPORTED_MODIFIER:
    'A selected modifier is not supported by the POS backend. Review and resolve manually.',
  SNAPSHOT_MISSING:
    'The backend no longer recognizes the catalog snapshot used for this sale. Manager review required.',
  PRICE_MISMATCH:
    'Captured item or modifier prices differ from the approved historical snapshot. Manager review required.',
  TOTAL_MISMATCH:
    'Sale total does not match the backend validation of the captured lines. Manager review required.',
  PAYLOAD_CONFLICT:
    'This sale ID already exists on the POS backend with different financial contents. Do not overwrite; investigate duplicate ID.',
  UNSUPPORTED_PAYMENT_STATE:
    'This payment state (such as unpaid or unverified external reference) requires manual POS settlement or review.',
  UNKNOWN_BACKEND_ISSUE:
    'The POS backend flagged this sale for manual review.',
  AUTH_REQUIRED:
    'POS authentication is missing or expired. Sign in again to resume recovery; local sales remain safe.',
  ACCESS_DENIED:
    'POS access was revoked for this device or user. Recovery is paused for review; local sales remain safe.',
  NOT_FOUND: 'No committed import record exists on the POS backend for this sale.',
  NETWORK_ERROR: 'Unable to reach the POS backend. Retry when connectivity returns.',
  TIMEOUT: 'The POS backend request timed out before a response arrived. Retry to reconcile status.',
  SERVER_ERROR: 'The POS backend returned a temporary server error. Retry shortly.',
  INVALID_RESPONSE:
    'The POS backend returned an unexpected response format. Local records were not marked imported.',
  INVALID_REQUEST:
    'The recovery request could not be validated before sending to the POS backend.',
};

/**
 * Returns a safe, actionable message for a sanitized issue code or connector error code.
 * Never echoes raw backend payloads or stack traces.
 */
export function describeRecoveryCode(code: string): string {
  if (Object.prototype.hasOwnProperty.call(SAFE_CODE_DESCRIPTIONS, code)) {
    return SAFE_CODE_DESCRIPTIONS[code as SanitizedIssueCode | ConnectorErrorCode];
  }
  return SAFE_CODE_DESCRIPTIONS.UNKNOWN_BACKEND_ISSUE;
}

/**
 * Typed, sanitized error raised by the HTTP POS connector.
 * Error messages are static and never expose raw backend bodies or credentials.
 */
export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly httpStatus?: number;
  readonly retriable: boolean;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    options?: { httpStatus?: number; retriable?: boolean }
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.httpStatus = options?.httpStatus;
    this.retriable = options?.retriable ?? false;
  }
}

export function isConnectorError(error: unknown): error is ConnectorError {
  return error instanceof ConnectorError;
}

export function isAuthConnectorError(error: unknown): error is ConnectorError {
  return (
    isConnectorError(error) &&
    (error.code === 'AUTH_REQUIRED' || error.code === 'ACCESS_DENIED')
  );
}

export function isRetriableConnectorError(error: unknown): error is ConnectorError {
  return isConnectorError(error) && error.retriable;
}

export const PreviewResponseSchema = z.strictObject({
  results: z.array(PreviewItemSchema),
});

export const CommitResponseSchema = z.strictObject({
  results: z.array(ImportResultSchema),
});

export type HttpPosConnectorConfig = {
  baseUrl: string;
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  credentials?: RequestCredentials;
};

const DEFAULT_TIMEOUT_MS = 15_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { name?: unknown }).name === 'AbortError';
}

function validateSalesInput(sales: readonly ConfirmedSale[]): ConfirmedSale[] {
  const validated: ConfirmedSale[] = [];
  for (const sale of sales) {
    const parsed = ConfirmedSaleSchema.safeParse(sale);
    if (!parsed.success) {
      throw new ConnectorError(
        'INVALID_REQUEST',
        SAFE_CODE_DESCRIPTIONS.INVALID_REQUEST,
        { retriable: false }
      );
    }
    validated.push(parsed.data);
  }
  return validated;
}

function mapHttpFailure(status: number): ConnectorError {
  if (status === 401) {
    return new ConnectorError('AUTH_REQUIRED', SAFE_CODE_DESCRIPTIONS.AUTH_REQUIRED, {
      httpStatus: 401,
      retriable: false,
    });
  }
  if (status === 403) {
    return new ConnectorError('ACCESS_DENIED', SAFE_CODE_DESCRIPTIONS.ACCESS_DENIED, {
      httpStatus: 403,
      retriable: false,
    });
  }
  if (status === 404) {
    return new ConnectorError('NOT_FOUND', SAFE_CODE_DESCRIPTIONS.NOT_FOUND, {
      httpStatus: 404,
      retriable: false,
    });
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new ConnectorError('SERVER_ERROR', SAFE_CODE_DESCRIPTIONS.SERVER_ERROR, {
      httpStatus: status,
      retriable: true,
    });
  }
  return new ConnectorError('INVALID_REQUEST', SAFE_CODE_DESCRIPTIONS.INVALID_REQUEST, {
    httpStatus: status,
    retriable: false,
  });
}

function normalizeImportResult(item: ImportResult, expectedSaleId?: string): ImportResult {
  if (expectedSaleId !== undefined && item.saleId !== expectedSaleId) {
    throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
      retriable: false,
    });
  }
  if (
    (item.status === 'IMPORTED' || item.status === 'ALREADY_IMPORTED') &&
    (!item.destinationReceiptId || item.destinationReceiptId.trim().length === 0)
  ) {
    throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
      retriable: false,
    });
  }
  return {
    saleId: item.saleId,
    status: item.status,
    ...(item.destinationReceiptId ? { destinationReceiptId: item.destinationReceiptId } : {}),
    issueCodes: sanitizeIssueCodes(item.issueCodes),
  };
}

function normalizePreviewItem(item: PreviewItem, expectedSaleId: string): PreviewItem {
  if (item.saleId !== expectedSaleId) {
    throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
      retriable: false,
    });
  }
  if (
    item.status === 'ALREADY_IMPORTED' &&
    (!item.destinationReceiptId || item.destinationReceiptId.trim().length === 0)
  ) {
    throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
      retriable: false,
    });
  }
  return {
    saleId: item.saleId,
    status: item.status,
    issueCodes: sanitizeIssueCodes(item.issueCodes),
    ...(item.destinationReceiptId ? { destinationReceiptId: item.destinationReceiptId } : {}),
  };
}

/**
 * Browser/Node HTTP adapter implementing the canonical PosConnector contract against /api/continuity/*.
 */
export class HttpPosConnector implements PosConnector {
  private readonly baseUrl: string;
  private readonly getAuthHeaders?: HttpPosConnectorConfig['getAuthHeaders'];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly credentials: RequestCredentials;

  constructor(config: HttpPosConnectorConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.getAuthHeaders = config.getAuthHeaders;
    const resolvedFetch = config.fetchImpl ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new ConnectorError('NETWORK_ERROR', SAFE_CODE_DESCRIPTIONS.NETWORK_ERROR, {
        retriable: true,
      });
    }
    this.fetchImpl = resolvedFetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.credentials = config.credentials ?? 'same-origin';
  }

  private async requestJson(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string }
  ): Promise<unknown> {
    let authHeaders: Record<string, string> = {};
    if (this.getAuthHeaders) {
      try {
        authHeaders = await this.getAuthHeaders();
      } catch (error) {
        if (isConnectorError(error)) throw error;
        throw new ConnectorError('AUTH_REQUIRED', SAFE_CODE_DESCRIPTIONS.AUTH_REQUIRED, {
          retriable: false,
        });
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...authHeaders,
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (controller && this.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        credentials: this.credentials,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if (timedOut || isAbortError(error)) {
        throw new ConnectorError('TIMEOUT', SAFE_CODE_DESCRIPTIONS.TIMEOUT, { retriable: true });
      }
      throw new ConnectorError('NETWORK_ERROR', SAFE_CODE_DESCRIPTIONS.NETWORK_ERROR, {
        retriable: true,
      });
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }

    if (!response.ok) {
      throw mapHttpFailure(response.status);
    }

    try {
      return await response.json();
    } catch {
      throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
        httpStatus: response.status,
        retriable: false,
      });
    }
  }

  async getCatalog(): Promise<CatalogSnapshot> {
    const raw = await this.requestJson('/api/continuity/catalog', { method: 'GET' });
    const parsed = CatalogSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
        retriable: false,
      });
    }
    return parsed.data;
  }

  async preview(sales: ConfirmedSale[]): Promise<PreviewItem[]> {
    const validatedSales = validateSalesInput(sales);
    if (validatedSales.length === 0) {
      return [];
    }

    const raw = await this.requestJson('/api/continuity/import/preview', {
      method: 'POST',
      body: JSON.stringify({ sales: validatedSales }),
    });

    const parsed = PreviewResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.results.length !== validatedSales.length) {
      throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
        retriable: false,
      });
    }

    return parsed.data.results.map((item, index) =>
      normalizePreviewItem(item, validatedSales[index].saleId)
    );
  }

  async commit(sales: ConfirmedSale[]): Promise<ImportResult[]> {
    const validatedSales = validateSalesInput(sales);
    if (validatedSales.length === 0) {
      return [];
    }

    const raw = await this.requestJson('/api/continuity/import/commit', {
      method: 'POST',
      body: JSON.stringify({ sales: validatedSales }),
    });

    const parsed = CommitResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.results.length !== validatedSales.length) {
      throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
        retriable: false,
      });
    }

    return parsed.data.results.map((item, index) =>
      normalizeImportResult(item, validatedSales[index].saleId)
    );
  }

  async status(saleId: string, sourceDeviceId: string): Promise<ImportResult> {
    if (
      typeof saleId !== 'string' ||
      saleId.trim().length === 0 ||
      typeof sourceDeviceId !== 'string' ||
      sourceDeviceId.trim().length === 0
    ) {
      throw new ConnectorError('INVALID_REQUEST', SAFE_CODE_DESCRIPTIONS.INVALID_REQUEST, {
        retriable: false,
      });
    }

    const encodedSaleId = encodeURIComponent(saleId);
    const encodedDeviceId = encodeURIComponent(sourceDeviceId);
    const raw = await this.requestJson(
      `/api/continuity/import/status/${encodedSaleId}?sourceDeviceId=${encodedDeviceId}`,
      { method: 'GET' }
    );

    const parsed = ImportResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConnectorError('INVALID_RESPONSE', SAFE_CODE_DESCRIPTIONS.INVALID_RESPONSE, {
        retriable: false,
      });
    }

    return normalizeImportResult(parsed.data, saleId);
  }
}

export function createHttpPosConnector(config: HttpPosConnectorConfig): HttpPosConnector {
  return new HttpPosConnector(config);
}
