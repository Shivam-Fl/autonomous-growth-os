// The executor (issue #20, TR-5): the ONLY module in the repository that calls
// a provider WRITE method. Everything that could reach an ad account comes
// through here, and the checks below run in the order written because the
// order is the safety property:
//
//   (0) tenant     — the envelope's own tenant, not the caller's word for it
//   (1) identity   — is this envelope one this server issued, unmoved: the
//                    kernel's shape check and signature comparison alone
//   (2) provenance — the bytes are one this server ISSUED, read back from the
//                    capabilities table rather than believed from the request
//   (3) dedupe     — durably, in the repository, before the provider is touched
//   (4) admission  — the kernel's other answer: expiry, scope, replay and the
//                    kill switches, which is what the envelope needs to WRITE
//   (5) the gate   — the SAME kernel.validateIntent, re-run here on the STORED
//                    envelope with the posture, the approval and the maturity
//                    read live, so a check that lived only at the minting route
//                    is a check this path cannot get past
//   (6) resolve    — the write method from the SIGNED action, never from the caller
//   (7) re-read    — through the READ interface, against the instance that wrote
//   (8) receipt    — one row, plus the idempotency effect and the audit event
//
// A SIGNATURE IS NOT AN AUTHORISATION. It proves the bytes have not moved since
// issuance, and a signature computed over a published dev secret proves that
// about an envelope the server never minted — which is why (2) exists and why
// the envelope is acted on only after it has been read back from storage.
//
// (1) and (2) are above (3) because (3) ANSWERS: a delivery reusing a spent
// nonce is handed a receipt, and the server owes that answer only to a body it
// has just proved is its own. Everything below (3) gates a WRITE, and a
// duplicate writes nothing — which is why a duplicate of a genuine envelope is
// still answered 200 while automation is frozen, and why an impostor wearing
// the same nonce is refused before the freeze is ever consulted.
//
// The provider is INJECTED and never constructed here: it is per request, and
// a module that built its own would have no way to honour the request's
// ?meta_error simulation, nor hold the state it just wrote for the re-read.

import { ACTION_WRITES } from '../integrations/meta_ads/index.js';
import { AUTHORITY_KINDS, SIGNED_FIELDS, approvalIdFromAuthority, intentFromEnvelope } from '../policy/kernel.js';

const CONSUMER = 'executor';

const DRIFT_SOURCES = new Set(['manual', 'platform', 'third-party']);

/** Every field issuance wrote, plus the signature: what the capabilities table
 * stores, and what execution must find again field for field. Comparing the
 * whole envelope rather than a chosen few means the duplicate answer's
 * correctness does not rest on a reader of this file knowing which fields the
 * HMAC happens to cover. */
const ENVELOPE_FIELDS = Object.freeze([...SIGNED_FIELDS, 'capability_id', 'signature']);

/**
 * The re-gate port, called with the STORED envelope's own values. It is
 * REQUIRED and not defaulted, for the same reason the kernel's two read ports
 * are: an executor with no way to ask the gate is an executor that stopped
 * enforcing it, and a default that admitted everything would be indistinguishable
 * from a working one.
 */
function assertGatePort(revalidate) {
  if (typeof revalidate !== 'function') {
    throw new Error('executor: revalidate is a required port (the same kernel.validateIntent the issuance routes call)');
  }
}

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

