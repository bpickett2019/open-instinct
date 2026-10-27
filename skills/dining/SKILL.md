---
name: dining
description: Find and reserve restaurants using source-backed preferences, current availability and confirmation evidence. Business-owner tasks use standing authority; personal and nonowner commitments retain their approval rules.
---

# Dining

Business mode: a bound owner task or enabled routine authorizes ordinary bookings
without a fresh yes. Ask for genuinely missing facts, especially dietary needs,
identity, total or scope; do not guess those. Honor actual owner constraints, not
personal default spend thresholds. Use only the hosted computer and verify the
confirmation. Provider login/payment challenges and Stripe Link consent remain.
Personal and nonowner rules below otherwise stay unchanged.

## Gather

From the message and memory (`memory_read`): party size, date and time window,
neighbourhood or distance, budget, occasion, cuisine, dietary notes for the
owner and the guests. Ask only for what is missing, one question per text. Two
unknowns at most before you start searching; guess sensibly on the rest and say
what you assumed.

## Find

1. `web_search` for candidates ("best izakaya near Mission SF open Thursday").
   `web_fetch` the top results and the restaurant's own site for hours, menu
   and dietary notes.
2. Shortlist 2 or 3 places. For each: name, neighbourhood, cuisine, price band,
   why it fits (one phrase), and anything about the dietary notes.
3. Text the shortlist to the owner in one message, plain prose, no list markup.
   Ask which one, or offer to book the first if they do not care.

## Hold, then confirm

1. Open the booking site on the desktop (skill `maritime-computer`). Resy and
   OpenTable both have mobile sites; Resy at resy.com, OpenTable at
   opentable.com. Search the restaurant, pick the date, party size and time.
2. If the site asks to log in, call `request_takeover` with reason "Log in to
   Resy for the Nopa booking". Never type a password or a card number.
3. For deposits or card holds, personal mode requires `ask_owner` and takeover.
   Business mode uses actual owner limits without a routine yes; provider-required
   payment consent still needs the owner. Never expose card details.
4. Put the reservation in a held state (the site's "reserve" button that can be
   cancelled without charge). Read the confirmation screen before you believe
   it. Zoom on the time and party size.
5. Personal mode: `ask_owner` with exact details unless already authorized to
   choose. Business mode: commit within the bound task's scope without asking again,
   then report the confirmation, total and cancellation terms.
6. On no: cancel the hold on the site and offer the next option.

## After booking

- Add it to the calendar (calendar app tool) with address and confirmation
  number in the description.
- Tell the owner in one text: place, time, party size, confirmation code, and
  cancellation deadline.
- If a guest's Instinct or phone is known, send them the time and address via
  `ask_instinct` (intent `confirm`) or `send_message`.
- `memory_write` any new preference the owner revealed ("likes counter seats",
  "no raw fish for Sam"). `journal_append` one line.

## When a partner or family member asks

`plans.propose` is open to partner, family and friend: you may search and hold.
`plans.commit` is `ask`: send the owner a one-line approval before you confirm,
and tell the requester you are checking. Do not reveal the owner's calendar
titles; say only whether the owner is free.

## Voice

Agent: Three options near the Mission for Thursday at 7, all fine for Sam's
shellfish allergy. Nopa, Cal-American, lively, about $60 a head. Foreign
Cinema, films on the wall, a bit pricier. Lolinda, Argentine steaks, easiest to
get. Which one?

Agent: Held a table at Nopa, Thu Oct 9, 7pm for 2. Confirm and I'll lock it in?

Agent: Booked. Nopa, Thu 7pm, 2 people, code RSY-48KQ. Free cancellation until
Thursday noon. Added to your calendar and sent Sam the details.

## Do not

- Do not enter card secrets; use provider consent/takeover when payment requires it.
- Do not book two places for the same slot "just in case".
- Do not promise a table until the confirmation screen shows it.
