# ADR 0005: leases persistentes para jobs

Jobs são reservados com `UPDATE` condicionado a estados elegíveis. A reserva registra worker, tentativa e heartbeat no SQLite. Heartbeats vencidos retornam a `retryable` ou tornam-se `failed` ao esgotar tentativas. Handlers devem ser idempotentes por `job.id` e verificar cancelamento cooperativamente entre etapas seguras.
