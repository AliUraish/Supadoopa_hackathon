"""Pawsome Vet (port 4102): pet appointments, the same flow shape as the clinic.

v1  GET  api/vets                       -> {vets: [{id, name, specialty}]}
    GET  api/slots?vet&date             -> {slots: [{id, time}]}
    POST api/appointments {slot_id, pet_name, owner_name, phone}  -> 201 {appointment: {id, ...}}
v2  GET  api/v2/clinicians              -> {clinicians: [{clinicianId, displayName, focus}]}
    GET  api/v2/openings?clinicianId&on -> {data: {openings: [{slotId, startsAt}]}}
    POST api/v2/visits {slotId, pet: {name}, owner: {fullName, phoneNumber}}  -> 201 {visit: ...}
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from demo_sites.common import (
    ApiError,
    SlotBook,
    State,
    build_app,
    json,
    obj,
    page_renderer,
    read_body,
    valid_date,
)

VETS = [
    {"id": "patel", "name": "Dr. Priya Patel", "specialty": "Dogs & cats"},
    {"id": "nguyen", "name": "Dr. Sam Nguyen", "specialty": "Rabbits, birds & exotics"},
    {"id": "brooks", "name": "Dr. Hannah Brooks", "specialty": "Surgery & dental"},
]
TIMES = ["08:30", "09:00", "09:30", "10:00", "10:30", "11:00"]
TIMES += ["13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]
V2_NAMES = {"pet_name": "pet.name", "owner_name": "owner.fullName", "phone": "owner.phoneNumber"}

CLIENT = {
    "v1": """\
const client = {
  vets: async () => (await get('api/vets')).vets
    .map((v) => ({ id: v.id, name: v.name, specialty: v.specialty })),
  slots: async (vet, date) => (await get('api/slots?' + new URLSearchParams({ vet, date }))).slots
    .map((s) => ({ id: s.id, time: s.time })),
  book: async (slot, pet, owner, phone) => {
    const { ok, body } = await post('api/appointments',
      { slot_id: slot, pet_name: pet, owner_name: owner, phone });
    if (!ok) return { error: body.error };
    const a = body.appointment;
    return { id: a.id, pet: a.pet_name, vet: a.vet, when: `${a.date} ${a.time}` };
  },
};
""",
    "v2": """\
const client = {
  vets: async () => (await get('api/v2/clinicians')).clinicians
    .map((c) => ({ id: c.clinicianId, name: c.displayName, specialty: c.focus })),
  slots: async (vet, date) => {
    const query = new URLSearchParams({ clinicianId: vet, on: date });
    return (await get('api/v2/openings?' + query)).data.openings
      .map((o) => ({ id: o.slotId, time: o.startsAt.slice(11, 16) }));
  },
  book: async (slot, pet, owner, phone) => {
    const { ok, body } = await post('api/v2/visits',
      { slotId: slot, pet: { name: pet }, owner: { fullName: owner, phoneNumber: phone } });
    if (!ok) return { error: body.error };
    const v = body.visit;
    const when = v.startsAt.replace('T', ' ').slice(0, 16);
    return { id: v.visitId, pet: v.pet.name, vet: v.clinician, when };
  },
};
""",
}


def create_app() -> FastAPI:
    state = State("bookings")
    diary = SlotBook(VETS, TIMES, state.tables["bookings"])

    def openings(vet_id: str | None, day: str | None, error: str) -> list[dict]:
        vet = diary.resource(vet_id)
        if not vet or not valid_date(day):
            raise ApiError(400, error)
        return diary.open_slots(vet["id"], day)

    def book(slot_id, pet, owner, phone, names: dict | None = None) -> dict:
        fields = {"pet_name": pet, "owner_name": owner, "phone": phone}
        return diary.book(slot_id, "vis", fields, names)

    async def vets_v1(_: Request) -> JSONResponse:
        return json({"vets": VETS})

    async def slots_v1(request: Request) -> JSONResponse:
        q = request.query_params
        found = openings(q.get("vet"), q.get("date"), "vet and date are required")
        return json({"slots": found})

    async def appointments_v1(request: Request) -> JSONResponse:
        body = await read_body(request)
        b = book(body.get("slot_id"), body.get("pet_name"), body.get("owner_name"),
                 body.get("phone"))  # fmt: skip
        appointment = {
            "id": b["id"],
            "slot_id": b["slot_id"],
            "vet": b["resource"],
            "date": b["date"],
            "time": b["time"],
            "pet_name": b["pet_name"],
            "owner_name": b["owner_name"],
        }
        return json({"appointment": appointment}, 201)

    async def clinicians_v2(_: Request) -> JSONResponse:
        clinicians = [
            {"clinicianId": v["id"], "displayName": v["name"], "focus": v["specialty"]}
            for v in VETS
        ]
        return json({"clinicians": clinicians})

    async def openings_v2(request: Request) -> JSONResponse:
        q = request.query_params
        vet, day = q.get("clinicianId"), q.get("on")
        found = openings(vet, day, "clinicianId and on are required")
        items = [{"slotId": s["id"], "startsAt": f"{day}T{s['time']}:00", "clinicianId": vet}
                 for s in found]  # fmt: skip
        return json({"data": {"openings": items}})

    async def visits_v2(request: Request) -> JSONResponse:
        body = await read_body(request)
        pet, owner = obj(body, "pet"), obj(body, "owner")
        b = book(body.get("slotId"), pet.get("name"), owner.get("fullName"),
                 owner.get("phoneNumber"), V2_NAMES)  # fmt: skip
        visit = {
            "visitId": b["id"],
            "slotId": b["slot_id"],
            "clinician": b["resource"],
            "startsAt": f"{b['date']}T{b['time']}:00",
            "pet": {"name": b["pet_name"]},
            "owner": {"fullName": b["owner_name"]},
        }
        return json({"visit": visit}, 201)

    api = {
        "v1": {
            "GET api/vets": vets_v1,
            "GET api/slots": slots_v1,
            "POST api/appointments": appointments_v1,
        },
        "v2": {
            "GET api/v2/clinicians": clinicians_v2,
            "GET api/v2/openings": openings_v2,
            "POST api/v2/visits": visits_v2,
        },
    }
    return build_app("Pawsome Vet", state, api, page_renderer("pawsome_vet.html", CLIENT))


app = create_app()
