let filmPresetsPromise = null;
// The table once it has loaded, for callers that must not wait (the GPU preview's
// per-frame parameters, #239).
let loadedFilmPresets = null;

export function loadFilmPresets() {
  if (!filmPresetsPromise) {
    filmPresetsPromise = import('./FilmPresets.js')
      .then(({ filmPresets }) => {
        loadedFilmPresets = filmPresets || {};
        return loadedFilmPresets;
      })
      .catch((err) => {
        filmPresetsPromise = null;
        throw err;
      });
  }
  return filmPresetsPromise;
}

export function getLoadedFilmPresets() {
  return loadedFilmPresets;
}
