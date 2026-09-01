const STORE_KEY = "sks-enpf-schema-v3";

const state = {
  floor: 1,
  mode: "scheme",
  selectedId: null,
  hoverId: null,
  data: null,
  drag: null
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version >= 3 && parsed.cables && parsed.rooms && parsed.geometry) {
        state.data = parsed;
        return;
      }
    }
  } catch (e) { /* ignore */ }
  state.data = buildDefaultState();
}

function saveLocal() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state.data));
}

function roomOf(floor, id) { return state.data.rooms[floor][id]; }
function cableById(id) { return state.data.cables.find((c) => c.id === id); }
function roomsOnFloor(floor) { return Object.values(state.data.rooms[floor]); }

function interpolateCorridor(floor, x) {
  const pts = [...state.data.geometry[floor].corridor].sort((a, b) => a.x - b.x);
  if (x <= pts[0].x) return { x, y: pts[0].y };
  if (x >= pts[pts.length - 1].x) return { x, y: pts[pts.length - 1].y };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = (x - a.x) / Math.max(b.x - a.x, 0.001);
      return { x, y: a.y + (b.y - a.y) * t };
    }
  }
  return { x, y: pts[0].y };
}

function roomDoor(floor, roomId) {
  const room = roomOf(floor, roomId);
  const cx = room.bbox.x + room.bbox.w / 2;
  const p = interpolateCorridor(floor, cx);
  return p;
}

function socketPos(floor, roomId, socketNo) {
  const room = roomOf(floor, roomId);
  return room.sockets[socketNo - 1] || {
    x: room.bbox.x + room.bbox.w / 2,
    y: room.bbox.y + room.bbox.h / 2
  };
}

function pathPoints(cable) {
  const floor = cable.floor;
  const sock = socketPos(floor, cable.room, cable.socket);
  const room = roomOf(floor, cable.room);
  const door = roomDoor(floor, cable.room);
  const pts = [{ x: sock.x, y: sock.y }];
  if (room.via) {
    const via = roomOf(floor, room.via);
    const viaC = { x: via.bbox.x + via.bbox.w / 2, y: via.bbox.y + via.bbox.h / 2 };
    pts.push({ x: sock.x, y: viaC.y });
    pts.push(viaC);
    const viaDoor = roomDoor(floor, room.via);
    pts.push({ x: viaC.x, y: viaDoor.y });
    pts.push(viaDoor);
  } else {
    pts.push({ x: sock.x, y: door.y });
    pts.push(door);
  }
  const g = state.data.geometry[floor];
  if (floor === 1) {
    const sleeve = g.sleeve;
    const from = pts[pts.length - 1];
    pts.push(interpolateCorridor(1, from.x));
    pts.push(interpolateCorridor(1, sleeve.x));
    pts.push({ x: sleeve.x, y: sleeve.y });
  } else {
    const hub = g.sleeve;
    const from = pts[pts.length - 1];
    pts.push(interpolateCorridor(2, from.x));
    pts.push(interpolateCorridor(2, hub.x));
    pts.push({ x: hub.x, y: hub.y });
    pts.push({ x: g.tambour.x, y: g.tambour.y });
    pts.push({ x: g.server.x, y: g.server.y });
  }
  return pts;
}

