/* Signal Stadium visual prototype: lead records stay in this browser only. */
(() => {
  const KEY = "signal-stadium-demo-leads-v1";
  const CHANGE_EVENT = "signal-stadium-demo-leads-change";
  const store = window.SignalStadiumStore;
  const clone = value => JSON.parse(JSON.stringify(value));
  const clean = (value, max) => String(value ?? "").trim().slice(0, max);
  const FIELD_TYPES = new Set(["text", "email", "tel"]);
  const FIELD_ID = /^[a-z][a-z0-9-]{0,79}$/i;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phoneDigits = value => String(value || "").replace(/\D/g, "");

  function configuredFields(settings) {
    const legacy = [];
    if (!Array.isArray(settings?.fields)) {
      if (settings?.nameMode !== "hidden") legacy.push({ id: "name", label: "Name", type: "text", required: settings?.nameMode !== "optional" });
      legacy.push({ id: "email", label: "Work email", type: "email", required: true });
      if (settings?.companyMode !== "hidden") legacy.push({ id: "company", label: "Company", type: "text", required: settings?.companyMode === "required" });
      return legacy;
    }
    const seen = new Set();
    return settings.fields.slice(0, 8).filter(field => {
      if (!field || typeof field.id !== "string" || !FIELD_ID.test(field.id) || !FIELD_TYPES.has(field.type) || !String(field.label || "").trim() || seen.has(field.id)) return false;
      seen.add(field.id);
      return true;
    }).map(field => ({ id: field.id, label: clean(field.label, 40), type: field.type, required: Boolean(field.required) }));
  }

  function legacySnapshot(row) {
    const available = [
      { id: "name", label: "Name", type: "text" },
      { id: "email", label: "Work email", type: "email" },
      { id: "phone", label: "Phone number", type: "tel" },
      { id: "company", label: "Company", type: "text" },
      { id: "useCase", label: "Use case (historic)", type: "text" },
    ];
    return available.filter(field => clean(row?.[field.id], 1)).map(field => ({ ...field, required: false }));
  }

  function snapshotFor(row) {
    const snapshot = Array.isArray(row?.fieldSnapshot) ? row.fieldSnapshot : legacySnapshot(row);
    return snapshot.filter(field => field && typeof field.id === "string" && typeof field.label === "string" && FIELD_TYPES.has(field.type));
  }

  function valueFor(row, id) {
    if (row?.fieldValues && Object.prototype.hasOwnProperty.call(row.fieldValues, id)) return row.fieldValues[id];
    return row?.[id] ?? "";
  }

  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(value) ? value.filter(item => item && typeof item.id === "string" && typeof item.createdAt === "string" && typeof item.eventId === "string") : [];
    } catch { return []; }
  }

  function write(records) {
    try {
      localStorage.setItem(KEY, JSON.stringify(records));
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || "Could not save the request in this browser." };
    }
  }

  function dayBoundary(value, end = false) {
    if (!value) return end ? Infinity : -Infinity;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split("-").map(Number);
      return new Date(year, month - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0).getTime();
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : (end ? Infinity : -Infinity);
  }

  function list({ eventId, from, to } = {}) {
    const start = dayBoundary(from), end = dayBoundary(to, true);
    return read().filter(lead => {
      if (eventId && eventId !== "all" && lead.eventId !== eventId) return false;
      const time = new Date(lead.createdAt).getTime();
      return Number.isFinite(time) && time >= start && time <= end;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  function submit(eventId, input = {}) {
    const event = store?.listEvents().find(item => item.id === eventId);
    if (!event) return { ok: false, error: "Event not found." };
    const settings = event.leadCapture;
    if (!settings?.enabled) return { ok: false, error: "Lead requests are closed for this event." };
    const intent = input.intent === "expert" ? "expert" : input.intent === "guide" ? "guide" : null;
    if (!intent || (intent === "guide" && !settings.guideEnabled) || (intent === "expert" && !settings.expertEnabled)) {
      return { ok: false, error: "This request is not available for the event." };
    }

    const fields = configuredFields(settings);
    if (!fields.some(field => field.type === "email" || field.type === "tel")) return { ok: false, error: "This event needs an email or phone field for follow-up." };
    const source = input.fieldValues && typeof input.fieldValues === "object" && !Array.isArray(input.fieldValues) ? input.fieldValues : input;
    const fieldValues = {};
    for (const field of fields) {
      const maxLength = field.type === "email" ? 254 : field.type === "tel" ? 40 : 160;
      const value = field.type === "email" ? clean(source[field.id], maxLength).toLowerCase() : clean(source[field.id], maxLength);
      if (field.required && !value) return { ok: false, error: `Enter ${field.label}.` };
      if (field.type === "email" && value && !EMAIL.test(value)) return { ok: false, error: `Enter a valid ${field.label.toLowerCase()}.` };
      if (field.type === "tel" && value && (!/^[+0-9().\-\s]+$/.test(value) || phoneDigits(value).length < 7 || phoneDigits(value).length > 20)) {
        return { ok: false, error: `Enter a valid ${field.label.toLowerCase()}.` };
      }
      fieldValues[field.id] = value;
    }
    const email = fields.find(field => field.type === "email" && fieldValues[field.id])?.id;
    const phone = fields.find(field => field.type === "tel" && fieldValues[field.id])?.id;
    if (!email && !phone) return { ok: false, error: "Add an email or phone number so the booth team can follow up." };
    const contactEmail = email ? fieldValues[email] : "";
    const contactPhone = phone ? fieldValues[phone] : "";

    const lead = {
      id: store.uid("lead"), eventId, createdAt: new Date().toISOString(), intent,
      fieldValues, fieldSnapshot: fields.map(clone),
      name: fieldValues.name || "", email: contactEmail, phone: contactPhone, company: fieldValues.company || "",
      marketingOptIn: Boolean(settings.marketingOptIn && contactEmail && input.marketingOptIn),
      participantId: clean(input.participantId, 100),
      heatId: clean(input.heatId, 100),
      heat: Number.isInteger(Number(input.heat)) ? Number(input.heat) : null,
      slot: Number.isInteger(Number(input.slot)) ? Number(input.slot) : null,
      consentVersion: "demo-request-v2",
    };
    const existing = read();
    const duplicate = existing.find(item => item.eventId === eventId && item.intent === intent && item.participantId === lead.participantId
      && ((contactEmail && item.email === contactEmail) || (contactPhone && phoneDigits(item.phone) === phoneDigits(contactPhone)))
      && Date.now() - new Date(item.createdAt).getTime() < 60_000);
    if (duplicate) return { ok: true, lead: clone(duplicate), duplicate: true };
    const result = write([...existing, lead]);
    if (!result.ok) return result;
    const metrics = window.SignalStadiumMetrics;
    const properties = { leadId: lead.id, intent, participantId: lead.participantId, heatId: lead.heatId,
      heat: lead.heat, slot: lead.slot, marketingOptIn: lead.marketingOptIn, fieldCount: fields.length };
    try {
      metrics?.record(eventId, "lead_submitted", properties);
      metrics?.record(eventId, intent === "guide" ? "guide_requested" : "expert_requested", properties);
    } catch { /* A metrics failure must not undo a saved request. */ }
    return { ok: true, lead: clone(lead) };
  }

  function toCSV(records = list()) {
    const rows = Array.isArray(records) ? records : [];
    const fields = new Map();
    for (const row of rows) for (const field of snapshotFor(row)) if (!fields.has(field.id)) fields.set(field.id, field);
    const columns = [...fields.values()];
    const csvCell = value => {
      const text = String(value ?? "");
      const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const header = ["timestamp", "event_id", "heat_id", "request", "marketing_opt_in", "participant_id", "lead_id",
      ...columns.map(field => `field_${field.id}`), "field_snapshot_json"];
    const output = rows.map(row => [row.createdAt, row.eventId, row.heatId || "", row.intent,
      row.marketingOptIn ? "yes" : "no", row.participantId || "", row.id,
      ...columns.map(field => valueFor(row, field.id)), JSON.stringify(snapshotFor(row))]);
    return [header, ...output].map(row => row.map(csvCell).join(",")).join("\r\n");
  }

  window.SignalStadiumLeads = { KEY, submit, list, toCSV };
})();
