const STORE_KEY = "sks-enpf-schema-v5";

const state = {
  floor: 1,
  mode: "scheme",
  selectedId: null,
  hoverId: null,
  data: null,
  drag: null,
  addBend: false,
  justAddedBend: false
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function migrateGeometry(data) {
  if (data && data.geometry && data.geometry[1] && data.geometry[1].serverRoom && (data.version || 0) >= 5) {
    return data;
  }
  const fresh = buildDefaultState();
  data.geometry = fresh.geometry;
  data.version = 5;
  return data;
}

function loadState() {
  try {
    let raw = localStorage.getItem(STORE_KEY);
    if (!raw) raw = localStorage.getItem("sks-enpf-schema-v4");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.cables && parsed.rooms && parsed.geometry) {
        state.data = migrateGeometry(parsed);
        saveLocal();
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

function socketBends(room, socketNo) {
  if (!room.bends) room.bends = {};
  const k = String(socketNo);
  if (!Array.isArray(room.bends[k])) room.bends[k] = [];
  return room.bends[k];
}

function pathPoints(cable) {
  const floor = cable.floor;
  const sock = socketPos(floor, cable.room, cable.socket);
  const room = roomOf(floor, cable.room);
  const door = roomDoor(floor, cable.room);
  const bends = socketBends(room, cable.socket);
  const pts = [{ x: sock.x, y: sock.y }];
  if (bends.length) {
    for (const b of bends) pts.push({ x: b.x, y: b.y });
  } else if (room.via) {
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
  const from = pts[pts.length - 1];
  pts.push(interpolateCorridor(floor, from.x));
  if (floor === 1) {
    const entry = g.entry || g.sleeve;
    pts.push(interpolateCorridor(1, entry.x));
    pts.push({ x: entry.x, y: entry.y });
    pts.push({ x: g.server.x, y: g.server.y });
  } else {
    pts.push(interpolateCorridor(2, g.sleeve.x));
    pts.push({ x: g.sleeve.x, y: g.sleeve.y });
  }
  return pts;
}

function polyLengthM(pts, floor) {
  const s = PLAN_SCALE[floor] || PLAN_SCALE[1];
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i].x - pts[i - 1].x) * s.x;
    const dy = (pts[i].y - pts[i - 1].y) * s.y;
    m += Math.hypot(dx, dy);
  }
  return m;
}

function cableLengthM(cable) {
  let m = polyLengthM(pathPoints(cable), cable.floor);
  if (cable.floor === 2) {
    const g1 = state.data.geometry[1];
    if (g1 && g1.sleeve && g1.server) {
      const extra = [g1.sleeve];
      if (g1.entry) extra.push(g1.entry);
      extra.push(g1.server);
      m += polyLengthM(extra, 1);
    }
    m += FLOOR_HEIGHT_M;
  }
  m += CABLE_SLACK_M;
  return m;
}

function totalCableLengthM(floor) {
  return state.data.cables
    .filter((c) => floor == null || c.floor === floor)
    .reduce((s, c) => s + cableLengthM(c), 0);
}

function formatLen(m) {
  return m.toFixed(1).replace(".", ",") + " м";
}

function projectSeg(a, b, p) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy || 1;
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  const q = { x: a.x + t * vx, y: a.y + t * vy };
  return { q, t, d: Math.hypot(p.x - q.x, p.y - q.y) };
}

function autoEntryBends(cable) {
  const sock = socketPos(cable.floor, cable.room, cable.socket);
  const room = roomOf(cable.floor, cable.room);
  const door = roomDoor(cable.floor, cable.room);
  if (room.via) {
    const via = roomOf(cable.floor, room.via);
    const viaC = { x: via.bbox.x + via.bbox.w / 2, y: via.bbox.y + via.bbox.h / 2 };
    const viaDoor = roomDoor(cable.floor, room.via);
    return [
      { x: sock.x, y: viaC.y },
      { x: viaC.x, y: viaC.y },
      { x: viaC.x, y: viaDoor.y },
      { x: viaDoor.x, y: viaDoor.y }
    ];
  }
  return [
    { x: sock.x, y: door.y },
    { x: door.x, y: door.y }
  ];
}

