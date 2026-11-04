import { CustomError } from "../errors/customError.error";
import { Account } from "../models/account.model";
import { WithholdingCode } from "../models/withholdingCode.model";
import { makeCrud } from "./crud.service";

/** Catálogo de códigos de retención: se desactivan, no se borran (las facturas viejas los citan). */
export const withholdingCodes = makeCrud(WithholdingCode, {
  label: "Código de retención",
  searchFields: ["code", "description"],
  sort: { tax: -1, code: 1 },
  writable: ["tax", "code", "description", "rate", "accountCode", "isActive"],
  filters: ["tax"],
  async validate(data) {
    if (data.rate !== undefined && !(Number(data.rate) >= 0 && Number(data.rate) <= 100)) {
      throw new CustomError("El porcentaje de retención va de 0 a 100", 400);
    }
    if (data.accountCode) {
      const acc = await Account.findOne({ code: data.accountCode }).lean<any>();
      if (!acc || acc.kind !== "movimiento") throw new CustomError(`La cuenta ${data.accountCode} no existe o no es de movimiento`, 400);
    }
  },
});
