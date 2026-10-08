// C ABI over LibRaw for the desktop decode command (#264 part C).
//
// The decode is the one libraw-wasm runs for rawFileLoader.js: the same
// LibRaw release and the same parameters, set on the object before
// open_buffer(), then unpack() -> dcraw_process(), and the processed image
// that dcraw_make_mem_image() would return, written straight into the RGBA16
// plane the page uses (NcLibRaw::pack_rgba16).
// Every entry point catches C++ exceptions: none may unwind into Rust.
#include "libraw/libraw.h"

#include <atomic>
#include <climits>
#include <cstdint>
#include <cstring>
#include <new>
#include <utility>

#if defined(_OPENMP)
#include <omp.h>
#endif

// nc_raw_pack_rgba16() refuses a layout the page would not accept either
// (it then decodes with libraw-wasm) or a plane of the wrong size.
enum
{
  NC_RAW_BAD_LAYOUT = -200001,
  NC_RAW_BAD_PLANE = -200002
};

class NcLibRaw : public LibRaw
{
public:
  NcLibRaw() : LibRaw(LIBRAW_OPTIONS_NONE) {}

  // What dcraw_make_mem_image() returns (copy_mem_image(scan0, stride, 0):
  // the output curve from the histogram, the orientation, the samples),
  // written as the page's post-decode pass packs libraw-wasm's result:
  // RGBA16, alpha 65535 after RGB, a grey sample replicated to RGB, a fourth
  // colour kept, 8-bit samples times 257. `out` holds width*height*4 samples
  // of get_mem_image_format()'s size. Rows run on `threads` OpenMP threads
  // and are skipped once `cancelled` is set. The part above the pixel loop
  // is copy_mem_image()'s own code (src/postprocessing/mem_image.cpp, LibRaw
  // 0.22.1); the parity tests hold the result to dcraw_make_mem_image() for
  // every orientation and both output depths.
  int pack_rgba16(uint16_t *out, size_t samples, int threads, const std::atomic<int> &cancelled)
  {
    if ((imgdata.progress_flags & LIBRAW_PROGRESS_THUMB_MASK) < LIBRAW_PROGRESS_PRE_INTERPOLATE || !imgdata.image)
      return LIBRAW_OUT_OF_ORDER_CALL;
    libraw_image_sizes_t &S = imgdata.sizes;
    const libraw_output_params_t &O = imgdata.params;
    const int colors = imgdata.idata.colors;
    if (!(colors == 1 || colors == 3 || colors == 4) || !(O.output_bps == 8 || O.output_bps == 16))
      return NC_RAW_BAD_LAYOUT;
    if (libraw_internal_data.output_data.histogram)
    {
      int perc, val, total, t_white = 0x2000, c;
      perc = int(S.width * S.height * O.auto_bright_thr);
      if (libraw_internal_data.internal_output_params.fuji_width)
        perc /= 2;
      if (!((O.highlight & ~2) || O.no_auto_bright))
        for (t_white = c = 0; c < colors; c++)
        {
          for (val = 0x2000, total = 0; --val > 32;)
            if ((total += libraw_internal_data.output_data.histogram[c][val]) > perc)
              break;
          if (t_white < val)
            t_white = val;
        }
      gamma_curve(O.gamm[0], O.gamm[1], 2, int((t_white << 3) / O.bright));
    }
    const int s_iheight = S.iheight, s_iwidth = S.iwidth, s_width = S.width, s_height = S.height;
    S.iheight = S.height;
    S.iwidth = S.width;
    if (S.flip & 4)
      std::swap(S.height, S.width);
    const int width = S.width, height = S.height;
    const int soff0 = flip_index(0, 0);
    const int cstep = flip_index(0, 1) - soff0;
    const int rstep = flip_index(1, 0) - flip_index(0, S.width);
    S.iheight = s_iheight;
    S.iwidth = s_iwidth;
    S.width = s_width;
    S.height = s_height;
    if (width <= 0 || height <= 0 || size_t(width) * size_t(height) > size_t(INT_MAX))
      return NC_RAW_BAD_LAYOUT;
    if (!out || samples != size_t(width) * size_t(height) * 4)
      return NC_RAW_BAD_PLANE;
    // copy_mem_image() walks the image with soff += cstep per pixel and
    // soff += rstep per row; each row's start follows from that directly.
    const long long row_step = (long long)width * cstep + rstep;
    const bool eight = O.output_bps == 8;
    const ushort *curve = imgdata.color.curve;
    const ushort(*image)[4] = imgdata.image;
#if defined(_OPENMP)
    const int team = threads > 0 ? threads : omp_get_num_procs();
#pragma omp parallel for schedule(static) num_threads(team)
#else
    (void)threads;
#endif
    for (int row = 0; row < height; row++)
    {
      if (cancelled.load(std::memory_order_relaxed))
        continue;
      int soff = int(soff0 + row * row_step);
      uint16_t *dst = out + size_t(row) * size_t(width) * 4;
      for (int col = 0; col < width; col++, soff += cstep, dst += 4)
      {
        const ushort *pixel = image[soff];
        uint16_t v[4] = {0, 0, 0, 0xffff};
        for (int c = 0; c < colors; c++)
          v[c] = eight ? uint16_t((curve[pixel[c]] >> 8) * 257) : curve[pixel[c]];
        if (colors == 1)
          v[1] = v[2] = v[0];
        dst[0] = v[0];
        dst[1] = v[1];
        dst[2] = v[2];
        dst[3] = v[3];
      }
    }
    return cancelled.load(std::memory_order_relaxed) ? LIBRAW_CANCELLED_BY_CALLBACK : LIBRAW_SUCCESS;
  }
};

