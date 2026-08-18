// src/services/PeerCircuitBreaker/index.ts
//
// Per-peer failure isolation for outbound cross-node requests (currently
// used by DmRelayService; written peer-agnostic so any future cross-node
// fetch caller — e.g. a peer health probe, action broadcast — can share
// the same instance without duplicating this state machine).
//
// Classic closed/open/half-open circuit breaker, in-memory only (state
// resets on process restart — this is a purely local, best-effort
// optimization, not a source of truth peers rely on). Scoped by
// InstanceRegistryService's instanceId.
//
// Independently implemented and verified: an earlier draft claimed an
// in-flight-probe guard, a probe-timeout fallback, reset(), and prune()
// were all in place, but none were present when the code was actually
// run rather than just read. Rewritten from scratch and each behavior
// verified against a standalone repro before being carried over here.

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export interface CircuitBreakerConfig {
  /** Consecutive failures (from CLOSED) before the circuit trips to OPEN. */
  failureThreshold: number
  /** Cooldown before the first OPEN -> HALF_OPEN probe attempt. */
  initialCooldownMs: number
  /** Ceiling for the cooldown after repeated HALF_OPEN failures. */
  maxCooldownMs: number
  /** Multiplier applied to the cooldown on each HALF_OPEN failure. */
  backoffMultiplier: number
  /**
   * If a HALF_OPEN probe never calls recordSuccess/recordFailure (e.g. the
   * caller crashed or forgot), a new probe is allowed after this many ms
   * rather than leaving the peer permanently stuck open. Should exceed
   * any real request timeout used by callers (DmRelayService's fetch
   * timeout is 5s; 15s gives headroom).
   */
  probeTimeoutMs: number
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  initialCooldownMs: 30_000,
  maxCooldownMs: 600_000,
  backoffMultiplier: 2,
  probeTimeoutMs: 15_000,
}

interface PeerState {
  state: CircuitState
  consecutiveFailures: number
  currentCooldownMs: number
  nextRetryTime: number | null
  probing: boolean
  probeStartedAt: number | null
}

export class PeerCircuitBreaker {
  private peers = new Map<number, PeerState>()
  private config: CircuitBreakerConfig

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  private getOrCreate(instanceId: number): PeerState {
    let s = this.peers.get(instanceId)
    if (!s) {
      s = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        currentCooldownMs: this.config.initialCooldownMs,
        nextRetryTime: null,
        probing: false,
        probeStartedAt: null,
      }
      this.peers.set(instanceId, s)
    }
    return s
  }

  /**
   * Call once per attempt, immediately before the fetch — not
   * speculatively ahead of time, since a HALF_OPEN call here claims the
   * single in-flight probe slot.
   */
  shouldAllowRequest(instanceId: number): boolean {
    const s = this.getOrCreate(instanceId)
    const now = Date.now()

    if (s.state === 'CLOSED') return true

    if (s.state === 'OPEN') {
      if (s.nextRetryTime !== null && now >= s.nextRetryTime) {
        s.state = 'HALF_OPEN'
        s.probing = true
        s.probeStartedAt = now
        return true
      }
      return false
    }

    // HALF_OPEN: only one in-flight probe at a time (Thundering Herd
    // guard) — otherwise every queued send to a peer that just left its
    // cooldown window would all probe simultaneously. A stuck probe
    // (caller never resolved it) self-heals after probeTimeoutMs instead
    // of wedging the peer open indefinitely.
    if (!s.probing) {
      s.probing = true
      s.probeStartedAt = now
      return true
    }
    if (s.probeStartedAt !== null && now - s.probeStartedAt > this.config.probeTimeoutMs) {
      s.probeStartedAt = now
      return true
    }
    return false
  }

  recordSuccess(instanceId: number): void {
    const s = this.getOrCreate(instanceId)
    s.state = 'CLOSED'
    s.consecutiveFailures = 0
    s.currentCooldownMs = this.config.initialCooldownMs
    s.nextRetryTime = null
    s.probing = false
    s.probeStartedAt = null
  }

  recordFailure(instanceId: number): void {
    const s = this.getOrCreate(instanceId)
    const now = Date.now()
    s.consecutiveFailures++

    if (s.state === 'HALF_OPEN') {
      s.state = 'OPEN'
      s.currentCooldownMs = Math.min(s.currentCooldownMs * this.config.backoffMultiplier, this.config.maxCooldownMs)
      s.nextRetryTime = now + s.currentCooldownMs
      s.probing = false
      s.probeStartedAt = null
    } else if (s.state === 'CLOSED' && s.consecutiveFailures >= this.config.failureThreshold) {
      s.state = 'OPEN'
      s.nextRetryTime = now + s.currentCooldownMs
    }
  }

  /**
   * Drop tracked state for a peer whose registry entry changed (URL or
   * validatorAddress update, or reactivation after a prior deactivate) —
   * past failures may not apply to what could be a different endpoint.
   */
  reset(instanceId: number): void {
    this.peers.delete(instanceId)
  }

  /**
   * Drop tracked state for peers no longer in the active peer set, so
   * deactivated/removed instances don't accumulate in this Map forever.
   * Call periodically (e.g. alongside InstanceRegistryService's refresh)
   * with the current active instanceId list.
   */
  prune(activeInstanceIds: Iterable<number>): void {
    const activeSet = new Set(activeInstanceIds)
    for (const id of this.peers.keys()) {
      if (!activeSet.has(id)) this.peers.delete(id)
    }
  }

  getStatus(instanceId: number): Readonly<PeerState> {
    return { ...this.getOrCreate(instanceId) }
  }
}

/** Shared instance for cross-node HTTP callers (DmRelayService today). */
export const peerCircuitBreaker = new PeerCircuitBreaker()
