/**
 * Arranca la API con una base Mongo en memoria (replica set, para que
 * funcionen las transacciones) y la siembra con datos de demo.
 * Uso: pnpm dev:memory → http://localhost:8100, usuario admin@importadoratapia.app / tapia2026
 * Nada toca Atlas ni producción; al cerrar el proceso la base desaparece.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.DB_URI = replSet.getUri("erp-tapia");
  process.env.JWT_SECRET ||= "solo-para-desarrollo-local";

  const { dbConnect } = await import("../config/mongo");
  const { seedDemo } = await import("./seed");
  const { createApp } = await import("../app");
  const { env } = await import("../config/env");

  await dbConnect();
  await seedDemo();
  createApp().server.listen(env.PORT, () => {
    console.log(`ERP en memoria: http://localhost:${env.PORT}/api — admin@importadoratapia.app / tapia2026`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
