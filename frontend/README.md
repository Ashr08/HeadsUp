# HeadsUp frontend

A dependency-free web frontend prototype matching the provided HeadsUp design references. It includes the Listening, Sounds, Settings, and Teach a sound pages.

## Run locally

Open a terminal in this folder and run:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`. Microphone access requires localhost or HTTPS. The frontend expects the FastAPI backend at `http://localhost:8000` by default; change this in **Settings → Backend connection**. Configure CORS on FastAPI to allow `http://localhost:4173`.

## Backend routes used

- `GET /health`
- `POST /predict` with a one-second, 16 kHz mono 16-bit PCM WAV file in multipart field `audio`
- `GET /sounds`
- `POST /custom-sound` with `name` and five multipart `clips`
- `DELETE /custom-sound/{name}`
- Optional account route used by the sign-up form: `POST /auth/signup` with `{name, email}`

The frontend captures mic audio in the browser, sends overlapping one-second WAV chunks to `/predict`, and uses model confidence plus each sound's threshold to decide whether to show an alert.

## Spotify and Apple Music

The listening page presents both providers and does not show music playback until a service is connected. The **Connect** buttons currently explain the required next step; they do not authenticate yet. A real integration needs provider developer setup, OAuth callback/token handling, and an authenticated playback SDK or embed. Spotify and Apple Music credentials should not be placed directly in browser code. Likewise, sign-up is a frontend form that expects an authentication endpoint; it does not store passwords or create accounts by itself.
