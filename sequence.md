## 1. Checkout: thành công, hết hàng, Try timeout

```mermaid
sequenceDiagram
    autonumber
    actor B as Buyer
    participant O as order-service
    participant A as api (cart/catalog)
    participant I as inventory-service
    B->>O: POST /orders (Idempotency-Key)
    O->>A: cart snapshot + SKU views (internal)
    A-->>O: lines, prices
    O->>O: tx A: order RESERVING, saga RESERVING (lease_until cho request), key IN_PROGRESS
    O->>I: POST /internal/reservations {orderId, lines, holdUntil} (timeout ~3s)
    alt HELD
        I-->>O: 201
        O->>O: tx B: order PENDING, saga AWAITING_AUTH (deadline), key COMPLETED, outbox order.placed
        O-->>B: 201
    else OUT_OF_STOCK
        I-->>O: 409
        O->>O: tx B: order REJECTED, saga COMPENSATED, gỡ key
        O-->>B: 409 Insufficient stock
    else timeout / 5xx / connection reset
        O->>O: tx B: order REJECTED, saga COMPENSATING [RELEASE_STOCK], gỡ key
        O->>I: release inline một lần (best-effort, ~1s)
        O-->>B: 503, retry với cùng key
        Note over O,I: nếu release inline chưa thành công: saga runner, bất đồng bộ
        O->>I: POST /internal/reservations/:orderId/release (retry tới khi 2xx)
        I-->>O: 200 (RELEASED, hoặc FENCED nếu Try chưa từng tới)
    end
```

## 2. Thanh toán: authorize, commit, capture

```mermaid
sequenceDiagram
    autonumber
    actor B as Buyer
    participant O as order-service
    participant P as payment-service
    participant S as Stripe
    participant I as inventory-service
    B->>O: POST /orders/:id/pay
    O->>O: kiểm tra owner, PENDING, now < deadline − 30m − margin
    O->>P: POST /internal/payment-sessions {orderId, amount, currency, expiresAt = deadline}
    P->>P: tx: lock header payment_orders (FENCED/CANCELLED thì 409)
    P->>S: checkout.sessions.create (capture_method=manual, expires_at = expiresAt)
    S-->>P: session url
    P-->>O: url
    O-->>B: url
    B->>S: nhập thẻ, authorize
    S->>P: webhook checkout.session.completed
    P->>S: sessions.retrieve (expand payment_intent)
    S-->>P: payment_intent.status = requires_capture
    P->>P: tx: header + payment AUTHORIZED, webhook_events, outbox payment.authorized
    P-->>S: 200
    P-->>O: payment.authorized (queue order-events)
    O-->>O: tx + inbox claim: order PENDING→CONFIRMING, saga COMMITTING_STOCK
    Note over O: sau commit, handler gọi advance(orderId)#59; runner là dự phòng
    O-->>I: POST /internal/reservations/:orderId/commit
    I-->>O: 200 COMMITTED
    O->>O: saga CAPTURING
    O->>P: POST /internal/payments/:orderId/capture
    P->>S: paymentIntents.capture (Idempotency-Key capture:{paymentId})
    S-->>P: succeeded
    P-->>O: 200 CAPTURED
    O->>O: tx: order PAID, saga COMPLETED, outbox order.paid
    O-->>O: order.paid → mail (queue order-events, gọi user-service lấy địa chỉ)
```

## 3. Hết hạn hoặc huỷ, và authorization tới muộn

```mermaid
sequenceDiagram
    autonumber
    participant R as saga runner (order-service)
    participant P as payment-service
    participant S as Stripe
    participant I as inventory-service
    R->>R: claim saga AWAITING_AUTH quá deadline (SKIP LOCKED)
    R->>R: tx: order EXPIRED, saga COMPENSATING [CANCEL_PAYMENT, RELEASE_STOCK], outbox order.expired
    R->>P: POST /internal/payments/:orderId/cancel
    alt session đang mở
        P->>S: checkout.sessions.expire
    else đã authorize (race)
        P->>S: paymentIntents.cancel (void)
    else chưa có payment
        P->>P: ghi FENCED, chặn /pay tới muộn
    end
    P-->>R: 200
    R-->>I: POST /internal/reservations/:orderId/release
    I-->>R: 200
    R->>R: saga COMPENSATED
    Note over P,R: payment.authorized tới sau khi order đã EXPIRED
    P-->>R: payment.authorized
    R->>P: cancel (idempotent): void nếu còn auth, chưa có tiền nào bị thu
```

## 4. Capture thất bại sau khi stock đã commit

```mermaid
sequenceDiagram
    autonumber
    participant R as saga runner
    participant P as payment-service
    participant I as inventory-service
    R->>P: capture
    alt timeout / 5xx: không rõ kết quả
        P--xR: không có response
        R->>R: retry với cùng Stripe idempotency key, KHÔNG compensate
    else 422: auth đã hết hạn / bị huỷ (thất bại hẳn)
        P-->>R: 422
        R->>R: tx: order FAILED, saga COMPENSATING [RESTOCK, CANCEL_PAYMENT]
        R-->>I: POST .../restock
        R->>P: POST .../cancel (no-op nếu auth đã chết)
    end
```
