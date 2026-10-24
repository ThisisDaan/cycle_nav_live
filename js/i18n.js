// Languages. English is written in the code; other languages map English text to
// their own. Code calls t() for sentences with values in them; fixed text in the
// page (buttons, labels, hints) is translated as it appears on screen.

import * as store from './store.js';

export const LANGUAGES = { en: 'English', nl: 'Nederlands' };

const NL = {
  // saved drawer
  'Routes': 'Routes',
  'Search saved': 'Zoek in bewaard',
  '{0} from you': '{0} van je af',
  'Shown on map': 'Zichtbaar op kaart',
  'Hidden on map': 'Verborgen op kaart',
  'Export GPX': 'GPX exporteren',
  'Ride it': 'Rijd dit',
  'Rename': 'Hernoemen',
  'Add {0} as a stop?': '{0} toevoegen als stop?',
  'Finish this ride first': 'Rond eerst deze rit af',
  'No saved routes yet. Plan a route and tap the bookmark button to keep it here.': 'Nog geen opgeslagen routes. Plan een route en tik op de bladwijzer om hem hier te bewaren.',
  'Restore': 'Herstellen',
  // pins & end sheet
  'Saved': 'Bewaard',
  'Pins': 'Pinnen',
  'Pin': 'Pin',
  'Pin saved': 'Pin bewaard',
  'Save pin': 'Pin bewaren',
  'Edit pin': 'Pin bewerken',
  'Delete this pin?': 'Deze pin verwijderen?',
  '📌 Save as pin': '📌 Bewaar als pin',
  '📌 Save my location': '📌 Bewaar mijn locatie',
  'Save as pin': 'Bewaar als pin',
  'Emoji': 'Emoji',
  'Any emoji': 'Een willekeurige emoji',
  'Name': 'Naam',
  'Note (optional)': 'Notitie (optioneel)',
  'Show on map': 'Toon op kaart',
  'Map': 'Kaart',
  'View': 'Bekijk',
  'Save': 'Bewaren',
  'Route here': 'Route hierheen',
  'Add as stop': 'Toevoegen als stop',
  'No pins yet. Long-press the map, or tap the pin icon in a search result, to save a place.': 'Nog geen pinnen. Druk lang op de kaart of tik op het pin-icoon bij een zoekresultaat om een plek te bewaren.',
  'End this ride?': 'Rit beëindigen?',
  'ridden': 'gereden',
  'End and save ride': 'Beëindig en bewaar rit',
  'End ride': 'Rit beëindigen',
  'End without saving': 'Beëindig zonder bewaren',
  'Continue riding': 'Verder rijden',
  // offline
  'Offline': 'Offline',
  'Offline maps': 'Offline kaarten',
  'Download an area': 'Gebied downloaden',
  'Download': 'Downloaden',
  'Area downloaded': 'Gebied gedownload',
  'Pan and zoom the map, drag the corners to resize.': 'Verschuif en zoom de kaart, sleep de hoeken om het formaat aan te passen.',
  'Map ≈ {0} MB': 'Kaart ≈ {0} MB',
  'routing data ≈ {0} MB': 'routedata ≈ {0} MB',
  'total ≈ {0} MB': 'totaal ≈ {0} MB',
  'Routing data for this area is already downloaded.': 'Routedata voor dit gebied is al gedownload.',
  'This area is too large. Zoom in to pick a smaller area.': 'Dit gebied is te groot. Zoom in om een kleiner gebied te kiezen.',
  'Looking up place…': 'Plaats opzoeken…',
  'Refresh': 'Vernieuwen',
  'Delete': 'Verwijderen',
  'Routing data': 'Routedata',
  'No downloaded maps yet.': 'Nog geen gedownloade kaarten.',
  'No routing data downloaded.': 'Geen routedata gedownload.',
  'Downloaded maps let you see the map and search for places without a connection.': 'Gedownloade kaarten laten je de kaart zien en plaatsen zoeken zonder verbinding.',
  'Offline routing needs the Android app. Maps and search work here.': 'Offline routeren vereist de Android-app. Kaarten en zoeken werken hier.',
  'Offline – using downloaded map': 'Offline – gedownloade kaart in gebruik',
  'Offline – no routing data here': 'Offline – hier geen routedata',
  'No offline routing data for this area': 'Geen offline routedata voor dit gebied',
  'Cancel download': 'Download annuleren',
  'Download cancelled': 'Download geannuleerd',
  'Download finished': 'Download voltooid',
  'Download failed': 'Download mislukt',
  'Downloading map…': 'Kaart downloaden…',
  'Downloading search index…': 'Zoekindex downloaden…',
  'Downloading routing data…': 'Routedata downloaden…',
  'Downloading fonts and symbols…': 'Lettertypen en symbolen downloaden…',
  'Area {0}': 'Gebied {0}',
  'Delete {0}?': '{0} verwijderen?',
  'Download “{0}”? Map ≈ {1} MB, routing data ≈ {2} MB. Total ≈ {3} MB.': '“{0}” downloaden? Kaart ≈ {1} MB, routedata ≈ {2} MB. Totaal ≈ {3} MB.',
  'Downloading, please wait': 'Bezig met downloaden, even geduld',
  'A download is already running': 'Er loopt al een download',
  // planner & map
  'My location': 'Mijn locatie',
  'Where to?': 'Waarheen?',
  'Swap start and destination': 'Start en bestemming omwisselen',
  'Swap': 'Omwisselen',
  'Clear route': 'Route wissen',
  'Clear': 'Wissen',
  'Settings': 'Instellingen',
  'Centre on me': 'Centreer op mij',
  'Record a ride without navigating': 'Rit opnemen zonder navigatie',
  'Record ride': 'Rit opnemen',
  'Show or hide route options': 'Routeopties tonen of verbergen',
  'Use this route next time': 'Gebruik deze route de volgende keer',
  'Save this route': 'Route bewaren',
  'Undo': 'Ongedaan maken',
  'Point added': 'Punt toegevoegd',
  'Point moved': 'Punt verplaatst',
  'Point removed': 'Punt verwijderd',
  'Swapped': 'Omgedraaid',
  'Route cleared': 'Route gewist',
  'Route reset': 'Route hersteld',
  'Start': 'Start',
  'Use GPS': 'Gebruik gps',
  'Waiting for GPS…': 'Wachten op gps…',
  'Follow a GPX route…': 'Een GPX-route volgen…',
  'Open a .gpx file and navigate along it': 'Open een .gpx-bestand en navigeer erlangs',
  'Recent': 'Recent',
  'Searching…': 'Zoeken…',
  'Nothing found': 'Niets gevonden',
  'Search is unavailable right now': 'Zoeken is nu niet beschikbaar',
  'Dropped pin': 'Geplaatste pin',
  'Route here': 'Route hierheen',
  'Go via here': 'Via dit punt',
  'Start from here': 'Start hier',
  'Directions from here': 'Route vanaf hier',
  'Directions to here': 'Route hierheen',
  'Remove this point': 'Dit punt verwijderen',
  'Hide points': 'Punten verbergen',
  'finding name…': 'naam zoeken…',
  'Point {0}': 'Punt {0}',
  '{0} points in between': '{0} tussenpunten',
  'This device has no location support': 'Dit apparaat ondersteunt geen locatie',
  'Location is off — type a start point, or allow location access': 'Locatie staat uit — typ een startpunt of sta locatietoegang toe',

  // planning
  'Waiting for your location…': 'Wachten op je locatie…',
  'Start and destination are the same place.': 'Start en bestemming zijn dezelfde plek.',
  'Updating your route…': 'Je route bijwerken…',
  'Finding calm routes…': 'Rustige routes zoeken…',
  "Couldn't route through that point: {0}": 'Geen route via dat punt mogelijk: {0}',
  "Couldn't find a route: {0}": 'Geen route gevonden: {0}',
  "{0}'s pace": 'Tempo van {0}',
  'Undo my changes': 'Mijn wijzigingen ongedaan maken',
  'Drag the green line to change the route': 'Sleep de groene lijn om de route te wijzigen',
  'Your usual way': 'Je vaste route',
  'Your route': 'Jouw route',
  'Most off-road': 'Meeste onverhard',
  'Calmest': 'Rustigst',
  'Shorter': 'Korter',
  'Alternative': 'Alternatief',
  'saved by you': 'door jou opgeslagen',
  'ridden {0}×': '{0}× gereden',
  '{0}% familiar': '{0}% bekend',
  'follows your GPX': 'volgt je GPX',
  '1 point added': '1 punt toegevoegd',
  '{0} points added': '{0} punten toegevoegd',
  'fewest turns': 'minste afslagen',
  '{0}% busy road': '{0}% drukke weg',
  '{0}% bike paths/lanes': '{0}% fietspad/-strook',
  '{0} turns': '{0} afslagen',
  '{0}% unpaved': '{0}% onverhard',
  'Drag the line or the white dot to change the route': 'Sleep de lijn of de witte stip om de route te wijzigen',
  'Drag the white dot to where you want to ride': 'Sleep de witte stip naar waar je wilt fietsen',
  'Saved. Next time this shows up as “Your usual way”': 'Opgeslagen. Volgende keer staat dit als „Je vaste route”',

  // navigation
  'End': 'Stop',
  'End ride': 'Rit beëindigen',
  'Stop?': 'Stoppen?',
  'Tap End to stop': 'Tik op Stop om te stoppen',
  'Show ride details': 'Ritdetails tonen',
  'arrival': 'aankomst',
  'to go': 'te gaan',
  'moving': 'onderweg',
  'ridden': 'gereden',
  'km/h avg': 'km/u gem.',
  'km/h': 'km/u',
  'Add a stop (café, shop, address…)': 'Stop toevoegen (café, winkel, adres…)',
  'Show whole route': 'Hele route tonen',
  'Coming up': 'Hierna',
  'Map orientation': 'Kaartrichting',
  'Voice on/off': 'Stem aan/uit',
  'Voice': 'Stem',
  'Re-centre': 'Centreren',
  'Voice on': 'Stem aan',
  'Voice off': 'Stem uit',
  'Map: {0}': 'Kaart: {0}',
  'Riding direction': 'Rijrichting',
  'The way you ride points up': 'Waar je heen fietst wijst omhoog',
  'North up': 'Noorden boven',
  'The map never turns': 'De kaart draait nooit',
  'Phone direction': 'Telefoonrichting',
  'Turns with the phone, like a compass': 'Draait mee met de telefoon, als een kompas',
  'Demo mode: simulating your ride': 'Demomodus: je rit wordt gesimuleerd',
  'Recording — ride your favourite way and Cycle Nav will remember it': 'Opname loopt — fiets je favoriete route en Cycle Nav onthoudt hem',
  'Locating…': 'Locatie zoeken…',
  'Off route': 'Van de route af',
  'Finding a new route…': 'Nieuwe route zoeken…',
  'Rerouting…': 'Herberekenen…',
  'Arrive at destination': 'Aankomst op bestemming',
  'Arrived': 'Aangekomen',
  'You have arrived': 'Je bent aangekomen',
  'Route updated': 'Route bijgewerkt',
  'Could not reroute — keep going, retrying shortly': 'Herberekenen mislukt — fiets door, zo opnieuw',
  'Ride too short to save': 'Rit te kort om op te slaan',
  'Then': 'Daarna',
  'right after': 'direct daarna',
  'after {0}': 'na {0}',
  '{0} away': 'nog {0}',
  'Destination': 'Bestemming',
  'Adding a stop at {0}…': 'Stop toevoegen: {0}…',
  "You've reached {0}": 'Je bent bij {0}',
  'You have reached {0}': 'Je bent bij {0}',
  "Let's go. {0} to go": 'Daar gaan we. Nog {0}',
  'In {0} metres, {1}': 'Over {0} meter, {1}',
  'kilometres': 'kilometer',
  'metres': 'meter',
  '{0}, then {1}': '{0}, daarna {1}',
  'Remove stop': 'Stop verwijderen',

  // turn instructions
  'Continue straight': 'Rechtdoor',
  'Turn left': 'Sla linksaf',
  'Bear left': 'Houd links aan',
  'Turn sharp left': 'Sla scherp linksaf',
  'Turn right': 'Sla rechtsaf',
  'Bear right': 'Houd rechts aan',
  'Turn sharp right': 'Sla scherp rechtsaf',
  'Keep left': 'Links aanhouden',
  'Keep right': 'Rechts aanhouden',
  'Make a U-turn': 'Keer om',
  'Continue': 'Ga verder',
  'Head straight on': 'Ga rechtdoor',
  'Take the exit on the left': 'Neem de afslag links',
  'Take the exit on the right': 'Neem de afslag rechts',
  'At the roundabout, take exit {0}': 'Neem op de rotonde afslag {0}',
  'Go through the roundabout': 'Ga over de rotonde',

  // rides
  'You made it! 🎉': 'Gelukt! 🎉',
  'Save this ride?': 'Deze rit opslaan?',
  'This was a simulated demo ride — you probably want to discard it.': 'Dit was een gesimuleerde demorit — die wil je waarschijnlijk weggooien.',
  'Saved rides teach Cycle Nav your favourite ways and your real speed.': 'Opgeslagen ritten leren Cycle Nav je favoriete routes en je echte snelheid.',
  'distance': 'afstand',
  'Ridden on': 'Gereden met',
  'Name (optional)': 'Naam (optioneel)',
  'Discard': 'Weggooien',
  'Save ride': 'Rit opslaan',
  'Ride': 'Rit',
  'To {0}': 'Naar {0}',
  'Ride saved — I’ll remember this way': 'Rit opgeslagen — ik onthoud deze route',
  'No route or track found in that GPX file': 'Geen route of track gevonden in dat GPX-bestand',
  'Start of {0}': 'Begin van {0}',
  'End of GPX route': 'Einde van GPX-route',
  'Following {0} ({1})': '{0} volgen ({1})',
  'Imported {0} rides for {1}': '{0} ritten geïmporteerd voor {1}',
  'No usable GPX tracks found': 'Geen bruikbare GPX-tracks gevonden',

  // bikes
  'Manage bikes': 'Fietsen beheren',
  'Add a bike': 'Fiets toevoegen',
  'Edit bike': 'Fiets bewerken',
  'Name': 'Naam',
  'e.g. Gazelle, Road bike, Bakfiets': 'bijv. Gazelle, Racefiets, Bakfiets',
  'Icon': 'Icoon',
  'Colour': 'Kleur',
  'Custom colour': 'Eigen kleur',
  'Type': 'Type',
  'Route style': 'Routestijl',
  'Average speed (km/h)': 'Gemiddelde snelheid (km/u)',
  'Learned from your last {0} rides: {1} km/h. Arrival times use {2} km/h.': 'Geleerd van je laatste {0} ritten: {1} km/u. Aankomsttijden gebruiken {2} km/u.',
  'Used for arrival times until Cycle Nav has learned your real pace from a few saved rides.': 'Gebruikt voor aankomsttijden tot Cycle Nav je echte tempo heeft geleerd van een paar opgeslagen ritten.',
  'Avoid unnecessary climbing': 'Onnodig klimmen vermijden',
  'Paved roads only (no gravel or dirt)': 'Alleen verharde wegen (geen grind of zand)',
  'Remove': 'Verwijderen',
  'Cancel': 'Annuleren',
  'Save': 'Opslaan',
  'Remove {0}? Its rides stay saved.': '{0} verwijderen? De ritten blijven bewaard.',
  'My bike': 'Mijn fiets',
  'City / commuter': 'Stad / woon-werk',
  'Road bike': 'Racefiets',
  'E-bike': 'E-bike',
  'Cargo bike': 'Bakfiets',
  'Mountain / gravel': 'Mountainbike / gravel',
  'Calm': 'Rustig',
  'Bike paths & straight roads, few turns': 'Fietspaden & rechte wegen, weinig afslagen',
  'Balanced': 'Gebalanceerd',
  'Prefers bike paths, accepts some turns': 'Liefst fietspaden, wat afslagen is oké',
  'Direct': 'Direct',
  'Shorter, still avoids busy roads': 'Korter, maar vermijdt drukke wegen',
  'Off-road': 'Onverhard',
  'Trails, gravel and forest paths (MTB)': 'Trails, grind en bospaden (MTB)',
  '{0} routes': '{0} routes',
  'riding': 'actief',
  'Use': 'Gebruik',
  'Edit': 'Bewerken',
  '(learned from {0} rides)': '(geleerd van {0} ritten)',

  // settings
  'Close': 'Sluiten', 'light': 'licht', 'moderate': 'matig', 'heavy': 'zwaar',
  'Bikes': 'Fietsen',
  'Rides': 'Ritten',
  'Look': 'Uiterlijk',
  'More': 'Meer',
  'Your bikes': 'Je fietsen',
  'Each bike has its own route style and speed. Ride with it and save the ride, and its speed adjusts to how fast you really go.': 'Elke fiets heeft een eigen routestijl en snelheid. Fiets ermee en sla de rit op, dan past de snelheid zich aan aan hoe snel je echt gaat.',
  'Memory': 'Geheugen',
  'rides': 'ritten',
  'km remembered': 'km onthouden',
  'Show my ridden roads on the map': 'Mijn gereden wegen op de kaart tonen',
  'When you plan a trip you’ve ridden before, Cycle Nav offers “Your usual way”, and it prefers routes over roads you know.': 'Plan je een rit die je eerder hebt gefietst, dan biedt Cycle Nav „Je vaste route” aan, en het kiest liever wegen die je kent.',
  'Import GPX rides': 'GPX-ritten importeren',
  'Navigate a GPX route': 'GPX-route navigeren',
  'Got rides in Strava, Garmin or Komoot? Export them as GPX and import them here to teach Cycle Nav your routes right away.': 'Ritten in Strava, Garmin of Komoot? Exporteer ze als GPX en importeer ze hier, dan kent Cycle Nav je routes meteen.',
  'View': 'Bekijken',
  'Delete ride': 'Rit verwijderen',
  'saved route': 'opgeslagen route',
  'No rides yet. Navigate somewhere, or tap the red record button and ride your favourite way.': 'Nog geen ritten. Navigeer ergens heen, of tik op de rode opnameknop en fiets je favoriete route.',
  'Delete this ride? Cycle Nav will forget it.': 'Deze rit verwijderen? Cycle Nav vergeet hem.',
  'Could not export the GPX': 'Kon de GPX niet exporteren',
  'Appearance': 'Weergave',
  'Automatic': 'Automatisch',
  'Light': 'Licht',
  'Dark': 'Donker',
  'Accent colour': 'Accentkleur',
  'Map': 'Kaart',
  'Your position on the map': 'Je positie op de kaart',
  'Arrow': 'Pijl',
  'Dot': 'Stip',
  'Your bike’s icon': 'Icoon van je fiets',
  'App icon': 'App-icoon',
  'Wheel': 'Wiel',
  'Winding path': 'Kronkelpad',
  'Leaf': 'Blad',
  'Used for the browser tab and when you add Cycle Nav to your home screen (re-add it to pick up a new icon).': 'Gebruikt voor het browsertabblad en als je Cycle Nav aan je beginscherm toevoegt (voeg opnieuw toe voor een nieuw icoon).',
  'Calm light (soft colours, like Apple Maps)': 'Rustig licht (zachte kleuren, zoals Apple Kaarten)',
  'Calm dark': 'Rustig donker',
  'Calm, follows light/dark mode': 'Rustig, volgt licht/donker',
  'OpenStreetMap, dimmed for night': 'OpenStreetMap, gedimd voor de nacht',
  'CyclOSM (shows bike infrastructure)': 'CyclOSM (toont fietsinfrastructuur)',
  'Humanitarian (soft colours)': 'Humanitair (zachte kleuren)',
  'OpenTopoMap (shows hills)': 'OpenTopoMap (toont heuvels)',
  'Language': 'Taal',
  'Navigation': 'Navigatie',
  'Spoken directions': 'Gesproken aanwijzingen',
  'Announce traffic lights ahead': 'Verkeerslichten vooraf aankondigen',
  'Traffic light ahead': 'Verkeerslicht voor je',
  'bike path': 'fietspad', 'quiet street': 'rustige straat', 'shared road': 'gedeelde weg', 'busy road': 'drukke weg', 'unpaved': 'onverhard', 'walking': 'lopen',
  '{0} traffic lights': '{0} verkeerslichten', '1 traffic light': '1 verkeerslicht',
  '{0} risky crossings': '{0} risicovolle oversteken', '1 risky crossing': '1 risicovolle oversteek',
  '{0} busy road without bike lane': '{0} drukke weg zonder fietsstrook',
  // ride weather advice
  'Go now, dry all the way': 'Ga nu, droog tot aan het einde',
  'Bring a jacket – light rain around {0}': 'Neem een jas mee – lichte regen rond {0}',
  'Wait {0} min – dry from {1}': 'Wacht {0} min – droog vanaf {1}',
  "Leave now – rain arrives in {0} min, you'll just stay dry": 'Ga nu – over {0} min komt regen, je blijft net droog',
  'Rain the whole ride – rain gear needed': 'De hele rit regen – regenkleding nodig',
  'Strong headwind: +{0} min': 'Harde tegenwind: +{0} min',
  '{0}° – wear gloves': '{0}° – trek handschoenen aan',
  'Dry for the next hour': 'Het blijft het komende uur droog',
  'Rain in {0} min, for about {1} min': 'Over {0} min regen, ongeveer {1} min lang',
  'Raining now, dry from {0}': 'Het regent nu, droog vanaf {0}',
  'Raining for the next two hours': 'Het regent de komende twee uur',
  'Ride weather advice': 'Weeradvies voor je rit',
  'Rain forecast, next 90 min': 'Regenverwachting, komende 90 min',
  'dry': 'droog',
  'now': 'nu', 'go': 'vertrek',
  'Wind {0} Bft': 'Wind {0} Bft',
  'Close': 'Sluiten',
  'Colour legend': 'Kleurenlegenda', 'Route colours': 'Routekleuren',
  'Bike path (separate from cars)': "Fietspad (gescheiden van auto's)", 'Quiet street or bike lane': 'Rustige straat of fietsstrook',
  'Shared road, 31-50 km/h': 'Gedeelde weg, 31-50 km/u', 'Busy road, no bike lane': 'Drukke weg, geen fietsstrook',
  'Unpaved surface': 'Onverhard', 'Walk your bike': 'Fiets aan de hand',
  'Traffic light': 'Verkeerslicht', 'Risky crossing (busy road, no lights)': 'Risicovolle oversteek (drukke weg, geen verkeerslicht)',
  'Map while navigating': 'Kaart tijdens navigeren',
  '3D view': '3D-weergave',
  '3D buildings and view': '3D-gebouwen en -weergave',
  '3D view: on': '3D-weergave: aan',
  '3D view: off': '3D-weergave: uit',
  'Slide to unlock': 'Schuif om te ontgrendelen',
  'Screen locked': 'Scherm vergrendeld',
  'Full screen': 'Volledig scherm',
  'For full screen: tap Share, then “Add to Home Screen”': 'Voor volledig scherm: tik op Delen en dan “Zet op beginscherm”',
  'Lock screen': 'Scherm vergrendelen',
  'Demo mode (simulate riding the route)': 'Demomodus (rit over de route simuleren)',
  'Demo mode lets you try navigation at your desk. Simulated rides can still be saved, so discard them.': 'Met demomodus probeer je navigatie achter je bureau. Gesimuleerde ritten kun je opslaan, dus gooi ze weg.',
  'Your data': 'Je gegevens',
  'Bikes, settings and rides are stored only on this device.': 'Fietsen, instellingen en ritten worden alleen op dit apparaat bewaard.',
  'Export backup': 'Back-up exporteren',
  'Restore backup': 'Back-up terugzetten',
  'About': 'Over',
  'Map data © OpenStreetMap contributors. Routing by BRouter with a custom “calm” profile that prefers bike paths and straightforward roads and penalises turns and residential shortcuts. Search by Photon.': 'Kaartgegevens © OpenStreetMap-bijdragers. Routes via BRouter met een eigen „rustig” profiel dat fietspaden en rechte wegen verkiest en afslagen en sluiproutes door woonwijken vermijdt. Zoeken via Photon.',
  'Could not export the backup': 'Kon de back-up niet exporteren',
  'Restore {0} bikes and {1} rides? This replaces what’s on this device.': '{0} fietsen en {1} ritten terugzetten? Dit vervangt wat op dit apparaat staat.',
  'Backup restored': 'Back-up teruggezet',
  'That file is not a Cycle Nav backup': 'Dat bestand is geen Cycle Nav-back-up',
};

