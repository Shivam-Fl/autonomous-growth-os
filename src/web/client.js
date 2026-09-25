// Tiny vanilla JS: announces the page state to the aria-live region, wires the
// error-panel retry buttons, drives the journal detail drawer (open a row,
// fetch its decision, move focus in; Close or Escape returns focus to the
// invoking row) and the approval decision controls. Filter selects submit
// natively — no JS required. No framework, no build.

(function initClient() {
  'use strict';

  var region = document.getElementById('live-region');

  function announce(message) {
    if (region) {
      region.textContent = message;
    }
  }

  var state = document.body.dataset.state || 'live';
  var page = document.title.split('·')[0].trim();
  announce(page + (state ? ' is showing the ' + state + ' preview state' : ' is live'));

  function stripPreviewOverride(href) {
    var url = new URL(href, window.location.origin);
    url.searchParams.delete('state');
    return url.pathname + (url.search ? url.search : '');
  }

  document.querySelectorAll('[data-action="retry"]').forEach(function (button) {
    button.addEventListener('click', function () {
      announce('Retrying…');
      window.location.replace(stripPreviewOverride(button.dataset.retryHref || window.location.href));
    });
  });

  // An error panel moves focus to its retry action, so keyboard users are not
  // left at the top of a page whose data just failed to load.
  var failedRetry = document.querySelector('.panel-error [data-action="retry"]');
  if (failedRetry) {
    failedRetry.focus();
  }

  // The hypothesis composer (issue #22): every field persists to localStorage
  // on input and is restored on load, so the error shell — which keeps the
  // form mounted beside the error panel — never loses a typed draft. Keys are
  // namespaced opp_exp_draft_. Storage is read defensively: browsers without
  // it, or a denied quota, degrade to a non-persistent form.
  try {
    document.querySelectorAll('[data-draft-key]').forEach(function (field) {
      var key = field.dataset.draftKey;
      var stored = window.localStorage.getItem(key);
      if (stored !== null && stored !== '' && field.value === '') {
        field.value = stored;
      }
      field.addEventListener('input', function () {
        try {
          window.localStorage.setItem(key, field.value);
        } catch (error) {
          /* A denied quota must not stop the form from working. */
        }
      });
    });
  } catch (error) {
    /* Storage unavailable: the form still works, it just does not persist. */
  }

  // The journal detail drawer: filling it is the page's one async behaviour.
  // A failed fetch keeps the drawer closed and announces the failure instead
  // of opening an empty dialog.
  var drawer = document.getElementById('journal-drawer');
  var drawerBody = document.getElementById('journal-drawer-body');
  var invokingRow = null;

  function closeDrawer() {
    if (!drawer || drawer.hidden) {
      return;
    }
    drawer.hidden = true;
    if (invokingRow) {
      invokingRow.focus();
      invokingRow = null;
    }
    announce('Decision detail closed');
  }

  // Drawer lines are built with DOM nodes and textContent, never HTML
  // strings: every field the drawer shows (alternative actions and reasons,
  // risk wording, refs, critic result, policy id) comes from POSTed stored
  // decision data and must never parse as markup, however it is written.
  function drawerLine(label, value) {
    var line = document.createElement('p');
    var term = document.createElement('strong');
    term.textContent = label;
    line.appendChild(term);
    line.appendChild(document.createTextNode(' ' + value));
    return line;
  }

  function renderDrawer(decision) {
    drawerBody.replaceChildren();
    (decision.alternatives || []).forEach(function (entry) {
      var outcomes = entry.expected_outcomes || {};
      drawerBody.appendChild(drawerLine(
        'Alternative ' + String(entry.action),
        (entry.action === 'do_nothing' && entry.reason ? 'reason: ' + entry.reason + ' — ' : '')
        + 'expected mean ' + String(outcomes.mean)
        + ' (p10 ' + String(outcomes.p10) + ', p90 ' + String(outcomes.p90) + ')'
      ));
    });
    if (decision.risk) {
      drawerBody.appendChild(drawerLine(
        'Downside estimate',
        String(decision.risk.expected_downside_micros) + ' micros — worst reasonable case: ' + decision.risk.worst_reasonable_case
      ));
    }
    drawerBody.appendChild(drawerLine('Evidence refs', (decision.evidence_refs || []).join(', ') || '—'));
    drawerBody.appendChild(drawerLine('Memory refs', (decision.memory_refs || []).join(', ') || '—'));
    drawerBody.appendChild(drawerLine('Critic result', decision.critic_result || '—'));
    drawerBody.appendChild(drawerLine('Policy decision', decision.policy_decision_id || '—'));
  }

  if (drawer && drawerBody) {
    document.querySelectorAll('[data-action="open-decision"]').forEach(function (button) {
      button.addEventListener('click', function () {
        var decisionId = button.dataset.decisionId;
        invokingRow = button;
        announce('Opening decision detail for ' + decisionId);
        fetch('/v1/decisions/' + encodeURIComponent(decisionId))
          .then(function (response) {
            if (!response.ok) {
              throw new Error('decision fetch failed with ' + response.status);
            }
            return response.json();
          })
          .then(function (decision) {
            renderDrawer(decision);
            drawer.hidden = false;
            drawer.querySelector('[data-action="close-drawer"]').focus();
            announce('Decision detail opened for ' + decisionId);
          })
          .catch(function () {
            invokingRow = null;
            announce('Decision detail for ' + decisionId + ' could not be loaded');
          });
      });
    });

    drawer.querySelector('[data-action="close-drawer"]').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !drawer.hidden) {
        closeDrawer();
      }
    });
  }

  // Approval decisions (issue #20). One delegated listener for all three
  // controls, so a control rendered by a later render is bound without a
  // second registration pass. Both ids come from event.currentTarget — the
  // control itself — and never from a row walk: a control carrying neither
  // produces a request with no approval id and a 404 that looks like a bad
  // row rather than like a mis-bound button.
  //
  // The page's own ?meta_error=<mode> is FORWARDED onto the write URL, which
  // is what makes /approvals?meta_error=quota produce a refused approval
  // instead of a successful one.
  var decisionResult = document.querySelector('[data-testid="approval-decision-result"]');

  function resultNode(testid, lines) {
    var box = document.createElement('div');
    box.setAttribute('data-testid', testid);
    lines.forEach(function (line) {
      var paragraph = document.createElement('p');
      paragraph.textContent = line;
      box.appendChild(paragraph);
    });
    return box;
  }

  function showResult(node) {
    if (!decisionResult) {
      return;
    }
    decisionResult.replaceChildren(node);
    decisionResult.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('click', function (event) {
    var control = event.target.closest('[data-action="approve-decision"], [data-action="reject-decision"], [data-action="re-decide"]');
    if (!control) {
      return;
    }
    var approvalId = control.dataset.approvalId;
    var tenantId = control.dataset.tenantId;
    if (!approvalId) {
      return;
    }
    // A reason lives on the pending card; a re-decide on an executed receipt
    // has none, which is fine because the route answers a redelivery before it
    // ever reads the reason.
    var card = control.closest('[data-approval-card]');
    var field = card ? card.querySelector('input[name="reason"]') : null;
    var reason = field ? field.value : '';
    var verb = control.dataset.action === 'reject-decision' ? 'reject' : 'approve';

    // The in-flight guard: a disabled control plus a row-level busy flag, so a
    // double click cannot fire two requests for one decision.
    control.disabled = true;
    if (card) {
      card.setAttribute('data-busy', 'true');
    }
    if (decisionResult) {
      decisionResult.replaceChildren();
    }
    announce(verb === 'approve' ? 'Approving ' + approvalId : 'Rejecting ' + approvalId);

    var url = '/v1/approvals/' + encodeURIComponent(approvalId) + '/' + verb;
    var forwarded = new URLSearchParams(window.location.search).get('meta_error');
    if (forwarded) {
      url += '?meta_error=' + encodeURIComponent(forwarded);
    }

    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason, tenant_id: tenantId })
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          return { status: response.status, payload: payload };
        });
      })
      .then(function (answer) {
        var payload = answer.payload;
        if (payload.executed === true) {
          var toast = 'Executed. Receipt ' + String(payload.receipt_id) + '. Reconciliation: ' + String(payload.reconciliation) + '.';
          announce(toast);
          showResult(resultNode('approval-toast', [toast]));
          // The card is NOT optimistically removed: the queue is re-read from
          // the server, so a receipt that never landed cannot be shown as one
          // that did.
          window.location.reload();
          return;
        }
        if (payload.decided === true) {
          // A REJECTION is a decision that succeeded, and the route answers it
          // as {approval_id, status:'rejected', decided:true} — no receipt, no
          // reconciliation, and nothing executed. It is checked BEFORE the
          // failure branch because that branch is otherwise correct for it: a
          // rejected card would be reported as "the item stays pending" and
          // would never leave the queue.
          var rejected = 'Rejected. ' + String(payload.approval_id ?? '') + ' will not run.';
          announce(rejected);
          showResult(resultNode('approval-rejected', [rejected]));
          window.location.reload();
          return;
        }
        if (payload.duplicate === true) {
          // A duplicate is neither a success nor a failure: the receipt exists,
          // nothing ran twice, and reloading would only hide the answer.
          var already = 'Already decided. Receipt ' + String(payload.receipt_id) + '. Nothing was executed a second time.';
          announce(already);
          showResult(resultNode('approval-already-decided', [already]));
          control.disabled = false;
          if (card) {
            card.removeAttribute('data-busy');
          }
          return;
        }
        var failed = 'Approval action failed. Reconciliation: ' + String(payload.reconciliation ?? 'unknown') + '. The item stays pending and nothing was executed.';
        var lines = [failed];
        if (answer.status >= 400 && payload.code) {
          lines.push(String(payload.code) + ': ' + String(payload.message ?? ''));
        }
        announce(failed);
        showResult(resultNode('approval-failed', lines));
        // No reload: the card is still on the page and the typed reason is
        // still in its input.
        control.disabled = false;
        if (card) {
          card.removeAttribute('data-busy');
        }
      })
      .catch(function () {
        control.disabled = false;
        if (card) {
          card.removeAttribute('data-busy');
        }
        var offline = 'Approval action failed. Reconciliation: unknown. The item stays pending and nothing was executed.';
        announce(offline);
        showResult(resultNode('approval-failed', [offline, 'The request could not reach the server.']));
      });
  });
})();
