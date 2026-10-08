// Where the booking API lives.
// Local development: the API runs on port 8080 of the same machine.
// Live site: https://api.<your domain> (e.g. www.example.ie → api.example.ie). Override with window.SJP_API_BASE if needed.
const host = location.hostname;
const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';

export const API_BASE = (window.SJP_API_BASE || (isLocal ? `http://${host || 'localhost'}:8080` : `https://api.${host.replace(/^www\./, '')}`)).replace(/\/$/, '');

export const BUSINESS = {
  name: 'St Johns Park Car Valeting Service',
  phone: '089 470 9672',
  phoneHref: 'tel:+353894709672',
  address: '19 Saint Lawrence Terrace, Ballytruckle, St Johns Park, Waterford, X91 H79Y',
};