struct nc_raw
{
  NcLibRaw processor;
  std::atomic<int> cancelled;
  nc_raw() : cancelled(0) {}
};

extern "C"
{

  // The options rawFileLoader.js passes to libraw-wasm's open(). Everything
  // else keeps LibRaw's defaults, as libraw-wasm's applySettings() does.
  struct nc_raw_options
  {
    int half_size;  // halfSize
    int output_bps; // outputBps (8 or 16)
  };

  // What libraw-wasm's metadata(true) reports and the loader reads:
  // the oriented size, camera and lens fields (see rawFileLoader.js
  // extractRawLensMetadata). Sizes follow LibRaw's own field widths.
  struct nc_raw_meta
  {
    unsigned width, height, raw_width, raw_height, top_margin, left_margin;
    int flip;
    char make[64], model[64];
    float iso_speed, shutter, aperture, focal_len;
    double timestamp;
    unsigned shot_order;
    char desc[512], artist[64];
    float gps_latitude[3], gps_longitude[3], gps_altitude;
    char gps_latref, gps_longref, gps_altref, gps_status, gps_parsed;
    unsigned thumb_width, thumb_height;
    int thumb_format;
    char lens[128], lens_make[128], lens_serial[128], internal_lens_serial[128];
    float lens_min_focal, lens_max_focal, lens_max_ap4_min_focal, lens_max_ap4_max_focal, lens_exif_max_ap;
    int lens_focal_35mm;
    char mk_lens[128];
    double mk_lens_id;
    float mk_min_focal, mk_max_focal, mk_max_ap, mk_min_ap, mk_cur_focal, mk_cur_ap, mk_focal_35mm,
        mk_min_focus_distance;
    int mk_lens_mount, mk_camera_mount;
    char mk_body[64];
    unsigned process_warnings;
  };

  // dcraw_make_mem_image()'s result without LibRaw's struct layout (the
  // parity tests' reference path).
  struct nc_raw_image
  {
    int width, height, colors, bits;
    size_t size;
    const unsigned char *data;
    void *handle;
  };

  static int nc_progress(void *data, enum LibRaw_progress, int, int)
  {
    return static_cast<nc_raw *>(data)->cancelled.load(std::memory_order_relaxed) ? 1 : 0;
  }

  nc_raw *nc_raw_new(void)
  {
    try
    {
      nc_raw *raw = new nc_raw();
      raw->processor.set_progress_handler(nc_progress, raw);
      return raw;
    }
    catch (...)
    {
      return nullptr;
    }
  }

  void nc_raw_free(nc_raw *raw)
  {
    try
    {
      delete raw;
    }
    catch (...)
    {
    }
  }

  // `data` must stay valid until nc_raw_release_input() or nc_raw_free():
  // LibRaw reads the buffer in place (libraw-wasm keeps its copy alive the
  // same way).
  int nc_raw_open(nc_raw *raw, const unsigned char *data, size_t size, const nc_raw_options *options)
  {
    try
    {
      raw->processor.recycle();
      libraw_output_params_t &params = raw->processor.imgdata.params;
      params.no_interpolation = 0;
      params.use_auto_wb = 1;
      params.use_camera_wb = 1;
      params.use_camera_matrix = 3;
      params.output_color = 1;
      params.output_bps = options->output_bps == 8 ? 8 : 16;
      params.half_size = options->half_size ? 1 : 0;
      return raw->processor.open_buffer(data, size);
    }
    catch (...)
    {
      return LIBRAW_UNSPECIFIED_ERROR;
    }
  }

  static void copy_text(char *dst, size_t dst_size, const char *src, size_t src_size)
  {
    size_t n = 0;
    while (n < src_size && n + 1 < dst_size && src[n])
    {
      dst[n] = src[n];
      n++;
    }
    dst[n] = 0;
  }
#define NC_COPY_TEXT(dst, src) copy_text(dst, sizeof(dst), src, sizeof(src))

  int nc_raw_metadata(nc_raw *raw, nc_raw_meta *out)
  {
    try
    {
      std::memset(out, 0, sizeof(*out));
      const libraw_data_t &d = raw->processor.imgdata;
      unsigned width = d.sizes.width, height = d.sizes.height;
      int flip = d.sizes.flip;
      if (flip == 5 || flip == 6 || flip == 7)
      {
        unsigned swap = width;
        width = height;
        height = swap;
      }
      out->width = width;
      out->height = height;
      out->raw_width = d.sizes.raw_width;
      out->raw_height = d.sizes.raw_height;
      out->top_margin = d.sizes.top_margin;
      out->left_margin = d.sizes.left_margin;
      out->flip = flip;
      NC_COPY_TEXT(out->make, d.idata.make);
      NC_COPY_TEXT(out->model, d.idata.model);
      out->iso_speed = d.other.iso_speed;
      out->shutter = d.other.shutter;
      out->aperture = d.other.aperture;
      out->focal_len = d.other.focal_len;
      out->timestamp = double(d.other.timestamp);
      out->shot_order = d.other.shot_order;
      NC_COPY_TEXT(out->desc, d.other.desc);
      NC_COPY_TEXT(out->artist, d.other.artist);
      for (int i = 0; i < 3; i++)
      {
        out->gps_latitude[i] = d.other.parsed_gps.latitude[i];
        out->gps_longitude[i] = d.other.parsed_gps.longitude[i];
      }
      out->gps_altitude = d.other.parsed_gps.altitude;
      out->gps_latref = d.other.parsed_gps.latref;
      out->gps_longref = d.other.parsed_gps.longref;
      out->gps_altref = d.other.parsed_gps.altref;
      out->gps_status = d.other.parsed_gps.gpsstatus;
      out->gps_parsed = d.other.parsed_gps.gpsparsed;
      out->thumb_width = d.thumbnail.twidth;
      out->thumb_height = d.thumbnail.theight;
      out->thumb_format = int(d.thumbnail.tformat);
      const libraw_lensinfo_t &l = d.lens;
      NC_COPY_TEXT(out->lens, l.Lens);
      NC_COPY_TEXT(out->lens_make, l.LensMake);
      NC_COPY_TEXT(out->lens_serial, l.LensSerial);
      NC_COPY_TEXT(out->internal_lens_serial, l.InternalLensSerial);
      out->lens_min_focal = l.MinFocal;
      out->lens_max_focal = l.MaxFocal;
      out->lens_max_ap4_min_focal = l.MaxAp4MinFocal;
      out->lens_max_ap4_max_focal = l.MaxAp4MaxFocal;
      out->lens_exif_max_ap = l.EXIF_MaxAp;
      out->lens_focal_35mm = int(l.FocalLengthIn35mmFormat);
      const libraw_makernotes_lens_t &m = l.makernotes;
      NC_COPY_TEXT(out->mk_lens, m.Lens);
      out->mk_lens_id = double(m.LensID);
      out->mk_min_focal = m.MinFocal;
      out->mk_max_focal = m.MaxFocal;
      out->mk_max_ap = m.MaxAp;
      out->mk_min_ap = m.MinAp;
      out->mk_cur_focal = m.CurFocal;
      out->mk_cur_ap = m.CurAp;
      out->mk_focal_35mm = m.FocalLengthIn35mmFormat;
      out->mk_min_focus_distance = m.MinFocusDistance;
      out->mk_lens_mount = int(m.LensMount);
      out->mk_camera_mount = int(m.CameraMount);
      NC_COPY_TEXT(out->mk_body, m.body);
      out->process_warnings = d.process_warnings;
      return LIBRAW_SUCCESS;
    }
    catch (...)
    {
      return LIBRAW_UNSPECIFIED_ERROR;
    }
  }

  // unpack() and dcraw_process() on the calling thread. `threads` sets this
  // thread's OpenMP team size for the decode (0: every core).
  //
  // The thread count must not change the output. LibRaw's parallel
  // decoders, its Bayer raw copy and the AHD/PPG demosaics write disjoint
  // pixels; its X-Trans demosaic, X-Trans half-size copy and DHT (quality 11)
  // do not, so anything but a Bayer (or non-CFA) sensor, or DHT, develops on
  // one thread. libraw-wasm applies the same rule (docs/native-raw-decode.md).
  int nc_raw_process(nc_raw *raw, int threads)
  {
    try
    {
#if defined(_OPENMP)
      omp_set_num_threads(threads > 0 ? threads : omp_get_num_procs());
#else
      (void)threads;
#endif
      int ret = raw->processor.unpack();
      if (ret != LIBRAW_SUCCESS)
        return ret;
#if defined(_OPENMP)
      const unsigned filters = raw->processor.imgdata.idata.filters;
      const bool thread_safe_develop = (filters == 0 || filters >= 1000) && raw->processor.imgdata.params.user_qual != 11;
      if (!thread_safe_develop)
        omp_set_num_threads(1);
#endif
      return raw->processor.dcraw_process();
    }
    catch (...)
    {
      return LIBRAW_UNSPECIFIED_ERROR;
    }
  }

  // The processed image's size and sample layout, as dcraw_make_mem_image()
  // would return it.
  int nc_raw_image_format(nc_raw *raw, int *width, int *height, int *colors, int *bps)
  {
    try
    {
      raw->processor.get_mem_image_format(width, height, colors, bps);
      return LIBRAW_SUCCESS;
    }
    catch (...)
    {
      return LIBRAW_UNSPECIFIED_ERROR;
    }
  }

  // Closes LibRaw's view of the file bytes once dcraw_process() is done, so
  // the caller may free them before the plane is allocated. Nothing after
  // dcraw_process() reads the file.
  void nc_raw_release_input(nc_raw *raw)
  {
    try
    {
      raw->processor.recycle_datastream();
    }
    catch (...)
    {
    }
  }

  // Writes the processed image into `out`, the RGBA16 plane the page's
  // post-decode pass builds from libraw-wasm's result (width*height*8 bytes
  // for get_mem_image_format()'s size, native-endian samples, rows top to
  // bottom), on `threads` OpenMP threads (see NcLibRaw::pack_rgba16).
  // Returns LIBRAW_CANCELLED_BY_CALLBACK once the decode is cancelled.
  int nc_raw_pack_rgba16(nc_raw *raw, unsigned char *out, size_t out_size, int threads)
  {
    try
    {
      if (out_size % 8)
        return NC_RAW_BAD_PLANE;
      if (raw->cancelled.load(std::memory_order_relaxed))
        return LIBRAW_CANCELLED_BY_CALLBACK;
      return raw->processor.pack_rgba16(reinterpret_cast<uint16_t *>(out), out_size / 2, threads, raw->cancelled);
    }
    catch (...)
    {
      return LIBRAW_UNSPECIFIED_ERROR;
    }
  }

  int nc_raw_make_image(nc_raw *raw, nc_raw_image *out)
  {
    std::memset(out, 0, sizeof(*out));
    try
    {
      int err = 0;
      libraw_processed_image_t *image = raw->processor.dcraw_make_mem_image(&err);
      if (!image)
        return err != 0 ? err : LIBRAW_UNSPECIFIED_ERROR;
      out->width = image->width;
      out->height = image->height;
      out->colors = image->colors;
      out->bits = image->bits;
      out->size = image->data_size;
      out->data = image->data;
      out->handle = image;
      return LIBRAW_SUCCESS;
    }
    catch (...)
    {
      return LIBRAW_UNSPECIFIED_ERROR;
    }
  }

  void nc_raw_free_image(nc_raw_image *image)
  {
    if (image && image->handle)
      LibRaw::dcraw_clear_mem(static_cast<libraw_processed_image_t *>(image->handle));
    if (image)
      std::memset(image, 0, sizeof(*image));
  }

  // Test hook: the orientation copy_mem_image() applies (EXIF flip 0..7).
  void nc_raw_set_flip(nc_raw *raw, int flip) { raw->processor.imgdata.sizes.flip = flip; }

  // Releases LibRaw's buffers (the demosaic's image, the raw plane) early.
  void nc_raw_recycle(nc_raw *raw)
  {
    try
    {
      raw->processor.recycle();
    }
    catch (...)
    {
    }
  }

  // Safe from any thread while another thread decodes: the progress handler
  // stops dcraw_process() at its next stage or AHD band, LibRaw's cancel
  // flag stops the decoders at their next checkCancel(), and the plane
  // packing skips its remaining rows.
  void nc_raw_cancel(nc_raw *raw)
  {
    raw->cancelled.store(1, std::memory_order_relaxed);
    raw->processor.setCancelFlag();
  }

  const char *nc_raw_libraw_version(void) { return LibRaw::version(); }

  int nc_raw_openmp(void)
  {
#if defined(LIBRAW_USE_OPENMP)
    return 1;
#else
    return 0;
#endif
  }

  // Registers the calling thread with the OpenMP runtime. The statically
  // linked libomp shuts itself down when the last thread it knows exits,
  // which frees the lock behind LibRaw's `#pragma omp critical` while the
  // compiled code keeps pointing at it: the next decode on a new blocking
  // thread would crash. A thread that registers and never exits keeps the
  // runtime up (see native_raw.rs, openmp_anchor).
  void nc_raw_openmp_register(void)
  {
#if defined(_OPENMP)
    (void)omp_get_max_threads();
#endif
  }

  int nc_raw_max_threads(void)
  {
#if defined(_OPENMP)
    return omp_get_num_procs();
#else
    return 1;
#endif
  }

  const char *nc_raw_strerror(int code) { return libraw_strerror(code); }

} // extern "C"
