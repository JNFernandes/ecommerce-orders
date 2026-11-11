/**
 * Status of an order as shown in the read model. Same string values as the write model's
 * OrderStatus (asserted by a unit test), but declared separately so the read path never
 * imports write-side types (Constitution Principle II).
 */
export enum OrderViewStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}
