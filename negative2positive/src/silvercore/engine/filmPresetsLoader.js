let filmPresetsPromise = null;

export function loadFilmPresets() {
  if (!filmPresetsPromise) {
    filmPresetsPromise = import('./FilmPresets.js')
      .then(({ filmPresets }) => filmPresets || {})
      .catch((err) => {
        filmPresetsPromise = null;
        throw err;
      });
  }
  return filmPresetsPromise;
}