function toD(pts) {
  return pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function installProgress(c) {
  const vals = INSTALL_KEYS.map(([k]) => c.install[k]);
  return Math.round(100 * vals.filter(Boolean).length / vals.length);
}

function overallProgress() {
  const all = state.data.cables;
  if (!all.length) return 0;
  return Math.round(all.reduce((s, c) => s + installProgress(c), 0) / all.length);
}

function renderOverlay() {
  const svg = document.getElementById("overlay");
  svg.innerHTML = "";
  const floor = state.floor;
  const g = state.data.geometry[floor];

  const cables = state.data.cables.filter((c) => c.floor === floor);
  for (const cable of cables) {
    const d = toD(pathPoints(cable));
    const confirmed = cable.routeConfirmed;
    const hot = state.selectedId === cable.id || state.hoverId === cable.id;
    const path = svgEl("path", {
      d,
      class: "route" + (state.selectedId && state.selectedId !== cable.id && state.hoverId !== cable.id ? " dim" : "") + (hot ? " hot" : ""),
      stroke: cable.color,
      "stroke-width": hot ? 0.55 : 0.28,
      "stroke-dasharray": confirmed ? "none" : "0.9 0.55",
      "data-id": cable.id,
      fill: "none"
    });
    const hit = svgEl("path", {
      d,
      fill: "none",
      stroke: "transparent",
      "stroke-width": 1.4,
      "data-id": cable.id,
      class: "route"
    });
    const bind = (el) => {
      el.addEventListener("mouseenter", (e) => onHover(cable, e));
      el.addEventListener("mousemove", (e) => onHover(cable, e));
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("click", (e) => { e.stopPropagation(); selectCable(cable.id); });
    };
    bind(hit); bind(path);
    svg.appendChild(hit);
    svg.appendChild(path);
  }

  if (floor === 2) {
    const riser = toD([g.sleeve, g.tambour, g.server]);
    const rp = svgEl("path", {
      d: riser, fill: "none", stroke: "#00e5ff", "stroke-width": 0.7,
      "stroke-dasharray": "1.1 0.5", class: "route"
    });
    rp.addEventListener("mouseenter", (e) => showTip(e, "<b>Пучок 1 этажа</b><br>44 кабеля из гильзы A1 → тамбур 16 → серверная №14"));
    rp.addEventListener("mousemove", (e) => showTip(e, "<b>Пучок 1 этажа</b><br>44 кабеля из гильзы A1 → тамбур 16 → серверная №14"));
    rp.addEventListener("mouseleave", hideTip);
    svg.appendChild(rp);
  }

  for (const room of roomsOnFloor(floor)) {
    room.sockets.forEach((s, i) => {
      const c = svgEl("circle", {
        cx: s.x, cy: s.y, r: 0.85,
        fill: room.color, stroke: "#fff", "stroke-width": 0.18,
        class: "socket", "data-kind": "socket", "data-floor": floor, "data-room": room.id, "data-socket": String(i)
      });
      svg.appendChild(c);
      const lb = svgEl("text", { x: s.x + 1.0, y: s.y - 0.7, fill: "#f4f7fa", class: "label" });
      lb.textContent = `${room.id}-${i + 1}`;
      svg.appendChild(lb);
    });
  }

  const sleeve = svgEl("circle", {
    cx: g.sleeve.x, cy: g.sleeve.y, r: 1.35,
    fill: "#0b1c22", stroke: "#00e5ff", "stroke-width": 0.35,
    class: "anchor", "data-kind": "sleeve"
  });
  svg.appendChild(sleeve);
  svg.appendChild(svgEl("circle", { cx: g.sleeve.x, cy: g.sleeve.y, r: 0.45, fill: "#00e5ff", class: "anchor", "data-kind": "sleeve" }));
  const sl = svgEl("text", { x: g.sleeve.x + 1.6, y: g.sleeve.y - 1.1, fill: "#00e5ff", class: "label", "font-size": "1.9" });
  sl.textContent = floor === 1 ? "A1 гильза ↑ в №14  · ТРЕБУЕТ УТОЧНЕНИЯ" : "A1 гильза (выход с 1 эт.)";
  svg.appendChild(sl);

  g.corridor.forEach((p) => {
    svg.appendChild(svgEl("rect", {
      x: p.x - 0.7, y: p.y - 0.7, width: 1.4, height: 1.4,
      fill: "#3d9cf0", stroke: "#fff", "stroke-width": 0.12,
      class: "anchor", "data-kind": "corridor", "data-id": p.id
    }));
  });

  if (floor === 2) {
    svg.appendChild(svgEl("circle", {
      cx: g.tambour.x, cy: g.tambour.y, r: 0.9,
      fill: "#f4d03f", stroke: "#fff", "stroke-width": 0.15,
      class: "anchor", "data-kind": "tambour"
    }));
    const tt = svgEl("text", { x: g.tambour.x + 1.3, y: g.tambour.y + 0.5, fill: "#f4d03f", class: "label" });
    tt.textContent = "тамбур 16";
    svg.appendChild(tt);
    svg.appendChild(svgEl("rect", {
      x: g.server.x - 1.1, y: g.server.y - 1.1, width: 2.2, height: 2.2,
      fill: "#ff6b5c", stroke: "#fff", "stroke-width": 0.15,
      class: "anchor", "data-kind": "server"
    }));
    const st = svgEl("text", { x: g.server.x + 1.5, y: g.server.y + 0.4, fill: "#ff6b5c", class: "label" });
    st.textContent = "шкаф";
    svg.appendChild(st);

    const r = g.serverRoom;
    svg.appendChild(svgEl("rect", {
      x: r.x, y: r.y, width: r.w, height: r.h,
      fill: "rgba(255,107,92,.16)", stroke: "#ff6b5c", "stroke-width": 0.35,
      "stroke-dasharray": "0.8 0.5", rx: 0.4,
      class: "zone-locked",
      "pointer-events": "none"
    }));
    const zt = svgEl("text", { x: r.x + 0.5, y: r.y + 2.3, fill: "#ff6b5c", class: "label", "font-size": "1.8" });
    zt.textContent = "Серверная №14";
    svg.appendChild(zt);
  }
}

function showTip(e, html) {
  const tip = document.getElementById("tooltip");
  tip.innerHTML = html;
  tip.style.display = "block";
  tip.style.left = e.clientX + 14 + "px";
  tip.style.top = e.clientY + 14 + "px";
}

function hideTip() {
  state.hoverId = null;
  document.getElementById("tooltip").style.display = "none";
  if (state.mode === "scheme") renderOverlay();
}

function onHover(cable, e) {
  state.hoverId = cable.id;
  showTip(e, `<b>${cable.id}</b><br>Этаж: ${cable.floor}<br>Кабинет: ${cable.room} · ${roomOf(cable.floor, cable.room).name}<br>Розетка: ${cable.socket}, порт ${cable.port}<br>Назначение: ${cable.purpose}${cable.routeConfirmed ? "" : "<br><span style='color:#e8a317'>ТРЕБУЕТ УТОЧНЕНИЯ</span>"}`);
}

function selectCable(id) {
  state.selectedId = id;
  renderOverlay();
  renderDetail();
}

function renderDetail() {
  const box = document.getElementById("detail");
  const c = cableById(state.selectedId);
  if (!c) {
    box.innerHTML = `<h2>Кабель не выбран</h2><p class="hint">Наведите на трассу: ID, этаж, кабинет, розетка, назначение. Кликните для правки.</p>`;
    return;
  }
  const room = roomOf(c.floor, c.room);
  const roomOpts = roomsOnFloor(c.floor).map((r) => `<option value="${r.id}" ${r.id === c.room ? "selected" : ""}>${r.id} · ${r.name}</option>`).join("");
  box.innerHTML = `
    <h2>${c.id}</h2>
    <div class="badge">${c.routeConfirmed ? "Трасса отмечена как уточнённая" : "ТРЕБУЕТ УТОЧНЕНИЯ"}</div>
    <div class="field"><label>ID кабеля</label><input id="fId" value="${c.id}" /></div>
    <div class="field"><label>Кабинет</label><select id="fRoom">${roomOpts}</select></div>
    <div class="field"><label>Розетка</label><input id="fSock" type="number" min="1" value="${c.socket}" /></div>
    <div class="field"><label>Порт</label><input id="fPort" type="number" min="1" max="2" value="${c.port}" /></div>
    <div class="field"><label>Цвет линии</label><input id="fColor" type="color" value="${c.color}" /></div>
    <div class="field"><label>Назначение</label><input id="fPurpose" value="${c.purpose}" /></div>
    <div class="field"><label>Патч-панель</label><input id="fPatch" value="${c.patchPanel}" placeholder="пока пусто" /></div>
    <div class="field"><label>Порт коммутатора</label><input id="fSw" value="${c.switchPort}" placeholder="пока пусто" /></div>
    <div class="field"><label>Примечание</label><textarea id="fNotes">${c.notes}</textarea></div>
    <label class="check"><input id="fConf" type="checkbox" ${c.routeConfirmed ? "checked" : ""} /> Трасса уточнена на объекте (убрать пунктир)</label>
    <h3>Контроль монтажа</h3>
    ${INSTALL_KEYS.map(([k, lab]) => `<label class="check"><input type="checkbox" data-inst="${k}" ${c.install[k] ? "checked" : ""} /> ${lab}</label>`).join("")}
    <div class="progress"><span style="width:${installProgress(c)}%"></span></div>
    <button type="button" id="btnApply">Сохранить поля</button>
    <button type="button" id="btnDel" style="margin-left:6px;border-color:#e85d4c;color:#e85d4c">Удалить кабель</button>
  `;
  document.getElementById("btnApply").onclick = () => applyDetail(c);
  document.getElementById("btnDel").onclick = () => deleteCable(c.id);
  box.querySelectorAll("[data-inst]").forEach((el) => {
    el.addEventListener("change", () => {
      c.install[el.getAttribute("data-inst")] = el.checked;
      persist();
      renderDetail();
    });
  });
}

function applyDetail(c) {
  const nid = document.getElementById("fId").value.trim();
  if (!nid) return alert("ID не может быть пустым");
  if (nid !== c.id && cableById(nid)) return alert("Такой ID уже есть");
  const roomId = document.getElementById("fRoom").value;
  const sock = Number(document.getElementById("fSock").value);
  const room = roomOf(c.floor, roomId);
  while (room.sockets.length < sock) {
    room.sockets.push({
      x: room.bbox.x + room.bbox.w / 2,
      y: room.bbox.y + room.bbox.h / 2
    });
  }
  c.id = nid;
  c.room = roomId;
  c.socket = sock;
  c.port = Number(document.getElementById("fPort").value);
  c.color = document.getElementById("fColor").value;
  c.purpose = document.getElementById("fPurpose").value;
  c.patchPanel = document.getElementById("fPatch").value;
  c.switchPort = document.getElementById("fSw").value;
  c.notes = document.getElementById("fNotes").value;
  c.routeConfirmed = document.getElementById("fConf").checked;
  state.selectedId = c.id;
  persist();
  renderOverlay();
  renderDetail();
}

function deleteCable(id) {
  if (!confirm("Удалить кабель " + id + "?")) return;
  state.data.cables = state.data.cables.filter((c) => c.id !== id);
  state.selectedId = null;
  persist();
  renderOverlay();
  renderDetail();
}

function persist() {
  saveLocal();
}

function setFloor(n) {
  state.floor = n;
  document.querySelectorAll("#floorSeg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.floor) === n));
  document.getElementById("planImg").src = n === 1 ? "plans/floor1.jpg" : "plans/floor2.jpg";
  renderOverlay();
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("page-scheme").classList.toggle("active", mode === "scheme");
  document.getElementById("page-control").classList.toggle("active", mode === "control");
  document.getElementById("page-table").classList.toggle("active", mode === "table");
  document.getElementById("page-accept").classList.toggle("active", mode === "accept");
  if (mode === "control") renderControl();
  if (mode === "table") renderTable();
  if (mode === "accept") renderAccept();
}

function renderControl() {
  const el = document.getElementById("page-control");
  const pct = overallProgress();
  const rows = state.data.cables.map((c) => {
    const boxes = INSTALL_KEYS.map(([k, lab]) =>
      `<label title="${lab}"><input type="checkbox" data-id="${c.id}" data-k="${k}" ${c.install[k] ? "checked" : ""} /></label>`
    ).join("");
    return `<tr data-row="${c.id}"><td>${c.id}</td><td>${c.floor}</td><td>${c.room} ${roomOf(c.floor, c.room).name}</td><td>${c.socket}/${c.port}</td>${INSTALL_KEYS.map(([k]) => `<td>${c.install[k] ? "✓" : ""}</td>`).join("")}<td>${boxes}</td></tr>`;
  }).join("");
  el.innerHTML = `
    <h2>Контроль монтажа</h2>
    <p class="hint">Отмечайте факты по каждой линии. Прогресс: <b>${pct}%</b> · кабелей ${state.data.cables.length}</p>
    <div class="progress"><span style="width:${pct}%"></span></div>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>ID</th><th>Эт.</th><th>Кабинет</th><th>Роз/порт</th>${INSTALL_KEYS.map(([, l]) => `<th>${l.replace("Кабель ", "").replace("Линия ", "")}</th>`).join("")}<th>Отметки</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  el.querySelectorAll("input[type=checkbox]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const c = cableById(inp.getAttribute("data-id"));
      if (c) c.install[inp.getAttribute("data-k")] = inp.checked;
      persist();
      renderControl();
    });
  });
}

function renderTable() {
  const el = document.getElementById("page-table");
  const rows = state.data.cables.map((c) => `
    <tr class="${c.id === state.selectedId ? "selected" : ""}" data-id="${c.id}">
      <td>${c.id}</td><td>${c.floor}</td>
      <td>${c.room} · ${roomOf(c.floor, c.room).name}</td>
      <td>${c.socket}</td><td>${c.port}</td>
      <td>${c.patchPanel || "—"}</td><td>${c.switchPort || "—"}</td>
      <td>${c.purpose}</td><td>${c.notes || ""}</td>
      <td>${c.routeConfirmed ? "уточнена" : "ТРЕБУЕТ УТОЧНЕНИЯ"}</td>
    </tr>`).join("");
  el.innerHTML = `
    <h2>Таблица кабелей</h2>
    <p class="hint">Патч-панель и порт коммутатора пока пустые — заполните после коммутации. Клик по строке открывает карточку на схеме.</p>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>ID кабеля</th><th>Этаж</th><th>Кабинет</th><th>Розетка</th><th>Порт</th><th>Патч-панель</th><th>Порт коммутатора</th><th>Назначение</th><th>Примечание</th><th>Трасса</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  el.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const c = cableById(tr.getAttribute("data-id"));
      state.selectedId = c.id;
      setFloor(c.floor);
      setMode("scheme");
      renderDetail();
    });
  });
}

