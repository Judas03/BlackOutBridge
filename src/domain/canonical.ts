import { ConfirmedSale, ConfirmedSaleSchema, PaymentRecord } from './contracts';

function canonicalizePayment(payment: PaymentRecord): Record<string, unknown> {
  switch (payment.status) {
    case 'UNPAID':
      return {
        status: payment.status,
        receivedUnits: payment.receivedUnits,
      };
    case 'CASH_RECORDED':
      return {
        status: payment.status,
        receivedUnits: payment.receivedUnits,
        changeUnits: payment.changeUnits,
      };
    case 'EXTERNAL_UNVERIFIED':
      return {
        status: payment.status,
        receivedUnits: payment.receivedUnits,
        reference: payment.reference,
      };
  }
}

/**
 * Produces a deterministic canonical JSON string over all immutable financial fields of a ConfirmedSale.
 * Preserves line order and modifier order verbatim while fixing property order regardless of JS object insertion order.
 */
export function canonicalizeSalePayload(sale: ConfirmedSale): string {
  const parsed = ConfirmedSaleSchema.parse(sale);
  const canonical = {
    currency: parsed.currency,
    scale: parsed.scale,
    saleId: parsed.saleId,
    sourceDeviceId: parsed.sourceDeviceId,
    snapshotId: parsed.snapshotId,
    recordedAt: parsed.recordedAt,
    totalUnits: parsed.totalUnits,
    payment: canonicalizePayment(parsed.payment),
    lines: parsed.lines.map(line => ({
      itemId: line.itemId,
      quantity: line.quantity,
      modifierIds: [...line.modifierIds],
      capturedUnitPriceUnits: line.capturedUnitPriceUnits,
      capturedModifierDeltaUnits: line.capturedModifierDeltaUnits,
      lineTotalUnits: line.lineTotalUnits,
    })),
  };
  return JSON.stringify(canonical);
}

/**
 * Computes a lowercase SHA-256 hex digest of the canonical ConfirmedSale payload using Web Crypto.
 * Compatible with both browser contexts and Node 24 server runtime.
 */
export async function computeSaleDigest(sale: ConfirmedSale): Promise<string> {
  const canonical = canonicalizeSalePayload(sale);
  const bytes = new TextEncoder().encode(canonical);
  const digestBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const digestBytes = new Uint8Array(digestBuffer);
  return Array.from(digestBytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
