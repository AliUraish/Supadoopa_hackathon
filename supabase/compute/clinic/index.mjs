// Sunrise Family Clinic: a demo site built for humans (buttons and forms, no public API).
// Its page talks to a private JSON backend. POST /admin/version switches that backend
// between v1 and v2 live, which is what breaks (and lets Doorway heal) the agent tools.
// State is in memory: Compute runs this as one long-lived process.

const DOCTORS = [
  { id: "khan", name: "Dr. Amina Khan", specialty: "General Practice" },
  { id: "ortega", name: "Dr. Luis Ortega", specialty: "Pediatrics" },
  { id: "chen", name: "Dr. Mei Chen", specialty: "Dermatology" },
];
const TIMES = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"];

const state = { version: "v1", bookings: new Map() }; // slotId -> booking

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const doctor = (id) => DOCTORS.find((d) => d.id === id);
const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

function openSlots(doctorId, date) {
  return TIMES.map((t) => ({ id: `${doctorId}-${date}-${t.replace(":", "")}`, time: t }))
    .filter((s) => !state.bookings.has(s.id));
}

function book(slotId, name, phone) {
  const [doctorId, y, m, d, hhmm] = String(slotId).split("-");
  const date = `${y}-${m}-${d}`;
  const doc = doctor(doctorId);
  if (!doc || !validDate(date) || !/^\d{4}$/.test(hhmm ?? "")) return { error: "unknown_slot", status: 404 };
  if (state.bookings.has(slotId)) return { error: "slot_taken", status: 409 };
  if (!name?.trim() || !phone?.trim()) return { error: "name_and_phone_required", status: 422 };
  const booking = {
    id: `apt_${crypto.randomUUID().slice(0, 8)}`,
    slotId, doctor: doc.name, date, time: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
    name: name.trim(), phone: phone.trim(), createdAt: new Date().toISOString(),
  };
  state.bookings.set(slotId, booking);
  return { booking };
}

const retired = () => json({ error: "This API version has been retired" }, 410);

const api = {
  v1: {
    "GET /api/doctors": () => json({ doctors: DOCTORS }),
    "GET /api/slots": (_req, url) => {
      const doctorId = url.searchParams.get("doctor");
      const date = url.searchParams.get("date");
      if (!doctor(doctorId) || !validDate(date)) return json({ error: "doctor and date required" }, 400);
      return json({ slots: openSlots(doctorId, date).map((s) => ({ ...s, doctor_id: doctorId })) });
    },
    "POST /api/appointments": async (req) => {
      const body = await req.json().catch(() => ({}));
      const r = book(body.slot_id, body.patient_name, body.phone);
      if (r.error) return json({ error: r.error }, r.status);
      const b = r.booking;
      return json({ appointment: { id: b.id, slot_id: b.slotId, doctor: b.doctor, date: b.date, time: b.time, patient_name: b.name } }, 201);
    },
  },
  v2: {
    "GET /api/v2/providers": () =>
      json({ providers: DOCTORS.map((d) => ({ providerId: d.id, fullName: d.name, specialty: d.specialty })) }),
    "GET /api/v2/availability": (_req, url) => {
      const providerId = url.searchParams.get("providerId");
      const day = url.searchParams.get("day");
      if (!doctor(providerId) || !validDate(day)) return json({ error: "providerId and day required" }, 400);
      return json({ data: { openings: openSlots(providerId, day).map((s) => ({ slotId: s.id, startsAt: `${day}T${s.time}:00`, providerId })) } });
    },
    "POST /api/v2/bookings": async (req) => {
      const body = await req.json().catch(() => ({}));
      const r = book(body.slotId, body.patient?.fullName, body.patient?.phoneNumber);
      if (r.error) return json({ error: r.error }, r.status);
      const b = r.booking;
      return json({ booking: { bookingId: b.id, slotId: b.slotId, provider: b.doctor, startsAt: `${b.date}T${b.time}:00`, patient: { fullName: b.name } } }, 201);
    },
  },
};

