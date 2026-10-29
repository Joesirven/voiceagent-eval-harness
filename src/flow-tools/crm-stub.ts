/** A local CRM stand-in for tests, simulations, and the public example. */

export interface CrmAction {
  name: "add_callback_number" | "book_appointment" | "email_document" | "request_quote" | "save_contact_detail";
  arguments: Record<string, unknown>;
}

export interface CrmClient {
  crmAddCallbackNumber(phone: string, label?: string): Promise<{ ok: boolean; message: string }>;
  crmBookAppointment(slotIso: string): Promise<{ ok: boolean; message: string }>;
  crmEmailDocument(document: string): Promise<{ status: "sent"; message: string }>;
  crmRequestQuote(workforce?: { employees: number; payroll: number }): Promise<{ ok: boolean; message: string }>;
  crmSaveContactDetail(field: string, value: string, evidenceQuote: string): Promise<{ ok: boolean; message: string }>;
}

export interface CrmStub extends CrmClient {
  readonly actions: CrmAction[];
}

/** Record each requested action and return a plausible local result. */
export function createCrmStub(): CrmStub {
  const actions: CrmAction[] = [];
  const record = (name: CrmAction["name"], arguments_: Record<string, unknown>) => actions.push({ name, arguments: arguments_ });
  return {
    actions,
    async crmAddCallbackNumber(phone, label) {
      record("add_callback_number", { phone, label });
      return { ok: true, message: "The callback number was recorded in the local CRM stub." };
    },
    async crmBookAppointment(slotIso) {
      record("book_appointment", { slotIso });
      return { ok: true, message: "The producer call was booked in the local CRM stub." };
    },
    async crmEmailDocument(document) {
      record("email_document", { document });
      return { status: "sent", message: "The local CRM stub accepted the email request." };
    },
    async crmRequestQuote(workforce) {
      record("request_quote", { workforce });
      return { ok: true, message: "The quote request was recorded in the local CRM stub." };
    },
    async crmSaveContactDetail(field, value, evidenceQuote) {
      record("save_contact_detail", { field, value, evidenceQuote });
      return { ok: true, message: "The contact detail was recorded in the local CRM stub." };
    },
  };
}
