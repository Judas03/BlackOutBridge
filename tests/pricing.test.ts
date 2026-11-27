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
  safeAddSigned,
  safeMultiply,
} from '../src/domain';

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
          {
            groupId: 'option-2',
            name: 'Milk & Extras',
            required: false,
            choices: [
              { modifierId: 'option-2:choice-1', name: 'Oat Milk', deltaUnits: 2000 },
              { modifierId: 'option-2:choice-2', name: 'Extra Shot', deltaUnits: 2500 },
            ],
          },
        ],
      },
      {
        itemId: 'americano',
        name: 'Americano',
        aliases: ['black coffee'],
        unitPriceUnits: 10000,
        available: true,
        optionGroups: [
          {
            groupId: 'option-1',
            name: 'Ice',
            required: false,
            choices: [{ modifierId: 'option-1:choice-1', name: 'Less Ice', deltaUnits: 0 }],
          },
        ],
      },
      {
        itemId: 'matcha_latte',
        name: 'Matcha Latte',
        aliases: [],
        unitPriceUnits: 15000,
        available: false,
        optionGroups: [],
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
  it('prices valid boundary quantities 1 and 99 with grouped options and signed deltas', () => {
    const snapshot = makeSnapshot();

    const single = priceDraftLine(
      {
        itemId: 'espresso',
        quantity: 1,
        modifierIds: ['option-1:choice-3', 'option-2:choice-1'],
      },
      snapshot
    );
    expect(single).toEqual({
      itemId: 'espresso',
      quantity: 1,
      modifierIds: ['option-1:choice-3', 'option-2:choice-1'],
      capturedUnitPriceUnits: 7500,
      capturedModifierDeltaUnits: 3500,
      lineTotalUnits: 11000,
    });

    const discountedSmall = priceDraftLine(
      {
        itemId: 'espresso',
        quantity: 2,
        modifierIds: ['option-1:choice-1'],
      },
      snapshot
    );
    expect(discountedSmall).toEqual({
      itemId: 'espresso',
      quantity: 2,
      modifierIds: ['option-1:choice-1'],
      capturedUnitPriceUnits: 7500,
      capturedModifierDeltaUnits: -1000,
      lineTotalUnits: 13000,
    });

    const bulk = priceDraftLine(
      { itemId: 'americano', quantity: 99, modifierIds: ['option-1:choice-1'] },
      snapshot
    );
    expect(bulk.lineTotalUnits).toBe(99 * 10000);
  });

  it.each([0, -1, 100, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid quantity %s',
    badQuantity => {
      const snapshot = makeSnapshot();
      expectPricingError(
        () =>
          priceDraftLine(
            { itemId: 'americano', quantity: badQuantity, modifierIds: [] },
            snapshot
          ),
        'INVALID_QUANTITY'
      );
    }
  );
});

