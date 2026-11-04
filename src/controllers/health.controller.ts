import { Request, Response, NextFunction } from "express";
import { dbConnect, isConnected } from "../config/mongo";

/**
 * GET /api/health — estado del proceso y de la base.
 *
 * Intenta reconectar antes de responder: una instancia inactiva de Vercel
 * suele haber soltado la conexión, y eso no es una caída real.
 */
export async function status(_req: Request, res: Response, next: NextFunction) {
  try {
    const db = isConnected() || (await dbConnect({ exitOnFail: false }));
    res.status(db ? 200 : 503).json({
      ok: db,
      db: db ? "connected" : "disconnected",
      uptime: Math.round(process.uptime()),
    });
  } catch (error) {
    next(error);
  }
}
