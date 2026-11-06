// The install chapter (#start) as a pinned scroll sequence: the steps on one side, the client's
// real window on the other, one screen per scroll stretch. Each step is a button that scrolls to
// its own stretch, so the progress bar and the screen follow. Progressive enhancement: without it
// (no script, reduced motion, short screens) the steps and one screenshot read as a plain list.

const clamp = (value) => Math.min(1, Math.max(0, value));

export function createInstallStory() {
  const story = document.querySelector('.install-story');
  if (!story) return { setEnabled() {} };
  const frames = [...story.querySelectorAll('.app-frame')];
  const steps = [...story.querySelectorAll('.install-steps > li')];
  const buttons = steps.map((step) => step.querySelector('button'));
  const bar = story.querySelector('.install-progress');
  let enabled = false, scheduled = false, current = -1;

  function travel() {
    return Math.max(1, story.getBoundingClientRect().height - window.innerHeight);
  }

  function render() {
    scheduled = false;
    if (!enabled) return;
    const progress = clamp(-story.getBoundingClientRect().top / travel());
    const frame = Math.min(frames.length - 1, Math.floor(progress * frames.length));
    bar?.style.setProperty('--install-progress', progress.toFixed(3));
    if (frame === current) return;
    current = frame;
    const step = Number(frames[frame].dataset.step);
    frames.forEach((node, i) => node.classList.toggle('is-current', i === frame));
    steps.forEach((node, i) => node.classList.toggle('is-current', i === step));
    buttons.forEach((button, i) => {
      if (i === step) button?.setAttribute('aria-current', 'step');
      else button?.removeAttribute('aria-current');
    });
  }

  function schedule() {
    if (enabled && !scheduled) {
      scheduled = true;
      requestAnimationFrame(render);
    }
  }

  // A step's stretch starts at its first screen; land a little inside it.
  function show(step) {
    const first = frames.findIndex((frame) => Number(frame.dataset.step) === step);
    if (!enabled || first < 0) return;
    const top = story.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + travel() * ((first + 0.2) / frames.length), behavior: 'smooth' });
  }

  buttons.forEach((button, i) => button?.addEventListener('click', () => show(i)));
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });

  return {
    setEnabled(value) {
      enabled = value;
      story.classList.toggle('is-playing', value);
      buttons.forEach((button) => { if (button) button.disabled = !value; });
      current = -1;
      if (value) schedule();
      else {
        frames.forEach(node => node.classList.remove('is-current'));
        steps.forEach(node => node.classList.remove('is-current'));
        buttons.forEach(button => button?.removeAttribute('aria-current'));
      }
    },
  };
}
