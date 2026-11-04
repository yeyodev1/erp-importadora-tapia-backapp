/**
 * Siembra una base NUEVA de producción: plan de cuentas de arranque, mapa
 * contable, bodegas, grupos, bancos, códigos de retención y datos de ejemplo
 * para la revisión. No crea usuarios de demo; el admin sale de ADMIN_EMAIL /
 * ADMIN_PASSWORD. Si la base ya tiene cuentas, no toca nada.
 * Uso: DB_URI=... ADMIN_EMAIL=... ADMIN_PASSWORD=... pnpm seed:prod
 */
import mongoose from "mongoose";
import { env } from "../config/env";
import { seedDemo } from "./seed";
import { seedAdmin } from "../services/auth.service";

async function main() {
  await mongoose.connect(env.DB_URI);
  const created = await seedDemo({ demoUsers: false });
  await seedAdmin();
  console.log(created ? "✔ Base sembrada" : "· La base ya tenía datos: no se tocó");
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("✖ Falló la siembra:", error);
  process.exit(1);
});
