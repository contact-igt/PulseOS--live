# WhatsApp confirmations and reminders — how they work, and why none get lost

## What happens, step by step
1. **Book** an appointment: it is *Booked*. Nothing is sent.
2. **Confirm** it (the patient agreed on the phone or by reply): PulseOS plans **one** WhatsApp *Appointment Confirmation* straight away and **one reminder 1 hour before** the visit.
3. The messages go out by themselves at the right time. Pressing *Confirm* again never sends a second message.
4. If the appointment is **moved**, the old reminder is cancelled and the visit is *Booked* again until you confirm the new time. If it is **cancelled**, a **no-show** or **completed**, nothing more is sent.
5. A reminder is never created for a time that has already passed. A visit booked 40 minutes ahead gets its confirmation, but no "1 hour before" message.

## If the computer restarts at the wrong moment
Confirming a visit is saved first; the message is planned a moment later. If the system restarted in that moment, the visit would be confirmed but have no message planned. To make sure that cannot stay unnoticed, PulseOS **checks every 5 minutes**: for every *Confirmed* visit in the next 7 days it asks "should there be a confirmation and a reminder?" and adds only what is missing. It only fills gaps: it never adds a second copy, never brings back a message that was cancelled, and never re-confirms a visit that was confirmed more than a day ago (so switching WhatsApp on later does not message everyone). Reminders for upcoming visits are still added. The sending step re-checks the visit just before it sends, and drops the message if the visit is no longer confirmed.

You do nothing for this; it runs in the background. Staff can tell it worked by opening the visit: the WhatsApp confirmation shows on the patient's timeline.

## When WhatsApp is not connected
The visit stays *Booked* / *Confirmed* as normal. The message shows **Blocked** (not connected) or **Failed** with the reason; it is never shown as sent. Call the patient instead.

## For the administrator
* The 5-minute check is the `notification-reconcile` job in the API worker. Set `NOTIFICATION_RECONCILE_INTERVAL_MS` to change the interval; `JOBS_DISABLED=true` turns the whole worker off on a second API instance.
* It logs counts only (visits looked at, messages recovered, errors) — never a patient's name, phone number or the message text.
* Rules live in **Settings → Reminders** (Admin). Namokar's pilot setting is: Confirmation, plus one reminder 1 hour before; the 1-day reminder is off.
