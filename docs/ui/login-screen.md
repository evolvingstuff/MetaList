# Login screen

The login and loading screens are one dark screen with the MetaList logo (the
teaser's block **M** over two bars, static). The logo sits at a fixed distance
from the top and never moves; everything else happens in the panel under it.

## Panel under the logo
- At first only the logo shows. Once the namespace list has loaded, the panel
  fades in as a whole (about 250 ms): the namespace dropdown (when there is more
  than one namespace), the password field, then **OK**, 10 px apart and 72 px below
  the logo. If the list fails to load, the panel appears anyway with the error.
- The panel is transparent rather than hidden while it waits, so a browser can
  fill a saved password before it fades in; a filled field keeps the dark look
  (no yellow or blue autofill background).

## Logging in
| Moment | Screen |
|---|---|
| Press OK (or Enter) | Nothing moves. The button reads "Checking…" and is disabled |
| An upgrade is due (`/auth/status` `database_upgrade_pending`) | While checking, a grey italic note under OK: "Backing up and upgrading this namespace…" |
| Wrong password, too many attempts, or the request fails | The reason appears under OK; the field is emptied and focused. Nothing moved |
| Password accepted | The form slides out to the left while the loading view slides in from the right (350 ms, within the logo's width) |
| Loading | A progress bar the logo's width that never moves backwards; under it, in grey italics, the current step and the seconds elapsed ("Decrypting notes into memory… · 4s") |
| Loading done | The app appears |
| Loading fails | The error replaces the step line in red, with the elapsed time frozen; the app does not open |

With the system's reduce-motion setting the fades and the slide become instant.

The login-style screens (login, Session locked, the tab opening a namespace)
reserve no scrollbar strip, since nothing on them scrolls: with always-visible
scrollbars the strip showed white at the right edge and shifted the logo when
the panel appeared. The app keeps its strip, so the notes do not shift when the
list starts to scroll (`main.css`, `html:has(> body > .login-page…)`).

## No white page in between
A password namespace's page opens straight on the login screen when a login is
certain: the browser has no session the server still knows (no cookie, as on a
first visit or after logging out, or a cookie from a session that has ended: the
server restarted, the password changed) or the URL asks for one
(`force_reauth=1`). A reload with a live session waits for the session check
instead, so a logged-in reload goes straight to the app
(`app/presentation/login_page.py`).

## Switching namespace
Picking another namespace in the dropdown loads it in this tab, so switching
back and forth keeps one tab (Back returns to the previous namespace). At the
moment of the pick everything under the logo disappears (no fade-out; the logo
stays put), so the old name is never seen coming back; when the wait passes a
second (the namespace is starting) a grey italic "Starting *name*…" fades in
under the logo. That namespace's login screen then arrives with the logo in
place and its panel fading in. The address asks for the login screen (`force_reauth=1`),
since this tab never owns a session there, so no white page shows while it
checks a cookie from another tab's session. A refused switch fades the panel back
in, with the reason under the dropdown and this namespace selected again.

In the app, Open/Switch namespace offers Open in This Tab (the same as here) and Open in
New Tab. A new tab shows this screen's logo, exactly where the namespace's login screen puts
it, until the namespace answers
(`app/static/js/modules/modals/namespace-loading-page.js`, which copies this
screen's own styles from the page).

## Session locked
`/locked` uses the same look: the logo, "Session locked" and one button (Go to
Login, or Take Over Session for a namespace without a password). The button
fades the heading and button out (200 ms) before opening the login page, where
the panel then fades in under the same logo.

## Password changes
Adding, changing or removing the password ends every session on the server.
Background requests answered "not logged in" while the change runs (the
session check, reminders) do not send the page to Session locked; the Password
dialog then reloads the page into the new state (`Auth.runPasswordChange`). After
a failed change, a lost session locks the page as usual.

## Code
- Markup: `app/templates/index.html`, `app/templates/locked.html`, shared logo
  `app/templates/_logo_mark.html`.
- Behaviour: `app/static/js/modules/auth.js` (form, busy state, slide, progress,
  elapsed time), `app/static/js/locked.js`.
- Styles: the login section at the top of `app/static/css/main.css`.
