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
    if (index === currentFileIndex) el.classList.add('active');
    if (item.settings) el.classList.add('has-settings');
    if (item.isDirty) el.classList.add('is-dirty');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'file-list-checkbox';
    checkbox.checked = Boolean(item.selected);
    checkbox.dataset.index = String(index);

    const nameEl = document.createElement('span');
    nameEl.className = 'file-list-name';
    nameEl.append(document.createTextNode(item.file.name));

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
      onToggleSelected(index, e.target.checked);
    });

    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('file-list-checkbox')) return;
      onOpenFile(index);
    });

    el.append(checkbox, nameEl, statusEl);
    fragment.appendChild(el);
  });

  countEl.textContent = `${selectedCount}/${items.length} (${settingsCount} ${labels.configured})`;
  container.replaceChildren(fragment);

  return { selectedCount, settingsCount };
}
