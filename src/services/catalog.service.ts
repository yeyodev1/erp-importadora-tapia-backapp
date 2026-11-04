import { CustomError } from "../errors/customError.error";
import { Account, ACCOUNT_CODE } from "../models/account.model";
import { BankAccount } from "../models/bankAccount.model";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { ProductGroup } from "../models/productGroup.model";
import { Warehouse } from "../models/warehouse.model";
import { makeCrud } from "./crud.service";

/** Cédula (10) o RUC (13) ecuatoriano; pasaporte y consumidor final libres. */
function validateIdentification(data: Record<string, unknown>) {
  const id = String(data.identification ?? "");
  const type = String(data.idType ?? "04");
  if (data.identification === undefined) return;
  if (type === "04" && !/^\d{13}$/.test(id)) throw new CustomError("El RUC debe tener 13 dígitos", 400);
  if (type === "05" && !/^\d{10}$/.test(id)) throw new CustomError("La cédula debe tener 10 dígitos", 400);
}

export const accounts = makeCrud(Account, {
  label: "Cuenta",
  searchFields: ["code", "name"],
  sort: { code: 1 },
  writable: ["code", "name", "kind", "requiresCostCenter", "isExpense", "isActive"],
  filters: ["kind"],
  async validate(data, isNew) {
    if (!isNew) {
      // El código no cambia: los asientos lo guardan como referencia.
      delete data.code;
      return;
    }
    const code = String(data.code ?? "");
    if (!ACCOUNT_CODE.test(code)) throw new CustomError("Código de cuenta inválido (ej. 1.1.01.02.01.004)", 400);
    const parentCode = code.includes(".") ? code.slice(0, code.lastIndexOf(".")) : null;
    if (parentCode) {
      const parent = await Account.findOne({ code: parentCode }).lean<any>();
      if (!parent) throw new CustomError(`Primero crea la cuenta padre ${parentCode}`, 400);
      if (parent.kind !== "mayor") throw new CustomError(`La cuenta ${parentCode} es de movimiento; no puede tener hijas`, 400);
    }
    data.parentCode = parentCode;
    data.level = code.split(".").length;
  },
});

export const parties = makeCrud(Party, {
  label: "Tercero",
  searchFields: ["name", "identification"],
  sort: { name: 1 },
  writable: [
    "identification",
    "idType",
    "name",
    "address",
    "phone",
    "email",
    "isCustomer",
    "isSupplier",
    "isEmployee",
    "customer",
    "supplier",
    "isActive",
  ],
  filters: ["isCustomer", "isSupplier", "isEmployee"],
  validate: validateIdentification,
});

export const warehouses = makeCrud(Warehouse, {
  label: "Bodega",
  searchFields: ["code", "name"],
  sort: { code: 1 },
  writable: ["code", "name", "establishment", "emissionPoint", "address", "isActive"],
});

export const productGroups = makeCrud(ProductGroup, {
  label: "Grupo",
  searchFields: ["name"],
  sort: { name: 1 },
  writable: ["name", "subgroups", "accounts", "isActive"],
});

export const products = makeCrud(Product, {
  label: "Producto",
  searchFields: ["code", "name", "barcode"],
  sort: { name: 1 },
  writable: [
    "code",
    "barcode",
    "name",
    "kind",
    "groupId",
    "subgroup",
    "supplierId",
    "location",
    "unit",
    "purchaseUnit",
    "minQty",
    "controlsStock",
    "controlsLot",
    "vatRate",
    "prices",
    "imageUrl",
    "isActive",
  ],
  filters: ["groupId", "kind"],
  populate: ["groupId"],
});

export const bankAccounts = makeCrud(BankAccount, {
  label: "Cuenta bancaria",
  searchFields: ["name", "bank", "number"],
  sort: { kind: 1, name: 1 },
  writable: ["kind", "name", "bank", "number", "type", "accountCode", "nextCheck", "isActive"],
  filters: ["kind"],
});

/** Busca un tercero por RUC/cédula exacta (para autollenar al facturar). */
export async function findPartyByIdentification(identification: string) {
  const party = await Party.findOne({ identification: identification.trim() }).lean();
  if (!party) throw new CustomError("No hay un tercero con esa identificación", 404);
  return party;
}
