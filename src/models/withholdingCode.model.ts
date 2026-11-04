import mongoose, { Schema } from "mongoose";

/**
 * Código de retención del SRI (renta 312, 307…; IVA 721, 723…). La tasa es
 * editable: el SRI la cambia por resolución y el sistema actual muestra tasas
 * viejas (312 al 2 %, 307 al 3 %). Si `accountCode` está vacío, la retención
 * va a la cuenta del mapa contable (incomeWithholdingPayable / vatWithholdingPayable).
 */
export interface IWithholdingCode {
  tax: "renta" | "iva";
  code: string;
  description: string;
  /** Porcentaje: 1.75 = 1.75 %. */
  rate: number;
  accountCode: string;
  isActive: boolean;
}

const withholdingCodeSchema = new Schema<IWithholdingCode>(
  {
    tax: { type: String, enum: ["renta", "iva"], required: true },
    code: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    rate: { type: Number, required: true, min: 0, max: 100 },
    accountCode: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

withholdingCodeSchema.index({ tax: 1, code: 1 }, { unique: true });

/** Los que se vieron en el reporte de retenciones de Tapia (video 1 y 2). */
export const DEFAULT_WITHHOLDING_CODES: Omit<IWithholdingCode, "isActive" | "accountCode">[] = [
  { tax: "renta", code: "303", description: "Honorarios profesionales y demás pagos por servicios relacionados con el título profesional", rate: 10 },
  { tax: "renta", code: "304", description: "Servicios predomina el intelecto no relacionados con el título profesional", rate: 8 },
  { tax: "renta", code: "307", description: "Servicios predomina la mano de obra", rate: 2 },
  { tax: "renta", code: "310", description: "Servicio de transporte privado de pasajeros o transporte público o privado de carga", rate: 1 },
  { tax: "renta", code: "312", description: "Transferencia de bienes muebles de naturaleza corporal", rate: 1.75 },
  { tax: "renta", code: "320", description: "Arrendamiento bienes inmuebles", rate: 10 },
  { tax: "renta", code: "332", description: "Otras compras de bienes y servicios no sujetas a retención", rate: 0 },
  { tax: "renta", code: "343", description: "Otras retenciones aplicables el 1% (incluye régimen RIMPE - Emprendedores)", rate: 1 },
  { tax: "iva", code: "721", description: "Retención del 10% del IVA", rate: 10 },
  { tax: "iva", code: "723", description: "Retención del 20% del IVA", rate: 20 },
  { tax: "iva", code: "725", description: "Retención del 30% del IVA", rate: 30 },
  { tax: "iva", code: "727", description: "Retención del 70% del IVA", rate: 70 },
  { tax: "iva", code: "729", description: "Retención del 100% del IVA", rate: 100 },
];

export const WithholdingCode =
  mongoose.models.WithholdingCode || mongoose.model<IWithholdingCode>("WithholdingCode", withholdingCodeSchema);
