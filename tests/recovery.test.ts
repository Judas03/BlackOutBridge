import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildConfirmedSale,
  CatalogSnapshot,
  computeSaleDigest,
  ConfirmedSale,
  ConfirmedSaleSchema,
  DraftLine,
  ImportResult,
  ISSUE_CODES,
  PaymentRecord,
  PreviewItem,
} from '../src/domain';
import {
  BlackOutBridgeDatabase,
  createDatabase,
  createStorageRepositories,
} from '../src/storage';
import {
  ConnectorError,
  createHttpPosConnector,
  createRecoveryEngine,
  describeRecoveryCode,
  sanitizeIssueCode,
  UNKNOWN_BACKEND_ISSUE,
} from '../src/sync';

const openDbs: BlackOutBridgeDatabase[] = [];

function createTestEnv(name = 'test-recovery') {
  const db = createDatabase(name, { indexedDB: new IDBFactory(), IDBKeyRange });
  openDbs.push(db);
  const storage = createStorageRepositories(db);
  return { db, storage };
}

function makeCatalogSnapshot(overrides?: Partial<CatalogSnapshot>): CatalogSnapshot {
  return {
    currency: 'MMK',
    scale: 0,
    snapshotId: 'snap-2026-11-26-01',
    sourcePosId: 'pos-yangon-01',
    issuedAt: '2026-11-26T08:00:00Z',
    items: [
      {
        itemId: 'mohinga',
        name: 'Mohinga',
        aliases: ['fish noodle'],
        unitPriceUnits: 3500,
        available: true,
        modifiers: [
          { modifierId: 'extra-egg', name: 'Boiled Egg', deltaUnits: 700 },
          { modifierId: 'extra-fritter', name: 'Gourd Fritter', deltaUnits: 500 },
        ],
      },
      {
        itemId: 'milk-tea',
        name: 'Burmese Milk Tea',
        aliases: ['laphet yay'],
        unitPriceUnits: 1500,
        available: true,
        modifiers: [{ modifierId: 'iced', name: 'Iced', deltaUnits: 300 }],
      },
    ],
    ...overrides,
  };
}

function makeValidCashSale(
  snapshot: CatalogSnapshot,
  saleId: string,
  sourceDeviceId: string,
  options?: {
    draftLines?: DraftLine[];
    receivedUnits?: number;
    recordedAt?: string;
  }
): ConfirmedSale {
  const draftLines: DraftLine[] = options?.draftLines ?? [
    { itemId: 'mohinga', quantity: 1, modifierIds: ['extra-egg'] },
  ];
  const base = buildConfirmedSale({
    saleId,
    sourceDeviceId,
    snapshot,
    recordedAt: options?.recordedAt ?? '2026-11-26T09:15:00Z',
    draftLines,
    payment: { status: 'UNPAID', receivedUnits: 0 },
  });
  const receivedUnits = options?.receivedUnits ?? base.totalUnits;
  return buildConfirmedSale({
    saleId,
    sourceDeviceId,
    snapshot,
    recordedAt: options?.recordedAt ?? '2026-11-26T09:15:00Z',
    draftLines,
    payment: {
      status: 'CASH_RECORDED',
      receivedUnits,
      changeUnits: receivedUnits - base.totalUnits,
    },
  });
}

type FaultKind =
  | { type: 'http'; status: number; rawBody?: string }
  | { type: 'network' }
  | { type: 'timeout' }
  | { type: 'malformed_json' }
  | { type: 'missing_receipt_id' }
  | { type: 'out_of_order_results' }
  | { type: 'wrong_result_length' };

type LedgerRecord = {
  tenantId: string;
  sourceDeviceId: string;
  saleId: string;
  digest: string;
  destinationReceiptId: string;
  payment: PaymentRecord;
};

/**
 * In-memory HTTP POS backend test double strictly confined to tests/.
 * Enforces auth->tenantId derivation, historical snapshot validation,
 * (tenantId, sourceDeviceId, saleId) uniqueness + canonical digest checks,
 * and zero kitchen/payment side effects.
 */
class InMemoryPosTestServer {
  private readonly tokens = new Map<string, { tenantId: string; revoked: boolean }>([
    ['token-tenant-a', { tenantId: 'tenant-a', revoked: false }],
    ['token-tenant-b', { tenantId: 'tenant-b', revoked: false }],
    ['token-revoked', { tenantId: 'tenant-a', revoked: true }],
  ]);

  private readonly snapshots = new Map<string, CatalogSnapshot>();
  private activeSnapshotId: string;
  private readonly ledger = new Map<string, LedgerRecord>();
  private receiptSeq = 0;

  nativeSalesCount = 0;
  kitchenDispatchCount = 0;
  paymentInitiationCount = 0;
  recordedOrderPayments: Array<{ destinationReceiptId: string; payment: PaymentRecord }> = [];
  capturedCommitPayloads: ConfirmedSale[][] = [];
  allowUnresolvedPaymentImport = false;

  dropResponseAfterCommit = false;
  partialCommitThenDropAfterN: number | null = null;
  private commitFaultQueue: FaultKind[] = [];
  private previewFaultQueue: FaultKind[] = [];
  private statusFaultQueue: FaultKind[] = [];
  customIssueOverrideForSale = new Map<string, string[]>();

  constructor(initialSnapshot: CatalogSnapshot) {
    this.snapshots.set(initialSnapshot.snapshotId, initialSnapshot);
    this.activeSnapshotId = initialSnapshot.snapshotId;
  }

  registerSnapshot(snapshot: CatalogSnapshot, makeActive = true): void {
    this.snapshots.set(snapshot.snapshotId, snapshot);
    if (makeActive) {
      this.activeSnapshotId = snapshot.snapshotId;
    }
  }

  setTokenState(token: string, state: { tenantId: string; revoked: boolean } | null): void {
    if (state === null) {
      this.tokens.delete(token);
    } else {
      this.tokens.set(token, state);
    }
  }

  queueCommitFault(fault: FaultKind): void {
    this.commitFaultQueue.push(fault);
  }

  queuePreviewFault(fault: FaultKind): void {
    this.previewFaultQueue.push(fault);
  }

  queueStatusFault(fault: FaultKind): void {
    this.statusFaultQueue.push(fault);
  }

  private ledgerKey(tenantId: string, sourceDeviceId: string, saleId: string): string {
    return `${tenantId}::${sourceDeviceId}::${saleId}`;
  }

