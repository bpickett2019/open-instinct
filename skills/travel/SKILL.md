---
name: travel
description: Search and book flights and hotels with full current totals and confirmation evidence. Business-owner tasks use standing authority and actual limits; personal travel retains exact-itinerary approval. Provider logins and payment consent remain.
---

# Travel

Personal mode asks before every booking; `travel.book` is in `neverWithoutAsk`
by default. Business-owner bound tasks and enabled routines authorize ordinary
bookings without a fresh yes, subject to actual owner constraints. Missing traveler
identity, dates or commercial terms are blockers, not facts to invent. Nonowner
restrictions remain unchanged. Use the hosted computer for business travel work.

## Gather

Dates (fixed or flexible), origin and destination, number of travellers, cabin
or hotel class, budget, loyalty programmes, and constraints from memory (aisle
seat, no red-eyes, hotel near the venue). Ask for what is missing, one question
per text. Save new preferences with `memory_write`.

## Search

Use the desktop (skill `maritime-computer`). Flights: Google Flights
(google.com/travel/flights) for the overview, then the airline's own site for
the fare and bags. Hotels: Google Hotels for the overview, then the hotel's own
site and one aggregator for price. `web_search` is fine for background (visa
rules, airport transfer time) but prices come from the booking pages.

For each option record: carrier or property, times or dates, duration and stops,
fare class, what is included (bags, seat, breakfast, cancellation), and the
total with taxes and fees. Zoom on the total; sites hide fees until late.

## Compare

Text 2 or 3 options in one message. Lead with the total. Say the trade-off in a
phrase. Recommend one and say why in one sentence.

Agent: Three options for Boston to SFO, Oct 20 to 24. JetBlue nonstop out 7:10am
back 4:30pm, $412 total with a carry-on. United nonstop out 9am back 6pm, $468,
checked bag included. Delta one stop, $355 but adds three hours each way. I'd
take JetBlue. Want me to book it?

## Book

1. Personal mode: `ask_owner` with the exact itinerary and total, then wait.
   Business mode: recheck final itinerary, total and actual owner limits, then proceed
   under the task's authority without another yes.
2. Fill passenger details from memory only if the owner has stored
   them there and told you to use them. Dates of birth, passport numbers and
   loyalty numbers that live in the Vault are entered by the owner during a
   `request_takeover`; never ask the owner to text them to you.
3. Provider-required payment/login challenges need `request_takeover`; Stripe Link
   still needs provider-hosted per-purchase consent. Personal mode stops at payment
   every time. If takeover fails, persist a blocker and do not replay the booking.
4. Read the confirmation page. Zoom on the record locator, dates and total.
   Save a screenshot to the workspace (`workspace/travel/<trip>/confirmation.png`).

## After booking

- Calendar: create events for each flight (departure to arrival, airport
  terminals in the location) and the hotel stay. Include the record locator.
- `schedule_create` a one-shot reminder 24 hours before each departure with the
  prompt "Check in for JetBlue BOS-SFO Oct 20, locator ABC123, then text the
  owner the boarding pass status." Online check-in itself happens when that
  fires, again through the desktop, with a takeover if the site needs a login.
- Record the provider confirmation and checked total in business task evidence;
  personal mode also uses `journal_append`. Never persist card secrets.
- Text the owner: what was booked, total, locator, and that reminders are set.

## Changes and cancellations

Find current fare rules, fee and refund form first. Personal changes need a yes.
Business changes within the owner's request use standing authority and actual limits.
Verify the changed booking; do not call it an atomic undo or replay uncertain work.

## Do not

- Personal mode: do not book without an explicit yes for the exact itinerary and total.
- Do not enter card numbers, passport numbers or loyalty logins yourself.
- Do not quote a fare without the total including taxes and the bag you know
  the owner needs.
- Do not hold two bookings for the same trip.
