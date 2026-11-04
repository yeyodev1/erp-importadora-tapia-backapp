import { ClientSession } from "mongoose";
import { Sequence } from "../models/sequence.model";

/** Siguiente número de la clave, atómico y dentro de la transacción. */
export async function next(key: string, session?: ClientSession): Promise<number> {
  const doc = await Sequence.findOneAndUpdate(
    { _id: key },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session },
  );
  return doc.value;
}

/** Secuencial SRI de 9 dígitos: 12190 → "000012190". */
export function pad9(n: number): string {
  return String(n).padStart(9, "0");
}

/**
 * Siguiente secuencial de un documento electrónico por establecimiento y
 * punto de emisión: "001-001-000012190".
 */
export async function nextDocNumber(
  docType: string,
  establishment: string,
  emissionPoint: string,
  session?: ClientSession,
): Promise<{ sequential: string; number: string }> {
  const n = await next(`${docType}-${establishment}-${emissionPoint}`, session);
  const sequential = pad9(n);
  return { sequential, number: `${establishment}-${emissionPoint}-${sequential}` };
}
