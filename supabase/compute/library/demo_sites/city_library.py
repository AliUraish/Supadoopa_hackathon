"""City Library (port 4103): a deliberately different flow (search -> hold) plus a contact form.

v1  GET  api/books?q                  -> {books: [{id, title, author, year, available, copies}]}
    POST api/holds {book_id, name, card_number, email}  -> 201 {hold: {id, title, pickup_by, ...}}
    POST api/messages {name, email, message}            -> 201 {message: {id, received_at}}
v2  GET  api/v2/catalog/search?query       -> {data: {results: [{itemId, title, creator, ...}]}}
    POST api/v2/reservations {itemId, patron: {fullName, cardNumber, emailAddress}}
                                           -> 201 {reservation: {reservationId, title, readyBy}}
    POST api/v2/inquiries {sender: {fullName, emailAddress}, body}  -> 201 {inquiry: {inquiryId}}

A hold uses up one copy (none left -> 409). Search lists available titles first.
"""

from __future__ import annotations

import unicodedata
from datetime import date, timedelta

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from demo_sites.common import (
    ApiError,
    State,
    build_app,
    check_email,
    json,
    new_id,
    now_iso,
    obj,
    page_renderer,
    read_body,
    require,
)

CATALOG = [  # title, author, year, copies
    ("Pride and Prejudice", "Jane Austen", 1813, 3),
    ("Moby-Dick", "Herman Melville", 1851, 2),
    ("The Great Gatsby", "F. Scott Fitzgerald", 1925, 3),
    ("Frankenstein", "Mary Shelley", 1818, 2),
    ("Little Women", "Louisa May Alcott", 1868, 3),
    ("The Adventures of Sherlock Holmes", "Arthur Conan Doyle", 1892, 3),
    ("Jane Eyre", "Charlotte Brontë", 1847, 2),
    ("Dracula", "Bram Stoker", 1897, 2),
    ("Middlemarch", "George Eliot", 1871, 1),
    ("The Time Machine", "H. G. Wells", 1895, 2),
    ("A Tale of Two Cities", "Charles Dickens", 1859, 2),
    ("Emma", "Jane Austen", 1815, 2),
]
BOOKS = [
    {"id": f"b{101 + i}", "title": title, "author": author, "year": year, "copies": copies}
    for i, (title, author, year, copies) in enumerate(CATALOG)
]
BY_ID = {b["id"]: b for b in BOOKS}
PICKUP_DAYS = 7
V2_HOLD_NAMES = {"name": "patron.fullName", "card_number": "patron.cardNumber",
                 "email": "patron.emailAddress"}  # fmt: skip
V2_MESSAGE_NAMES = {"name": "sender.fullName", "email": "sender.emailAddress", "message": "body"}

CLIENT = {
    "v1": """\
const client = {
  search: async (q) => (await get('api/books?' + new URLSearchParams({ q }))).books.map((b) =>
    ({ id: b.id, title: b.title, author: b.author, year: b.year, available: b.available,
       copies: b.copies })),
  hold: async (book, name, card, email) => {
    const { ok, body } = await post('api/holds', { book_id: book, name, card_number: card, email });
    if (!ok) return { error: body.error };
    return { id: body.hold.id, title: body.hold.title, pickup: body.hold.pickup_by };
  },
  contact: async (name, email, message) => {
    const { ok, body } = await post('api/messages', { name, email, message });
    return ok ? { id: body.message.id } : { error: body.error };
  },
};
""",
    "v2": """\
const client = {
  search: async (q) => {
    const query = new URLSearchParams({ query: q });
    return (await get('api/v2/catalog/search?' + query)).data.results.map((r) =>
      ({ id: r.itemId, title: r.title, author: r.creator, year: r.published,
         available: r.copiesAvailable, copies: r.copiesTotal }));
  },
  hold: async (book, name, card, email) => {
    const patron = { fullName: name, cardNumber: card, emailAddress: email };
    const { ok, body } = await post('api/v2/reservations', { itemId: book, patron });
    if (!ok) return { error: body.error };
    const r = body.reservation;
    return { id: r.reservationId, title: r.title, pickup: r.readyBy };
  },
  contact: async (name, email, message) => {
    const sender = { fullName: name, emailAddress: email };
    const { ok, body } = await post('api/v2/inquiries', { sender, body: message });
    return ok ? { id: body.inquiry.inquiryId } : { error: body.error };
  },
};
""",
}