describe('grouped options, negative deltas, and item availability', () => {
  it('rejects missing required option groups', () => {
    const snapshot = makeSnapshot();
    expectPricingError(
      () =>
        priceDraftLine(
          { itemId: 'espresso', quantity: 1, modifierIds: ['option-2:choice-1'] },
          snapshot
        ),
      'MISSING_REQUIRED_OPTION'
    );
  });

  it('rejects multiple selections from the same option group', () => {
    const snapshot = makeSnapshot();
    expectPricingError(
      () =>
        priceDraftLine(
          {
            itemId: 'espresso',
            quantity: 1,
            modifierIds: ['option-1:choice-1', 'option-1:choice-3'],
          },
          snapshot
        ),
      'MULTIPLE_GROUP_SELECTIONS'
    );
  });

  it('rejects duplicate modifiers on the same line', () => {
    const snapshot = makeSnapshot();
    expectPricingError(
      () =>
        priceDraftLine(
          {
            itemId: 'espresso',
            quantity: 1,
            modifierIds: ['option-1:choice-2', 'option-1:choice-2'],
          },
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
          { itemId: 'americano', quantity: 1, modifierIds: ['option-2:choice-1'] },
          snapshot
        ),
      'UNKNOWN_MODIFIER'
    );
    expectPricingError(
      () =>
        priceDraftLine(
          { itemId: 'espresso', quantity: 1, modifierIds: ['nonexistent-mod'] },
          snapshot
        ),
      'UNKNOWN_MODIFIER'
    );
  });

  it('rejects negative effective unit price when negative deltas exceed base price', () => {
    const snapshot = makeSnapshot({
      items: [
        {
          itemId: 'espresso',
          name: 'Espresso',
          aliases: [],
          unitPriceUnits: 1000,
          available: true,
          optionGroups: [
            {
              groupId: 'option-1',
              name: 'Size',
              required: true,
              choices: [{ modifierId: 'option-1:choice-1', name: 'Tiny', deltaUnits: -1500 }],
            },
          ],
        },
      ],
    });
    expectPricingError(
      () =>
        priceDraftLine(
          { itemId: 'espresso', quantity: 1, modifierIds: ['option-1:choice-1'] },
          snapshot
        ),
      'NEGATIVE_UNIT_PRICE'
    );
  });

  it('rejects duplicate groupId or duplicate modifierId across groups in catalog snapshot', () => {
    const dupGroupSnapshot = makeSnapshot({
      items: [
        {
          itemId: 'espresso',
          name: 'Espresso',
          aliases: [],
          unitPriceUnits: 7500,
          available: true,
          optionGroups: [
            {
              groupId: 'option-1',
              name: 'Size',
              required: false,
              choices: [{ modifierId: 'option-1:choice-1', name: 'Small', deltaUnits: 0 }],
            },
            {
              groupId: 'option-1',
              name: 'Temp',
              required: false,
              choices: [{ modifierId: 'option-2:choice-1', name: 'Hot', deltaUnits: 0 }],
            },
          ],
        },
      ],
    });
    expectPricingError(
      () => priceDraftLine({ itemId: 'espresso', quantity: 1, modifierIds: [] }, dupGroupSnapshot),
      'INVALID_CATALOG'
    );

    const dupModifierSnapshot = makeSnapshot({
      items: [
        {
          itemId: 'espresso',
          name: 'Espresso',
          aliases: [],
          unitPriceUnits: 7500,
          available: true,
          optionGroups: [
            {
              groupId: 'option-1',
              name: 'Size',
              required: false,
              choices: [{ modifierId: 'shared-id', name: 'Small', deltaUnits: 0 }],
            },
            {
              groupId: 'option-2',
              name: 'Temp',
              required: false,
              choices: [{ modifierId: 'shared-id', name: 'Hot', deltaUnits: 0 }],
            },
          ],
        },
      ],
    });
    expectPricingError(
      () =>
        priceDraftLine({ itemId: 'espresso', quantity: 1, modifierIds: [] }, dupModifierSnapshot),
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
      () => priceDraftLine({ itemId: 'matcha_latte', quantity: 1, modifierIds: [] }, snapshot),
      'ITEM_UNAVAILABLE'
    );
    expectPricingError(
      () =>
        priceDraftLine(
          { itemId: 'americano', quantity: 1, modifierIds: [] },
          snapshot,
          new Set(['americano'])
        ),
      'ITEM_UNAVAILABLE'
    );
  });
});

