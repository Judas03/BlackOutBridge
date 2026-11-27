import {
  CatalogSnapshot,
  ConfirmedSale,
  ImportResult,
  PosConnector,
  PreviewItem,
  QueueEntry,
} from '../domain';
import { StorageRepositories } from '../storage';
import {
  ConnectorError,
  ConnectorErrorCode,
  describeRecoveryCode,
  isConnectorError,
  SanitizedIssueCode,
  sanitizeIssueCodes,
  UNKNOWN_BACKEND_ISSUE,
} from './connector';

const UNCERTAIN_ERROR_CODES: ReadonlySet<string> = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'SERVER_ERROR',
  'INVALID_RESPONSE',
]);

export type RecoveryRunOutcome =
  | 'COMPLETED'
  | 'AUTH_REQUIRED'
  | 'ACCESS_DENIED'
  | 'TRANSIENT_FAILURE'
  | 'ERROR';

export type RecoveryPreviewReport = {
  outcome: RecoveryRunOutcome;
  errorCode?: ConnectorErrorCode;
  message?: string;
  items: Array<Omit<PreviewItem, 'issueCodes'> & { issueCodes: SanitizedIssueCode[] }>;
  summary: {
    ready: number;
    alreadyImported: number;
    reviewRequired: number;
  };
};

export type SaleCommitOutcome = {
  saleId: string;
  status: 'IMPORTED' | 'ALREADY_IMPORTED' | 'REVIEW_REQUIRED' | 'PENDING_RETRY';
  destinationReceiptId?: string;
  issueCodes: SanitizedIssueCode[];
  errorCode?: string;
  resolvedViaStatus?: boolean;
};

export type RecoveryCommitReport = {
  outcome: RecoveryRunOutcome;
  errorCode?: ConnectorErrorCode;
  message?: string;
  outcomes: SaleCommitOutcome[];
  summary: {
    imported: number;
    alreadyImported: number;
    reviewRequired: number;
    pendingRetry: number;
  };
};

export type SaleReconciliationOutcome =
  | {
      status: 'IMPORTED' | 'ALREADY_IMPORTED';
      saleId: string;
      destinationReceiptId: string;
      issueCodes: SanitizedIssueCode[];
    }
  | {
      status: 'REVIEW_REQUIRED';
      saleId: string;
      issueCodes: SanitizedIssueCode[];
      errorCode: SanitizedIssueCode;
    }
  | {
      status: 'NOT_FOUND';
      saleId: string;
    }
  | {
      status: 'AUTH_REQUIRED' | 'ACCESS_DENIED' | 'TRANSIENT_FAILURE' | 'ERROR';
      saleId: string;
      errorCode: ConnectorErrorCode;
      message: string;
    };

export type RecoveryEngineDeps = {
  storage: StorageRepositories;
  connector: PosConnector;
  batchSize?: number;
  reconcileBeforeCommit?: boolean;
  resolveUncertainViaStatus?: boolean;
};

export type PreviewPendingOptions = {
  saleIds?: readonly string[];
};

export type CommitPendingOptions = {
  saleIds?: readonly string[];
  batchSize?: number;
  reconcileBeforeCommit?: boolean;
  resolveUncertainViaStatus?: boolean;
};

type PendingPair = { sale: ConfirmedSale; queueEntry: QueueEntry };

function normalizeConnectorError(error: unknown): ConnectorError {
  if (isConnectorError(error)) {
    return error;
  }
  return new ConnectorError('NETWORK_ERROR', describeRecoveryCode('NETWORK_ERROR'), {
    retriable: true,
  });
}

function hasValidReceiptId(result: ImportResult): result is ImportResult & { destinationReceiptId: string } {
  return (
    typeof result.destinationReceiptId === 'string' &&
    result.destinationReceiptId.trim().length > 0
  );
}

