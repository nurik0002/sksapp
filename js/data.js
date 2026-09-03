/* Рабочая схема СКС — не официальный проект.
   Координаты — доли изображения 0..100. Геометрия ориентировочная: ТРЕБУЕТ УТОЧНЕНИЯ. */

const INSTALL_KEYS = [
  ["laid", "Кабель проложен"],
  ["labeled", "Кабель промаркирован"],
  ["outlet", "Розетка установлена"],
  ["inServer", "Кабель заведён в серверную"],
  ["patched", "Кабель подключен к патч-панели"],
  ["tested", "Линия протестирована"],
  ["passed", "Тест пройден"]
];

/* Метры на 1% плана. Калибровка по чертежам «размеры 1 этаж» / «размеры 2 этаж»:
   корпус 36,80 × 14,60 м; глубина кабинетов 5,50 / 5,43 м; коридор 1,85 м;
   2 эт. коридор 23,94 м; высота помещений h=3,00 / 3,05 м. */
const PLAN_SCALE = {
  1: { x: 0.400, y: 0.245 },
  2: { x: 0.370, y: 0.265 }
};
const CABLE_SLACK_M = 3;
const FLOOR_HEIGHT_M = 3.3;

const ROOM_SPECS = {
  1: [
    { id: "1", name: "Холл", sockets: 3, color: "#f0a202", side: "south", bbox: [70.8, 34.8, 12.4, 22],
      purposes: [["Информационный стенд", "Информационный стенд (резерв)"], ["Терминал СУЭО", "Терминал СУЭО (резерв)"], ["Самообслуживание, ПК", "Самообслуживание, телефон"]],
      notes: "За ресепшн, на стены зала ожидания. Отдельной розетки на ресепшн нет." },
    { id: "3", name: "ОВО", sockets: 9, color: "#3d9cf0", side: "south", bbox: [25.4, 34.8, 23.8, 22],
      notes: "13 мест + сетевые принтеры. Розетки по периметру." },
    { id: "10", name: "Колл-центр", sockets: 1, color: "#62c462", side: "north", bbox: [15.6, 8.2, 6.6, 22.8],
      notes: "2 рабочих места, одна двухпортовая розетка." },
    { id: "12", name: "Зам. директора", sockets: 1, color: "#c77dff", side: "north", bbox: [38.0, 8.2, 8.2, 22.8] },
    { id: "13", name: "Операционный отдел", sockets: 2, color: "#ff6b8a", side: "north", bbox: [46.2, 8.2, 14.4, 22.8],
      notes: "4 рабочих места, без СУЭО." },
    { id: "14", name: "Отделение ОО", sockets: 5, color: "#2ec4b6", side: "north", bbox: [60.6, 8.2, 21.8, 22.8],
      notes: "5 розеток по периметру зала. Посадка неизвестна." },
    { id: "15", name: "Обучение", sockets: 1, color: "#f4d03f", side: "south", bbox: [49.4, 34.8, 13.4, 22] }
  ],
  2: [
    { id: "10", name: "Адм. отдел", sockets: 2, color: "#5dade2", side: "north", bbox: [21.8, 9.2, 8.8, 20.8],
      notes: "4 рабочих места, 2 розетки." },
    { id: "10.1", name: "Кабинет IT", sockets: 2, color: "#58d68d", side: "north", bbox: [30.8, 9.2, 8.8, 20.8] },
    { id: "11", name: "Кабинет юриста", sockets: 2, color: "#af7ac5", side: "north", bbox: [39.8, 9.2, 7.8, 20.8] },
    { id: "12", name: "Архив", sockets: 1, color: "#d4ac0d", side: "north", bbox: [47.8, 9.2, 16.6, 20.8],
      notes: "Стеллажи не разводим." },
    { id: "13", name: "Кабинет аудитора", sockets: 1, color: "#85929e", side: "north", bbox: [66.8, 9.2, 6.4, 16.6] },
    { id: "17", name: "Отдел контроля", sockets: 4, color: "#e67e22", side: "north", bbox: [81.2, 9.2, 13.6, 20.8],
      notes: "7 человек, 8 портов." },
    { id: "18", name: "Приёмная", sockets: 1, color: "#48c9b0", side: "south", bbox: [81.0, 35.6, 7.2, 9.6] },
    { id: "19", name: "Кабинет директора", sockets: 1, color: "#e74c3c", side: "south", bbox: [81.0, 45.4, 13.8, 9.4],
      via: "18", notes: "Заход через приёмную №18." }
  ]
};

const CHECKLIST = [
  "Количество розеток совпадает со схемой: 36 розеток, 72 кабеля",
  "Маркировка одинакова на обоих концах каждого кабеля (формат этаж-кабинет-розетка-порт)",
  "Кабель не ниже категории 6 (лучше Cat 6A), как запрашивали у арендодателя",
  "Топология звезда: нет последовательного соединения розеток",
  "Кабели в коробах/лотках, без прокладки по полу прохода и по ступеням",
  "Нет заломов, пережимов стяжками и повреждённой оболочки",
  "Сетевые трассы отделены от силовых (ориентир не менее 250 мм от мощных лотков)",
  "Гильза A1: через перекрытие коридора у санузла, не через кабинеты арендодателя и не по лестнице",
  "Огнезащита проходки перекрытия выполнена, пучок закреплён на вертикали",
  "В комнате водителей №6 (серверная) есть запас кабеля у шкафа",
  "Соблюдены радиусы изгиба (для Cat 6 обычно не меньше 4 внешних диаметров)",
  "Розетки на стенах, в коробе, оба порта подписаны",
  "Каждая линия прозвонена/протестирована кабельным тестером",
  "Есть результаты теста (pass/fail) по каждому ID",
  "Маркировка на объекте совпадает с этой рабочей схемой"
];

