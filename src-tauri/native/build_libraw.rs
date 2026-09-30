// Build-script half of the native RAW decoder (#264 part C), included by
// build.rs. Compiles the vendored LibRaw release (vendor/libraw), the portable
// libm it calls (vendor/portable-math, the copy libraw-wasm bundles) and the C
// shim (native/nc_libraw.cpp) with the `cc` crate, with the settings the WASM
// decoder uses so both decode to the same pixels (docs/native-raw-decode.md),
// and links an OpenMP runtime where no separate install is needed:
//
// - macOS: the vendored static LLVM libomp (vendor/libomp/macos, built by
//   scripts/build-libomp-macos.sh for 10.15 x86_64 / 11.0 arm64). Nothing is
//   loaded at run time, and the App Store build needs no entitlement.
// - Linux: single-threaded by default; NEGATIVE_CONVERTER_NATIVE_RAW_OPENMP=gomp
//   links libgomp (the packages then have to depend on it).
// - Windows: not built by default (NEGATIVE_CONVERTER_NATIVE_RAW=1 builds it,
//   single-threaded; =vcomp in NEGATIVE_CONVERTER_NATIVE_RAW_OPENMP adds
//   /openmp, and vcomp140.dll then has to ship next to the executable).
//
// NEGATIVE_CONVERTER_NATIVE_RAW=0 leaves the decoder out on every platform;
// the commands then report it unavailable and the page keeps libraw-wasm.
//
// Emits `cfg(native_raw)` when the decoder is linked and
// `cfg(native_raw_openmp)` when it runs on several threads.

use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

