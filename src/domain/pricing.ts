import {
  CatalogItem,
  CatalogModifier,
  CatalogOptionGroup,
  CatalogSnapshot,
  CatalogSnapshotSchema,
  ConfirmedLine,
  ConfirmedSale,
  ConfirmedSaleSchema,
  DraftLine,
  PaymentRecord,
} from './contracts';

export type PricingErrorCode =
  | 'INVALID_INTEGER'
  | 'NEGATIVE_AMOUNT'
  | 'INTEGER_OVERFLOW'
  | 'INVALID_QUANTITY'
  | 'EMPTY_CART'
  | 'UNKNOWN_ITEM'
  | 'ITEM_UNAVAILABLE'
  | 'UNKNOWN_MODIFIER'
  | 'DUPLICATE_MODIFIER'
  | 'MULTIPLE_GROUP_SELECTIONS'
  | 'MISSING_REQUIRED_OPTION'
  | 'NEGATIVE_UNIT_PRICE'
  | 'INSUFFICIENT_CASH'
  | 'INVALID_CATALOG'
  | 'INVALID_SALE_INPUT';

/**
 * Typed domain error thrown on invalid pricing, catalog, or payment inputs.
 */
export class DomainPricingError extends Error {
  readonly code: PricingErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PricingErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainPricingError';
    this.code = code;
    this.details = details;
  }
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 99;

/**
 * Validates that a number is a finite safe signed integer.
 */
export function assertSafeSignedInt(value: number, field = 'delta'): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new DomainPricingError('INVALID_INTEGER', `${field} must be a finite integer.`, {
      field,
      value,
    });
  }
  if (!Number.isInteger(value)) {
    throw new DomainPricingError('INVALID_INTEGER', `${field} must be an integer.`, {
      field,
      value,
    });
  }
  if (!Number.isSafeInteger(value)) {
    throw new DomainPricingError(
      'INTEGER_OVERFLOW',
      `${field} exceeds safe integer bounds.`,
      { field, value }
    );
  }
  return value;
}

/**
 * Validates that a number is a finite, nonnegative safe integer.
 */
export function assertSafeNonNegativeInt(value: number, field = 'amount'): number {
  assertSafeSignedInt(value, field);
  if (value < 0) {
    throw new DomainPricingError('NEGATIVE_AMOUNT', `${field} must be nonnegative.`, {
      field,
      value,
    });
  }
  return value;
}

/**
 * Overflow-checked addition of two safe signed integers.
 */
export function safeAddSigned(a: number, b: number, field = 'sum'): number {
  const left = assertSafeSignedInt(a, `${field}.left`);
  const right = assertSafeSignedInt(b, `${field}.right`);
  const result = BigInt(left) + BigInt(right);
  if (result > MAX_SAFE_BIGINT || result < MIN_SAFE_BIGINT) {
    throw new DomainPricingError('INTEGER_OVERFLOW', `${field} exceeds safe integer bounds.`, {
      field,
    });
  }
  return Number(result);
}

/**
 * Overflow-checked addition of two safe nonnegative integers.
 */
export function safeAdd(a: number, b: number, field = 'sum'): number {
  const left = assertSafeNonNegativeInt(a, `${field}.left`);
  const right = assertSafeNonNegativeInt(b, `${field}.right`);
  const result = BigInt(left) + BigInt(right);
  if (result > MAX_SAFE_BIGINT) {
    throw new DomainPricingError('INTEGER_OVERFLOW', `${field} exceeds Number.MAX_SAFE_INTEGER.`, {
      field,
    });
  }
  return Number(result);
}

/**
 * Overflow-checked multiplication of two safe nonnegative integers.
 */
export function safeMultiply(a: number, b: number, field = 'product'): number {
  const left = assertSafeNonNegativeInt(a, `${field}.left`);
  const right = assertSafeNonNegativeInt(b, `${field}.right`);
  const result = BigInt(left) * BigInt(right);
  if (result > MAX_SAFE_BIGINT) {
    throw new DomainPricingError('INTEGER_OVERFLOW', `${field} exceeds Number.MAX_SAFE_INTEGER.`, {
      field,
    });
  }
  return Number(result);
}

/**
 * Validates item quantity according to contract bounds (integer 1..99).
 */
export function validateQuantity(quantity: number): number {
  if (
    typeof quantity !== 'number' ||
    !Number.isSafeInteger(quantity) ||
    quantity < MIN_QUANTITY ||
    quantity > MAX_QUANTITY
  ) {
    throw new DomainPricingError(
      'INVALID_QUANTITY',
      `Quantity must be an integer between ${MIN_QUANTITY} and ${MAX_QUANTITY}.`,
      { quantity }
    );
  }
  return quantity;
}

function assertValidSnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
  const parsed = CatalogSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new DomainPricingError('INVALID_CATALOG', 'Catalog snapshot failed schema validation.', {
      issues: parsed.error.issues.map(issue => issue.message),
    });
  }
  return parsed.data;
}