const DEFAULT_SOCKETS = {
  1: {
    "1": [{ x: 63.21, y: 41.4 }, { x: 63.14, y: 50.62 }, { x: 63.14, y: 46.68 }],
    "3": [
      { x: 28.28, y: 59.66 }, { x: 43.57, y: 59.37 }, { x: 49.03, y: 45.82 },
      { x: 49.1, y: 53.22 }, { x: 47.44, y: 59.18 }, { x: 39.63, y: 59.66 },
      { x: 33.82, y: 59.57 }, { x: 25.59, y: 54.57 }, { x: 25.38, y: 45.43 }
    ],
    "10": [{ x: 23.44, y: 21.11 }],
    "12": [{ x: 39.35, y: 13.04 }],
    "13": [{ x: 59.54, y: 19.48 }, { x: 47.1, y: 20.06 }],
    "14": [
      { x: 75.93, y: 9.77 }, { x: 86.51, y: 14.38 }, { x: 84.02, y: 31.3 },
      { x: 66.25, y: 10.35 }, { x: 61.13, y: 24.09 }
    ],
    "15": [{ x: 56.71, y: 59.76 }]
  },
  2: {
    "10": [{ x: 24.62, y: 27.61 }, { x: 16.8, y: 23.73 }],
    "10.1": [{ x: 33.33, y: 21.04 }, { x: 27.04, y: 19.86 }],
    "11": [{ x: 41.84, y: 23.23 }, { x: 35.13, y: 23.31 }],
    "12": [{ x: 45.99, y: 35.87 }],
    "13": [{ x: 64.18, y: 20.53 }],
    "17": [
      { x: 96.68, y: 19.94 }, { x: 96.61, y: 29.04 },
      { x: 87.97, y: 35.95 }, { x: 79.18, y: 23.23 }
    ],
    "18": [{ x: 93.43, y: 38.82 }],
    "19": [{ x: 96.75, y: 63.76 }]
  }
};

function aroundWalls(x, y, w, h, n, inset) {
  const pad = inset ?? 1.4;
  const L = x + pad, T = y + pad, R = x + w - pad, B = y + h - pad;
  const ww = Math.max(R - L, 0.5), hh = Math.max(B - T, 0.5);
  const peri = 2 * (ww + hh);
  const pts = [];
  for (let i = 0; i < n; i++) {
    let d = ((i + 0.5) / n) * peri;
    if (d <= ww) { pts.push({ x: L + d, y: T }); continue; }
    d -= ww;
    if (d <= hh) { pts.push({ x: R, y: T + d }); continue; }
    d -= hh;
    if (d <= ww) { pts.push({ x: R - d, y: B }); continue; }
    d -= ww;
    pts.push({ x: L, y: B - d });
  }
  return pts;
}

function emptyInstall() {
  return { laid: false, labeled: false, outlet: false, inServer: false, patched: false, tested: false, passed: false };
}

function buildDefaultState() {
  const rooms = { 1: {}, 2: {} };
  const cables = [];

  const geometry = {
    1: {
      corridor: [
        { id: "c1a1", x: 11.2, y: 34.55 },
        { id: "c1w", x: 22.61, y: 34.67 },
        { id: "c1s", x: 65.01, y: 34.28 },
        { id: "c1e", x: 82.16, y: 33.99 }
      ],
      sleeve: { x: 11.2, y: 34.55 },
      entry: { x: 14.6, y: 39.2 },
      server: { x: 8.8, y: 52.6 },
      serverRoom: { x: 3.9, y: 46.4, w: 10.4, h: 11.6 }
    },
    2: {
      corridor: [
        { id: "c2a1", x: 12.5, y: 40.12 },
        { id: "c2w", x: 23.17, y: 40.08 },
        { id: "c2s", x: 76.49, y: 40.25 },
        { id: "c2e", x: 94.88, y: 40.50 }
      ],
      sleeve: { x: 12.5, y: 40.12 }
    }
  };

  for (const floor of [1, 2]) {
    for (const spec of ROOM_SPECS[floor]) {
      const saved = DEFAULT_SOCKETS[floor] && DEFAULT_SOCKETS[floor][spec.id];
      const sockets = saved
        ? saved.map((s) => ({ x: s.x, y: s.y }))
        : aroundWalls(spec.bbox[0], spec.bbox[1], spec.bbox[2], spec.bbox[3], spec.sockets);
      rooms[floor][spec.id] = {
        id: spec.id,
        name: spec.name,
        color: spec.color,
        side: spec.side,
        bbox: { x: spec.bbox[0], y: spec.bbox[1], w: spec.bbox[2], h: spec.bbox[3] },
        via: spec.via || null,
        notes: spec.notes || "",
        sockets
      };
      for (let s = 1; s <= spec.sockets; s++) {
        for (let p = 1; p <= 2; p++) {
          const purpose = spec.purposes ? spec.purposes[s - 1][p - 1] : (p === 1 ? "Порт 1 (ПК / устройство)" : "Порт 2 (телефон / резерв / принтер)");
          cables.push({
            id: `${floor}-${spec.id}-${s}-${p}`,
            floor,
            room: spec.id,
            socket: s,
            port: p,
            color: spec.color,
            purpose,
            notes: spec.notes || "",
            patchPanel: "",
            switchPort: "",
            routeConfirmed: false,
            install: emptyInstall()
          });
        }
      }
    }
  }

  return {
    version: 5,
    disclaimer: "Рабочая схема для контроля монтажа и коммутации. Не является официальным проектом СКС.",
    geometry,
    rooms,
    cables
  };
}