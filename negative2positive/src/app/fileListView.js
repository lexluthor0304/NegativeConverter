export function renderFileList({
  container,
  countEl,
  items,
  currentFileIndex,
  labels,
  onToggleSelected,
  onOpenFile
}) {
  let selectedCount = 0;
  let settingsCount = 0;
  const fragment = document.createDocumentFragment();

  items.forEach((item, index) => {
    if (item.selected) selectedCount++;
    if (item.settings) settingsCount++;

    const el = document.createElement('div');
    el.className = 'file-list-item';
    el.setAttribute('role', 'listitem');
    if (index === currentFileIndex) el.classList.add('active');
    if (item.settings) el.classList.add('has-settings');
    if (item.isDirty) el.classList.add('is-dirty');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'file-list-checkbox';
    checkbox.checked = Boolean(item.selected);
    checkbox.dataset.index = String(index);
    // Without this every row is announced as an anonymous "checkbox".
    checkbox.setAttribute('aria-label', labels.selectFile
      ? labels.selectFile(item.file.name)
      : item.file.name);

    // A button, not a span: opening another queued file was mouse-only before.
    const nameEl = document.createElement('button');
    nameEl.type = 'button';
    nameEl.className = 'file-list-name';
    nameEl.dataset.index = String(index);
    if (index === currentFileIndex) nameEl.setAttribute('aria-current', 'true');
    if (document.body.classList.contains('studio')) {
      const preview = document.createElement(item.thumbnail ? 'img' : 'span');
      preview.className = item.thumbnail ? 'file-list-thumbnail' : 'file-list-placeholder';
      if (item.thumbnail) {
        preview.src = item.thumbnail;
        preview.alt = '';
      } else {
        preview.textContent = String(index + 1).padStart(2, '0');
        preview.setAttribute('aria-hidden', 'true');
      }
      const filename = document.createElement('span');
      filename.className = 'file-list-filename';
      filename.textContent = item.file.name;
      nameEl.title = item.file.name;
      nameEl.append(preview, filename);
    } else {
      nameEl.append(document.createTextNode(item.file.name));
    }

    if (item.settings) {
      const badge = document.createElement('span');
      badge.className = 'file-list-settings-badge';
      badge.textContent = labels.customSettings;
      nameEl.append(badge);
    }

    if (item.isDirty) {
      const badge = document.createElement('span');
      badge.className = 'file-list-unsaved-badge';
      badge.textContent = labels.unsaved;
      nameEl.append(badge);
    }

    // Optional per-file badges (detected film stock, roll outlier, ...):
    // labels.badges(item) returns [{ className, text, title }].
    const extraBadges = typeof labels.badges === 'function' ? labels.badges(item) || [] : [];
    for (const spec of extraBadges) {
      if (!spec || !spec.text) continue;
      const badge = document.createElement('span');
      badge.className = `file-list-badge ${spec.className || ''}`.trim();
      badge.textContent = spec.text;
      if (spec.title) badge.title = spec.title;
      el.append(badge);
    }

    const statusEl = document.createElement('span');
    statusEl.className = `file-list-status ${item.status}`;
    statusEl.textContent = labels.statusText(item.status);

    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggleSelected(index, e.target.checked, { range: e.shiftKey });
    });

    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('file-list-checkbox')) return;
      onOpenFile(index);
    });

    let selectionControl = checkbox;
    if (document.body.classList.contains('studio')) {
      selectionControl = document.createElement('label');
      selectionControl.className = 'file-list-select-control';
      selectionControl.append(checkbox);
      selectionControl.addEventListener('click', event => event.stopPropagation());
    }
    el.append(selectionControl, nameEl, statusEl);
    fragment.appendChild(el);
  });

  countEl.textContent = `${selectedCount}/${items.length} (${settingsCount} ${labels.configured})`;

  // The whole list is rebuilt on every state change, so a checkbox toggled by
  // keyboard would otherwise drop focus to <body> mid-interaction.
  const active = document.activeElement;
  const restore = active && container.contains(active)
    ? { cls: active.className, index: active.dataset.index }
    : null;

  const scrollLeft = container.scrollLeft;
  container.setAttribute('role', 'list');
  installKeyboardNavigation(container);
  container.replaceChildren(fragment);
  container.scrollLeft = scrollLeft;

  if (restore && restore.index !== undefined) {
    const next = container.querySelector(
      `.${restore.cls.split(' ')[0]}[data-index="${restore.index}"]`
    );
    if (next) next.focus();
  }

  return { selectedCount, settingsCount };
}

// Arrow keys move between the file buttons; in the light table grid Up/Down
// jump by one row (the number of tiles sharing the first tile's top edge).
function installKeyboardNavigation(container) {
  if (container.dataset.keyNav) return;
  container.dataset.keyNav = 'true';
  container.addEventListener('keydown', (event) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const buttons = [...container.querySelectorAll('.file-list-name')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const firstTop = buttons[0].getBoundingClientRect().top;
    const columns = Math.max(1, buttons.filter((b) => Math.abs(b.getBoundingClientRect().top - firstTop) < 2).length);
    let next = index;
    if (event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'ArrowLeft') next = index - 1;
    else if (event.key === 'ArrowDown') next = index + columns;
    else if (event.key === 'ArrowUp') next = index - columns;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === index || next < 0 || next >= buttons.length) return;
    event.preventDefault();
    buttons[next].focus();
    buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}