export function createExecutor({ repositories, provider, kernel, auditClock, revalidate }) {
  assertGatePort(revalidate);

  /**
   * Run one capability. Every branch that did NOT reach the provider releases
   * the claim it took, so a refused or failed write leaves a nonce unspent and
   * the caller's retry is a genuine retry rather than a swallowed claim — and
   * the two branches BEFORE the claim takes one have no claim to release,
   * because an unauthenticated body never takes one at all.
   *
   * There is NO approvalId option. Which queue row this execution satisfies is
   * read out of the STORED envelope's signed authority, because it was the
   * caller's claim about its own request when it was an option — and a
   * receipt filed against an approval nobody approved is worse than one filed
   * against no approval at all.
   */
  async function execute(capability, { actor, tenantId }) {
    const nowIso = auditClock();

    // (0) TENANT. A capability is bearer material: it says which tenant it is
    // for, and the executor does not take the caller's word for it.
    if (capability?.tenant !== tenantId) {
      return { executed: false, duplicate: false, error: { code: 'TENANT_MISMATCH', message: 'the capability names another tenant' } };
    }
    const nonce = capability.nonce;

    // (1) IDENTITY. Is this envelope shaped like one of ours and unmoved since
    // it was signed? That, and nothing else: whether it may WRITE right now is
    // (4)'s question, and a duplicate arrives under exactly the conditions (4)
    // refuses — so the two answers are asked in that order, and this one is
    // what the duplicate answer below is allowed to rest on.
    const identity = kernel.verifyCapabilityIdentity(capability);
    if (!identity.ok) {
      return { executed: false, duplicate: false, error: identity.error };
    }

    // (2) PROVENANCE. The signature above proves the bytes have not moved; it
    // does not prove this server ever issued them, and with the dev secret
    // published it cannot. So the envelope is read back out of the capabilities
    // table by its own primary key and required to be the SAME envelope, field
    // for field across everything issuance wrote. Everything after this point
    // acts on the STORED one, so a value that survived this comparison is a
    // value the server wrote — and so the receipt (3) hands back describes the
    // envelope that was actually spent rather than one the delivery claimed.
    const issued = repositories.capabilities.get(capability.tenant, capability.capability_id);
    const stored = issued?.envelope ?? null;
    // A stored authority of no recognised kind names no approval, and treating
    // it as autonomous would turn a row this build never wrote into the one
    // thing the write path admits without a human.
    const altered = stored === null
      || !AUTHORITY_KINDS.includes(stored.authority?.kind)
      || ENVELOPE_FIELDS.some((field) => JSON.stringify(capability[field]) !== JSON.stringify(stored[field]));
    if (altered) {
      return {
        executed: false,
        duplicate: false,
        error: {
          code: 'CAPABILITY_NOT_ISSUED',
          message: stored === null
            ? 'this capability was not issued by this server'
            : 'the delivered capability differs from the one this server issued',
          details: { reason: stored === null ? 'unknown-capability' : 'altered-envelope', capability_id: capability.capability_id },
        },
      };
    }
    const approvalId = approvalIdFromAuthority(stored.authority);

    // (3) DURABLE DEDUPE, in two sub-steps. 3a is check-then-act and does not
    // close the two-tab race; 3b is what closes it.
    const existing = repositories.actionRecords.getByNonce(capability.tenant, nonce);
    if (existing) {
      // A duplicate mutates nothing, so it answers with its receipt even while
      // a kill switch is active. This is deliberately NOT a 409: a second tab
      // or a retried POST is exactly the case where a 409 tells the operator
      // their action failed when it succeeded. It is also not an answer given
      // to whoever asks: (1) and (2) have just proved this body is the very
      // envelope the receipt is the record of, so the two describe each other
      // by construction rather than by a caller-supplied nonce.
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

    // (4) ADMISSION. (1) answered identity; this answers the other half of the
    // kernel's question — may this envelope write NOW: expiry, the caller's
    // tenant, a nonce already spent, and the kill switches. All four are
    // conditions of writing, and all four are conditions a duplicate arrives
    // under, which is why they sit below the dedupe and not above it.
    const validated = kernel.validateCapability(capability, { nowIso, tenantId });
    if (!validated.ok) {
      release();
      return { executed: false, duplicate: false, error: validated.error };
    }

    // (5) THE GATE, again, on the write path. Same pure kernel.validateIntent
    // the issuance routes ran, fed the STORED envelope's own values and the
    // server's own reading of the world: the live posture, the approval row the
    // envelope's own authority names, and the maturity measured now. A
    // correctness fix (a policy class, a cap, a trusted band) is worth what the
    // rules said, not what the rules said when the envelope was minted.
    const reGated = revalidate(stored.tenant, intentFromEnvelope(stored), { nowIso, approvalId });
    if (!reGated.ok) {
      release();
      return { executed: false, duplicate: false, error: reGated.error };
    }

    // (6) THE WRITE, resolved from the SIGNED action. An action the contract
    // does not map is a malformed capability, not a default to something
    // adjacent: a signed envelope naming a write this build does not implement
    // is refused, never quietly routed.
    const methodName = ACTION_WRITES[stored.action];
    if (methodName === undefined) {
      release();
      return {
        executed: false,
        duplicate: false,
        error: {
          code: 'MALFORMED_CAPABILITY',
          message: `no provider write is registered for ${stored.action}`,
          details: { field: 'action' },
        },
      };
    }
    const args = writeArgsFor(stored.action, stored);
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

    // (7) THE RE-READ, through the READ interface against the SAME provider
    // instance that performed the write, so one request reconciles against the
    // state it just wrote.
    const applied = written.data?.reported ?? null;
    const readBackState = await readBack(stored.action, stored, provider);
    const reconciliation = classify(applied, readBackState);
    const drift = classifyDrift(provider, reconciliation);

    // (8) THE RECEIPT. maturity and band are COPIED from the signed envelope
    // rather than recomputed: without that, the two audit columns would be null
    // on every autonomous receipt and a receipt could not answer which band was
    // actually enforced.
    const receiptId = `rcp_${String(stored.capability_id).replace(/^cap_/, '')}`;
    const executedAt = auditClock();
    const { appended } = repositories.actionRecords.append({
      tenant_id: stored.tenant,
      receipt_id: receiptId,
      approval_id: approvalId,
      capability_id: stored.capability_id,
      nonce,
      action_class: stored.action_class,
      action: stored.action,
      resource: stored.resource,
      requested: args,
      reported: readBackState ?? {},
      reconciliation,
      drift,
      maturity_at_decision: stored.maturity ?? null,
      band_at_decision: stored.band ?? null,
      actor,
      executed_at: executedAt,
    });

    if (!appended) {
      // Lost the UNIQUE nonce race between 3a and here. Release the claim and
      // hand back the receipt that won, rather than reporting a second write.
      release();
      const winner = repositories.actionRecords.getByNonce(stored.tenant, nonce);
      return {
        executed: false,
        duplicate: true,
        receipt_id: winner?.receipt_id ?? receiptId,
        reconciliation: winner?.reconciliation ?? null,
        drift: winner?.drift ?? null,
      };
    }

    repositories.idempotency.record(stored.tenant, nonce, CONSUMER, { receipt_id: receiptId });
    repositories.auditEvents.append({
      tenant_id: stored.tenant,
      actor,
      action: 'action.executed',
      subject: receiptId,
      capability_id: stored.capability_id,
      details: {
        action_class: stored.action_class,
        action: stored.action,
        resource: stored.resource,
        reconciliation,
        drift,
        band: stored.band ?? null,
        maturity: stored.maturity ?? null,
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
