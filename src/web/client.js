// Tiny vanilla JS (<100 lines): announces the page state to the aria-live
// region, wires the error-panel retry buttons, and drives the journal detail
// drawer (open a row, fetch its decision, move focus in; Close or Escape
// returns focus to the invoking row). Filter selects submit natively — no JS
// required. No framework, no build.

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

  // No focus is taken here, on purpose. Focusing the failing panel's retry
  // action parked the keyboard deep in the document before the user had pressed
  // anything, so the first Tab after a fresh load continued from there and the
  // skip link was never the first stop (issue #61, AC-1). The focus was also
  // standing in for an announcement that did not exist: on a region-level
  // failure such as ?meta_error=quota the body state is still 'ideal', so the
  // live region named nothing that had failed. Announce the panel's own
  // heading instead — docs/ui.md requires the panel to state what failed, so
  // the announcement cannot drift from the page — read defensively so a shell
  // without an <h2> degrades to a generic sentence rather than throwing.
  var failedPanel = document.querySelector('.panel-error');
  if (failedPanel) {
    var failedHeading = failedPanel.querySelector('h2');
    var failure = failedHeading && failedHeading.textContent
      ? failedHeading.textContent.trim()
      : 'This page failed to load';
    announce(failure + ' Use Retry to try again.');
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
})();
