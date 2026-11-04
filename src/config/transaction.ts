import mongoose, { ClientSession } from "mongoose";

/**
 * Corre fn dentro de una transacción de Mongo: el documento, sus movimientos
 * de stock y su asiento se graban juntos o no se graba nada. Un documento a
 * medio grabar (factura sin asiento) es exactamente el descuadre que Tapia
 * sufre hoy con la mayorización.
 *
 * Requiere replica set (Atlas lo es; en local usa `pnpm dev:memory`).
 */
export async function runInTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}
