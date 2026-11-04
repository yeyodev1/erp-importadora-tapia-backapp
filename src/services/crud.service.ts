import { Model } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { escapeRegex } from "../utils/regex";

/**
 * CRUD de catálogos (plan de cuentas, terceros, bodegas, grupos, productos).
 * Son tablas maestras sin lógica contable: no se borran, se desactivan,
 * porque un asiento viejo sigue apuntando a ellas.
 */
export interface CrudOptions {
  label: string;
  searchFields: string[];
  sort: Record<string, 1 | -1>;
  /** Campos que el cliente puede escribir. Lo demás se ignora. */
  writable: string[];
  /** Filtros por query permitidos: ?isCustomer=true */
  filters?: string[];
  populate?: string[];
  validate?: (data: Record<string, unknown>, isNew: boolean) => void | Promise<void>;
}

function pick(body: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([k]) => keys.includes(k)));
}

function parseFilter(value: unknown) {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

export function makeCrud(model: Model<any>, opts: CrudOptions) {
  return {
    async list(query: Record<string, unknown>) {
      const page = Math.max(1, Number(query.page) || 1);
      const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
      const filter: Record<string, unknown> = {};
      if (query.q) {
        const rx = new RegExp(escapeRegex(String(query.q)), "i");
        filter.$or = opts.searchFields.map((f) => ({ [f]: rx }));
      }
      if (query.active !== "all") filter.isActive = query.active === "false" ? false : true;
      for (const f of opts.filters ?? []) if (query[f] !== undefined) filter[f] = parseFilter(query[f]);

      let q = model.find(filter).sort(opts.sort).skip((page - 1) * limit).limit(limit);
      for (const p of opts.populate ?? []) q = q.populate(p);
      const [items, total] = await Promise.all([q.lean(), model.countDocuments(filter)]);
      return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
    },

    async get(id: string) {
      let q = model.findById(id);
      for (const p of opts.populate ?? []) q = q.populate(p);
      const item = await q.lean();
      if (!item) throw new CustomError(`${opts.label} no encontrado`, 404);
      return item;
    },

    async create(body: Record<string, unknown>) {
      const data = pick(body, opts.writable);
      await opts.validate?.(data, true);
      return (await model.create(data)).toObject();
    },

    async update(id: string, body: Record<string, unknown>) {
      const data = pick(body, opts.writable);
      await opts.validate?.(data, false);
      const item = await model.findByIdAndUpdate(id, data, { new: true, runValidators: true }).lean();
      if (!item) throw new CustomError(`${opts.label} no encontrado`, 404);
      return item;
    },
  };
}