const DICTS = { nl: NL };

export function language() {
  const l = store.get().lang;
  if (l && LANGUAGES[l]) return l;
  return (navigator.language || 'en').toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

const dict = () => DICTS[language()] || null;

// t('Following {0} ({1})', name, dist)
export function t(text, ...args) {
  const out = dict()?.[text] ?? text;
  return args.length ? out.replace(/\{(\d)\}/g, (_, i) => args[i] ?? '') : out;
}

export const speechLang = () => ({ nl: 'nl-NL' })[language()] || 'en-US';

// ---- translate fixed text as it appears on screen

const ATTRS = ['placeholder', 'title', 'aria-label'];

// Units inside longer text ("17.0 km/h · Calm").
const UNITS = { nl: [[/(\d) km\/h\b/g, '$1 km/u']] };

function translateText(node, d) {
  if (node.parentElement?.closest('.selectable, script, style')) return;
  const raw = node.nodeValue;
  const key = raw.trim();
  if (!key) return;
  // Only write when something changes: a write is itself a change the observer sees.
  if (key in d) { if (d[key] !== key) node.nodeValue = raw.replace(key, d[key]); return; }
  let out = raw;
  for (const [re, to] of UNITS[language()] || []) out = out.replace(re, to);
  if (out !== raw) node.nodeValue = out;
}

function translateTree(root, d) {
  if (root.nodeType === Node.TEXT_NODE) { translateText(root, d); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const els = [root, ...root.querySelectorAll('*')];
  for (const el of els) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && v in d && d[v] !== v) el.setAttribute(a, d[v]);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) translateText(n, d);
}

export function startTranslating() {
  const d = dict();
  document.documentElement.lang = language();
  if (!d) return;
  translateTree(document.body, d);
  new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'characterData') translateText(r.target, d);
      else if (r.type === 'attributes') { const v = r.target.getAttribute(r.attributeName); if (v && v in d && d[v] !== v) r.target.setAttribute(r.attributeName, d[v]); }
      else r.addedNodes.forEach(n => translateTree(n, d));
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
