import { Request, Response, NextFunction } from "express";
import { dbConnect, isConnected } from "../config/mongo";

const ATTEMPTS = 2;

/**
 * Garantiza la conexión a Mongo antes de cada ruta que la usa.
 *
 * En Vercel una instancia recién encendida (o una que perdió la conexión)
 * puede recibir la petición antes de que Mongo esté listo. Sin esto la
 * consulta fallaba de inmediato; ahora se reconecta y reintenta una vez.
 */
export async function dbMiddleware(_req: Request, res: Response, next: NextFunction) {
  for (let i = 0; i < ATTEMPTS; i++) {
    if (isConnected() || (await dbConnect({ exitOnFail: false }))) {
      next();
      return;
    }
  }
  res.status(503).json({ message: "No pudimos conectar con la base de datos. Intenta de nuevo en unos segundos." });
}
