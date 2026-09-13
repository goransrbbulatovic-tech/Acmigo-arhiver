# AcMigo Arhiver

Brz i stabilan arhiver za **macOS**. Jezgro je u **C++** (libarchive), UI u **Electron**-u.
Native operacije rade u zasebnoj niti (`worker_threads`), pa se interfejs ne blokira ni na
ogromnim arhivama (100 GB+ radi jer se sve obrađuje **streaming**-om, bez učitavanja u memoriju).

## Šta radi

- **Čita/lista** na klik: zip, 7z, tar(.gz/.bz2/.xz/.zst), iso (ISO9660), rar, cab, lha, ar, cpio, xar, jar/war…
- **Raspakuje**: sve / izabrano / „ovdje" (pored arhive) / u folder po izboru — sa progresom i **Otkaži**.
- **Pravi** nove arhive (zip; podržani i 7z/tar/tar.gz u jezgru).
- **Mijenja unutrašnjost** zip-a: dodavanje i brisanje fajlova pa **Sačuvaj izmjene**.
- Registruje se kao **ponuđeni** otvarač („Otvori pomoću…") za poznate formate —
  **ne dira** tvoj postojeći default arhiver.

## Iskreno o granicama (da ne bude iznenađenja)

- **RAR**: samo čitanje/raspakivanje. Pravljenje RAR-a nije moguće legalno bez WinRAR SDK-a — to nijedan alat ne radi.
- **ISO** radi. **MDF** (Alcohol 120%) libarchive ne čita direktno; može se dodati kasnije preko `mdf2iso` konverzije.
- „Izmjena u mjestu" u zip formatu tehnički ne postoji — kod svake izmjene se radi **streaming prepis**
  u novi fajl pa zamjena originala. Za 100 GB arhivu to znači jedan prolaz kroz disk (nema učitavanja u RAM).
- **Bez upozorenja na tuđim Mac-ovima** zahtijeva Apple Developer nalog (99 $/god) za potpis + notarizaciju.
  Bez toga se build i dalje pravi, ali korisnik prvi put mora `desktop → Otvori` (desni klik → Otvori). Vidi dole.

## Lokalno pokretanje (za razvoj)

```bash
brew install cmake pkg-config libarchive
npm install
npm start          # kompajlira native modul i pokrene app
```

## Build na GitHub-u (dobiješ gotov .dmg)

1. Napravi repo i push-uj ovaj folder.
2. Push-uj tag da krene build:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   (ili pokreni ručno: Actions → **build-mac** → Run workflow)
3. Kad završi: Actions → run → **Artifacts** → skini
   `AcMigo-Arhiver-arm64` (Apple Silicon) i/ili `AcMigo-Arhiver-x64` (Intel).
4. Otvori `.dmg`, prevuci u Applications. Gotovo.

Workflow (`.github/workflows/build.yml`) sam skida i **statički** kompajlira libarchive (vcpkg),
gradi native modul za tačan Electron ABI i pravi DMG. Ništa ne diraš ručno.

## Potpis i notarizacija (opciono, kad budeš imao Apple nalog)

Postavi GitHub **Secrets** (Settings → Secrets and variables → Actions):

| Secret | Šta je |
|---|---|
| `MAC_CSC_LINK` | base64 tvog `Developer ID Application` .p12 certifikata |
| `MAC_CSC_KEY_PASSWORD` | lozinka tog .p12 |
| `APPLE_API_KEY_BASE64` | base64 App Store Connect API ključa (`AuthKey_XXXX.p8`) |
| `APPLE_API_KEY_ID` | ID tog ključa |
| `APPLE_API_ISSUER` | Issuer ID |

Zatim u `electron-builder.yml` postavi:
```yaml
mac:
  notarize: true
```
Workflow već automatski aktivira potpis/notarizaciju kad tajne postoje. Nakon toga se DMG
otvara **bez ijednog upozorenja** na svakom Mac-u.

## Struktura

```
native/src/archive_addon.cpp   # C++ jezgro (libarchive): list/extract/create/rewrite
CMakeLists.txt                 # build native modula (cmake-js)
src/main/                      # Electron main + preload
src/worker/                    # nit koja poziva native modul
src/renderer/                  # UI (HTML/CSS/JS)
electron-builder.yml           # pakovanje u DMG + file asocijacije
.github/workflows/build.yml    # CI: vcpkg + native build + DMG
```

## Napomene

- Ako prvi CI build padne na linkovanju native modula, skoro uvijek je riječ o nekoj
  tranzitivnoj biblioteci — dopiši je u `target_link_libraries` u `CMakeLists.txt`.
- Ikonu dodaj kao `build/icon.icns` (512×512). Bez nje ide default Electron ikona.
