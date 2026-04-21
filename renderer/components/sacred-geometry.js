// @ts-check
/**
 * Phase 5.0 — Sacred Geometry SVG library.
 *
 * Возвращают строки SVG для inline вставки в DOM или CSS-background через
 * data:image/svg+xml;base64,... — ноль зависимостей.
 *
 * Все символы стилизуются через `currentColor` + opacity, чтобы наследовать
 * цвет из родительского элемента (золото / cyan / emerald).
 */

/**
 * Цветок Жизни — 19 пересекающихся окружностей в гексагональной решётке.
 * Базовый сакральный паттерн западного эзотерического канона.
 *
 * @param {object} opts
 * @param {number} [opts.size]      — итоговый viewBox (px). Default 240.
 * @param {number} [opts.opacity]   — alpha штриха. Default 0.18.
 * @param {string} [opts.color]     — fallback на currentColor если не указан.
 * @returns {string} SVG-source (полный <svg>...)
 */
export function flowerOfLife({ size = 240, opacity = 0.18, color } = {}) {
  const r = size / 8;
  const cx = size / 2;
  const cy = size / 2;
  const stroke = color || "currentColor";
  const offsets = [
    [0, 0],
    [r * 1.732, -r],
    [r * 1.732, r],
    [0, -2 * r],
    [0, 2 * r],
    [-r * 1.732, -r],
    [-r * 1.732, r],
    [r * 1.732 * 2, 0],
    [-r * 1.732 * 2, 0],
    [r * 1.732, -3 * r],
    [r * 1.732, 3 * r],
    [-r * 1.732, -3 * r],
    [-r * 1.732, 3 * r],
    [r * 1.732 * 2, -2 * r],
    [r * 1.732 * 2, 2 * r],
    [-r * 1.732 * 2, -2 * r],
    [-r * 1.732 * 2, 2 * r],
    [0, -4 * r],
    [0, 4 * r],
  ];
  const circles = offsets
    .map(([dx, dy]) => `<circle cx="${(cx + dx).toFixed(2)}" cy="${(cy + dy).toFixed(2)}" r="${r.toFixed(2)}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="none" stroke="${stroke}" stroke-width="0.7" opacity="${opacity}">${circles}</svg>`;
}

/**
 * Золотая спираль (Фибоначчи) — 8 четвертей логарифмической спирали через
 * вложенные квадраты с радиусами 1,1,2,3,5,8,13,21.
 */
export function goldenSpiral({ size = 240, opacity = 0.25, color } = {}) {
  const fib = [1, 1, 2, 3, 5, 8, 13, 21];
  const total = fib.reduce((s, x) => s + x, 0);
  const scale = (size * 0.85) / total;
  const stroke = color || "currentColor";

  /** @type {string[]} */
  const arcs = [];
  let x = size / 2;
  let y = size / 2;
  /* Направление: справа, вниз, влево, вверх */
  const dirs = [
    { dx: 1, dy: 0, sweep: 1 },
    { dx: 0, dy: 1, sweep: 1 },
    { dx: -1, dy: 0, sweep: 1 },
    { dx: 0, dy: -1, sweep: 1 },
  ];
  for (let i = 0; i < fib.length; i++) {
    const f = fib[i] * scale;
    const dir = dirs[i % 4];
    const ex = x + dir.dx * f;
    const ey = y + dir.dy * f;
    arcs.push(`M ${x.toFixed(2)} ${y.toFixed(2)} A ${f.toFixed(2)} ${f.toFixed(2)} 0 0 ${dir.sweep} ${ex.toFixed(2)} ${ey.toFixed(2)}`);
    x = ex;
    y = ey;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="none" stroke="${stroke}" stroke-width="1.2" opacity="${opacity}"><path d="${arcs.join(" ")}"/></svg>`;
}

/**
 * Куб Метатрона — 13 окружностей соединённых всеми возможными линиями.
 * Содержит проекции 5 платоновых тел.
 */
export function metatronCube({ size = 240, opacity = 0.16, color } = {}) {
  const r = size / 18;
  const cx = size / 2;
  const cy = size / 2;
  const ringR = size / 4;
  const stroke = color || "currentColor";

  const points = [{ x: cx, y: cy }];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    points.push({ x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    points.push({ x: cx + Math.cos(a) * ringR * 2, y: cy + Math.sin(a) * ringR * 2 });
  }

  const circles = points.map((p) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r.toFixed(2)}"/>`).join("");
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      lines.push(
        `<line x1="${points[i].x.toFixed(2)}" y1="${points[i].y.toFixed(2)}" x2="${points[j].x.toFixed(2)}" y2="${points[j].y.toFixed(2)}"/>`
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="none" stroke="${stroke}" stroke-width="0.4" opacity="${opacity}">${lines.join("")}${circles}</svg>`;
}

/**
 * Гексагональная сетка — простой повторяющийся паттерн под background.
 *
 * @param {object} opts
 * @param {number} [opts.cellSize] — радиус одной ячейки. Default 28.
 * @param {number} [opts.opacity]
 * @param {string} [opts.color]
 */
export function hexagonalGrid({ cellSize = 28, opacity = 0.08, color } = {}) {
  const r = cellSize;
  const w = r * Math.sqrt(3);
  const h = r * 1.5;
  const stroke = color || "currentColor";
  /* Один полный гекс = 6 точек, потом replicate через CSS background-repeat */
  const path = (() => {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      pts.push(`${(r + Math.cos(a) * r).toFixed(2)},${(r + Math.sin(a) * r).toFixed(2)}`);
    }
    return pts.join(" ");
  })();
  /* Tile: viewBox = w x (2*h), 2 hexa: один в верхней половине, другой смещён */
  const w2 = w * 2;
  const h2 = h * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w2.toFixed(2)} ${h2.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="0.5" opacity="${opacity}"><polygon points="${path}"/><polygon points="${path}" transform="translate(${(w / 2).toFixed(2)},${h.toFixed(2)})"/></svg>`;
}

/** Безопасная кодировка SVG в data: URL для CSS background. */
export function svgDataUrl(svg) {
  /* btoa не любит non-ASCII (в нашем SVG их нет, но на всякий) */
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Удобный helper для inline-вставки SVG в DOM. */
export function appendSvg(parent, svg) {
  const tmp = document.createElement("div");
  tmp.innerHTML = svg;
  const node = tmp.firstElementChild;
  if (node) parent.appendChild(node);
  return node;
}
