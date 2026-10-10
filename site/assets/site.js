// Veridone website: copy buttons and the hero transcript replay. Works without JS (static transcript).
(() => {
  for (const btn of document.querySelectorAll('button.copy[data-copy]')) {
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.dataset.copied = '';
        btn.textContent = btn.dataset.done || 'Copied';
      } catch {
        btn.textContent = btn.dataset.fail || 'Select and copy';
      }
      setTimeout(() => { delete btn.dataset.copied; btn.textContent = label; }, 1800);
    });
  }

  const list = document.querySelector('.transcript');
  if (!list) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const items = [...list.children];
  let timers = [];

  function typeIn(li) {
    const what = li.querySelector('.what');
    const text = what.dataset.text || what.textContent;
    what.dataset.text = text;
    what.textContent = '';
    what.classList.add('typed');
    let i = 0;
    const step = () => {
      what.textContent = text.slice(0, ++i);
      if (i < text.length) timers.push(setTimeout(step, 18));
      else what.classList.remove('typed');
    };
    step();
  }

  function play() {
    timers.forEach(clearTimeout);
    timers = [];
    if (reduce) return;
    list.classList.add('is-playing');
    items.forEach((li) => li.classList.remove('shown'));
    let at = 250;
    for (const li of items) {
      at += Number(li.dataset.delay || 650);
      const typed = li.hasAttribute('data-typed');
      timers.push(setTimeout(() => { li.classList.add('shown'); if (typed) typeIn(li); }, at));
      if (typed) { const w = li.querySelector('.what'); at += (w.dataset.text || w.textContent).length * 18; }
    }
  }

  const replay = document.querySelector('.replay');
  if (replay) {
    if (reduce) replay.hidden = true;
    replay.addEventListener('click', play);
  }
  play();
})();