function summarizeOutcomes(outcomes: readonly SaleCommitOutcome[]): RecoveryCommitReport['summary'] {
  let imported = 0;
  let alreadyImported = 0;
  let reviewRequired = 0;
  let pendingRetry = 0;

  for (const outcome of outcomes) {
    switch (outcome.status) {
      case 'IMPORTED':
        imported += 1;
        break;
      case 'ALREADY_IMPORTED':
        alreadyImported += 1;
        break;
      case 'REVIEW_REQUIRED':
        reviewRequired += 1;
        break;
      case 'PENDING_RETRY':
        pendingRetry += 1;
        break;
    }
  }

  return { imported, alreadyImported, reviewRequired, pendingRetry };
}

function mapFailureOutcome(error: ConnectorError): RecoveryRunOutcome {
  if (error.code === 'AUTH_REQUIRED') return 'AUTH_REQUIRED';
  if (error.code === 'ACCESS_DENIED') return 'ACCESS_DENIED';
  if (error.retriable) return 'TRANSIENT_FAILURE';
  return 'ERROR';
}

function filterPendingPairs(
  pairs: readonly PendingPair[],
  saleIds?: readonly string[]
): PendingPair[] {
  if (!saleIds) return [...pairs];
  const allowed = new Set(saleIds);
  return pairs.filter(pair => allowed.has(pair.sale.saleId));
}

function resolveBatchSize(batchSize: number | undefined, total: number): number {
  if (batchSize === undefined) {
    return Math.max(1, total);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new ConnectorError('INVALID_REQUEST', describeRecoveryCode('INVALID_REQUEST'), {
      retriable: false,
    });
  }
  return batchSize;
}

/**
 * Durable offline queue orchestrator coordinating preview, status reconciliation,
 * atomic batch commit, and sanitized exception handling without mutating confirmed local sales.
 */
