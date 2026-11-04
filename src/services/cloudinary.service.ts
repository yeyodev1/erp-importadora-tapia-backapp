import crypto from "crypto";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

const ROOT_FOLDER = "erp-importadora-tapia";

function sign(params: Record<string, string | number>): string {
  // Cloudinary firma los params ordenados alfabéticamente con el secret al final.
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(`${toSign}${env.CLOUDINARY_API_SECRET}`).digest("hex");
}

function isConfigured(): boolean {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

/**
 * Firma para que el navegador suba la foto directo a Cloudinary: así las
 * imágenes no pasan por la función de Vercel, que corta a los 4.5 MB.
 */
export function uploadSignature(subfolder: string) {
  if (!isConfigured()) throw new CustomError("Cloudinary no está configurado", 503);

  const safe = subfolder.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "general";
  const folder = `${ROOT_FOLDER}/${safe}`;
  const timestamp = Math.floor(Date.now() / 1000);

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    folder,
    timestamp,
    signature: sign({ folder, timestamp }),
  };
}

/** Solo se guardan fotos alojadas en nuestra cuenta: nada de URLs arbitrarias. */
export function isOwnUrl(url: string): boolean {
  return (
    Boolean(env.CLOUDINARY_CLOUD_NAME) &&
    url.startsWith(`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`)
  );
}

/** Borra una foto. Si falla no se interrumpe nada: la foto huérfana no rompe la app. */
export async function destroyImage(publicId: string): Promise<void> {
  if (!publicId || !isConfigured()) return;

  const timestamp = Math.floor(Date.now() / 1000);
  const form = new URLSearchParams();
  form.append("public_id", publicId);
  form.append("timestamp", String(timestamp));
  form.append("api_key", env.CLOUDINARY_API_KEY);
  form.append("signature", sign({ public_id: publicId, timestamp }));

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`,
      { method: "POST", body: form },
    );
    if (!res.ok) console.warn(`[cloudinary] destroy ${publicId}: ${res.status}`);
  } catch (error) {
    console.warn("[cloudinary] no se pudo borrar la foto:", error);
  }
}