function renderAccept() {
  const el = document.getElementById("page-accept");
  el.innerHTML = `
    <h2>Что проверить у подрядчика перед сдачей СКС</h2>
    <p class="hint">Это чеклист приёмки строительной части. Отметки хранятся в браузере вместе со схемой.</p>
    <ul class="checklist" id="acceptList">
      ${CHECKLIST.map((t, i) => {
        const on = (state.data.accept && state.data.accept[i]) ? "checked" : "";
        return `<li><input type="checkbox" data-i="${i}" ${on} /><span>${t}</span></li>`;
      }).join("")}
    </ul>`;
  el.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("change", () => {
      if (!state.data.accept) state.data.accept = [];
      state.data.accept[Number(inp.dataset.i)] = inp.checked;
      persist();
    });
  });
}

function clientToSvg(evt) {
  const svg = document.getElementById("overlay");
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const m = svg.getScreenCTM().inverse();
  const p = pt.matrixTransform(m);
  return {
    x: Math.max(0, Math.min(100, p.x)),
    y: Math.max(0, Math.min(100, p.y))
  };
}

function onPointerDown(e) {
  const t = e.target;
  if (!t.classList || (!t.classList.contains("anchor") && !t.classList.contains("socket"))) return;
  const kind = t.getAttribute("data-kind");
  state.drag = { kind, el: t };
  if (kind === "socket") {
    state.drag.floor = Number(t.getAttribute("data-floor"));
    state.drag.room = t.getAttribute("data-room");
    state.drag.index = Number(t.getAttribute("data-socket"));
  }
  if (kind === "corridor") state.drag.id = t.getAttribute("data-id");
  e.preventDefault();
}

