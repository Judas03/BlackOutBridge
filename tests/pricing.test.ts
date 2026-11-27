import { describe, expect, it } from 'vitest';
import {
  buildConfirmedSale,
  calculateCashPayment,
  canonicalizeSalePayload,
  CatalogSnapshot,
  computeSaleDigest,
  ConfirmedSale,
  ConfirmedSaleSchema,
  DomainPricingError,
  DraftLineSchema,
  priceCart,
  priceDraftLine,
  safeAdd,
  safeMultiply,
} from '../src/domain';

function makeSnapshot(overrides?: Partial<CatalogSnapshot>): CatalogSnapshot {
  return {
    currency: 'MMK',
    scale: 0,
    snapshotId: 'snap-2026-11-26-01',
    sourcePosId: 'pos-main-01',
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
          { modifierId: 'extra-fritter', name: 'Crispy Fritter', deltaUnits: 500 },
        ],
      },
      {
        itemId: 'milk-tea',
        name: 'Burmese Milk Tea',
        aliases: ['laphet yay'],
        unitPriceUnits: 1500,
        available: true,
        modifiers: [{ modifierId: 'less-sugar', name: 'Less Sugar', deltaUnits: 0 }],
      },
      {
        itemId: 'shan-noodles',
        name: 'Shan Noodles',
        aliases: [],
        unitPriceUnits: 4000,
        available: false,
        modifiers: [],
      },
    ],
    ...overrides,
  };
}

