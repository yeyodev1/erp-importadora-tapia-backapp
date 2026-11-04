/**
 * Código de barras Code 128 en SVG para la clave de acceso del RIDE.
 * Pares de dígitos en el set C (la clave tiene 49 dígitos: el último va en set B).
 */

/** Anchos barra/espacio de cada símbolo 0..106 (106 = stop). */
export const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_C = 105;
const CODE_B = 100;
const STOP = 106;

/** Símbolos (con checksum y stop) para una cadena de dígitos. */
export function code128Digits(value: string): number[] {
  if (!/^\d+$/.test(value)) throw new Error("Code128: solo dígitos");
  const symbols = [START_C];
  let i = 0;
  for (; i + 1 < value.length; i += 2) symbols.push(Number(value.slice(i, i + 2)));
  // Dígito suelto: cambio a set B, donde "0".."9" son los símbolos 16..25.
  if (i < value.length) symbols.push(CODE_B, value.charCodeAt(i) - 32);
  const checksum = symbols.reduce((acc, s, idx) => acc + s * (idx === 0 ? 1 : idx), 0) % 103;
  return [...symbols, checksum, STOP];
}

/** SVG con módulos de 1 unidad y viewBox escalable (preserveAspectRatio none para estirar al ancho). */
export function code128Svg(value: string, height = 50): string {
  const quiet = 10;
  let x = quiet;
  const rects: string[] = [];
  for (const symbol of code128Digits(value)) {
    const widths = PATTERNS[symbol];
    for (let k = 0; k < widths.length; k++) {
      const w = Number(widths[k]);
      if (k % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`);
      x += w;
    }
  }
  const total = x + quiet;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" ` +
    `role="img" aria-label="Clave de acceso ${value}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${height}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`
  );
}
