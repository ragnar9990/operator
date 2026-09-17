// avatar.js — a bot's face.
//
// One construction for every bot so the roster reads as a single system: a body
// shape, two eyes, an accessory, a hue. Identity comes from the combination,
// never from redrawing the character. The eyes carry state, so the same face
// that tells you WHO a bot is also tells you WHAT it is doing.

(function (global) {
  const BODY = {
    squircle: '<rect class="av-body" x="4" y="4" width="24" height="24" rx="9"/>',
    round: '<circle class="av-body" cx="16" cy="16.5" r="12"/>',
    dome: '<path class="av-body" d="M4 17a12 12 0 0 1 24 0v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z"/>',
    shield: '<path class="av-body" d="M16 3.6 27.2 7.3v8.4c0 6.8-4.6 11-11.2 12.7C9.4 26.7 4.8 22.5 4.8 15.7V7.3Z"/>',
  };

  // Drawn over the body, never replacing part of it.
  const EXTRA = {
    none: '',
    antenna: '<path class="av-line" d="M16 4V1.8"/><circle class="av-dot" cx="16" cy="1" r="1.5"/>',
    visor: '<rect class="av-line av-fill" x="8" y="9.5" width="16" height="2.6" rx="1.3"/>',
    bolt: '<path class="av-line" d="M17.4 6.2 14 10.4h3.1l-1.4 3.4"/>',
    sprout: '<path class="av-line" d="M16 4.2V1.6"/><path class="av-line av-fill" d="M16 2.4c1.9-1.5 4-1.1 4-1.1s.1 2.2-1.8 2.9c-1.3.5-2.2-.6-2.2-1.8Z"/>',
    halo: '<ellipse class="av-line" cx="16" cy="2.4" rx="5.4" ry="1.8"/>',
    ears: '<circle class="av-line av-fill" cx="3.6" cy="16" r="2.2"/><circle class="av-line av-fill" cx="28.4" cy="16" r="2.2"/>',
  };

  const EYES =
    '<g class="av-eyes">' +
    '<rect x="10.4" y="14" width="3.6" height="5.4" rx="1.8"/>' +
    '<rect x="18" y="14" width="3.6" height="5.4" rx="1.8"/>' +
    '</g>';

  function svg(face, size) {
    const f = face || { hue: 199, shape: 'squircle', accessory: 'none' };
    const body = BODY[f.shape] || BODY.squircle;
    const extra = EXTRA[f.accessory] || '';
    const s = size || 30;

    return (
      '<svg class="av-svg" viewBox="0 0 32 32" width="' + s + '" height="' + s + '" aria-hidden="true" ' +
      'style="--h:' + f.hue + '">' +
      body + extra + EYES +
      '</svg>'
    );
  }

  // <span class="av working"><svg …></span>
  function el(face, size, state) {
    const span = document.createElement('span');
    span.className = 'av ' + (state || 'idle');
    span.innerHTML = svg(face, size);
    return span;
  }

  global.Avatar = { svg, el };
})(window);
