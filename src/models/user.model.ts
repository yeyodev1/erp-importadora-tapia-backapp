import bcrypt from "bcryptjs";
import mongoose, { Schema } from "mongoose";

/**
 * Roles del ERP. "admin" es gerencia (todo); "auditor" solo lee.
 * El resto define qué módulos puede operar cada persona.
 */
export const ROLES = [
  "admin",
  "contabilidad",
  "facturacion",
  "cartera",
  "bodega",
  "vendedor",
  "auditor",
] as const;
export type Role = (typeof ROLES)[number];

export interface IUser {
  email: string;
  password: string;
  name: string;
  phone: string;
  role: Role;
  /** Bodega por defecto (Guayaquil/Quito) para facturación y bodega. */
  warehouseId: mongoose.Types.ObjectId | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  resetPasswordToken: string | null;
  resetPasswordExpires: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    // select: false — nunca viaja en un find() por descuido.
    password: { type: String, required: true, select: false },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    role: { type: String, enum: ROLES, default: "facturacion" },
    warehouseId: { type: Schema.Types.ObjectId, ref: "Warehouse", default: null },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    next();
    return;
  }
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

export const User = mongoose.models.User || mongoose.model<IUser>("User", userSchema);
