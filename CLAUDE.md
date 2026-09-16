# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"심판 · 침범 카운터" is a Korean-language, zero-dependency static web app for a referee at an SKKU
Automation LAB driving contest. Two cars (차량 A, 차량 B) run at once; each is assigned a driving-order
number (주행 순서 n번), and the referee counts per-order "intrusions" (침범) with one key per car
(left Shift = A, right Shift = B), hears a per-car Korean voice clip followed by the spoken team name,
and exports a CSV. Every match is either 일반주행 (regular) or 토너먼트 (tournament), chosen at setup;
results are archived and exported per mode. The source lives in `심판/` (extracted from `심판.zip`
at the repo root; the zip is the original upload, the folder is the working copy). All user-facing
text, the README, and the CSV headers are Korean and should stay Korean.

## Commands

There is no build step, package manager, test suite, or linter. Vanilla HTML/CSS/JS, Python stdlib only.

- Run locally: open `심판/index.html` directly in a browser (works from `file://`).
- Deploy (production): the public app is **https://judge-skku.p-e.kr**, served by GitHub Pages from
  the public repo `devkev00/judge-skku`. This directory is its git checkout; remote `origin` is the
  SSH URL `git@github.com:devkev00/judge-skku.git`. `.github/workflows/pages.yml` uploads `심판/`
  as-is on every push to `main`, live in about a minute; verify with `gh run list --limit 1` and a
  `curl` of the domain. Push over SSH only: the `gh` OAuth token lacks the `workflow` scope, so an
  HTTPS push of any commit touching the workflow file is rejected. The domain is a free
  내도메인.한국 subdomain whose only record is a CNAME to `devkev00.github.io`; GitHub provisions the
  certificate and HTTPS is enforced (`gh api repos/devkev00/judge-skku/pages` shows the state).
  Pages serves every file in `심판/` (README.md and share_server.py included), and `.nojekyll`
  there keeps GitHub from processing anything.
- Backup share (old path, still enabled): `cd 심판 && python3 share_server.py --port 8766`
  (loopback only, allowlisted files, Python ≥ 3.9 for `Path.is_relative_to`) plus a Cloudflare Quick
  Tunnel (`~/.local/bin/cloudflared`) run as systemd user services `referee-share-server` /
  `referee-share-tunnel` (linger enabled, restart on failure). `bash 심판/share_status.sh` prints
  their state and the current `trycloudflare.com` URL, which changes on every tunnel restart or
  reboot; if that URL is handed out, put it in the README's 예비 subsection. Restarting only the
  server unit keeps the URL (the tunnel unit uses `Wants=`, not `Requires=`); never restart the
  tunnel unit casually. The server reads `심판/` live. Do not query a freshly issued tunnel hostname
  through the local resolver until public DNS has it (check via dns.google/resolve or
  `curl --resolve`): the campus DNS caches the negative answer for minutes. Every "server is down"
  report so far was a stale URL in someone's hands; compare the README with `share_status.sh --url`
  before touching the units.
- The system `node` is v12 and cannot parse `?.` / `??`, so `node --check` is useless here. Verify in
  a browser instead. Headless Chrome is installed: serve a copy of the folder with
  `python3 -m http.server`, drive `index.html` from a harness page in an iframe, and use
  `google-chrome --headless=new --dump-dom` / `--screenshot` to read results.
- To start from a clean state, clear the localStorage keys `referee.matches.v3`,
  `referee.matches.v2` and `referee.infringement.v1` in DevTools.

## Architecture

### Script load order and module boundary
`index.html` loads `csv.js` then `app.js`, both `defer`. `csv.js` publishes a frozen
`window.RefereeCsv = { build, filename, download }` and nothing else; `app.js` is an IIFE that owns all
state and DOM wiring and is the only consumer. Keep that order and that single global.

### State model (app.js)
- `match` is the source of truth:
  `{ mode, teamCount, startedAt, endedAt, status, teamNames: string[], events: [{ team, at, car, manual? }] }`.
  `mode` is `"regular"` or `"tournament"` (`MODES` maps them to 일반주행/토너먼트), fixed at setup.
  `team` is the driving order (1..teamCount), `car` is `"A"`, `"B"`, or `null`; `manual: true` marks
  a correction made from the list screen. `teamNames` always has `teamCount` entries after
  `normalizeNames` (blank = no name; older v3 blobs without the field load fine). Per-order totals
  are always derived via `totalsOf(m)`; never store counts. `teamLabel(order)` renders
  "n번 · name" / "n번" / "빈 자리" and is the single place that formats an order for humans.