function indexCatalogItems(snapshot: CatalogSnapshot): Map<string, CatalogItem> {
  const itemsById = new Map<string, CatalogItem>();
  for (const item of snapshot.items) {
    if (itemsById.has(item.itemId)) {
      throw new DomainPricingError('INVALID_CATALOG', `Duplicate itemId in catalog: ${item.itemId}`, {
        itemId: item.itemId,
      });
    }
    itemsById.set(item.itemId, item);
  }
  return itemsById;
}

function indexOptionGroups(
  item: CatalogItem
): Map<string, { group: CatalogOptionGroup; choice: CatalogModifier }> {
  const seenGroupIds = new Set<string>();
  const byModifierId = new Map<string, { group: CatalogOptionGroup; choice: CatalogModifier }>();

  for (const group of item.optionGroups) {
    if (seenGroupIds.has(group.groupId)) {
      throw new DomainPricingError(
        'INVALID_CATALOG',
        `Duplicate option groupId ${group.groupId} on item ${item.itemId}.`,
        { itemId: item.itemId, groupId: group.groupId }
      );
    }
    seenGroupIds.add(group.groupId);

    for (const choice of group.choices) {
      if (byModifierId.has(choice.modifierId)) {
        throw new DomainPricingError(
          'INVALID_CATALOG',
          `Duplicate modifierId ${choice.modifierId} on item ${item.itemId}.`,
          { itemId: item.itemId, groupId: group.groupId, modifierId: choice.modifierId }
        );
      }
      byModifierId.set(choice.modifierId, { group, choice });
    }
  }
  return byModifierId;
}

function priceDraftLineWithIndex(
  line: DraftLine,
  itemsById: ReadonlyMap<string, CatalogItem>,
  localUnavailableItemIds?: ReadonlySet<string>
): ConfirmedLine {
  if (!line || typeof line !== 'object' || typeof line.itemId !== 'string' || !line.itemId) {
    throw new DomainPricingError('UNKNOWN_ITEM', 'Draft line is missing a valid itemId.');
  }
  if (!Array.isArray(line.modifierIds)) {
    throw new DomainPricingError('UNKNOWN_MODIFIER', 'Draft line modifierIds must be an array.', {
      itemId: line.itemId,
    });
  }

  const quantity = validateQuantity(line.quantity);
  const item = itemsById.get(line.itemId);
  if (!item) {
    throw new DomainPricingError('UNKNOWN_ITEM', `Unknown catalog item: ${line.itemId}`, {
      itemId: line.itemId,
    });
  }
  if (!item.available || localUnavailableItemIds?.has(item.itemId)) {
    throw new DomainPricingError('ITEM_UNAVAILABLE', `Catalog item is unavailable: ${item.itemId}`, {
      itemId: item.itemId,
    });
  }

  const capturedUnitPriceUnits = assertSafeNonNegativeInt(item.unitPriceUnits, 'unitPriceUnits');
  const byModifierId = indexOptionGroups(item);
  const seenModifiers = new Set<string>();
  const selectedGroups = new Set<string>();
  let capturedModifierDeltaUnits = 0;

  for (const modifierId of line.modifierIds) {
    if (typeof modifierId !== 'string' || !modifierId) {
      throw new DomainPricingError('UNKNOWN_MODIFIER', 'Modifier ID must be a non-empty string.', {
        itemId: item.itemId,
      });
    }
    if (seenModifiers.has(modifierId)) {
      throw new DomainPricingError(
        'DUPLICATE_MODIFIER',
        `Duplicate modifier ${modifierId} on item ${item.itemId}.`,
        { itemId: item.itemId, modifierId }
      );
    }
    const entry = byModifierId.get(modifierId);
    if (!entry) {
      throw new DomainPricingError(
        'UNKNOWN_MODIFIER',
        `Modifier ${modifierId} is not supported on item ${item.itemId}.`,
        { itemId: item.itemId, modifierId }
      );
    }
    if (selectedGroups.has(entry.group.groupId)) {
      throw new DomainPricingError(
        'MULTIPLE_GROUP_SELECTIONS',
        `Only one choice may be selected for option group ${entry.group.groupId} on item ${item.itemId}.`,
        { itemId: item.itemId, groupId: entry.group.groupId, modifierId }
      );
    }
    seenModifiers.add(modifierId);
    selectedGroups.add(entry.group.groupId);
    const delta = assertSafeSignedInt(entry.choice.deltaUnits, 'modifier.deltaUnits');
    capturedModifierDeltaUnits = safeAddSigned(
      capturedModifierDeltaUnits,
      delta,
      'capturedModifierDeltaUnits'
    );
  }

  for (const group of item.optionGroups) {
    if (group.required && !selectedGroups.has(group.groupId)) {
      throw new DomainPricingError(
        'MISSING_REQUIRED_OPTION',
        `Required option group ${group.groupId} was not selected for item ${item.itemId}.`,
        { itemId: item.itemId, groupId: group.groupId }
      );
    }
  }

  const effectiveUnitPrice = safeAddSigned(
    capturedUnitPriceUnits,
    capturedModifierDeltaUnits,
    'effectiveUnitPrice'
  );
  if (effectiveUnitPrice < 0) {
    throw new DomainPricingError(
      'NEGATIVE_UNIT_PRICE',
      `Selected options reduce unit price below zero for item ${item.itemId}.`,
      { itemId: item.itemId, capturedUnitPriceUnits, capturedModifierDeltaUnits, effectiveUnitPrice }
    );
  }
  const lineTotalUnits = safeMultiply(quantity, effectiveUnitPrice, 'lineTotalUnits');

  return {
    itemId: item.itemId,
    quantity,
    modifierIds: [...line.modifierIds],
    capturedUnitPriceUnits,
    capturedModifierDeltaUnits,
    lineTotalUnits,
  };
}

