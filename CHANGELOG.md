# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Fixed H3 reference ordering: the seam/start frame is now `<Picture 1>` and the source
  portrait `<Picture 2>` with an explicit identity-only prompt rule, so a chained shot no
  longer jumps to the portrait at frame 0. The seam frame is also conformed as an exact
  frame-0 keyframe in reference mode.
- Added an automatic location/camera lock for identity-locked chained shots: the compiled
  prompt now pins the seam frame's environment, lighting and camera position for the
  entire shot and forbids the portrait's background, so the scene cannot change mid-shot.
- Chained `r2v` shots now also receive a 1.5s tail clip of the previous shot as a
  `<Video N>` reference, so H3 conditions on the camera and location near the cut — not on
  the full clip, whose opening image may be the source portrait and cause a snap-back.
  One of the three video slots is reserved for that continuity clip.
- Seam conform writes the exact previous final frame as frame 0 and dissolves into the
  **moving** generated footage over 10 frames. A single frame-0 swap jumped at frame 1
  (17.9 dB PSNR); the earlier frozen hold removed the jump but made the cut appear to
  stop. The moving dissolve keeps frame 0 exact without a still freeze.

### Added

- Source-character lock: bind one portrait at project or shot level, carry it into
  Qwen stills and into H3 as an identity-only reference behind the seam frame.
  Existing `<Picture N>` tags are renumbered automatically.
- Character-lock pickers in the shot inspector, Stills boards and Library, plus a 🔒
  timeline badge and a regression harness for identity ordering.
- Public documentation set: installation, architecture, workflows, API, verification
  and troubleshooting.
- Clean UI screenshots and a contributor guide.
- Windows launchers now resolve their own location instead of hard-coding paths, and
  the Chrome profile is configurable through `-ChromeProfile` / `H3_CHROME_PROFILE`.

## [0.1.0] - 2026-10-05

### Added

- H3 Director Studio: React timeline editor, Library, Gallery, Stills board, export
  and AI co-director over any OpenAI-compatible endpoint.
- Headless ComfyUI render engine integration with two-stage Qwen still + H3 video
  pipeline, content-hashed media staging and exact seam conforming via ffmpeg.
- Durable per-job JSONL logs and saved compiled graphs for diagnosability.
- Regression harnesses for store safety and real-browser timeline geometry.

### Changed

- One shared source of truth for the 0.5-15 second shot duration limits.
- Project saves are debounced and flushed before rendering, export, project switch or
  tab close.
- Renders re-read the current project before every take write, so edits made during a
  render are no longer rolled back.

### Fixed

- Project writes are atomic with a `.bak` generation; corruption is reported instead
  of silently hiding a project.
- Export picks the newest accepted take instead of the oldest successful one.
- Timeline multi-select, insert-at-position, playhead and keyboard actions.
- Drag-reorder in a narrow viewport keeps the moved tile in view.
- Reorder verification harness no longer permutes real project data.
- Images dragged from Explorer attach to the hovered shot instead of always going to
  the Library.
