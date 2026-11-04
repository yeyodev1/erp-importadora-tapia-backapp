import { CustomError } from "../errors/customError.error";

/**
 * Todo monto viaja y se guarda en CENTAVOS enteros (1234 = $12.34).
 * Así una suma de mil líneas nunca deja un 0.000001 que descuadre un asiento.
 * Los costos unitarios sí son decimales (dólares por unidad, 6 decimales),
 * porque el promedio ponderado rara vez cae en centavos exactos.
 */

/** Valida que llegue un entero de centavos (puede ser negativo solo si allowNegative). */
export function cents(value: unknown, field = "monto", allowNegative = false): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CustomError(`El ${field} debe ser un valor en centavos (entero)`, 400);
  }
  if (!allowNegative && n < 0) throw new CustomError(`El ${field} no puede ser negativo`, 400);
  return n;
}

/** Redondeo bancario no: el SRI usa redondeo aritmético a 2 decimales. */
export function roundCents(value: number): number {
  return Math.round(value + Number.EPSILON * Math.sign(value));
}

/** Porcentaje (15 = 15 %) aplicado a una base en centavos. */
export function percentOf(baseCents: number, rate: number): number {
  return roundCents((baseCents * rate) / 100);
}

/** Cantidad × costo unitario en dólares → centavos. */
export function costCents(qty: number, unitCost: number): number {
  return roundCents(qty * unitCost * 100);
}

/** Cantidades con 4 decimales (libras, sacos). */
export function roundQty(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Costo unitario con 6 decimales. */
export function roundUnitCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Para mensajes: 123456 → "1,234.56". */
export function formatCents(value: number): string {
  return (value / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
