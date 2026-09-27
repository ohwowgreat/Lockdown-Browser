# Locking down student devices

ExamLock runs in a browser tab. It can see what happens inside that tab and
whether the browser window has focus. It cannot see other apps, overlays that
float above the browser without taking focus, what is on a second display, or
a phone on the desk. The exam builder says so in its detection panel.

Closing that gap is a device job, not a web-page job. This page lists what a
school can do with the device management it probably already has, what each
option buys, and when a native client would be worth building.

## Options by platform

Each of these locks the device to one browser or one URL for the exam period,
so an AI assistant or a dictionary app cannot be opened or floated above the
exam in the first place.

### ChromeOS, managed through Google Admin

- Put exam devices in their own organizational unit and apply a **managed
  guest session** or a **kiosk** deployment that opens the ExamLock join URL.
  Students sign into nothing else.
- Use **URLAllowlist** and **URLBlocklist** on that unit so the browser can
  reach only the ExamLock origin, plus `www.desmos.com` if any exam uses the
  built-in calculators.
- Extensions are controlled by the same unit. Allow none for exam devices.

### Windows, school-managed

- **Assigned Access** (kiosk mode) with a dedicated exam account that runs
  Microsoft Edge in kiosk mode pointed at the ExamLock join URL. Use the
  multi-app variant only if an approved second app is genuinely needed.
- For that account, Alt+Tab, the Start menu, the taskbar and other apps are
  unavailable by design.

### macOS and iPadOS, through Apple School Manager and an MDM

- **Single App Mode** pushed by the MDM locks the device to the browser for
  the exam window. On macOS an app allowlist restriction profile is the lighter
  alternative.
- **Apple Classroom** lets the teacher "lock into app" live from their own
  device, and unlock when the exam ends.
- On a single iPad, **Guided Access** does the same thing with a passcode and
  no MDM.

### Unmanaged or bring-your-own devices

- A desktop shortcut that launches the browser in kiosk mode, for example:

  ```
  chrome --kiosk --incognito https://your-examlock.example/student
  ```

  This removes tabs and the address bar and pairs well with ExamLock's own
  fullscreen and violation tracking. It is not tamper-proof: a student can
  still close the window or switch apps, and ExamLock will record that.
- The realistic posture here is ExamLock's flags plus a teacher walking the
  room.

## What each option buys

| Option | Other apps | Overlays | Second display | Phones | Needs |
|---|---|---|---|---|---|
| Managed kiosk or Single App Mode | Blocked | Blocked | Usually blocked by the same policy | No | Device management |
| Classroom lock or Guided Access | Blocked | Blocked | Not applicable on iPad | No | Teacher device, supervision |
| Kiosk shortcut on BYOD | Discouraged, easy to escape | No | No | No | Nothing |
| ExamLock alone | Detects switching | No | Flags it, cannot see it | No | Nothing |

Nothing on this page stops a phone. Only seating, sight lines and a teacher
in the room do that.

## Preparing ExamLock for kiosk use

- Point the kiosk at `/student` so the device lands on the join page.
- Serve ExamLock over HTTPS and set `JWT_SECRET`. URL policies match on the
  exact origin, so decide the hostname once.
- If URL filtering is on, allow `www.desmos.com` as well. The per-question
  calculators load their script from there and show "Calculator unavailable"
  without it.
- Kiosk browsers are already fullscreen at the operating-system level.
  ExamLock's own fullscreen request still runs inside that window and is
  harmless; the "Exam should be fullscreen" bar clears once the student has
  clicked once.

## When a native client is worth it

A native client would be an Electron or Tauri shell around the student page:
always-on-top fullscreen, app switching blocked where the operating system
allows it, a scan of running processes to flag known tools, screen capture
disabled where possible. It has to be installed on every student machine with
admin rights, built and signed for each operating system, and kept updated in
a cat-and-mouse race with the tools it tries to block.

Build one only when all three hold:

1. The school cannot manage the devices, so nothing above applies.
2. Environment flags and violations show that overlay tools are a real,
   recurring problem, not a hypothetical one.
3. The exams are high-stakes enough to justify a separate multi-week project
   and its upkeep.

If any managed option above is available, use it first. The native client is
the answer only when it cannot be.
