# St Johns Park Car Valeting — Website

The public website for St Johns Park Car Valeting Service, Waterford, in the "Obsidian & Gold" design.
It is plain HTML, CSS and JavaScript ES modules. There is no build step, framework or `npm install`: the files in this
folder are the site. Booking, tracking and accounts are handled by the booking API in
[`../../stjohns-backend`](../../stjohns-backend/README.md).

## Structure

| Page | What it is | Page CSS | Page script |
|---|---|---|---|
| `index.html` | Homepage: hero slideshow, services (live prices), process, before/after slider, gallery preview, about, visit + next free slot | `css/home.css` | `js/home.js` |
| `gallery.html` | Photo gallery: Exterior / Detail / Wheels filters and a full-screen photo viewer | `css/gallery-page.css` | `js/gallery.js` |
| `booking.html` | Book a valet | `css/booking.css` | `js/booking.js` |
| `track.html` | Track a booking by reference and phone number | `css/account.css` | `js/track.js` |
| `account.html` | Sign in / create an account | `css/account.css` | `js/account.js` |
| `my-bookings.html` | A signed-in customer's bookings | `css/account.css` | `js/my-bookings.js` |
| `reset-password.html` | Choose a new password (link from the reset email) | `css/account.css` | `js/reset.js` |

```
css/site.css       Shared design system: colour/type tokens, header, footer, buttons, forms, cards, page band,
                   toasts, cookie banner. Every page loads it first, then its own page CSS.
js/config.js       Where the API lives (API_BASE) and the business details.
js/api.js          Small fetch client for the API: sends the session cookie, times out, throws friendly ApiErrors.
js/ui.js           Shared page behaviour: mobile menu, "Sign in" → "My bookings" swap, footer year, toasts,
                   safe DOM builder and date helpers. Every page script imports it.
js/<page>.js       One ES module per page (loaded with <script type="module">).
analytics.js       Google Analytics with a cookie-consent banner (a classic script, loaded on every page).
assets/img/        Optimised WebP images. Photos come in two widths, -1280.webp and -2400.webp, used through
                   srcset; the logo comes in -600 and -1200.
assets/hero.png    Original high-resolution source photo (2.7 MB). No page links to it; keep it as a source only.
```

Pages contain no inline scripts or `onclick=` attributes. The Content-Security-Policy on every page blocks them.

## Run it locally

1. **Start the API** on `http://localhost:8080` by following [`../../stjohns-backend/README.md`](../../stjohns-backend/README.md#local-development).
   In short: `docker compose up -d`, `npm install`, `npm run migrate`, `npm run dev`.
2. **Serve this folder** over HTTP on port 5500:

   ```bash
   cd stjohns-frontend/stjohns-frontend
   python -m http.server 5500
   ```

   Then open http://localhost:5500. (`npx serve -l 5500` works too.)

- Use port **5500**. The API only accepts browser requests from the origins in its `ALLOWED_ORIGINS` setting, and the
  backend's `.env.example` lists `http://localhost:5500` and `http://127.0.0.1:5500`. If you use another port, add it there,
  or sign-in and booking calls will be blocked by CORS.
- Opening the files directly (`file://…`) does not work, because browsers will not load ES modules from `file://`.
- The homepage and gallery still work when the API is down; prices and the next free slot just stay hidden. Booking,
  tracking and account pages need the API.

## Where the API URL is set

Everything goes through **`js/config.js`**:

- On `localhost` / `127.0.0.1` the API is `http://<same host>:8080`.
- On the live site it is `https://api.<your domain>`, with `www.` removed. For example, `www.example.ie` uses `api.example.ie`.
  This matches the domain setup in the backend README.
- To use any other address, edit `API_BASE` in `js/config.js`. You can also set `window.SJP_API_BASE` from a classic
  `<script src>` that loads before the modules; an inline script would be blocked by the CSP.

## Google Analytics

- Every page's `<html>` tag carries the GA4 Measurement ID: `<html lang="en" data-ga-id="G-XXXXXXXXXX">`.
  It is empty for now. **Set it on all seven pages.** While it is empty, `analytics.js` does nothing: no banner and no tracking.
- `analytics.js` shows a cookie banner and loads Google Analytics only after the visitor chooses *Allow analytics*,
  as Irish/EU rules require. The choice is stored in `localStorage` (`sjp-analytics-consent`). The footer's *Cookie settings*
  link (`data-cookie-settings`) shows the banner again so visitors can change their mind.
- Events are recorded only after consent: `click_to_call` (any `tel:` link), `view_gallery_photo` (gallery viewer), and
  anything a page sends through `window.sjpTrack(name, params)`. For example, the booking page sends `booking_submitted`.
  `analytics.js` also sends `begin_booking` when an element with `data-open-booking` is clicked. That attribute came from
  the old booking pop-up and no current page uses it, so add it to the "Book" links if you want that event.
- To show the analytics in the owner dashboard, follow section 8 of the backend README.

## Before launch: tighten the Content-Security-Policy

Each page has the same CSP in a `<meta http-equiv="Content-Security-Policy">` tag. For local development its
`connect-src` currently allows any HTTPS host plus the local API:

```
connect-src 'self' https: http://localhost:8080 http://127.0.0.1:8080
```

At launch, replace it on **every page** with the real API domain and the Google Analytics endpoints only, and remove the
localhost entries:

```
connect-src 'self' https://api.yourdomain.ie https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com
```

`img-src 'self' data: https:` can also be narrowed to `'self' data: https://*.google-analytics.com https://*.googletagmanager.com`,
because every site image is local. If your host can send real HTTP headers, send the CSP there as well and add
`frame-ancestors 'none'` and HSTS. A `<meta>` CSP cannot set `frame-ancestors`.

## Gallery photos

The gallery uses only local images. Do not hotlink photos from other websites. To add or replace a photo:

1. Export it as WebP at 1280 px and 2400 px wide (16:9 works best) into `assets/img/`, e.g. `job-golf-1280.webp` and
   `job-golf-2400.webp`.
2. In `gallery.html`, copy one `<li class="g-item">` block. Set `data-category` to `exterior`, `detail` or `wheels`, point the
   link `href` at the -2400 file and the `img` `src`/`srcset` at both files, and write the `alt` text and caption.
   Add `g-tall` or `g-wide` to the `<li>` for a bigger tile.
3. The filter counts, photo viewer and arrow-key navigation pick it up automatically.

Detail tiles can zoom into part of a photo with a `crop crop-…` class (see `css/gallery-page.css`). Each crop sets a
focal point and a zoom level, and the same crop is used in the viewer. The current photos show the standard of finish
rather than specific St Johns Park jobs, and a note under the grid says so. Remove that note once the gallery shows
your own customer work.

## Deploying

Upload the contents of this folder to any static host: GoDaddy hosting, Netlify, Cloudflare Pages, S3 or similar.
No build is needed. Point `www.yourdomain.ie` at it and run the API at `api.yourdomain.ie`, as described in the backend README.
