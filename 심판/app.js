(() => {
  "use strict";

  const STORAGE_KEY = "referee.matches.v5";
  const PREVIOUS_KEYS = ["referee.matches.v4", "referee.matches.v3", "referee.matches.v2"];
  const LEGACY_KEY = "referee.infringement.v1";
  const MAX_TEAMS = 100;
  const MAX_NAME = 40;
  const CARS = Object.freeze(["A", "B"]);
  // 경기 구분. 결과는 구분마다 따로 보관하고 따로 내보낸다.
  const MODES = Object.freeze({ regular: "일반주행", tournament: "토너먼트" });
  const MODE_KEYS = Object.freeze(Object.keys(MODES));
  const VOICE_FILES = Object.freeze({
    female: "assets/intrusion-female.mp3",
    male: "assets/intrusion-male.mp3",
    original: "assets/intrusion.mp3",
  });
  // 성대 마크: 아래 파일 중 먼저 읽히는 것을 헤더에 표시한다. 없으면 은행잎 아이콘을 쓴다.
  const LOGO_FILES = Object.freeze(["assets/skku-mark.svg", "assets/skku-mark.png"]);
  const $ = (id) => document.getElementById(id);
  const clockFormat = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const fullDateFormat = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const settings = { soundEnabled: true, volume: 80, voices: { A: "female", B: "male" }, speakNames: true };
  // 차량 A·B가 현재 맡은 주행 순서. null이면 빈 자리.
  const slots = { A: null, B: null };
  // 구분별로 마친 경기를 보관한다. 일반주행은 한 건, 토너먼트는 라운드(팀 수)마다 한 건씩.
  const results = { regular: null, tournament: [] };
  const pressTimeouts = {};
  let match = null;
  let legacyEvents = [];
  // null: 경기 상태에 따라 판정/결과 화면, "setup": 새 경기 입력, "list": 주행 목록(정정) 화면
  let overlay = null;
  let resultTab = "regular";
  // 토너먼트 탭에서 보고 있는 라운드. 그 라운드의 팀 수로 구분한다.
  let resultRound = 0;
  // 초기화 확인 창이 지울 대상: "all"(전체) 또는 차량("A"/"B", 그 차량이 맡은 순서만).
  let resetTarget = "all";

  const validTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
  const validTeamCount = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_TEAMS;
  const validOrder = (value, teamCount) => Number.isInteger(value) && value >= 1 && value <= teamCount;
  const isVoice = (value) => Object.prototype.hasOwnProperty.call(VOICE_FILES, value);
  const isMode = (value) => Object.prototype.hasOwnProperty.call(MODES, value);
  const isRunning = () => match?.status === "running" && overlay === null;
  const dialogOpen = () => Boolean(document.querySelector("dialog[open]"));
  const cleanName = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "");
  const parseNames = (text) => String(text ?? "").split(/\r?\n/).map(cleanName);

  function normalizeNames(names, teamCount) {
    const list = Array.isArray(names) ? names : [];
    return Array.from({ length: teamCount }, (_, index) => cleanName(list[index]));
  }

  const pairCount = (teamCount) => Math.ceil(teamCount / 2);
  const pairOf = (order) => Math.ceil(order / 2);
  // 대진의 두 순서. 짝이 없으면 second가 null (부전승).
  function pairOrders(target, index) {
    const first = index * 2 + 1;
    return { first, second: first + 1 <= target.teamCount ? first + 1 : null };
  }

  // 진출 팀 목록을 대진 수에 맞춘다. 부전승은 자동으로 진출.
  function normalizeWinners(target) {
    if (target.mode !== "tournament") {
      delete target.winners;
      return;
    }
    const saved = Array.isArray(target.winners) ? target.winners : [];
    target.winners = Array.from({ length: pairCount(target.teamCount) }, (_, index) => {
      const { first, second } = pairOrders(target, index);
      if (second === null) return first;
      return saved[index] === first || saved[index] === second ? saved[index] : null;
    });
    if (!Number.isInteger(target.round) || target.round < 1) target.round = 1;
  }

  // 추월 표시. 대진마다 추월한 주행 순서(없으면 null). 본선(토너먼트)에서만 쓴다.
  // 규정 4.1.3·5.1 b4: 따라잡힌 차량은 완주 실패, 따라잡은 차량이 그 대진의 승자.
  function normalizeOvertakes(target) {
    if (target.mode !== "tournament") {
      delete target.overtakes;
      return;
    }
    const saved = Array.isArray(target.overtakes) ? target.overtakes : [];
    target.overtakes = Array.from({ length: pairCount(target.teamCount) }, (_, index) => {
      const { first, second } = pairOrders(target, index);
      if (second === null) return null;
      return saved[index] === first || saved[index] === second ? saved[index] : null;
    });
  }

  // 그 순서의 대진 상대. 없으면 null (부전승).
  function partnerOf(target, order) {
    const { first, second } = pairOrders(target, pairOf(order) - 1);
    return order === first ? second : first;
  }
  // 그 순서가 속한 대진에서 추월한 순서. 추월이 없거나 토너먼트가 아니면 null.
  const overtakerOf = (target, order) => (target.mode === "tournament" && order !== null && Array.isArray(target.overtakes)
    ? target.overtakes[pairOf(order) - 1] ?? null : null);

  // 팀 수로 라운드를 부른다. 10팀이면 10강, 5팀이면 5강, 2팀은 결승.
  function roundLabel(teamCount) {
    if (teamCount <= 1) return "우승";
    if (teamCount === 2) return "결승";
    return `${teamCount}강`;
  }
  const modeLabel = (target) => (target && target.mode === "tournament"
    ? `${MODES.tournament} · ${roundLabel(target.teamCount)}` : MODES[target?.mode] || "");

  const nameOf = (target, order) => (target && order !== null ? target.teamNames[order - 1] || "" : "");
  const teamName = (order) => nameOf(match, order);
  const teamLabel = (order) => {
    if (order === null) return "빈 자리";
    const name = teamName(order);
    return name ? `${order}번 · ${name}` : `${order}번`;
  };

  function currentView() {
    if (!match || overlay === "setup") return "setup";
    if (overlay === "list") return "list";
    return match.status === "running" ? "match" : "result";
  }

  function storageError(message) {
    $("storage-status").classList.add("error");
    $("storage-status-text").textContent = message;
  }

  function readSettings(saved) {
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.soundEnabled === "boolean") settings.soundEnabled = saved.soundEnabled;
    if (typeof saved.speakNames === "boolean") settings.speakNames = saved.speakNames;
    if (Number.isInteger(saved.volume) && saved.volume >= 10 && saved.volume <= 100) settings.volume = saved.volume;
    // v1·v2의 단일 목소리 설정은 차량 A에 적용한다.
    if (isVoice(saved.voicePreset)) settings.voices.A = saved.voicePreset;
    if (saved.voices && typeof saved.voices === "object") {
      for (const car of CARS) if (isVoice(saved.voices[car])) settings.voices[car] = saved.voices[car];
    }
  }

  function validMatch(saved) {
    return Boolean(saved) && validTeamCount(saved.teamCount) && validTime(saved.startedAt)
      && ["running", "finished"].includes(saved.status)
      && (saved.status === "running" ? saved.endedAt === null : validTime(saved.endedAt))
      && (saved.teamNames === undefined || Array.isArray(saved.teamNames))
      && (saved.mode === undefined || isMode(saved.mode))
      && (saved.winners === undefined || Array.isArray(saved.winners))
      && (saved.overtakes === undefined || Array.isArray(saved.overtakes))
      && Array.isArray(saved.events)
      && saved.events.every((event) => event && validOrder(event.team, saved.teamCount) && validTime(event.at)
        && (event.car === undefined || event.car === null || CARS.includes(event.car)));
  }

  function normalizeEvent(event) {
    const normalized = { team: event.team, at: event.at, car: CARS.includes(event.car) ? event.car : null };
    if (event.manual === true) normalized.manual = true;
    return normalized;
  }

  // 저장본을 현재 형식으로 맞춘다. 구분이 없던 기록은 일반주행으로 본다.
  function normalizeMatch(saved) {
    if (!validMatch(saved)) return null;
    saved.mode = isMode(saved.mode) ? saved.mode : "regular";
    saved.events = saved.events.map(normalizeEvent);
    saved.teamNames = normalizeNames(saved.teamNames, saved.teamCount);
    normalizeWinners(saved);
    normalizeOvertakes(saved);
    return saved;
  }

  const snapshot = (target) => JSON.parse(JSON.stringify(target));

  function defaultSlots(teamCount) {
    slots.A = 1;
    slots.B = teamCount >= 2 ? 2 : null;
  }

  function readSlots(saved) {
    if (!saved || typeof saved !== "object") return;
    for (const car of CARS) {
      if (saved[car] === null || validOrder(saved[car], match.teamCount)) slots[car] = saved[car];
    }
  }

  // v1: 팀 없이 시각만 저장한 기록. 별도 CSV로만 제공한다.
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    if (legacy && Array.isArray(legacy.events) && legacy.events.every(validTime)) {
      legacyEvents = legacy.events;
      readSettings(legacy);
    }
  } catch {
    storageError("이전 기록을 불러오지 못했습니다.");
  }

  // v4 저장본을 읽는다. 없으면 v3(구분 없음) → v2(팀 하나 선택) 순으로 옮긴다.
  try {
    let saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved) {
      for (const key of PREVIOUS_KEYS) {
        const previous = JSON.parse(localStorage.getItem(key) || "null");
        if (!previous || typeof previous !== "object") continue;
        saved = { settings: previous.settings, match: previous.match ?? null, slots: previous.slots ?? null, results: null };
        // v2는 팀 하나만 선택했다. 그 팀을 차량 A, 다음 번호를 차량 B로 옮긴다.
        if (validMatch(saved.match) && validOrder(previous.selectedTeam, saved.match.teamCount)) {
          const selected = previous.selectedTeam;
          saved.slots = { A: selected, B: selected < saved.match.teamCount ? selected + 1 : null };
        }
        break;
      }
    }
    if (saved) {
      if (typeof saved !== "object" || (saved.match !== null && saved.match !== undefined && !validMatch(saved.match))) {
        throw new Error("Invalid match");
      }
      readSettings(saved.settings);
      match = normalizeMatch(saved.match ?? null);
      if (match) {
        defaultSlots(match.teamCount);
        readSlots(saved.slots);
        resultTab = match.mode;
        resultRound = match.teamCount;
      }
      if (saved.results && typeof saved.results === "object") {
        const regular = normalizeMatch(saved.results.regular ?? null);
        if (regular && regular.status === "finished") results.regular = regular;
        // v4는 토너먼트를 한 건만 두었다. 배열로 옮긴다.
        const stored = Array.isArray(saved.results.tournament) ? saved.results.tournament
          : saved.results.tournament ? [saved.results.tournament] : [];
        for (const entry of stored) {
          const round = normalizeMatch(entry ?? null);
          if (round && round.status === "finished") archiveRound(round);
        }
      }
      // 마친 경기를 불러온 경우, 보관함이 비어 있을 수 있으므로 바로 맞춰 둔다(구분 없던 저장본에서 옮겨올 때).
      syncResults();
    }
  } catch {
    storageError("저장된 경기를 불러오지 못했습니다. 팀 수를 다시 입력하세요.");
  }

  // 토너먼트 보관함은 라운드(팀 수)마다 한 건. 같은 라운드를 다시 하면 최신 것으로 바꾼다.
  function archiveRound(finished) {
    const index = results.tournament.findIndex((entry) => entry.teamCount === finished.teamCount);
    if (index >= 0) results.tournament[index] = finished;
    else results.tournament.push(finished);
    results.tournament.sort((a, b) => b.teamCount - a.teamCount);
  }

  // 마친 경기는 구분별 보관함에도 남겨 다른 구분·라운드의 결과와 나란히 볼 수 있게 한다.
  function syncResults() {
    if (!match || match.status !== "finished" || !isMode(match.mode)) return;
    if (match.mode === "regular") results.regular = snapshot(match);
    else archiveRound(snapshot(match));
  }

  function save() {
    try {
      syncResults();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, match, slots, results }));
      $("storage-status").classList.remove("error");
      $("storage-status-text").textContent = "이 브라우저에 자동 저장";
    } catch {
      storageError("자동 저장 실패. 창을 닫기 전에 결과 화면에서 CSV를 내려받으세요.");
    }
  }

  function totalsOf(target) {
    const totals = Array(target.teamCount).fill(0);
    for (const event of target.events) totals[event.team - 1] += 1;
    return totals;
  }

  const teamTotals = () => totalsOf(match);
  const formatCount = (value) => value.toLocaleString("ko-KR");

  function eventLabel(event) {
    const who = event.manual ? "정정" : event.car ? `차량 ${event.car}` : "판정";
    return `${who} · ${teamLabel(event.team)}`;
  }

  // 주행 순서 드롭다운. 팀 수나 팀명이 바뀌었을 때만 다시 만든다.
  function fillOrderOptions(select) {
    const signature = `${match.teamCount}\n${match.teamNames.join("\n")}`;
    if (select.dataset.signature === signature) return;
    const options = [new Option("빈 자리", "")];
    for (let order = 1; order <= match.teamCount; order += 1) options.push(new Option(teamLabel(order), String(order)));
    select.replaceChildren(...options);
    select.dataset.signature = signature;
  }

  function renderCar(car, totals) {
    const order = slots[car];
    const select = $(`order-${car}`);
    fillOrderOptions(select);
    select.value = order === null ? "" : String(order);
    select.classList.toggle("has-name", order !== null && teamName(order) !== "");
    $(`car-${car}`).classList.toggle("is-empty", order === null);
    // 팀명 칸: 입력 중(포커스)일 때는 값을 덮어쓰지 않는다. 다른 차량 판정으로 다시 그려도 타이핑이 지워지지 않게.
    const nameInput = $(`name-${car}`);
    nameInput.disabled = order === null;
    if (document.activeElement !== nameInput) nameInput.value = order === null ? "" : teamName(order);
    nameInput.setAttribute("aria-label", order === null ? `차량 ${car} 팀명` : `차량 ${car}, ${order}번 팀명`);
    const count = order === null ? "–" : formatCount(totals[order - 1]);
    const output = $(`count-${car}`);
    output.textContent = count;
    output.dataset.digits = count.length;
    output.setAttribute("aria-label", order === null ? `차량 ${car} 빈 자리` : `차량 ${car}, ${teamLabel(order)} 침범 횟수`);
    const shortcut = car === "A" ? "왼쪽 Shift" : "오른쪽 Shift";
    const button = $(`record-${car}`);
    button.disabled = order === null;
    button.setAttribute("aria-label", order === null ? `차량 ${car} 빈 자리`
      : `차량 ${car}, ${teamLabel(order)} 침범 1회 추가, ${shortcut} 키`);
    $(`prev-${car}`).disabled = order !== null && order <= 1;
    $(`next-${car}`).disabled = order !== null && order >= match.teamCount;
    renderOvertake(car, order);
    $(`reset-car-${car}`).disabled = order === null || (totals[order - 1] === 0 && overtakerOf(match, order) === null);
  }

  // 추월 줄: 본선에서만 보인다. 누른 쪽은 버튼이 켜지고, 대진 상대 카드에는 “추월당함 · 완주 실패”가 뜬다.
  function renderOvertake(car, order) {
    const tournament = match.mode === "tournament";
    const card = $(`car-${car}`);
    $(`overtake-row-${car}`).hidden = !tournament;
    const partner = tournament && order !== null ? partnerOf(match, order) : null;
    const overtaker = tournament ? overtakerOf(match, order) : null;
    const on = overtaker !== null && overtaker === order;
    const overtaken = overtaker !== null && overtaker !== order;
    const toggle = $(`overtake-${car}`);
    toggle.disabled = !tournament || order === null || partner === null;
    toggle.classList.toggle("is-on", on);
    toggle.setAttribute("aria-pressed", String(on));
    const who = order === null ? "빈 자리" : teamLabel(order);
    toggle.title = order === null ? "빈 자리" : partner === null ? "상대 없음 (부전승)"
      : on ? `${who} 추월 표시 지우기` : `${who}가 ${teamLabel(partner)}를 따라잡았을 때`;
    toggle.setAttribute("aria-label", order === null ? `차량 ${car} 빈 자리` : partner === null ? `차량 ${car}, ${who} 상대 없음`
      : on ? `차량 ${car}, ${who} 추월 표시 지우기` : `차량 ${car}, ${who}가 ${teamLabel(partner)}를 추월함`);
    $(`overtaken-${car}`).hidden = !overtaken;
    card.classList.toggle("is-overtaken", overtaken);
    card.classList.toggle("is-overtaker", on);
  }

  // 두 차량이 짝을 이루는 기준 순서. A가 비어 있으면 B에서 거꾸로 계산한다.
  function runBase() {
    if (slots.A !== null) return slots.A;
    if (slots.B !== null) return slots.B - 1;
    return null;
  }

  function renderHistory() {
    const recent = match.events.slice(-5).reverse();
    $("empty-history").hidden = recent.length > 0;
    $("history").hidden = recent.length === 0;
    const rows = recent.map((event, index) => {
      const row = document.createElement("li");
      row.className = "history-row";
      const number = document.createElement("span");
      number.className = "history-number";
      number.textContent = match.events.length - index;
      const label = document.createElement("span");
      label.className = "history-name";
      label.textContent = eventLabel(event);
      const time = document.createElement("time");
      time.dateTime = new Date(event.at).toISOString();
      time.textContent = clockFormat.format(event.at);
      time.title = fullDateFormat.format(event.at);
      row.append(number, label, time);
      return row;
    });
    $("history").replaceChildren(...rows);
  }

  function renderRunning() {
    const totals = teamTotals();
    $("match-team-count").textContent = match.teamCount;
    $("match-mode").textContent = MODES[match.mode];
    for (const car of CARS) renderCar(car, totals);
    $("same-order").hidden = slots.A === null || slots.A !== slots.B;
    const base = runBase();
    $("prev-run").disabled = base === null || base - 2 < 1;
    $("next-run").disabled = base === null || base + 2 > match.teamCount;
    $("match-started").textContent = fullDateFormat.format(match.startedAt);
    $("match-started").dateTime = new Date(match.startedAt).toISOString();
    $("undo-button").disabled = match.events.length === 0;
    $("reset-button").disabled = match.events.length === 0;
    renderHistory();
  }

  function renderList() {
    const totals = teamTotals();
    $("list-team-count").textContent = match.teamCount;
    $("list-mode").textContent = MODES[match.mode];
    $("list-back").textContent = match.status === "running" ? "판정으로 돌아가기" : "결과로 돌아가기";
    const rows = totals.map((total, index) => {
      const order = index + 1;
      const row = document.createElement("tr");
      const head = document.createElement("th");
      head.scope = "row";
      head.textContent = `${order}번`;
      const nameCell = document.createElement("td");
      nameCell.className = "list-name";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "name-input";
      input.maxLength = MAX_NAME;
      input.autocomplete = "off";
      input.placeholder = "팀명";
      input.value = teamName(order);
      input.dataset.team = order;
      input.setAttribute("aria-label", `${order}번 팀명`);
      nameCell.append(input);
      const count = document.createElement("td");
      count.className = "list-count";
      count.textContent = formatCount(total);
      const cars = document.createElement("td");
      cars.className = "list-cars";
      if (match.status === "running") {
        for (const car of CARS) {
          if (slots[car] !== order) continue;
          const badge = document.createElement("span");
          badge.className = "car-badge";
          badge.textContent = car;
          badge.title = `차량 ${car}`;
          cars.append(badge);
        }
      }
      const actions = document.createElement("td");
      actions.className = "list-actions";
      for (const delta of [-1, 1]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mini-button";
        button.textContent = delta > 0 ? "+1" : "−1";
        button.dataset.team = order;
        button.dataset.delta = delta;
        button.disabled = delta < 0 && total === 0;
        button.setAttribute("aria-label", `${order}번 침범 1회 ${delta > 0 ? "더하기" : "빼기"}`);
        actions.append(button);
      }
      row.append(head, nameCell, count, cars, actions);
      return row;
    });
    $("list-rows").replaceChildren(...rows);
  }

  // 토너먼트 탭에 보여 줄 라운드 목록. 팀이 많은 라운드(8강)부터 결승 쪽으로 내려간다.
  const tournamentRounds = () => results.tournament;

  // 보고 있는 라운드가 사라졌으면 현재 경기의 라운드, 그것도 없으면 첫 라운드로 맞춘다.
  function ensureRound() {
    if (resultTab !== "tournament") return;
    const rounds = tournamentRounds();
    if (rounds.some((entry) => entry.teamCount === resultRound)) return;
    if (match && match.status === "finished" && match.mode === "tournament") resultRound = match.teamCount;
    else resultRound = rounds.length ? rounds[0].teamCount : 0;
  }

  // 결과 화면에서 지금 보고 있는 경기. 현재 경기가 그 자리면 현재 경기(정정이 바로 보이도록), 아니면 보관본.
  // 아직 안 고른 대진만 채워 둔다: 추월이 있으면 추월한 팀, 아니면 침범이 적은 쪽. 동률은 심판이 고르도록 비워 둔다.
  function suggestWinners(target) {
    if (target.mode !== "tournament") return;
    const totals = totalsOf(target);
    for (let index = 0; index < target.winners.length; index += 1) {
      if (target.winners[index] !== null) continue;
      const { first, second } = pairOrders(target, index);
      const overtaker = target.overtakes[index];
      if (second === null) {
        target.winners[index] = first;
      } else if (overtaker !== null) {
        // 추월이 있던 대진은 따라잡은 팀이 승자(규정 4.1.3).
        target.winners[index] = overtaker;
      } else if (totals[first - 1] < totals[second - 1]) {
        target.winners[index] = first;
      } else if (totals[second - 1] < totals[first - 1]) {
        target.winners[index] = second;
      }
    }
  }

  function activeResult() {
    const current = match && match.status === "finished" && match.mode === resultTab;
    if (resultTab === "regular") return current ? match : results.regular;
    if (current && match.teamCount === resultRound) return match;
    return tournamentRounds().find((entry) => entry.teamCount === resultRound) || null;
  }

  // 토너먼트 결과: 주행 순서를 두 대씩 묶어 대진으로 보여 준다. 차량 A·B가 함께 달린 짝과 같다.
  function renderBracket(shown, editable) {
    const totals = totalsOf(shown);
    const cards = [];
    for (let first = 1; first <= shown.teamCount; first += 2) {
      const second = first + 1 <= shown.teamCount ? first + 1 : null;
      const card = document.createElement("li");
      card.className = "bracket-pair";
      const heading = document.createElement("div");
      heading.className = "bracket-heading";
      const title = document.createElement("p");
      title.className = "bracket-title";
      title.textContent = `대진 ${Math.ceil(first / 2)}`;
      heading.append(title);
      const tie = second !== null && totals[first - 1] === totals[second - 1];
      const undecided = second !== null && shown.winners[Math.ceil(first / 2) - 1] === null;
      const overtaker = second === null ? null : overtakerOf(shown, first);
      const noteText = overtaker !== null ? (undecided ? "추월 · 진출 팀 선택" : "추월")
        : tie && undecided ? "침범 동률 · 진출 팀 선택" : tie ? "침범 동률" : undecided ? "진출 팀 선택" : "";
      if (noteText) {
        const note = document.createElement("span");
        note.className = "bracket-note";
        note.classList.toggle("is-overtake", overtaker !== null);
        note.textContent = noteText;
        heading.append(note);
      }
      card.append(heading);
      for (const order of [first, second]) {
        const row = document.createElement("div");
        row.className = "bracket-row";
        if (order === null) {
          row.classList.add("is-empty");
          const label = document.createElement("span");
          label.className = "bracket-name";
          label.textContent = "상대 없음";
          row.append(label);
          card.append(row);
          continue;
        }
        const total = totals[order - 1];
        const badge = document.createElement("span");
        badge.className = "bracket-order";
        badge.textContent = `${order}번`;
        const name = document.createElement("span");
        name.className = "bracket-name";
        name.textContent = nameOf(shown, order) || "팀명 없음";
        if (!nameOf(shown, order)) name.classList.add("is-blank");
        const count = document.createElement("span");
        count.className = "bracket-count";
        count.textContent = `${formatCount(total)}회`;
        row.append(badge, name, count);
        const index = pairOf(first) - 1;
        const winner = shown.winners[index];
        const bye = second === null;
        if (editable && !bye) {
          // 진출 팀은 심판이 고른다. 침범이 적은 쪽을 미리 골라 두되 바꿀 수 있다.
          const pick = document.createElement("button");
          pick.type = "button";
          pick.className = "advance-button";
          pick.dataset.pair = index;
          pick.dataset.team = order;
          pick.textContent = winner === order ? "진출" : "진출로";
          pick.setAttribute("aria-pressed", String(winner === order));
          pick.classList.toggle("is-on", winner === order);
          pick.setAttribute("aria-label", `${order}번 ${nameOf(shown, order) || "팀명 없음"} 진출로 선택`);
          row.append(pick);
        } else {
          const state = document.createElement("span");
          state.className = "advance-state";
          state.textContent = bye ? "부전승" : winner === null ? "미정" : winner === order ? "진출" : "탈락";
          state.classList.toggle("is-on", bye || winner === order);
          row.append(state);
        }
        if (winner === order) row.classList.add("is-winner");
        // 사실만 적는다. 추월이 있던 대진은 추월함·추월당함(완주 실패)만 적고 침범 비교는 생략한다.
        if (overtaker !== null) {
          const mark = document.createElement("span");
          mark.className = `bracket-mark ${overtaker === order ? "is-overtake" : "is-overtaken"}`;
          mark.textContent = overtaker === order ? "추월함" : "추월당함 · 완주 실패";
          row.append(mark);
        } else if (second !== null && !tie && total === Math.min(totals[first - 1], totals[second - 1])) {
          row.classList.add("is-lower");
          const mark = document.createElement("span");
          mark.className = "bracket-mark";
          mark.textContent = "침범 적음";
          row.append(mark);
        }
        card.append(row);
      }
      cards.push(card);
    }
    $("result-bracket").replaceChildren(...cards);
  }

  function renderTable(shown) {
    $("result-table").classList.toggle("has-names", shown.teamNames.some(Boolean));
    const rows = totalsOf(shown).map((total, index) => {
      const row = document.createElement("tr");
      const order = document.createElement("th");
      order.scope = "row";
      order.textContent = `${index + 1}번`;
      const name = document.createElement("td");
      name.className = "name-col name-cell";
      name.textContent = nameOf(shown, index + 1);
      const count = document.createElement("td");
      count.textContent = formatCount(total);
      row.append(order, name, count);
      return row;
    });
    $("result-rows").replaceChildren(...rows);
  }

  // 진출 팀이 다 정해지면 다음 라운드를 바로 시작할 수 있게 안내한다.
  function renderNextRound(shown, editable) {
    const winners = shown.winners;
    const decided = winners.every((order) => order !== null);
    const advancing = winners.length;
    const champion = decided && advancing === 1;
    $("champion").hidden = !champion;
    if (champion) $("champion-name").textContent = nameOf(shown, winners[0]) || `${winners[0]}번`;
    $("next-round").hidden = champion || !editable || advancing < 2;
    if ($("next-round").hidden) return;
    $("next-round-label").textContent = roundLabel(advancing);
    $("next-round-count").textContent = advancing;
    $("next-round-button").disabled = !decided;
    $("next-round-button").textContent = `${roundLabel(advancing)} 시작`;
    $("next-round-hint").hidden = decided;
    const names = decided ? winners.map((order) => nameOf(shown, order) || `${order}번`).join(", ") : "";
    $("next-round-teams").textContent = names;
    $("next-round-teams").hidden = !decided;
  }

  function renderRoundChips() {
    const rounds = tournamentRounds();
    const chips = rounds.map((entry) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "round-chip";
      chip.dataset.round = entry.teamCount;
      chip.textContent = roundLabel(entry.teamCount);
      const selected = entry.teamCount === resultRound;
      chip.classList.toggle("is-active", selected);
      chip.setAttribute("aria-pressed", String(selected));
      chip.setAttribute("aria-label", `${roundLabel(entry.teamCount)} 결과, ${entry.teamCount}팀`);
      return chip;
    });
    $("result-rounds").replaceChildren(...chips);
    $("result-rounds").hidden = resultTab !== "tournament" || rounds.length === 0;
  }

  function renderResult() {
    ensureRound();
    for (const mode of MODE_KEYS) {
      const tab = $(`tab-${mode}`);
      const selected = mode === resultTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.classList.toggle("is-active", selected);
      const has = mode === "regular" ? Boolean(results.regular) : tournamentRounds().length > 0;
      tab.classList.toggle("is-empty", !has);
    }
    renderRoundChips();
    const shown = activeResult();
    const isCurrent = shown !== null && shown === match;
    const tournament = resultTab === "tournament";
    $("result-empty").hidden = Boolean(shown);
    $("result-body").hidden = !shown;
    $("result-empty-mode").textContent = MODES[resultTab];
    $("resume-button").hidden = !isCurrent;
    $("result-list-button").hidden = !isCurrent;
    $("result-bracket").hidden = !tournament;
    $("result-table").hidden = tournament;
    $("bracket-summary").hidden = !tournament;
    $("download-all").hidden = !tournament || tournamentRounds().length === 0;
    $("result-mode").textContent = shown ? modeLabel(shown) : MODES[resultTab];
    if (!shown) {
      $("result-team-count").textContent = "0";
      return;
    }
    $("result-team-count").textContent = shown.teamCount;
    $("result-started").textContent = fullDateFormat.format(shown.startedAt);
    $("result-started").dateTime = new Date(shown.startedAt).toISOString();
    $("result-ended").textContent = fullDateFormat.format(shown.endedAt);
    $("result-ended").dateTime = new Date(shown.endedAt).toISOString();
    if (tournament) {
      $("bracket-round").textContent = roundLabel(shown.teamCount);
      $("bracket-pairs").textContent = pairCount(shown.teamCount);
      $("bracket-order-no").textContent = shown.round || 1;
      renderBracket(shown, isCurrent);
      renderNextRound(shown, isCurrent);
    } else {
      renderTable(shown);
      $("next-round").hidden = true;
      $("champion").hidden = true;
    }
  }

  function render() {
    const view = currentView();
    $("setup-view").hidden = view !== "setup";
    $("match-view").hidden = view !== "match";
    $("list-view").hidden = view !== "list";
    $("result-view").hidden = view !== "result";
    const phase = { setup: "경기 설정", match: "판정 중", list: "주행 목록", result: "경기 결과" }[view];
    $("phase-label").textContent = match && view !== "setup" ? `${phase} · ${MODES[match.mode]}` : phase;
    document.body.classList.toggle("is-scoreboard", view === "match");
    document.body.classList.toggle("is-results", view === "result");
    $("legacy-records").hidden = legacyEvents.length === 0;
    $("legacy-count").textContent = legacyEvents.length;
    $("back-to-result").hidden = !(overlay === "setup" && match?.status === "finished");
    if (view === "match") renderRunning();
    else if (view === "list") renderList();
    else if (view === "result") renderResult();
  }

  // ---------- 음성 ----------
  // 시작할 때 음원 3개를 한 번만 받아(blob) 두고, 판정마다 새 <audio> 요소로 재생한다.
  // 유튜브 같은 일반 미디어와 같은 경로라 브라우저·기기 설정의 영향이 가장 적고, 요소를 따로 만들므로 소리가 겹친다.
  // file:// 실행에서는 fetch를 쓸 수 없어 파일을 직접 읽는다. (Web Audio는 데스크톱 Chrome에서 조용했던 사례가 있어 쓰지 않는다.)
  // 팀명은 녹음할 수 없으므로 “침범” 음원이 끝난 뒤 브라우저 음성 합성(speechSynthesis)으로 읽는다.
  const speech = window.speechSynthesis;
  const canSpeak = Boolean(speech && typeof window.SpeechSynthesisUtterance === "function");
  const clipSources = {};
  const activeClips = new Set();
  const audioLog = [];
  let koreanVoices = [];
  let audioError = "";
  let preloading = false;

  function logAudio(message) {
    audioLog.push(`${clockFormat.format(Date.now())} ${message}`);
    if (audioLog.length > 12) audioLog.shift();
    renderDiagnostics();
  }

  async function preloadVoices() {
    if (typeof fetch !== "function" || location.protocol === "file:") {
      for (const [preset, url] of Object.entries(VOICE_FILES)) clipSources[preset] = url;
      logAudio("file:// 실행: 음원을 파일에서 직접 재생");
      renderAudio();
      return;
    }
    preloading = true;
    renderAudio();
    await Promise.all(Object.entries(VOICE_FILES).map(async ([preset, url]) => {
      try {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        clipSources[preset] = URL.createObjectURL(await response.blob());
      } catch (error) {
        clipSources[preset] = url;
        logAudio(`${preset} 음원 미리 받기 실패, 파일 직접 재생: ${error?.message || error}`);
      }
    }));
    preloading = false;
    const blobs = Object.values(clipSources).filter((source) => source.startsWith("blob:")).length;
    logAudio(`음원 준비: ${blobs}/3 미리 받음`);
    renderAudio();
  }

  function loadKoreanVoices() {
    if (!canSpeak) return;
    try {
      koreanVoices = speech.getVoices().filter((voice) => /^ko/i.test(voice.lang));
    } catch {
      koreanVoices = [];
    }
  }

  const isPlaying = () => activeClips.size > 0;

  function describeError(error) {
    const name = error?.name || (error?.code ? `MediaError ${error.code}` : "알 수 없는 오류");
    if (name === "NotAllowedError") return "브라우저가 소리 재생을 막았습니다. 화면을 한 번 클릭한 뒤 다시 시도하세요 (NotAllowedError)";
    if (name === "NotSupportedError" || error?.code === 4) return "이 브라우저에서 음성 파일을 재생할 수 없습니다 (NotSupportedError)";
    return `재생 실패 (${name})`;
  }

  // 팀명 읽기. 차량마다 목소리 설정에 맞춰 높낮이를 달리해 A·B를 구분한다.
  function speakTeamName(car, name) {
    if (!settings.soundEnabled || !settings.speakNames || !name) return;
    if (!canSpeak) {
      logAudio("이 브라우저는 팀명 읽기를 지원하지 않습니다");
      return;
    }
    try {
      const utterance = new window.SpeechSynthesisUtterance(name);
      utterance.lang = "ko-KR";
      utterance.volume = settings.volume / 100;
      utterance.rate = 1.1;
      utterance.pitch = settings.voices[car] === "male" ? 0.8 : settings.voices[car] === "female" ? 1.25 : 1;
      if (koreanVoices.length) utterance.voice = koreanVoices[CARS.indexOf(car) % koreanVoices.length];
      utterance.addEventListener("error", (event) => {
        if (event?.error === "interrupted" || event?.error === "canceled") return;
        logAudio(`팀명 읽기 실패: ${event?.error || "알 수 없음"}`);
      });
      speech.speak(utterance);
    } catch (error) {
      logAudio(`팀명 읽기 실패: ${error?.message || error}`);
    }
  }

  // <audio> 요소로 한 번 재생한다. 실패해도 다른 재생은 멈추지 않는다.
  function playClip(preset, { onFail, onEnded } = {}) {
    const clip = new Audio(clipSources[preset] || VOICE_FILES[preset]);
    clip.volume = settings.volume / 100;
    activeClips.add(clip);
    let started = false;
    let done = false;
    const finish = (fail) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      activeClips.delete(clip);
      if (fail) {
        clip.pause();
        onFail?.(fail);
      } else {
        onEnded?.();
      }
      renderAudio();
    };
    const watchdog = setTimeout(() => {
      if (!started) finish("재생이 시작되지 않았습니다 (timeout)");
    }, 4000);
    // 멈춘 음원은 감시 타이머까지 끊는다. 안 그러면 취소한 판정의 팀명이 몇 초 뒤에 읽힌다.
    clip.stopClip = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      activeClips.delete(clip);
      clip.pause();
    };
    clip.addEventListener("playing", () => {
      started = true;
      clearTimeout(watchdog);
    }, { once: true });
    clip.addEventListener("ended", () => finish(null), { once: true });
    clip.addEventListener("error", () => finish(describeError(clip.error)), { once: true });
    const promise = clip.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch((error) => finish(describeError(error)));
    }
  }

  function playVoice(car, name = "") {
    if (!settings.soundEnabled) return;
    audioError = "";
    playClip(settings.voices[car], {
      onEnded: () => speakTeamName(car, name),
      onFail: (reason) => {
        logAudio(`차량 ${car} 재생 실패: ${reason}`);
        audioError = reason;
        renderAudio();
        // 음원이 실패해도 팀명은 읽어 준다.
        speakTeamName(car, name);
      },
    });
    renderAudio();
  }

  function diagnosticsText() {
    const blobs = Object.values(clipSources).filter((source) => source.startsWith("blob:")).length;
    return [
      `브라우저: ${navigator.userAgent}`,
      `주소: ${location.href}`,
      `음성 ${settings.soundEnabled ? "켜짐" : "꺼짐"} · 음량 ${settings.volume}% · 목소리 A ${settings.voices.A}, B ${settings.voices.B}`,
      `음원: ${blobs}/3 미리 받음 (${Object.keys(clipSources).length}/3 준비)${preloading ? " (준비 중)" : ""}`,
      `팀명 읽기: ${settings.speakNames ? "켜짐" : "꺼짐"} · ${canSpeak ? `지원함, 한국어 목소리 ${koreanVoices.length}개` : "이 브라우저는 지원하지 않음"}`,
      `재생 중: ${activeClips.size}`,
      `마지막 오류: ${audioError || "없음"}`,
      "기록:",
      ...(audioLog.length ? audioLog.map((line) => `  ${line}`) : ["  (없음)"]),
    ].join("\n");
  }

  function renderDiagnostics() {
    $("audio-diag-text").textContent = diagnosticsText();
  }

  function renderAudio() {
    $("sound-toggle").setAttribute("aria-checked", String(settings.soundEnabled));
    $("name-toggle").setAttribute("aria-checked", String(settings.speakNames));
    $("name-toggle").disabled = !settings.soundEnabled;
    $("volume").disabled = !settings.soundEnabled;
    for (const car of CARS) {
      $(`voice-${car}`).disabled = !settings.soundEnabled;
      $(`voice-${car}`).value = settings.voices[car];
      $(`preview-${car}`).disabled = !settings.soundEnabled;
    }
    $("volume").value = settings.volume;
    $("volume-value").textContent = `${settings.volume}%`;
    const position = ((settings.volume - 10) / 90) * 100;
    $("volume").style.backgroundImage = `linear-gradient(to right, #7aa832 ${position}%, #e8eedd ${position}%)`;
    const error = Boolean(audioError && settings.soundEnabled);
    const text = !settings.soundEnabled ? "음성 꺼짐"
      : audioError || (isPlaying() ? `“침범” 재생 중 (${activeClips.size})` : `음성 켜짐${preloading ? " · 음원 준비 중" : ""}`);
    $("audio-status").classList.toggle("off", !settings.soundEnabled);
    $("audio-status").classList.toggle("error", error);
    $("audio-status-text").textContent = text;
    // 판정 화면에는 문제가 있을 때만 바로 보이게 한다.
    const inline = $("audio-inline");
    inline.hidden = settings.soundEnabled && !audioError;
    inline.classList.toggle("error", error);
    inline.querySelector("span").textContent = !settings.soundEnabled ? "음성 꺼짐 · 설정에서 켜기" : audioError;
    renderDiagnostics();
  }

  function stopVoice() {
    for (const clip of [...activeClips]) {
      if (typeof clip.stopClip === "function") clip.stopClip();
      else clip.pause();
    }
    activeClips.clear();
    if (canSpeak) {
      try {
        speech.cancel();
      } catch {
        // 취소를 지원하지 않는 브라우저
      }
    }
    renderAudio();
  }

  function flash(car) {
    const card = $(`car-${car}`);
    card.classList.add("recorded");
    clearTimeout(pressTimeouts[car]);
    pressTimeouts[car] = setTimeout(() => card.classList.remove("recorded"), 220);
  }

  // ---------- 판정 ----------
  function record(car) {
    if (!isRunning() || dialogOpen()) return;
    const team = slots[car];
    if (!validOrder(team, match.teamCount)) return;
    match.events.push({ team, at: Date.now(), car });
    renderRunning();
    save();
    playVoice(car, teamName(team));
    $("announcement").textContent = `차량 ${car}, ${teamLabel(team)} 침범 ${teamTotals()[team - 1]}회`;
    flash(car);
  }

  function undoLast() {
    if (!isRunning() || match.events.length === 0) return;
    const removed = match.events.pop();
    // 취소한 판정을 낸 차량을 그 주행 순서로 되돌려 어느 기록이 지워졌는지 보이게 한다.
    if (removed.car) slots[removed.car] = removed.team;
    stopVoice();
    renderRunning();
    save();
    $("announcement").textContent = `${eventLabel(removed)} 마지막 판정 취소`;
    $("record-A").focus();
  }

  // 추월: 누른 차량의 순서가 대진 상대를 따라잡은 것으로 표시한다. 상대는 추월당함(완주 실패).
  // 같은 버튼을 다시 누르면 지우고, 상대 카드의 버튼을 누르면 방향이 바뀐다.
  // 규정 4.1.3에 따라 그 대진의 진출 팀도 추월한 팀으로 맞춰 둔다(결과 화면에서 바꿀 수 있다). 지우면 미정으로 돌아간다.
  function toggleOvertake(car) {
    if (!isRunning() || dialogOpen() || match.mode !== "tournament") return;
    const order = slots[car];
    if (!validOrder(order, match.teamCount)) return;
    const partner = partnerOf(match, order);
    if (partner === null) return;
    const index = pairOf(order) - 1;
    const on = match.overtakes[index] !== order;
    match.overtakes[index] = on ? order : null;
    match.winners[index] = on ? order : null;
    renderRunning();
    save();
    $("announcement").textContent = on
      ? `차량 ${car}, ${teamLabel(order)} 추월. ${teamLabel(partner)} 추월당함, 완주 실패`
      : `${teamLabel(order)} 추월 표시 취소`;
    $(`record-${car}`).focus();
  }

  function setOrder(car, order) {
    if (!isRunning() || dialogOpen()) return;
    if (order !== null && !validOrder(order, match.teamCount)) return;
    slots[car] = order;
    renderRunning();
    save();
    $("announcement").textContent = order === null ? `차량 ${car} 빈 자리`
      : `차량 ${car}, ${teamLabel(order)}, 침범 ${teamTotals()[order - 1]}회`;
  }

  function stepOrder(car, direction) {
    if (!isRunning()) return;
    const order = slots[car];
    const next = order === null ? (direction > 0 ? 1 : match.teamCount) : order + direction;
    if (next < 1 || next > match.teamCount) return;
    setOrder(car, next);
    $(`record-${car}`).focus();
  }

  // 이전·다음 주행: 두 차량을 (n, n+1) 짝으로 두 칸씩 옮긴다. 팀 수가 홀수면 마지막 주행의 B는 빈 자리.
  function moveRun(direction) {
    if (!isRunning() || dialogOpen()) return;
    const base = runBase();
    if (base === null) return;
    const nextBase = base + direction * 2;
    if (nextBase < 1 || nextBase > match.teamCount) return;
    slots.A = nextBase;
    slots.B = nextBase + 1 <= match.teamCount ? nextBase + 1 : null;
    renderRunning();
    save();
    $("announcement").textContent = `${direction > 0 ? "다음" : "이전"} 주행. 차량 A ${teamLabel(slots.A)}, 차량 B ${teamLabel(slots.B)}`;
    $("record-A").focus();
  }

  function adjust(team, delta) {
    if (!match || overlay !== "list" || !validOrder(team, match.teamCount)) return;
    if (delta > 0) {
      match.events.push({ team, at: Date.now(), car: null, manual: true });
    } else {
      let index = match.events.length - 1;
      while (index >= 0 && match.events[index].team !== team) index -= 1;
      if (index < 0) return;
      match.events.splice(index, 1);
    }
    if (match.status === "finished") match.endedAt = Date.now();
    save();
    renderList();
    const message = `${teamLabel(team)} 침범 ${formatCount(teamTotals()[team - 1])}회로 정정`;
    $("list-status").textContent = message;
    $("announcement").textContent = message;
    const again = $("list-rows").querySelector(`button[data-team="${team}"][data-delta="${delta}"]`);
    const fallback = $("list-rows").querySelector(`button[data-team="${team}"][data-delta="1"]`);
    (again && !again.disabled ? again : fallback)?.focus();
  }

  function setName(team, value) {
    if (!match || !validOrder(team, match.teamCount)) return;
    const name = cleanName(value);
    match.teamNames[team - 1] = name;
    save();
    return name;
  }

  function showList() {
    if (!match) return;
    $("settings-dialog").close();
    overlay = "list";
    $("list-status").textContent = "";
    $("names-bulk").open = false;
    stopVoice();
    render();
    $("list-title").focus();
  }

  function downloadCsv() {
    const shown = activeResult();
    if (!shown) return;
    try {
      const filename = window.RefereeCsv.download(shown);
      $("csv-status").textContent = `CSV 다운로드 요청: ${filename}`;
      $("csv-status").classList.remove("error");
    } catch {
      $("csv-status").textContent = "다운로드하지 못했습니다. 결과 다운로드를 다시 눌러주세요.";
      $("csv-status").classList.add("error");
    }
  }

  function showSetupError(id, message) {
    $("team-count-error").hidden = true;
    $("team-names-error").hidden = true;
    $("team-count").removeAttribute("aria-invalid");
    $("team-names").removeAttribute("aria-invalid");
    if (!message) return;
    $(`${id}-error`).textContent = message;
    $(`${id}-error`).hidden = false;
    $(id).setAttribute("aria-invalid", "true");
    $(id).focus();
  }

  const selectedMode = () => {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked && isMode(checked.value) ? checked.value : "regular";
  };

  function setSetupMode(mode) {
    const radio = document.querySelector(`input[name="mode"][value="${isMode(mode) ? mode : "regular"}"]`);
    if (radio) radio.checked = true;
  }

  $("setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (currentView() !== "setup") return;
    const names = parseNames($("team-names").value);
    while (names.length && names[names.length - 1] === "") names.pop();
    let teamCount = $("team-count").valueAsNumber;
    // 팀 수를 비우고 팀명만 적으면 줄 수가 팀 수가 된다.
    if (Number.isNaN(teamCount) && names.length) teamCount = names.length;
    if (!validTeamCount(teamCount)) {
      showSetupError("team-count", `팀 수는 1~${MAX_TEAMS} 사이의 정수로 입력하세요.`);
      return;
    }
    if (names.length > teamCount) {
      showSetupError("team-names", `팀명이 ${names.length}줄인데 팀 수는 ${teamCount}입니다. 팀 수를 늘리거나 줄을 줄이세요.`);
      return;
    }
    showSetupError(null);
    const mode = selectedMode();
    match = {
      mode, round: 1, teamCount, startedAt: Date.now(), endedAt: null, status: "running",
      events: [], teamNames: normalizeNames(names, teamCount),
    };
    normalizeWinners(match);
    normalizeOvertakes(match);
    overlay = null;
    resultTab = mode;
    resultRound = teamCount;
    defaultSlots(teamCount);
    $("csv-status").textContent = "";
    stopVoice();
    save();
    render();
    $("record-A").focus();
    $("announcement").textContent = `${MODES[mode]} ${teamCount}팀 경기 시작. 차량 A ${teamLabel(slots.A)}, 차량 B ${teamLabel(slots.B)}`;
  });

  for (const car of CARS) {
    $(`record-${car}`).addEventListener("click", () => record(car));
    $(`prev-${car}`).addEventListener("click", () => stepOrder(car, -1));
    $(`next-${car}`).addEventListener("click", () => stepOrder(car, 1));
    $(`order-${car}`).addEventListener("change", (event) => {
      const value = event.target.value;
      setOrder(car, value === "" ? null : Number(value));
      $(`record-${car}`).focus();
    });
    $(`voice-${car}`).addEventListener("change", (event) => {
      if (!isVoice(event.target.value)) return;
      settings.voices[car] = event.target.value;
      audioError = "";
      stopVoice();
      renderAudio();
      save();
    });
    $(`overtake-${car}`).addEventListener("click", () => toggleOvertake(car));
    // 미리 듣기: 그 차량이 맡은 팀명이 있으면 실제 판정과 같게 들려준다.
    $(`preview-${car}`).addEventListener("click", () => {
      playVoice(car, match && slots[car] !== null ? teamName(slots[car]) : "");
    });
    // 판정 화면의 팀명 칸: Enter나 칸 밖 클릭으로 저장하고 침범 버튼으로 돌아간다. Esc는 되돌린다.
    const commitCardName = () => {
      const order = slots[car];
      const input = $(`name-${car}`);
      if (!isRunning() || order === null) return;
      const before = teamName(order);
      const name = setName(order, input.value);
      input.value = name;
      renderRunning();
      if (name !== before) $("announcement").textContent = name ? `${order}번 팀명: ${name}` : `${order}번 팀명 지움`;
    };
    $(`name-${car}`).addEventListener("change", commitCardName);
    $(`name-${car}`).addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commitCardName();
        event.target.blur();
        $(`record-${car}`).focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.target.value = slots[car] === null ? "" : teamName(slots[car]);
        event.target.blur();
        $(`record-${car}`).focus();
      }
    });
  }
  $("prev-run").addEventListener("click", () => moveRun(-1));
  $("next-run").addEventListener("click", () => moveRun(1));
  $("undo-button").addEventListener("click", undoLast);

  // 초기화 확인 창. 전체(설정의 “전체 기록 초기화”)와 차량 카드의 “횟수 초기화”(재경기용)가 같은 창을 쓴다.
  function openResetDialog(target) {
    resetTarget = target;
    if (target === "all") {
      $("reset-title").textContent = "판정 기록을 초기화할까요?";
      $("reset-description").textContent = "현재 경기의 모든 주행 순서 판정 기록이 삭제됩니다. 삭제한 기록은 되돌릴 수 없습니다.";
    } else {
      const order = slots[target];
      const count = match.events.filter((event) => event.team === order).length;
      const overtake = overtakerOf(match, order) !== null ? " 그 대진의 추월 표시도 지웁니다." : "";
      $("reset-title").textContent = `${teamLabel(order)} 침범 횟수를 초기화할까요?`;
      $("reset-description").textContent = `차량 ${target}가 맡은 ${teamLabel(order)}의 침범 기록 ${formatCount(count)}건이 삭제됩니다. 재경기 전에 쓰세요.${overtake} 삭제한 기록은 되돌릴 수 없습니다.`;
    }
    $("settings-dialog").close();
    $("reset-dialog").returnValue = "";
    $("reset-dialog").showModal();
  }

  // 재경기: 그 차량이 맡은 주행 순서의 침범 기록만 지운다. 본선이면 그 대진의 추월 표시와 진출 선택도 되돌린다.
  function resetOrder(car) {
    const order = slots[car];
    if (!validOrder(order, match.teamCount)) return;
    const before = match.events.length;
    match.events = match.events.filter((event) => event.team !== order);
    let overtakeCleared = false;
    if (match.mode === "tournament") {
      const index = pairOf(order) - 1;
      if (match.overtakes[index] !== null) {
        match.overtakes[index] = null;
        match.winners[index] = null;
        overtakeCleared = true;
      }
    }
    stopVoice();
    renderRunning();
    save();
    $(`record-${car}`).focus();
    $("announcement").textContent = `${teamLabel(order)} 침범 기록 ${formatCount(before - match.events.length)}건 삭제${overtakeCleared ? ", 추월 표시 지움" : ""}`;
  }

  $("reset-button").addEventListener("click", () => {
    if (!isRunning() || match.events.length === 0) return;
    openResetDialog("all");
  });
  for (const car of CARS) {
    $(`reset-car-${car}`).addEventListener("click", () => {
      if (!isRunning() || dialogOpen() || slots[car] === null) return;
      openResetDialog(car);
    });
  }
  $("reset-form").addEventListener("submit", (event) => {
    if (event.submitter?.value !== "confirm") return;
    event.preventDefault();
    $("reset-dialog").close("confirm");
    if (!isRunning()) return;
    if (resetTarget !== "all") {
      resetOrder(resetTarget);
      return;
    }
    match.events = [];
    if (match.mode === "tournament") {
      match.overtakes.fill(null);
      match.winners = [];
      normalizeWinners(match);
    }
    stopVoice();
    renderRunning();
    save();
    $("record-A").focus();
    $("announcement").textContent = "모든 주행 순서의 판정 기록 초기화";
  });

  $("show-results-button").addEventListener("click", () => {
    if (!isRunning()) return;
    match.status = "finished";
    match.endedAt = Date.now();
    resultTab = match.mode;
    resultRound = match.teamCount;
    suggestWinners(match);
    $("csv-status").textContent = "";
    $("csv-status").classList.remove("error");
    stopVoice();
    save();
    render();
    $("result-title").focus();
    $("announcement").textContent = `${modeLabel(match)} 경기 결과`;
  });
  $("resume-button").addEventListener("click", () => {
    if (match?.status !== "finished") return;
    match.status = "running";
    match.endedAt = null;
    overlay = null;
    stopVoice();
    save();
    render();
    $("record-A").focus();
  });
  $("download-button").addEventListener("click", downloadCsv);
  for (const mode of MODE_KEYS) {
    $(`tab-${mode}`).addEventListener("click", () => {
      if (currentView() !== "result") return;
      resultTab = mode;
      $("csv-status").textContent = "";
      $("csv-status").classList.remove("error");
      renderResult();
      const shown = activeResult();
      $("announcement").textContent = shown ? `${modeLabel(shown)} 결과` : `${MODES[mode]} 결과 없음`;
    });
  }
  // 대진 카드에서 진출 팀 고르기. 현재 경기의 결과에서만 바꿀 수 있다.
  $("result-bracket").addEventListener("click", (event) => {
    const pick = event.target.closest("button[data-pair]");
    if (!pick || currentView() !== "result") return;
    const shown = activeResult();
    if (!shown || shown !== match || match.mode !== "tournament") return;
    const index = Number(pick.dataset.pair);
    const order = Number(pick.dataset.team);
    if (!Number.isInteger(index) || index < 0 || index >= match.winners.length) return;
    match.winners[index] = match.winners[index] === order ? null : order;
    save();
    renderResult();
    const name = teamName(order) || `${order}번`;
    $("announcement").textContent = match.winners[index] === order
      ? `대진 ${index + 1} 진출: ${name}` : `대진 ${index + 1} 진출 선택 해제`;
    $("result-bracket").querySelector(`button[data-pair="${index}"][data-team="${order}"]`)?.focus();
  });

  // 진출 팀으로 다음 라운드를 짠다. 주행 순서는 위에서부터 1번으로 다시 매긴다.
  $("next-round-button").addEventListener("click", () => {
    if (currentView() !== "result") return;
    const shown = activeResult();
    if (!shown || shown !== match || match.mode !== "tournament") return;
    const winners = match.winners;
    if (winners.length < 2 || winners.some((order) => order === null)) return;
    const names = winners.map((order) => teamName(order));
    const teamCount = winners.length;
    const round = (match.round || 1) + 1;
    save();
    match = {
      mode: "tournament", round, teamCount, startedAt: Date.now(), endedAt: null, status: "running",
      events: [], teamNames: normalizeNames(names, teamCount),
    };
    normalizeWinners(match);
    normalizeOvertakes(match);
    overlay = null;
    resultTab = "tournament";
    resultRound = teamCount;
    defaultSlots(teamCount);
    $("csv-status").textContent = "";
    $("csv-status").classList.remove("error");
    stopVoice();
    save();
    render();
    $("record-A").focus();
    $("announcement").textContent = `${roundLabel(teamCount)} 시작. 진출 ${teamCount}팀`;
  });

  $("download-all").addEventListener("click", () => {
    const rounds = tournamentRounds();
    if (!rounds.length) return;
    try {
      const filename = window.RefereeCsv.downloadAll(rounds);
      $("csv-status").textContent = `CSV 다운로드 요청: ${filename}`;
      $("csv-status").classList.remove("error");
    } catch {
      $("csv-status").textContent = "다운로드하지 못했습니다. 다시 눌러주세요.";
      $("csv-status").classList.add("error");
    }
  });

  $("result-rounds").addEventListener("click", (event) => {
    const chip = event.target.closest("button[data-round]");
    if (!chip || currentView() !== "result") return;
    resultRound = Number(chip.dataset.round);
    $("csv-status").textContent = "";
    $("csv-status").classList.remove("error");
    renderResult();
    $("announcement").textContent = `${roundLabel(resultRound)} 결과`;
  });
  $("new-match-button").addEventListener("click", () => {
    if (match?.status !== "finished") return;
    overlay = "setup";
    setSetupMode(match.mode);
    $("team-count").value = match.teamCount;
    $("team-names").value = match.teamNames.join("\n").replace(/\n+$/, "");
    showSetupError(null);
    render();
    $("team-count").focus();
    $("team-count").select();
  });
  $("back-to-result").addEventListener("click", () => {
    if (match?.status !== "finished") return;
    overlay = null;
    render();
    $("download-button").focus();
  });

  $("list-button").addEventListener("click", showList);
  $("result-list-button").addEventListener("click", showList);
  $("audio-inline").addEventListener("click", () => {
    if (isRunning()) $("settings-dialog").showModal();
  });
  $("list-back").addEventListener("click", () => {
    if (overlay !== "list") return;
    overlay = null;
    if (match.status === "finished") {
      resultTab = match.mode;
      resultRound = match.teamCount;
    }
    render();
    (match.status === "running" ? $("record-A") : $("download-button")).focus();
  });
  $("list-rows").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-team]");
    if (!button) return;
    adjust(Number(button.dataset.team), Number(button.dataset.delta));
  });
  // 팀명 칸: 입력을 마치면(포커스 이동·Enter) 저장한다. 목록을 다시 그리지 않아 Tab으로 계속 입력할 수 있다.
  $("list-rows").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-team]");
    if (!input) return;
    const team = Number(input.dataset.team);
    const name = setName(team, input.value);
    input.value = name;
    $("list-status").textContent = name ? `${team}번 팀명: ${name}` : `${team}번 팀명 지움`;
  });
  $("list-rows").addEventListener("keydown", (event) => {
    const input = event.target.closest("input[data-team]");
    if (!input || event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const next = $("list-rows").querySelector(`input[data-team="${Number(input.dataset.team) + 1}"]`);
    if (next) next.focus();
    else input.blur();
  });
  $("names-bulk").addEventListener("toggle", () => {
    if ($("names-bulk").open && match) $("bulk-names").value = match.teamNames.join("\n");
  });
  $("apply-names").addEventListener("click", () => {
    if (!match || overlay !== "list") return;
    const names = parseNames($("bulk-names").value);
    for (let index = 0; index < match.teamCount; index += 1) match.teamNames[index] = names[index] || "";
    save();
    renderList();
    const filled = match.teamNames.filter(Boolean).length;
    const ignored = Math.max(names.length - match.teamCount, 0);
    $("list-status").textContent = `팀명 ${filled}개 적용${ignored ? ` (넘치는 ${ignored}줄은 무시)` : ""}`;
    $("announcement").textContent = $("list-status").textContent;
  });

  $("legacy-download").addEventListener("click", () => {
    if (!legacyEvents.length) return;
    try {
      window.RefereeCsv.download({
        mode: null, teamCount: 0, startedAt: null, endedAt: null, teamNames: [],
        events: legacyEvents.map((at) => ({ team: null, at, car: null })),
      });
      $("legacy-download").textContent = "이전 기록 CSV 다시 받기";
    } catch {
      storageError("이전 기록 CSV 다운로드 실패. 다시 시도하세요.");
    }
  });

  $("sound-toggle").addEventListener("click", () => {
    settings.soundEnabled = !settings.soundEnabled;
    if (!settings.soundEnabled) stopVoice();
    else audioError = "";
    renderAudio();
    save();
  });
  $("name-toggle").addEventListener("click", () => {
    settings.speakNames = !settings.speakNames;
    if (!settings.speakNames && canSpeak) {
      try {
        speech.cancel();
      } catch {
        // 취소를 지원하지 않는 브라우저
      }
    }
    logAudio(`팀명 읽기 ${settings.speakNames ? "켬" : "끔"}`);
    renderAudio();
    save();
  });
  $("volume").addEventListener("input", (event) => {
    settings.volume = Number(event.target.value);
    for (const clip of activeClips) clip.volume = settings.volume / 100;
    renderAudio();
    save();
  });
  $("test-voice").addEventListener("click", () => {
    logAudio("음성 테스트 시작");
    playClip(settings.voices.A, {
      onEnded: () => speakTeamName("A", "테스트 팀"),
      onFail: (reason) => logAudio(`음성 테스트 실패: ${reason}`),
    });
    renderAudio();
  });
  $("copy-diag").addEventListener("click", async () => {
    const text = diagnosticsText();
    try {
      // 클립보드 권한 창이 멈춰 있어도 곧 텍스트 선택으로 넘어가도록 시간을 제한한다.
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
      ]);
      $("copy-diag").textContent = "복사했습니다";
    } catch {
      const range = document.createRange();
      range.selectNodeContents($("audio-diag-text"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      $("copy-diag").textContent = "선택했습니다. 길게 눌러 복사하세요";
    }
    setTimeout(() => { $("copy-diag").textContent = "진단 내용 복사"; }, 2500);
  });

  $("settings-button").addEventListener("click", () => {
    if (isRunning()) $("settings-dialog").showModal();
  });
  $("close-settings").addEventListener("click", () => $("settings-dialog").close());
  $("settings-dialog").addEventListener("close", () => {
    if (isRunning() && !$("reset-dialog").open) $("record-A").focus();
  });

  $("fullscreen-button").hidden = typeof document.documentElement.requestFullscreen !== "function";
  $("fullscreen-button").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      $("screen-status").textContent = "";
    } catch {
      $("screen-status").textContent = "전체 화면을 열지 못했습니다. 브라우저의 전체 화면 기능을 사용하세요.";
    }
  });
  document.addEventListener("fullscreenchange", () => {
    const label = document.fullscreenElement ? "전체 화면 해제" : "전체 화면";
    $("fullscreen-button").querySelector("span").textContent = label;
    $("fullscreen-button").setAttribute("aria-label", label);
  });

  // 왼쪽 Shift → 차량 A, 오른쪽 Shift → 차량 B, ← → → 이전·다음 주행, Backspace → 마지막 판정 취소
  document.addEventListener("keydown", (event) => {
    if (!isRunning() || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || dialogOpen()) return;
    const target = event.target;
    // 입력 칸에서는 Shift가 대문자·쌍자음 입력에 쓰이므로 판정으로 가로채지 않는다.
    if (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]")) return;
    // Space는 판정 키가 아니다. 판정 뒤 포커스가 침범 버튼에 있으므로, 버튼이 눌리는 기본 동작만 막는다.
    // (Enter는 버튼을 누르는 표준 동작이라 그대로 둔다. 다른 버튼의 Space도 그대로.)
    if (event.code === "Space" && target.closest(".record-button")) {
      event.preventDefault();
      return;
    }
    if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
      event.preventDefault();
      if (!event.repeat) record(event.code === "ShiftLeft" ? "A" : "B");
      return;
    }
    if (event.code === "Backspace") {
      event.preventDefault();
      if (!event.repeat) undoLast();
      return;
    }
    if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      event.preventDefault();
      if (!event.repeat) moveRun(event.code === "ArrowLeft" ? -1 : 1);
    }
  });

  function loadLogo(index = 0) {
    if (index >= LOGO_FILES.length) return;
    const probe = new Image();
    probe.addEventListener("load", () => {
      $("brand-logo").src = LOGO_FILES[index];
      $("brand-logo").hidden = false;
      $("brand-glyph").hidden = true;
      $("brand-mark").classList.add("has-logo");
    });
    probe.addEventListener("error", () => loadLogo(index + 1));
    probe.src = LOGO_FILES[index];
  }

  if (canSpeak) {
    loadKoreanVoices();
    // 목소리 목록은 늦게 채워지는 브라우저가 있다.
    speech.addEventListener?.("voiceschanged", loadKoreanVoices);
  }
  if (match) setSetupMode(match.mode);
  loadLogo();
  render();
  renderAudio();
  preloadVoices();
})();
