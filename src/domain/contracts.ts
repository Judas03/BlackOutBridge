import { z } from 'zod';

/**
 * Canonical issue codes shared across local validation, preview, and commit responses.
 */
export const ISSUE_CODES = [
  'UNKNOWN_ITEM',
  'UNSUPPORTED_MODIFIER',
  'MISSING_REQUIRED_OPTION',
  'SNAPSHOT_MISSING',
  'PRICE_MISMATCH',
  'TOTAL_MISMATCH',
  'PAYLOAD_CONFLICT',
  'UNSUPPORTED_PAYMENT_STATE',
] as const;

export const IssueCodeSchema = z.enum(ISSUE_CODES);
export type IssueCode = z.infer<typeof IssueCodeSchema>;

export const NonEmptyStringSchema = z.string().min(1);

export const SafeNonNegativeIntSchema = z.number().int().safe().nonnegative();

export const SafeSignedIntSchema = z.number().int().safe();

export const QuantitySchema = z.number().int().min(1).max(99);

export const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const MoneyConfigSchema = z.strictObject({
  currency: z.literal('THB'),
  scale: z.literal(2),
});
export type MoneyConfig = z.infer<typeof MoneyConfigSchema>;

export const CatalogModifierSchema = z.strictObject({
  modifierId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  deltaUnits: SafeSignedIntSchema,
});
export type CatalogModifier = z.infer<typeof CatalogModifierSchema>;

export const CatalogOptionGroupSchema = z.strictObject({
  groupId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  required: z.boolean(),
  choices: z.array(CatalogModifierSchema).min(1),
});
export type CatalogOptionGroup = z.infer<typeof CatalogOptionGroupSchema>;

export const CatalogItemSchema = z.strictObject({
  itemId: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  aliases: z.array(NonEmptyStringSchema),
  unitPriceUnits: SafeNonNegativeIntSchema,
  available: z.boolean(),
  optionGroups: z.array(CatalogOptionGroupSchema),
});
export type CatalogItem = z.infer<typeof CatalogItemSchema>;

export const CatalogSnapshotSchema = z.strictObject({
  currency: z.literal('THB'),
  scale: z.literal(2),
  snapshotId: NonEmptyStringSchema,
  sourcePosId: NonEmptyStringSchema,
  issuedAt: IsoTimestampSchema,
  items: z.array(CatalogItemSchema),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;

export const DraftLineSchema = z.strictObject({
  itemId: NonEmptyStringSchema,
  quantity: QuantitySchema,
  modifierIds: z.array(NonEmptyStringSchema),
});
export type DraftLine = z.infer<typeof DraftLineSchema>;

export const ConfirmedLineSchema = z.strictObject({
  itemId: NonEmptyStringSchema,
  quantity: QuantitySchema,
  modifierIds: z.array(NonEmptyStringSchema),
  capturedUnitPriceUnits: SafeNonNegativeIntSchema,
  capturedModifierDeltaUnits: SafeSignedIntSchema,
  lineTotalUnits: SafeNonNegativeIntSchema,
});
export type ConfirmedLine = z.infer<typeof ConfirmedLineSchema>;

export const UnpaidPaymentSchema = z.strictObject({
  status: z.literal('UNPAID'),
  receivedUnits: z.literal(0),
});

export const CashRecordedPaymentSchema = z.strictObject({
  status: z.literal('CASH_RECORDED'),
  receivedUnits: SafeNonNegativeIntSchema,
  changeUnits: SafeNonNegativeIntSchema,
});

export const ExternalUnverifiedPaymentSchema = z.strictObject({
  status: z.literal('EXTERNAL_UNVERIFIED'),
  receivedUnits: z.literal(0),
  reference: NonEmptyStringSchema,
});

export const PaymentRecordSchema = z.discriminatedUnion('status', [
  UnpaidPaymentSchema,
  CashRecordedPaymentSchema,
  ExternalUnverifiedPaymentSchema,
]);
export type PaymentRecord = z.infer<typeof PaymentRecordSchema>;

export const ConfirmedSaleSchema = z.strictObject({
  currency: z.literal('THB'),
  scale: z.literal(2),
  saleId: NonEmptyStringSchema,
  sourceDeviceId: NonEmptyStringSchema,
  snapshotId: NonEmptyStringSchema,
  recordedAt: IsoTimestampSchema,
  lines: z.array(ConfirmedLineSchema).min(1),
  totalUnits: SafeNonNegativeIntSchema,
  payment: PaymentRecordSchema,
});
export type ConfirmedSale = z.infer<typeof ConfirmedSaleSchema>;

export const QueueStateSchema = z.enum(['PENDING', 'REVIEW_REQUIRED', 'IMPORTED']);
export type QueueState = z.infer<typeof QueueStateSchema>;

export const QueueEntrySchema = z.strictObject({
  saleId: NonEmptyStringSchema,
  payloadVersion: z.literal(1),
  state: QueueStateSchema,
  attempts: SafeNonNegativeIntSchema,
  lastErrorCode: NonEmptyStringSchema.optional(),
  destinationReceiptId: NonEmptyStringSchema.optional(),
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;

export const PreviewItemSchema = z.strictObject({
  saleId: NonEmptyStringSchema,
  status: z.enum(['READY', 'ALREADY_IMPORTED', 'REVIEW_REQUIRED']),
  issueCodes: z.array(NonEmptyStringSchema),
  destinationReceiptId: NonEmptyStringSchema.optional(),
});
export type PreviewItem = z.infer<typeof PreviewItemSchema>;

export const ImportResultSchema = z.strictObject({
  saleId: NonEmptyStringSchema,
  status: z.enum(['IMPORTED', 'ALREADY_IMPORTED', 'REVIEW_REQUIRED']),
  destinationReceiptId: NonEmptyStringSchema.optional(),
  issueCodes: z.array(NonEmptyStringSchema),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export interface PosConnector {
  getCatalog(): Promise<CatalogSnapshot>;
  preview(sales: ConfirmedSale[]): Promise<PreviewItem[]>;
  commit(sales: ConfirmedSale[]): Promise<ImportResult[]>;
  status(saleId: string, sourceDeviceId: string): Promise<ImportResult>;
}