export function createRecoveryEngine(deps: RecoveryEngineDeps) {
  const { storage, connector } = deps;
  const defaultReconcileBeforeCommit = deps.reconcileBeforeCommit ?? true;
  const defaultResolveUncertainViaStatus = deps.resolveUncertainViaStatus ?? true;

  async function applyResolvedImportResult(
    saleId: string,
    result: ImportResult,
    options: { resolvedViaStatus: boolean; incrementReviewAttempt: boolean }
  ): Promise<SaleCommitOutcome> {
    if (result.saleId !== saleId) {
      await storage.queue.recordAttemptFailure(saleId, 'INVALID_RESPONSE');
      return {
        saleId,
        status: 'PENDING_RETRY',
        issueCodes: [],
        errorCode: 'INVALID_RESPONSE',
      };
    }

    const issueCodes = sanitizeIssueCodes(result.issueCodes);

    if (result.status === 'IMPORTED' || result.status === 'ALREADY_IMPORTED') {
      if (!hasValidReceiptId(result)) {
        await storage.queue.recordAttemptFailure(saleId, 'INVALID_RESPONSE');
        return {
          saleId,
          status: 'PENDING_RETRY',
          issueCodes: [],
          errorCode: 'INVALID_RESPONSE',
        };
      }
      await storage.queue.markImported(saleId, result.destinationReceiptId);
      return {
        saleId,
        status: result.status,
        destinationReceiptId: result.destinationReceiptId,
        issueCodes,
        ...(options.resolvedViaStatus ? { resolvedViaStatus: true } : {}),
      };
    }

    const primaryIssue = issueCodes[0] ?? UNKNOWN_BACKEND_ISSUE;
    await storage.queue.markReviewRequired(saleId, primaryIssue, {
      incrementAttempts: options.incrementReviewAttempt,
    });
    return {
      saleId,
      status: 'REVIEW_REQUIRED',
      issueCodes,
      errorCode: primaryIssue,
      ...(options.resolvedViaStatus ? { resolvedViaStatus: true } : {}),
    };
  }

  async function applyAuthFailureToSales(
    sales: readonly PendingPair[],
    outcomes: SaleCommitOutcome[],
    incrementStartIndex = 0,
    incrementEndIndex = sales.length
  ): Promise<void> {
    for (let i = incrementStartIndex; i < incrementEndIndex; i += 1) {
      const { sale } = sales[i];
      await storage.queue.recordAttemptFailure(sale.saleId, 'AUTH_REQUIRED');
      outcomes.push({
        saleId: sale.saleId,
        status: 'PENDING_RETRY',
        issueCodes: [],
        errorCode: 'AUTH_REQUIRED',
      });
    }
  }

  async function applyAccessDeniedToSales(
    sales: readonly PendingPair[],
    outcomes: SaleCommitOutcome[],
    incrementEndIndex: number
  ): Promise<void> {
    for (let i = 0; i < sales.length; i += 1) {
      const { sale } = sales[i];
      await storage.queue.markReviewRequired(sale.saleId, 'ACCESS_DENIED', {
        incrementAttempts: i < incrementEndIndex,
      });
      outcomes.push({
        saleId: sale.saleId,
        status: 'REVIEW_REQUIRED',
        issueCodes: [],
        errorCode: 'ACCESS_DENIED',
      });
    }
  }

  function buildCommitReport(
    outcome: RecoveryRunOutcome,
    outcomes: SaleCommitOutcome[],
    error?: ConnectorError
  ): RecoveryCommitReport {
    return {
      outcome,
      ...(error ? { errorCode: error.code, message: error.message } : {}),
      outcomes,
      summary: summarizeOutcomes(outcomes),
    };
  }

  return {
    async refreshCatalog(): Promise<CatalogSnapshot> {
      const snapshot = await connector.getCatalog();
      return storage.catalog.saveSnapshot(snapshot);
    },

    async previewPending(options?: PreviewPendingOptions): Promise<RecoveryPreviewReport> {
      const pending = filterPendingPairs(
        await storage.queue.listPendingWithSales(),
        options?.saleIds
      );

      if (pending.length === 0) {
        return {
          outcome: 'COMPLETED',
          items: [],
          summary: { ready: 0, alreadyImported: 0, reviewRequired: 0 },
        };
      }

      try {
        const rawItems = await connector.preview(pending.map(pair => pair.sale));
        if (rawItems.length !== pending.length) {
          throw new ConnectorError('INVALID_RESPONSE', describeRecoveryCode('INVALID_RESPONSE'), {
            retriable: false,
          });
        }

        const sanitizedItems: RecoveryPreviewReport['items'] = [];
        let ready = 0;
        let alreadyImported = 0;
        let reviewRequired = 0;

        for (let i = 0; i < pending.length; i += 1) {
          const item = rawItems[i];
          if (item.saleId !== pending[i].sale.saleId) {
            throw new ConnectorError('INVALID_RESPONSE', describeRecoveryCode('INVALID_RESPONSE'), {
              retriable: false,
            });
          }
          if (
            item.status === 'ALREADY_IMPORTED' &&
            (!item.destinationReceiptId || item.destinationReceiptId.trim().length === 0)
          ) {
            throw new ConnectorError('INVALID_RESPONSE', describeRecoveryCode('INVALID_RESPONSE'), {
              retriable: false,
            });
          }

          const sanitized: RecoveryPreviewReport['items'][number] = {
            saleId: item.saleId,
            status: item.status,
            issueCodes: sanitizeIssueCodes(item.issueCodes),
            ...(item.destinationReceiptId
              ? { destinationReceiptId: item.destinationReceiptId }
              : {}),
          };
          sanitizedItems.push(sanitized);

          if (sanitized.status === 'READY') ready += 1;
          else if (sanitized.status === 'ALREADY_IMPORTED') alreadyImported += 1;
          else reviewRequired += 1;
        }

        return {
          outcome: 'COMPLETED',
          items: sanitizedItems,
          summary: { ready, alreadyImported, reviewRequired },
        };
      } catch (error) {
        const normalized = normalizeConnectorError(error);
        return {
          outcome: mapFailureOutcome(normalized),
          errorCode: normalized.code,
          message: normalized.message,
          items: [],
          summary: { ready: 0, alreadyImported: 0, reviewRequired: 0 },
        };
      }
    },

    async commitPending(options?: CommitPendingOptions): Promise<RecoveryCommitReport> {
      const pending = filterPendingPairs(
        await storage.queue.listPendingWithSales(),
        options?.saleIds
      );

      if (pending.length === 0) {
        return buildCommitReport('COMPLETED', []);
      }

      const reconcileBeforeCommit = options?.reconcileBeforeCommit ?? defaultReconcileBeforeCommit;
      const resolveUncertainViaStatus =
        options?.resolveUncertainViaStatus ?? defaultResolveUncertainViaStatus;
      const effectiveBatchSize = resolveBatchSize(
        options?.batchSize ?? deps.batchSize,
        pending.length
      );

      const outcomes: SaleCommitOutcome[] = [];
      const toCommit: PendingPair[] = [];

      // Phase A: Reconcile previously attempted sales whose prior HTTP outcome was uncertain.
      if (reconcileBeforeCommit) {
        for (let i = 0; i < pending.length; i += 1) {
          const pair = pending[i];
          const needsStatusCheck =
            pair.queueEntry.attempts > 0 &&
            pair.queueEntry.lastErrorCode !== undefined &&
            UNCERTAIN_ERROR_CODES.has(pair.queueEntry.lastErrorCode);

          if (!needsStatusCheck) {
            toCommit.push(pair);
            continue;
          }

          try {
            const statusResult = await connector.status(
              pair.sale.saleId,
              pair.sale.sourceDeviceId
            );
            const outcome = await applyResolvedImportResult(pair.sale.saleId, statusResult, {
              resolvedViaStatus: true,
              incrementReviewAttempt: false,
            });
            outcomes.push(outcome);
            if (outcome.status === 'PENDING_RETRY') {
              const invalidErr = new ConnectorError(
                'INVALID_RESPONSE',
                describeRecoveryCode('INVALID_RESPONSE'),
                { retriable: false }
              );
              return buildCommitReport('ERROR', outcomes, invalidErr);
            }
          } catch (error) {
            const normalized = normalizeConnectorError(error);
            if (normalized.code === 'NOT_FOUND') {
              toCommit.push(pair);
              continue;
            }
            if (normalized.code === 'AUTH_REQUIRED') {
              await applyAuthFailureToSales(pending.slice(i), outcomes);
              return buildCommitReport('AUTH_REQUIRED', outcomes, normalized);
            }
            if (normalized.code === 'ACCESS_DENIED') {
              await applyAccessDeniedToSales(pending.slice(i), outcomes, pending.length - i);
              return buildCommitReport('ACCESS_DENIED', outcomes, normalized);
            }
            if (normalized.retriable) {
              await storage.queue.recordAttemptFailure(pair.sale.saleId, normalized.code);
              outcomes.push({
                saleId: pair.sale.saleId,
                status: 'PENDING_RETRY',
                issueCodes: [],
                errorCode: normalized.code,
              });
              return buildCommitReport('TRANSIENT_FAILURE', outcomes, normalized);
            }
            await storage.queue.recordAttemptFailure(pair.sale.saleId, normalized.code);
            outcomes.push({
              saleId: pair.sale.saleId,
              status: 'PENDING_RETRY',
              issueCodes: [],
              errorCode: normalized.code,
            });
            return buildCommitReport('ERROR', outcomes, normalized);
          }
        }
      } else {
        toCommit.push(...pending);
      }

      if (toCommit.length === 0) {
        return buildCommitReport('COMPLETED', outcomes);
      }

      // Phase B: Commit remaining uncommitted sales in deterministic chunks.
      for (let offset = 0; offset < toCommit.length; offset += effectiveBatchSize) {
        const chunk = toCommit.slice(offset, offset + effectiveBatchSize);
        const remainingFromChunkStart = toCommit.slice(offset);

        try {
          const results = await connector.commit(chunk.map(pair => pair.sale));
          if (results.length !== chunk.length) {
            throw new ConnectorError('INVALID_RESPONSE', describeRecoveryCode('INVALID_RESPONSE'), {
              retriable: false,
            });
          }
          for (let j = 0; j < chunk.length; j += 1) {
            if (results[j].saleId !== chunk[j].sale.saleId) {
              throw new ConnectorError(
                'INVALID_RESPONSE',
                describeRecoveryCode('INVALID_RESPONSE'),
                { retriable: false }
              );
            }
          }

          let invalidResultError: ConnectorError | undefined;
          for (let j = 0; j < chunk.length; j += 1) {
            const outcome = await applyResolvedImportResult(chunk[j].sale.saleId, results[j], {
              resolvedViaStatus: false,
              incrementReviewAttempt: true,
            });
            outcomes.push(outcome);
            if (outcome.status === 'PENDING_RETRY' && !invalidResultError) {
              invalidResultError = new ConnectorError(
                'INVALID_RESPONSE',
                describeRecoveryCode('INVALID_RESPONSE'),
                { retriable: false }
              );
            }
          }

          if (invalidResultError) {
            return buildCommitReport('ERROR', outcomes, invalidResultError);
          }
        } catch (error) {
          const normalized = normalizeConnectorError(error);

          if (normalized.code === 'AUTH_REQUIRED') {
            await applyAuthFailureToSales(chunk, outcomes);
            return buildCommitReport('AUTH_REQUIRED', outcomes, normalized);
          }

          if (normalized.code === 'ACCESS_DENIED') {
            await applyAccessDeniedToSales(remainingFromChunkStart, outcomes, chunk.length);
            return buildCommitReport('ACCESS_DENIED', outcomes, normalized);
          }

          if (normalized.retriable) {
            if (!resolveUncertainViaStatus) {
              for (const pair of chunk) {
                await storage.queue.recordAttemptFailure(pair.sale.saleId, normalized.code);
                outcomes.push({
                  saleId: pair.sale.saleId,
                  status: 'PENDING_RETRY',
                  issueCodes: [],
                  errorCode: normalized.code,
                });
              }
              return buildCommitReport('TRANSIENT_FAILURE', outcomes, normalized);
            }

            // Probe each sale in the uncertain chunk to detect partial commits or lost responses.
            let chunkHasUnresolved = false;
            for (let j = 0; j < chunk.length; j += 1) {
              const pair = chunk[j];
              try {
                const statusResult = await connector.status(
                  pair.sale.saleId,
                  pair.sale.sourceDeviceId
                );
                const resolved = await applyResolvedImportResult(pair.sale.saleId, statusResult, {
                  resolvedViaStatus: true,
                  incrementReviewAttempt: false,
                });
                outcomes.push(resolved);
                if (resolved.status === 'PENDING_RETRY') {
                  chunkHasUnresolved = true;
                }
              } catch (probeRawError) {
                const probeErr = normalizeConnectorError(probeRawError);
                if (probeErr.code === 'NOT_FOUND') {
                  await storage.queue.recordAttemptFailure(pair.sale.saleId, normalized.code);
                  outcomes.push({
                    saleId: pair.sale.saleId,
                    status: 'PENDING_RETRY',
                    issueCodes: [],
                    errorCode: normalized.code,
                  });
                  chunkHasUnresolved = true;
                  continue;
                }
                if (probeErr.code === 'AUTH_REQUIRED') {
                  await applyAuthFailureToSales(chunk.slice(j), outcomes);
                  return buildCommitReport('AUTH_REQUIRED', outcomes, probeErr);
                }
                if (probeErr.code === 'ACCESS_DENIED') {
                  const unprobedAndRemaining = toCommit.slice(offset + j);
                  await applyAccessDeniedToSales(
                    unprobedAndRemaining,
                    outcomes,
                    chunk.length - j
                  );
                  return buildCommitReport('ACCESS_DENIED', outcomes, probeErr);
                }
                if (probeErr.retriable) {
                  for (let k = j; k < chunk.length; k += 1) {
                    await storage.queue.recordAttemptFailure(
                      chunk[k].sale.saleId,
                      probeErr.code
                    );
                    outcomes.push({
                      saleId: chunk[k].sale.saleId,
                      status: 'PENDING_RETRY',
                      issueCodes: [],
                      errorCode: probeErr.code,
                    });
                  }
                  return buildCommitReport('TRANSIENT_FAILURE', outcomes, probeErr);
                }

                await storage.queue.recordAttemptFailure(pair.sale.saleId, 'INVALID_RESPONSE');
                outcomes.push({
                  saleId: pair.sale.saleId,
                  status: 'PENDING_RETRY',
                  issueCodes: [],
                  errorCode: 'INVALID_RESPONSE',
                });
                chunkHasUnresolved = true;
              }
            }

            if (chunkHasUnresolved) {
              return buildCommitReport('TRANSIENT_FAILURE', outcomes, normalized);
            }
            continue;
          }

          for (const pair of chunk) {
            await storage.queue.recordAttemptFailure(pair.sale.saleId, normalized.code);
            outcomes.push({
              saleId: pair.sale.saleId,
              status: 'PENDING_RETRY',
              issueCodes: [],
              errorCode: normalized.code,
            });
          }
          return buildCommitReport('ERROR', outcomes, normalized);
        }
      }

      return buildCommitReport('COMPLETED', outcomes);
    },

    async reconcileSaleStatus(saleId: string): Promise<SaleReconciliationOutcome> {
      const bundle = await storage.sales.getReceiptBundle(saleId);
      if (!bundle) {
        return { status: 'NOT_FOUND', saleId };
      }
      if (bundle.queueEntry.state === 'IMPORTED' && bundle.queueEntry.destinationReceiptId) {
        return {
          status: 'ALREADY_IMPORTED',
          saleId,
          destinationReceiptId: bundle.queueEntry.destinationReceiptId,
          issueCodes: [],
        };
      }

      try {
        const result = await connector.status(bundle.sale.saleId, bundle.sale.sourceDeviceId);
        const outcome = await applyResolvedImportResult(saleId, result, {
          resolvedViaStatus: true,
          incrementReviewAttempt: false,
        });

        if (outcome.status === 'IMPORTED' || outcome.status === 'ALREADY_IMPORTED') {
          return {
            status: outcome.status,
            saleId,
            destinationReceiptId: outcome.destinationReceiptId!,
            issueCodes: outcome.issueCodes,
          };
        }
        if (outcome.status === 'REVIEW_REQUIRED') {
          return {
            status: 'REVIEW_REQUIRED',
            saleId,
            issueCodes: outcome.issueCodes,
            errorCode: (outcome.errorCode as SanitizedIssueCode) ?? UNKNOWN_BACKEND_ISSUE,
          };
        }
        return {
          status: 'ERROR',
          saleId,
          errorCode: 'INVALID_RESPONSE',
          message: describeRecoveryCode('INVALID_RESPONSE'),
        };
      } catch (error) {
        const normalized = normalizeConnectorError(error);
        if (normalized.code === 'NOT_FOUND') {
          return { status: 'NOT_FOUND', saleId };
        }
        return {
          status: mapFailureOutcome(normalized) as
            | 'AUTH_REQUIRED'
            | 'ACCESS_DENIED'
            | 'TRANSIENT_FAILURE'
            | 'ERROR',
          saleId,
          errorCode: normalized.code,
          message: normalized.message,
        };
      }
    },

    async requeueForRetry(saleId: string): Promise<QueueEntry> {
      return storage.queue.requeueForRetry(saleId);
    },

    async requeueAllReviewRequired(filterErrorCode?: string): Promise<QueueEntry[]> {
      const entries = await storage.queue.listByState('REVIEW_REQUIRED');
      const requeued: QueueEntry[] = [];
      for (const entry of entries) {
        if (filterErrorCode !== undefined && entry.lastErrorCode !== filterErrorCode) {
          continue;
        }
        requeued.push(await storage.queue.requeueForRetry(entry.saleId));
      }
      return requeued;
    },
  };
}

export type RecoveryEngine = ReturnType<typeof createRecoveryEngine>;
