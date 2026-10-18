# Ptixy Player for the p5.js Web Editor

This is the hosted counterpart of `ptixy_player/`, packaged like the working `ptixy_online/` editor. It uses p5.js 2.3.4 and requires no files outside this folder.

## Setup

1. Create or duplicate a sketch in [the p5.js Web Editor](https://editor.p5js.org/) and select p5.js **2.3.4**.
2. Replace `sketch.js`, add `flipdot.js`, and copy the supplied `index.html` and `style.css`. The HTML loads `flipdot.js` before `sketch.js`; no additional libraries are needed.
3. On the computer running your browser, start either `node flipdot_server.js` or `python flipdot_server.py` using the repository's normal setup.
4. Run the sketch and click **Connect**. Allow access to local services if your browser asks. Playback starts even before connecting.

For local testing, serve the repository with your development server and open `/ptixy_player_online/`, for example `http://127.0.0.1:5501/ptixy_player_online/`.

## Playlist and controls

The 13 formulas and current **15-second** duration are copied from the local player. Edit `makePrograms()` in `sketch.js` to change the playlist, or `nSecondsToRunProgram` to change the duration (use `60` for one minute per formula). Timing uses elapsed time and continues while disconnected.

- Left/right arrows: previous/next formula.
- Digits 0–9: select that numbered formula.
- Selecting a formula resets its timer, frame counter `t`, and previous-frame memory `P[]`.

The current formula appears in a read-only text area. Faulty formulas are reported and skipped. If the entire playlist is invalid or empty, the last complete frame is held.

## Connection

`flipdot.js` is copied from the working online editor, with host-neutral comments and permission feedback. Its `FLIPDOT_SERVER_URL` defaults to `http://localhost:3000`; change the port there if you change the server's HTTP API port. The hosted sketch does not fetch the repository's JSON configuration. The server still enforces its `transmitEnabled` setting; `ENABLE_TX = false` in `sketch.js` sends preview requests without moving dots.

The `tx:` indicator is yellow while awaiting connection, green after a recent successful bridge response, and red after failure. Green confirms communication with the bridge, not physical movement of the dots. Once Connect is clicked, ordinary outages retry automatically, sending only the latest complete frame. Detected browser-permission or iframe-policy denials pause retries and show an explanation below the formula. Program errors take priority over connection messages.

Keep only one transmitting sketch open at a time.