def fold(text: str) -> str:
    """Lowercase without accents, so "bronte" finds "Brontë"."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def create_app() -> FastAPI:
    state = State("holds", "messages")
    holds, messages = state.tables["holds"], state.tables["messages"]

    def available(book: dict) -> int:
        return book["copies"] - sum(1 for h in holds.values() if h["book_id"] == book["id"])

    def search(query: str | None) -> list[tuple[dict, int]]:
        words = fold(query or "").split()
        hits = [b for b in BOOKS if all(w in fold(f"{b['title']} {b['author']}") for w in words)]
        return sorted(((b, available(b)) for b in hits), key=lambda hit: hit[1] == 0)

    def place_hold(book_id, name, card, email, names: dict | None = None) -> dict:
        book = BY_ID.get(book_id) if isinstance(book_id, str) else None
        if not book:
            raise ApiError(404, "unknown_book")
        if available(book) <= 0:
            raise ApiError(409, "no_copies_available")
        fields = require({"name": name, "card_number": card, "email": email}, names)
        check_email(fields["email"])
        hold = {
            "id": new_id("hold"),
            "book_id": book["id"],
            "title": book["title"],
            **fields,
            "pickup_by": (date.today() + timedelta(days=PICKUP_DAYS)).isoformat(),
            "created_at": now_iso(),
        }
        holds[hold["id"]] = hold
        return hold

    def send_message(name, email, message, names: dict | None = None) -> dict:
        fields = require({"name": name, "email": email, "message": message}, names)
        check_email(fields["email"])
        msg = {"id": new_id("msg"), **fields, "received_at": now_iso()}
        messages[msg["id"]] = msg
        return msg

    async def books_v1(request: Request) -> JSONResponse:
        books = [{**b, "available": n} for b, n in search(request.query_params.get("q"))]
        return json({"books": books})

    async def holds_v1(request: Request) -> JSONResponse:
        body = await read_body(request)
        h = place_hold(body.get("book_id"), body.get("name"), body.get("card_number"),
                       body.get("email"))  # fmt: skip
        hold = {k: h[k] for k in ("id", "book_id", "title", "name", "pickup_by")}
        return json({"hold": hold}, 201)

    async def messages_v1(request: Request) -> JSONResponse:
        body = await read_body(request)
        m = send_message(body.get("name"), body.get("email"), body.get("message"))
        return json({"message": {"id": m["id"], "received_at": m["received_at"]}}, 201)

    async def search_v2(request: Request) -> JSONResponse:
        results = [
            {"itemId": b["id"], "title": b["title"], "creator": b["author"],
             "published": b["year"], "copiesAvailable": n, "copiesTotal": b["copies"]}
            for b, n in search(request.query_params.get("query"))
        ]  # fmt: skip
        return json({"data": {"results": results}})

    async def reservations_v2(request: Request) -> JSONResponse:
        body = await read_body(request)
        patron = obj(body, "patron")
        h = place_hold(body.get("itemId"), patron.get("fullName"), patron.get("cardNumber"),
                       patron.get("emailAddress"), V2_HOLD_NAMES)  # fmt: skip
        reservation = {
            "reservationId": h["id"],
            "itemId": h["book_id"],
            "title": h["title"],
            "readyBy": h["pickup_by"],
        }
        return json({"reservation": reservation}, 201)

    async def inquiries_v2(request: Request) -> JSONResponse:
        body = await read_body(request)
        sender = obj(body, "sender")
        m = send_message(sender.get("fullName"), sender.get("emailAddress"), body.get("body"),
                         V2_MESSAGE_NAMES)  # fmt: skip
        return json({"inquiry": {"inquiryId": m["id"], "receivedAt": m["received_at"]}}, 201)

    api = {
        "v1": {
            "GET api/books": books_v1,
            "POST api/holds": holds_v1,
            "POST api/messages": messages_v1,
        },
        "v2": {
            "GET api/v2/catalog/search": search_v2,
            "POST api/v2/reservations": reservations_v2,
            "POST api/v2/inquiries": inquiries_v2,
        },
    }
    return build_app("City Library", state, api, page_renderer("city_library.html", CLIENT))


app = create_app()
