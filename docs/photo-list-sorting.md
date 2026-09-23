# Photo-list sorting

The film strip and light table share one Sort selector. Fresh devices default
to **Modified: newest first**. The other choices are oldest first and natural
filename order in either direction (`frame2` before `frame10` when ascending).
The preference is stored under `nc_photo_sort_v1`; invalid values fall back to
the default. Storage failures do not prevent sorting.

Modification time means the original `File.lastModified`, not EXIF capture
time or the last in-app adjustment. Missing/invalid timestamps sort last in
both directions. Equal dates or equivalent filenames retain import order.
The name collator uses a fixed locale, numeric comparison and case-insensitive
matching so changing the UI language does not change the order.

Sorting is a presentation-only permutation of original queue indices. It
does not change the active photo, settings, history, selection, cache keys,
pending decode ownership, or source files. Initial import activation keeps
the existing selected-file behavior. Appended files join the current sort
without switching the open photo. Row elements and decoded thumbnails are
reused, and the index permutation is cached across status/thumbnail updates.

Keyboard navigation follows the rendered order. Shift selection spans the
displayed, review-filtered range. Batch exports and contact sheets consume
the sorted selected entries but retain their original indices for settings
lookup. Changing the order is disabled while export owns the selection.
The project format and embedded frame identity remain unchanged.

Regression coverage: `fileListOrder.test.mjs`, `fileListSorting.test.mjs`,
`fileListView.test.mjs`, `studioWorkspace.test.mjs`, and the browser smoke
suite's photo-sort and light-table scenarios.