  private authenticate(headers: Headers): { tenantId: string } | Response {
    const auth = headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'missing bearer token' }), { status: 401 });
    }
    const token = auth.slice('Bearer '.length);
    const entry = this.tokens.get(token);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'expired token' }), { status: 401 });
    }
    if (entry.revoked) {
      return new Response(JSON.stringify({ error: 'permission revoked' }), { status: 403 });
    }
    return { tenantId: entry.tenantId };
  }

  private applyInjectedFault(fault: FaultKind, init?: RequestInit): Response {
    if (fault.type === 'network') {
      throw new TypeError('Simulated socket hang up');
    }
    if (fault.type === 'timeout') {
      if (init?.signal?.aborted) {
        const abortErr = new Error('The operation was aborted.');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const abortErr = new Error('Simulated request timeout');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (fault.type === 'malformed_json') {
      return new Response('{not-valid-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (fault.type === 'http') {
      return new Response(
        fault.rawBody ?? JSON.stringify({ error: 'Simulated server failure' }),
        {
          status: fault.status,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    throw new Error(`Unhandled response fault ${fault.type}`);
  }

  private validateSaleAgainstSnapshot(sale: ConfirmedSale): string[] {
    const customIssues = this.customIssueOverrideForSale.get(sale.saleId);
    if (customIssues) {
      return customIssues;
    }

    const issues: string[] = [];
    const snapshot = this.snapshots.get(sale.snapshotId);
    if (!snapshot) {
      issues.push('SNAPSHOT_MISSING');
      return issues;
    }

    if (
      !this.allowUnresolvedPaymentImport &&
      (sale.payment.status === 'UNPAID' || sale.payment.status === 'EXTERNAL_UNVERIFIED')
    ) {
      issues.push('UNSUPPORTED_PAYMENT_STATE');
    }

    const itemsById = new Map(snapshot.items.map(item => [item.itemId, item]));
    let expectedTotal = 0;

    for (const line of sale.lines) {
      const item = itemsById.get(line.itemId);
      if (!item) {
        issues.push('UNKNOWN_ITEM');
        continue;
      }
      if (line.capturedUnitPriceUnits !== item.unitPriceUnits) {
        issues.push('PRICE_MISMATCH');
      }

      const modifiersById = new Map(item.modifiers.map(mod => [mod.modifierId, mod]));
      let expectedDelta = 0;
      let missingModifier = false;
      for (const modId of line.modifierIds) {
        const mod = modifiersById.get(modId);
        if (!mod) {
          issues.push('UNSUPPORTED_MODIFIER');
          missingModifier = true;
        } else {
          expectedDelta += mod.deltaUnits;
        }
      }
      if (!missingModifier && line.capturedModifierDeltaUnits !== expectedDelta) {
        issues.push('PRICE_MISMATCH');
      }

      const expectedLineTotal =
        line.quantity * (line.capturedUnitPriceUnits + line.capturedModifierDeltaUnits);
      if (line.lineTotalUnits !== expectedLineTotal) {
        issues.push('TOTAL_MISMATCH');
      }
      expectedTotal += line.lineTotalUnits;
    }

    if (sale.totalUnits !== expectedTotal) {
      issues.push('TOTAL_MISMATCH');
    }

    return Array.from(new Set(issues));
  }

  private async evaluatePreview(tenantId: string, sale: ConfirmedSale): Promise<PreviewItem> {
    const digest = await computeSaleDigest(sale);
    const key = this.ledgerKey(tenantId, sale.sourceDeviceId, sale.saleId);
    const existing = this.ledger.get(key);
    if (existing) {
      if (existing.digest !== digest) {
        return {
          saleId: sale.saleId,
          status: 'REVIEW_REQUIRED',
          issueCodes: ['PAYLOAD_CONFLICT'],
        };
      }
      return {
        saleId: sale.saleId,
        status: 'ALREADY_IMPORTED',
        destinationReceiptId: existing.destinationReceiptId,
        issueCodes: [],
      };
    }

    const issues = this.validateSaleAgainstSnapshot(sale);
    if (issues.length > 0) {
      return {
        saleId: sale.saleId,
        status: 'REVIEW_REQUIRED',
        issueCodes: issues,
      };
    }

    return {
      saleId: sale.saleId,
      status: 'READY',
      issueCodes: [],
    };
  }

  private async commitOneSale(tenantId: string, sale: ConfirmedSale): Promise<ImportResult> {
    const digest = await computeSaleDigest(sale);
    const key = this.ledgerKey(tenantId, sale.sourceDeviceId, sale.saleId);
    const existing = this.ledger.get(key);
    if (existing) {
      if (existing.digest !== digest) {
        return {
          saleId: sale.saleId,
          status: 'REVIEW_REQUIRED',
          issueCodes: ['PAYLOAD_CONFLICT'],
        };
      }
      return {
        saleId: sale.saleId,
        status: 'ALREADY_IMPORTED',
        destinationReceiptId: existing.destinationReceiptId,
        issueCodes: [],
      };
    }

    const issues = this.validateSaleAgainstSnapshot(sale);
    if (issues.length > 0) {
      return {
        saleId: sale.saleId,
        status: 'REVIEW_REQUIRED',
        issueCodes: issues,
      };
    }

    // Historical recovery write: NEVER increments kitchenDispatchCount or paymentInitiationCount.
    this.receiptSeq += 1;
    const destinationReceiptId = `RCPT-${tenantId.toUpperCase()}-${String(this.receiptSeq).padStart(4, '0')}`;
    this.ledger.set(key, {
      tenantId,
      sourceDeviceId: sale.sourceDeviceId,
      saleId: sale.saleId,
      digest,
      destinationReceiptId,
      payment: structuredClone(sale.payment),
    });
    this.nativeSalesCount += 1;
    this.recordedOrderPayments.push({
      destinationReceiptId,
      payment: structuredClone(sale.payment),
    });

    return {
      saleId: sale.saleId,
      status: 'IMPORTED',
      destinationReceiptId,
      issueCodes: [],
    };
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'https://pos.local');
    const headers = new Headers(init?.headers);
    const authResult = this.authenticate(headers);
    if (authResult instanceof Response) {
      return authResult;
    }
    const { tenantId } = authResult;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET' && url.pathname === '/api/continuity/catalog') {
      const snapshot = this.snapshots.get(this.activeSnapshotId);
      if (!snapshot) {
        return new Response(JSON.stringify({ error: 'no active snapshot' }), { status: 404 });
      }
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'POST' && url.pathname === '/api/continuity/import/preview') {
      const nextFault = this.previewFaultQueue.shift();
      if (nextFault) {
        return this.applyInjectedFault(nextFault, init);
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as { sales?: unknown[] };
      const sales = (body.sales ?? []).map(item => ConfirmedSaleSchema.parse(item));
      const results: PreviewItem[] = [];
      for (const sale of sales) {
        results.push(await this.evaluatePreview(tenantId, sale));
      }
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'POST' && url.pathname === '/api/continuity/import/commit') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { sales?: unknown[] };
      const sales = (body.sales ?? []).map(item => ConfirmedSaleSchema.parse(item));
      this.capturedCommitPayloads.push(structuredClone(sales));

      const nextFault = this.commitFaultQueue.shift();
      if (
        nextFault &&
        nextFault.type !== 'missing_receipt_id' &&
        nextFault.type !== 'out_of_order_results' &&
        nextFault.type !== 'wrong_result_length'
      ) {
        return this.applyInjectedFault(nextFault, init);
      }

      if (this.partialCommitThenDropAfterN !== null) {
        const count = this.partialCommitThenDropAfterN;
        this.partialCommitThenDropAfterN = null;
        for (let i = 0; i < Math.min(count, sales.length); i += 1) {
          await this.commitOneSale(tenantId, sales[i]);
        }
        throw new TypeError('Simulated mid-batch socket drop');
      }

      const results: ImportResult[] = [];
      for (const sale of sales) {
        results.push(await this.commitOneSale(tenantId, sale));
      }

      if (this.dropResponseAfterCommit) {
        this.dropResponseAfterCommit = false;
        throw new TypeError('Simulated lost HTTP response after commit');
      }

      if (nextFault?.type === 'missing_receipt_id' && results.length > 0) {
        results[0] = { ...results[0], destinationReceiptId: undefined };
      } else if (nextFault?.type === 'out_of_order_results' && results.length > 1) {
        results.reverse();
      } else if (nextFault?.type === 'wrong_result_length' && results.length > 0) {
        results.pop();
      }

      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'GET' && url.pathname.startsWith('/api/continuity/import/status/')) {
      const nextFault = this.statusFaultQueue.shift();
      if (nextFault) {
        return this.applyInjectedFault(nextFault, init);
      }

      const saleId = decodeURIComponent(
        url.pathname.slice('/api/continuity/import/status/'.length)
      );
      const sourceDeviceId = url.searchParams.get('sourceDeviceId') ?? '';
      const existing = this.ledger.get(this.ledgerKey(tenantId, sourceDeviceId, saleId));
      if (!existing) {
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      }
      const result: ImportResult = {
        saleId,
        status: 'IMPORTED',
        destinationReceiptId: existing.destinationReceiptId,
        issueCodes: [],
      };
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'unknown route' }), { status: 404 });
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe('POS connector and durable recovery engine', () => {
  it('refreshes catalog, previews without mutating queue, and commits cash sales without kitchen/payment triggers', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('happy-path');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });

    const savedSnapshot = await engine.refreshCatalog();
    expect(savedSnapshot.snapshotId).toBe(snapshot.snapshotId);
    expect((await storage.catalog.getActiveSnapshot())?.snapshotId).toBe(snapshot.snapshotId);

    const deviceId = await storage.device.getOrCreateDeviceId();
    const sale = makeValidCashSale(snapshot, 'sale-happy-01', deviceId, { receivedUnits: 5000 });
    await storage.sales.confirmSale(sale);

    const preview = await engine.previewPending();
    expect(preview.outcome).toBe('COMPLETED');
    expect(preview.summary).toEqual({ ready: 1, alreadyImported: 0, reviewRequired: 0 });
    expect(preview.items[0]).toEqual({
      saleId: 'sale-happy-01',
      status: 'READY',
      issueCodes: [],
    });

    // Preview must never mark a local queue entry IMPORTED.
    expect((await storage.queue.getBySaleId('sale-happy-01'))?.state).toBe('PENDING');

    const commit = await engine.commitPending();
    expect(commit.outcome).toBe('COMPLETED');
    expect(commit.summary).toEqual({
      imported: 1,
      alreadyImported: 0,
      reviewRequired: 0,
      pendingRetry: 0,
    });
    expect(commit.outcomes[0].destinationReceiptId).toBe('RCPT-TENANT-A-0001');

    const queueAfter = await storage.queue.getBySaleId('sale-happy-01');
    expect(queueAfter?.state).toBe('IMPORTED');
    expect(queueAfter?.destinationReceiptId).toBe('RCPT-TENANT-A-0001');

    // Confirmed sale and payment remain intact and immutable locally.
    expect(await storage.sales.getById('sale-happy-01')).toEqual(sale);
    expect((await storage.payments.getBySaleId('sale-happy-01'))?.payment).toEqual(sale.payment);

    // Historical import must never dispatch kitchen tickets or initiate payments.
    expect(server.nativeSalesCount).toBe(1);
    expect(server.kitchenDispatchCount).toBe(0);
    expect(server.paymentInitiationCount).toBe(0);
  });

  it('does not mark local queue IMPORTED when preview returns ALREADY_IMPORTED', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('preview-already-imported');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });
    const deviceId = await storage.device.getOrCreateDeviceId();
    const sale = makeValidCashSale(snapshot, 'sale-pre-imported', deviceId);

    // Pre-seed server ledger via direct connector commit, then store locally as PENDING.
    await connector.commit([sale]);
    await storage.sales.confirmSale(sale);

    const preview = await engine.previewPending();
    expect(preview.outcome).toBe('COMPLETED');
    expect(preview.items[0].status).toBe('ALREADY_IMPORTED');
    expect(preview.items[0].destinationReceiptId).toBe('RCPT-TENANT-A-0001');
    expect((await storage.queue.getBySaleId('sale-pre-imported'))?.state).toBe('PENDING');
  });

  it('recovers immediately via status lookup when HTTP response is lost after server commit', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('lost-response-immediate');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });

    const deviceId = await storage.device.getOrCreateDeviceId();
    const sale = makeValidCashSale(snapshot, 'sale-lost-resp-01', deviceId);
    await storage.sales.confirmSale(sale);

    server.dropResponseAfterCommit = true;
    const report = await engine.commitPending();

    expect(report.outcome).toBe('COMPLETED');
    expect(report.summary).toEqual({
      imported: 1,
      alreadyImported: 0,
      reviewRequired: 0,
      pendingRetry: 0,
    });
    expect(report.outcomes[0]).toMatchObject({
      saleId: 'sale-lost-resp-01',
      status: 'IMPORTED',
      destinationReceiptId: 'RCPT-TENANT-A-0001',
      resolvedViaStatus: true,
    });
    expect((await storage.queue.getBySaleId('sale-lost-resp-01'))?.state).toBe('IMPORTED');
    expect(server.nativeSalesCount).toBe(1);
    expect(server.kitchenDispatchCount).toBe(0);
    expect(server.paymentInitiationCount).toBe(0);
  });

  it('stays PENDING on prolonged outage after commit, then reconciles on next run without duplicating', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('lost-response-prolonged');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });

    const deviceId = await storage.device.getOrCreateDeviceId();
    const sale = makeValidCashSale(snapshot, 'sale-lost-resp-02', deviceId);
    await storage.sales.confirmSale(sale);

    // Both commit response and immediate status probe fail due to connectivity outage.
    server.dropResponseAfterCommit = true;
    server.queueStatusFault({ type: 'network' });

    const firstAttempt = await engine.commitPending();
    expect(firstAttempt.outcome).toBe('TRANSIENT_FAILURE');
    expect(firstAttempt.errorCode).toBe('NETWORK_ERROR');
    expect(firstAttempt.summary.pendingRetry).toBe(1);

    const midQueue = await storage.queue.getBySaleId('sale-lost-resp-02');
    expect(midQueue?.state).toBe('PENDING');
    expect(midQueue?.attempts).toBe(1);
    expect(midQueue?.lastErrorCode).toBe('NETWORK_ERROR');
    expect(midQueue?.destinationReceiptId).toBeUndefined();

    // Reconnect: Phase A reconciles via status() without even sending a second commit.
    const commitCallsBeforeReconnect = server.capturedCommitPayloads.length;
    const secondAttempt = await engine.commitPending();

    expect(secondAttempt.outcome).toBe('COMPLETED');
    expect(secondAttempt.outcomes[0]).toMatchObject({
      saleId: 'sale-lost-resp-02',
      status: 'IMPORTED',
      destinationReceiptId: 'RCPT-TENANT-A-0001',
      resolvedViaStatus: true,
    });
    expect(server.capturedCommitPayloads.length).toBe(commitCallsBeforeReconnect);
    expect(server.nativeSalesCount).toBe(1);
    expect((await storage.queue.getBySaleId('sale-lost-resp-02'))?.state).toBe('IMPORTED');
  });

  it('supports idempotent retry when status reconciliation is disabled', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('idempotent-retry');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({
      storage,
      connector,
      reconcileBeforeCommit: false,
      resolveUncertainViaStatus: false,
    });

    const deviceId = await storage.device.getOrCreateDeviceId();
    const sale = makeValidCashSale(snapshot, 'sale-idempotent-01', deviceId);
    await storage.sales.confirmSale(sale);

    server.dropResponseAfterCommit = true;
    const first = await engine.commitPending();
    expect(first.outcome).toBe('TRANSIENT_FAILURE');

    const second = await engine.commitPending();
    expect(second.outcome).toBe('COMPLETED');
    expect(second.outcomes[0].status).toBe('ALREADY_IMPORTED');
    expect(second.outcomes[0].destinationReceiptId).toBe('RCPT-TENANT-A-0001');
    expect(server.nativeSalesCount).toBe(1);
  });

  it('flags PAYLOAD_CONFLICT when an existing saleId is reused with altered financial content', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('payload-conflict');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });

    const deviceId = await storage.device.getOrCreateDeviceId();
    const original = makeValidCashSale(snapshot, 'sale-conflict-01', deviceId);
    await connector.commit([original]);
    expect(server.nativeSalesCount).toBe(1);

    // Local device records a different order under the same (sourceDeviceId, saleId).
    const altered = makeValidCashSale(snapshot, 'sale-conflict-01', deviceId, {
      draftLines: [{ itemId: 'milk-tea', quantity: 2, modifierIds: [] }],
    });
    await storage.sales.confirmSale(altered);

    const preview = await engine.previewPending();
    expect(preview.outcome).toBe('COMPLETED');
    expect(preview.items[0]).toEqual({
      saleId: 'sale-conflict-01',
      status: 'REVIEW_REQUIRED',
      issueCodes: ['PAYLOAD_CONFLICT'],
    });

    const commit = await engine.commitPending();
    expect(commit.outcome).toBe('COMPLETED');
    expect(commit.summary.reviewRequired).toBe(1);
    expect(commit.outcomes[0]).toEqual({
      saleId: 'sale-conflict-01',
      status: 'REVIEW_REQUIRED',
      issueCodes: ['PAYLOAD_CONFLICT'],
      errorCode: 'PAYLOAD_CONFLICT',
    });

    const queueEntry = await storage.queue.getBySaleId('sale-conflict-01');
    expect(queueEntry?.state).toBe('REVIEW_REQUIRED');
    expect(queueEntry?.lastErrorCode).toBe('PAYLOAD_CONFLICT');
    expect(server.nativeSalesCount).toBe(1);
  });

  it('preserves local sales and retries cleanly after HTTP 401 expired auth', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('auth-401');
    let activeToken = 'expired-token';

    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: `Bearer ${activeToken}` }),
    });
    const engine = createRecoveryEngine({ storage, connector });

    const deviceId = await storage.device.getOrCreateDeviceId();
    const sale = makeValidCashSale(snapshot, 'sale-auth-401', deviceId);
    await storage.sales.confirmSale(sale);

    const preview401 = await engine.previewPending();
    expect(preview401.outcome).toBe('AUTH_REQUIRED');
    expect(preview401.errorCode).toBe('AUTH_REQUIRED');

    const commit401 = await engine.commitPending();
    expect(commit401.outcome).toBe('AUTH_REQUIRED');
    expect(commit401.errorCode).toBe('AUTH_REQUIRED');
    expect(commit401.summary.pendingRetry).toBe(1);

    // Local sale, payment, and PENDING queue state remain completely intact.
    expect(await storage.sales.getById('sale-auth-401')).toEqual(sale);
    expect(await storage.payments.getBySaleId('sale-auth-401')).toBeDefined();
    const queue401 = await storage.queue.getBySaleId('sale-auth-401');
    expect(queue401?.state).toBe('PENDING');
    expect(queue401?.lastErrorCode).toBe('AUTH_REQUIRED');
    expect(queue401?.attempts).toBe(1);

    // Reauthorize and retry.
    activeToken = 'token-tenant-a';
    const retry = await engine.commitPending();
    expect(retry.outcome).toBe('COMPLETED');
    expect(retry.summary.imported).toBe(1);
    expect((await storage.queue.getBySaleId('sale-auth-401'))?.state).toBe('IMPORTED');
    expect(server.nativeSalesCount).toBe(1);
  });

  it('moves pending sales to REVIEW_REQUIRED on HTTP 403 revoked access without erasing local records', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('auth-403');
    let activeToken = 'token-revoked';

    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: `Bearer ${activeToken}` }),
    });
    const engine = createRecoveryEngine({ storage, connector, batchSize: 1 });

    const deviceId = await storage.device.getOrCreateDeviceId();
    const s1 = makeValidCashSale(snapshot, 'sale-403-1', deviceId, {
      recordedAt: '2026-11-26T09:00:00Z',
    });
    const s2 = makeValidCashSale(snapshot, 'sale-403-2', deviceId, {
      recordedAt: '2026-11-26T09:01:00Z',
    });
    await storage.sales.confirmSale(s1);
    await storage.sales.confirmSale(s2);

    const preview403 = await engine.previewPending();
    expect(preview403.outcome).toBe('ACCESS_DENIED');
    expect(preview403.errorCode).toBe('ACCESS_DENIED');

    const commit403 = await engine.commitPending();
    expect(commit403.outcome).toBe('ACCESS_DENIED');
    expect(commit403.errorCode).toBe('ACCESS_DENIED');
    expect(commit403.summary.reviewRequired).toBe(2);

    // Local sales & payments must never be erased on 403.
    expect(await storage.sales.getById('sale-403-1')).toEqual(s1);
    expect(await storage.sales.getById('sale-403-2')).toEqual(s2);
    expect((await storage.queue.getBySaleId('sale-403-1'))?.state).toBe('REVIEW_REQUIRED');
    expect((await storage.queue.getBySaleId('sale-403-1'))?.lastErrorCode).toBe('ACCESS_DENIED');
    expect((await storage.queue.getBySaleId('sale-403-2'))?.state).toBe('REVIEW_REQUIRED');
    expect((await storage.queue.getBySaleId('sale-403-2'))?.lastErrorCode).toBe('ACCESS_DENIED');

    // Permission restored: requeue ACCESS_DENIED entries and commit.
    activeToken = 'token-tenant-a';
    const requeued = await engine.requeueAllReviewRequired('ACCESS_DENIED');
    expect(requeued).toHaveLength(2);

    const recovered = await engine.commitPending();
    expect(recovered.outcome).toBe('COMPLETED');
    expect(recovered.summary.imported).toBe(2);
    expect(server.nativeSalesCount).toBe(2);
  });

  it('quarantines all catalog and pricing drift exceptions without mutating immutable local sales', async () => {
    const serverSnapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(serverSnapshot);
    const { storage } = createTestEnv('catalog-drift');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });
    const deviceId = await storage.device.getOrCreateDeviceId();

    // 1. UNKNOWN_ITEM (local snapshot had an item removed/unknown on backend)
    const staleCatalogWithRemovedItem = makeCatalogSnapshot({
      items: [
        ...serverSnapshot.items,
        {
          itemId: 'shan-noodles',
          name: 'Shan Noodles',
          aliases: [],
          unitPriceUnits: 3200,
          available: true,
          modifiers: [],
        },
      ],
    });
    const unknownItemSale = makeValidCashSale(staleCatalogWithRemovedItem, 'sale-unknown-item', deviceId, {
      draftLines: [{ itemId: 'shan-noodles', quantity: 1, modifierIds: [] }],
    });

    // 2. UNSUPPORTED_MODIFIER
    const staleCatalogWithExtraMod = makeCatalogSnapshot({
      items: [
        {
          ...serverSnapshot.items[0],
          modifiers: [
            ...serverSnapshot.items[0].modifiers,
            { modifierId: 'legacy-chili', name: 'Legacy Chili', deltaUnits: 200 },
          ],
        },
        serverSnapshot.items[1],
      ],
    });
    const unsupportedModSale = makeValidCashSale(
      staleCatalogWithExtraMod,
      'sale-unsupported-mod',
      deviceId,
      { draftLines: [{ itemId: 'mohinga', quantity: 1, modifierIds: ['legacy-chili'] }] }
    );

    // 3. SNAPSHOT_MISSING
    const missingSnapshot = makeCatalogSnapshot({ snapshotId: 'snap-missing-on-server' });
    const missingSnapSale = makeValidCashSale(missingSnapshot, 'sale-missing-snap', deviceId);

    // 4. PRICE_MISMATCH (both base unit price drift and modifier delta drift)
    const driftedPriceSnapshot = makeCatalogSnapshot({
      items: [
        {
          ...serverSnapshot.items[0],
          unitPriceUnits: 3800,
          modifiers: [{ modifierId: 'extra-egg', name: 'Boiled Egg', deltaUnits: 900 }],
        },
      ],
    });
    const priceMismatchSale = makeValidCashSale(driftedPriceSnapshot, 'sale-price-mismatch', deviceId);

    // 5. TOTAL_MISMATCH (detected via backend total verification)
    const baseValid = makeValidCashSale(serverSnapshot, 'sale-total-mismatch', deviceId);
    // Construct a sale that fails backend line/total check by tweaking server custom validation?
    // Even better: send a sale whose line prices match snapshot, then verify storage requires valid
    // arithmetic locally while backend checks lineTotalUnits against its own math (or simulate
    // backend reporting TOTAL_MISMATCH for altered snapshot rule). Here we simulate a snapshot
    // item price mismatch cleared only on total, or use server's TOTAL_MISMATCH check cleanly:
    const mismatchSnapshot = makeCatalogSnapshot({
      snapshotId: 'snap-total-mismatch',
      items: [
        {
          itemId: 'mohinga',
          name: 'Mohinga',
          aliases: [],
          unitPriceUnits: 3500,
          available: true,
          modifiers: [{ modifierId: 'extra-egg', name: 'Boiled Egg', deltaUnits: 700 }],
        },
      ],
    });
    server.registerSnapshot(mismatchSnapshot, false);
    // Make backend report TOTAL_MISMATCH on this saleId as if an unsupported rounding/tax rule differed.
    server.customIssueOverrideForSale.set('sale-total-mismatch', ['TOTAL_MISMATCH']);

    const allDriftSales = [
      unknownItemSale,
      unsupportedModSale,
      missingSnapSale,
      priceMismatchSale,
      baseValid,
    ];
    for (const s of allDriftSales) {
      await storage.sales.confirmSale(s);
    }

    const preview = await engine.previewPending();
    expect(preview.outcome).toBe('COMPLETED');
    expect(preview.summary.reviewRequired).toBe(5);

    const commit = await engine.commitPending();
    expect(commit.outcome).toBe('COMPLETED');
    expect(commit.summary).toEqual({
      imported: 0,
      alreadyImported: 0,
      reviewRequired: 5,
      pendingRetry: 0,
    });

    const expectedErrors: Array<[string, string]> = [
      ['sale-unknown-item', 'UNKNOWN_ITEM'],
      ['sale-unsupported-mod', 'UNSUPPORTED_MODIFIER'],
      ['sale-missing-snap', 'SNAPSHOT_MISSING'],
      ['sale-price-mismatch', 'PRICE_MISMATCH'],
      ['sale-total-mismatch', 'TOTAL_MISMATCH'],
    ];
    for (const [saleId, code] of expectedErrors) {
      const q = await storage.queue.getBySaleId(saleId);
      expect(q?.state).toBe('REVIEW_REQUIRED');
      expect(q?.lastErrorCode).toBe(code);
    }
    expect(server.nativeSalesCount).toBe(0);
  });

  it('commits valid sales and quarantines invalid ones in a mixed batch', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('mixed-batch');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });
    const deviceId = await storage.device.getOrCreateDeviceId();

    const s1 = makeValidCashSale(snapshot, 'sale-mix-1', deviceId, {
      recordedAt: '2026-11-26T10:00:00Z',
    });
    const staleCatalog = makeCatalogSnapshot({
      items: [
        ...snapshot.items,
        {
          itemId: 'deleted-item',
          name: 'Deleted Dish',
          aliases: [],
          unitPriceUnits: 2000,
          available: true,
          modifiers: [],
        },
      ],
    });
    const s2Bad = makeValidCashSale(staleCatalog, 'sale-mix-2', deviceId, {
      recordedAt: '2026-11-26T10:01:00Z',
      draftLines: [{ itemId: 'deleted-item', quantity: 1, modifierIds: [] }],
    });
    const s3 = makeValidCashSale(snapshot, 'sale-mix-3', deviceId, {
      recordedAt: '2026-11-26T10:02:00Z',
    });

    await storage.sales.confirmSale(s1);
    await storage.sales.confirmSale(s2Bad);
    await storage.sales.confirmSale(s3);

    const report = await engine.commitPending();
    expect(report.outcome).toBe('COMPLETED');
    expect(report.summary).toEqual({
      imported: 2,
      alreadyImported: 0,
      reviewRequired: 1,
      pendingRetry: 0,
    });

    expect((await storage.queue.getBySaleId('sale-mix-1'))?.state).toBe('IMPORTED');
    expect((await storage.queue.getBySaleId('sale-mix-2'))?.state).toBe('REVIEW_REQUIRED');
    expect((await storage.queue.getBySaleId('sale-mix-2'))?.lastErrorCode).toBe('UNKNOWN_ITEM');
    expect((await storage.queue.getBySaleId('sale-mix-3'))?.state).toBe('IMPORTED');
    expect(server.nativeSalesCount).toBe(2);
  });

  it('resumes cleanly after mid-batch server crash without duplicating already committed sales', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('mid-batch-crash');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });
    const deviceId = await storage.device.getOrCreateDeviceId();

    const s1 = makeValidCashSale(snapshot, 'sale-crash-1', deviceId, {
      recordedAt: '2026-11-26T11:00:00Z',
    });
    const s2 = makeValidCashSale(snapshot, 'sale-crash-2', deviceId, {
      recordedAt: '2026-11-26T11:01:00Z',
    });
    const s3 = makeValidCashSale(snapshot, 'sale-crash-3', deviceId, {
      recordedAt: '2026-11-26T11:02:00Z',
    });

    await storage.sales.confirmSale(s1);
    await storage.sales.confirmSale(s2);
    await storage.sales.confirmSale(s3);

    // Server commits first 2 sales in the batch, then drops connection before committing the 3rd.
    server.partialCommitThenDropAfterN = 2;
    const firstRun = await engine.commitPending();

    expect(firstRun.outcome).toBe('TRANSIENT_FAILURE');
    expect(firstRun.summary).toEqual({
      imported: 2,
      alreadyImported: 0,
      reviewRequired: 0,
      pendingRetry: 1,
    });
    expect((await storage.queue.getBySaleId('sale-crash-1'))?.state).toBe('IMPORTED');
    expect((await storage.queue.getBySaleId('sale-crash-2'))?.state).toBe('IMPORTED');
    expect((await storage.queue.getBySaleId('sale-crash-3'))?.state).toBe('PENDING');

    // Resume: only S3 is sent and committed.
    const secondRun = await engine.commitPending();
    expect(secondRun.outcome).toBe('COMPLETED');
    expect(secondRun.summary).toEqual({
      imported: 1,
      alreadyImported: 0,
      reviewRequired: 0,
      pendingRetry: 0,
    });
    expect(secondRun.outcomes.map(o => o.saleId)).toEqual(['sale-crash-3']);
    expect((await storage.queue.getBySaleId('sale-crash-3'))?.state).toBe('IMPORTED');
    expect(server.nativeSalesCount).toBe(3);
  });

  it('resumes chunked batch (batchSize: 1) after 503 without duplicating earlier chunks', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('chunked-batch-503');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector, batchSize: 1 });
    const deviceId = await storage.device.getOrCreateDeviceId();

    for (const [index, time] of ['12:00:00Z', '12:01:00Z', '12:02:00Z'].entries()) {
      await storage.sales.confirmSale(
        makeValidCashSale(snapshot, `sale-chunk-${index + 1}`, deviceId, {
          recordedAt: `2026-11-26T${time}`,
        })
      );
    }

    // Chunk 1 succeeds; Chunk 2 hits HTTP 503 -> Chunk 3 is not sent yet.
    // Next commit call succeeds, then Chunk 2 triggers 503.
    const origFetch = server.fetch;
    let commitCallIndex = 0;
    const wrappedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/continuity/import/commit')) {
        commitCallIndex += 1;
        if (commitCallIndex === 2) {
          return new Response(
            JSON.stringify({ error: 'SQLITE_BUSY: database is locked at line 42' }),
            { status: 503 }
          );
        }
      }
      return origFetch(input, init);
    };

    const chunkEngine = createRecoveryEngine({
      storage,
      connector: createHttpPosConnector({
        baseUrl: 'https://pos.local',
        fetchImpl: wrappedFetch,
        getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
      }),
      batchSize: 1,
    });

    const first = await chunkEngine.commitPending();
    expect(first.outcome).toBe('TRANSIENT_FAILURE');
    expect(first.errorCode).toBe('SERVER_ERROR');
    expect(first.message).not.toContain('SQLITE_BUSY');
    expect((await storage.queue.getBySaleId('sale-chunk-1'))?.state).toBe('IMPORTED');
    expect((await storage.queue.getBySaleId('sale-chunk-2'))?.state).toBe('PENDING');
    expect((await storage.queue.getBySaleId('sale-chunk-3'))?.state).toBe('PENDING');
    expect(server.nativeSalesCount).toBe(1);

    const second = await chunkEngine.commitPending();
    expect(second.outcome).toBe('COMPLETED');
    expect(second.summary.imported).toBe(2);
    expect(second.outcomes.map(o => o.saleId)).toEqual(['sale-chunk-2', 'sale-chunk-3']);
    expect(server.nativeSalesCount).toBe(3);
  });

  it('preserves EXTERNAL_UNVERIFIED and UNPAID states and never marks them paid', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('unresolved-payments');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });
    const deviceId = await storage.device.getOrCreateDeviceId();

    const unpaidSale = buildConfirmedSale({
      saleId: 'sale-unpaid-01',
      sourceDeviceId: deviceId,
      snapshot,
      recordedAt: '2026-11-26T13:00:00Z',
      draftLines: [{ itemId: 'milk-tea', quantity: 1, modifierIds: [] }],
      payment: { status: 'UNPAID', receivedUnits: 0 },
    });
    const externalSale = buildConfirmedSale({
      saleId: 'sale-ext-01',
      sourceDeviceId: deviceId,
      snapshot,
      recordedAt: '2026-11-26T13:01:00Z',
      draftLines: [{ itemId: 'mohinga', quantity: 1, modifierIds: [] }],
      payment: { status: 'EXTERNAL_UNVERIFIED', receivedUnits: 0, reference: 'KBZPAY-REF-991' },
    });

    await storage.sales.confirmSale(unpaidSale);
    await storage.sales.confirmSale(externalSale);

    // Case A: Backend requires manual payment resolution (UNSUPPORTED_PAYMENT_STATE).
    const rejected = await engine.commitPending();
    expect(rejected.outcome).toBe('COMPLETED');
    expect(rejected.summary.reviewRequired).toBe(2);
    expect((await storage.queue.getBySaleId('sale-unpaid-01'))?.lastErrorCode).toBe(
      'UNSUPPORTED_PAYMENT_STATE'
    );
    expect((await storage.queue.getBySaleId('sale-ext-01'))?.lastErrorCode).toBe(
      'UNSUPPORTED_PAYMENT_STATE'
    );

    // Outgoing payloads preserved exact unresolved payment states.
    expect(server.capturedCommitPayloads[0][0].payment).toEqual({
      status: 'UNPAID',
      receivedUnits: 0,
    });
    expect(server.capturedCommitPayloads[0][1].payment).toEqual({
      status: 'EXTERNAL_UNVERIFIED',
      receivedUnits: 0,
      reference: 'KBZPAY-REF-991',
    });

    // Case B: Backend supports importing unresolved orders without settling payment.
    server.allowUnresolvedPaymentImport = true;
    await engine.requeueAllReviewRequired('UNSUPPORTED_PAYMENT_STATE');
    const imported = await engine.commitPending();
    expect(imported.outcome).toBe('COMPLETED');
    expect(imported.summary.imported).toBe(2);

    // Local payment records AND server order payment records remain unresolved; zero payment triggers.
    expect((await storage.payments.getBySaleId('sale-unpaid-01'))?.payment).toEqual({
      status: 'UNPAID',
      receivedUnits: 0,
    });
    expect((await storage.payments.getBySaleId('sale-ext-01'))?.payment).toEqual({
      status: 'EXTERNAL_UNVERIFIED',
      receivedUnits: 0,
      reference: 'KBZPAY-REF-991',
    });
    expect(server.recordedOrderPayments.map(entry => entry.payment)).toEqual([
      { status: 'UNPAID', receivedUnits: 0 },
      { status: 'EXTERNAL_UNVERIFIED', receivedUnits: 0, reference: 'KBZPAY-REF-991' },
    ]);
    expect(server.paymentInitiationCount).toBe(0);
    expect(server.kitchenDispatchCount).toBe(0);
  });

  it('rejects malformed responses, missing receiptIds, out-of-order results, and sanitizes unknown errors/codes', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('sanitization-and-validation');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
    });
    const engine = createRecoveryEngine({ storage, connector });
    const deviceId = await storage.device.getOrCreateDeviceId();

    const s1 = makeValidCashSale(snapshot, 'sale-sanitize-1', deviceId, {
      recordedAt: '2026-11-26T14:00:00Z',
    });
    const s2 = makeValidCashSale(snapshot, 'sale-sanitize-2', deviceId, {
      recordedAt: '2026-11-26T14:01:00Z',
    });
    await storage.sales.confirmSale(s1);
    await storage.sales.confirmSale(s2);

    // 1. Out-of-order batch results -> INVALID_RESPONSE, nothing marked IMPORTED.
    server.queueCommitFault({ type: 'out_of_order_results' });
    const outOfOrder = await engine.commitPending();
    expect(outOfOrder.outcome).toBe('ERROR');
    expect(outOfOrder.errorCode).toBe('INVALID_RESPONSE');
    expect((await storage.queue.getBySaleId('sale-sanitize-1'))?.state).toBe('PENDING');
    expect((await storage.queue.getBySaleId('sale-sanitize-2'))?.state).toBe('PENDING');

    // 2. Reconcile s1 & s2 via Phase A status() before moving on.
    expect((await engine.commitPending()).outcome).toBe('COMPLETED');
    expect((await storage.queue.getBySaleId('sale-sanitize-1'))?.state).toBe('IMPORTED');
    expect((await storage.queue.getBySaleId('sale-sanitize-2'))?.state).toBe('IMPORTED');

    // 3. IMPORTED without destinationReceiptId -> INVALID_RESPONSE, stays PENDING.
    const s3 = makeValidCashSale(snapshot, 'sale-missing-rcpt', deviceId, {
      recordedAt: '2026-11-26T14:02:00Z',
    });
    await storage.sales.confirmSale(s3);
    server.queueCommitFault({ type: 'missing_receipt_id' });
    const missingRcpt = await engine.commitPending();
    expect(missingRcpt.outcome).toBe('ERROR');
    expect(missingRcpt.errorCode).toBe('INVALID_RESPONSE');
    expect((await storage.queue.getBySaleId('sale-missing-rcpt'))?.state).toBe('PENDING');

    // Reconcile s3 via Phase A status() so subsequent commit faults hit commit() directly.
    expect((await engine.commitPending()).outcome).toBe('COMPLETED');
    expect((await storage.queue.getBySaleId('sale-missing-rcpt'))?.state).toBe('IMPORTED');

    // 4. Malformed JSON response -> INVALID_RESPONSE, stays PENDING.
    const s4Malformed = makeValidCashSale(snapshot, 'sale-malformed-json', deviceId, {
      recordedAt: '2026-11-26T14:02:30Z',
    });
    await storage.sales.confirmSale(s4Malformed);
    server.queueCommitFault({ type: 'malformed_json' });
    const malformed = await engine.commitPending();
    expect(malformed.outcome).toBe('ERROR');
    expect(malformed.errorCode).toBe('INVALID_RESPONSE');
    expect((await storage.queue.getBySaleId('sale-malformed-json'))?.state).toBe('PENDING');

    // Recover s4Malformed cleanly before the next fault step.
    expect((await engine.commitPending()).outcome).toBe('COMPLETED');
    expect((await storage.queue.getBySaleId('sale-malformed-json'))?.state).toBe('IMPORTED');

    // 5. Raw backend SQL/stack trace on 500 never leaks into ConnectorError or RecoveryCommitReport.
    const s5Server500 = makeValidCashSale(snapshot, 'sale-http-500', deviceId, {
      recordedAt: '2026-11-26T14:02:45Z',
    });
    await storage.sales.confirmSale(s5Server500);
    server.queueCommitFault({
      type: 'http',
      status: 500,
      rawBody: 'FATAL: password authentication failed for user "pos_admin" at pg/pool.js:88',
    });
    server.queueStatusFault({ type: 'network' });
    const server500 = await engine.commitPending();
    expect(server500.outcome).toBe('TRANSIENT_FAILURE');
    expect(server500.errorCode).toBe('NETWORK_ERROR');
    expect(server500.message).not.toContain('pos_admin');
    expect(server500.message).not.toContain('FATAL');

    // 6. Unknown backend issue codes are sanitized to UNKNOWN_BACKEND_ISSUE.
    const s6Issue = makeValidCashSale(snapshot, 'sale-raw-issue', deviceId, {
      recordedAt: '2026-11-26T14:03:00Z',
    });
    await storage.sales.confirmSale(s6Issue);
    server.customIssueOverrideForSale.set('sale-raw-issue', [
      'INTERNAL_PG_CONSTRAINT_23505_SECRET_TABLE',
      'UNKNOWN_ITEM',
    ]);
    // Phase A checks s5Server500 (404), then Phase B commits s5Server500 and flags s6Issue.
    const sanitizedRun = await engine.commitPending();
    expect(sanitizedRun.outcome).toBe('COMPLETED');
    const s6Outcome = sanitizedRun.outcomes.find(o => o.saleId === 'sale-raw-issue');
    expect(s6Outcome?.status).toBe('REVIEW_REQUIRED');
    expect(s6Outcome?.issueCodes).toEqual([UNKNOWN_BACKEND_ISSUE, 'UNKNOWN_ITEM']);
    expect((await storage.queue.getBySaleId('sale-raw-issue'))?.lastErrorCode).toBe(
      UNKNOWN_BACKEND_ISSUE
    );

    // 7. Helper unit checks for sanitizeIssueCode and describeRecoveryCode.
    for (const code of ISSUE_CODES) {
      expect(sanitizeIssueCode(code)).toBe(code);
      expect(describeRecoveryCode(code).length).toBeGreaterThan(10);
    }
    expect(sanitizeIssueCode('RAW_STACK_TRACE')).toBe(UNKNOWN_BACKEND_ISSUE);
    expect(describeRecoveryCode('RAW_STACK_TRACE')).not.toContain('RAW_STACK_TRACE');
  });

  it('handles request timeouts cleanly and reconciles individual sales via reconcileSaleStatus', async () => {
    const snapshot = makeCatalogSnapshot();
    const server = new InMemoryPosTestServer(snapshot);
    const { storage } = createTestEnv('timeout-and-reconcile');
    const connector = createHttpPosConnector({
      baseUrl: 'https://pos.local',
      fetchImpl: server.fetch,
      getAuthHeaders: () => ({ Authorization: 'Bearer token-tenant-a' }),
      timeoutMs: 250,
    });
    const engine = createRecoveryEngine({ storage, connector });
    const deviceId = await storage.device.getOrCreateDeviceId();

    const sale = makeValidCashSale(snapshot, 'sale-timeout-01', deviceId);
    await storage.sales.confirmSale(sale);

    // 404 before any commit -> NOT_FOUND
    expect(await engine.reconcileSaleStatus('sale-timeout-01')).toEqual({
      status: 'NOT_FOUND',
      saleId: 'sale-timeout-01',
    });

    // Timeout on commit & timeout on status -> TRANSIENT_FAILURE with TIMEOUT code
    server.queueCommitFault({ type: 'timeout' });
    server.queueStatusFault({ type: 'timeout' });
    const timedOut = await engine.commitPending();
    expect(timedOut.outcome).toBe('TRANSIENT_FAILURE');
    expect(timedOut.errorCode).toBe('TIMEOUT');
    expect((await storage.queue.getBySaleId('sale-timeout-01'))?.lastErrorCode).toBe('TIMEOUT');

    // Direct connector error properties check
    server.queueStatusFault({ type: 'timeout' });
    await expect(connector.status('sale-timeout-01', deviceId)).rejects.toMatchObject({
      name: 'ConnectorError',
      code: 'TIMEOUT',
      retriable: true,
    } satisfies Partial<ConnectorError>);

    // After server receives sale, reconcileSaleStatus transitions queue to IMPORTED.
    await connector.commit([sale]);
    const reconciled = await engine.reconcileSaleStatus('sale-timeout-01');
    expect(reconciled).toEqual({
      status: 'IMPORTED',
      saleId: 'sale-timeout-01',
      destinationReceiptId: 'RCPT-TENANT-A-0001',
      issueCodes: [],
    });
    expect((await storage.queue.getBySaleId('sale-timeout-01'))?.state).toBe('IMPORTED');

    // Subsequent call returns ALREADY_IMPORTED from local state without network dependency.
    server.queueStatusFault({ type: 'network' });
    expect(await engine.reconcileSaleStatus('sale-timeout-01')).toEqual({
      status: 'ALREADY_IMPORTED',
      saleId: 'sale-timeout-01',
      destinationReceiptId: 'RCPT-TENANT-A-0001',
      issueCodes: [],
    });
  });

  it('enforces request timeout across stalled response body on a real loopback HTTP server', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"saleId":"sale-stalled-body"');
      // Intentionally never call res.end() to simulate headers-then-stalled-body.
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected loopback TCP server address.');
      }
      const connector = createHttpPosConnector({
        baseUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 40,
      });

      const startedAt = Date.now();
      await expect(connector.status('sale-stalled-body', 'dev-loopback')).rejects.toMatchObject({
        name: 'ConnectorError',
        code: 'TIMEOUT',
        retriable: true,
      } satisfies Partial<ConnectorError>);
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    }
  });
});