- `results = { regular: match|null, tournament: match[] }` is the archive. Regular keeps one snapshot;
  tournament keeps one per round, keyed by `teamCount` and sorted descending (10강 → 5강 → 3강 → 결승),
  via `archiveRound()`. `roundLabel(n)` names a round purely by team count: 1 → 우승, 2 → 결승, else
  `n강` (the user's model: 10 teams = 10강, winners = 5강); `modeLabel(m)` is "토너먼트 · 10강". `save()` calls `syncResults()` first (the load
  path too), so the archive always tracks the current finished match.
- The result view is `resultTab` (mode) + `resultRound` (tournament teamCount), resolved by
  `activeResult()`: the live `match` when it is the finished match for that tab/round — so list-screen
  corrections show immediately — else the archived snapshot, which is read-only (판정으로 돌아가기 and
  목록에서 정정 hide). `ensureRound()` repairs `resultRound` before every render. Regular renders the
  plain table; tournament renders `renderBracket()` pair cards (two driving orders per card, matching
  the A/B run pair) marking "침범 적음"/"침범 동률" as facts.
- Tournament progression: `match.winners` holds one advancing driving order (or `null`) per pair,
  normalized by `normalizeWinners()`; a bye (odd team count) is filled automatically. `suggestWinners()`
  runs on 결과 보기 and fills only the still-null pairs with the lower-intrusion team, leaving ties for
  the referee — intrusions alone never decide a winner, the referee's 진출로 buttons do. The 다음 라운드
  panel unlocks when every pair is decided and `#next-round-button` starts a fresh tournament match
  containing only the winners (orders renumbered 1..k, names carried over, `round` + 1); the finished
  round stays archived. One winner left (i.e. after 결승) shows `#champion` instead. Winner picking is
  offered only while the shown round is the live `match`; archived rounds render static
  진출/탈락/부전승 badges. The download button exports the active round; `#download-all` exports every
  archived round in one file via `RefereeCsv.downloadAll()`.
- `slots = { A, B }` holds which driving order each car is on (`null` = 빈 자리, empty seat). Defaults
  to (1, 2). Pair navigation (`moveRun`, ← / →) moves both by 2 and re-pairs as (n, n+1); per-car
  arrows and the `<select>` change one car. `runBase()` derives the pair anchor from A, or B−1.
- Undo pops the last event of any car and moves that car's slot back to the removed event's order.
- `overlay` (`null | "setup" | "list"`) plus `match.status` decide the view in `currentView()`:
  setup / match / list / result sections toggle via `hidden`; `body.is-scoreboard` / `body.is-results`
  drive layout CSS. `isRunning()` (status running and overlay null) gates every mutating action and
  the keyboard handler. The list screen is reachable from both the match and result views;
  corrections there while finished also refresh `endedAt`.

### Persistence and schema versioning
- Everything (`settings`, `match`, `slots`, `results`) is saved as one JSON blob under
  `referee.matches.v5` on every mutation via `save()`. On load it is validated by `validMatch` and
  normalized by `normalizeMatch` (which also defaults a missing `mode` to `"regular"`); an invalid
  blob is discarded and a message is shown in `#storage-status`.
