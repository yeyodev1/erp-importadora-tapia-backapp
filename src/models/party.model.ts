import mongoose, { Schema, Types } from "mongoose";

/**
 * "Persona" del sistema actual: un mismo RUC puede ser cliente, proveedor y
 * empleado a la vez (el empleado recibe cheques como anticipo y compra a
 * proveedores pequeños). Por eso es un solo modelo con banderas.
 */
/** Códigos de tipo de identificación del SRI. */
export const ID_TYPES = { RUC: "04", CEDULA: "05", PASAPORTE: "06", CONSUMIDOR_FINAL: "07" } as const;

export interface IParty {
  identification: string;
  idType: string;
  name: string;
  address: string;
  phone: string;
  email: string;
  isCustomer: boolean;
  isSupplier: boolean;
  isEmployee: boolean;
  customer: {
    sellerName: string;
    sellerCode: string;
    creditDays: number;
    priceList: string;
    customerType: string;
    parish: string;
    branch: string;
    /** Contribuyente especial: nos retiene IVA. */
    withholdsVat: boolean;
  };
  supplier: { creditDays: number; defaultExpenseAccount: string };
  isActive: boolean;
  /** Importación que lo creó (Migración de datos): "Quitar datos importados" lo borra. */
  importBatchId: Types.ObjectId | null;
}

const partySchema = new Schema<IParty>(
  {
    identification: { type: String, required: true, unique: true, trim: true },
    idType: { type: String, default: ID_TYPES.RUC },
    name: { type: String, required: true, trim: true },
    address: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },
    isCustomer: { type: Boolean, default: false, index: true },
    isSupplier: { type: Boolean, default: false, index: true },
    isEmployee: { type: Boolean, default: false },
    customer: {
      sellerName: { type: String, default: "" },
      sellerCode: { type: String, default: "" },
      creditDays: { type: Number, default: 0 },
      priceList: { type: String, default: "GENERAL" },
      customerType: { type: String, default: "" },
      parish: { type: String, default: "" },
      branch: { type: String, default: "" },
      withholdsVat: { type: Boolean, default: false },
    },
    supplier: {
      creditDays: { type: Number, default: 0 },
      defaultExpenseAccount: { type: String, default: "" },
    },
    isActive: { type: Boolean, default: true },
    importBatchId: { type: Schema.Types.ObjectId, default: null, index: true },
  },
  { timestamps: true },
);

partySchema.index({ name: "text", identification: "text" });

export const Party = mongoose.models.Party || mongoose.model<IParty>("Party", partySchema);