function seedBendsIfEmpty(cable) {
  const room = roomOf(cable.floor, cable.room);
  const bends = socketBends(room, cable.socket);
  if (!bends.length) {
    for (const b of autoEntryBends(cable)) bends.push({ x: b.x, y: b.y });
  }
  return bends;
}

function insertBendAt(cable, p) {
  const bends = seedBendsIfEmpty(cable);
  const sock = socketPos(cable.floor, cable.room, cable.socket);
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.9;
  if (near(p, sock) || bends.some((b) => near(p, b))) return;
  const chain = [{ x: sock.x, y: sock.y }, ...bends];
  let bestI = chain.length - 1, bestD = Infinity;
  for (let i = 0; i < chain.length; i++) {
    const b = i < chain.length - 1 ? chain[i + 1] : interpolateCorridor(cable.floor, chain[i].x);
    const hit = projectSeg(chain[i], b, p);
    if (hit.d < bestD) {
      bestD = hit.d;
      bestI = i;
    }
  }
  bends.splice(bestI, 0, { x: p.x, y: p.y });
}

function setAddBend(on) {
  state.addBend = !!on;
  document.body.classList.toggle("adding-bend", state.addBend);
}

function toD(pts) {
  return pts.map((p, i) => `${i ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

function offsetPoly(pts, dist) {
  const p = [];
  for (const pt of pts) {
    if (!p.length || p[p.length - 1].x !== pt.x || p[p.length - 1].y !== pt.y) p.push(pt);
  }
  if (p.length < 2) return pts.map((pt) => ({ x: pt.x, y: pt.y + dist }));
  const nrm = [];
  for (let i = 0; i < p.length - 1; i++) {
    const dx = p[i + 1].x - p[i].x, dy = p[i + 1].y - p[i].y;
    const len = Math.hypot(dx, dy) || 1;
    nrm.push({ x: -dy / len, y: dx / len });
  }
  return p.map((pt, i) => {
    let nx, ny;
    if (i === 0) {
      nx = nrm[0].x;
      ny = nrm[0].y;
    } else if (i === p.length - 1) {
      nx = nrm[nrm.length - 1].x;
      ny = nrm[nrm.length - 1].y;
    } else {
      nx = nrm[i - 1].x + nrm[i].x;
      ny = nrm[i - 1].y + nrm[i].y;
      const l = Math.hypot(nx, ny);
      if (l < 0.001) {
        nx = nrm[i].x;
        ny = nrm[i].y;
      } else {
        nx /= l;
        ny /= l;
        const miter = Math.min(3.5, 1 / Math.max(0.28, nrm[i - 1].x * nx + nrm[i - 1].y * ny));
        nx *= miter;
        ny *= miter;
      }
    }
    return { x: pt.x + nx * dist, y: pt.y + ny * dist };
  });
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

function renderOverlay(target, opts) {
  const svg = target && target.appendChild ? target : document.getElementById("overlay");
  const forExport = !!(opts && opts.forExport);
  if (forExport) {
    [...svg.childNodes].forEach((n) => {
      if (!n.tagName || n.tagName.toLowerCase() !== "style") n.remove();
    });
  } else {
    svg.innerHTML = "";
  }
  const floor = state.floor;
  const g = state.data.geometry[floor];

  if (floor === 1 && g.serverRoom) {
    const r = g.serverRoom;
    svg.appendChild(svgEl("rect", {
      x: r.x, y: r.y, width: r.w, height: r.h,
      fill: "rgba(255,107,92,.18)", stroke: "#ff6b5c", "stroke-width": 0.35,
      "stroke-dasharray": "0.8 0.5", rx: 0.4,
      class: forExport ? "zone" : "anchor zone",
      "data-kind": "zone"
    }));
    const zt = svgEl("text", { x: r.x + 0.5, y: r.y + 2.2, fill: "#ff6b5c", class: "label", "font-size": "1.7" });
    zt.textContent = "Серверная · №6 водители";
    svg.appendChild(zt);
  }

  const cables = state.data.cables.filter((c) => c.floor === floor);
  for (const cable of cables) {
    const pts = pathPoints(cable);
    const hot = !forExport && (state.selectedId === cable.id || state.hoverId === cable.id);
    const dim = !forExport && state.selectedId && state.selectedId !== cable.id && state.hoverId !== cable.id;
    const off = forExport ? 0.16 : (hot ? 0.2 : 0.14);
    const sw = forExport ? 0.22 : (hot ? 0.3 : 0.18);
    const cls = "route" + (dim ? " dim" : "") + (hot ? " hot" : "");
    if (!forExport) {
      const hit = svgEl("path", {
        d: toD(pts),
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
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (state.addBend || state.justAddedBend) return;
          selectCable(cable.id);
        });
      };
      bind(hit);
      svg.appendChild(hit);
      for (const rail of [offsetPoly(pts, off), offsetPoly(pts, -off)]) {
        const path = svgEl("path", {
          d: toD(rail),
          class: cls,
          stroke: cable.color,
          "stroke-width": sw,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          "data-id": cable.id,
          fill: "none"
        });
        bind(path);
        svg.appendChild(path);
      }
    } else {
      for (const rail of [offsetPoly(pts, off), offsetPoly(pts, -off)]) {
        svg.appendChild(svgEl("path", {
          d: toD(rail),
          class: "route",
          stroke: cable.color,
          "stroke-width": sw,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          fill: "none"
        }));
      }
    }
  }

  if (floor === 1 && g.entry && g.server) {
    const riserPts = [g.sleeve, g.entry, g.server];
    const riserOff = 0.22;
    const riserW = 0.32;
    for (const rail of [offsetPoly(riserPts, riserOff), offsetPoly(riserPts, -riserOff)]) {
      const rp = svgEl("path", {
        d: toD(rail), fill: "none", stroke: "#00e5ff", "stroke-width": riserW,
        "stroke-linecap": "round", "stroke-linejoin": "round", class: "route"
      });
      if (!forExport) {
        rp.addEventListener("mouseenter", (e) => showTip(e, "<b>Пучок 2 этажа</b><br>28 кабелей из гильзы A1 → коридор №7 → комната водителей №6"));
        rp.addEventListener("mousemove", (e) => showTip(e, "<b>Пучок 2 этажа</b><br>28 кабелей из гильзы A1 → коридор №7 → комната водителей №6"));
        rp.addEventListener("mouseleave", hideTip);
      }
      svg.appendChild(rp);
    }
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
  sl.textContent = floor === 1 ? "A1 гильза (спуск с 2 эт.) · у санузла" : "A1 гильза ↓ в комнату водителей №6";
  svg.appendChild(sl);

  if (!forExport) {
    g.corridor.forEach((p) => {
      svg.appendChild(svgEl("rect", {
        x: p.x - 0.7, y: p.y - 0.7, width: 1.4, height: 1.4,
        fill: "#3d9cf0", stroke: "#fff", "stroke-width": 0.12,
        class: "anchor", "data-kind": "corridor", "data-id": p.id
      }));
    });
  }

  if (floor === 1 && g.server) {
    if (g.entry && !forExport) {
      svg.appendChild(svgEl("circle", {
        cx: g.entry.x, cy: g.entry.y, r: 0.9,
        fill: "#f4d03f", stroke: "#fff", "stroke-width": 0.15,
        class: "anchor", "data-kind": "entry"
      }));
      const et = svgEl("text", { x: g.entry.x + 1.3, y: g.entry.y + 0.5, fill: "#f4d03f", class: "label" });
      et.textContent = "вход в №6";
      svg.appendChild(et);
    }
    svg.appendChild(svgEl("rect", {
      x: g.server.x - 1.1, y: g.server.y - 1.1, width: 2.2, height: 2.2,
      fill: "#ff6b5c", stroke: "#fff", "stroke-width": 0.15,
      class: "anchor", "data-kind": "server"
    }));
    const st = svgEl("text", { x: g.server.x + 1.5, y: g.server.y + 0.4, fill: "#ff6b5c", class: "label" });
    st.textContent = "шкаф";
    svg.appendChild(st);
  }

  if (floor === 1 && g.serverRoom && !forExport) {
    const r = g.serverRoom;
    const corners = [
      { id: "nw", x: r.x, y: r.y },
      { id: "ne", x: r.x + r.w, y: r.y },
      { id: "sw", x: r.x, y: r.y + r.h },
      { id: "se", x: r.x + r.w, y: r.y + r.h }
    ];
    for (const c of corners) {
      svg.appendChild(svgEl("rect", {
        x: c.x - 0.75, y: c.y - 0.75, width: 1.5, height: 1.5,
        fill: "#ff6b5c", stroke: "#fff", "stroke-width": 0.14,
        class: "anchor zone-handle",
        "data-kind": "zone-handle",
        "data-corner": c.id
      }));
    }
  }

  const sel = !forExport ? cableById(state.selectedId) : null;
  if (sel && sel.floor === floor) {
    const bends = socketBends(roomOf(floor, sel.room), sel.socket);
    bends.forEach((b, i) => {
      const d = svgEl("rect", {
        x: b.x - 0.75, y: b.y - 0.75, width: 1.5, height: 1.5,
        transform: `rotate(45 ${b.x} ${b.y})`,
        fill: "#ffe566", stroke: "#1a1a1a", "stroke-width": 0.16,
        class: "bend", "data-kind": "bend",
        "data-room": sel.room,
        "data-socket": String(sel.socket),
        "data-index": String(i)
      });
      d.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        e.preventDefault();
        socketBends(roomOf(floor, sel.room), sel.socket).splice(i, 1);
        persist();
        renderOverlay();
        renderDetail();
      });
      svg.appendChild(d);
    });
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
  if (state.mode === "scheme" && !state.drag) renderOverlay();
}

function onHover(cable, e) {
  state.hoverId = cable.id;
  showTip(e, `<b>${cable.id}</b><br>Этаж: ${cable.floor}<br>Кабинет: ${cable.room} · ${roomOf(cable.floor, cable.room).name}<br>Розетка: ${cable.socket}, порт ${cable.port}<br>Длина: ${formatLen(cableLengthM(cable))}<br>Назначение: ${cable.purpose}${cable.routeConfirmed ? "" : "<br><span style='color:#e8a317'>ТРЕБУЕТ УТОЧНЕНИЯ</span>"}`);
}

function selectCable(id) {
  if (state.selectedId !== id) setAddBend(false);
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
  const len = cableLengthM(c);
  const lenWarn = len > 90;
  box.innerHTML = `
    <h2>${c.id}</h2>
    <div class="badge">${c.routeConfirmed ? "Трасса отмечена как уточнённая" : "ТРЕБУЕТ УТОЧНЕНИЯ"}</div>
    <div class="field"><label>ID кабеля</label><input id="fId" value="${c.id}" /></div>
    <div class="field"><label>Кабинет</label><select id="fRoom">${roomOpts}</select></div>
    <div class="field"><label>Розетка</label><input id="fSock" type="number" min="1" value="${c.socket}" /></div>
    <div class="field"><label>Порт</label><input id="fPort" type="number" min="1" max="2" value="${c.port}" /></div>
    <div class="field"><label>Цвет линии</label><input id="fColor" type="color" value="${c.color}" /></div>
    <div class="field"><label>Назначение</label><input id="fPurpose" value="${c.purpose}" /></div>
    <div class="field"><label>Длина кабеля</label><input id="fLen" value="${formatLen(len)}" readonly ${lenWarn ? 'style="color:#e85d4c;font-weight:650"' : ""} /></div>
    <p class="hint">Ориентир по размерам стен на чертеже, плюс запас ${String(CABLE_SLACK_M).replace(".", ",")} м у шкафа${c.floor === 2 ? " и межэтаж " + String(FLOOR_HEIGHT_M).replace(".", ",") + " м" : ""}. Не замена промеру на объекте.${lenWarn ? " <b style='color:#e85d4c'>Больше 90 м — для Cat 6 это предел канала.</b>" : ""}</p>
    <div class="field"><label>Патч-панель</label><input id="fPatch" value="${c.patchPanel}" placeholder="пока пусто" /></div>
    <div class="field"><label>Порт коммутатора</label><input id="fSw" value="${c.switchPort}" placeholder="пока пусто" /></div>
    <div class="field"><label>Примечание</label><textarea id="fNotes">${c.notes}</textarea></div>
    <label class="check"><input id="fConf" type="checkbox" ${c.routeConfirmed ? "checked" : ""} /> Трасса уточнена на объекте</label>
    <h3>Изгибы в кабинет</h3>
    <p class="hint">Оба порта этой розетки идут по одним углам. Жёлтые ромбы можно таскать, двойной клик по ромбу — удалить угол.</p>
    <div class="bend-actions">
      <button type="button" id="btnBend" class="${state.addBend ? "primary" : ""}">${state.addBend ? "Готово" : "Добавить изгиб"}</button>
      <button type="button" id="btnBendClear">Сбросить изгибы</button>
    </div>
    ${state.addBend ? "<p class=\"hint\">Кликните по трассе или по плану — новый угол встанет на ближайший участок.</p>" : ""}
    <h3>Контроль монтажа</h3>
    ${INSTALL_KEYS.map(([k, lab]) => `<label class="check"><input type="checkbox" data-inst="${k}" ${c.install[k] ? "checked" : ""} /> ${lab}</label>`).join("")}
    <div class="progress"><span style="width:${installProgress(c)}%"></span></div>
    <button type="button" id="btnApply">Сохранить поля</button>
    <button type="button" id="btnDel" style="margin-left:6px;border-color:#e85d4c;color:#e85d4c">Удалить кабель</button>
  `;
  document.getElementById("btnApply").onclick = () => applyDetail(c);
  document.getElementById("btnDel").onclick = () => deleteCable(c.id);
  document.getElementById("btnBend").onclick = () => {
    if (state.addBend) {
      setAddBend(false);
    } else {
      seedBendsIfEmpty(c);
      persist();
      setAddBend(true);
    }
    renderOverlay();
    renderDetail();
  };
  document.getElementById("btnBendClear").onclick = () => {
    const room = roomOf(c.floor, c.room);
    if (room.bends) room.bends[String(c.socket)] = [];
    setAddBend(false);
    persist();
    renderOverlay();
    renderDetail();
  };
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
  document.getElementById("planImg").src = n === 1 ? "plans/floor1.jpg?v=16" : "plans/floor2.jpg?v=16";
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
  const total = totalCableLengthM();
  const t1 = totalCableLengthM(1);
  const t2 = totalCableLengthM(2);
  const n = state.data.cables.length;
  const n1 = state.data.cables.filter((c) => c.floor === 1).length;
  const n2 = state.data.cables.filter((c) => c.floor === 2).length;
  const rows = state.data.cables.map((c) => `
    <tr class="${c.id === state.selectedId ? "selected" : ""}" data-id="${c.id}">
      <td>${c.id}</td><td>${c.floor}</td>
      <td>${c.room} · ${roomOf(c.floor, c.room).name}</td>
      <td>${c.socket}</td><td>${c.port}</td>
      <td>${formatLen(cableLengthM(c))}</td>
      <td>${c.patchPanel || "—"}</td><td>${c.switchPort || "—"}</td>
      <td>${c.purpose}</td><td>${c.notes || ""}</td>
      <td>${c.routeConfirmed ? "уточнена" : "ТРЕБУЕТ УТОЧНЕНИЯ"}</td>
    </tr>`).join("");
  el.innerHTML = `
    <h2>Таблица кабелей</h2>
    <p class="hint">Длины по стенам с чертежей размеров (корпус 36,80×14,60 м, коридор 2 эт. 23,94 м, h=3,00 м) плюс запас ${String(CABLE_SLACK_M).replace(".", ",")} м у шкафа. Не замена промеру на объекте. Клик по строке открывает карточку на схеме.</p>
    <div class="totals">
      <div><b>Итого</b><span>${formatLen(total)}</span><small>${n} каб.</small></div>
      <div>1 этаж<span>${formatLen(t1)}</span><small>${n1} каб.</small></div>
      <div>2 этаж<span>${formatLen(t2)}</span><small>${n2} каб.</small></div>
    </div>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>ID кабеля</th><th>Этаж</th><th>Кабинет</th><th>Розетка</th><th>Порт</th><th>Длина</th><th>Патч-панель</th><th>Порт коммутатора</th><th>Назначение</th><th>Примечание</th><th>Трасса</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="5">Итого</td>
            <td>${formatLen(total)}</td>
            <td colspan="5">${n} кабелей · 1 эт. ${formatLen(t1)} · 2 эт. ${formatLen(t2)}</td>
          </tr>
        </tfoot>
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
  if (t.classList && t.classList.contains("bend")) {
    const kind = t.getAttribute("data-kind");
    state.drag = {
      kind,
      room: t.getAttribute("data-room"),
      socket: Number(t.getAttribute("data-socket")),
      index: Number(t.getAttribute("data-index"))
    };
    e.preventDefault();
    return;
  }
  if (state.addBend && state.selectedId) {
    if (t.classList && (t.classList.contains("socket") || t.classList.contains("anchor"))) {
      /* fall through to drag sockets / anchors */
    } else {
      const c = cableById(state.selectedId);
      if (c && c.floor === state.floor) {
        insertBendAt(c, clientToSvg(e));
        persist();
        state.justAddedBend = true;
        renderOverlay();
        renderDetail();
      }
      e.preventDefault();
      return;
    }
  }
  if (!t.classList || (!t.classList.contains("anchor") && !t.classList.contains("socket"))) return;
  const kind = t.getAttribute("data-kind");
  state.drag = { kind, el: t };
  if (kind === "socket") {
    state.drag.floor = Number(t.getAttribute("data-floor"));
    state.drag.room = t.getAttribute("data-room");
    state.drag.index = Number(t.getAttribute("data-socket"));
  }
  if (kind === "corridor") state.drag.id = t.getAttribute("data-id");
  if (kind === "zone") {
    const r = state.data.geometry[state.floor].serverRoom;
    const p = clientToSvg(e);
    state.drag.offX = p.x - r.x;
    state.drag.offY = p.y - r.y;
  }
  if (kind === "zone-handle") state.drag.corner = t.getAttribute("data-corner");
  e.preventDefault();
}

function onPointerMove(e) {
  if (!state.drag) return;
  const p = clientToSvg(e);
  const g = state.data.geometry[state.floor];
  if (state.drag.kind === "socket") {
    const room = roomOf(state.drag.floor, state.drag.room);
    room.sockets[state.drag.index] = p;
  } else if (state.drag.kind === "bend") {
    const room = roomOf(state.floor, state.drag.room);
    const bends = socketBends(room, state.drag.socket);
    if (bends[state.drag.index]) {
      bends[state.drag.index] = { x: p.x, y: p.y };
    }
  } else if (state.drag.kind === "sleeve") {
    g.sleeve = p;
  } else if (state.drag.kind === "entry" || state.drag.kind === "tambour") {
    if (g.entry) g.entry = p;
    else g.tambour = p;
  } else if (state.drag.kind === "server") {
    g.server = p;
  } else if (state.drag.kind === "zone") {
    const r = g.serverRoom;
    if (r) {
      r.x = p.x - state.drag.offX;
      r.y = p.y - state.drag.offY;
    }
  } else if (state.drag.kind === "zone-handle") {
    resizeServerRoom(g.serverRoom, state.drag.corner, p);
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
    if (state.selectedId) renderDetail();
  }
}

function resizeServerRoom(r, corner, p) {
  if (!r) return;
  let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  if (corner === "nw" || corner === "sw") x1 = p.x;
  if (corner === "ne" || corner === "se") x2 = p.x;
  if (corner === "nw" || corner === "ne") y1 = p.y;
  if (corner === "sw" || corner === "se") y2 = p.y;
  r.x = Math.min(x1, x2);
  r.y = Math.min(y1, y2);
  r.w = Math.max(2, Math.abs(x2 - x1));
  r.h = Math.max(2, Math.abs(y2 - y1));
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
  const headers = ["ID кабеля", "Этаж", "Кабинет", "Название", "Розетка", "Порт", "Длина м", "Патч-панель", "Порт коммутатора", "Назначение", "Примечание", "Трасса", ...INSTALL_KEYS.map(([, l]) => l)];
  const lines = [headers.join(";")];
  for (const c of state.data.cables) {
    const room = roomOf(c.floor, c.room);
    const row = [
      c.id, c.floor, c.room, room.name, c.socket, c.port,
      cableLengthM(c).toFixed(1).replace(".", ","),
      c.patchPanel, c.switchPort, c.purpose, (c.notes || "").replace(/;/g, ","),
      c.routeConfirmed ? "уточнена" : "ТРЕБУЕТ УТОЧНЕНИЯ",
      ...INSTALL_KEYS.map(([k]) => c.install[k] ? "да" : "нет")
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
    lines.push(row.join(";"));
  }
  const totalRow = [
    "ИТОГО", "", "", "", "", state.data.cables.length,
    totalCableLengthM().toFixed(1).replace(".", ","),
    "", "", "", "", "",
    ...INSTALL_KEYS.map(() => "")
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
  lines.push(totalRow.join(";"));
  downloadText("sks-cables.csv", "\uFEFF" + lines.join("\n"), "text/csv;charset=utf-8");
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("blob"))), "image/jpeg", quality);
    } catch (err) {
      reject(err);
    }
  });
}

