// AcMigo Arhiver - native engine (libarchive)
// Sve funkcije su SINHRONE i rade u worker niti (worker_threads),
// pa je blokiranje niti u redu. Napredak se javlja preko JS callback-a,
// a otkazivanje preko SharedArrayBuffer (Int32) zastavice.

#include <napi.h>
#include <archive.h>
#include <archive_entry.h>

#include <string>
#include <vector>
#include <set>
#include <cstdio>
#include <cstring>
#include <sys/stat.h>

namespace {

Napi::Error MakeError(Napi::Env env, const std::string &msg) {
  return Napi::Error::New(env, msg);
}

struct ProgressCtx {
  Napi::Function cb;
  bool has = false;
  volatile int32_t *cancelFlag = nullptr; // pokazivač u deljeni Int32 niz
  int64_t total = 0;
  int64_t processed = 0;
  int64_t lastReport = 0;
  int64_t reportEvery = 8 * 1024 * 1024; // javi napredak na svakih ~8 MB
};

// Vraća false ako je operacija otkazana.
bool report(Napi::Env env, ProgressCtx &p, const char *name) {
  if (p.cancelFlag && *p.cancelFlag != 0) return false;
  if (p.has && (p.processed - p.lastReport >= p.reportEvery || p.processed == p.total)) {
    p.lastReport = p.processed;
    p.cb.Call({Napi::Number::New(env, (double)p.processed),
               Napi::Number::New(env, (double)p.total),
               Napi::String::New(env, name ? name : "")});
  }
  return true;
}

ProgressCtx buildProgress(Napi::Env env, const Napi::Object &opts) {
  ProgressCtx p;
  if (opts.Has("onProgress") && opts.Get("onProgress").IsFunction()) {
    p.cb = opts.Get("onProgress").As<Napi::Function>();
    p.has = true;
  }
  if (opts.Has("total")) p.total = (int64_t)opts.Get("total").ToNumber().DoubleValue();
  if (opts.Has("cancel") && opts.Get("cancel").IsTypedArray()) {
    Napi::Int32Array ta = opts.Get("cancel").As<Napi::Int32Array>();
    p.cancelFlag = reinterpret_cast<volatile int32_t *>(ta.Data());
  }
  return p;
}

// --- list ------------------------------------------------------------------
Napi::Value List(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string path = info[0].As<Napi::String>();

  struct archive *a = archive_read_new();
  archive_read_support_filter_all(a);
  archive_read_support_format_all(a);

  if (archive_read_open_filename(a, path.c_str(), 1024 * 1024) != ARCHIVE_OK) {
    std::string e = archive_error_string(a) ? archive_error_string(a) : "nepoznata greška";
    archive_read_free(a);
    throw MakeError(env, "Ne mogu otvoriti arhivu: " + e);
  }

  Napi::Array arr = Napi::Array::New(env);
  uint32_t idx = 0;
  struct archive_entry *entry;
  int r;
  while ((r = archive_read_next_header(a, &entry)) == ARCHIVE_OK) {
    Napi::Object o = Napi::Object::New(env);
    const char *name = archive_entry_pathname(entry);
    o.Set("path", Napi::String::New(env, name ? name : ""));
    la_int64_t size = archive_entry_size_is_set(entry) ? archive_entry_size(entry) : 0;
    o.Set("size", Napi::Number::New(env, (double)size));
    mode_t ft = archive_entry_filetype(entry);
    o.Set("isDir", Napi::Boolean::New(env, ft == AE_IFDIR));
    o.Set("mtime", Napi::Number::New(env,
        (double)(archive_entry_mtime_is_set(entry) ? archive_entry_mtime(entry) : 0)));
    o.Set("mode", Napi::Number::New(env, (double)archive_entry_perm(entry)));
    arr.Set(idx++, o);
    archive_read_data_skip(a);
  }

  if (r != ARCHIVE_EOF) {
    std::string e = archive_error_string(a) ? archive_error_string(a) : "greška pri čitanju";
    archive_read_free(a);
    throw MakeError(env, "Greška pri čitanju arhive: " + e);
  }
  archive_read_free(a);
  return arr;
}

int copy_data_extract(struct archive *ar, struct archive *aw, Napi::Env env,
                      ProgressCtx &p, const char *name, bool &cancelled) {
  const void *buff;
  size_t size;
  la_int64_t offset;
  for (;;) {
    int r = archive_read_data_block(ar, &buff, &size, &offset);
    if (r == ARCHIVE_EOF) return ARCHIVE_OK;
    if (r < ARCHIVE_OK) return r;
    r = archive_write_data_block(aw, buff, size, offset);
    if (r < ARCHIVE_OK) return r;
    p.processed += (int64_t)size;
    if (!report(env, p, name)) { cancelled = true; return ARCHIVE_FATAL; }
  }
}

// --- extract ---------------------------------------------------------------
Napi::Value Extract(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string src = info[0].As<Napi::String>();
  std::string dest = info[1].As<Napi::String>();
  Napi::Object opts = info[2].As<Napi::Object>();

  std::set<std::string> only;
  bool hasOnly = false;
  if (opts.Has("entries") && opts.Get("entries").IsArray()) {
    Napi::Array e = opts.Get("entries").As<Napi::Array>();
    for (uint32_t i = 0; i < e.Length(); ++i)
      only.insert(std::string(e.Get(i).As<Napi::String>()));
    hasOnly = true;
  }
  bool overwrite = opts.Has("overwrite") ? opts.Get("overwrite").ToBoolean().Value() : true;
  ProgressCtx p = buildProgress(env, opts);

  struct archive *a = archive_read_new();
  archive_read_support_filter_all(a);
  archive_read_support_format_all(a);

  struct archive *ext = archive_write_disk_new();
  int flags = ARCHIVE_EXTRACT_TIME | ARCHIVE_EXTRACT_PERM | ARCHIVE_EXTRACT_ACL |
              ARCHIVE_EXTRACT_FFLAGS | ARCHIVE_EXTRACT_SECURE_NODOTDOT |
              ARCHIVE_EXTRACT_SECURE_SYMLINKS;
  if (!overwrite) flags |= ARCHIVE_EXTRACT_NO_OVERWRITE;
  archive_write_disk_set_options(ext, flags);
  archive_write_disk_set_standard_lookup(ext);

  if (archive_read_open_filename(a, src.c_str(), 1024 * 1024) != ARCHIVE_OK) {
    std::string e = archive_error_string(a) ? archive_error_string(a) : "open";
    archive_read_free(a);
    archive_write_free(ext);
    throw MakeError(env, "Ne mogu otvoriti arhivu: " + e);
  }

  std::string base = dest;
  if (!base.empty() && base.back() != '/') base += '/';

  int extracted = 0;
  bool cancelled = false;
  std::string firstErr;
  struct archive_entry *entry;
  int r;
  while ((r = archive_read_next_header(a, &entry)) == ARCHIVE_OK) {
    const char *cn = archive_entry_pathname(entry);
    std::string name = cn ? cn : "";
    if (hasOnly && only.find(name) == only.end()) {
      archive_read_data_skip(a);
      continue;
    }
    std::string outPath = base + name;
    archive_entry_set_pathname(entry, outPath.c_str());

    // Podesi i cilj hardlink-a ako postoji
    const char *hl = archive_entry_hardlink(entry);
    if (hl) {
      std::string hlp = base + hl;
      archive_entry_set_hardlink(entry, hlp.c_str());
    }

    r = archive_write_header(ext, entry);
    if (r >= ARCHIVE_WARN) {
      if (!archive_entry_size_is_set(entry) || archive_entry_size(entry) > 0) {
        r = copy_data_extract(a, ext, env, p, name.c_str(), cancelled);
        if (cancelled) break;
      }
      archive_write_finish_entry(ext);
      extracted++;
    } else if (firstErr.empty()) {
      const char *es = archive_error_string(ext);
      firstErr = std::string(outPath) + ": " + (es ? es : "ne mogu zapisati na disk");
    }
  }
  bool eof = (r == ARCHIVE_EOF);

  archive_read_close(a);
  archive_read_free(a);
  archive_write_close(ext);
  archive_write_free(ext);

  // Ako ništa nije raspakovano zbog greške pri pisanju — prijavi je jasno
  if (extracted == 0 && !cancelled && !firstErr.empty()) {
    throw MakeError(env, "Raspakivanje nije uspjelo (dozvole/odredište?):\n" + firstErr);
  }

  Napi::Object res = Napi::Object::New(env);
  res.Set("extracted", Napi::Number::New(env, extracted));
  res.Set("cancelled", Napi::Boolean::New(env, cancelled));
  res.Set("ok", Napi::Boolean::New(env, eof || cancelled));
  return res;
}

// --- create ----------------------------------------------------------------
void setupWriter(struct archive *a, const std::string &format, int level) {
  if (format == "7z") {
    archive_write_set_format_7zip(a);
  } else if (format == "tar.gz" || format == "tgz") {
    archive_write_set_format_pax_restricted(a);
    archive_write_add_filter_gzip(a);
  } else if (format == "tar") {
    archive_write_set_format_pax_restricted(a);
  } else { // zip (default)
    archive_write_set_format_zip(a);
    std::string comp = "zip:compression=" + std::string(level == 0 ? "store" : "deflate");
    archive_write_set_options(a, comp.c_str());
    if (level > 0) {
      std::string lv = "zip:compression-level=" + std::to_string(level);
      archive_write_set_options(a, lv.c_str());
    }
  }
}

bool writeFileEntry(struct archive *a, const std::string &source, const std::string &name,
                    Napi::Env env, ProgressCtx &p) {
  struct stat st;
  if (stat(source.c_str(), &st) != 0) return true; // preskoči nedostupno
  struct archive_entry *entry = archive_entry_new();
  archive_entry_set_pathname(entry, name.c_str());
  archive_entry_copy_stat(entry, &st);

  bool cancelled = false;
  if (archive_write_header(a, entry) == ARCHIVE_OK && S_ISREG(st.st_mode)) {
    FILE *f = fopen(source.c_str(), "rb");
    if (f) {
      static thread_local char buff[256 * 1024];
      size_t n;
      while ((n = fread(buff, 1, sizeof(buff), f)) > 0) {
        archive_write_data(a, buff, n);
        p.processed += (int64_t)n;
        if (!report(env, p, name.c_str())) { cancelled = true; break; }
      }
      fclose(f);
    }
  }
  archive_entry_free(entry);
  return !cancelled;
}

Napi::Value Create(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string out = info[0].As<Napi::String>();
  Napi::Array inputs = info[1].As<Napi::Array>();
  Napi::Object opts = info[2].As<Napi::Object>();

  std::string format = opts.Has("format") ? std::string(opts.Get("format").As<Napi::String>()) : "zip";
  int level = opts.Has("level") ? opts.Get("level").ToNumber().Int32Value() : 6;
  ProgressCtx p = buildProgress(env, opts);

  struct archive *a = archive_write_new();
  setupWriter(a, format, level);
  if (archive_write_open_filename(a, out.c_str()) != ARCHIVE_OK) {
    std::string e = archive_error_string(a) ? archive_error_string(a) : "open";
    archive_write_free(a);
    throw MakeError(env, "Ne mogu kreirati arhivu: " + e);
  }

  bool cancelled = false;
  for (uint32_t i = 0; i < inputs.Length(); ++i) {
    Napi::Object it = inputs.Get(i).As<Napi::Object>();
    std::string source = it.Get("source").As<Napi::String>();
    std::string name = it.Get("name").As<Napi::String>();
    if (!writeFileEntry(a, source, name, env, p)) { cancelled = true; break; }
  }

  archive_write_close(a);
  archive_write_free(a);

  Napi::Object res = Napi::Object::New(env);
  res.Set("cancelled", Napi::Boolean::New(env, cancelled));
  res.Set("ok", Napi::Boolean::New(env, true));
  return res;
}

// --- rewrite (izmjena unutrašnjosti: briši + dodaj) -------------------------
// libarchive nema izmjenu "u mjestu", pa se radi streaming prepis:
// kopira sve stavke koje ostaju (preskačući 'exclude'), pa dodaje nove.
// Radi i za arhive od 100 GB+ jer se ne učitava u memoriju.
Napi::Value Rewrite(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string src = info[0].As<Napi::String>();
  std::string out = info[1].As<Napi::String>();
  Napi::Object opts = info[2].As<Napi::Object>();

  std::set<std::string> exclude;
  if (opts.Has("exclude") && opts.Get("exclude").IsArray()) {
    Napi::Array e = opts.Get("exclude").As<Napi::Array>();
    for (uint32_t i = 0; i < e.Length(); ++i)
      exclude.insert(std::string(e.Get(i).As<Napi::String>()));
  }
  int level = opts.Has("level") ? opts.Get("level").ToNumber().Int32Value() : 6;
  ProgressCtx p = buildProgress(env, opts);

  struct archive *in = archive_read_new();
  archive_read_support_filter_all(in);
  archive_read_support_format_all(in);
  if (archive_read_open_filename(in, src.c_str(), 1024 * 1024) != ARCHIVE_OK) {
    std::string e = archive_error_string(in) ? archive_error_string(in) : "open";
    archive_read_free(in);
    throw MakeError(env, "Ne mogu otvoriti arhivu: " + e);
  }

  struct archive *a = archive_write_new();
  setupWriter(a, "zip", level);
  if (archive_write_open_filename(a, out.c_str()) != ARCHIVE_OK) {
    std::string e = archive_error_string(a) ? archive_error_string(a) : "open";
    archive_read_free(in);
    archive_write_free(a);
    throw MakeError(env, "Ne mogu kreirati arhivu: " + e);
  }

  bool cancelled = false;
  struct archive_entry *entry;
  int r;
  while ((r = archive_read_next_header(in, &entry)) == ARCHIVE_OK) {
    const char *cn = archive_entry_pathname(entry);
    std::string name = cn ? cn : "";
    if (exclude.count(name)) {
      archive_read_data_skip(in);
      continue;
    }
    if (archive_write_header(a, entry) == ARCHIVE_OK) {
      const void *buff;
      size_t size;
      la_int64_t offset;
      for (;;) {
        int rr = archive_read_data_block(in, &buff, &size, &offset);
        if (rr == ARCHIVE_EOF) break;
        if (rr < ARCHIVE_OK) break;
        archive_write_data_block(a, buff, size, offset);
        p.processed += (int64_t)size;
        if (!report(env, p, name.c_str())) { cancelled = true; break; }
      }
    } else {
      archive_read_data_skip(in);
    }
    if (cancelled) break;
  }

  if (!cancelled && opts.Has("add") && opts.Get("add").IsArray()) {
    Napi::Array add = opts.Get("add").As<Napi::Array>();
    for (uint32_t i = 0; i < add.Length(); ++i) {
      Napi::Object it = add.Get(i).As<Napi::Object>();
      std::string source = it.Get("source").As<Napi::String>();
      std::string name = it.Get("name").As<Napi::String>();
      if (!writeFileEntry(a, source, name, env, p)) { cancelled = true; break; }
    }
  }

  archive_read_close(in);
  archive_read_free(in);
  archive_write_close(a);
  archive_write_free(a);

  Napi::Object res = Napi::Object::New(env);
  res.Set("cancelled", Napi::Boolean::New(env, cancelled));
  res.Set("ok", Napi::Boolean::New(env, true));
  return res;
}

Napi::Value Version(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), archive_version_details());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("list", Napi::Function::New(env, List));
  exports.Set("extract", Napi::Function::New(env, Extract));
  exports.Set("create", Napi::Function::New(env, Create));
  exports.Set("rewrite", Napi::Function::New(env, Rewrite));
  exports.Set("version", Napi::Function::New(env, Version));
  return exports;
}

} // namespace

NODE_API_MODULE(archive_addon, Init)
