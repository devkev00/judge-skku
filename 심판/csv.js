(() => {
  "use strict";

  const HEADERS = ["경기 구분", "구분", "총 팀 수", "주행 순서", "팀명", "대진", "진출", "차량", "침범 횟수", "판정 번호", "판정 시각", "경기 시작", "집계 시각"];
  const MODES = { regular: "일반주행", tournament: "토너먼트" };
  // 토너먼트는 라운드까지 적는다. 10팀이면 “토너먼트 10강”, 2팀이면 “토너먼트 결승”.
  function modeText(match) {
    if (!Object.prototype.hasOwnProperty.call(MODES, match.mode)) return "";
    if (match.mode !== "tournament") return MODES[match.mode];
    const round = match.teamCount <= 1 ? "우승" : match.teamCount === 2 ? "결승" : `${match.teamCount}강`;
    return `${MODES.tournament} ${round}`;
  }
  const CARS = ["A", "B"];
  const pad = (value, width = 2) => String(value).padStart(width, "0");

  function dateParts(timestamp) {
    if (timestamp === null || timestamp === undefined) return null;
    const date = new Date(timestamp);
    if (!Number.isSafeInteger(timestamp) || !Number.isFinite(date.getTime())) {
      throw new TypeError("유효하지 않은 판정 시각입니다.");
    }
    return [
      pad(date.getFullYear(), 4), pad(date.getMonth() + 1), pad(date.getDate()),
      pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds()), pad(date.getMilliseconds(), 3),
    ];
  }

  function formatDate(timestamp) {
    const parts = dateParts(timestamp);
    if (!parts) return "";
    const [year, month, day, hour, minute, second, millisecond] = parts;
    return `${year}-${month}-${day} ${hour}:${minute}:${second}.${millisecond}`;
  }

  function cell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  const orderText = (team) => (team === null ? "미지정" : `${team}번`);
  const pairOf = (team) => (team === null ? "" : Math.ceil(team / 2));

  // 토너먼트에서 그 팀이 다음 라운드에 올라갔는지. 상대가 없으면 부전승, 아직 안 골랐으면 미정.
  function advancement(match, team) {
    if (match.mode !== "tournament" || team === null) return "";
    const index = Math.ceil(team / 2) - 1;
    const first = index * 2 + 1;
    const hasOpponent = first + 1 <= match.teamCount;
    if (!hasOpponent) return "부전승";
    const winners = Array.isArray(match.winners) ? match.winners : [];
    const winner = winners[index];
    if (winner === undefined || winner === null) return "미정";
    return winner === team ? "진출" : "탈락";
  }

  function rowsOf(match) {
    if (!match || !Number.isSafeInteger(match.teamCount) || match.teamCount < 0 || !Array.isArray(match.events)) {
      throw new TypeError("유효하지 않은 경기 기록입니다.");
    }

    const startedAt = formatDate(match.startedAt);
    const endedAt = formatDate(match.endedAt);
    const mode = modeText(match);
    const names = Array.isArray(match.teamNames) ? match.teamNames : [];
    const nameOf = (team) => (team !== null && typeof names[team - 1] === "string" ? names[team - 1] : "");
    const totals = new Map();
    const runningCounts = new Map();
    const detailRows = [];
    for (let index = 0; index < match.events.length; index += 1) {
      const event = match.events[index];
      if (!event || (event.team !== null && (!Number.isSafeInteger(event.team) || event.team < 1 || event.team > match.teamCount))) {
        throw new TypeError("판정의 주행 순서를 확인해 주세요.");
      }
      if (event.car !== undefined && event.car !== null && !CARS.includes(event.car)) {
        throw new TypeError("판정의 차량을 확인해 주세요.");
      }
      if (event.at === null || event.at === undefined) {
        throw new TypeError("판정 시각이 없습니다.");
      }
      const timestamp = formatDate(event.at);
      const cumulativeCount = (runningCounts.get(event.team) || 0) + 1;
      runningCounts.set(event.team, cumulativeCount);
      totals.set(event.team, cumulativeCount);
      detailRows.push([
        mode, event.manual ? "정정" : "판정", match.teamCount, orderText(event.team), nameOf(event.team),
        pairOf(event.team), "", event.car ?? "", cumulativeCount, index + 1, timestamp, startedAt, endedAt,
      ]);
    }

    const rows = [];
    for (let team = 1; team <= match.teamCount; team += 1) {
      rows.push([mode, "팀별 집계", match.teamCount, orderText(team), nameOf(team), pairOf(team), advancement(match, team), "", totals.get(team) || 0, "", "", startedAt, endedAt]);
    }
    if (totals.has(null) || match.teamCount === 0) {
      rows.push([mode, "팀별 집계", match.teamCount, "미지정", "", "", "", "", totals.get(null) || 0, "", "", startedAt, endedAt]);
    }
    return rows.concat(detailRows);
  }

  const encode = (rows) =>
    // The BOM makes Korean text readable when opening the CSV directly in Excel.
    "\uFEFF" + [HEADERS].concat(rows).map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";

  const build = (match) => encode(rowsOf(match));

  // 토너먼트 전체: 라운드를 순서대로 이어 붙여 한 파일로 만든다. 헤더는 한 번만.
  function buildAll(matches) {
    if (!Array.isArray(matches) || matches.length === 0) throw new TypeError("내보낼 경기가 없습니다.");
    return encode(matches.flatMap((match) => rowsOf(match)));
  }

  function filename(match) {
    const parts = dateParts(match.endedAt ?? match.startedAt);
    // 경기 구분을 파일명에 넣어 일반주행·토너먼트 결과가 섞이지 않게 한다.
    const label = modeText(match).replace(/ /g, "_");
    const mode = label ? `${label}_` : "";
    if (!parts) return label ? `침범기록_${label}.csv` : "침범기록.csv";
    const [year, month, day, hour, minute, second] = parts;
    return `침범기록_${mode}${year}${month}${day}_${hour}${minute}${second}.csv`;
  }

  function allFilename(matches) {
    const newest = matches.reduce((best, match) => {
      const at = match.endedAt ?? match.startedAt ?? 0;
      return at > best ? at : best;
    }, 0);
    const parts = dateParts(newest || null);
    if (!parts) return "침범기록_토너먼트_전체.csv";
    const [year, month, day, hour, minute, second] = parts;
    return `침범기록_토너먼트_전체_${year}${month}${day}_${hour}${minute}${second}.csv`;
  }

  function saveFile(csv, name) {
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.hidden = true;
    try {
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      // Give browsers time to start reading the blob before releasing it.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return name;
  }

  const download = (match) => saveFile(build(match), filename(match));
  const downloadAll = (matches) => saveFile(buildAll(matches), allFilename(matches));

  window.RefereeCsv = Object.freeze({ build, buildAll, filename, allFilename, download, downloadAll });
})();
