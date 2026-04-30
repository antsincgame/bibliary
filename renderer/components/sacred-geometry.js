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

/** Безопасная кодировка SVG в data: URL для CSS background. */
export function svgDataUrl(svg) {
  /* btoa не любит non-ASCII (в нашем SVG их нет, но на всякий) */
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
