import { CustomError } from "../errors/customError.error";

export const TIMEZONE = "America/Guayaquil";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "2026-09-14" → Date a las 12:00 UTC. Al mediodía UTC el día es el mismo en
 * Ecuador (UTC-5), así que agrupar por día o por mes nunca corre la fecha.
 */
export function parseDay(value: unknown, field = "fecha"): Date {
  const raw = String(value ?? "").slice(0, 10);
  if (!DAY.test(raw)) throw new CustomError(`La ${field} debe tener formato AAAA-MM-DD`, 400);
  const date = new Date(`${raw}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new CustomError(`La ${field} no es válida`, 400);
  return date;
}

/** Límites inclusivos de un rango de días para filtrar. */
export function dayRange(from?: unknown, to?: unknown): { $gte?: Date; $lte?: Date } | null {
  const range: { $gte?: Date; $lte?: Date } = {};
  if (from) range.$gte = new Date(`${String(from).slice(0, 10)}T00:00:00.000Z`);
  if (to) range.$lte = new Date(`${String(to).slice(0, 10)}T23:59:59.999Z`);
  if (range.$gte && Number.isNaN(range.$gte.getTime())) throw new CustomError("Fecha 'desde' inválida", 400);
  if (range.$lte && Number.isNaN(range.$lte.getTime())) throw new CustomError("Fecha 'hasta' inválida", 400);
  return range.$gte || range.$lte ? range : null;
}