- `PREVIOUS_KEYS` are tried in order when v5 is absent: `referee.matches.v4` (archive held a single
  tournament match — the loader accepts both an array and a bare object), `referee.matches.v3` (no
  mode, no archive) and `referee.matches.v2` (single selected team, no `car` — `selectedTeam` becomes
  car A, the next order car B, `voicePreset` becomes car A's voice).
- `referee.infringement.v1` (timestamps with no team) is read but never migrated; it is only exposed
  as a separate "이전 기록 CSV" download (`teamCount: 0`, `team: null`). If the stored shape changes
  again, bump the key and keep the old keys readable the same way.

### Audio pipeline
`settings.voices = { A, B }` picks one of three local MP3s per car (`VOICE_FILES`); no network TTS at
runtime. `preloadVoices()` fetches all three once at startup into blob URLs (`clipSources`); on
`file://` there is no fetch, so it stores the file paths instead. `playVoice()` → `playClip()` creates
a fresh `new Audio(url)` per call (the same path as ordinary media such as YouTube), so clips overlap
and nothing is fetched per press. Live clips are tracked in `activeClips` for `stopVoice()` and live
volume changes. A failure never stops other clips; it sets `audioError` (with the error name), shown
in the settings dialog and in the `#audio-inline` notice on the scoreboard, and is appended to
`audioLog`. `stopVoice()` calls each clip's `stopClip()`, which clears the 4-second watchdog — without
that, a cancelled clip's timeout later reached the fail path and spoke its team name seconds after an
undo. Team names cannot be pre-recorded, so `speakTeamName()` reads them with the Web Speech
API (`speechSynthesis`) once the clip's `ended` fires — gated by `settings.speakNames`, silent when
the browser has no Korean voice, pitch-differentiated per car. This is speech synthesis, not the
Web Audio API, and is the only runtime-generated audio. The settings dialog's 음성 진단 panel
(음성 테스트 + diagnostics text + copy) is the intended way to debug sound remotely;
`share_server.py` logs each request's User-Agent for the same reason.
**Do not reintroduce the Web Audio API**: it was silent with no error on the user's desktop Chrome
via the tunnel and was removed at the user's request on 2026-09-11. Headless Chrome has no audio
sink, so playback itself cannot be verified there; the harness checks preload counts and absence of
logged failures.

### Keyboard and accessibility conventions
- One global `keydown` handler, active only when `isRunning()`: `ShiftLeft` → car A, `ShiftRight` →
  car B, ← / → → previous/next run pair, Backspace → undo. All ignore `event.repeat`, Alt/Ctrl/Meta,
  IME composition, editable targets (inputs and the order selects), and any open `<dialog>` — that
  exemption is what keeps Shift usable for capitals and 쌍자음 while typing team names. Space and `+`
  are no longer shortcuts, and Space is additionally `preventDefault`ed on `.record-button` targets so
  the native button activation cannot record (focus lands there after every action). Enter still
  activates the buttons, and Space still works on every other button. Do not re-add Space/`+` as
  shortcuts or drop that guard without asking: the user asked for the Shift remap on 2026-09-12 and
  for the leftover Space activation to go on 2026-09-13.
- After every action, focus is moved explicitly (usually to `#record-A`) and the visually hidden
  `#announcement` live region is updated. The `<output class="count">` elements are `aria-live="off"`
  on purpose so the announcement text is the single spoken summary.
- DOM is built with `createElement`/`replaceChildren`; there is no `innerHTML` anywhere. The list
  screen uses event delegation on `#list-rows` with `data-team` / `data-delta` buttons and
  `input[data-team]` name fields; name edits save on `change` without re-rendering the table so
  Tab/Enter can move through 100 rows. Each car card also has a `#name-A` / `#name-B` input for the
  current order's name; `renderCar` skips writing its value while it is focused so a press on the
  other car does not clobber typing. The order `<select>`s rebuild only when their
  `data-signature` (count + names) changes.

### CSV format (csv.js)
Output is UTF-8 with BOM (`"\uFEFF"` escape, not a literal byte), CRLF line endings, filename
`침범기록_<모드>_YYYYMMDD_HHMMSS.csv` from `endedAt`. Columns: 경기 구분, 구분, 총 팀 수, 주행 순서,
팀명, 대진, 진출, 차량, 침범 횟수, 판정 번호, 판정 시각, 경기 시작, 집계 시각. 대진 is the pair number for
every mode; 진출 is 진출/탈락/부전승/미정 on tournament 팀별 집계 rows only. The 경기 구분 cell and the
filename carry the round for tournaments ("토너먼트 10강"), so `csv.js` keeps its own copy of the mode
labels and the round rule — update both when either changes. `rowsOf()` builds one match's rows and
`buildAll()` concatenates several rounds under a single header for the tournament-wide export. Row order: header, one "팀별 집계" row per order (zero
counts included, 차량 blank), then one row per event ("판정" with A/B, or "정정" for manual
corrections with 차량 blank) carrying that order's running cumulative count and the 1-based event
index. `build()` throws `TypeError` on malformed input; `app.js` catches and reports in `#csv-status`.

### Theme and branding
The key color is SKKU light green, defined once as the `--accent*` tokens at the top of `styles.css`;
accent surfaces use dark text (`--accent-ink`) because white on that green fails contrast. The header
mark is an inline ginkgo-leaf glyph; `loadLogo()` swaps in `assets/skku-mark.svg` or `.png` if either
file exists (both are already in the share-server allowlist). The footer credit line in `index.html`
is verbatim user-supplied text; do not "fix" its wording.

### share_server.py
Serves only the paths listed in `PUBLIC_FILES` (explicit content types, `no-cache`, `nosniff`) and
binds `127.0.0.1`. It honours single byte ranges (206, `Accept-Ranges`), which Safari/iOS require
for media; keep that when touching the handler. Adding any new asset or script to the app requires adding it to that allowlist or
it will 404 on the backup tunnel share (GitHub Pages serves everything in the folder).

## Documentation
`심판/README.md` is the end-user manual and the handover document (인수인계용). Any change to shortcuts,
CSV columns, storage keys, voices, or theming must be reflected there, and every development pass
gets a dated bullet in its "개발 기록" section.
