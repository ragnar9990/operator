// cursor.js — the drawn pointer in the click-through overlay (cursor.html).

const ptr = document.getElementById('ptr');
const ring = document.getElementById('ring');
let hideTimer = null;

// Matches the easing the Windows helper uses, so the drawn cursor and the
// real one stay together instead of drifting apart mid-glide.
const EASE = 'cubic-bezier(0.45, 0, 0.35, 1)';

window.operatorCursor.onMove(({ x, y, ms, action }) => {
  clearTimeout(hideTimer);
  ptr.classList.add('show');

  ptr.style.transition = ms > 0
    ? `transform ${Math.round(ms)}ms ${EASE}, opacity 160ms ease`
    : 'opacity 160ms ease';
  ptr.style.transform = `translate(${x}px, ${y}px)`;

  if (action === 'click' || action === 'scroll') {
    // Fire the ring when the pointer arrives, not when it sets off.
    setTimeout(() => {
      ring.style.setProperty('--at', `translate(${x}px, ${y}px)`);
      ring.classList.remove('fire');
      void ring.offsetWidth;          // restart the animation
      ring.classList.add('fire');
    }, Math.round(ms));
  }

  // Fade out once the agent stops moving, so it isn't sitting on your
  // screen for the rest of the day.
  hideTimer = setTimeout(() => ptr.classList.remove('show'), 4000);
});

window.operatorCursor.onHide(() => {
  clearTimeout(hideTimer);
  ptr.classList.remove('show');
});