function admin(req, url) {
  const token = process.env.CLINIC_ADMIN_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token) return json({ error: "unauthorized" }, 401);
  if (req.method === "GET" && url.pathname === "/admin/state") {
    return json({ version: state.version, bookings: [...state.bookings.values()] });
  }
  if (req.method === "POST" && url.pathname === "/admin/version") {
    return req.json().then((body) => {
      if (!["v1", "v2"].includes(body?.version)) return json({ error: "version must be v1 or v2" }, 400);
      state.version = body.version;
      return json({ version: state.version });
    });
  }
  if (req.method === "POST" && url.pathname === "/admin/reset") {
    state.bookings.clear();
    state.version = "v1";
    return json({ version: state.version, bookings: 0 });
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/admin/")) return admin(req, url);
    if (url.pathname.startsWith("/api/")) {
      const handler = api[state.version][`${req.method} ${url.pathname}`];
      if (handler) return handler(req, url);
      const otherVersion = state.version === "v1" ? "v2" : "v1";
      if (api[otherVersion][`${req.method} ${url.pathname}`]) return retired();
      return json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(page(state.version), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
};

// The page ships matching frontend code for whichever backend version is live,
// like a real site deploy: humans never notice the switch, hard-coded clients break.
function page(version) {
  const v1 = {
    doctors: "async () => (await (await fetch('api/doctors')).json()).doctors.map(d => ({ id: d.id, name: d.name, specialty: d.specialty }))",
    slots: "async (doc, date) => (await (await fetch(`api/slots?doctor=${doc}&date=${date}`)).json()).slots.map(s => ({ id: s.id, time: s.time }))",
    book: "async (slot, name, phone) => { const r = await fetch('api/appointments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slot_id: slot, patient_name: name, phone }) }); const b = await r.json(); return r.ok ? { id: b.appointment.id, when: `${b.appointment.date} ${b.appointment.time}`, doctor: b.appointment.doctor } : { error: b.error }; }",
  };
  const v2 = {
    doctors: "async () => (await (await fetch('api/v2/providers')).json()).providers.map(p => ({ id: p.providerId, name: p.fullName, specialty: p.specialty }))",
    slots: "async (doc, date) => (await (await fetch(`api/v2/availability?providerId=${doc}&day=${date}`)).json()).data.openings.map(o => ({ id: o.slotId, time: o.startsAt.slice(11, 16) }))",
    book: "async (slot, name, phone) => { const r = await fetch('api/v2/bookings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slotId: slot, patient: { fullName: name, phoneNumber: phone } }) }); const b = await r.json(); return r.ok ? { id: b.booking.bookingId, when: b.booking.startsAt.replace('T', ' ').slice(0, 16), doctor: b.booking.provider } : { error: b.error }; }",
  };
  const c = version === "v2" ? v2 : v1;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sunrise Family Clinic · Book a visit</title>
<style>
  :root { --brand:#0f766e; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --bg:#f8fafc; }
  * { box-sizing:border-box } body { margin:0; font:16px/1.5 system-ui,sans-serif; color:var(--ink); background:var(--bg) }
  header { background:var(--brand); color:#fff; padding:20px 16px } header h1 { margin:0; font-size:22px } header p { margin:4px 0 0; opacity:.85 }
  main { max-width:640px; margin:24px auto; padding:0 16px }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px }
  label { display:block; font-weight:600; margin:12px 0 4px } select,input { width:100%; padding:10px; border:1px solid var(--line); border-radius:8px; font:inherit }
  button { background:var(--brand); color:#fff; border:0; border-radius:8px; padding:10px 16px; font:inherit; font-weight:600; cursor:pointer; margin-top:16px }
  .slots { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px } .slots button { background:#fff; color:var(--brand); border:1px solid var(--brand); margin:0 }
  .slots button[aria-pressed=true] { background:var(--brand); color:#fff } .muted { color:var(--muted) } .hidden { display:none } .ok { color:#047857; font-weight:600 } .err { color:#b91c1c }
</style></head>
<body>
<header><h1>Sunrise Family Clinic</h1><p>Book a visit online, any time.</p></header>
<main>
  <section class="card">
    <h2>1. Choose a doctor and day</h2>
    <label for="doctor">Doctor</label><select id="doctor"></select>
    <label for="date">Day</label><input id="date" type="date">
    <button id="find">Find available times</button>
    <div id="slots" class="slots"></div><p id="slots-msg" class="muted"></p>
  </section>
  <section class="card hidden" id="details">
    <h2>2. Your details</h2>
    <label for="name">Full name</label><input id="name" autocomplete="name">
    <label for="phone">Phone</label><input id="phone" autocomplete="tel">
    <button id="book">Confirm booking</button><p id="result"></p>
  </section>
</main>
<script>
  // API calls are relative, so the page must be served from a path ending in "/".
  if (!location.pathname.endsWith('/')) location.replace(location.pathname + '/' + location.search);
  const client = { doctors: ${c.doctors}, slots: ${c.slots}, book: ${c.book} };
  const $ = (id) => document.getElementById(id);
  let chosen = null;
  $('date').value = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  client.doctors().then((docs) => { $('doctor').innerHTML = docs.map((d) => \`<option value="\${d.id}">\${d.name} · \${d.specialty}</option>\`).join(''); });
  $('find').onclick = async () => {
    const slots = await client.slots($('doctor').value, $('date').value);
    chosen = null; $('details').classList.add('hidden');
    $('slots-msg').textContent = slots.length ? 'Pick a time:' : 'No times left that day.';
    $('slots').innerHTML = slots.map((s) => \`<button data-id="\${s.id}" aria-pressed="false">\${s.time}</button>\`).join('');
    $('slots').querySelectorAll('button').forEach((b) => b.onclick = () => {
      $('slots').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true'); chosen = b.dataset.id; $('details').classList.remove('hidden');
    });
  };
  $('book').onclick = async () => {
    if (!chosen) return;
    const r = await client.book(chosen, $('name').value, $('phone').value);
    $('result').className = r.error ? 'err' : 'ok';
    $('result').textContent = r.error ? 'Could not book: ' + r.error : \`Booked! \${r.doctor}, \${r.when}. Reference \${r.id}.\`;
  };
</script>
</body></html>`;
}