describe('cart totals and cash change', () => {
  it('computes exact multi-line totals in THB satang and rejects empty carts', () => {
    const snapshot = makeSnapshot();
    const result = priceCart(
      [
        { itemId: 'espresso', quantity: 2, modifierIds: ['option-1:choice-1'] },
        { itemId: 'americano', quantity: 3, modifierIds: [] },
      ],
      snapshot
    );
    expect(result.lines).toHaveLength(2);
    expect(result.totalUnits).toBe(2 * (7500 - 1000) + 3 * 10000);

    expectPricingError(() => priceCart([], snapshot), 'EMPTY_CART');
  });

  it('computes exact cash payment and overpayment change, and rejects insufficient cash', () => {
    expect(calculateCashPayment(43000, 43000)).toEqual({
      status: 'CASH_RECORDED',
      receivedUnits: 43000,
      changeUnits: 0,
    });

    expect(calculateCashPayment(43000, 50000)).toEqual({
      status: 'CASH_RECORDED',
      receivedUnits: 50000,
      changeUnits: 7000,
    });

    expectPricingError(() => calculateCashPayment(43000, 42999), 'INSUFFICIENT_CASH');
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
  it('rejects safeAdd, safeAddSigned, and safeMultiply overflow at safe integer bounds', () => {
    expect(safeAdd(Number.MAX_SAFE_INTEGER, 0)).toBe(Number.MAX_SAFE_INTEGER);
    expect(safeAddSigned(5000, -1000)).toBe(4000);
    expectPricingError(() => safeAdd(Number.MAX_SAFE_INTEGER, 1), 'INTEGER_OVERFLOW');
    expectPricingError(() => safeAddSigned(Number.MIN_SAFE_INTEGER, -1), 'INTEGER_OVERFLOW');
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
          optionGroups: [],
        },
        {
          itemId: 'extra-item',
          name: 'Extra Item',
          aliases: [],
          unitPriceUnits: 100,
          available: true,
          optionGroups: [],
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
  it('rejects unknown authority fields and non-THB/scale-2 money configs on schemas', () => {
    const badDraft = DraftLineSchema.safeParse({
      itemId: 'americano',
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
      recordedAt: '2026-11-27T08:15:00Z',
      draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
      payment: { status: 'CASH_RECORDED', receivedUnits: 12000, changeUnits: 2000 },
    });

    expect(ConfirmedSaleSchema.safeParse(sale).success).toBe(true);
    expect(ConfirmedSaleSchema.safeParse({ ...sale, tenantId: 'hijacked-tenant' }).success).toBe(
      false
    );
    expect(ConfirmedSaleSchema.safeParse({ ...sale, currency: 'MMK' }).success).toBe(false);
    expect(ConfirmedSaleSchema.safeParse({ ...sale, scale: 0 }).success).toBe(false);
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
          recordedAt: '2026-11-27T08:15:00Z',
          draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
          payment: { status: 'CASH_RECORDED', receivedUnits: 12000, changeUnits: 9999 },
        }),
      'INVALID_SALE_INPUT'
    );

    expectPricingError(
      () =>
        buildConfirmedSale({
          saleId: 'sale-003',
          sourceDeviceId: 'device-001',
          snapshot,
          recordedAt: '2026-11-27T08:15:00Z',
          draftLines: [{ itemId: 'americano', quantity: 1, modifierIds: [] }],
          payment: { status: 'CASH_RECORDED', receivedUnits: 5000, changeUnits: 0 },
        }),
      'INSUFFICIENT_CASH'
    );
  });
});

describe('canonical payload serialization and SHA-256 digest', () => {
  it('produces identical digests regardless of JS object property insertion order, including negative deltas', async () => {
    const saleA: ConfirmedSale = {
      currency: 'THB',
      scale: 2,
      saleId: 'sale-digest-1',
      sourceDeviceId: 'dev-1',
      snapshotId: 'snap-1',
      recordedAt: '2026-11-27T09:00:00Z',
      lines: [
        {
          itemId: 'espresso',
          quantity: 2,
          modifierIds: ['option-1:choice-1'],
          capturedUnitPriceUnits: 7500,
          capturedModifierDeltaUnits: -1000,
          lineTotalUnits: 13000,
        },
      ],
      totalUnits: 13000,
      payment: { status: 'CASH_RECORDED', receivedUnits: 20000, changeUnits: 7000 },
    };

    const saleB: ConfirmedSale = {
      payment: { changeUnits: 7000, receivedUnits: 20000, status: 'CASH_RECORDED' },
      totalUnits: 13000,
      recordedAt: '2026-11-27T09:00:00Z',
      snapshotId: 'snap-1',
      lines: [
        {
          lineTotalUnits: 13000,
          capturedModifierDeltaUnits: -1000,
          capturedUnitPriceUnits: 7500,
          modifierIds: ['option-1:choice-1'],
          quantity: 2,
          itemId: 'espresso',
        },
      ],
      sourceDeviceId: 'dev-1',
      saleId: 'sale-digest-1',
      scale: 2,
      currency: 'THB',
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
      recordedAt: '2026-11-27T09:00:00Z',
      draftLines: [{ itemId: 'espresso', quantity: 1, modifierIds: ['option-1:choice-3'] }],
      payment: { status: 'EXTERNAL_UNVERIFIED', receivedUnits: 0, reference: 'promptpay-ref-01' },
    });

    const baseDigest = await computeSaleDigest(baseSale);

    const mutatedTotal = { ...baseSale, totalUnits: baseSale.totalUnits + 1 };
    const mutatedPayment = {
      ...baseSale,
      payment: {
        status: 'EXTERNAL_UNVERIFIED' as const,
        receivedUnits: 0 as const,
        reference: 'promptpay-ref-02',
      },
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
