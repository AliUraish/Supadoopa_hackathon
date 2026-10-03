"""Bella Bistro (port 4101): table reservations, the same flow shape as the clinic.

v1  GET  api/areas                             -> {areas: [{id, name, description, max_party}]}
    GET  api/times?area&date&party             -> {times: [{id, time}]}
    POST api/reservations {time_id, guest_name, phone, party_size}  -> 201 {reservation: {id, ...}}
v2  GET  api/v2/sections                       -> {sections: [{sectionId, label, blurb, maxCovers}]}
    GET  api/v2/availability?sectionId&day&covers  -> {data: {openings: [{slotId, startsAt}]}}
    POST api/v2/bookings {slotId, guest: {fullName, phoneNumber}, covers}  -> 201 {booking: ...}
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
    to_int,
    valid_date,
)

AREAS = [
    {
        "id": "dining",
        "name": "Main Dining Room",
        "description": "Candlelit tables beside the open kitchen",
        "max_party": 10,
    },
    {
        "id": "patio",
        "name": "Garden Patio",
        "description": "A heated terrace under the olive trees",
        "max_party": 6,
    },
    {
        "id": "counter",
        "name": "Chef's Counter",
        "description": "Front-row seats at the pasta bar",
        "max_party": 4,
    },
]
TIMES = ["12:00", "12:30", "13:00", "13:30", "17:30", "18:00"]
TIMES += ["18:30", "19:00", "19:30", "20:00", "20:30", "21:00"]
V2_NAMES = {"guest_name": "guest.fullName", "phone": "guest.phoneNumber", "party_size": "covers"}

CLIENT = {
    "v1": """\
const client = {
  areas: async () => (await get('api/areas')).areas
    .map((a) => ({ id: a.id, name: a.name, note: a.description, max: a.max_party })),
  slots: async (area, date, party) =>
    (await get('api/times?' + new URLSearchParams({ area, date, party }))).times
      .map((t) => ({ id: t.id, time: t.time })),
  book: async (slot, name, phone, party) => {
    const { ok, body } = await post('api/reservations',
      { time_id: slot, guest_name: name, phone, party_size: Number(party) });
    if (!ok) return { error: body.error };
    const r = body.reservation;
    return { id: r.id, when: `${r.date} ${r.time}`, where: r.area, party: r.party_size };
  },
};
""",
    "v2": """\
const client = {
  areas: async () => (await get('api/v2/sections')).sections
    .map((s) => ({ id: s.sectionId, name: s.label, note: s.blurb, max: s.maxCovers })),
  slots: async (area, date, party) => {
    const query = new URLSearchParams({ sectionId: area, day: date, covers: party });
    return (await get('api/v2/availability?' + query)).data.openings
      .map((o) => ({ id: o.slotId, time: o.startsAt.slice(11, 16) }));
  },
  book: async (slot, name, phone, party) => {
    const { ok, body } = await post('api/v2/bookings',
      { slotId: slot, guest: { fullName: name, phoneNumber: phone }, covers: Number(party) });
    if (!ok) return { error: body.error };
    const b = body.booking;
    const when = b.startsAt.replace('T', ' ').slice(0, 16);
    return { id: b.bookingId, when, where: b.section, party: b.covers };
  },
};
""",
}


def create_app() -> FastAPI:
    state = State("bookings")
    tables = SlotBook(AREAS, TIMES, state.tables["bookings"])

    def openings(area_id: str | None, day: str | None, party: str | None, error: str) -> list:
        area, size = tables.resource(area_id), to_int(party)
        if not area or not valid_date(day) or size is None or size < 1:
            raise ApiError(400, error)
        return tables.open_slots(area["id"], day) if size <= area["max_party"] else []

    def fits(area: dict, fields: dict) -> None:
        if not 1 <= fields["party_size"] <= area["max_party"]:
            raise ApiError(422, "invalid_party_size", max_party=area["max_party"])

    def reserve(slot_id, name, phone, party, names: dict | None = None) -> dict:
        fields = {"guest_name": name, "phone": phone, "party_size": to_int(party)}
        return tables.book(slot_id, "res", fields, names, check=fits)

    async def areas_v1(_: Request) -> JSONResponse:
        return json({"areas": AREAS})

    async def times_v1(request: Request) -> JSONResponse:
        q = request.query_params
        error = "area, date and party are required"
        return json({"times": openings(q.get("area"), q.get("date"), q.get("party"), error)})

    async def reserve_v1(request: Request) -> JSONResponse:
        body = await read_body(request)
        b = reserve(body.get("time_id"), body.get("guest_name"), body.get("phone"),
                    body.get("party_size"))  # fmt: skip
        reservation = {
            "id": b["id"],
            "time_id": b["slot_id"],
            "area": b["resource"],
            "date": b["date"],
            "time": b["time"],
            "guest_name": b["guest_name"],
            "party_size": b["party_size"],
        }
        return json({"reservation": reservation}, 201)

    async def sections_v2(_: Request) -> JSONResponse:
        sections = [
            {"sectionId": a["id"], "label": a["name"], "blurb": a["description"],
             "maxCovers": a["max_party"]}
            for a in AREAS
        ]  # fmt: skip
        return json({"sections": sections})

    async def availability_v2(request: Request) -> JSONResponse:
        q = request.query_params
        section, day = q.get("sectionId"), q.get("day")
        found = openings(section, day, q.get("covers"), "sectionId, day and covers are required")
        items = [{"slotId": s["id"], "startsAt": f"{day}T{s['time']}:00", "sectionId": section}
                 for s in found]  # fmt: skip
        return json({"data": {"openings": items}})

    async def book_v2(request: Request) -> JSONResponse:
        body = await read_body(request)
        guest = obj(body, "guest")
        b = reserve(body.get("slotId"), guest.get("fullName"), guest.get("phoneNumber"),
                    body.get("covers"), V2_NAMES)  # fmt: skip
        booking = {
            "bookingId": b["id"],
            "slotId": b["slot_id"],
            "section": b["resource"],
            "startsAt": f"{b['date']}T{b['time']}:00",
            "covers": b["party_size"],
            "guest": {"fullName": b["guest_name"]},
        }
        return json({"booking": booking}, 201)

    api = {
        "v1": {
            "GET api/areas": areas_v1,
            "GET api/times": times_v1,
            "POST api/reservations": reserve_v1,
        },
        "v2": {
            "GET api/v2/sections": sections_v2,
            "GET api/v2/availability": availability_v2,
            "POST api/v2/bookings": book_v2,
        },
    }
    return build_app("Bella Bistro", state, api, page_renderer("bella_bistro.html", CLIENT))


app = create_app()
