// these exact bytes are allowed by both the admin and preview policies
export const BRIDGE = `(() => {
  const config = JSON.parse(document.querySelector('meta[name="inkling-preview"]').content);
  const targets = '[data-inkling-field], [data-inkling-section], [data-inkling-shared]';
  const nodes = [...document.querySelectorAll(targets)];
  const send = (kind, data = {}) => parent.postMessage({ channel: config.channel, kind, ...data }, config.origin);
  const selectionAt = element => {
    if (!element || !element.closest) return null;
    const shared = element.closest('[data-inkling-shared]')?.getAttribute('data-inkling-shared');
    if (shared) return { shared };
    const field = element.closest('[data-inkling-field]')?.getAttribute('data-inkling-field');
    const section = element.closest('[data-inkling-section]')?.getAttribute('data-inkling-section');
    return field || section ? { field, section } : null;
  };
  const elementFor = selection => {
    const attr = selection.shared ? 'data-inkling-shared' : selection.field ? 'data-inkling-field' : 'data-inkling-section';
    const key = selection.shared || selection.field || selection.section;
    return nodes.find(node => node.getAttribute(attr) === key);
  };
  const geometry = () => send('geometry', {
    scroll: scrollY,
    items: nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return { selection: selectionAt(node), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }),
  });
  let pending;
  const measure = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(geometry);
  };
  const highlight = (selection, reveal) => {
    for (const node of nodes) node.removeAttribute('data-inkling-selected');
    const node = elementFor(selection);
    if (!node) return;
    node.setAttribute('data-inkling-selected', '');
    if (reveal) {
      const rect = node.getBoundingClientRect();
      if (rect.top < 0) scrollBy(0, rect.top);
      else if (rect.bottom > innerHeight) scrollBy(0, Math.min(rect.top, rect.bottom - innerHeight));
    }
    measure();
  };
  addEventListener('message', event => {
    const value = event.data;
    if (event.source !== parent || event.origin !== config.origin || value?.channel !== config.channel) return;
    if (value.kind === 'init') {
      for (const node of nodes) {
        const selected = selectionAt(node);
        const label = selected.shared ? node.getAttribute('data-inkling-label') : value.labels[selected.field] || node.getAttribute('data-inkling-label') || 'content';
        node.setAttribute('tabindex', '0');
        node.setAttribute('role', 'button');
        node.setAttribute('aria-label', 'Edit ' + label);
      }
      scrollTo(0, value.scroll || 0);
      highlight(value.selection, false);
    } else if (value.kind === 'highlight') highlight(value.selection, value.reveal);
    else if (value.kind === 'focus') elementFor(value.selection)?.focus({ preventScroll: true });
  });
  let click;
  const select = (target, kind) => {
    const selection = selectionAt(target);
    if (selection) send(kind, { selection });
  };
  document.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(click);
    if (selectionAt(event.target)?.shared) click = setTimeout(() => select(event.target, 'select'), 250);
    else select(event.target, 'select');
  }, true);
  document.addEventListener('dblclick', event => {
    event.preventDefault();
    clearTimeout(click);
    select(event.target, 'edit');
  }, true);
  document.addEventListener('contextmenu', event => {
    clearTimeout(click);
    const selection = selectionAt(event.target);
    if (!selection) return;
    event.preventDefault();
    send('menu', { selection, x: event.clientX, y: event.clientY });
  });
  document.addEventListener('submit', event => event.preventDefault(), true);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && ['s', 'z'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      send('shortcut', { key: event.key.toLowerCase(), metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
      return;
    }
    const selection = selectionAt(event.target);
    if (!selection) return;
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = elementFor(selection).getBoundingClientRect();
      send('menu', { selection, x: rect.x, y: rect.y });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      clearTimeout(click);
      select(event.target, 'edit');
    }
  });
  addEventListener('scroll', () => { send('scroll'); measure(); }, { passive: true });
  addEventListener('resize', measure);
  const observer = new ResizeObserver(measure);
  observer.observe(document.documentElement);
  observer.observe(document.body);
  document.addEventListener('load', measure, true);
  send('ready');
  measure();
})();`

export const BRIDGE_HASH = "ayjZng8UQEHeY3eOboBctEG6/YObUPkwLfvOW3MZpr4="
