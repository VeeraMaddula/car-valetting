'use strict';
// Google Analytics 4, loaded only after the visitor agrees (EU/Irish cookie rules).
// Set the Measurement ID on the page: <html data-ga-id="G-XXXXXXXXXX">. With no ID, nothing loads or shows.
(function () {
  var MEASUREMENT_ID = document.documentElement.getAttribute('data-ga-id') || '';
  var STORAGE_KEY = 'sjp-analytics-consent';
  var loaded = false;

  function readChoice() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function saveChoice(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (e) { /* private mode: ask again next visit */ }
  }

  function loadAnalytics() {
    if (loaded || !/^G-[A-Z0-9]+$/.test(MEASUREMENT_ID)) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', MEASUREMENT_ID);
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(MEASUREMENT_ID);
    document.head.appendChild(script);
  }

  /** Record an event, e.g. sjpTrack('begin_booking'). Does nothing until the visitor has agreed. */
  window.sjpTrack = function (name, params) {
    if (loaded && window.gtag) window.gtag('event', name, params || {});
  };

  function removeBanner() {
    var banner = document.getElementById('cookieBanner');
    if (banner) banner.remove();
  }

  function choose(value) {
    saveChoice(value);
    removeBanner();
    if (value === 'granted') loadAnalytics();
  }

  function showBanner() {
    if (document.getElementById('cookieBanner')) return;
    var banner = document.createElement('section');
    banner.id = 'cookieBanner';
    banner.className = 'cookieBanner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie choice');
    var text = document.createElement('p');
    text.textContent = 'Can we use analytics cookies to count visits and improve the site? We never use them for advertising.';
    var actions = document.createElement('div');
    actions.className = 'cookieActions';
    var decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'cookieDecline';
    decline.textContent = 'No thanks';
    decline.addEventListener('click', function () { choose('denied'); });
    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'cookieAccept';
    accept.textContent = 'Allow analytics';
    accept.addEventListener('click', function () { choose('granted'); });
    actions.append(decline, accept);
    banner.append(text, actions);
    document.body.appendChild(banner);
  }

  if (!MEASUREMENT_ID) return;

  var choice = readChoice();
  if (choice === 'granted') loadAnalytics();
  else if (choice !== 'denied') showBanner();

  // "Cookie settings" links let visitors change their mind.
  document.addEventListener('click', function (event) {
    var settings = event.target.closest && event.target.closest('[data-cookie-settings]');
    if (settings) {
      event.preventDefault();
      showBanner();
      return;
    }
    if (event.target.closest && event.target.closest('[data-open-booking], a[href^="booking.html"]')) window.sjpTrack('begin_booking');
    var link = event.target.closest && event.target.closest('a[href^="tel:"]');
    if (link) window.sjpTrack('click_to_call');
  });
})();