async function exportJPEG() {
  const plan = document.getElementById("planImg");
  const btn = document.getElementById("btnJpeg");
  const prevLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Готовлю JPEG…";
  try {
    const planSrc = (typeof PLAN_JPEG !== "undefined" && PLAN_JPEG[state.floor])
      ? PLAN_JPEG[state.floor]
      : (plan.currentSrc || plan.src);
    const planBmp = await loadImg(planSrc);
    if (!planBmp.naturalWidth) throw new Error("plan");
    const scale = planBmp.naturalWidth < 2200 ? 2 : 1;
    const w = Math.round(planBmp.naturalWidth * scale);
    const h = Math.round(planBmp.naturalHeight * scale);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("xmlns", NS);
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("preserveAspectRatio", "none");
    const css = document.createElementNS(NS, "style");
    css.textContent = "text{font-family:'Segoe UI',Arial,sans-serif;font-size:2.1px}";
    svg.appendChild(css);
    renderOverlay(svg, { forExport: true });
    const xml = new XMLSerializer().serializeToString(svg);
    const overlayImg = await loadImg("data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(planBmp, 0, 0, w, h);
    ctx.drawImage(overlayImg, 0, 0, w, h);
    const blob = await canvasToJpegBlob(canvas, 0.92);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sks-etazh-${state.floor}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (err) {
    alert("Не удалось сохранить JPEG. Обновите страницу (Ctrl+F5) и попробуйте снова.");
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
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
  document.getElementById("btnJpeg").onclick = () => exportJPEG();
  document.getElementById("btnReset").onclick = () => {
    if (!confirm("Вернуть розетки, гильзу и коридор к исходным точкам? Отметки монтажа сохранятся, если совпадут ID.")) {
      return;
    }
    const old = state.data.cables;
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
        state.data = migrateGeometry(parsed);
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
    if (state.justAddedBend) {
      state.justAddedBend = false;
      return;
    }
    if (state.addBend) return;
    if (e.target === svg) {
      state.selectedId = null;
      setAddBend(false);
      hideTip();
      renderDetail();
      renderOverlay();
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.addBend) {
      setAddBend(false);
      renderDetail();
    }
  });
}

init();