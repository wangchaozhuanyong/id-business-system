(function () {
  let nextId = 0;

  function positionNote(help) {
    const note = help.querySelector('.title-description');
    if (!note || !help.open) return;
    const anchor = help.querySelector('summary').getBoundingClientRect();
    const bounds = note.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(anchor.left, innerWidth - bounds.width - margin));
    const below = anchor.bottom + 8;
    const top = below + bounds.height <= innerHeight - margin
      ? below
      : Math.max(margin, anchor.top - bounds.height - 8);
    note.style.left = `${left}px`;
    note.style.top = `${top}px`;
  }

  // The top layer escapes clipped cards, scrolling drawers and container-query boundaries.
  document.addEventListener('toggle', (event) => {
    const help = event.target;
    if (!help.matches?.('.title-help')) return;
    const note = help.querySelector('.title-description');
    if (!note?.showPopover) return;
    note.setAttribute('popover', 'manual');
    if (help.open) {
      note.showPopover();
      positionNote(help);
    } else if (note.matches(':popover-open')) note.hidePopover();
  }, true);

  const reposition = () => {
    for (const help of document.querySelectorAll('.title-help[open]')) positionNote(help);
  };
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, { capture: true, passive: true });

  window.IDTitleHelp = {
    attach(title, description) {
      if (!title || !description || title.parentElement.classList.contains('title-with-help'))
        return;
      const row = document.createElement('div');
      row.className = 'title-with-help';
      title.before(row);
      const help = document.createElement('details');
      help.className = 'title-help';
      const trigger = document.createElement('summary');
      trigger.setAttribute('aria-label', '查看' + title.textContent.trim() + '说明');
      trigger.textContent = 'ⓘ';
      const note = document.createElement('div');
      note.className = 'title-description';
      note.id = 'title-note-' + ++nextId;
      note.setAttribute('role', 'note');
      trigger.setAttribute('aria-controls', note.id);
      note.append(...description.childNodes);
      description.remove();
      help.append(trigger, note);
      row.append(title, help);
    }
  };

  document.addEventListener('click', (event) => {
    for (const help of document.querySelectorAll('.title-help[open]'))
      if (!help.contains(event.target)) help.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const openHelp = document.querySelectorAll('.title-help[open]');
    if (openHelp.length) event.preventDefault();
    for (const help of openHelp) {
      const returnFocus = help.contains(document.activeElement);
      help.open = false;
      if (returnFocus) help.querySelector('summary').focus({ preventScroll: true });
    }
  });
})();
