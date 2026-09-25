// The executor (issue #20, TR-5): the ONLY module in the repository that calls
// a provider WRITE method. Everything that could reach an ad account comes
// through here, and the checks below run in the order written because the
// order is the safety property:
//
//   (0) tenant   — the envelope's own tenant, not the caller's word for it
//   (1) dedupe   — durably, in the repository, before the provider is touched
//   (2) kernel   — signature, expiry, scope, replay and the kill switches
//   (3) resolve  — the write method from the SIGNED action, never from the caller
//   (4) re-read  — through the READ interface, against the instance that wrote
//   (5) receipt  — one row, plus the idempotency effect and the audit event
//
// The provider is INJECTED and never constructed here: it is per request, and
// a module that built its own would have no way to honour the request's
// ?meta_error simulation, nor hold the state it just wrote for the re-read.

import { ACTION_WRITES } from '../integrations/meta_ads/index.js';

const CONSUMER = 'executor';

const DRIFT_SOURCES = new Set(['manual', 'platform', 'third-party']);

/**
 * The write's arguments, derived from the SIGNED envelope through ONE named
 * function. resource is the target id for every update and status action — the
 * ad set id for a budget change, the campaign id for a status or creative
 * change.
 *
 * create_campaign is the case that needs stating: its resource is a PROPOSED
 * campaign id that does not exist yet, so the NAME comes from
 * constraints.name. Reading the name off resource would create a campaign
 * literally called 'campaign_004', which is exactly what an earlier revision
 * of this module did.
 */
export function writeArgsFor(action, envelope) {
  const constraints = envelope.constraints ?? {};
  switch (action) {
    case 'set_campaign_status':
      return { campaignId: envelope.resource, status: constraints.status };
    case 'update_campaign_budget':
      return { adSetId: envelope.resource, deltaMicros: constraints.delta_micros };
    case 'update_campaign_creative':
      return { campaignId: envelope.resource, name: constraints.name };
    case 'create_campaign':
      return { name: constraints.name };
    default:
      return null;
  }
}

/** The state this write was about, read back through the READ interface.
 * Returns null whenever there is nothing to compare against — a failed read or
 * a target that is not there — which is what makes 'unknown' reachable. */
async function readBack(action, envelope, provider) {
  switch (action) {
    case 'set_campaign_status': {
      const read = await provider.listCampaigns();
      if (!read.ok) {
        return null;
      }
      const row = read.data.find((campaign) => campaign.id === envelope.resource);
      return row ? { status: row.status } : null;
    }
    case 'update_campaign_budget': {
      const read = await provider.listAdSets();
      if (!read.ok) {
        return null;
      }
      const row = read.data.find((adSet) => adSet.id === envelope.resource);
      return row ? { daily_budget_micros: row.daily_budget_micros } : null;
    }
    case 'update_campaign_creative': {
      const [ads, adSets] = await Promise.all([provider.listAds(), provider.listAdSets()]);
      if (!ads.ok || !adSets.ok) {
        return null;
      }
      const targetAdSets = new Set(
        adSets.data.filter((adSet) => adSet.campaign_id === envelope.resource).map((adSet) => adSet.id),
      );
      return {
        ads: ads.data
          .filter((ad) => targetAdSets.has(ad.ad_set_id))
          .map((ad) => ({ id: ad.id, name: ad.name })),
      };
    }
    case 'create_campaign': {
      const read = await provider.listCampaigns();
      if (!read.ok) {
        return null;
      }
      const row = read.data.find((campaign) => campaign.name === envelope.constraints?.name);
      return row ? { id: row.id, name: row.name, status: row.status } : null;
    }
    default:
      return null;
  }
}

/**
 * Classify the post-write re-read into a CLOSED vocabulary, because the receipt
 * column, the success toast and the failure panel all render it:
 *
 *   'agreed'   — the re-read reports exactly the state the write applied
 *   'diverged' — the re-read succeeded and reports something else
 *   'partial'  — only some of a multi-field change landed
 *   'unknown'  — there is no re-read to compare against
 *
 * So every string the UI can render is one of the four, and none is undefined.
 * A provider refusal never reaches here; it answers with 'unknown' directly.
 */
function classify(applied, readBackState) {
  if (applied === null || readBackState === null) {
    return 'unknown';
  }
  if (Array.isArray(applied.ads)) {
    const wanted = new Map(applied.ads.map((id) => [id, applied.name]));
    const landed = (readBackState.ads ?? []).filter((ad) => wanted.get(ad.id) === ad.name).length;
    if (landed === 0) {
      return 'diverged';
    }
    return landed === wanted.size ? 'agreed' : 'partial';
  }
  const fields = Object.keys(applied);
  if (fields.length === 0) {
    return 'unknown';
  }
  return fields.every((field) => readBackState[field] === applied[field]) ? 'agreed' : 'diverged';
}

/**
 * The provider's own report of who changed the state behind the write, or
 * 'none' when nothing was reported and the re-read agreed. The source is named
 * by the provider rather than inferred here: a live adapter would read it from
 * a platform-side signal this slice does not have.
 */
function classifyDrift(provider, reconciliation) {
  const reported = provider.lastWrite?.()?.drift ?? 'none';
  if (DRIFT_SOURCES.has(reported)) {
    return reported;
  }
  return reconciliation === 'agreed' ? 'none' : 'platform';
}

