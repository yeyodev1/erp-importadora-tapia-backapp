import mongoose from "mongoose";
import { env } from "./env";

/**
 * Conexión a Mongo pensada para serverless.
 *
 * Se guarda la *promesa* de conexión a nivel de módulo: las invocaciones que
 * reusan la instancia esperan la misma promesa en vez de abrir otra conexión
 * (Atlas tiene un tope) y ninguna consulta corre antes de tiempo.
 *
 * Una conexión fallida no se cachea: si se guardara, la instancia quedaría
 * inservible hasta que Vercel la recicle.
 */

let promesa: Promise<typeof mongoose> | null = null;

/** 1 = conectado. */
export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Espera a que una conexión en curso (estado 2) termine de abrir, con tope. */
function waitConnected(ms: number): Promise<boolean> {
  if (isConnected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      mongoose.connection.off("connected", done);
      resolve(isConnected());
    };
    const timer = setTimeout(done, ms);
    mongoose.connection.once("connected", done);
  });
}

/** exitOnFail: solo al arrancar en local tiene sentido tumbar el proceso. */
export async function dbConnect({ exitOnFail = !env.IS_VERCEL } = {}): Promise<boolean> {
  if (isConnected()) return true;

  // Una promesa ya resuelta no sirve si la conexión se cayó después (Vercel
  // congela la instancia entre peticiones): esperarla devolvía "conectado" sin
  // estarlo y el login respondía 503. Desconectado (0) o cerrando (3) = conectar de nuevo.
  const state = mongoose.connection.readyState;
  if (!promesa || state === 0 || state === 3) {
    promesa = mongoose.connect(env.DB_URI, {
      // Fallar rápido y reintentar es mejor que dejar la petición colgada.
      serverSelectionTimeoutMS: 8000,
      // Sin buffer, una consulta lanzada antes de tiempo falla en vez de
      // quedarse esperando en silencio.
      bufferCommands: false,
    });
  }

  try {
    await promesa;
    if (!(await waitConnected(8000))) throw new Error("MongoDB no quedó conectado");
    console.log("Connected to MongoDB");
    return true;
  } catch (error) {
    promesa = null;
    console.error("MongoDB connection error:", error);
    if (exitOnFail) process.exit(1);
    return false;
  }
}
