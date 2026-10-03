'use strict';

// Shared page behaviour: delete confirmations, copy-to-clipboard, mobile nav.
(function () {
  // Confirm dialogs for destructive actions.
  document.addEventListener('submit', function (e) {
    const form = e.target.closest('form[data-confirm]');
    if (form && !window.confirm(form.dataset.confirm)) {
      e.preventDefault();
    }
  });

  // Copy buttons.
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const input = document.querySelector(btn.dataset.target);
      if (!input) return;
      input.select();
      const done = function () {
        const old = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(function () { btn.textContent = old; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, function () { document.execCommand('copy'); done(); });
      } else {
        document.execCommand('copy');
        done();
      }
    });
  });

  // Close mobile nav after tapping a link.
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    a.addEventListener('click', function () { document.body.classList.remove('nav-open'); });
  });
})();
