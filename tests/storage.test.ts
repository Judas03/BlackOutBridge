import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfirmedSale, CatalogSnapshot, priceCart } from '../src/domain';
import {
  BlackOutBridgeDatabase,
  confirmSaleAtomically,
  createDatabase,
  createStorageRepositories,
  StorageError,
} from '../src/storage';

const openDbs: BlackOutBridgeDatabase[] = [];

function createTestDb(factory = new IDBFactory(), name = 'test-blackoutbridge') {
  const db = createDatabase(name, { indexedDB: factory, IDBKeyRange });
  openDbs.push(db);
  return { db, factory, name, repos: createStorageRepositories(db) };
}

function makeSnapshot(overrides?: Partial<CatalogSnapshot>): CatalogSnapshot {
  return {
    currency: 'THB',
    scale: 2,
    snapshotId: 'snap-2026-11-27-01',
    sourcePosId: 'brew-points-pos-1',
    issuedAt: '2026-11-27T08:00:00Z',
    items: [
      {
        itemId: 'espresso',
        name: 'Espresso',
        aliases: ['espresso'],
        unitPriceUnits: 7500,
        available: true,
        optionGroups: [
          {
            groupId: 'option-1',
            name: 'Size',
            required: true,
            choices: [
              { modifierId: 'option-1:choice-1', name: 'Small', deltaUnits: -1000 },
              { modifierId: 'option-1:choice-2', name: 'Regular', deltaUnits: 0 },
              { modifierId: 'option-1:choice-3', name: 'Large', deltaUnits: 1500 },
            ],
          },
        ],
      },
      {
        itemId: 'americano',
        name: 'Americano',
        aliases: [],
        unitPriceUnits: 10000,
        available: true,
        optionGroups: [],
      },
    ],
    ...overrides,
  };
}

async function expectStorageError(
  promise: Promise<unknown>,
  expectedCode: StorageError['code']
): Promise<StorageError> {
  try {
    await promise;
    expect.fail(`Expected StorageError(${expectedCode}), but resolved.`);
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe(expectedCode);
    return error as StorageError;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
});