function onPointerMove(e) {
  if (!state.drag) return;
  const p = clientToSvg(e);
  const g = state.data.geometry[state.floor];
  if (state.drag.kind === "socket") {
    const room = roomOf(state.drag.floor, state.drag.room);
    room.sockets[state.drag.index] = p;
  } else if (state.drag.kind === "sleeve") {
    g.sleeve = p;
  } else if (state.drag.kind === "tambour") {
    g.tambour = p;
  } else if (state.drag.kind === "server") {
    g.server = p;
  } else if (state.drag.kind === "corridor") {
    const pt = g.corridor.find((c) => c.id === state.drag.id);
    if (pt) { pt.x = p.x; pt.y = p.y; }
  }
  renderOverlay();
}

function onPointerUp() {
  if (state.drag) {
    state.drag = null;
    persist();
  }
}

function downloadText(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportJSON() {
  downloadText("sks-schema.json", JSON.stringify(state.data, null, 2), "application/json");
}

function exportCSV() {
  const headers = ["ID кабеля", "Этаж", "Кабинет", "Название", "Розетка", "Порт", "Патч-панель", "Порт коммутатора", "Назначение", "Примечание", "Трасса", ...INSTALL_KEYS.map(([, l]) => l)];
  const lines = [headers.join(";")];
  for (const c of state.data.cables) {
    const room = roomOf(c.floor, c.room);
    const row = [
      c.id, c.floor, c.room, room.name, c.socket, c.port,
      c.patchPanel, c.switchPort, c.purpose, (c.notes || "").replace(/;/g, ","),
      c.routeConfirmed ? "уточнена" : "ТРЕБУЕТ УТОЧНЕНИЯ",
      ...INSTALL_KEYS.map(([k]) => c.install[k] ? "да" : "нет")
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
    lines.push(row.join(";"));
  }
  downloadText("sks-cables.csv", "\uFEFF" + lines.join("\n"), "text/csv;charset=utf-8");
}

function fillNewRooms() {
  const floor = Number(document.getElementById("newFloor").value);
  const sel = document.getElementById("newRoom");
  sel.innerHTML = roomsOnFloor(floor).map((r) => `<option value="${r.id}">${r.id} · ${r.name}</option>`).join("");
}

function openAdd() {
  fillNewRooms();
  document.getElementById("modalBack").classList.add("open");
}

function addCable() {
  const floor = Number(document.getElementById("newFloor").value);
  const room = document.getElementById("newRoom").value;
  const socket = Number(document.getElementById("newSocket").value);
  const port = Number(document.getElementById("newPort").value);
  const id = `${floor}-${room}-${socket}-${port}`;
  if (cableById(id)) { alert("Кабель " + id + " уже есть"); return; }
  const r = roomOf(floor, room);
  while (r.sockets.length < socket) {
    r.sockets.push({ x: r.bbox.x + r.bbox.w / 2, y: r.bbox.y + r.bbox.h / 2 });
  }
  state.data.cables.push({
    id, floor, room, socket, port,
    color: document.getElementById("newColor").value,
    purpose: document.getElementById("newPurpose").value,
    notes: "", patchPanel: "", switchPort: "",
    routeConfirmed: false, install: emptyInstall()
  });
  document.getElementById("modalBack").classList.remove("open");
  state.selectedId = id;
  persist();
  setFloor(floor);
  renderDetail();
}

function init() {
  loadState();
  document.getElementById("planImg").addEventListener("load", renderOverlay);
  setFloor(1);
  document.querySelectorAll("#floorSeg button").forEach((b) => b.onclick = () => setFloor(Number(b.dataset.floor)));
  document.querySelectorAll("#modeSeg button").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
  document.getElementById("btnAdd").onclick = openAdd;
  document.getElementById("btnSave").onclick = exportJSON;
  document.getElementById("btnCsv").onclick = exportCSV;
  document.getElementById("btnReset").onclick = () => {
    if (!confirm("Вернуть розетки, гильзу и коридор к исходным точкам? Отметки монтажа сохранятся, если совпадут ID.")) {
      return;
    }
    const old = state.data.cables;
    const lockedZone = state.data.geometry[2] && state.data.geometry[2].serverRoom
      ? JSON.parse(JSON.stringify(state.data.geometry[2].serverRoom))
      : null;
    const fresh = buildDefaultState();
    const byId = Object.fromEntries(old.map((c) => [c.id, c]));
    for (const c of fresh.cables) {
      const prev = byId[c.id];
      if (prev) {
        c.install = prev.install;
        c.patchPanel = prev.patchPanel;
        c.switchPort = prev.switchPort;
        c.routeConfirmed = prev.routeConfirmed;
        c.notes = prev.notes;
        c.purpose = prev.purpose;
      }
    }
    fresh.accept = state.data.accept;
    if (lockedZone) fresh.geometry[2].serverRoom = lockedZone;
    state.data = fresh;
    persist();
    renderOverlay();
    renderDetail();
  };
  document.getElementById("btnLoad").onclick = () => document.getElementById("fileLoad").click();
  document.getElementById("fileLoad").onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.cables || !parsed.rooms) throw new Error("bad");
        state.data = parsed;
        persist();
        setFloor(state.floor);
        renderDetail();
        alert("Схема загружена");
      } catch (err) { alert("Не удалось прочитать файл схемы"); }
    };
    reader.readAsText(f);
  };
  document.getElementById("newFloor").onchange = fillNewRooms;
  document.getElementById("newCancel").onclick = () => document.getElementById("modalBack").classList.remove("open");
  document.getElementById("newOk").onclick = addCable;
  const svg = document.getElementById("overlay");
  svg.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("click", (e) => {
    if (e.target === svg) { state.selectedId = null; hideTip(); renderDetail(); renderOverlay(); }
  });
}

init();