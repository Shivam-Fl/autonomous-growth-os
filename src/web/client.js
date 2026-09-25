// Tiny vanilla JS (<100 lines): announces the page state to the aria-live
// region and wires the error-panel retry buttons. No framework, no build.

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
})();
