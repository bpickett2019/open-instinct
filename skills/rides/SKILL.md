---
name: rides
description: Request an Uber or Lyft for the owner through the desktop browser at m.uber.com or lyft.com. Use when the owner asks for a ride, a car, a pickup, or to get somewhere now or at a set time. Confirm pickup and destination, show the price before requesting, hand over for payment or verification prompts, and report the driver and ETA.
---

# Rides

Rides happen on the desktop in a logged-in mobile web session. The session is
persistent, so after one takeover to log in, later rides usually need none.

Business mode: the bound owner task or enabled routine authorizes the ride without
a fresh yes. Check current price against actual owner limits, not personal defaults.
Only the hosted computer is available. Missing pickup/identity or provider challenges
become durable waits. Nonowner and personal rules below still apply to those modes.

## Gather

Pickup (exact address or "where I am"), destination, when (now or a time),
riders, and service level (default the cheapest standard car unless memory says
otherwise). The owner's current location is `owner.location.exact`; you only
know it if the owner tells you or memory has a home or work address. If the
owner says "pick me up" without a place, ask once: "Where should the car come
to?"

## Request

1. Open m.uber.com (or lyft.com if the owner prefers Lyft or Uber has no cars).
   Use skill `maritime-computer`. If the site shows a login or phone
   verification, `request_takeover` with reason "Log in to Uber". Never type a
   verification code the owner texts you; the owner enters it during takeover.
2. Enter destination first, then pickup. Click into each field and verify the
   field is focused before typing. Pick the suggestion that matches the full
   address. Zoom to confirm the pin is on the right side of the street.
3. Read the ride options. Note the price and ETA for the chosen service.
4. Personal mode: show price and ask unless already authorized under spend policy.
   Business mode: verify pickup, destination, current total and actual owner limits,
   then request without a fresh yes. Report the price with the result.
5. Request. If a payment or card prompt appears, `request_takeover` with reason
   "Confirm payment for the Uber". Do not add or select a card yourself.
6. Read the screen after requesting: driver name, car, plate, ETA. Text the
   owner those four facts in one message.

## While waiting

Personal mode: check periodically and text only meaningful changes. Business mode:
use durable timed checks, not a model call sleeping for minutes. Verify driver,
car, plate and ETA from current state before reporting arrival or reassignment.

## Scheduled rides

For "a car at 6am tomorrow", use the site's schedule option and then
`schedule_create` a one-shot wake 10 minutes before pickup with the prompt
"Check the scheduled Uber for the owner and text the driver details." Say both
to the owner.

## For other people

A partner or family member asking for a ride for themselves: `plans.propose`
lets you look up the price, `plans.commit` and `purchase` are `ask`, so the
owner gets a one-line approval text before you request. A ride for the owner
requested by someone else ("send Maria a car") is the same: price to the owner,
yes from the owner.

## Voice

Agent: UberX from 1 Main St to South Station, $18, 3 minutes away. Request it?

Agent: On the way. Priya in a grey Prius, plate 8KLM204, 4 minutes.

Agent: Priya is outside.

## Do not

- Personal mode: do not request before showing the price. Business: honor actual limits.
- Do not select or add payment methods, or enter verification codes.
- Do not guess the pickup location.
- Do not keep texting while nothing changes.
