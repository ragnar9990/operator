/* Shared across every page: fill in the handful of details that live in
   config.js, so the support address and seller name are written in one place
   and never drift between the footer and the legal pages. An element opts in
   with data-cfg="…"; if the value is still a placeholder, the page says so
   plainly rather than showing a dead "SUPPORT_EMAIL". */

(function () {
  var cfg = window.OPERATOR_SITE || {};
  var set = cfg.set || function () { return false; };
  var support = set(cfg.supportEmail) ? cfg.supportEmail : null;

  // Support links: a real mailto when we have an address, otherwise honest.
  document.querySelectorAll('[data-cfg="support"]').forEach(function (el) {
    if (support) { el.href = 'mailto:' + support; el.textContent = support; }
    else { el.removeAttribute('href'); el.textContent = 'a support email (added at launch)'; }
  });
  document.querySelectorAll('[data-cfg="support-link"]').forEach(function (el) {
    if (support) el.href = 'mailto:' + support;
    else el.removeAttribute('href');
  });

  // Plain text fills for the legal pages.
  var fill = function (sel, val) {
    document.querySelectorAll(sel).forEach(function (el) { if (val) el.textContent = val; });
  };
  fill('[data-cfg="seller"]', cfg.seller && set(cfg.seller.name) ? cfg.seller.name : null);
  fill('[data-cfg="country"]', cfg.seller ? cfg.seller.country : null);
  fill('[data-cfg="domain"]', set(cfg.domain) ? cfg.domain : null);
})();
