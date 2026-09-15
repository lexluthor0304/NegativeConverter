// Kodak TI-2660 (April 2013), page 2: US-manufactured 16/35/65 mm film.
// https://www.kodak.com/content/products-brochures/Film/Guide-to-Identifying-Year-of-Manufacture-for-KODAK-Motion-Picture-Films.pdf
// Country and gauge matter. Repeated codes never imply one year by themselves.
export const KODAK_YEAR_CODES = Object.freeze({
  '●': [1916,1936,1956,1976], '■': [1917,1937,1957,1977], '▲': [1918,1938,1958,1978],
  '●●': [1919,1939,1959,1979], '■■': [1920,1940,1960,1980], '▲▲': [1921,1941,1961,1981],
  '●■': [1922,1942,1962], '●▲': [1923,1943,1963], '▲■': [1924,1944,1964],
  '■●': [1925,1945,1965], '▲●': [1926,1946,1966], '■▲': [1927,1947,1967],
  '●●●': [1928,1948], '++': [1968], '+': [1929,1949,1969],
  '▲+': [1930,1950,1970], '●+': [1931,1951,1971], '■+': [1932,1952,1972],
  '+▲': [1933,1953,1973], '+●': [1934,1954,1974], '+■': [1935,1955,1975],
  '●■×': [1982], '×▲×': [1983], '▲■▲': [1984], '■●▲': [1985], '▲●▲': [1986],
  '■▲▲': [1987], '++▲': [1988], '×+▲': [1989], '▲+▲': [1990], '×+×': [1991],
  '■+▲': [1992], '+▲▲': [1993], '+●▲': [1994], '+■▲': [1995], '×●▲': [1996],
  '×■▲': [1997], '×▲▲': [1998], '●×▲': [1999], '■■▲': [2000], '▲▲●': [2001],
  '●■●': [2002], '●▲●': [2003], '▲■●': [2004], '■●●': [2005],
});
export const YEAR_SYMBOL_BITMAPS = {
  '●': ['01110','11111','11111','11111','11111','11111','01110'],
  '■': ['11111','11111','11111','11111','11111','11111','11111'],
  '▲': ['00100','00100','01110','01110','11111','11111','11111'],
  '+': ['00100','00100','00100','11111','00100','00100','00100'],
  '×': ['10001','10001','01010','00100','01010','10001','10001'],
};
export function decodeKodakYear(symbols, { country = 'unknown', earliest = 1910, latest = 2005 } = {}) {
  const candidates = (KODAK_YEAR_CODES[symbols] || []).filter(year => year >= earliest && year <= latest);
  // Post-1950 Canada/UK follow US codes; before that a country is necessary.
  const unambiguousCountry = country === 'US' || candidates.every(y => y > 1950);
  return { year: candidates.length === 1 && unambiguousCountry ? candidates[0] : null, candidates };
}
