// The install chapter (#start) as a pinned scroll sequence: the steps on one side, the client's
// real window on the other, one screen per scroll stretch. Progressive enhancement: without it
// (no script, reduced motion, short screens) the steps and one screenshot read as a plain list.

const clamp = (value) => Math.min(1, Math.max(0, value));

export function createInstallStory() {
  const story = document.querySelector('.install-story');
  if (!story) return { setEnabled() {} };
  const frames = [...story.querySelectorAll('.app-frame')];
  const steps = [...story.querySelectorAll('.install-steps > li')];
  const bar = story.querySelector('.install-progress');
  let enabled = false, scheduled = false, current = -1;

  function render() {
    scheduled = false;
    if (!enabled) return;
    const box = story.getBoundingClientRect();
    const travel = Math.max(1, box.height - window.innerHeight);
    const progress = clamp(-box.top / travel);
    const frame = Math.min(frames.length - 1, Math.floor(progress * frames.length));
    bar?.style.setProperty('--install-progress', progress.toFixed(3));
    if (frame === current) return;
    current = frame;
    const step = Number(frames[frame].dataset.step);
    frames.forEach((node, i) => node.classList.toggle('is-current', i === frame));
    steps.forEach((node, i) => node.classList.toggle('is-current', i === step));
  }

  function schedule() {
    if (enabled && !scheduled) {
      scheduled = true;
      requestAnimationFrame(render);
    }
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });

  return {
    setEnabled(value) {
      enabled = value;
      story.classList.toggle('is-playing', value);
      current = -1;
      if (value) schedule();
      else {
        frames.forEach(node => node.classList.remove('is-current'));
        steps.forEach(node => node.classList.remove('is-current'));
      }
    },
  };
}
