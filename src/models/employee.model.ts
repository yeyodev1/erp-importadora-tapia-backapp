import mongoose, { Schema, Types } from "mongoose";
import { DEPARTMENTS, Department } from "./settings.model";

/**
 * Ficha del trabajador. Va atada a un tercero (Party con isEmployee) de la
 * misma cédula: así los cheques, anticipos y el rol quedan en el mismo tercero.
 */
export interface IEmployee {
  partyId: Types.ObjectId;
  identification: string;
  firstName: string;
  lastName: string;
  address: string;
  phone: string;
  email: string;
  hireDate: Date;
  department: Department;
  position: string;
  /** Sueldo mensual en centavos. */
  salary: number;
  /** Vendedor del reporte de comisiones (sellerName de la factura). */
  sellerName: string;
  /** % sobre lo cobrado del vendedor en el mes. */
  commissionRate: number;
  /** true: el fondo de reserva se paga en el rol; false: se acumula en el IESS. */
  reserveFundMonthly: boolean;
  isActive: boolean;
  exitDate: Date | null;
}

const employeeSchema = new Schema<IEmployee>(
  {
    partyId: { type: Schema.Types.ObjectId, ref: "Party", required: true },
    identification: { type: String, required: true, unique: true, trim: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    address: { type: String, default: "" },
    phone: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },
    hireDate: { type: Date, required: true },
    department: { type: String, enum: DEPARTMENTS, required: true },
    position: { type: String, default: "" },
    salary: { type: Number, required: true, min: 0 },
    sellerName: { type: String, default: "", trim: true },
    commissionRate: { type: Number, default: 0, min: 0, max: 100 },
    reserveFundMonthly: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    exitDate: { type: Date, default: null },
  },
  { timestamps: true },
);

export const Employee = mongoose.models.Employee || mongoose.model<IEmployee>("Employee", employeeSchema);
