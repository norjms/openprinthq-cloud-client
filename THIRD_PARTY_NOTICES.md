# Third-party components

The desktop installers bundle these programs as separate executables beside the app (Tauri sidecars).
Each keeps its own licence. They are fetched at build time by the scripts named below; none of them is
in this repository.

| Component | Platforms | Source | Licence |
|---|---|---|---|
| Node.js v22.11.0 | all desktop installers | nodejs.org official binaries (`scripts/fetch-node.sh`, `scripts/fetch-node.ps1`) | MIT, with the bundled dependency licences listed in Node's own `LICENSE` |
| go2rtc 1.9.9 | all desktop installers | [AlexxIT/go2rtc](https://github.com/AlexxIT/go2rtc) releases (`scripts/fetch-camera-tools.sh`, `.ps1`) | MIT |
| FFmpeg 7.1.1, static, arm64 | macOS (Apple silicon slice) | [OSXExperts](https://www.osxexperts.net) build `ffmpeg711arm.zip` | GPL-2.0-or-later (built with `--enable-gpl`) |
| FFmpeg 8.0, static, x86_64 | macOS (Intel slice) | evermeet.cx's build (tessus), as republished in the [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) release [b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1), asset `ffmpeg-darwin-x64.gz`, SHA-256 `929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106`, checked at fetch time | GPL-3.0-or-later (built with `--enable-gpl --enable-version3`) |
| FFmpeg, static | Linux (amd64, arm64) | [John Van Sickle's](https://johnvansickle.com/ffmpeg/) release builds | GPL-3.0-or-later |
| FFmpeg, static | Windows (x64) | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) | GPL (the `gpl` build variant) |

The connector image (`agent/Dockerfile`) installs FFmpeg from Alpine's packages instead.

## FFmpeg

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project. The binaries above are
unmodified builds by the parties named; the app runs them as separate programs (go2rtc calls FFmpeg to
turn a printer's H.264 camera stream into JPEG frames) and does not link to them. Source for each FFmpeg
release is at [ffmpeg.org/download.html](https://ffmpeg.org/download.html) and
[github.com/FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg); the external libraries in each build and
their versions are listed by its builder (for the macOS x86_64 build, in `darwin-x64.README` of the
ffmpeg-static release above).

Why the macOS x86_64 source changed in 0.0.24: evermeet.cx, which the Intel build used to fetch from
directly, now answers 410 Gone. The ffmpeg-static release holds the same builder's FFmpeg 8.0 under a
fixed release tag, so the file cannot change under the build without the checksum check failing.

## Credits

The camera relay design follows OctoEverywhere by Quinn Damerell
([OctoPrint-OctoEverywhere](https://github.com/QuinnDamerell/OctoPrint-OctoEverywhere), AGPL-3.0).