describe('device repository', () => {
  it('generates and persists a stable sourceDeviceId across close/reopen', async () => {
    const { db, factory, name, repos } = createTestDb();
    const firstId = await repos.device.getOrCreateDeviceId();
    const secondId = await repos.device.getOrCreateDeviceId();
    expect(firstId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(secondId).toBe(firstId);

    db.close();
    const reopened = createTestDb(factory, name);
    expect(await reopened.repos.device.getOrCreateDeviceId()).toBe(firstId);
  });

  it('handles missing navigator.storage.persist gracefully', async () => {
    const { repos } = createTestDb();
    const result = await repos.device.requestPersistentStorage();
    expect(result).toEqual({ supported: false, persisted: false });
  });
});

describe('catalog repository and local sold-out overrides', () => {
  it('stores snapshots newest-first, enforces immutability, and keeps local overrides separate', async () => {
    const { repos } = createTestDb();
    const snapOld = makeSnapshot({
      snapshotId: 'snap-old',
      issuedAt: '2026-11-26T08:00:00Z',
    });
    const snapNew = makeSnapshot({
      snapshotId: 'snap-new',
      issuedAt: '2026-11-27T09:00:00Z',
    });

    await repos.catalog.saveSnapshot(snapOld);
    await repos.catalog.saveSnapshot(snapNew);

    // Re-saving identical snapshot is idempotent.
    await repos.catalog.saveSnapshot(snapNew);

    const active = await repos.catalog.getActiveSnapshot();
    expect(active?.snapshotId).toBe('snap-new');

    const listed = await repos.catalog.listSnapshots();
    expect(listed.map(s => s.snapshotId)).toEqual(['snap-new', 'snap-old']);

    // Mutating snapshot under same ID is rejected.
    const altered = makeSnapshot({
      snapshotId: 'snap-new',
      issuedAt: '2026-11-27T09:00:00Z',
      items: [
        {
          ...snapNew.items[0],
          unitPriceUnits: 9999,
        },
      ],
    });
    await expectStorageError(repos.catalog.saveSnapshot(altered), 'SNAPSHOT_CONFLICT');

    // Local sold-out override does not mutate the approved snapshot.
    await repos.catalog.setLocalItemAvailability('snap-new', 'espresso', false);
    const unavailableIds = await repos.catalog.getLocalUnavailableItemIds('snap-new');
    expect(unavailableIds.has('espresso')).toBe(true);

    const persistedSnap = await repos.catalog.getSnapshotById('snap-new');
    expect(persistedSnap?.items.find(i => i.itemId === 'espresso')?.available).toBe(true);
    expect(persistedSnap?.items.find(i => i.itemId === 'espresso')?.unitPriceUnits).toBe(7500);

    // Pricing respects local sold-out overrides.
    expect(() =>
      priceCart(
        [{ itemId: 'espresso', quantity: 1, modifierIds: ['option-1:choice-2'] }],
        persistedSnap!,
        unavailableIds
      )
    ).toThrow(/unavailable/i);
  });

  it('rejects overrides for unknown snapshot or unknown item', async () => {
    const { repos } = createTestDb();
    await repos.catalog.saveSnapshot(makeSnapshot());

    await expectStorageError(
      repos.catalog.setLocalItemAvailability('missing-snap', 'espresso', false),
      'SNAPSHOT_NOT_FOUND'
    );
    await expectStorageError(
      repos.catalog.setLocalItemAvailability('snap-2026-11-27-01', 'missing-item', false),
      'INVALID_RECORD'
    );
  });
});

describe('draft repository', () => {
  it('saves, reads, clears drafts, and rejects invalid draft lines', async () => {
    const { repos } = createTestDb();
    const saved = await repos.drafts.saveDraft('snap-2026-11-27-01', [
      { itemId: 'espresso', quantity: 2, modifierIds: ['option-1:choice-3'] },
    ]);
    expect(saved.lines).toHaveLength(1);

    const loaded = await repos.drafts.getDraft();
    expect(loaded?.lines).toEqual([
      { itemId: 'espresso', quantity: 2, modifierIds: ['option-1:choice-3'] },
    ]);

    await repos.drafts.clearDraft();
    expect(await repos.drafts.getDraft()).toBeUndefined();

    await expectStorageError(
      repos.drafts.saveDraft('snap-2026-11-27-01', [
        { itemId: 'americano', quantity: 0, modifierIds: [] },
      ]),
      'INVALID_RECORD'
    );
  });
});

describe('atomic confirmed sale, payment, and queue transaction', () => {
  it('commits sale (including signed modifier deltas), payment, and queue entry atomically and clears active draft', async () => {
    const { db, repos } = createTestDb();
    const snapshot = await repos.catalog.saveSnapshot(makeSnapshot());
    const deviceId = await repos.device.getOrCreateDeviceId();
    await repos.drafts.saveDraft(snapshot.snapshotId, [
      { itemId: 'espresso', quantity: 1, modifierIds: ['option-1:choice-1'] },
    ]);

    const sale = buildConfirmedSale({
      saleId: 'sale-atomic-01',
      sourceDeviceId: deviceId,
      snapshot,
      recordedAt: '2026-11-27T10:00:00Z',
      draftLines: [{ itemId: 'espresso', quantity: 1, modifierIds: ['option-1:choice-1'] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 10000, changeUnits: 3500 },
    });

    const receipt = await repos.sales.confirmSale(sale, { clearDraftId: 'active' });
    expect(receipt.sale.totalUnits).toBe(6500);
    expect(receipt.sale.lines[0].capturedModifierDeltaUnits).toBe(-1000);
    expect(receipt.payment.status).toBe('CASH_RECORDED');
    expect(receipt.payment.currency).toBe('THB');
    expect(receipt.payment.scale).toBe(2);
    expect(receipt.queueEntry).toEqual({
      saleId: 'sale-atomic-01',
      payloadVersion: 1,
      state: 'PENDING',
      attempts: 0,
    });

    expect(await repos.drafts.getDraft()).toBeUndefined();
    expect(await db.confirmedSales.count()).toBe(1);
    expect(await db.payments.count()).toBe(1);
    expect(await db.importQueue.count()).toBe(1);
  });

  it('rolls back entire transaction when importQueue.add fails mid-transaction', async () => {
    const { db, repos } = createTestDb();
    const snapshot = await repos.catalog.saveSnapshot(makeSnapshot());
    await repos.drafts.saveDraft(snapshot.snapshotId, [
      { itemId: 'americano', quantity: 1, modifierIds: [] },
    ]);

    const sale = buildConfirmedSale({
      saleId: 'sale-fail-queue',
      sourceDeviceId: 'dev-1',
      snapshot,
      recordedAt: '2026-11-27T10:01:00Z',
      draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 10000, changeUnits: 0 },
    });

    vi.spyOn(db.importQueue, 'add').mockRejectedValueOnce(new Error('Simulated QuotaExceededError'));

    await expectStorageError(
      confirmSaleAtomically(db, sale, { clearDraftId: 'active' }),
      'ATOMIC_COMMIT_FAILED'
    );

    expect(await db.confirmedSales.count()).toBe(0);
    expect(await db.payments.count()).toBe(0);
    expect(await db.importQueue.count()).toBe(0);
    expect(await repos.sales.getReceiptBundle('sale-fail-queue')).toBeUndefined();
    expect((await repos.drafts.getDraft())?.lines).toHaveLength(1);
  });

  it('rolls back confirmedSales when payments.add fails mid-transaction', async () => {
    const { db, repos } = createTestDb();
    const snapshot = await repos.catalog.saveSnapshot(makeSnapshot());

    const sale = buildConfirmedSale({
      saleId: 'sale-fail-payment',
      sourceDeviceId: 'dev-1',
      snapshot,
      recordedAt: '2026-11-27T10:02:00Z',
      draftLines: [{ itemId: 'americano', quantity: 2, modifierIds: [] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 20000, changeUnits: 0 },
    });

    vi.spyOn(db.payments, 'add').mockRejectedValueOnce(new Error('Simulated IndexedDB write abort'));

    await expectStorageError(confirmSaleAtomically(db, sale), 'ATOMIC_COMMIT_FAILED');

    expect(await db.confirmedSales.count()).toBe(0);
    expect(await db.payments.count()).toBe(0);
    expect(await db.importQueue.count()).toBe(0);
  });

  it('enforces immutability by rejecting duplicate saleId without modifying original record', async () => {
    const { repos } = createTestDb();
    const snapshot = await repos.catalog.saveSnapshot(makeSnapshot());

    const original = buildConfirmedSale({
      saleId: 'sale-immutable-1',
      sourceDeviceId: 'dev-1',
      snapshot,
      recordedAt: '2026-11-27T10:05:00Z',
      draftLines: [{ itemId: 'espresso', quantity: 1, modifierIds: ['option-1:choice-2'] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 10000, changeUnits: 2500 },
    });

    const replacement = buildConfirmedSale({
      saleId: 'sale-immutable-1',
      sourceDeviceId: 'dev-1',
      snapshot,
      recordedAt: '2026-11-27T10:06:00Z',
      draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 12000, changeUnits: 2000 },
    });

    await repos.sales.confirmSale(original);
    await expectStorageError(repos.sales.confirmSale(replacement), 'DUPLICATE_SALE_ID');

    const stored = await repos.sales.getById('sale-immutable-1');
    expect(stored?.totalUnits).toBe(7500);
    expect(stored?.lines[0]?.itemId).toBe('espresso');
  });

  it('rejects tampered sale totals and negative effective unit price before writing anything', async () => {
    const { db, repos } = createTestDb();
    const snapshot = await repos.catalog.saveSnapshot(makeSnapshot());
    const valid = buildConfirmedSale({
      saleId: 'sale-tampered-1',
      sourceDeviceId: 'dev-1',
      snapshot,
      recordedAt: '2026-11-27T10:07:00Z',
      draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 10000, changeUnits: 0 },
    });

    await expectStorageError(
      repos.sales.confirmSale({ ...valid, totalUnits: 100 }),
      'INVALID_RECORD'
    );

    await expectStorageError(
      repos.sales.confirmSale({
        ...valid,
        saleId: 'sale-negative-unit',
        lines: [
          {
            itemId: 'americano',
            quantity: 1,
            modifierIds: [],
            capturedUnitPriceUnits: 1000,
            capturedModifierDeltaUnits: -2000,
            lineTotalUnits: 0,
          },
        ],
        totalUnits: 0,
        payment: { status: 'CASH_RECORDED', receivedUnits: 0, changeUnits: 0 },
      }),
      'INVALID_RECORD'
    );

    expect(await db.confirmedSales.count()).toBe(0);
  });
});

describe('payment repository, queue transitions, and reload durability', () => {
  it('tracks payment statuses and computes cash totals summary accurately', async () => {
    const { repos } = createTestDb();
    const snapshot = await repos.catalog.saveSnapshot(makeSnapshot());

    await repos.sales.confirmSale(
      buildConfirmedSale({
        saleId: 'cash-1',
        sourceDeviceId: 'dev-1',
        snapshot,
        recordedAt: '2026-11-27T10:10:00Z',
        draftLines: [{ itemId: 'espresso', quantity: 1, modifierIds: ['option-1:choice-2'] }],
        payment: { status: 'CASH_RECORDED', receivedUnits: 10000, changeUnits: 2500 },
      })
    );
    await repos.sales.confirmSale(
      buildConfirmedSale({
        saleId: 'cash-2',
        sourceDeviceId: 'dev-1',
        snapshot,
        recordedAt: '2026-11-27T10:11:00Z',
        draftLines: [{ itemId: 'americano', quantity: 2, modifierIds: [] }],
        payment: { status: 'CASH_RECORDED', receivedUnits: 20000, changeUnits: 0 },
      })
    );
    await repos.sales.confirmSale(
      buildConfirmedSale({
        saleId: 'ext-1',
        sourceDeviceId: 'dev-1',
        snapshot,
        recordedAt: '2026-11-27T10:12:00Z',
        draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
        payment: { status: 'EXTERNAL_UNVERIFIED', receivedUnits: 0, reference: 'promptpay-9988' },
      })
    );

    expect(await repos.payments.listByStatus('CASH_RECORDED')).toHaveLength(2);
    expect(await repos.payments.listByStatus('EXTERNAL_UNVERIFIED')).toHaveLength(1);
    expect(await repos.payments.summarizeCashTotals()).toEqual({
      count: 2,
      totalUnits: 27500,
      receivedUnits: 30000,
      changeUnits: 2500,
    });
  });

  it('enforces queue state transitions and exports only unresolved sales', async () => {
    const { repos } = createTestDb();
    const snapshot = await repos.catalog.saveSnapshot(makeSnapshot());

    const s1 = buildConfirmedSale({
      saleId: 'q-1',
      sourceDeviceId: 'dev-1',
      snapshot,
      recordedAt: '2026-11-27T10:20:00Z',
      draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 10000, changeUnits: 0 },
    });
    const s2 = buildConfirmedSale({
      saleId: 'q-2',
      sourceDeviceId: 'dev-1',
      snapshot,
      recordedAt: '2026-11-27T10:21:00Z',
      draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
      payment: { status: 'UNPAID', receivedUnits: 0 },
    });

    await repos.sales.confirmSale(s1);
    await repos.sales.confirmSale(s2);

    const failed = await repos.queue.recordAttemptFailure('q-1', 'NETWORK_TIMEOUT');
    expect(failed).toEqual({
      saleId: 'q-1',
      payloadVersion: 1,
      state: 'PENDING',
      attempts: 1,
      lastErrorCode: 'NETWORK_TIMEOUT',
    });

    const imported = await repos.queue.markImported('q-1', 'BP-ORD-1');
    expect(imported).toEqual({
      saleId: 'q-1',
      payloadVersion: 1,
      state: 'IMPORTED',
      attempts: 1,
      destinationReceiptId: 'BP-ORD-1',
    });

    expect(await repos.sales.getById('q-1')).toBeDefined();
    expect(await repos.queue.markImported('q-1', 'BP-ORD-1')).toEqual(imported);
    await expectStorageError(
      repos.queue.markImported('q-1', 'BP-ORD-DIFFERENT'),
      'INVALID_QUEUE_TRANSITION'
    );
    await expectStorageError(
      repos.queue.recordAttemptFailure('q-1', 'ERR'),
      'INVALID_QUEUE_TRANSITION'
    );

    const review = await repos.queue.markReviewRequired('q-2', 'UNSUPPORTED_PAYMENT_STATE', {
      incrementAttempts: true,
    });
    expect(review.state).toBe('REVIEW_REQUIRED');
    expect(review.attempts).toBe(1);

    const backup = await repos.queue.exportPendingSalesBackup();
    expect(backup.pendingCount).toBe(1);
    expect(backup.entries.map(e => e.sale.saleId)).toEqual(['q-2']);

    const requeued = await repos.queue.requeueForRetry('q-2');
    expect(requeued.state).toBe('PENDING');
    expect((await repos.queue.listPendingWithSales()).map(item => item.sale.saleId)).toEqual([
      'q-2',
    ]);
  });

  it('recovers saved catalog, local overrides, cash sale, and queue entry after simulated reload', async () => {
    const { db, factory, name, repos } = createTestDb();
    const deviceId = await repos.device.getOrCreateDeviceId();
    const snapshot = await repos.catalog.saveSnapshot(makeSnapshot());
    await repos.catalog.setLocalItemAvailability(snapshot.snapshotId, 'americano', false);

    const cashSale = buildConfirmedSale({
      saleId: 'sale-reload-01',
      sourceDeviceId: deviceId,
      snapshot,
      recordedAt: '2026-11-27T11:00:00Z',
      draftLines: [{ itemId: 'espresso', quantity: 2, modifierIds: ['option-1:choice-3'] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 20000, changeUnits: 2000 },
    });
    await repos.sales.confirmSale(cashSale);

    db.close();
    const { repos: reloadedRepos } = createTestDb(factory, name);

    expect(await reloadedRepos.device.getOrCreateDeviceId()).toBe(deviceId);
    expect((await reloadedRepos.catalog.getActiveSnapshot())?.snapshotId).toBe(snapshot.snapshotId);
    expect(
      (await reloadedRepos.catalog.getLocalUnavailableItemIds(snapshot.snapshotId)).has('americano')
    ).toBe(true);

    const bundle = await reloadedRepos.sales.getReceiptBundle('sale-reload-01');
    expect(bundle?.sale.totalUnits).toBe(18000);
    expect(bundle?.payment.payment).toEqual({
      status: 'CASH_RECORDED',
      receivedUnits: 20000,
      changeUnits: 2000,
    });
    expect(bundle?.queueEntry.state).toBe('PENDING');
  });
});
