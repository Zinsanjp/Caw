// Standalone verification of PeerCircuitBreaker's state machine.
// Mirrors the logic in client/src/services/PeerCircuitBreaker/index.ts
// (kept in plain JS here so it runs with a bare `node`, no ts-node needed).
// Run: node scripts/verify-peer-circuit-breaker.js

class PeerCircuitBreaker {
  constructor(config = {}) {
    this.peers = new Map()
    this.config = {
      failureThreshold: 3,
      initialCooldownMs: 30_000,
      maxCooldownMs: 600_000,
      backoffMultiplier: 2,
      probeTimeoutMs: 15_000,
      ...config,
    }
  }

  getOrCreate(instanceId) {
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

  shouldAllowRequest(instanceId) {
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

  recordSuccess(instanceId) {
    const s = this.getOrCreate(instanceId)
    s.state = 'CLOSED'
    s.consecutiveFailures = 0
    s.currentCooldownMs = this.config.initialCooldownMs
    s.nextRetryTime = null
    s.probing = false
    s.probeStartedAt = null
  }

  recordFailure(instanceId) {
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

  reset(instanceId) {
    this.peers.delete(instanceId)
  }

  prune(activeInstanceIds) {
    const activeSet = new Set(activeInstanceIds)
    for (const id of this.peers.keys()) {
      if (!activeSet.has(id)) this.peers.delete(id)
    }
  }

  getStatus(instanceId) {
    return { ...this.getOrCreate(instanceId) }
  }
}

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

async function run() {
  // 1) Initial state: CLOSED, requests allowed.
  const cb1 = new PeerCircuitBreaker()
  check('1: initial state is CLOSED and allows requests', [cb1.getStatus(1).state, cb1.shouldAllowRequest(1)], ['CLOSED', true])

  // 2-4) Failures below threshold stay CLOSED; the 3rd trips to OPEN.
  const cb2 = new PeerCircuitBreaker({ initialCooldownMs: 100 })
  cb2.recordFailure(1)
  check('2: 1st failure stays CLOSED', cb2.getStatus(1).state, 'CLOSED')
  cb2.recordFailure(1)
  check('3: 2nd failure stays CLOSED', cb2.getStatus(1).state, 'CLOSED')
  cb2.recordFailure(1)
  check('4: 3rd failure trips to OPEN', cb2.getStatus(1).state, 'OPEN')

  // 5) OPEN blocks requests before cooldown elapses.
  check('5: OPEN blocks requests immediately after tripping', cb2.shouldAllowRequest(1), false)

  // 6) Independent peers: peer 2 unaffected by peer 1's OPEN state.
  check('6: a different peer is unaffected (still CLOSED)', cb2.getStatus(2).state, 'CLOSED')

  await new Promise(r => setTimeout(r, 150))

  // 7) After cooldown, transitions to HALF_OPEN and allows exactly one probe.
  const probe1 = cb2.shouldAllowRequest(1)
  check('7: cooldown elapsed -> HALF_OPEN, first probe allowed', [cb2.getStatus(1).state, probe1], ['HALF_OPEN', true])

  // 8-9) In-flight probe guard: concurrent callers during the same
  // HALF_OPEN window are rejected until the probe resolves.
  check('8: concurrent call #2 during in-flight probe is rejected', cb2.shouldAllowRequest(1), false)
  check('9: concurrent call #3 during in-flight probe is rejected', cb2.shouldAllowRequest(1), false)

  // 10-11) Probe succeeds -> CLOSED, normal traffic resumes.
  cb2.recordSuccess(1)
  check('10: successful probe returns to CLOSED', cb2.getStatus(1).state, 'CLOSED')
  check('11: post-recovery requests are allowed again', cb2.shouldAllowRequest(1), true)

  // 12) Re-trip: three more failures opens it again.
  cb2.recordFailure(1); cb2.recordFailure(1); cb2.recordFailure(1)
  check('12: three more failures re-trips to OPEN', cb2.getStatus(1).state, 'OPEN')

  await new Promise(r => setTimeout(r, 150))

  // 13-14) Repeated HALF_OPEN failures double the cooldown each time
  // (exponential backoff), capped at maxCooldownMs.
  cb2.shouldAllowRequest(1) // enter HALF_OPEN, claim the probe
  const cooldownBeforeSecondFailure = cb2.getStatus(1).currentCooldownMs
  cb2.recordFailure(1)
  check('13: HALF_OPEN failure doubles the cooldown', cb2.getStatus(1).currentCooldownMs, cooldownBeforeSecondFailure * 2)
  check('13b: HALF_OPEN failure re-opens the circuit', cb2.getStatus(1).state, 'OPEN')

  await new Promise(r => setTimeout(r, cb2.getStatus(1).currentCooldownMs + 20))
  const cooldownBeforeThirdFailure = cb2.getStatus(1).currentCooldownMs
  cb2.shouldAllowRequest(1)
  cb2.recordFailure(1)
  check('14: cooldown keeps doubling on repeated HALF_OPEN failures', cb2.getStatus(1).currentCooldownMs, cooldownBeforeThirdFailure * 2)

  // 15) Probe timeout protection: a probe that never resolves unblocks
  // itself after probeTimeoutMs rather than wedging the peer open forever.
  const cb3 = new PeerCircuitBreaker({ initialCooldownMs: 100 })
  cb3.recordFailure(1); cb3.recordFailure(1); cb3.recordFailure(1)
  await new Promise(r => setTimeout(r, 150))
  cb3.shouldAllowRequest(1) // starts a probe that is never resolved
  const s15 = cb3.getOrCreate(1)
  s15.probeStartedAt = Date.now() - 20_000 // simulate a probe stuck for 20s
  check('15: a stuck probe unblocks itself after probeTimeoutMs', cb3.shouldAllowRequest(1), true)

  // 16) reset() clears tracked state for a peer immediately.
  const cb4 = new PeerCircuitBreaker()
  cb4.recordFailure(2); cb4.recordFailure(2); cb4.recordFailure(2)
  check('16a: peer is OPEN before reset', cb4.getStatus(2).state, 'OPEN')
  cb4.reset(2)
  check('16b: reset() immediately returns the peer to a fresh CLOSED state', cb4.getStatus(2).state, 'CLOSED')

  // 17) 429 and 5xx are failures; 4xx (other than 429) counts as success
  // (peer answered over HTTP, it's alive) -- this mirrors how
  // DmRelayService classifies fetch responses, not PeerCircuitBreaker
  // itself, so this test documents the intended classification directly.
  function classify(status) {
    return (status === 429 || status >= 500) ? 'failure' : 'success'
  }
  check('17a: HTTP 403 (privacy/signature rejection) classifies as success', classify(403), 'success')
  check('17b: HTTP 429 (rate limited) classifies as failure', classify(429), 'failure')
  check('17c: HTTP 500 classifies as failure', classify(500), 'failure')

  // 18) prune() drops state for peers no longer in the active set.
  const cb5 = new PeerCircuitBreaker()
  cb5.recordFailure(10)
  cb5.recordFailure(20)
  cb5.recordFailure(30)
  check('18a: three peers tracked before prune', cb5.peers.size, 3)
  cb5.prune([10, 20])
  check('18b: prune([10,20]) drops the untracked peer (30)', cb5.peers.size, 2)

  console.log(`\n${18 - failures}/18 passed`)
  process.exit(failures > 0 ? 1 : 0)
}

run()
