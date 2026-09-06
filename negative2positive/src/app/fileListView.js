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
