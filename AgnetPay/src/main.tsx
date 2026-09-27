import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, ArrowRight, ArrowDown, ArrowUp, Check, Copy, RefreshCw, Wallet, Sparkles, ChevronRight, AlertCircle, Zap, Lock, ShieldAlert, CloudRain, Satellite, MapPin, LocateFixed, Hourglass, CloudLightning, CloudSun, Clock, TimerOff, Waves, Sun, Umbrella, Plane, SlidersHorizontal, Package, X as XIcon, type LucideIcon } from 'lucide-react';
import { request, explorer, cluster, apiUrl, createPolicy, evaluatePolicy, resolvePolicy, getProducts, searchVenues, isPending, type Pending, type Resolution, type Product, type Balance, type History, type Policy, type Venue, type Evaluation, type EvaluateOptions, type Cover, type ProductType } from './api';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { balanceOf, payPremium, phantom, PremiumError, type Signer } from './premium';
import { Brand } from './Brand';
import Landing from './Landing';
import './styles.css';
import './workspace.css';

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;
const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
const sol = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL`;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
const statusLabel = { none: 'None · sources agree', investigating: 'Investigating', escalated: 'Escalated to reviewer', resolved: 'Resolved' } as const;
// Plain-language versions for the Playground result.
const plainStatus = { none: 'Settled', investigating: 'Waiting for the next reading', escalated: 'Waiting for a reviewer', resolved: 'Settled' } as const;
const scenarioCopy: Record<string, { title: string; text: string }> = {
  'Live Open-Meteo readings': { title: 'Live weather', text: 'Two real forecast models for last week over the field.' },
  'Force agreement': { title: 'Sources agree', text: 'Both models report about the same rain. The formula amount is paid at once, no review.' },
  'Force disagreement': { title: 'Sources disagree', text: 'One model says wet, one says dry. The minimum is paid now, the rest waits.' },
  'On time': { title: 'On time', text: 'Both delay feeds report a few minutes. Nothing is owed.' },
  'Long delay': { title: 'Long delay', text: 'Both feeds agree the train was hours late. Big payout, no review.' },
  'Feeds disagree': { title: 'Feeds disagree', text: 'One feed says 20 minutes, the other 2.5 hours. The minimum is paid, the rest waits.' },
};
const sol4 = (n: number) => `${n.toFixed(4)} SOL`;
const MODELS: Record<string, { plain: string; tech: string }> = {
  best_match: { plain: 'Local forecast', tech: "Open-Meteo's best-match blend of your country's weather service models" },
  ecmwf_ifs025: { plain: 'European forecast', tech: 'ECMWF IFS, the European weather centre\'s global model' },
  ecmwf_ifs04: { plain: 'European forecast', tech: 'ECMWF IFS, the European weather centre\'s global model' },
  ecmwf_aifs025: { plain: 'European AI forecast', tech: 'ECMWF AIFS, the European weather centre\'s AI model' },
  gfs_seamless: { plain: 'US forecast', tech: 'NOAA GFS, the US national global model' },
  icon_seamless: { plain: 'German forecast', tech: 'DWD ICON, the German weather service model' },
  meteofrance_seamless: { plain: 'French forecast', tech: 'Météo-France ARPEGE/AROME' },
  ukmo_seamless: { plain: 'UK forecast', tech: 'UK Met Office model' },
};
const rainModels = { a: 'best_match', b: 'ecmwf_ifs025' };  // replaced by GET /products on load
const modelName = (id: string) => MODELS[id]?.plain ?? id;
const modelTech = (id: string) => MODELS[id]?.tech ?? id;
const SOURCES_NOTE = 'Both numbers come from the same free weather service, Open-Meteo, but from two different forecasts: a local one built from your country\'s weather services, and the European weather centre\'s global forecast. They can overlap a little, which is why the satellite can be added as a third, separate check.';
const sourceName = (s: string) => s.includes('delay-feed-A') ? 'Delay feed A' : s.includes('delay-feed-B') ? 'Delay feed B' : s.endsWith(':A') || s.includes(rainModels.a) ? modelName(rainModels.a) : s.endsWith(':B') || s.includes(rainModels.b) ? modelName(rainModels.b) : s.includes('ndvi') || s.includes('satellite') ? 'Satellite' : s;
const verdict = (ratio: number | null) => ratio == null ? '' : ratio <= 0.01 ? 'No loss' : ratio < 0.5 ? `Some loss · ${pct(ratio)}` : ratio < 0.99 ? `Heavy loss · ${pct(ratio)}` : 'Total loss';
const providerBadge = (d: { ai_used: boolean; model: string } | null | undefined) => !d ? '' : !d.ai_used ? 'Rule-based check' : d.model.toLowerCase().startsWith('groq') ? 'Explained by Groq AI' : d.model.toLowerCase().includes('claude') ? 'Explained by Claude AI' : `Explained by ${d.model}`;
function headline(r: Evaluation): { title: string; sub: string } {
  if (r.dispute_status === 'none') return { title: `${sol4(r.floor_amount_sol)} paid.`, sub: r.floor_amount_sol > 0 ? 'Every source agrees. The full amount went out on-chain. Nothing is waiting.' : 'Every source agrees: your rule was not hit. Nothing is owed.' };
  if (r.dispute_status === 'resolved') return { title: `${sol4(r.floor_amount_sol)} paid now.`, sub: r.escrow?.status === 'released' ? `The held ${sol4(r.escrow.released_amount_sol ?? r.escrow.amount_sol)} was released too. Done.` : 'The held amount was voided. Done.' };
  return { title: `${sol4(r.floor_amount_sol)} paid now.`, sub: `The sources don't agree, so ${sol4(r.escrow_amount_sol)} is held ${r.dispute_status === 'escalated' ? 'until a reviewer decides' : 'until the next reading'}.` };
}type Form = { region: string; lat: string; lon: string; trigger_mm: string; exit_mm: string; sum_insured_sol: string; payee_pubkey: string; venue_name: string; event_date: string; ndvi_trigger: string; ndvi_exit: string };
const defaultForm: Form = { region: 'Warsaw, PL', lat: '52.23', lon: '21.01', trigger_mm: '40', exit_mm: '10', sum_insured_sol: '0.01', payee_pubkey: '', venue_name: '', event_date: '', ndvi_trigger: '0.55', ndvi_exit: '0.25' };
// The product picker, metric labels, units and copy all read off the GET /products catalog: a new
// vertical is a new catalog entry, not new JSX. 'custom' is the only client-side option.
type Metric = { unit: string; label: string; noun: string; period: string; who: string; sources: string };
const CUSTOM = 'custom';
const iconFor: Record<string, LucideIcon> = { sun: Sun, 'cloud-rain': CloudRain, umbrella: Umbrella, plane: Plane, sliders: SlidersHorizontal };
const metricOf = (p?: Product): Metric => { const label = p?.metric_label ?? 'Rainfall', noun = label.toLowerCase(); return { unit: p?.metric_unit ?? 'mm', label, noun, period: p?.period ?? 'this week', who: `Who tells us the ${noun}?`, sources: `${noun} readings` }; };
const coverOf = (p: Product): Cover => p.direction === 'less' ? 'drought' : 'excess_rain';
type ReadingsMode = 'live' | 'simulate';
type Scenario = { label: string; mode: ReadingsMode; ra?: number; rb?: number };
// Demo readings sit at a payout ratio on the policy's own rule, so 'agree' / 'disagree' mean the same thing for every product.
const presets: Scenario[] = [{ label: 'Live Open-Meteo readings', mode: 'live' }, { label: 'Force agreement', mode: 'simulate', ra: 0.48, rb: 0.52 }, { label: 'Force disagreement', mode: 'simulate', ra: 0.25, rb: 0.85 }];
const travelPresets: Scenario[] = [{ label: 'On time', mode: 'simulate', ra: -0.15, rb: -0.1 }, { label: 'Long delay', mode: 'simulate', ra: 0.73, rb: 0.8 }, { label: 'Feeds disagree', mode: 'simulate', ra: -0.07, rb: 0.8 }];
const readingAt = (r: number, t: number, x: number) => String(Math.max(0, +(t + r * (x - t)).toFixed(1)));
type RuleOption = { title: string; text: string; trigger: number; exit: number; recommended?: boolean };
type RuleSet = { question: string; hint: string; scope?: string; note?: string; options: RuleOption[] };
const cropNote = (crop: string) => `These are typical starting points for ${crop}. What counts as a normal week depends on your region, crop and season, so check them against your area or change them under "Set my own numbers".`;
// Plain-language choices over the same trigger/exit numbers; the middle option is each product's catalog default.
const rulePresets: Record<string, RuleSet> = {
  crop_drought: { question: 'How dry does the week have to be?', scope: "This policy only protects against drought (too little rain). For flood or excess-rain risk, choose 'Crop excess-rain cover' in Step 1 instead.", hint: 'The real rainfall over your field is measured automatically by two weather models. Here you only choose how little rain counts as a loss.', note: cropNote('wheat'), options: [
    { title: 'A bit drier than normal', text: 'Starts paying at the first dry spell.', trigger: 50, exit: 20 },
    { title: 'Clearly too dry', text: 'A properly dry week. The usual choice.', trigger: 40, exit: 10, recommended: true },
    { title: 'Only a severe drought', text: 'Pays only when almost no rain falls.', trigger: 25, exit: 5 }] },
  crop_excess_rain: { question: 'How wet does the week have to be?', scope: "This policy only protects against excess rain and flooding. For drought risk, choose 'Crop drought cover' in Step 1 instead.", hint: 'The real rainfall over your field is measured automatically by two weather models. Here you only choose how much rain counts as a loss.', note: cropNote('corn'), options: [
    { title: 'Wetter than normal', text: 'Starts paying when the soil gets soaked.', trigger: 60, exit: 110 },
    { title: 'Waterlogged field', text: 'Standing water that hurts the crop. The usual choice.', trigger: 80, exit: 140, recommended: true },
    { title: 'Only a flood', text: 'Pays only for a real flood.', trigger: 110, exit: 180 }] },
  event_weather_cancel: { question: 'How much rain ruins your event?', hint: 'The real rain over the venue during the event is measured automatically by two weather models. Here you only choose how much rain counts as a rain-out.', options: [
    { title: 'Even light rain', text: 'A few hours of drizzle already spoils it.', trigger: 2, exit: 10 },
    { title: 'A proper downpour', text: 'Heavy rain that sends people home. The usual choice.', trigger: 5, exit: 25, recommended: true },
    { title: 'Only a storm', text: 'Pays only for a real washout.', trigger: 15, exit: 40 }] },
  travel_delay: { question: 'How late counts as a problem?', hint: 'The real delay is read automatically from two delay feeds. Here you only choose how late counts as a loss.', options: [
    { title: 'Even short delays', text: 'Missed connections and long waits.', trigger: 15, exit: 90 },
    { title: 'Over half an hour', text: 'A delay that ruins plans. The usual choice.', trigger: 30, exit: 180, recommended: true },
    { title: 'Only long delays', text: 'Pays only when the day is lost.', trigger: 60, exit: 240 }] },
};
const unitValue = (r: { observed_mm: number; unit: string }) => r.unit === 'ndvi' ? `NDVI ${r.observed_mm.toFixed(2)}` : `${r.observed_mm.toFixed(1)} ${r.unit}`;
const tilt = (e: React.MouseEvent<HTMLElement>) => { const el = e.currentTarget, r = el.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5; el.style.setProperty('--ry', `${(x * 6).toFixed(2)}deg`); el.style.setProperty('--rx', `${(-y * 6).toFixed(2)}deg`); };
const untilt = (e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.setProperty('--rx', '0deg'); e.currentTarget.style.setProperty('--ry', '0deg'); };
// Client-side preview of the same formula the backend runs, so each step can say what you'd earn.
// Hover/focus explanation next to a field label, for people who have never seen a parametric policy.
type ScaleRow = { icon: LucideIcon; what: string; pays: 'none' | 'part' | 'full' };
const amountText = (v: number, unit: string) => unit === 'min' && v >= 60 ? `${+(v / 60).toFixed(1)} ${v === 60 ? 'hour' : 'hours'}` : `${+v.toFixed(1)} ${unit}`;
// The rule as a three-line picture: what happens, and what you get. Numbers stay, but the words carry the meaning.
function ruleScale(productType: string, dry: boolean, t: number, x: number, unit: string): { intro: string; rows: ScaleRow[] } {
  const T = amountText(t, unit), X = amountText(x, unit);
  switch (productType) {
    case 'event_weather_cancel': return { intro: 'You get money if it rains on your event.', rows: [
      { icon: Sun, what: `Dry, or only a little rain (less than ${T})`, pays: 'none' },
      { icon: CloudRain, what: `Real rain (${T} to ${X})`, pays: 'part' },
      { icon: CloudLightning, what: `A downpour (${X} or more)`, pays: 'full' }] };
    case 'travel_delay': return { intro: 'You get money if your journey is late.', rows: [
      { icon: Clock, what: `On time, or less than ${T} late`, pays: 'none' },
      { icon: Hourglass, what: `${T} to ${X} late`, pays: 'part' },
      { icon: TimerOff, what: `${X} late or more`, pays: 'full' }] };
    default: return dry
      ? { intro: 'You get money if your field gets too little rain this week.', rows: [
        { icon: CloudRain, what: `Enough rain (${T} or more)`, pays: 'none' },
        { icon: CloudSun, what: `Too little rain (${X} to ${T})`, pays: 'part' },
        { icon: Sun, what: `Almost no rain (${X} or less)`, pays: 'full' }] }
      : { intro: 'You get money if your field gets too much rain this week.', rows: [
        { icon: CloudSun, what: `Normal rain (up to ${T})`, pays: 'none' },
        { icon: CloudRain, what: `Too much rain (${T} to ${X})`, pays: 'part' },
        { icon: Waves, what: `Flooded (${X} or more)`, pays: 'full' }] };
  }
}
function RuleScale({ productType, dry, t, x, unit, cover, usd }: { productType: string; dry: boolean; t: number; x: number; unit: string; cover: number; usd: string }) {
  const { intro, rows } = ruleScale(productType, dry, t, x, unit);
  const pay = { none: 'You get nothing', part: 'You get part of it. The worse it gets, the more you get', full: `You get all of it: ${sol4(cover)}${usd ? ` (${usd})` : ''}` };
  return <div className="rule-scale"><b>{intro}</b>
    <ol>{rows.map(r => <li key={r.pays} className={`pays-${r.pays}`}><r.icon size={22} aria-hidden="true"/><span>{r.what}</span><ArrowRight size={15} aria-hidden="true"/><strong>{pay[r.pays]}</strong></li>)}</ol>
    {unit === 'mm' && <small>What is 1 mm of rain? Leave a glass outside: 1 mm is how high the water would stand in it. A shower is about 5 mm; a heavy downpour is 25 mm or more.</small>}
  </div>;
}
const ruleName = (pt: string | undefined, dry: boolean) => pt === 'event_weather_cancel' ? 'the rain-out rule' : pt === 'travel_delay' ? 'the delay rule' : pt === 'crop_excess_rain' ? 'the excess-rain rule' : pt === 'crop_drought' ? 'the drought rule' : dry ? 'your drought rule' : 'your excess-rain rule';
const Hint = ({ text }: { text: string }) => <span className="hint" tabIndex={0} role="note" aria-label={text}><i>?</i><span className="hint-pop">{text}</span></span>;
type Place = { id: string; name: string; detail: string; lat: number; lon: number };
type PhotonFeature = { geometry: { coordinates: [number, number] }; properties: { osm_id?: number; osm_type?: string; name?: string; street?: string; housenumber?: string; city?: string; district?: string; county?: string; state?: string; countrycode?: string } };
// Photon (OpenStreetMap) allows search-as-you-type and resolves villages, streets and landmarks, not just towns.
const searchPlaces = async (q: string): Promise<Place[]> => {
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`);
  const d = (await r.json()) as { features?: PhotonFeature[] };
  const seen = new Set<string>();
  return (d.features ?? []).map((f, i) => {
    const p = f.properties;
    const street = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : '';
    const name = p.name || street || p.city || 'Unnamed place';
    const detail = [name !== street ? street : '', p.district, p.city !== name ? p.city : '', p.county, p.state, p.countrycode].filter(Boolean).filter((v, j, a) => a.indexOf(v) === j).join(', ');
    return { id: `${p.osm_type ?? ''}${p.osm_id ?? i}`, name, detail, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
  }).filter(pl => { const k = `${pl.name}|${pl.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });  // one street is often several OSM ways
};
const placeLabel = (p: Place) => [p.name, p.detail.split(', ').slice(0, 2).join(', ')].filter(Boolean).join(', ');
function useSuggest<T>(query: string, open: boolean, fetcher: (q: string) => Promise<T[]>, emptyNote: string) {
  const [results, setResults] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState('');
  const fetchRef = useRef(fetcher); fetchRef.current = fetcher;
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) { setResults([]); setSearching(false); return; }
    let live = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try { const found = await fetchRef.current(q); if (live) { setResults(found); setNote(found.length ? '' : emptyNote); } }
      catch { if (live) { setResults([]); setNote('Suggestions are unavailable right now. You can still type it in.'); } }
      finally { if (live) setSearching(false); }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [query, open, emptyNote]);
  return { results, searching, note, setNote, clear: () => setResults([]) };
}
function SuggestList<T>({ items, keyOf, render, onPick }: { items: T[]; keyOf: (t: T) => string | number; render: (t: T) => React.ReactNode; onPick: (t: T) => void }) {
  return <ul className="place-list" role="listbox">{items.map(t => <li key={keyOf(t)} role="option" aria-selected={false}><button type="button" onMouseDown={e => e.preventDefault()} onClick={() => onPick(t)}><MapPin size={14} aria-hidden="true"/>{render(t)}</button></li>)}</ul>;
}
function PlaceField({ label, hint, noun, value, lat, lon, disabled, onType, onPick, onMove }: { label: string; hint: string; noun: string; value: string; lat: number; lon: number; disabled: boolean; onType: (v: string) => void; onPick: (region: string, lat: number, lon: number) => void; onMove: (lat: number, lon: number) => void }) {
  const [open, setOpen] = useState(false);
  const [gps, setGps] = useState(false);
  const s = useSuggest(value, open, searchPlaces, 'Nothing found. Try the nearest village, street or landmark.');
  const pick = (p: Place) => { onPick(placeLabel(p), +p.lat.toFixed(5), +p.lon.toFixed(5)); setOpen(false); s.clear(); s.setNote(''); };
  const locate = () => {
    if (!navigator.geolocation) { s.setNote('This device cannot share its location. Type a place name instead.'); return; }
    setGps(true); s.setNote(''); setOpen(false);
    navigator.geolocation.getCurrentPosition(
      pos => { setGps(false); onPick('My location', +pos.coords.latitude.toFixed(5), +pos.coords.longitude.toFixed(5)); },
      () => { setGps(false); s.setNote('Could not get your location. Type a place name instead.'); },
      { timeout: 10000, enableHighAccuracy: true });
  };
  const located = Number.isFinite(lat) && Number.isFinite(lon);
  return <div className="field place-field"><span>{label} <Hint text={hint}/></span>
    <div className="place-row">
      <input value={value} disabled={disabled} placeholder="Village, street or landmark" autoComplete="off" role="combobox" aria-expanded={open && s.results.length > 0} aria-autocomplete="list"
        onChange={e => { onType(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => { if (e.key === 'Enter' && s.results[0]) { e.preventDefault(); pick(s.results[0]); } else if (e.key === 'Escape') setOpen(false); }}/>
      <button type="button" className="place-gps" disabled={disabled || gps} onClick={locate}><LocateFixed size={15} aria-hidden="true"/>{gps ? 'Finding you…' : 'Use my location'}</button>
      {open && s.results.length > 0 && <SuggestList items={s.results} keyOf={p => p.id} onPick={pick} render={p => <><b>{p.name}</b><small>{p.detail}</small></>}/>}
    </div>
    <small className={`field-help${located ? ' ok' : ''}`}>{s.searching ? 'Searching…' : s.note || (located ? `Drag the pin onto the exact spot of your ${noun}, or tap the map. Weather is read at ${lat.toFixed(4)}, ${lon.toFixed(4)}.` : 'Search, or use your location. Then fine-tune the pin on the map.')}</small>
    {located && <PinMap lat={lat} lon={lon} disabled={disabled} onMove={onMove}/>}
  </div>;
}
function VenueField({ value, disabled, onType, onPick }: { value: string; disabled: boolean; onType: (v: string) => void; onPick: (v: Venue) => void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Venue | null>(null);
  const s = useSuggest(value, open, searchVenues, 'Not on Ticketmaster. That is fine: we will use the weather only.');
  const pick = (v: Venue) => { setPicked(v); onPick(v); setOpen(false); s.clear(); s.setNote(''); };
  return <div className="field place-field"><span>Which venue? (optional) <Hint text="If the venue sells tickets on Ticketmaster, we also check whether the event was cancelled or postponed: a second, non-weather source."/></span>
    <div className="place-row">
      <input value={value} disabled={disabled} placeholder="Start typing, e.g. Tauron Arena" autoComplete="off" role="combobox" aria-expanded={open && s.results.length > 0} aria-autocomplete="list"
        onChange={e => { onType(e.target.value); setPicked(null); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => { if (e.key === 'Enter' && s.results[0]) { e.preventDefault(); pick(s.results[0]); } else if (e.key === 'Escape') setOpen(false); }}/>
      {open && s.results.length > 0 && <SuggestList items={s.results} keyOf={v => v.id} onPick={pick} render={v => <><b>{v.name}</b><small>{[v.city, v.country].filter(Boolean).join(', ')}</small></>}/>}
    </div>
    <small className={`field-help${picked ? ' ok' : ''}`}>{s.searching ? 'Searching Ticketmaster…' : s.note || (picked ? `Got it. We put the pin on ${picked.name} for you.` : 'Pick your venue and we place the pin for you. Skip it if the event is not ticketed.')}</small>
  </div>;
}
let solUsdCache: Promise<number | null> | null = null;
function useSolUsd() {
  const [usd, setUsd] = useState<number | null>(null);
  useEffect(() => {
    solUsdCache ??= fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd').then(r => r.json()).then(d => typeof d?.solana?.usd === 'number' ? d.solana.usd : null).catch(() => null);
    let live = true; void solUsdCache.then(v => { if (live) setUsd(v); }); return () => { live = false; };
  }, []);
  return usd;
}
const usdOf = (solAmount: number, usd: number | null) => usd == null || !Number.isFinite(solAmount) ? '' : `≈ $${(solAmount * usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isSolAddress = (s: string) => { try { return bs58.decode(s.trim()).length === 32; } catch { return false; } };
const FALLBACK_COVER_USD = [50, 150, 400];
const solFor = (usdAmount: number, usd: number) => +(usdAmount / usd).toFixed(4);
type WalletMode = 'demo' | 'phantom' | 'new';
const PREMIUM_HINT = 'This is a fixed demo rate, not real actuarial pricing. In a real product the premium would be set by region, season, past data and risk level. That is out of scope for this project and a separate problem (see Known limitations in the README).';
function WalletBalance({ address, need }: { address: string; need: number }) {
  const [bal, setBal] = useState<number | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(() => { setErr(false); balanceOf(address).then(setBal).catch(() => setErr(true)); }, [address]);
  useEffect(() => { load(); }, [load]);
  const short = bal != null && bal * 1e9 < Math.round(need * 1e9) + 5000;
  return <small className={`field-help${bal == null ? '' : short ? ' warn' : ' ok'}`}>
    {err ? 'Could not read the balance.' : bal == null ? 'Reading the balance…' : short ? `Balance ${bal.toFixed(4)} SOL: not enough for the ${need.toFixed(4)} SOL premium. Get devnet SOL at faucet.solana.com, then refresh.` : `Balance ${bal.toFixed(4)} SOL: enough for the ${need.toFixed(4)} SOL premium.`}
    {' '}<button type="button" className="link-btn" onClick={load}>Refresh</button>
  </small>;
}
function PayoutWallet({ label, signer, premium, disabled, onChange }: { label: string; signer: Signer | null; premium: number; disabled: boolean; onChange: (s: Signer | null) => void }) {
  const [mode, setMode] = useState<WalletMode>(signer?.kind === 'phantom' ? 'phantom' : signer?.kind === 'local' ? 'new' : 'demo');
  const [created, setCreated] = useState<Extract<Signer, { kind: 'local' }> | null>(signer?.kind === 'local' ? signer : null);
  const [connected, setConnected] = useState<Extract<Signer, { kind: 'phantom' }> | null>(signer?.kind === 'phantom' ? signer : null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState('');
  const [note, setNote] = useState('');
  const choose = (m: WalletMode) => { setMode(m); setNote(''); onChange(m === 'new' ? created : m === 'phantom' ? connected : null); };
  const connect = async () => {
    const p = phantom();
    if (!p) return;
    try { const r = await p.connect(); const s = { kind: 'phantom' as const, address: r.publicKey.toString() }; setConnected(s); onChange(s); setNote(''); }
    catch { setNote('The connection was not approved in Phantom.'); }
  };
  const create = () => {
    // Generated in the browser: the secret key never leaves this page, so only the user can spend what is paid here.
    const kp = nacl.sign.keyPair();
    const s = { kind: 'local' as const, address: bs58.encode(kp.publicKey), secret: kp.secretKey };
    setCreated(s); setSaved(false); onChange(s);
  };
  const download = () => {
    if (!created) return;
    const blob = new Blob([JSON.stringify(Array.from(created.secret))], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `crossroad-wallet-${created.address.slice(0, 6)}.json`; a.click(); URL.revokeObjectURL(a.href);
    setSaved(true);
  };
  const copy = (what: string, text: string) => { void navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 2000); }); };
  const addressRow = (s: Signer, title: string) => <div className="wallet-addr"><small>{title}</small><code>{s.address}</code><button type="button" onClick={() => copy('addr', s.address)}>{copied === 'addr' ? <Check size={14}/> : <Copy size={14}/>}{copied === 'addr' ? 'Copied' : 'Copy'}</button></div>;
  return <div className="field wallet-field"><span>{label} <Hint text="This wallet pays the premium now and receives the payout later."/></span>
    <div className="wallet-pick" role="radiogroup" aria-label="Which wallet pays the premium and gets the payout?">
      {([['demo', 'Use the demo wallet'], ['phantom', 'Connect Phantom'], ['new', 'Create one for me']] as const).map(([m, t]) => <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={disabled} onClick={() => choose(m)}>{t}</button>)}
    </div>
    {mode === 'demo' && <small className="field-help">A shared demo wallet pays the premium and receives the payout. Fine for trying it out; you cannot spend it yourself.</small>}
    {mode === 'phantom' && (!phantom() ? <small className="field-help warn">Phantom is not installed in this browser. Install it from phantom.com, turn on Testnet Mode and choose Solana Devnet, then reload this page.</small>
      : !connected ? <><button type="button" className="wallet-create" disabled={disabled} onClick={() => void connect()}><Wallet size={15} aria-hidden="true"/>Connect Phantom</button>
        <small className={`field-help${note ? ' warn' : ''}`}>{note || 'Phantom must be on Solana Devnet (Settings → Developer settings → Testnet Mode). You approve the premium in Phantom when you buy.'}</small></>
      : <div className="wallet-new">{addressRow(connected, 'Connected Phantom wallet')}<WalletBalance address={connected.address} need={premium}/></div>)}
    {mode === 'new' && (!created ? <><button type="button" className="wallet-create" disabled={disabled} onClick={create}><Wallet size={15} aria-hidden="true"/>Create a new wallet</button>
      <small className="field-help">We make it here in your browser. Nobody else, including us, ever sees its key. A new wallet starts empty: it needs a little devnet SOL for the premium.</small></>
      : <div className="wallet-new">
        {addressRow(created, 'Your new wallet address')}
        <div className="wallet-actions">
          <button type="button" className="wallet-save" onClick={download}>{saved ? <Check size={15}/> : <ArrowDown size={15}/>}{saved ? 'Key file saved' : 'Save my key file'}</button>
          <button type="button" onClick={() => copy('key', bs58.encode(created.secret))}>{copied === 'key' ? <Check size={14}/> : <Copy size={14}/>}{copied === 'key' ? 'Copied' : 'Copy private key (for Phantom)'}</button>
        </div>
        <small className={`field-help${saved ? ' ok' : ' warn'}`}>{saved ? 'Keep that file somewhere safe. It is the only way to open this wallet.' : 'Save the key file now. It is the only way to spend this money, and we cannot recover it if you lose it.'}</small>
        <WalletBalance address={created.address} need={premium}/>
      </div>)}
  </div>;
}
function PinMap({ lat, lon, disabled, onMove }: { lat: number; lon: number; disabled: boolean; onMove: (lat: number, lon: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null), pin = useRef<L.Marker | null>(null), layers = useRef<{ street: L.TileLayer; sat: L.TileLayer } | null>(null);
  const [sat, setSat] = useState(true);  // people recognise their own field or venue from above
  const moveRef = useRef(onMove); moveRef.current = onMove;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  useEffect(() => {
    const m = L.map(el.current!, { scrollWheelZoom: false }).setView([lat, lon], 15);
    const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
    const satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri' });
    const icon = L.divIcon({ className: 'pin-icon', html: '<span></span>', iconSize: [30, 30], iconAnchor: [15, 30] });
    const mk = L.marker([lat, lon], { draggable: true, icon, title: 'Drag me onto the exact spot' }).addTo(m);
    const put = (p: L.LatLng) => moveRef.current(+p.lat.toFixed(5), +p.lng.toFixed(5));
    mk.on('dragend', () => put(mk.getLatLng()));
    m.on('click', (e: L.LeafletMouseEvent) => { if (disabledRef.current) return; mk.setLatLng(e.latlng); put(e.latlng); });
    map.current = m; pin.current = mk; layers.current = { street, sat: satLayer };
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); m.remove(); map.current = null; pin.current = null; };
  }, []);
  useEffect(() => {  // a new search result or GPS fix moves the pin and recentres the map
    const m = map.current, mk = pin.current; if (!m || !mk) return;
    const cur = mk.getLatLng();
    if (Math.abs(cur.lat - lat) > 1e-6 || Math.abs(cur.lng - lon) > 1e-6) { mk.setLatLng([lat, lon]); m.setView([lat, lon], Math.max(m.getZoom(), 15)); }
  }, [lat, lon]);
  useEffect(() => { const m = map.current, l = layers.current; if (!m || !l) return; m.removeLayer(sat ? l.street : l.sat); (sat ? l.sat : l.street).addTo(m); }, [sat]);
  useEffect(() => { if (disabled) pin.current?.dragging?.disable(); else pin.current?.dragging?.enable(); }, [disabled]);
  return <div className="pin-map">
    <div ref={el} className="pin-map-canvas" aria-label="Map: drag the pin or tap the exact spot"/>
    <div className="pin-map-tabs" role="group" aria-label="Map style"><button type="button" aria-pressed={!sat} onClick={() => setSat(false)}>Map</button><button type="button" aria-pressed={sat} onClick={() => setSat(true)}>Satellite</button></div>
  </div>;
}
const ratioOf = (obs: number, trig: number, ex: number) => trig === ex ? 0 : Math.max(0, Math.min(1, (trig - obs) / (trig - ex)));
// '#playground?product=event_weather_cancel' -> { route: 'playground', product: 'event_weather_cancel' }
const parseHash = () => { const [route, query = ''] = location.hash.slice(1).split('?'); return { route: route || 'overview', product: new URLSearchParams(query).get('product') }; };
function App() {
  const [page, setPage] = useState(parseHash().route); const [hashProduct, setHashProduct] = useState<string | null>(parseHash().product); useEffect(() => { const change = () => { const h = parseHash(); setPage(h.route); setHashProduct(h.product); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []); const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [balanceError, setBalanceError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<Form>(defaultForm);
  const [preset, setPreset] = useState<string>('crop_drought');
  const solUsd = useSolUsd();
  const solD = (n: number) => `${sol4(n)}${solUsd != null ? ` (${usdOf(n, solUsd)})` : ''}`;
  const [catalog, setCatalog] = useState<Product[]>([]); const [catalogError, setCatalogError] = useState('');
  const [maxCover, setMaxCover] = useState(5);
  const [premiumRate, setPremiumRate] = useState(0.03);
  const [insurerWallet, setInsurerWallet] = useState('');
  const [signer, setSigner] = useState<Signer | null>(null);
  useEffect(() => { getProducts().then(r => { if (r.rain_models) Object.assign(rainModels, r.rain_models); setCatalog(r.products); if (r.max_sum_insured_sol) setMaxCover(r.max_sum_insured_sol); if (r.premium_rate != null) setPremiumRate(r.premium_rate); if (r.insurer_wallet) setInsurerWallet(r.insurer_wallet); setSatelliteLive(!!r.satellite_live); }).catch(e => setCatalogError(message(e))); }, []);
  const [cover, setCover] = useState<Cover>('drought');
  const [mode, setMode] = useState<ReadingsMode>('live');
  const [scenario, setScenario] = useState('Live Open-Meteo readings');
  const [simA, setSimA] = useState('30');
  const [simB, setSimB] = useState('12');
  const [satellite, setSatellite] = useState(false);
  const [satLook, setSatLook] = useState<'healthy' | 'stressed'>('healthy');
  const [satelliteLive, setSatelliteLive] = useState(false);
  const [step, setStep] = useState(1);
  const [simNdvi, setSimNdvi] = useState('');
  const [simEventStatus, setSimEventStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('');
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [result, setResult] = useState<Evaluation | null>(null);
  // A 202 pending_confirmation: the payment may already have landed. Only ever re-check it, never resend.
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingAction, setPendingAction] = useState<{ kind: 'evaluate' } | { kind: 'resolve'; release: boolean }>({ kind: 'evaluate' });
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const busy = useRef(false);
  const refreshingRef = useRef(false);
  // The pill nav compacts once the page is scrolled.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 48);
    onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [page]);
  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true; setRefreshing(true);
    await Promise.allSettled([
      request<Balance>('/wallet/balance').then(data => { setBalance(data); setBalanceError(''); }).catch(e => setBalanceError(message(e))),
      request<History>('/wallet/history').then(data => { setHistory(data); setHistoryError(''); }).catch(e => setHistoryError(message(e))),
    ]);
    refreshingRef.current = false; setRefreshing(false);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!running) return;
    const start = Date.now(); const interval = setInterval(() => setElapsed((Date.now() - start) / 1000), 100);
    return () => clearInterval(interval);
  }, [running]);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); } }, [copied]);
  const num = (v: string) => { const n = Number(v); return v.trim() !== '' && Number.isFinite(n) ? n : NaN; };
  const trigger = num(form.trigger_mm), exit = num(form.exit_mm), sum = num(form.sum_insured_sol), ndviT = num(form.ndvi_trigger), ndviE = num(form.ndvi_exit);
  const directionOk = cover === 'drought' ? exit >= 0 && exit < trigger : trigger >= 0 && exit > trigger;
  const ndviOk = simNdvi.trim() === '' || (num(simNdvi) >= -1 && num(simNdvi) <= 1);
  const formValid = form.region.trim() !== '' && Number.isFinite(num(form.lat)) && Number.isFinite(num(form.lon)) && trigger > 0 && directionOk && sum > 0 && ndviE < ndviT && ndviE > -1 && ndviT < 1 && (mode === 'live' || (num(simA) >= 0 && num(simB) >= 0 && ndviOk));
  type Fixed = { a: number; b: number };  // the quick demo's own readings (state set in the same tick would still be stale)
  const evalOptions = (fx?: Fixed): EvaluateOptions => ({ simulate: fx || mode === 'simulate' ? [{ mm: fx ? fx.a : num(simA), label: isDemo ? 'delay-feed-A' : 'A' }, { mm: fx ? fx.b : num(simB), label: isDemo ? 'delay-feed-B' : 'B' }] : undefined, include_satellite: fx || !(preset === CUSTOM || !!currentProduct?.product_type.startsWith('crop_')) || (mode === 'live' && !satelliteLive) ? false : satellite, simulate_satellite_ndvi: !fx && mode === 'simulate' && simNdvi.trim() !== '' ? num(simNdvi) : undefined, simulate_event_status: !fx && mode === 'simulate' && currentProduct?.venue_lookup && simEventStatus ? simEventStatus : undefined });
  const currentProduct = preset === CUSTOM ? undefined : catalog.find(p => p.product_type === preset);
  const M = metricOf(currentProduct);
  const rules = preset === CUSTOM ? undefined : rulePresets[preset];
  const coverUsd = currentProduct?.cover_usd ?? FALLBACK_COVER_USD;
  const premium = Number.isFinite(sum) && sum > 0 ? +(sum * premiumRate).toFixed(9) : 0;
  const coverTouched = useRef(false);
  useEffect(() => {  // until the user picks an amount, start each product on its smallest real-world cover
    if (coverTouched.current || solUsd == null) return;
    setForm(f => ({ ...f, sum_insured_sol: String(Math.min(solFor(coverUsd[0], solUsd), maxCover)) }));
  }, [solUsd, currentProduct, maxCover]);
  const isDemo = preset !== CUSTOM && currentProduct?.sources === 'demo';
  const place = currentProduct?.location_noun ?? 'location';
  const payeeLabel = currentProduct?.payee_label ?? 'Your wallet';
  const theme = currentProduct?.theme ?? (preset === CUSTOM ? 'custom' : 'farm');   // same themes as the Landing page, read off the catalog
  const activePresets = isDemo ? travelPresets : presets;
  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [key]: e.target.value }));
  useEffect(() => { setSimNdvi(mode === 'simulate' && satellite ? (satLook === 'stressed' ? '0.20' : '0.65') : ''); }, [mode, satellite, satLook]);
  const applyScenario = (sc: Scenario, t = num(form.trigger_mm), x = num(form.exit_mm)) => {
    setScenario(sc.label); setMode(sc.mode);
    if (sc.ra != null && sc.rb != null && Number.isFinite(t) && Number.isFinite(x)) { setSimA(readingAt(sc.ra, t, x)); setSimB(readingAt(sc.rb, t, x)); }
  };
  useEffect(() => {  // a new rule re-places the chosen demo scenario on it
    const sc = [...presets, ...travelPresets].find(x => x.label === scenario);
    if (sc?.mode === 'simulate') applyScenario(sc);
  }, [form.trigger_mm, form.exit_mm]);
  const choosePreset = (key: string) => { const p = catalog.find(c => c.product_type === key); setPreset(key); setSimEventStatus(''); if (p) { setCover(coverOf(p)); setForm(f => ({ ...f, trigger_mm: String(p.trigger), exit_mm: String(p.exit) })); } else { setCover('drought'); setForm(f => ({ ...f, trigger_mm: defaultForm.trigger_mm, exit_mm: defaultForm.exit_mm, ndvi_trigger: defaultForm.ndvi_trigger, ndvi_exit: defaultForm.ndvi_exit })); } const list = p?.sources === 'demo' ? travelPresets : presets; const crop = !p || p.product_type.startsWith('crop_'); const t = p ? p.trigger : num(defaultForm.trigger_mm), x = p ? p.exit : num(defaultForm.exit_mm); if (!crop) setSatellite(false); applyScenario(list.find(sc => sc.label === scenario) ?? (p?.sources === 'demo' ? travelPresets[2] : presets[0]), t, x); if (p?.sources === 'demo') setSatellite(false); };
  const chooseCover = (c: Cover) => { setCover(c); setForm(f => { const t = num(f.trigger_mm), x = num(f.exit_mm); const ok = c === 'drought' ? x < t : x > t; return ok ? f : { ...f, trigger_mm: c === 'drought' ? '40' : '80', exit_mm: c === 'drought' ? '10' : '140' }; }); };
  // Deep link from the Landing page: #playground?product=<product_type> lands on Step 1 with that product selected.
  const appliedProduct = useRef<string | null>(null);
  useEffect(() => {
    if (page !== 'playground' || !hashProduct) { appliedProduct.current = null; return; }
    if (!catalog.length || appliedProduct.current === hashProduct) return;
    appliedProduct.current = hashProduct;
    if (catalog.some(c => c.product_type === hashProduct)) { setResult(null); setPending(null); setPolicy(null); setError(''); choosePreset(hashProduct); setStep(1); }
  }, [page, hashProduct, catalog]);
  async function run(fx?: Fixed) {
    if ((!fx && !formValid) || busy.current) return;
    busy.current = true; setRunning(true); setError(''); setResult(null); setPending(null); setPolicy(null); setElapsed(0);
    let paying = false;
    try {
      let premiumSig: string | undefined;
      if (signer) {
        setPhase('Checking your balance');
        try { premiumSig = await payPremium(signer, insurerWallet, premium, setPhase); }
        catch (e) { setError(e instanceof PremiumError ? e.message : `The premium could not be paid, so no policy was created. ${message(e)}`); return; }
      }
      setPhase(signer ? 'Creating policy' : 'Charging the premium and creating the policy');
      const eventWindow = currentProduct?.venue_lookup && form.event_date ? form.event_date : undefined;
      const created = await createPolicy({ region: form.region.trim(), lat: num(form.lat), lon: num(form.lon), trigger_mm: trigger, exit_mm: exit, sum_insured_sol: sum, payee_pubkey: form.payee_pubkey.trim() || undefined, premium_tx_signature: premiumSig, premium_payer: premiumSig ? signer?.address : undefined, cover, ndvi_trigger: ndviT, ndvi_exit: ndviE, product_type: currentProduct?.product_type ?? 'crop_drought', metric_unit: M.unit, metric_label: M.label, venue_name: currentProduct?.venue_lookup && form.venue_name.trim() ? form.venue_name.trim() : undefined, window_start: eventWindow, window_end: eventWindow });
      setPolicy(created); paying = true;
      setPhase(!fx && mode === 'live' ? `Pulling two rainfall sources${satellite ? ' and satellite NDVI' : ''}, then paying the floor` : 'Applying simulated readings and paying the floor');
      const out = await evaluatePolicy(created.id, evalOptions(fx));
      if (isPending(out)) { setPendingAction({ kind: 'evaluate' }); setPending(out); } else setResult(out);
    }
    catch (e) { setError(paying ? `${message(e)} The outcome may be unknown. Check recent transactions before submitting again.` : `${message(e)} No policy was created.`); }
    finally { busy.current = false; setRunning(false); setPhase(''); void refresh(); }
  }
  async function nextCycle() {
    if (!policy || busy.current) return;
    busy.current = true; setRunning(true); setError(''); setElapsed(0); setPhase('Re-pulling readings for the next cycle');
    try { const out = await evaluatePolicy(policy.id, evalOptions()); if (isPending(out)) { setPendingAction({ kind: 'evaluate' }); setPending(out); } else setResult(out); }
    catch (e) { setError(message(e)); }
    finally { busy.current = false; setRunning(false); setPhase(''); void refresh(); }
  }
  async function resolve(release: boolean) {
    if (!policy || busy.current) return;
    busy.current = true; setRunning(true); setError(''); setElapsed(0); setPhase(release ? 'Releasing the escrowed delta on-chain' : 'Voiding the escrowed delta');
    try { const res = await resolvePolicy(policy.id, release); if (isPending(res)) { setPendingAction({ kind: 'resolve', release }); setPending(res); } else applyResolution(res); }
    catch (e) { setError(message(e)); }
    finally { busy.current = false; setRunning(false); setPhase(''); void refresh(); }
  }
  const applyResolution = (res: Resolution) => setResult(prev => prev ? { ...prev, dispute_status: res.dispute_status, escrow: res.escrow, note: `Escrow ${res.escrow.status} by a human reviewer.` } : prev);
  // "Check again" for a pending payment: re-calls the SAME endpoint for the SAME policy. The backend re-checks the stored
  // transaction and never sends a second payment; this never re-runs the create-policy / pay flow from scratch.
  async function checkAgain() {
    if (!policy || !pending || busy.current) return;
    busy.current = true; setRunning(true); setError(''); setElapsed(0); setPhase('Checking whether the payment landed - nothing is sent again');
    try {
      if (pendingAction.kind === 'resolve') { const res = await resolvePolicy(policy.id, pendingAction.release); if (isPending(res)) setPending(res); else { setPending(null); applyResolution(res); } }
      else { const out = await evaluatePolicy(policy.id, evalOptions()); if (isPending(out)) setPending(out); else { setPending(null); setResult(out); } }
    }
    catch (e) { setError(message(e)); }
    finally { busy.current = false; setRunning(false); setPhase(''); void refresh(); }
  }
  const escrow = result?.escrow ?? null;
  const escrowState: 'none' | 'pending' | 'released' | 'voided' = escrow ? escrow.status : 'none';
  const releasedAmount = escrow?.released_amount_sol ?? escrow?.amount_sol ?? 0;
  const satReading = result?.readings.find(r => r.unit === 'ndvi') ?? null;
  const satImage = satReading?.image_url ? `${apiUrl(satReading.image_url)}&v=${encodeURIComponent(result?.policy_id ?? '')}` : null;
  if (page !== 'playground' && page !== 'activity') return <Landing/>;
  return <div className="app-shell" data-theme={page === 'playground' ? theme : undefined}>
    <header className={`topbar${scrolled ? ' scrolled' : ''}`}>
      <span className="corner corner-left"><MapPin size={14}/> {form.region.trim() || 'Warsaw, PL'}</span>
      <nav className="pill" aria-label="Main navigation"><a className="pill-brand" href="#overview" aria-label="Crossroad overview"><Brand/></a>{["overview","playground","activity"].map(item => <a key={item} href={"#"+item} aria-current={page === item ? "page" : undefined}>{item}</a>)}<a className="pill-cta" href="#overview"><Zap size={14}/> Overview</a></nav>
      <span className="corner corner-right"><span className="solana-mark" aria-hidden="true">≋</span> {balance ? balance.balance_sol.toFixed(3)+" SOL" : "devnet"}</span>
    </header>
    <main id="workspace">
      {page === 'playground' && (() => {
        const T = Number.isFinite(trigger) && trigger > 0 ? trigger : 40, X = Number.isFinite(exit) && exit >= 0 ? exit : 10, S = Number.isFinite(sum) && sum > 0 ? sum : 0.01;
        const dry = cover === 'drought';
        const isCrop = preset === CUSTOM || !!currentProduct?.product_type.startsWith('crop_');
        const table = [0, 0.25, 0.5, 0.75, 1].map(r => ({ r, mm: T - r * (T - X), pay: S * r }));
        const eventStatusRatio = simEventStatus === 'cancelled' || simEventStatus === 'postponed' ? 1 : simEventStatus === 'onsale' ? 0 : null;
        const simRatios = mode === 'simulate' ? [num(simA), num(simB)].filter(Number.isFinite).map(mm => ratioOf(mm, T, X)).concat(simNdvi.trim() !== '' && Number.isFinite(num(simNdvi)) ? [ratioOf(num(simNdvi), ndviT, ndviE)] : []).concat(currentProduct?.venue_lookup && eventStatusRatio !== null ? [eventStatusRatio] : []) : [];
        const pf = simRatios.length ? Math.min(...simRatios) : 0, pc = simRatios.length ? Math.max(...simRatios) : 0, pDisagree = simRatios.length > 1 && pc - pf > 0.10;
        const steps = ['Your field', 'Your rule', 'The weather', 'Your money'];
        // "Just show me a payout": the selected product's own defaults, both sources agreeing near the middle of its rule, straight to Step 4.
        const quickDemo = () => { if (running || pending || !canNext || !directionOk) return; const t = num(form.trigger_mm), x = num(form.exit_mm); const a = +(t + 0.48 * (x - t)).toFixed(1), b = +(t + 0.52 * (x - t)).toFixed(1); setMode('simulate'); setScenario(isDemo ? '' : 'Force agreement'); setSimA(String(a)); setSimB(String(b)); setSimNdvi(''); setSatellite(false); setStep(4); window.scrollTo({ top: 0, behavior: 'smooth' }); void run({ a, b }); };
        const canNext = step === 1 ? form.region.trim() !== '' && Number.isFinite(num(form.lat)) && Number.isFinite(num(form.lon)) && sum > 0 && sum <= maxCover && (form.payee_pubkey.trim() === '' || isSolAddress(form.payee_pubkey)) : step === 2 ? directionOk && ndviE < ndviT : true;
        return <section className="playground guide">
          <div className="guide-head"><span className="eyebrow">PLAYGROUND</span><h1>Insure a field, step by step.</h1></div>
          <ol className="guide-steps" aria-label="Progress">{steps.map((s, i) => <li key={s} className={step === i + 1 ? 'now' : step > i + 1 ? 'done' : ''}><span>{step > i + 1 ? <Check size={13}/> : i + 1}</span>{s}</li>)}</ol>

          <div className="guide-card"><div className="guide-pane" key={`pane-${step}-${result ? result.dispute_status : "draft"}`}>
            {step === 1 && <div className="guide-body">
              <h2>Step 1 · What are we covering, and for how much?</h2>
              <p className="guide-what">What we protect, and the most it can ever receive. Nothing is paid yet.</p>
              <div className="guide-grid">
                <div className="field"><span>What are you covering? <Hint text="Each product comes with a ready-made rule that you can adjust in the next step. Pick 'My own rule' to also choose the direction and the satellite thresholds."/></span><div className="crop-pick five" role="radiogroup" aria-label="Product">{catalogError ? <span className="pick-note" role="alert">Couldn't load the product list. {catalogError}</span> : !catalog.length ? <span className="pick-note">Loading products…</span> : [...catalog.map(p => ({ key: p.product_type as string, label: p.label, hint: p.icon_hint })), { key: CUSTOM, label: 'My own rule', hint: 'sliders' }].map(o => { const Icon = iconFor[o.hint] ?? Package; return <button key={o.key} type="button" role="radio" aria-checked={preset === o.key} disabled={running} onClick={() => choosePreset(o.key)}><em><Icon size={20} aria-hidden="true"/></em>{o.label}</button>; })}</div></div>
                {currentProduct?.venue_lookup && <VenueField value={form.venue_name} disabled={running} onType={v => setForm(f => ({ ...f, venue_name: v }))}
                  onPick={v => setForm(f => ({ ...f, venue_name: v.name, region: [v.city, v.country].filter(Boolean).join(', '), lat: String(v.lat), lon: String(v.lon) }))}/>}
                <PlaceField label={currentProduct?.place_prompt ?? 'Where is this?'} noun={place} hint={`Search a village, street or landmark near your ${place}, or tap "Use my location" when you are there. Then drag the pin onto the exact spot: that is where the weather is read.`} value={form.region} lat={num(form.lat)} lon={num(form.lon)} disabled={running}
                  onType={v => setForm(f => ({ ...f, region: v, lat: '', lon: '' }))} onPick={(region, lat, lon) => setForm(f => ({ ...f, region, lat: String(lat), lon: String(lon) }))} onMove={(lat, lon) => setForm(f => ({ ...f, lat: String(lat), lon: String(lon) }))}/>
                {currentProduct?.venue_lookup && <label className="field"><span>Event date <Hint text="The day of the concert or festival. Weather is read for this day, and (with a venue) Ticketmaster is checked for a real event there on this date."/></span><input type="date" value={form.event_date} disabled={running} onChange={set('event_date')}/><small className="field-help">The day of the event. Leave it empty to cover the coming week.</small></label>}
                <div className="field cover-field" style={{ gridColumn: '1 / -1' }}><span>How much cover? <Hint text={`The most you can receive ${M.period} if your rule is hit at its worst. Smaller losses pay a smaller part. It is paid in SOL, the money on the Solana network (test money on devnet here).`}/></span>
                  {solUsd != null ? <div className="cover-chips" role="group" aria-label="Quick amounts">{coverUsd.map(u => { const v = solFor(u, solUsd); return <button key={u} type="button" aria-pressed={sum === v} disabled={running || v > maxCover} onClick={() => { coverTouched.current = true; setForm(f => ({ ...f, sum_insured_sol: String(v) })); }}><b>≈ ${Math.round(v * solUsd).toLocaleString('en-US')} cover</b><small>{v} SOL · {usdOf(v * premiumRate, solUsd).replace('≈ ', '')} to insure it</small></button>; })}</div>
                    : <small className="field-help">Dollar prices are unavailable right now. You can still type an amount in SOL.</small>}
                  <div className="cover-input"><input aria-label="Cover amount in SOL" inputMode="decimal" value={form.sum_insured_sol} disabled={running} onChange={e => { coverTouched.current = true; set('sum_insured_sol')(e); }}/><b>SOL cover</b></div>
                  {!(sum > 0) || sum > maxCover
                    ? <small className="field-help warn">{!(sum > 0) ? 'Enter an amount in SOL, or pick one above.' : `The demo allows at most ${maxCover} SOL${solUsd != null ? ` (${usdOf(maxCover, solUsd)})` : ''}.`}</small>
                    : <div className="money-flow">
                      <p>Pay a small amount now. Get up to the cover amount back later, only if {ruleName(currentProduct?.product_type, dry)} is triggered.</p>
                      <div className="money-box money-out"><ArrowDown size={18} aria-hidden="true"/><div><small>You pay now</small><b>{premium.toFixed(4)} SOL{solUsd != null && ` (${usdOf(premium, solUsd)})`}</b><span>Non-refundable. {+(premiumRate * 100).toFixed(2)}% of the cover, a flat demo rate <Hint text={PREMIUM_HINT}/></span></div></div>
                      <div className="money-box money-in"><ArrowUp size={18} aria-hidden="true"/><div><small>You could get back</small><b>up to {sum} SOL{solUsd != null && ` (${usdOf(sum, solUsd)})`}</b><span>Only if {ruleName(currentProduct?.product_type, dry)} is triggered. A smaller loss pays a smaller part.</span></div></div>
                    </div>}
                </div>
                <PayoutWallet label={payeeLabel} signer={signer} premium={premium} disabled={running} onChange={sg => { setSigner(sg); setForm(f => ({ ...f, payee_pubkey: sg?.address ?? '' })); }}/>
                <details className="src-more" style={{ gridColumn: '1 / -1' }}><summary>Enter exact coordinates instead</summary><div className="guide-grid" style={{ marginTop: 12 }}>
                  <label className="field"><span>Latitude <Hint text={`The exact spot of your ${place}, north to south. Right-click it in Google Maps and copy the first number.`}/></span><input inputMode="decimal" value={form.lat} disabled={running} onChange={set('lat')}/></label>
                  <label className="field"><span>Longitude <Hint text={`The exact spot of your ${place}, east to west. The second number from Google Maps.`}/></span><input inputMode="decimal" value={form.lon} disabled={running} onChange={set('lon')}/></label>
                </div></details>
              </div>
              <div className="guide-meaning"><b>What this means</b><p>You are insuring <em>{currentProduct?.subject ?? 'a custom policy'}</em> {isDemo ? 'from' : 'near'} <em>{form.region.trim() || '…'}</em>. The most it can receive is <em>{sol4(S)}{solUsd != null ? ` (${usdOf(S, solUsd)})` : ''}</em>. That money leaves the insurer's wallet on Solana only if the rule in the next step is hit.{isDemo && ` ${currentProduct?.source_note}`}</p></div>
            </div>}

            {step === 2 && <div className="guide-body">
              <h2>Step 2 · The rule that pays</h2>
              <p className="guide-what">One line decides everything. No adjuster, no phone call, no one can change the number afterwards.</p>
              <div className="guide-grid">
                {preset === CUSTOM && <label className="field"><span>Pay when rain is <Hint text="Drought: the less it rains, the more you get. Flooding: the more it rains, the more you get."/></span><select className="gsel" value={cover} disabled={running} onChange={e => chooseCover(e.target.value as Cover)}><option value="drought">too little (drought)</option><option value="excess_rain">too much (flooding)</option></select></label>}
                {rules && <div className="field" style={{ gridColumn: '1 / -1' }}><span>{rules.question} <Hint text={rules.hint}/></span>
                  {rules.scope && <p className="rule-scope"><AlertCircle size={15} aria-hidden="true"/>{rules.scope}</p>}
                  <div className="rule-pick" role="radiogroup" aria-label={rules.question}>{rules.options.map(o => <button key={o.title} type="button" role="radio" aria-checked={trigger === o.trigger && exit === o.exit} disabled={running} onClick={() => setForm(f => ({ ...f, trigger_mm: String(o.trigger), exit_mm: String(o.exit) }))}>
                    <b>{o.title}{o.recommended && <i>Recommended</i>}</b><small>{o.text}</small><em>Starts at {o.trigger} {M.unit} · full at {o.exit} {M.unit}</em></button>)}</div>
                  {rules.note && <small className="field-help">{rules.note}</small>}
                </div>}
                {(() => { const inputs = <>
                  <label className="field"><span>Starts paying at ({M.unit}) <Hint text={`Also called the trigger. The ${M.noun} ${M.period}: at this value you get nothing yet; past it the payout begins to grow.`}/></span><input inputMode="decimal" value={form.trigger_mm} disabled={running} onChange={set('trigger_mm')}/></label>
                  <label className="field"><span>Pays in full at ({M.unit}) <Hint text={`Also called the exit. At this ${M.noun} you get the whole cover amount.`}/></span><input inputMode="decimal" value={form.exit_mm} disabled={running} onChange={set('exit_mm')}/></label></>;
                  return rules ? <details className="src-more" style={{ gridColumn: '1 / -1' }}><summary>Set my own numbers</summary><div className="guide-grid" style={{ marginTop: 12 }}>{inputs}</div></details> : inputs; })()}
                {preset === CUSTOM && <details className="src-more" style={{ gridColumn: '1 / -1' }}><summary>Satellite settings (optional)</summary><div className="guide-grid" style={{ marginTop: 12 }}>
                  <label className="field"><span>Healthy field score <Hint text="Also called healthy NDVI. NDVI is a 0 to 1 greenness score from satellite photos. Around 0.6 and above means a healthy green field. At this value the satellite says no loss."/></span><input inputMode="decimal" value={form.ndvi_trigger} disabled={running} onChange={set('ndvi_trigger')}/></label>
                  <label className="field"><span>Dead field score <Hint text="Also called total-loss NDVI. Below about 0.3 the field looks bare or dead from space. At this value the satellite says total loss."/></span><input inputMode="decimal" value={form.ndvi_exit} disabled={running} onChange={set('ndvi_exit')}/></label>
                </div></details>}
              </div>
              <RuleScale productType={currentProduct?.product_type ?? 'custom'} dry={dry} t={T} x={X} unit={M.unit} cover={S} usd={usdOf(S, solUsd)}/>
              <details className="src-more"><summary>See the exact numbers</summary><div className="guide-meaning" style={{ marginTop: 10 }}><b>What you would earn</b>
                <table className="earn"><thead><tr><th>If the {M.noun} {M.period} is</th><th>You get</th></tr></thead><tbody>{table.map(row => <tr key={row.r}><td>{row.r === 0 ? `${row.mm} ${M.unit} or ${dry ? 'more' : 'less'}` : row.r === 1 ? `${row.mm} ${M.unit} or ${dry ? 'less' : 'more'}` : `about ${row.mm.toFixed(0)} ${M.unit}`}</td><td><b>{sol4(row.pay)}</b> <span>{pct(row.r)} of the cover</span></td></tr>)}</tbody></table>
                <p>In between it is a straight line. {dry ? `Less ${M.noun}, more money.` : `More ${M.noun}, more money.`}</p></div></details>
            </div>}

            {step === 3 && <div className="guide-body">
              <div className="demo-banner"><span>Demo mode</span><p>This step only exists for the demo. A real customer is never asked it: once the cover period ends, the readings are fetched automatically.</p></div>
              <h2>Step 3 · {M.who}</h2>
              <p className="guide-what">{isDemo ? `We never trust one source. Two independent readings. If they disagree, only the part they both agree on is paid at once, and the rest is held. ${currentProduct?.source_note}` : 'We never trust one source. Two independent weather models' + (isCrop ? ', and the satellite if you like' : '') + '. If they disagree, only the part they all agree on is paid at once, and the rest is held.'}</p>
              <div className="guide-options" role="radiogroup" aria-label="Readings source">{activePresets.map(p => <button key={p.label} type="button" role="radio" aria-checked={scenario === p.label} disabled={running} onClick={() => applyScenario(p)}><i/><span><b>{scenarioCopy[p.label].title} <em>{p.mode === 'live' ? 'real data' : 'demo'}</em></b><small>{scenarioCopy[p.label].text}</small></span></button>)}</div>
              {isCrop && <div className="sat-switch">
                <label className="wiz-check"><input type="checkbox" checked={satellite && !(mode === 'live' && !satelliteLive)} disabled={running || (mode === 'live' && !satelliteLive)} onChange={e => setSatellite(e.target.checked)}/><span><Satellite size={15} aria-hidden="true"/> Also look at the field from space (satellite, a third source)</span></label>
                {mode === 'live' && !satelliteLive ? <small className="field-help">Live satellite photos are not switched on for this server (no Agromonitoring key). Pick a demo card to try the satellite with example values.</small>
                  : satellite && (mode === 'live' ? <small className="field-help ok">The real satellite photo of your field is checked too, as a third source.</small>
                  : <div className="sat-look" role="radiogroup" aria-label="What does the satellite see?">{([['healthy', 'Field looks healthy', 'green crop, NDVI 0.65'], ['stressed', 'Field looks stressed', 'dry or dying crop, NDVI 0.20']] as const).map(([v, t, sub]) => <button key={v} type="button" role="radio" aria-checked={satLook === v} disabled={running} onClick={() => setSatLook(v)}><b>{t}</b><small>Demo value: {sub}</small></button>)}</div>)}
              </div>}
              <p className={`sim-note${mode === 'live' ? ' off' : ''}`}>{mode === 'live' ? 'Live weather is selected: the real readings are fetched for you, so there is nothing to type here.' : 'The card you picked filled in these numbers. Change them to fine-tune the scenario.'}</p>
              {mode !== 'live' && <div className="guide-grid three"><label className="field"><span>{isDemo ? `Feed A says (${M.unit})` : `${modelName(rainModels.a)} (${M.unit})`} <Hint text={isDemo ? 'Demo only: pretend this is what the first delay feed reported.' : `Demo only: pretend this is what the ${modelName(rainModels.a).toLowerCase()} reported. ${SOURCES_NOTE} Technically: ${modelTech(rainModels.a)}.`}/></span><input inputMode="decimal" value={simA} disabled={running} onChange={e => setSimA(e.target.value)}/></label><label className="field"><span>{isDemo ? `Feed B says (${M.unit})` : `${modelName(rainModels.b)} (${M.unit})`} <Hint text={isDemo ? 'Demo only: pretend this is what the second delay feed reported.' : `Demo only: pretend this is what the ${modelName(rainModels.b).toLowerCase()} reported. ${SOURCES_NOTE} Technically: ${modelTech(rainModels.b)}.`}/></span><input inputMode="decimal" value={simB} disabled={running} onChange={e => setSimB(e.target.value)}/></label>{currentProduct?.venue_lookup && <label className="field"><span>Event status (optional) <Hint text="Demo only: pretend Ticketmaster reports this status for the event, as a second, non-weather source. Leave on 'skip' to use weather only."/></span><select className="gsel" value={simEventStatus} disabled={running} onChange={e => setSimEventStatus(e.target.value)}><option value="">skip (weather only)</option><option value="onsale">still on sale</option><option value="postponed">postponed</option><option value="cancelled">cancelled</option></select></label>}</div>}
              <div className="guide-meaning"><b>What will happen</b>
                {mode === 'live' ? <>
                  <p>We read the real {M.noun} {M.period}{satellite ? ', and a satellite photo of your field' : ''}. Whatever it was, the rule pays for it.</p>
                  <div className="src-strip"><span><i/>{modelName(rainModels.a)}</span><span><i/>{modelName(rainModels.b)}</span>{satellite && <span><i/>Satellite photo</span>}{currentProduct?.venue_lookup && <span><i/>Ticketmaster</span>}</div>
                  {currentProduct?.venue_lookup && <p>{form.venue_name.trim() ? `We also check whether "${form.venue_name.trim()}" is on sale, postponed or cancelled on Ticketmaster — an independent, non-weather signal.` : 'Add a venue name in Step 1 to also check the event\'s real status on Ticketmaster (independent of the weather).'}</p>}
                  <details className="src-more"><summary>Where do these come from?</summary>
                    <ul className="pre-sources pre-trust">
                      <li><b>{modelName(rainModels.a)}</b><span><strong>{modelTech(rainModels.a)}</strong> · read through Open-Meteo, a Swiss non-profit weather service. <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">See the source <ArrowUpRight size={12}/></a></span></li>
                      <li><b>{modelName(rainModels.b)}</b><span><strong>{modelTech(rainModels.b)}</strong> · read through the same Open-Meteo service. A different forecast from the local one, so it usually goes wrong in different ways, though the local blend can also use European data in some regions. <a href="https://www.ecmwf.int/en/forecasts" target="_blank" rel="noreferrer">See the source <ArrowUpRight size={12}/></a></span></li>
                      <li className="pre-trust-note"><b>One clarification</b><span>Both readings are fetched through Open-Meteo's API — it's one provider re-serving two different underlying forecast models, not two separate companies queried independently.</span></li>
                      {satellite && <li><b>Satellite</b><span><strong>Sentinel-2 and Landsat 8</strong> · photos from ESA and NASA, read as a 0 to 1 greenness score of your field. <a href="https://agromonitoring.com/" target="_blank" rel="noreferrer">See the source <ArrowUpRight size={12}/></a></span></li>}
                      {currentProduct?.venue_lookup && <li><b>Event status</b><span><strong>Ticketmaster Discovery API</strong> · whether the event is on sale, postponed or cancelled, from the venue's own ticketing system. Only checked when a venue name was given in Step 1, and only if a matching event is found. <a href="https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/" target="_blank" rel="noreferrer">See the source <ArrowUpRight size={12}/></a></span></li>}
                      <li className="pre-trust-note"><b>Why you can trust it</b><span>Nobody types these numbers. They are fetched live when you press the button, every reading is shown afterwards, and the payment is on Solana for anyone to check.</span></li>
                    </ul>
                  </details>
                </> : (() => {
                  const rows: { name: string; v: number; unit: 'metric' | 'ndvi' | 'status' }[] = [{ name: isDemo ? `${M.label} feed A` : modelName(rainModels.a), v: num(simA), unit: 'metric' }, { name: isDemo ? `${M.label} feed B` : modelName(rainModels.b), v: num(simB), unit: 'metric' }]; if (simNdvi.trim() !== '' && Number.isFinite(num(simNdvi))) rows.push({ name: 'Satellite', v: num(simNdvi), unit: 'ndvi' }); if (currentProduct?.venue_lookup && eventStatusRatio !== null) rows.push({ name: 'Event status', v: eventStatusRatio, unit: 'status' }); const usable = rows.filter(r => Number.isFinite(r.v));
                  const withR = usable.map(r => ({ ...r, r: r.unit === 'ndvi' ? ratioOf(r.v, ndviT, ndviE) : r.unit === 'status' ? r.v : ratioOf(r.v, T, X) }));
                  const lo = withR.reduce((m, r) => r.r < m.r ? r : m, withR[0]), hi = withR.reduce((m, r) => r.r > m.r ? r : m, withR[0]);
                  return <>
                    {pDisagree ? <>
                      <p><em>{sol4(S * pf)}</em> is paid at once. <em>{sol4(S * (pc - pf))}</em> waits, because <em>{lo.name}</em> and <em>{hi.name}</em> don't agree.</p>
                    </> : <>
                      <p>{pf > 0.01 ? <>The sources agree. <em>{sol4(S * pf)}</em> is paid at once, nothing waits.</> : <>The sources agree: your rule was not hit, nothing is owed.</>}</p>
                    </>}
                    <details className="src-more"><summary>What each source says</summary>{!isDemo && <p className="src-note">{SOURCES_NOTE}</p>}<ul className="pre-sources">{withR.map(r => <li key={r.name}><b>{r.name}</b><span>says <em>{r.unit === 'ndvi' ? `NDVI ${r.v.toFixed(2)}` : r.unit === 'status' ? (r.v >= 1 ? 'cancelled / postponed' : 'still on sale') : `${r.v.toFixed(0)} ${M.unit} of ${M.noun}`}</em>{r.unit === 'ndvi' ? (r.r >= 0.5 ? ', the field looks stressed from space' : ', the field looks healthy from space') : r.unit === 'status' ? '' : (dry ? (r.v >= T ? ', enough rain, no loss' : r.v <= X ? ', very dry, total loss' : ', a dry week, some loss') : (r.v <= T ? ', normal rain, no loss' : r.v >= X ? ', flooded, total loss' : ', a wet week, some loss'))}. By your rule that is <em>{pct(r.r)}</em> of the cover, <em>{sol4(S * r.r)}</em>.</span></li>)}</ul></details>
                  </>;
                })()}
              </div>
            </div>}

            {step === 4 && <div className="guide-body">
              <h2>Step 4 · Your money</h2>
              {pending && <div className="pending-card" role="status" aria-live="polite">
                <b><Hourglass size={18}/> Still confirming</b>
                <p>The payment was sent, but the network has not confirmed it yet. It may already have gone through, so <strong>do not pay again</strong>. Check again in a moment.</p>
                <div className="pending-meta"><span>{pending.floor_amount_sol != null ? `${solD(pending.floor_amount_sol)} · ` : ''}transaction <code title={pending.tx_signature}>{pending.tx_signature.slice(0, 6)}…{pending.tx_signature.slice(-6)}</code></span>{pending.floor_explorer_url && <a className="external" href={pending.floor_explorer_url} target="_blank" rel="noreferrer">See it on Solana <ArrowUpRight size={13}/></a>}</div>
                <button type="button" className="primary" disabled={running} onClick={() => void checkAgain()}>{running ? <><RefreshCw size={15} className="spin"/> {phase || 'Checking'}…</> : <><RefreshCw size={15}/> Check again</>}</button>
              </div>}
              {!result && !pending && !running && !error && <p className="guide-what">Everything is set. Press the button and watch the money move on Solana devnet.</p>}
              {!result && <div className="guide-summary"><span>{currentProduct?.label ?? 'Custom rule'} · {form.region.trim() || '…'}</span><span>Cover {solD(S)}</span><span>Premium {solD(premium)} · paid now</span><span>{M.label} rule {T} → {X} {M.unit}</span><span>{mode === 'live' ? 'Real weather' : 'Demo readings'}</span></div>}
              {!result && !pending && <div className="wiz-go"><button className="primary wiz-btn" disabled={running || !formValid} type="button" onClick={() => void run()}>{running ? <><RefreshCw size={16} className="spin"/> {phase || 'Working'}…</> : <>Check the {M.noun} and pay me <ArrowUpRight size={18}/></>}</button><span>Real devnet SOL. It takes a few seconds.</span></div>}
              {running && <div className="working"><span className="pulse"/><span>{phase || 'Working'}…</span><span>{elapsed.toFixed(0)}s</span></div>}
              {error && <div className="error-banner" role="alert"><AlertCircle size={18}/><span>{error}</span></div>}
              {result && (() => {
                const weather = result.readings.filter(r => r.unit !== 'ndvi' && r.unit !== 'status'), evStatus = result.readings.find(r => r.unit === 'status'), sat = result.readings.find(r => r.unit === 'ndvi');
                const agree = result.dispute_status === 'none';
                const paid = result.floor_amount_sol, held = escrowState === 'none' ? 0 : escrow!.amount_sol;
                const got = paid + (escrowState === 'released' ? releasedAmount : 0);
                const plainWhy = agree ? '' : sat && weather.length && Math.abs((sat.payout_ratio ?? 0) - (weather.reduce((s, r) => s + (r.payout_ratio ?? 0), 0) / weather.length)) > 0.1
                  ? `The weather reports say one thing, the satellite picture of your field says another. We paid what all of them agree on. The rest waits until someone checks the picture.`
                  : `The two ${M.sources} don't match (${weather.map(r => `${r.observed_mm.toFixed(0)} ${r.unit}`).join(' vs ')}). We paid what both agree on. The rest waits for a fresh reading or a person.`;
                return <div className="flow" key={`${result.policy_id}-${result.cycle}-${result.dispute_status}`}>
                  <div className="flow-verdict">{got > 0 ? <><span className="flow-big flow-win"><ArrowUpRight size={28}/></span><div><b>You got paid.</b><p>{solD(got)} is in your wallet{held > 0 && escrowState === 'pending' ? `, and ${solD(held)} more may follow.` : '.'}</p></div></> : held > 0 && escrowState === 'pending' ? <><span className="flow-big flow-wait"><Hourglass size={26}/></span><div><b>Not yet.</b><p>{solD(held)} is waiting for a decision.</p></div></> : <><span className="flow-big flow-none"><Check size={26}/></span><div><b>No payout.</b><p>Your rule was not hit, so nothing is owed.</p></div></>}</div>
                  <ol className="flow-chain">
                    <li className="flow-box"><small>1 · {M.label} {M.period}</small><b>{weather.map(r => `${r.observed_mm.toFixed(0)} ${r.unit}`).join(' · ')}</b><span>{weather.length > 1 ? (agree ? 'both reports match' : 'reports differ') : 'one report'}{evStatus ? ` · event status: ${evStatus.detail.match(/status\.code=(\w+)/)?.[1] ?? 'known'}` : ''}{sat ? ` · field from space: ${(sat.payout_ratio ?? 0) >= 0.5 ? 'looks bad' : 'looks fine'}` : ''}</span></li>
                    <li className="flow-arrow" aria-hidden="true"><ArrowRight size={22}/><ArrowDown size={22}/></li>
                    <li className={`flow-box ${paid > 0 ? 'flow-box-win' : ''}`}><small>2 · Paid to you now</small><b>{solD(paid)}</b><span>{paid > 0 ? 'already in your wallet' : 'nothing owed'}</span>{result.floor_explorer_url && <a className="external" href={result.floor_explorer_url} target="_blank" rel="noreferrer">See it on Solana <ArrowUpRight size={13}/></a>}</li>
                    <li className="flow-arrow" aria-hidden="true"><ArrowRight size={22}/><ArrowDown size={22}/></li>
                    <li className={`flow-box ${escrowState === 'pending' ? 'flow-box-wait' : escrowState === 'released' ? 'flow-box-win' : escrowState === 'voided' ? 'flow-box-lost' : ''}`}><small>3 · {escrowState === 'none' ? 'Waiting' : escrowState === 'pending' ? 'Still waiting' : escrowState === 'released' ? 'Was waiting, now paid' : 'Was waiting, not paid'}</small><b>{escrowState === 'none' ? 'nothing' : escrowState === 'released' ? solD(releasedAmount) : solD(held)}</b><span>{escrowState === 'none' ? 'everyone agreed' : escrowState === 'pending' ? (result.dispute_status === 'escalated' ? 'a person must decide' : 'settles at the next reading') : escrowState === 'released' ? 'sent to your wallet' : 'the higher reading was not trusted'}</span>{(escrow?.escrow_pda ?? result.escrow_pda) && <span className="pda-note">Locked in a program-controlled account — not held by us.<a className="external" href={escrow?.escrow_explorer_link ?? result.escrow_explorer_link ?? '#'} target="_blank" rel="noreferrer" title={escrow?.escrow_pda ?? result.escrow_pda ?? ''}>{(escrow?.escrow_pda ?? result.escrow_pda ?? '').slice(0, 4)}…{(escrow?.escrow_pda ?? result.escrow_pda ?? '').slice(-4)} on Explorer <ArrowUpRight size={13}/></a></span>}{escrow?.release_explorer_url && <a className="external" href={escrow.release_explorer_url} target="_blank" rel="noreferrer">See it on Solana <ArrowUpRight size={13}/></a>}</li>
                  </ol>
                  {escrowState === 'pending' && <div className="flow-decide"><p><b>What should happen to the {solD(held)} that is waiting?</b></p><div className="flow-buttons"><button type="button" disabled={running || !!pending} onClick={() => void resolve(true)}><ArrowUpRight size={16}/> Pay it to me</button><button type="button" className="flow-no" disabled={running || !!pending} onClick={() => void resolve(false)}><XIcon size={16}/> Don't pay it</button>{result.dispute_status === 'investigating' && <button type="button" className="flow-again" disabled={running || !!pending} onClick={() => void nextCycle()}><RefreshCw size={15}/> Check the weather again</button>}</div></div>}
                  {!agree && <div className="flow-why"><b>Why part of it waits <span className="ai-badge">{providerBadge(result.dispute)}</span></b><p>{plainWhy}</p><details><summary>The full explanation</summary><p>{result.dispute?.summary}</p><small>{result.dispute?.ai_used ? `Written by ${result.dispute.model}` : 'Rule-based check'}. It can explain and flag. It can never pay.</small></details></div>}
                  <div className="flow-total"><span>Your cover was <b>{policy ? solD(policy.sum_insured_sol) : '—'}</b></span><span>Received <b>{solD(got)}</b></span>{escrowState === 'pending' && <span>Still possible <b>{solD(held)}</b></span>}</div>
                  {result.proof && <details className="pg-details proof"><summary>Show the math</summary>
                    <div className="proof-body">
                      <p className="proof-ai"><b>{result.proof.ai_involvement === 'none' ? 'No AI was involved. The formula alone set this amount.' : 'The AI did not decide this amount. It only wrote the explanation of the disagreement.'}</b></p>
                      <table className="proof-table"><thead><tr><th>Source</th><th>Reading</th><th>Fetched</th><th>Payout ratio</th></tr></thead><tbody>{result.proof.readings.map(r => <tr key={r.source}><td>{r.source} <span className={r.live ? 'tag-live' : 'tag-sim'}>{r.live ? 'live' : 'demo'}</span></td><td>{r.unit === 'status' ? `event status: ${r.value}` : `${r.value} ${r.unit}`}</td><td>{r.fetched_at.replace('T', ' ').replace('Z', ' UTC')}</td><td>{r.payout_ratio.toFixed(4)}</td></tr>)}</tbody></table>
                      <dl className="proof-lines"><div><dt>Trigger / exit</dt><dd>{result.proof.trigger} {result.proof.metric_unit} / {result.proof.exit} {result.proof.metric_unit}</dd></div><div><dt>Formula</dt><dd><code>{result.proof.formula}</code></dd></div><div><dt>Floor (paid now)</dt><dd><code>{result.proof.floor_calc}</code></dd></div><div><dt>Ceiling (most possible)</dt><dd><code>{result.proof.ceiling_calc}</code></dd></div><div><dt>Disagreement</dt><dd>spread {pct(result.spread)} vs tolerance {pct(result.proof.tolerance)}</dd></div><div><dt>Inputs hash</dt><dd><code className="proof-hash">sha256 {result.proof.inputs_hash}</code></dd></div>{result.proof.data_source_note && <div><dt>Data source</dt><dd>{result.proof.data_source_note}</dd></div>}</dl>
                    </div>
                  </details>}
                <details className="pg-details numbers"><summary>All the numbers, explained</summary>
                  <div className="num-block"><h4>Where each number came from</h4>
                    <div className="num-sources">{result.readings.map(r => { const ratio = r.payout_ratio ?? 0; const who = r.unit === 'status' ? { name: r.live ? 'Ticketmaster event status' : 'Ticketmaster event status (demo value)', what: r.live ? 'Whether the event is on sale, postponed or cancelled, read from the venue\'s own ticketing system.' : 'A pretend event status, chosen for the demo.' } : r.source.includes(rainModels.a) ? { name: modelName(rainModels.a), what: `Real reading. Technically: ${modelTech(rainModels.a)}, via Open-Meteo.` } : r.source.includes(rainModels.b) ? { name: modelName(rainModels.b), what: `Real reading. Technically: ${modelTech(rainModels.b)}, via Open-Meteo.` } : r.source.includes('agromonitoring') ? { name: 'Satellite (Agromonitoring)', what: 'Greenness of the field from Sentinel-2 and Landsat photos.' } : r.unit === 'ndvi' ? { name: 'Satellite (demo value)', what: 'A pretend greenness score, typed in for the demo.' } : { name: isDemo ? `${M.label} feed ${r.source.endsWith('B') ? 'B' : 'A'} (demo value)` : `${modelName(r.source.endsWith('B') ? rainModels.b : rainModels.a)} (demo value)`, what: `A pretend ${M.noun} value, typed in for the demo.` };
                      return <div key={r.source} className="num-source"><div className="num-source-head"><b>{who.name}</b><span className={r.live ? 'tag-live' : 'tag-sim'}>{r.live ? 'real data' : 'demo'}</span></div><p>{who.what}</p><div className="num-source-row"><span>It reported</span><b>{r.unit === 'ndvi' ? `NDVI ${r.observed_mm.toFixed(2)}` : r.unit === 'status' ? (r.detail.match(/status\.code=(\w+)/)?.[1] ?? (r.observed_mm >= 1 ? 'cancelled / postponed' : 'on sale')) : `${r.observed_mm.toFixed(1)} ${M.unit} of ${M.noun}`}</b></div><div className="num-source-row"><span>By your rule that means</span><b className={ratio >= 0.5 ? 'pg-bad' : ratio > 0.01 ? 'pg-mid' : 'pg-ok'}>{ratio <= 0.01 ? 'no loss, 0% payout' : ratio >= 0.99 ? 'total loss, 100% payout' : `${pct(ratio)} of the cover`}</b></div>{r.detail && r.live && <small>{r.detail}</small>}</div>; })}</div>
                  </div>
                  <div className="num-block"><h4>How the money was worked out</h4>
                    <ol className="num-math">
                      <li><span>Lowest payout any source allows</span><b>{pct(result.payout_ratio_floor)}</b><small>Everyone agrees on at least this much, so it was paid right away: {pct(result.payout_ratio_floor)} of {policy ? solD(policy.sum_insured_sol) : '—'} = <em>{solD(result.floor_amount_sol)}</em>.</small></li>
                      <li><span>Highest payout any source allows</span><b>{pct(result.payout_ratio_ceiling)}</b><small>{result.spread > result.tolerance ? <>The gap between lowest and highest is {pct(result.spread)}. Anything over {pct(result.tolerance)} counts as a disagreement, so the difference was held: <em>{solD(result.escrow_amount_sol)}</em>.</> : <>The gap is only {pct(result.spread)}, within the {pct(result.tolerance)} allowance, so the sources count as agreeing and nothing was held.</>}</small></li>
                      <li><span>The rule itself</span><b>{policy?.cover === 'excess_rain' ? 'more rain, more payout' : 'less rain, more payout'}</b><small>payout = (trigger − rain) ÷ (trigger − exit), kept between 0 and 1. With trigger {policy?.trigger_mm} mm and exit {policy?.exit_mm} mm.{satReading ? ` The satellite uses the same shape with NDVI ${policy?.ndvi_trigger} (healthy) and ${policy?.ndvi_exit} (total loss).` : ''}</small></li>
                    </ol>
                  </div>
                  {satReading && <div className="num-block"><h4>The field from space</h4><figure className="satellite-proof"><div className="satellite-frame">{satImage ? <img src={satImage} alt={`NDVI image of the field, ${satReading.live ? 'satellite scene' : 'simulated'}`}/> : <div className="satellite-missing"><Satellite size={22}/><span>No scene available</span></div>}</div><figcaption><strong><Satellite size={13}/> Greenness map {satReading.live ? <span className="tag-live">real scene</span> : <span className="tag-sim">demo</span>}</strong><span className="satellite-stat"><em>{satReading.observed_mm.toFixed(2)}</em> average greenness (NDVI)</span>{satReading.captured_at && <span>photographed {satReading.captured_at}</span>}<span>Green means healthy plants, brown means bare soil or dead crop.</span></figcaption></figure></div>}
                  {result.dispute && <div className="num-block"><h4>What the watchdog checked</h4><ul className="num-evidence">{result.dispute.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul><small className="num-foot">{result.dispute.ai_used ? `Written by ${result.dispute.model}` : 'Rule-based check'}. It can explain and flag. It can never move money.</small></div>}
                  <div className="num-block num-policy"><h4>This policy</h4><dl><div><dt>Policy number</dt><dd>{result.policy_id}</dd></div><div><dt>Field</dt><dd>{policy?.region} · {policy?.lat}, {policy?.lon}</dd></div><div><dt>Week covered</dt><dd>{policy?.window_start} to {policy?.window_end}</dd></div><div><dt>Cover</dt><dd>{policy ? solD(policy.sum_insured_sol) : '—'}</dd></div><div><dt>Paid to</dt><dd className="num-mono">{policy?.payee_pubkey ? `${policy.payee_pubkey.slice(0, 6)}…${policy.payee_pubkey.slice(-6)}` : '—'}</dd></div><div><dt>Time to settle</dt><dd>{(result.elapsed_ms / 1000).toFixed(2)} seconds</dd></div></dl>{result.note && <p className="payment-note">{result.note}</p>}</div>
                </details>
                </div>;
              })()}
            </div>}

            </div>
            <div className="guide-nav">
              {step > 1 && !running && !result && !pending ? <button type="button" className="guide-back" onClick={() => { if (result) { setResult(null); setPolicy(null); setError(''); setStep(1); } else setStep(step - 1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{result ? 'Start over' : 'Back'}</button> : step === 1 && !running && !pending && !result ? <button type="button" className="guide-back guide-demo" disabled={!canNext || !directionOk} onClick={quickDemo} title="Skip the steps: fills in sensible defaults and shows a payout">Just show me a payout</button> : <span/>}
              {step < 4 && <button type="button" className="primary guide-next" disabled={!canNext} onClick={() => setStep(step + 1)}>Next: {steps[step]} <ArrowUpRight size={16}/></button>}
              {step === 4 && result && !running && !pending && <button type="button" className="primary guide-next" onClick={() => { setResult(null); setPolicy(null); setError(''); setStep(1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Insure another field <ArrowUpRight size={16}/></button>}
            </div>
          </div>
        </section>;
      })()}
      {page === 'activity' && <section className="activity"><div className="page-heading"><div><span className="eyebrow">ON-CHAIN RECORDS</span><h1>Wallet <em>activity.</em></h1><p>Inspect the payouts sent by the insurer wallet.</p></div><a className="secondary-link" href="#playground">New policy <ArrowUpRight size={16}/></a></div><details className="wallet" open>
        <summary><span><Wallet size={17}/> Insurer wallet</span><span>{balance ? balance.balance_sol.toLocaleString('en-US',{maximumFractionDigits:6}) : refreshing ? 'Loading…' : 'Unavailable'} {balance && 'SOL'}<ChevronRight size={16}/></span></summary>
        <div className="wallet-content"><div className="wallet-address"><span>{cluster}</span>{balance && <div><a href={explorer('address',balance.address)} target="_blank" rel="noreferrer">{short(balance.address)} <ArrowUpRight size={14}/></a><button aria-label={copied ? 'Address copied' : 'Copy wallet address'} onClick={async () => { try { await navigator.clipboard.writeText(balance.address); setCopied(true); } catch { setBalanceError('Clipboard unavailable. Open the wallet link to copy the address.'); } }}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button></div>}</div>
        <div className="history-heading"><h2>Recent transactions</h2><button className="refresh" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/> Refresh</button></div>
        {balanceError && <p className="inline-error" role="alert">{balanceError}{balance && ' Showing last known balance.'}</p>}
        {historyError && <p className="inline-error" role="alert">{historyError}{history && ' Showing last retrieved transactions.'}</p>}
        {history?.transactions.length ? <ul className="transaction-list">{history.transactions.map(tx => <li key={tx.signature}><a href={explorer('tx',tx.signature)} target="_blank" rel="noreferrer" aria-label={'View transaction '+tx.signature}><span>{short(tx.signature)}</span><span className={tx.err == null ? 'success' : 'failed'}>{tx.err == null ? 'Successful' : 'Failed'} <ArrowUpRight size={14}/></span></a></li>)}</ul> : <p className="empty">{refreshing ? 'Loading transactions…' : historyError ? 'History is unavailable right now.' : 'No transactions yet.'}</p>}
        </div>
      </details></section>}
      {balanceError && <p className="wallet-warning">Wallet could not refresh{balance ? ' · Balance may be out of date' : ''}. Visit Activity to inspect wallet details.</p>}
      <footer><span className="footer-wordmark"><Brand size={18}/></span><span>Parametric cover. Deterministic payouts.</span><span className="footer-end">SOLANA / CROSSROAD DEMO</span></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
