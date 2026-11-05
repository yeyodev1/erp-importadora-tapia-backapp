import { CustomError } from "../errors/customError.error";
import { Account } from "../models/account.model";
import { Settings, ACCOUNT_MAP_KEYS, ACCOUNT_DEFAULTS, PAYROLL_DEFAULTS } from "../models/settings.model";
import { User, ROLES } from "../models/user.model";
import * as authService from "./auth.service";

/** Con los valores por defecto de las claves nuevas (nómina) que la base aún no tiene grabadas. */
export async function get() {
  const s: any = (await Settings.findById("main").lean()) ?? (await Settings.create({ _id: "main" })).toObject();
  const accounts = { ...s.accounts };
  for (const [k, code] of Object.entries(ACCOUNT_DEFAULTS)) accounts[k] ||= code;
  return { ...s, accounts, payroll: { ...PAYROLL_DEFAULTS, ...s.payroll } };
}

/** SBU en centavos y tasas en % (0–100). */
function payrollRates(body: Record<string, unknown>) {
  const data: Record<string, number> = {};
  for (const key of Object.keys(body)) {
    if (!(key in PAYROLL_DEFAULTS)) throw new CustomError(`Parámetro de nómina desconocido: ${key}`, 400);
    const n = Number(body[key]);
    const ok = key === "sbu" ? Number.isInteger(n) && n > 0 : n >= 0 && n <= 100;
    if (!ok) throw new CustomError(`Valor inválido para ${key}`, 400);
    data[`payroll.${key}`] = n;
  }
  return data;
}

/** Actualiza empresa, ambiente SRI y mapa contable. Las cuentas del mapa deben existir y ser de movimiento. */
export async function update(body: any) {
  const data: Record<string, unknown> = {};
  if (body.company) data.company = body.company;
  if (body.sriEnvironment !== undefined) {
    if (![1, 2].includes(Number(body.sriEnvironment))) throw new CustomError("Ambiente SRI inválido", 400);
    data.sriEnvironment = Number(body.sriEnvironment);
  }
  if (body.payroll) Object.assign(data, payrollRates(body.payroll));
  if (body.accounts) {
    for (const key of Object.keys(body.accounts)) {
      if (!ACCOUNT_MAP_KEYS.includes(key as any)) throw new CustomError(`Clave contable desconocida: ${key}`, 400);
      const code = String(body.accounts[key] ?? "");
      if (!code) continue;
      const acc = await Account.findOne({ code }).lean<any>();
      if (!acc || acc.kind !== "movimiento") {
        throw new CustomError(`La cuenta ${code} (${key}) no existe o no es de movimiento`, 400);
      }
      data[`accounts.${key}`] = code;
    }
  }
  await Settings.updateOne({ _id: "main" }, { $set: data }, { upsert: true });
  return get();
}

/** Cierra (o reabre con null) los meses hasta "AAAA-MM" inclusive. */
export async function lockThrough(period: string | null) {
  if (period !== null && !/^\d{4}-\d{2}$/.test(period)) throw new CustomError("Período inválido (AAAA-MM)", 400);
  await Settings.updateOne({ _id: "main" }, { lockedThrough: period }, { upsert: true });
  return get();
}

export async function listUsers() {
  return User.find().sort({ name: 1 }).lean();
}

export async function createUser(body: any) {
  if (!ROLES.includes(body.role)) throw new CustomError("Rol inválido", 400);
  return authService.createUser({
    email: String(body.email ?? ""),
    password: String(body.password ?? ""),
    name: body.name,
    phone: body.phone,
    role: body.role,
    warehouseId: body.warehouseId || null,
  });
}

export async function updateUser(id: string, body: any) {
  const data: Record<string, unknown> = {};
  for (const k of ["name", "phone", "isActive", "warehouseId"]) if (body[k] !== undefined) data[k] = body[k];
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) throw new CustomError("Rol inválido", 400);
    data.role = body.role;
  }
  const user = await User.findByIdAndUpdate(id, data, { new: true }).lean();
  if (!user) throw new CustomError("Usuario no encontrado", 404);
  return user;
}
