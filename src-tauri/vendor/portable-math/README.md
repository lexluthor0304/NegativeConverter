# portable-math

LibRaw builds lookup tables with libm on every decode: the output gamma curve
(`pow`, `exp`, `log`), the CIELab cube-root table AHD uses to pick directions
(`pow(float, float)`, i.e. `powf`), and a few smaller ones (`logf`, `cos`).
Different libms, and compilers that constant-fold or rewrite these calls
(`pow(x, 0.5)` → `sqrt`, folding with the build machine's own libm, …), can
shift those tables by one unit in the last place, which can move a decoded
pixel by a level. This directory pins them.

- `musl/` — musl v1.2.6's `pow`, `powf`, `exp`, `log`, `logf` and `cos`, with the
  data tables and internal helpers they use, **unmodified** (`musl-1.2.6.tar.gz`,
  sha256 `d585fd3b613c66151fc3249e8ed44f77020cb5e6c1e635a616d3f9f82460512a`,
  `src/math/`). They are the same files Emscripten's libc compiles (5.0.7 and
  6.0.4 alike), so on wasm32 they compute exactly what earlier builds of this
  package computed. musl is MIT licensed; see `musl/COPYRIGHT` and the notices in
  the individual files.
- `include/libm.h`, `include/features.h` — stand-ins for musl's internal headers,
  so the files build outside musl. `libm.h` also renames every function and
  table to `libraw_portable_*` (so nothing clashes with, or interposes on, the
  platform libm) and undefines `__FP_FAST_FMA`, so every target takes musl's
  non-FMA code paths — the only ones wasm32, which has no fused multiply-add,
  can take. `__rem_pio2_large.c` also calls `floor` and `scalbn`; both are exact
  on every libm.
- `libraw_portable_math.h` — force-included (`-include`) into LibRaw's C++
  sources. It maps LibRaw's calls onto the functions above, with the same
  overloads `<cmath>` gives these names (`pow(float, float)` is `powf`,
  `log(float)` is `logf`, other arguments promote to `double`).

`compileLibraw.sh` compiles each file in `musl/` as C with
`-ffp-contract=off -fno-builtin -U__FP_FAST_FMA -include include/libm.h`
into `libs/libportablemath.a`, and every LibRaw source with
`-ffp-contract=off -include libraw_portable_math.h`. A native build of LibRaw
that should decode to the same pixels as this package does the same (and must
not use `-ffast-math`/`/fp:fast` or FMA contraction).

To update musl, copy the same files from the new release's `src/math/`, and
check its `src/internal/libm.h` for changes that `include/libm.h` should follow.