function expectPricingError(fn: () => unknown, expectedCode: DomainPricingError['code']): void {
  try {
    fn();
    expect.fail(`Expected DomainPricingError with code ${expectedCode}, but no error was thrown.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainPricingError);
    expect((error as DomainPricingError).code).toBe(expectedCode);
  }
}

describe('quantities and line pricing', () => {
  it('prices valid boundary quantities 1 and 99 with modifiers', () => {
    const snapshot = makeSnapshot();

    const single = priceDraftLine(
      { itemId: 'mohinga', quantity: 1, modifierIds: ['extra-egg', 'extra-fritter'] },
      snapshot
    );
    expect(single).toEqual({
      itemId: 'mohinga',
      quantity: 1,
      modifierIds: ['extra-egg', 'extra-fritter'],
      capturedUnitPriceUnits: 3500,
      capturedModifierDeltaUnits: 1200,
      lineTotalUnits: 4700,
    });

    const bulk = priceDraftLine(
      { itemId: 'milk-tea', quantity: 99, modifierIds: ['less-sugar'] },
      snapshot
    );
    expect(bulk.lineTotalUnits).toBe(99 * 1500);
  });

  it.each([0, -1, 100, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid quantity %s',
    badQuantity => {
      const snapshot = makeSnapshot();
      expectPricingError(
        () => priceDraftLine({ itemId: 'mohinga', quantity: badQuantity, modifierIds: [] }, snapshot),
        'INVALID_QUANTITY'
      );
    }
  );
});

describe('modifiers and item availability', () => {
  it('rejects duplicate modifiers on the same line', () => {
    const snapshot = makeSnapshot();
    expectPricingError(
      () =>
        priceDraftLine(
          { itemId: 'mohinga', quantity: 1, modifierIds: ['extra-egg', 'extra-egg'] },
          snapshot
        ),
      'DUPLICATE_MODIFIER'
    );
  });

  it('rejects unknown or cross-item modifiers', () => {
    const snapshot = makeSnapshot();
    expectPricingError(
      () =>
        priceDraftLine(
          { itemId: 'milk-tea', quantity: 1, modifierIds: ['extra-egg'] },
          snapshot
        ),
      'UNKNOWN_MODIFIER'
    );
    expectPricingError(
      () =>
        priceDraftLine(
          { itemId: 'mohinga', quantity: 1, modifierIds: ['nonexistent-mod'] },
          snapshot
        ),
      'UNKNOWN_MODIFIER'
    );
  });

  it('rejects negative modifier delta in catalog snapshot', () => {
    const badSnapshot = makeSnapshot({
      items: [
        {
          itemId: 'mohinga',
          name: 'Mohinga',
          aliases: [],
          unitPriceUnits: 3500,
          available: true,
          modifiers: [{ modifierId: 'discount', name: 'Bad Negative', deltaUnits: -100 }],
        },
      ],
    });
    expectPricingError(
      () => priceDraftLine({ itemId: 'mohinga', quantity: 1, modifierIds: ['discount'] }, badSnapshot),
      'INVALID_CATALOG'
    );
  });

  it('rejects unknown items, catalog-unavailable items, and locally sold-out items', () => {
    const snapshot = makeSnapshot();
    expectPricingError(
      () => priceDraftLine({ itemId: 'unknown-dish', quantity: 1, modifierIds: [] }, snapshot),
      'UNKNOWN_ITEM'
    );
    expectPricingError(
      () => priceDraftLine({ itemId: 'shan-noodles', quantity: 1, modifierIds: [] }, snapshot),
      'ITEM_UNAVAILABLE'
    );
    expectPricingError(
      () =>
        priceDraftLine(
          { itemId: 'mohinga', quantity: 1, modifierIds: [] },
          snapshot,
          new Set(['mohinga'])
        ),
      'ITEM_UNAVAILABLE'
    );
  });
});

describe('cart totals and cash change', () => {
  it('computes exact multi-line totals and rejects empty carts', () => {
    const snapshot = makeSnapshot();
    const result = priceCart(
      [
        { itemId: 'mohinga', quantity: 2, modifierIds: ['extra-egg'] },
        { itemId: 'milk-tea', quantity: 3, modifierIds: [] },
      ],
      snapshot
    );
    expect(result.lines).toHaveLength(2);
    expect(result.totalUnits).toBe(2 * (3500 + 700) + 3 * 1500);

    expectPricingError(() => priceCart([], snapshot), 'EMPTY_CART');
  });

  it('computes exact cash payment and overpayment change, and rejects insufficient cash', () => {
    expect(calculateCashPayment(8400, 8400)).toEqual({
      status: 'CASH_RECORDED',
      receivedUnits: 8400,
      changeUnits: 0,
    });

    expect(calculateCashPayment(8400, 10000)).toEqual({
      status: 'CASH_RECORDED',
      receivedUnits: 10000,
      changeUnits: 1600,
    });

    expectPricingError(() => calculateCashPayment(8400, 8399), 'INSUFFICIENT_CASH');
  });

  it.each([-1, 100.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid received cash amount %s',
    badCash => {
      const expectedCode =
        badCash < 0
          ? 'NEGATIVE_AMOUNT'
          : Number.isInteger(badCash) && Number.isFinite(badCash)
            ? 'INTEGER_OVERFLOW'
            : 'INVALID_INTEGER';
      expectPricingError(() => calculateCashPayment(1000, badCash), expectedCode);
    }
  );
});

describe('integer overflow protection', () => {
  it('rejects safeAdd and safeMultiply overflow at Number.MAX_SAFE_INTEGER', () => {
    expect(safeAdd(Number.MAX_SAFE_INTEGER, 0)).toBe(Number.MAX_SAFE_INTEGER);
    expectPricingError(() => safeAdd(Number.MAX_SAFE_INTEGER, 1), 'INTEGER_OVERFLOW');
    expectPricingError(() => safeMultiply(Number.MAX_SAFE_INTEGER, 2), 'INTEGER_OVERFLOW');
  });

  it('rejects line total overflow and multi-line cart total overflow', () => {
    const halfMax = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    const snapshot = makeSnapshot({
      items: [
        {
          itemId: 'big-item',
          name: 'High Value Item',
          aliases: [],
          unitPriceUnits: halfMax,
          available: true,
          modifiers: [],
        },
        {
          itemId: 'extra-item',
          name: 'Extra Item',
          aliases: [],
          unitPriceUnits: 100,
          available: true,
          modifiers: [],
        },
      ],
    });

    expectPricingError(
      () => priceDraftLine({ itemId: 'big-item', quantity: 3, modifierIds: [] }, snapshot),
      'INTEGER_OVERFLOW'
    );

    expectPricingError(
      () =>
        priceCart(
          [
            { itemId: 'big-item', quantity: 2, modifierIds: [] },
            { itemId: 'extra-item', quantity: 1, modifierIds: [] },
          ],
          snapshot
        ),
      'INTEGER_OVERFLOW'
    );
  });
});

describe('contract schemas and authority boundaries', () => {
  it('rejects unknown authority fields on DraftLineSchema and ConfirmedSaleSchema', () => {
    const badDraft = DraftLineSchema.safeParse({
      itemId: 'mohinga',
      quantity: 1,
      modifierIds: [],
      unitPriceUnits: 1,
    });
    expect(badDraft.success).toBe(false);

    const snapshot = makeSnapshot();
    const sale = buildConfirmedSale({
      saleId: 'sale-001',
      sourceDeviceId: 'device-001',
      snapshot,
      recordedAt: '2026-11-26T08:15:00Z',
      draftLines: [{ itemId: 'mohinga', quantity: 1, modifierIds: [] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 5000, changeUnits: 1500 },
    });

    expect(ConfirmedSaleSchema.safeParse(sale).success).toBe(true);
    expect(ConfirmedSaleSchema.safeParse({ ...sale, tenantId: 'hijacked-tenant' }).success).toBe(
      false
    );
    expect(ConfirmedSaleSchema.safeParse({ ...sale, currency: 'USD' }).success).toBe(false);
    expect(ConfirmedSaleSchema.safeParse({ ...sale, scale: 2 }).success).toBe(false);
    expect(ConfirmedSaleSchema.safeParse({ ...sale, lines: [] }).success).toBe(false);
    expect(
      ConfirmedSaleSchema.safeParse({
        ...sale,
        payment: { status: 'UNPAID', receivedUnits: 100 },
      }).success
    ).toBe(false);
  });

  it('rejects tampered change or insufficient cash in buildConfirmedSale', () => {
    const snapshot = makeSnapshot();
    expectPricingError(
      () =>
        buildConfirmedSale({
          saleId: 'sale-002',
          sourceDeviceId: 'device-001',
          snapshot,
          recordedAt: '2026-11-26T08:15:00Z',
          draftLines: [{ itemId: 'mohinga', quantity: 1, modifierIds: [] }],
          payment: { status: 'CASH_RECORDED', receivedUnits: 5000, changeUnits: 9999 },
        }),
      'INVALID_SALE_INPUT'
    );

    expectPricingError(
      () =>
        buildConfirmedSale({
          saleId: 'sale-003',
          sourceDeviceId: 'device-001',
          snapshot,
          recordedAt: '2026-11-26T08:15:00Z',
          draftLines: [{ itemId: 'mohinga', quantity: 1, modifierIds: [] }],
          payment: { status: 'CASH_RECORDED', receivedUnits: 1000, changeUnits: 0 },
        }),
      'INSUFFICIENT_CASH'
    );
  });
});

describe('canonical payload serialization and SHA-256 digest', () => {
  it('produces identical digests regardless of JS object property insertion order', async () => {
    const saleA: ConfirmedSale = {
      currency: 'MMK',
      scale: 0,
      saleId: 'sale-digest-1',
      sourceDeviceId: 'dev-1',
      snapshotId: 'snap-1',
      recordedAt: '2026-11-26T09:00:00Z',
      lines: [
        {
          itemId: 'mohinga',
          quantity: 2,
          modifierIds: ['extra-egg'],
          capturedUnitPriceUnits: 3500,
          capturedModifierDeltaUnits: 700,
          lineTotalUnits: 8400,
        },
      ],
      totalUnits: 8400,
      payment: { status: 'CASH_RECORDED', receivedUnits: 10000, changeUnits: 1600 },
    };

    const saleB: ConfirmedSale = {
      payment: { changeUnits: 1600, receivedUnits: 10000, status: 'CASH_RECORDED' },
      totalUnits: 8400,
      recordedAt: '2026-11-26T09:00:00Z',
      snapshotId: 'snap-1',
      lines: [
        {
          lineTotalUnits: 8400,
          capturedModifierDeltaUnits: 700,
          capturedUnitPriceUnits: 3500,
          modifierIds: ['extra-egg'],
          quantity: 2,
          itemId: 'mohinga',
        },
      ],
      sourceDeviceId: 'dev-1',
      saleId: 'sale-digest-1',
      scale: 0,
      currency: 'MMK',
    };

    expect(canonicalizeSalePayload(saleA)).toBe(canonicalizeSalePayload(saleB));
    const digestA = await computeSaleDigest(saleA);
    const digestB = await computeSaleDigest(saleB);
    expect(digestA).toMatch(/^[a-f0-9]{64}$/);
    expect(digestA).toBe(digestB);
  });

  it('produces different digests if any immutable field changes', async () => {
    const snapshot = makeSnapshot();
    const baseSale = buildConfirmedSale({
      saleId: 'sale-digest-2',
      sourceDeviceId: 'dev-1',
      snapshot,
      recordedAt: '2026-11-26T09:00:00Z',
      draftLines: [{ itemId: 'mohinga', quantity: 1, modifierIds: ['extra-egg'] }],
      payment: { status: 'EXTERNAL_UNVERIFIED', receivedUnits: 0, reference: 'kpay-ref-01' },
    });

    const baseDigest = await computeSaleDigest(baseSale);

    const mutatedTotal = { ...baseSale, totalUnits: baseSale.totalUnits + 1 };
    const mutatedPayment = {
      ...baseSale,
      payment: { status: 'EXTERNAL_UNVERIFIED' as const, receivedUnits: 0 as const, reference: 'kpay-ref-02' },
    };
    const mutatedQty = {
      ...baseSale,
      lines: [{ ...baseSale.lines[0], quantity: 2 }],
    };

    expect(await computeSaleDigest(mutatedTotal)).not.toBe(baseDigest);
    expect(await computeSaleDigest(mutatedPayment)).not.toBe(baseDigest);
    expect(await computeSaleDigest(mutatedQty)).not.toBe(baseDigest);
  });
});
