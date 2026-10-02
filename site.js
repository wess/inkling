// Shared behaviour for the documentation pages. The landing page carries its
// own title sequence and does not load this.

// Scroll reveal. Anything marked .enter rises once, then stops being watched.
(function () {
  const items = document.querySelectorAll(".enter");
  if (!items.length) return;
  if (!("IntersectionObserver" in window)) {
    items.forEach(i => i.classList.add("seen"));
    return;
  }
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("seen");
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: "0px 0px -10% 0px" });
  items.forEach(i => io.observe(i));
})();

// Mark the table of contents entry for whatever section is on screen. Keyed on
// the heading nearest the top of the viewport rather than the first one
// intersecting, so a short section between two long ones still registers.
(function () {
  const links = Array.from(document.querySelectorAll(".toc a[href^='#']"));
  if (!links.length) return;

  const targets = links
    .map(link => {
      const el = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      return el ? { link, el } : null;
    })
    .filter(Boolean);

  if (!targets.length) return;

  let ticking = false;

  const mark = () => {
    ticking = false;
    // 120px down the viewport: below the sticky nav, so the heading that reads
    // as "current" is the one the reader is actually under.
    const line = 120;
    let active = targets[0];
    for (const candidate of targets) {
      if (candidate.el.getBoundingClientRect().top <= line) active = candidate;
    }
    for (const { link } of targets) link.classList.remove("here");
    active.link.classList.add("here");
  };

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(mark);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  mark();
})();
