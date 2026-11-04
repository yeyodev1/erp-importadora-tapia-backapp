import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * Base en memoria con replica set (las transacciones lo exigen) y datos de
 * demo. Cada archivo de prueba llama a setup() en before y a teardown() en after.
 */
let replSet: MongoMemoryReplSet | null = null;

export const ACTOR = { userId: null, name: "Pruebas" };

export async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.DB_URI = replSet.getUri("erp-test");
  process.env.JWT_SECRET ||= "test";
  await mongoose.connect(process.env.DB_URI);
  const { seedDemo } = await import("../src/scripts/seed");
  await seedDemo();
}

export async function teardown() {
  await mongoose.disconnect();
  await replSet?.stop();
}

/** "2026-11-04" → Date al mediodía UTC, igual que parseDay. */
export function day(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}
