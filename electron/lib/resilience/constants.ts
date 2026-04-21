/**
 * Single source of truth для всех числовых констант resilience-блока.
 * Меняй здесь — отражается во всём стеке.
 *
 * Обоснования каждой величины — в Phase 2.5R плана и в README модуля.
 */

export const HEALTH_POLL_INTERVAL_MS = 5_000;
export const READINESS_CHECK_INTERVAL_MS = 30_000;
export const HEALTH_FAIL_THRESHOLD = 3;

export const COOLDOWN_BASE_MS = 200;
export const COOLDOWN_DEGRADED_MS = 800;

export const TPS_DEGRADED_THRESHOLD = 5;
export const TPS_CRITICAL_THRESHOLD = 2;

export const ABORT_GRACE_MS = 1_500;
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000;

export const TELEMETRY_MAX_BYTES = 50 * 1024 * 1024;

export const LOCK_RETRIES = 5;
export const LOCK_STALE_MS = 10_000;

export const POLICY_MAX_RETRIES = 3;
export const POLICY_BASE_BACKOFF_MS = 1_000;
export const POLICY_HARD_TIMEOUT_CAP_MS = 600_000;
export const POLICY_TIMEOUT_BUFFER_MS = 30_000;
export const POLICY_MIN_OBSERVED_TPS = 1;