export function createExecutor({ repositories, provider, kernel, auditClock }) {
  /**
   * Run one capability. Every branch that did NOT reach the provider releases
   * the claim it took, so a refused or failed write leaves a nonce unspent and
   * the caller's retry is a genuine retry rather than a swallowed claim.
   *
   * approvalId is the QUEUE ROW this execution satisfies, supplied by the
   * caller rather than read off the envelope: a signed capability is the
   * authority to write, and which approval it was spent against is the
   * caller's claim about its own request. It is null on the autonomous route,
   * which is exactly what keeps an autonomous receipt out of the queue's
   * executed-receipts panel.
   */
  async function execute(capability, { actor, tenantId, approvalId = null }) {
    const nowIso = auditClock();

    // (0) TENANT. A capability is bearer material: it says which tenant it is
    // for, and the executor does not take the caller's word for it.
    if (capability?.tenant !== tenantId) {
      return { executed: false, duplicate: false, error: { code: 'TENANT_MISMATCH', message: 'the capability names another tenant' } };
    }
    const nonce = capability.nonce;

    // (1) DURABLE DEDUPE, in two sub-steps. 1a is check-then-act and does not
    // close the two-tab race; 1b is what closes it.
    const existing = repositories.actionRecords.getByNonce(capability.tenant, nonce);
    if (existing) {
      // A duplicate mutates nothing, so it answers with its receipt even while
      // a kill switch is active. This is deliberately NOT a 409: a second tab
      // or a retried POST is exactly the case where a 409 tells the operator
      // their action failed when it succeeded.
      return {
        executed: false,
        duplicate: true,
        receipt_id: existing.receipt_id,
        reconciliation: existing.reconciliation,
        drift: existing.drift,
      };
    }
    if (!repositories.idempotency.claim(capability.tenant, nonce, CONSUMER)) {
      // Another delivery won the claim. Tell the loser to RETRY rather than to
      // wait on a receipt row: a winner that then fails releases the claim and
      // no row is ever coming, so a bounded wait would hang on nothing.
      return {
        executed: false,
        duplicate: false,
        error: {
          code: 'EXECUTION_IN_PROGRESS',
          message: 'another delivery of this capability is in flight; retry',
          retryable: true,
        },
      };
    }

    const release = () => repositories.idempotency.release(capability.tenant, nonce, CONSUMER);

    // (2) THE GATE.
    const validated = kernel.validateCapability(capability, { nowIso, tenantId });
    if (!validated.ok) {
      release();
      return { executed: false, duplicate: false, error: validated.error };
    }

    // (3) THE WRITE, resolved from the SIGNED action. An action the contract
    // does not map is a malformed capability, not a default to something
    // adjacent: a signed envelope naming a write this build does not implement
    // is refused, never quietly routed.
    const methodName = ACTION_WRITES[capability.action];
    if (methodName === undefined) {
      release();
      return {
        executed: false,
        duplicate: false,
        error: {
          code: 'MALFORMED_CAPABILITY',
          message: `no provider write is registered for ${capability.action}`,
          details: { field: 'action' },
        },
      };
    }
    const args = writeArgsFor(capability.action, capability);
    const written = await provider[methodName](args);

    if (!written.ok) {
      // A provider refusal releases the claim and writes NO receipt, so the
      // approval stays pending and the caller's next attempt is a real one.
      release();
      return {
        executed: false,
        duplicate: false,
        error: written.error,
        reconciliation: 'unknown',
      };
    }

    // (4) THE RE-READ, through the READ interface against the SAME provider
    // instance that performed the write, so one request reconciles against the
    // state it just wrote.
    const applied = written.data?.reported ?? null;
    const readBackState = await readBack(capability.action, capability, provider);
    const reconciliation = classify(applied, readBackState);
    const drift = classifyDrift(provider, reconciliation);

    // (5) THE RECEIPT. maturity and band are COPIED from the signed envelope
    // rather than recomputed: without that, the two audit columns would be null
    // on every autonomous receipt and a receipt could not answer which band was
    // actually enforced.
    const receiptId = `rcp_${String(capability.capability_id).replace(/^cap_/, '')}`;
    const executedAt = auditClock();
    const { appended } = repositories.actionRecords.append({
      tenant_id: capability.tenant,
      receipt_id: receiptId,
      approval_id: approvalId,
      capability_id: capability.capability_id,
      nonce,
      action_class: capability.action_class,
      action: capability.action,
      resource: capability.resource,
      requested: args,
      reported: readBackState ?? {},
      reconciliation,
      drift,
      maturity_at_decision: capability.maturity ?? null,
      band_at_decision: capability.band ?? null,
      actor,
      executed_at: executedAt,
    });

    if (!appended) {
      // Lost the UNIQUE nonce race between 1a and here. Release the claim and
      // hand back the receipt that won, rather than reporting a second write.
      release();
      const winner = repositories.actionRecords.getByNonce(capability.tenant, nonce);
      return {
        executed: false,
        duplicate: true,
        receipt_id: winner?.receipt_id ?? receiptId,
        reconciliation: winner?.reconciliation ?? null,
        drift: winner?.drift ?? null,
      };
    }

    repositories.idempotency.record(capability.tenant, nonce, CONSUMER, { receipt_id: receiptId });
    repositories.auditEvents.append({
      tenant_id: capability.tenant,
      actor,
      action: 'action.executed',
      subject: receiptId,
      capability_id: capability.capability_id,
      details: {
        action_class: capability.action_class,
        action: capability.action,
        resource: capability.resource,
        reconciliation,
        drift,
        band: capability.band ?? null,
        maturity: capability.maturity ?? null,
      },
      occurred_at: executedAt,
    });

    return {
      executed: true,
      receipt_id: receiptId,
      requested: args,
      reported: readBackState ?? {},
      reconciliation,
      drift,
    };
  }

  return { execute, writeArgsFor };
}
