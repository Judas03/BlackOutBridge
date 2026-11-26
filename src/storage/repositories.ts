import {
  CatalogSnapshot,
  CatalogSnapshotSchema,
  ConfirmedSale,
  ConfirmedSaleSchema,
  DraftLine,
  DraftLineSchema,
  PaymentRecord,
  QueueEntry,
  QueueEntrySchema,
  QueueState,
  safeAdd,
  safeMultiply,
} from '../domain';
import {
  BlackOutBridgeDatabase,
  ConfirmedSaleReceipt,
  DraftRecord,
  StorageError,
  StoredPaymentRecord,
} from './db';

export type PendingSalesBackup = {
  schemaVersion: 1;
  exportedAt: string;
  sourceDeviceId: string;
  pendingCount: number;
  entries: Array<{ sale: ConfirmedSale; queueEntry: QueueEntry }>;
};

export type CashTotalsSummary = {
  count: number;
  totalUnits: number;
  receivedUnits: number;
  changeUnits: number;
};

function isConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; inner?: { name?: unknown } };
  return candidate.name === 'ConstraintError' || candidate.inner?.name === 'ConstraintError';
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => isDeepEqual(value, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      key =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        isDeepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }
  return false;
}

function validateConfirmedSaleIntegrity(sale: ConfirmedSale): ConfirmedSale {
  const parsed = ConfirmedSaleSchema.safeParse(sale);
  if (!parsed.success) {
    throw new StorageError('INVALID_RECORD', 'Confirmed sale failed schema validation.', {
      issues: parsed.error.issues.map(issue => issue.message),
    });
  }

  const validated = parsed.data;
  try {
    let computedTotal = 0;
    for (const line of validated.lines) {
      const effectiveUnit = safeAdd(
        line.capturedUnitPriceUnits,
        line.capturedModifierDeltaUnits,
        'effectiveUnit'
      );
      const expectedLineTotal = safeMultiply(line.quantity, effectiveUnit, 'lineTotalUnits');
      if (line.lineTotalUnits !== expectedLineTotal) {
        throw new StorageError('INVALID_RECORD', 'Confirmed line total mismatch.', {
          itemId: line.itemId,
          expectedLineTotal,
          lineTotalUnits: line.lineTotalUnits,
        });
      }
      computedTotal = safeAdd(computedTotal, expectedLineTotal, 'totalUnits');
    }

    if (validated.totalUnits !== computedTotal) {
      throw new StorageError('INVALID_RECORD', 'Confirmed sale totalUnits mismatch.', {
        expectedTotal: computedTotal,
        totalUnits: validated.totalUnits,
      });
    }

    if (validated.payment.status === 'CASH_RECORDED') {
      if (validated.payment.receivedUnits < validated.totalUnits) {
        throw new StorageError('INVALID_RECORD', 'Cash received is less than totalUnits.');
      }
      const expectedChange = validated.payment.receivedUnits - validated.totalUnits;
      if (validated.payment.changeUnits !== expectedChange) {
        throw new StorageError('INVALID_RECORD', 'Cash changeUnits mismatch.', {
          expectedChange,
          changeUnits: validated.payment.changeUnits,
        });
      }
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError('INVALID_RECORD', 'Confirmed sale arithmetic validation failed.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return validated;
}

/**
 * Atomically writes an immutable ConfirmedSale, its StoredPaymentRecord, and its initial
 * PENDING QueueEntry in a single IndexedDB transaction. A failure aborts all writes.
 */
export async function confirmSaleAtomically(
  db: BlackOutBridgeDatabase,
  sale: ConfirmedSale,
  options?: { clearDraftId?: string }
): Promise<ConfirmedSaleReceipt> {
  const validatedSale = validateConfirmedSaleIntegrity(sale);

  const paymentRecord: StoredPaymentRecord = {
    saleId: validatedSale.saleId,
    status: validatedSale.payment.status,
    recordedAt: validatedSale.recordedAt,
    currency: validatedSale.currency,
    scale: validatedSale.scale,
    totalUnits: validatedSale.totalUnits,
    payment: validatedSale.payment,
  };

  const queueEntry = QueueEntrySchema.parse({
    saleId: validatedSale.saleId,
    payloadVersion: 1,
    state: 'PENDING',
    attempts: 0,
  });

  const tables = options?.clearDraftId
    ? [db.confirmedSales, db.payments, db.importQueue, db.drafts]
    : [db.confirmedSales, db.payments, db.importQueue];

  try {
    await db.transaction('rw', tables, async () => {
      await db.confirmedSales.add(validatedSale);
      await db.payments.add(paymentRecord);
      await db.importQueue.add(queueEntry);
      if (options?.clearDraftId) {
        await db.drafts.delete(options.clearDraftId);
      }
    });
  } catch (error) {
    if (isConstraintError(error)) {
      throw new StorageError(
        'DUPLICATE_SALE_ID',
        `Confirmed sale ${validatedSale.saleId} already exists and cannot be overwritten.`,
        { saleId: validatedSale.saleId }
      );
    }
    throw new StorageError(
      'ATOMIC_COMMIT_FAILED',
      `Failed to commit sale ${validatedSale.saleId} atomically.`,
      {
        saleId: validatedSale.saleId,
        cause: error instanceof Error ? error.message : String(error),
      }
    );
  }

  return {
    sale: validatedSale,
    payment: paymentRecord,
    queueEntry,
  };
}

export function createDeviceRepository(db: BlackOutBridgeDatabase) {
  return {
    async getOrCreateDeviceId(): Promise<string> {
      return db.transaction('rw', db.meta, async () => {
        const existing = await db.meta.get('sourceDeviceId');
        if (existing?.value) return existing.value;
        const deviceId = globalThis.crypto.randomUUID();
        await db.meta.put({
          key: 'sourceDeviceId',
          value: deviceId,
          updatedAt: new Date().toISOString(),
        });
        return deviceId;
      });
    },

    async requestPersistentStorage(): Promise<{ supported: boolean; persisted: boolean }> {
      const storage = globalThis.navigator?.storage;
      if (!storage || typeof storage.persist !== 'function') {
        return { supported: false, persisted: false };
      }
      const persisted = await storage.persist();
      return { supported: true, persisted };
    },
  };
}

export function createCatalogRepository(db: BlackOutBridgeDatabase) {
  return {
    async saveSnapshot(
      snapshot: CatalogSnapshot,
      options?: { setActive?: boolean }
    ): Promise<CatalogSnapshot> {
      const parsed = CatalogSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) {
        throw new StorageError('INVALID_RECORD', 'Catalog snapshot failed schema validation.', {
          issues: parsed.error.issues.map(issue => issue.message),
        });
      }

      const validSnapshot = parsed.data;
      await db.transaction('rw', [db.catalogSnapshots, db.meta], async () => {
        const existing = await db.catalogSnapshots.get(validSnapshot.snapshotId);
        if (existing) {
          if (!isDeepEqual(existing, validSnapshot)) {
            throw new StorageError(
              'SNAPSHOT_CONFLICT',
              `Snapshot ${validSnapshot.snapshotId} already exists with different contents.`,
              { snapshotId: validSnapshot.snapshotId }
            );
          }
        } else {
          await db.catalogSnapshots.add(validSnapshot);
        }

        if (options?.setActive !== false) {
          await db.meta.put({
            key: 'activeSnapshotId',
            value: validSnapshot.snapshotId,
            updatedAt: new Date().toISOString(),
          });
        }
      });

      return validSnapshot;
    },

    async getSnapshotById(snapshotId: string): Promise<CatalogSnapshot | undefined> {
      return db.catalogSnapshots.get(snapshotId);
    },

    async getActiveSnapshot(): Promise<CatalogSnapshot | undefined> {
      const activeMeta = await db.meta.get('activeSnapshotId');
      if (activeMeta?.value) {
        const snapshot = await db.catalogSnapshots.get(activeMeta.value);
        if (snapshot) return snapshot;
      }
      const latest = await db.catalogSnapshots.orderBy('issuedAt').reverse().first();
      return latest;
    },

    async listSnapshots(): Promise<CatalogSnapshot[]> {
      return db.catalogSnapshots.orderBy('issuedAt').reverse().toArray();
    },

    async setLocalItemAvailability(
      snapshotId: string,
      itemId: string,
      available: boolean
    ): Promise<void> {
      const snapshot = await db.catalogSnapshots.get(snapshotId);
      if (!snapshot) {
        throw new StorageError('SNAPSHOT_NOT_FOUND', `Snapshot ${snapshotId} not found.`, {
          snapshotId,
        });
      }
      const itemExists = snapshot.items.some(item => item.itemId === itemId);
      if (!itemExists) {
        throw new StorageError(
          'INVALID_RECORD',
          `Item ${itemId} does not exist in snapshot ${snapshotId}.`,
          { snapshotId, itemId }
        );
      }

      await db.localOverrides.put({
        snapshotId,
        itemId,
        available,
        updatedAt: new Date().toISOString(),
      });
    },

    async getLocalUnavailableItemIds(snapshotId: string): Promise<Set<string>> {
      const overrides = await db.localOverrides.where('snapshotId').equals(snapshotId).toArray();
      const unavailable = new Set<string>();
      for (const override of overrides) {
        if (!override.available) {
          unavailable.add(override.itemId);
        }
      }
      return unavailable;
    },
  };
}

export function createDraftRepository(db: BlackOutBridgeDatabase) {
  return {
    async saveDraft(
      snapshotId: string,
      lines: readonly DraftLine[],
      draftId = 'active'
    ): Promise<DraftRecord> {
      if (!snapshotId || !draftId) {
        throw new StorageError('INVALID_RECORD', 'snapshotId and draftId must be non-empty.');
      }
      const validatedLines: DraftLine[] = [];
      for (const line of lines) {
        const parsed = DraftLineSchema.safeParse(line);
        if (!parsed.success) {
          throw new StorageError('INVALID_RECORD', 'Draft line failed schema validation.', {
            issues: parsed.error.issues.map(issue => issue.message),
          });
        }
        validatedLines.push(parsed.data);
      }

      const record: DraftRecord = {
        draftId,
        snapshotId,
        lines: validatedLines,
        updatedAt: new Date().toISOString(),
      };
      await db.drafts.put(record);
      return record;
    },

    async getDraft(draftId = 'active'): Promise<DraftRecord | undefined> {
      return db.drafts.get(draftId);
    },

    async clearDraft(draftId = 'active'): Promise<void> {
      await db.drafts.delete(draftId);
    },
  };
}

export function createSaleRepository(db: BlackOutBridgeDatabase) {
  return {
    confirmSale(
      sale: ConfirmedSale,
      options?: { clearDraftId?: string }
    ): Promise<ConfirmedSaleReceipt> {
      return confirmSaleAtomically(db, sale, options);
    },

    async getById(saleId: string): Promise<ConfirmedSale | undefined> {
      return db.confirmedSales.get(saleId);
    },

    async listAll(): Promise<ConfirmedSale[]> {
      return db.confirmedSales.orderBy('recordedAt').reverse().toArray();
    },

    async getReceiptBundle(saleId: string): Promise<ConfirmedSaleReceipt | undefined> {
      return db.transaction('r', [db.confirmedSales, db.payments, db.importQueue], async () => {
        const [sale, payment, queueEntry] = await Promise.all([
          db.confirmedSales.get(saleId),
          db.payments.get(saleId),
          db.importQueue.get(saleId),
        ]);
        if (!sale || !payment || !queueEntry) return undefined;
        return { sale, payment, queueEntry };
      });
    },
  };
}

export function createPaymentRepository(db: BlackOutBridgeDatabase) {
  return {
    async getBySaleId(saleId: string): Promise<StoredPaymentRecord | undefined> {
      return db.payments.get(saleId);
    },

    async listAll(): Promise<StoredPaymentRecord[]> {
      return db.payments.orderBy('recordedAt').reverse().toArray();
    },

    async listByStatus(status: PaymentRecord['status']): Promise<StoredPaymentRecord[]> {
      return db.payments.where('status').equals(status).toArray();
    },

    async summarizeCashTotals(): Promise<CashTotalsSummary> {
      const cashPayments = await db.payments.where('status').equals('CASH_RECORDED').toArray();
      let totalUnits = 0;
      let receivedUnits = 0;
      let changeUnits = 0;

      for (const record of cashPayments) {
        if (record.payment.status !== 'CASH_RECORDED') continue;
        totalUnits = safeAdd(totalUnits, record.totalUnits, 'cashSummary.totalUnits');
        receivedUnits = safeAdd(
          receivedUnits,
          record.payment.receivedUnits,
          'cashSummary.receivedUnits'
        );
        changeUnits = safeAdd(changeUnits, record.payment.changeUnits, 'cashSummary.changeUnits');
      }

      return {
        count: cashPayments.length,
        totalUnits,
        receivedUnits,
        changeUnits,
      };
    },
  };
}

export function createQueueRepository(db: BlackOutBridgeDatabase) {
  const deviceRepo = createDeviceRepository(db);

  return {
    async getBySaleId(saleId: string): Promise<QueueEntry | undefined> {
      return db.importQueue.get(saleId);
    },

    async listAll(): Promise<QueueEntry[]> {
      return db.importQueue.toArray();
    },

    async listByState(state: QueueState): Promise<QueueEntry[]> {
      return db.importQueue.where('state').equals(state).toArray();
    },

    async listPendingWithSales(): Promise<Array<{ sale: ConfirmedSale; queueEntry: QueueEntry }>> {
      return db.transaction('r', [db.importQueue, db.confirmedSales], async () => {
        const pendingEntries = await db.importQueue.where('state').equals('PENDING').toArray();
        const paired: Array<{ sale: ConfirmedSale; queueEntry: QueueEntry }> = [];
        for (const queueEntry of pendingEntries) {
          const sale = await db.confirmedSales.get(queueEntry.saleId);
          if (sale) {
            paired.push({ sale, queueEntry });
          }
        }
        paired.sort((a, b) => a.sale.recordedAt.localeCompare(b.sale.recordedAt));
        return paired;
      });
    },

    async recordAttemptFailure(saleId: string, errorCode: string): Promise<QueueEntry> {
      if (!errorCode) {
        throw new StorageError('INVALID_RECORD', 'errorCode must be non-empty.');
      }
      return db.transaction('rw', db.importQueue, async () => {
        const existing = await db.importQueue.get(saleId);
        if (!existing) {
          throw new StorageError('QUEUE_ENTRY_NOT_FOUND', `Queue entry ${saleId} not found.`, {
            saleId,
          });
        }
        if (existing.state === 'IMPORTED') {
          throw new StorageError(
            'INVALID_QUEUE_TRANSITION',
            `Cannot record failure on already imported sale ${saleId}.`,
            { saleId }
          );
        }
        const updated = QueueEntrySchema.parse({
          saleId: existing.saleId,
          payloadVersion: 1,
          state: 'PENDING',
          attempts: existing.attempts + 1,
          lastErrorCode: errorCode,
        });
        await db.importQueue.put(updated);
        return updated;
      });
    },

    async markReviewRequired(
      saleId: string,
      errorCode: string,
      options?: { incrementAttempts?: boolean }
    ): Promise<QueueEntry> {
      if (!errorCode) {
        throw new StorageError('INVALID_RECORD', 'errorCode must be non-empty.');
      }
      return db.transaction('rw', db.importQueue, async () => {
        const existing = await db.importQueue.get(saleId);
        if (!existing) {
          throw new StorageError('QUEUE_ENTRY_NOT_FOUND', `Queue entry ${saleId} not found.`, {
            saleId,
          });
        }
        if (existing.state === 'IMPORTED') {
          throw new StorageError(
            'INVALID_QUEUE_TRANSITION',
            `Cannot move already imported sale ${saleId} to REVIEW_REQUIRED.`,
            { saleId }
          );
        }
        const updated = QueueEntrySchema.parse({
          saleId: existing.saleId,
          payloadVersion: 1,
          state: 'REVIEW_REQUIRED',
          attempts: options?.incrementAttempts ? existing.attempts + 1 : existing.attempts,
          lastErrorCode: errorCode,
        });
        await db.importQueue.put(updated);
        return updated;
      });
    },

    async markImported(saleId: string, destinationReceiptId: string): Promise<QueueEntry> {
      if (!destinationReceiptId) {
        throw new StorageError('INVALID_RECORD', 'destinationReceiptId must be non-empty.');
      }
      return db.transaction('rw', db.importQueue, async () => {
        const existing = await db.importQueue.get(saleId);
        if (!existing) {
          throw new StorageError('QUEUE_ENTRY_NOT_FOUND', `Queue entry ${saleId} not found.`, {
            saleId,
          });
        }
        if (existing.state === 'IMPORTED') {
          if (existing.destinationReceiptId === destinationReceiptId) {
            return existing;
          }
          throw new StorageError(
            'INVALID_QUEUE_TRANSITION',
            `Sale ${saleId} is already imported with a different receipt ID.`,
            {
              saleId,
              existingReceiptId: existing.destinationReceiptId,
              destinationReceiptId,
            }
          );
        }
        const updated = QueueEntrySchema.parse({
          saleId: existing.saleId,
          payloadVersion: 1,
          state: 'IMPORTED',
          attempts: existing.attempts,
          destinationReceiptId,
        });
        await db.importQueue.put(updated);
        return updated;
      });
    },

    async requeueForRetry(saleId: string): Promise<QueueEntry> {
      return db.transaction('rw', db.importQueue, async () => {
        const existing = await db.importQueue.get(saleId);
        if (!existing) {
          throw new StorageError('QUEUE_ENTRY_NOT_FOUND', `Queue entry ${saleId} not found.`, {
            saleId,
          });
        }
        if (existing.state === 'IMPORTED') {
          throw new StorageError(
            'INVALID_QUEUE_TRANSITION',
            `Cannot requeue already imported sale ${saleId}.`,
            { saleId }
          );
        }
        const updated = QueueEntrySchema.parse({
          saleId: existing.saleId,
          payloadVersion: 1,
          state: 'PENDING',
          attempts: existing.attempts,
          ...(existing.lastErrorCode ? { lastErrorCode: existing.lastErrorCode } : {}),
        });
        await db.importQueue.put(updated);
        return updated;
      });
    },

    async exportPendingSalesBackup(): Promise<PendingSalesBackup> {
      const sourceDeviceId = await deviceRepo.getOrCreateDeviceId();
      const entries = await db.transaction('r', [db.importQueue, db.confirmedSales], async () => {
        const allQueue = await db.importQueue.toArray();
        const unresolved: Array<{ sale: ConfirmedSale; queueEntry: QueueEntry }> = [];
        for (const queueEntry of allQueue) {
          if (queueEntry.state === 'IMPORTED') continue;
          const sale = await db.confirmedSales.get(queueEntry.saleId);
          if (sale) {
            unresolved.push({ sale, queueEntry });
          }
        }
        unresolved.sort((a, b) => a.sale.recordedAt.localeCompare(b.sale.recordedAt));
        return unresolved;
      });

      return {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        sourceDeviceId,
        pendingCount: entries.length,
        entries,
      };
    },
  };
}

export function createStorageRepositories(db: BlackOutBridgeDatabase) {
  return {
    db,
    device: createDeviceRepository(db),
    catalog: createCatalogRepository(db),
    drafts: createDraftRepository(db),
    sales: createSaleRepository(db),
    payments: createPaymentRepository(db),
    queue: createQueueRepository(db),
  };
}

export type StorageRepositories = ReturnType<typeof createStorageRepositories>;