pub fn build() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    println!("cargo::rustc-check-cfg=cfg(native_raw)");
    println!("cargo::rustc-check-cfg=cfg(native_raw_openmp)");
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-changed=vendor");
    println!("cargo:rerun-if-env-changed=NEGATIVE_CONVERTER_NATIVE_RAW");
    println!("cargo:rerun-if-env-changed=NEGATIVE_CONVERTER_NATIVE_RAW_OPENMP");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let requested = env::var("NEGATIVE_CONVERTER_NATIVE_RAW").ok();
    let wanted = match requested.as_deref().map(str::trim) {
        Some(value) if is_off(value) => false,
        Some(value) if !value.is_empty() => true,
        // Windows needs a verified MSVC build of LibRaw and musl first.
        _ => matches!(target_os.as_str(), "macos" | "linux"),
    };
    if !wanted || !matches!(target_os.as_str(), "macos" | "linux" | "windows") {
        return;
    }

    let libraw = manifest.join("vendor/libraw");
    let portable = manifest.join("vendor/portable-math");
    let shim = manifest.join("native/nc_libraw.cpp");
    let sources = libraw_sources(&manifest.join("native/libraw-sources.txt"), &libraw);
    let musl = c_files(&portable.join("musl"));
    if sources.is_empty() || musl.is_empty() || !shim.is_file() {
        println!("cargo:warning=native RAW decoder sources missing; the WASM decoder stays in use");
        return;
    }

    let openmp_request = env::var("NEGATIVE_CONVERTER_NATIVE_RAW_OPENMP").unwrap_or_default();
    let openmp = choose_openmp(&manifest, &target_os, &target_env, openmp_request.trim());
    let msvc = target_env == "msvc";

    // One configuration per kind of translation unit.
    let configure = |build: &mut cc::Build, unit: Unit| {
        build.opt_level(if unit == Unit::PortableMath { 2 } else { 3 }).debug(false).warnings(false).extra_warnings(false);
        // IEEE-strict everywhere: no fast-math and no fused multiply-add
        // contraction (clang contracts a*b+c by default where the target has
        // FMA, arm64; baseline x86-64 and WASM have none). `char` is signed as
        // on wasm32, x86-64 and Apple arm64 (Linux arm64 defaults to unsigned).
        if msvc {
            build.flag("/fp:precise");
        } else {
            build.flag("-w").flag("-ffp-contract=off").flag("-fno-fast-math").flag("-fsigned-char");
        }
        if unit == Unit::PortableMath {
            // musl's own sources, compiled as libraw-wasm compiles them.
            build.cpp(false).include(portable.join("include"));
            let libm = portable.join("include/libm.h");
            if msvc {
                build.flag("/Oi-").flag(format!("/FI{}", libm.display()));
            } else {
                build.flag("-fno-builtin").flag("-U__FP_FAST_FMA").flag("-U__FP_FAST_FMAF").flag("-include").flag(libm.to_string_lossy().as_ref());
            }
            return;
        }
        build.cpp(true).std("c++17").include(&libraw).define("NDEBUG", None);
        if msvc {
            build.define("LIBRAW_NODLL", None).define("_CRT_SECURE_NO_WARNINGS", None).flag("/bigobj").flag("/EHsc");
        }
        if unit == Unit::LibRaw {
            // LibRaw's pow/powf/exp/log/logf/cos calls go to the portable copies.
            let header = portable.join("libraw_portable_math.h");
            if msvc {
                build.flag(format!("/FI{}", header.display()));
            } else {
                build.flag("-include").flag(header.to_string_lossy().as_ref());
            }
        }
        match &openmp {
            OpenMp::None => {}
            OpenMp::LlvmStatic { include, .. } => {
                // FORCE: libraw_types.h drops LIBRAW_USE_OPENMP on Apple when
                // _REENTRANT is defined.
                build.define("LIBRAW_FORCE_OPENMP", None).flag("-Xpreprocessor").flag("-fopenmp").include(include);
            }
            OpenMp::Gomp => {
                build.define("LIBRAW_FORCE_OPENMP", None).flag("-fopenmp");
            }
            OpenMp::Vcomp => {
                build.define("LIBRAW_FORCE_OPENMP", None).flag("/openmp");
            }
        }
    };

    let units: Vec<(PathBuf, Unit)> = sources
        .iter()
        .map(|path| (path.clone(), Unit::LibRaw))
        .chain(musl.iter().map(|path| (path.clone(), Unit::PortableMath)))
        .chain(std::iter::once((shim.clone(), Unit::Shim)))
        .collect();

    // The archive only changes with the sources, the flags and the compiler:
    // reuse it when build.rs reruns for anything else (the Tauri config).
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let fingerprint = {
        let mut hasher = DefaultHasher::new();
        let headers = [header_files(&libraw.join("libraw")), header_files(&libraw.join("internal")), header_files(&portable), header_files(&portable.join("include")), header_files(&portable.join("musl"))];
        for path in units.iter().map(|(path, _)| path).chain(headers.iter().flatten()) {
            path.hash(&mut hasher);
            fs::read(path).unwrap_or_default().hash(&mut hasher);
        }
        openmp.describe().hash(&mut hasher);
        for key in ["TARGET", "CC", "CXX", "CFLAGS", "CXXFLAGS", "MACOSX_DEPLOYMENT_TARGET"] {
            env::var(key).unwrap_or_default().hash(&mut hasher);
        }
        for unit in [Unit::LibRaw, Unit::PortableMath, Unit::Shim] {
            let mut build = cc::Build::new();
            configure(&mut build, unit);
            let tool = build.get_compiler();
            format!("{:?} {:?}", tool.path(), tool.args()).hash(&mut hasher);
        }
        hasher.finish()
    };
    let stamp = out_dir.join(format!("nc_libraw-{fingerprint:016x}.stamp"));
    let archive = out_dir.join(if msvc { "nc_libraw.lib" } else { "libnc_libraw.a" });

    if stamp.is_file() && archive.is_file() {
        println!("cargo:rustc-link-search=native={}", out_dir.display());
        println!("cargo:rustc-link-lib=static=nc_libraw");
        link_cpp_stdlib(&target_os, msvc);
    } else {
        for old in fs::read_dir(&out_dir).into_iter().flatten().flatten() {
            let name = old.file_name().to_string_lossy().into_owned();
            if name.starts_with("nc_libraw-") && name.ends_with(".stamp") {
                let _ = fs::remove_file(old.path());
            }
        }
        // ~100 translation units; cc compiles serially without its `parallel`
        // feature, so spread them over the jobs cargo allows.
        let jobs = env::var("NUM_JOBS").ok().and_then(|n| n.parse::<usize>().ok()).unwrap_or(4).clamp(1, 16);
        let objects: Vec<PathBuf> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..jobs)
                .map(|job| {
                    let mine: Vec<&(PathBuf, Unit)> = units.iter().skip(job).step_by(jobs).collect();
                    let configure = &configure;
                    scope.spawn(move || {
                        let mut objects = Vec::new();
                        for unit in [Unit::LibRaw, Unit::PortableMath, Unit::Shim] {
                            let files: Vec<&PathBuf> = mine.iter().filter(|(_, kind)| *kind == unit).map(|(path, _)| path).collect();
                            if files.is_empty() {
                                continue;
                            }
                            let mut build = cc::Build::new();
                            configure(&mut build, unit);
                            objects.extend(build.files(files).compile_intermediates());
                        }
                        objects
                    })
                })
                .collect();
            handles.into_iter().flat_map(|handle| handle.join().expect("LibRaw compile thread panicked")).collect()
        });
        let mut build = cc::Build::new();
        configure(&mut build, Unit::Shim);
        build.objects(objects).compile("nc_libraw");
        let _ = fs::write(&stamp, b"");
    }

    match &openmp {
        OpenMp::None => {
            if target_os == "macos" {
                println!("cargo:warning=native RAW decoder built without OpenMP (vendor/libomp/macos missing): one thread");
            }
        }
        OpenMp::LlvmStatic { lib_dir, .. } => {
            println!("cargo:rustc-link-search=native={}", lib_dir.display());
            println!("cargo:rustc-link-lib=static=omp");
            println!("cargo:rustc-cfg=native_raw_openmp");
        }
        OpenMp::Gomp => {
            println!("cargo:rustc-link-lib=gomp");
            println!("cargo:rustc-cfg=native_raw_openmp");
        }
        OpenMp::Vcomp => {
            // cl.exe's /openmp embeds a default-library directive for
            // vcomp.lib; vcomp140.dll has to ship next to the executable.
            println!("cargo:rustc-cfg=native_raw_openmp");
        }
    }
    if target_os == "windows" {
        // LibRaw takes ntohs/htonl from Winsock.
        println!("cargo:rustc-link-lib=ws2_32");
    }
    println!("cargo:rustc-cfg=native_raw");
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Unit {
    LibRaw,
    PortableMath,
    Shim,
}

