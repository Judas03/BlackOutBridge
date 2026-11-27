import { Dexie, type DexieOptions, type Table } from 'dexie';
import type {
  CatalogSnapshot,
  ConfirmedSale,
  DraftLine,
  PaymentRecord,
  QueueEntry,
} from '../domain';

export type MetaRecord = {
  key: string;
  value: string;
  updatedAt: string;
};

export type LocalAvailabilityOverrideRecord = {
  snapshotId: string;
  itemId: string;
  available: boolean;
  updatedAt: string;
};

export type DraftRecord = {
  draftId: string;
  snapshotId: string;
  lines: DraftLine[];
  updatedAt: string;
};

export type StoredPaymentRecord = {
  saleId: string;
  status: PaymentRecord['status'];
  recordedAt: string;
  currency: 'THB';
  scale: 2;
  totalUnits: number;
  payment: PaymentRecord;
};

export type ConfirmedSaleReceipt = {
  sale: ConfirmedSale;
  payment: StoredPaymentRecord;
  queueEntry: QueueEntry;
};

export type StorageErrorCode =
  | 'DUPLICATE_SALE_ID'
  | 'INVALID_RECORD'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_CONFLICT'
  | 'QUEUE_ENTRY_NOT_FOUND'
  | 'INVALID_QUEUE_TRANSITION'
  | 'ATOMIC_COMMIT_FAILED';

/**
 * Typed error raised by local IndexedDB repositories and atomic transactions.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: StorageErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.details = details;
  }
}

export const DEFAULT_DATABASE_NAME = 'BlackOutBridgeDB';

/**
 * Dexie v4 database holding approved catalog snapshots, local availability overrides,
 * drafts, immutable confirmed sales, payment records, and the recovery queue.
 */
export class BlackOutBridgeDatabase extends Dexie {
  meta!: Table<MetaRecord, string>;
  catalogSnapshots!: Table<CatalogSnapshot, string>;
  localOverrides!: Table<LocalAvailabilityOverrideRecord, [string, string]>;
  drafts!: Table<DraftRecord, string>;
  confirmedSales!: Table<ConfirmedSale, string>;
  payments!: Table<StoredPaymentRecord, string>;
  importQueue!: Table<QueueEntry, string>;

  constructor(name = DEFAULT_DATABASE_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      meta: 'key',
      catalogSnapshots: 'snapshotId, issuedAt, sourcePosId',
      localOverrides: '[snapshotId+itemId], snapshotId',
      drafts: 'draftId, snapshotId, updatedAt',
      confirmedSales: 'saleId, snapshotId, recordedAt',
      payments: 'saleId, status, recordedAt',
      importQueue: 'saleId, state, attempts',
    });
  }
}

export function createDatabase(
  name = DEFAULT_DATABASE_NAME,
  options?: DexieOptions
): BlackOutBridgeDatabase {
  return new BlackOutBridgeDatabase(name, options);
}
