# Contract: `POST /orders`

## Request

```
POST /orders
Content-Type: application/json
```

```json
{
  "customerId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "items": [
    { "productId": "prod-001", "quantity": 2, "unitPrice": 29.99 }
  ]
}
```

| Field | Type | Rules |
|---|---|---|
| `customerId` | string (UUID) | required, valid UUID, must correspond to an existing customer |
| `items` | array | required, non-empty |
| `items[].productId` | string | required, non-empty |
| `items[].quantity` | integer | required, > 0 |
| `items[].unitPrice` | number | required, > 0 |

Items sharing the same `productId` are consolidated server-side into a single line item before validation and totaling (see data-model.md).

## Responses

### 201 Created — order placed

```json
{ "orderId": "7c9e6679-7425-40de-944b-e07fc1f90ae7" }
```

Returned once the order has been durably saved to the write database — regardless of whether the subsequent Kafka publish succeeds (see event-order-placed.md).

### 400 Bad Request — invalid input

```json
{
  "statusCode": 400,
  "message": ["items must not be empty", "quantity must be greater than 0"],
  "error": "Bad Request"
}
```

Returned for: missing/invalid `customerId` format, empty `items`, or any item failing validation.

### 404 Not Found — unknown customer

```json
{
  "statusCode": 404,
  "message": "Customer not found",
  "error": "Not Found"
}
```

Returned when `customerId` is a well-formed UUID but does not correspond to an existing customer. Checked after DTO validation and before any DB save — no order is created.

### 500 Internal Server Error — DB save failed

Returned only if the durable save itself fails. Never returned for a downstream Kafka publish failure (that case still returns 201 — see event-order-placed.md).