enum OpenMp {
    None,
    LlvmStatic { include: PathBuf, lib_dir: PathBuf },
    Gomp,
    Vcomp,
}

impl OpenMp {
    fn describe(&self) -> String {
        match self {
            OpenMp::None => "none".into(),
            OpenMp::LlvmStatic { include, lib_dir } => {
                let mut hasher = DefaultHasher::new();
                fs::read(lib_dir.join("libomp.a")).unwrap_or_default().hash(&mut hasher);
                fs::read(include.join("omp.h")).unwrap_or_default().hash(&mut hasher);
                format!("llvm {:016x}", hasher.finish())
            }
            OpenMp::Gomp => "gomp".into(),
            OpenMp::Vcomp => "vcomp".into(),
        }
    }
}

fn is_off(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "off" | "false" | "no")
}

fn choose_openmp(manifest: &Path, target_os: &str, target_env: &str, request: &str) -> OpenMp {
    if is_off(request) {
        return OpenMp::None;
    }
    match target_os {
        "macos" => {
            let root = manifest.join("vendor/libomp/macos");
            let include = root.join("include");
            let lib_dir = root.join("lib");
            if include.join("omp.h").is_file() && lib_dir.join("libomp.a").is_file() {
                OpenMp::LlvmStatic { include, lib_dir }
            } else {
                OpenMp::None
            }
        }
        "linux" if request.eq_ignore_ascii_case("gomp") => OpenMp::Gomp,
        "windows" if target_env == "msvc" && request.eq_ignore_ascii_case("vcomp") => OpenMp::Vcomp,
        _ => OpenMp::None,
    }
}

fn link_cpp_stdlib(target_os: &str, msvc: bool) {
    if msvc {
        return;
    }
    match target_os {
        "macos" => println!("cargo:rustc-link-lib=c++"),
        _ => println!("cargo:rustc-link-lib=stdc++"),
    }
}

// The translation units of LibRaw's own library target (Makefile.am
// `lib_libraw_a_SOURCES`), listed in native/libraw-sources.txt.
fn libraw_sources(list: &Path, root: &Path) -> Vec<PathBuf> {
    let Ok(list) = fs::read_to_string(list) else { return Vec::new() };
    list.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| root.join(line))
        .filter(|path| path.is_file())
        .collect()
}

fn files_with_extension(dir: &Path, extension: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == extension))
        .collect();
    files.sort();
    files
}

fn c_files(dir: &Path) -> Vec<PathBuf> {
    files_with_extension(dir, "c")
}

fn header_files(dir: &Path) -> Vec<PathBuf> {
    files_with_extension(dir, "h")
}
