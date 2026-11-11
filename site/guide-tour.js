// The quick start's screen tours (/guide/): each [data-tour] holds a client window with its screens
// (.app-frame[data-frame]), the marks on them (.tour-spot[data-step], .term-line[data-step]) and the
// numbered steps under it (.tour-steps > li[data-frame]). One step is current at a time: its screen
// shows, its mark lights, and a caption with the step's words moves beside the mark. While a tour is
// on screen the steps play in turn: the current step's bar fills by a CSS animation and its end moves
// to the next step, so hovering or focusing the tour pauses both. Reduced motion: no autoplay, clicks
// only. Without this script every screen and step reads as a plain list.

const GAP = 12;

export function createTour(root, { autoplay = true } = {}) {
  const steps = [...root.querySelectorAll('.tour-steps > li')];
  const frames = [...root.querySelectorAll('.app-frame')];
  const marks = [...root.querySelectorAll('[data-step]')];
  const screen = root.querySelector('.app-screen');
  const caption = createCaption(root.ownerDocument, steps);
  screen?.append(caption);
  let current = -1;

  // The caption sits under the mark, or over it when the mark is low; a step without a mark (the
  // session's lines) keeps it at the bottom. Moved by transform only.
  function place() {
    const spot = marks.find(mark => Number(mark.dataset.step) === current && mark.classList.contains('tour-spot'));
    const width = screen?.clientWidth ?? 0, height = screen?.clientHeight ?? 0;
    const box = { width: caption.offsetWidth || 0, height: caption.offsetHeight || 0 };
    let x = GAP, y = height - box.height - GAP;
    if (spot) {
      const top = spot.offsetTop, bottom = top + spot.offsetHeight;
      x = Math.min(Math.max(spot.offsetLeft, GAP), width - box.width - GAP);
      y = bottom + GAP + box.height <= height ? bottom + GAP : Math.max(GAP, top - GAP - box.height);
      // A mark as tall as the screen: the caption rests inside its lower edge.
      if (y + box.height > height || (y < bottom && y + box.height > top)) y = Math.max(GAP, bottom - box.height - GAP);
    }
    caption.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function show(index) {
    current = (index + steps.length) % steps.length;
    const frame = steps[current].dataset.frame;
    frames.forEach(node => node.classList.toggle('is-current', node.dataset.frame === frame));
    steps.forEach((node, i) => {
      node.classList.toggle('is-current', i === current);
      const button = node.querySelector('button');
      if (i === current) button?.setAttribute('aria-current', 'step');
      else button?.removeAttribute('aria-current');
    });
    for (const mark of marks) {
      const step = Number(mark.dataset.step);
      mark.classList.toggle('is-current', step === current);
      // A line of the session appears once its step is reached, and stays.
      mark.classList.toggle('is-ahead', step > current && steps[step]?.dataset.frame === frame);
    }
    caption.querySelectorAll('[data-caption]').forEach(line => line.classList.toggle('is-current', Number(line.dataset.caption) === current));
    place();
  }

  steps.forEach((node, i) => node.querySelector('button')?.addEventListener('click', () => show(i)));
  // Only the current step's bar animates, so any animationend on a bar is its step ending.
  root.addEventListener('animationend', (event) => {
    if (event.target.classList?.contains('tour-bar')) show(current + 1);
  });
  const view = root.ownerDocument.defaultView;
  if (screen && view?.ResizeObserver) new view.ResizeObserver(place).observe(screen);

  root.classList.add('is-enhanced');
  root.classList.toggle('is-autoplay', autoplay);
  show(0);
  return {
    show,
    get current() { return current; },
    setPlaying(playing) { root.classList.toggle('is-playing', playing && autoplay); },
  };
}

// The caption holds a copy of every step's words (their data-i18n keys come along, so a language
// switch updates them too) and shows the current one. Screen readers read the steps list instead.
function createCaption(document, steps) {
  const caption = document.createElement('p');
  caption.className = 'tour-caption';
  caption.setAttribute('aria-hidden', 'true');
  steps.forEach((step, i) => {
    const line = document.createElement('span');
    line.dataset.caption = String(i);
    const number = document.createElement('b');
    number.textContent = String(i + 1);
    const words = step.querySelector('[data-i18n]')?.cloneNode(true);
    line.append(number, ...(words ? [words] : []));
    caption.append(line);
  });
  return caption;
}

export function startGuideTours({ document, window }) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const tours = [...document.querySelectorAll('[data-tour]')].map(root => [root, createTour(root, { autoplay: !reduced })]);
  if (!('IntersectionObserver' in window)) return tours.map(([, tour]) => tour);
  // A tour plays only while most of its window is on screen.
  const windows = new Map(tours.map(([root, tour]) => [root.querySelector('.tour-window') ?? root, tour]));
  const observer = new window.IntersectionObserver((entries) => {
    for (const entry of entries) windows.get(entry.target)?.setPlaying(entry.intersectionRatio >= 0.6);
  }, { threshold: [0, 0.6, 1] });
  for (const node of windows.keys()) observer.observe(node);
  return tours.map(([, tour]) => tour);
}
