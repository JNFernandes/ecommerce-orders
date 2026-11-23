/**
 * Who asks to act on an order, as the domain sees it (US-11, research R12). Built by the
 * controller from the verified caller; the domain knows nothing about tokens.
 */
export interface OrderRequester {
  /** The requester's customer id, or `null` when the requester is not acting as a customer. */
  readonly customerId: string | null;
  /** Whether the requester is an administrator, who may act on any order. */
  readonly isAdmin: boolean;
}