/**
 * Validates and deterministically prices a single draft line from an approved catalog snapshot.
 */
export function priceDraftLine(
  line: DraftLine,
  snapshot: CatalogSnapshot,
  localUnavailableItemIds?: ReadonlySet<string>
): ConfirmedLine {
  const validSnapshot = assertValidSnapshot(snapshot);
  const itemsById = indexCatalogItems(validSnapshot);
  return priceDraftLineWithIndex(line, itemsById, localUnavailableItemIds);
}

/**
 * Validates and deterministically prices an entire cart from an approved catalog snapshot.
 */
export function priceCart(
  lines: readonly DraftLine[],
  snapshot: CatalogSnapshot,
  localUnavailableItemIds?: ReadonlySet<string>
): { lines: ConfirmedLine[]; totalUnits: number } {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new DomainPricingError('EMPTY_CART', 'At least one line is required to price a cart.');
  }

  const validSnapshot = assertValidSnapshot(snapshot);
  const itemsById = indexCatalogItems(validSnapshot);
  const confirmedLines: ConfirmedLine[] = [];
  let totalUnits = 0;

  for (const line of lines) {
    const priced = priceDraftLineWithIndex(line, itemsById, localUnavailableItemIds);
    confirmedLines.push(priced);
    totalUnits = safeAdd(totalUnits, priced.lineTotalUnits, 'totalUnits');
  }

  return { lines: confirmedLines, totalUnits };
}

/**
 * Computes exact cash change in minor currency units, rejecting underpayment and overflow.
 */
export function calculateCashPayment(
  totalUnits: number,
  receivedUnits: number
): Extract<PaymentRecord, { status: 'CASH_RECORDED' }> {
  const validTotal = assertSafeNonNegativeInt(totalUnits, 'totalUnits');
  const validReceived = assertSafeNonNegativeInt(receivedUnits, 'receivedUnits');

  if (validReceived < validTotal) {
    throw new DomainPricingError(
      'INSUFFICIENT_CASH',
      'Received cash is less than the bill total.',
      { totalUnits: validTotal, receivedUnits: validReceived }
    );
  }

  const changeUnits = validReceived - validTotal;
  return {
    status: 'CASH_RECORDED',
    receivedUnits: validReceived,
    changeUnits,
  };
}

export type BuildConfirmedSaleInput = {
  saleId: string;
  sourceDeviceId: string;
  snapshot: CatalogSnapshot;
  recordedAt: string;
  draftLines: readonly DraftLine[];
  payment: PaymentRecord;
  localUnavailableItemIds?: ReadonlySet<string>;
};

/**
 * Constructs and schema-validates an immutable ConfirmedSale from approved catalog prices.
 */
export function buildConfirmedSale(input: BuildConfirmedSaleInput): ConfirmedSale {
  const { lines, totalUnits } = priceCart(
    input.draftLines,
    input.snapshot,
    input.localUnavailableItemIds
  );

  let validatedPayment: PaymentRecord;
  if (input.payment.status === 'CASH_RECORDED') {
    const expectedPayment = calculateCashPayment(totalUnits, input.payment.receivedUnits);
    if (input.payment.changeUnits !== expectedPayment.changeUnits) {
      throw new DomainPricingError(
        'INVALID_SALE_INPUT',
        'Recorded cash change does not match receivedUnits - totalUnits.',
        {
          expectedChangeUnits: expectedPayment.changeUnits,
          providedChangeUnits: input.payment.changeUnits,
        }
      );
    }
    validatedPayment = expectedPayment;
  } else {
    validatedPayment = input.payment;
  }

  const candidate: ConfirmedSale = {
    currency: input.snapshot.currency,
    scale: input.snapshot.scale,
    saleId: input.saleId,
    sourceDeviceId: input.sourceDeviceId,
    snapshotId: input.snapshot.snapshotId,
    recordedAt: input.recordedAt,
    lines,
    totalUnits,
    payment: validatedPayment,
  };

  const parsed = ConfirmedSaleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DomainPricingError(
      'INVALID_SALE_INPUT',
      'Confirmed sale failed contract validation.',
      { issues: parsed.error.issues.map(issue => issue.message) }
    );
  }
  return parsed.data;
}
