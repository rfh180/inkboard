/**
 * InkBoard (full web version) - backend
 * Runs free as a Google Apps Script web app. The board's screen (index.html)
 * talks to this file. Everything you change on the board's Settings screens
 * is saved here, in your Google account.
 *
 * You only need to edit KEY below. Everything else is set from the board.
 *
 * After changing this file:
 *   Deploy -> Manage deployments -> pencil icon -> Version: New version -> Deploy
 */

// A long made-up password. The board asks for it once, the first time it opens.
var KEY = 'change-me';

// =====================================================================
//  DEFAULT SETTINGS (used until you change them on the board)
// =====================================================================
var DEFAULTS = {
  name: 'InkBoard',
  views: ['home', 'calendar', 'todo'],       // up to 5, first one is home
  comboDesign: 'classic',                    // (older versions only)
  homeMinutes: 3,                            // minutes untouched before going home / rotating
  idleMode: 'home',                          // home | rotate | stay
  rotateMinutes: 2,
  homeList: '',                              // list on Home: '' = first shown list, a list id, or 'all'
  todoLists: [],                             // up to 3 list ids for the To-do view ([] = first 3 shown)
  nightDesign: 'big',                        // big | panel
  cdLayout: 'fib',                           // countdown layout: fib | halves | puzzle
  unit: 'fahrenheit',
  lat: 40.7128, lon: -74.006, place: 'New York, NY',
  calendars: {},                             // google calendar id -> { show: true/false }
  ics: [],                                   // [{ id, name, url, kind: 'outlook'|'icloud'|'other', show }]
  defaultCal: '',
  calDays: 5,
  lists: {},                                 // task list id -> { show: true/false }
  listOrder: [],
  keepDoneHours: 24,
  pf: { left: { name: 'Me', cals: [], lists: [] }, right: { name: 'Family', cals: [], lists: [] } },
  countdowns: [],                            // [{ key, title, day, start }]
  countdownOff: [],                          // keys of #countdown events switched off
  photoMinutes: 2,
  dotSize: 'medium',                         // fine | medium | bold
  sleepNight: 'dark',                        // dark | photos
  passcode: ''
};

// =====================================================================
//  ENTRY POINTS
// =====================================================================
// Opening the web app URL directly shows the board inside Google's page (handy for testing).
function doGet(e) {
  var page;
  try { page = HtmlService.createHtmlOutputFromFile('Index'); }
  catch (err) {
    return HtmlService.createHtmlOutput('<div style="font:20px -apple-system,Helvetica,Arial,sans-serif;padding:40px">' +
      '<h1>InkBoard backend is running</h1><p>Open the board from its GitHub Pages link.</p></div>').setTitle('InkBoard');
  }
  return page
    .setTitle('InkBoard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// The board on GitHub Pages (or anywhere else) sends POST requests here.
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  var out = api(body.key, body.action, body.args || []);
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// One door for every request. Also called directly when the board runs inside Google's page.
function api(key, action, args) {
  try {
    if (KEY === 'change-me') throw new Error('Set your own KEY at the top of Code.gs, then deploy a new version.');
    if (key !== KEY) throw new Error('Wrong key');
    var fn = ACTIONS[action];
    if (!fn) throw new Error('Unknown action: ' + action);
    return { ok: true, data: fn.apply(null, args || []) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

var ACTIONS = {
  'board': boardData_,
  'saveSettings': saveSettings_,
  'calendars': calendarList_,
  'upcoming': upcoming_,
  'geocode': geocode_,
  'task.toggle': taskToggle_,
  'task.add': taskAdd_,
  'task.update': taskUpdate_,
  'task.move': taskMove_,
  'task.delete': taskDelete_,
  'list.add': listAdd_,
  'list.rename': listRename_,
  'list.delete': listDelete_,
  'event.add': eventAdd_,
  'event.update': eventUpdate_,
  'event.delete': eventDelete_
};

// Run this once from the editor: it approves access and checks everything works.
function setup() {
  CalendarApp.getDefaultCalendar().getName();
  var lists = Tasks.Tasklists.list({ maxResults: 100 });
  Logger.log('Task lists found: ' + (lists.items || []).map(function (l) { return l.title; }).join(', '));
  UrlFetchApp.fetch('https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m');
  getSettings_();
  Logger.log('All set. Calendar, Tasks and weather access are approved.');
}

// =====================================================================
//  SETTINGS
// =====================================================================
function getSettings_() {
  var raw = PropertiesService.getScriptProperties().getProperty('settings');
  var s = {};
  try { s = raw ? JSON.parse(raw) : {}; } catch (e) { s = {}; }
  var out = JSON.parse(JSON.stringify(DEFAULTS));
  Object.keys(s).forEach(function (k) { out[k] = s[k]; });
  return out;
}

function saveSettings_(patch) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var s = getSettings_();
    Object.keys(patch || {}).forEach(function (k) { if (k in DEFAULTS) s[k] = patch[k]; });
    var today = todayKey_();
    s.countdowns = (s.countdowns || []).filter(function (c) { return c.day >= today; }).slice(0, 30);
    s.countdownOff = (s.countdownOff || []).slice(-60);
    if (s.views.length > 5) s.views = s.views.slice(0, 5);
    if (!s.views.length) s.views = ['home'];
    s.todoLists = (s.todoLists || []).slice(0, 3);
    PropertiesService.getScriptProperties().setProperty('settings', JSON.stringify(s));
    return s;
  } finally {
    lock.releaseLock();
  }
}

// =====================================================================
//  BOARD DATA
// =====================================================================
function boardData_() {
  var s = getSettings_();
  var tz = tz_();
  var today = todayKey_();
  var tdn = keyToDn_(today);
  var first = fromDn_(tdn); first = dn_(first.y, first.m, 1);
  var gridStart = first - ((fromDn_(first).wd + 6) % 7);           // Monday on/before the 1st
  var startDn = Math.min(gridStart, tdn - ((fromDn_(tdn).wd + 6) % 7));
  var endDn = Math.max(tdn + 42, gridStart + 42);
  var winStart = dnToEpoch_(startDn, tz), winEnd = dnToEpoch_(endDn, tz);
  var warnings = [];

  // Calendars
  var cals = calendarList_(s);
  pfDefaults_(s, cals);
  var wanted = {};
  cals.forEach(function (c) { if (c.show) wanted[c.id] = true; });
  ['left', 'right'].forEach(function (side) { (s.pf[side].cals || []).forEach(function (id) { wanted[id] = true; }); });

  var events = [], tagged = [];
  cals.forEach(function (c) {
    if (!wanted[c.id]) return;
    try {
      if (c.type === 'google') {
        var cal = CalendarApp.getCalendarById(c.id);
        if (!cal) throw new Error('missing');
        cal.getEvents(new Date(winStart), new Date(winEnd)).forEach(function (ev) {
          events.push(googleEvent_(ev, c, tz));
        });
        // #countdown events further ahead than the window
        cal.getEvents(new Date(winEnd), new Date(dnToEpoch_(tdn + 366, tz)), { search: '#countdown' }).forEach(function (ev) {
          tagged.push(googleEvent_(ev, c, tz));
        });
      } else {
        var text = fetchIcs_(c.url);
        icsEvents_(text, winStart, winEnd, tz).forEach(function (ev) { events.push(icsEvent_(ev, c)); });
        icsEvents_(text, winEnd, dnToEpoch_(tdn + 366, tz), tz, function (e) {
          return /#countdown/i.test(e.title + ' ' + e.notes);
        }).forEach(function (ev) { tagged.push(icsEvent_(ev, c)); });
      }
    } catch (err) {
      warnings.push(c.name + ' could not load');
    }
  });

  // Tasks
  var lists = [], tasks = {};
  try {
    lists = taskLists_(s);
    var wantList = {};
    lists.forEach(function (l) { if (l.show) wantList[l.id] = true; });
    ['left', 'right'].forEach(function (side) { (s.pf[side].lists || []).forEach(function (id) { wantList[id] = true; }); });
    lists.forEach(function (l) { if (wantList[l.id]) tasks[l.id] = taskItems_(l.id, s); });
  } catch (err) {
    warnings.push('Google Tasks could not load');
  }

  // Weather
  var weather = null;
  try { weather = weatherData_(s); } catch (err) { warnings.push('Weather could not load'); }

  return {
    settings: s,
    calendars: cals,
    events: events,
    lists: lists,
    tasks: tasks,
    countdowns: countdowns_(s, events.concat(tagged), today),
    weather: weather,
    warnings: warnings,
    today: today,
    range: [keyOf_(fromDn_(startDn)), keyOf_(fromDn_(endDn))],
    updated: Date.now()
  };
}

// Until Personal + Family is set up, start with sensible picks (not saved until changed).
function pfDefaults_(s, cals) {
  var L = s.pf.left, R = s.pf.right;
  if ((L.cals || []).length || (L.lists || []).length || (R.cals || []).length || (R.lists || []).length) return;
  var lists = [];
  try { lists = taskLists_(s).filter(function (l) { return l.show; }); } catch (e) {}
  var primary = cals.filter(function (c) { return c.primary; })[0];
  L.cals = primary ? [primary.id] : [];
  R.cals = cals.filter(function (c) { return !c.primary && c.show; }).map(function (c) { return c.id; });
  if (!R.cals.length) R.cals = cals.filter(function (c) { return !c.primary && c.type === 'google' && c.writable; }).map(function (c) { return c.id; }).slice(0, 1);
  L.lists = lists.slice(0, 1).map(function (l) { return l.id; });
  R.lists = lists.slice(1, 3).map(function (l) { return l.id; });
}

function googleEvent_(ev, c, tz) {
  var title = ev.getTitle() || '(No title)', notes = '';
  try { notes = (ev.getDescription() || '').replace(/<[^>]+>/g, ' ').substr(0, 500); } catch (e) {}
  var o = {
    calId: c.id, title: stripTag_(title), location: ev.getLocation() || '', notes: stripTag_(notes),
    tagged: /#countdown/i.test(title + ' ' + notes), recurring: ev.isRecurringEvent(),
    editable: c.writable && !ev.isRecurringEvent(), allDay: ev.isAllDayEvent()
  };
  if (o.allDay) {
    o.startKey = Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd');
    o.endKey = Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd');
    if (o.endKey <= o.startKey) o.endKey = keyOf_(fromDn_(keyToDn_(o.startKey) + 1));
    o.key = 'g|' + c.id + '|' + ev.getId() + (o.recurring ? '|' + o.startKey : '');
  } else {
    o.start = ev.getStartTime().getTime();
    o.end = ev.getEndTime().getTime();
    o.key = 'g|' + c.id + '|' + ev.getId() + (o.recurring ? '|' + o.start : '');
  }
  return o;
}

function icsEvent_(ev, c) {
  var o = {
    calId: c.id, title: stripTag_(ev.title), location: ev.location || '', notes: stripTag_(ev.notes || ''),
    tagged: /#countdown/i.test(ev.title + ' ' + ev.notes), recurring: ev.recurring, editable: false, allDay: ev.allDay
  };
  if (ev.allDay) { o.startKey = ev.startKey; o.endKey = ev.endKey; }
  else { o.start = ev.start; o.end = ev.end; }
  o.key = 'i|' + c.id + '|' + ev.uid + '|' + (ev.allDay ? ev.startKey : ev.start);
  return o;
}

function stripTag_(s) {
  return String(s || '').replace(/\s*#countdown\b/gi, '').trim();
}

function countdowns_(s, events, today) {
  var off = {};
  (s.countdownOff || []).forEach(function (k) { off[k] = true; });
  var seen = {}, out = [];
  (s.countdowns || []).forEach(function (c) {
    if (c.day >= today && !seen[c.key]) { seen[c.key] = true; out.push(c); }
  });
  var tz = tz_();
  events.forEach(function (e) {
    if (!e.tagged || off[e.key] || seen[e.key]) return;
    var day = e.allDay ? e.startKey : Utilities.formatDate(new Date(e.start), tz, 'yyyy-MM-dd');
    if (day < today) return;
    seen[e.key] = true;
    out.push({ key: e.key, title: e.title, day: day, start: e.allDay ? null : e.start, tagged: true });
  });
  out.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : (a.start || 0) - (b.start || 0); });
  return out;
}

// =====================================================================
//  CALENDARS
// =====================================================================
function calendarList_(s) {
  s = s || getSettings_();
  var out = [];
  var owned = {};
  CalendarApp.getAllOwnedCalendars().forEach(function (c) { owned[c.getId()] = true; });
  var primary = CalendarApp.getDefaultCalendar().getId();
  CalendarApp.getAllCalendars().forEach(function (c) {
    var id = c.getId();
    var pref = s.calendars[id];
    out.push({
      id: id, name: c.getName(), type: 'google', writable: !!owned[id],
      show: pref ? !!pref.show : id === primary, primary: id === primary
    });
  });
  out.sort(function (a, b) { return (b.primary ? 1 : 0) - (a.primary ? 1 : 0); });
  (s.ics || []).forEach(function (c) {
    out.push({ id: c.id, name: c.name, type: 'ics', kind: c.kind || 'other', url: c.url, writable: false, show: c.show !== false });
  });
  out.forEach(function (c, i) { c.marker = i; });
  var def = s.defaultCal && owned[s.defaultCal] ? s.defaultCal : primary;
  out.forEach(function (c) { c.isDefault = c.id === def; });
  return out;
}

function fetchIcs_(url) {
  url = String(url).replace(/^webcal:\/\//i, 'https://');
  var cache = CacheService.getScriptCache();
  var ck = 'ics_' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, url));
  var hit = cache.get(ck);
  if (hit) return hit;
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
  var text = res.getContentText();
  if (text.indexOf('BEGIN:VCALENDAR') < 0) throw new Error('Not a calendar');
  if (text.length < 95000) cache.put(ck, text, 4 * 60);
  return text;
}

// Every upcoming event in the next year, repeating events shown once (for Settings -> Countdowns).
function upcoming_() {
  var s = getSettings_(), tz = tz_(), today = todayKey_(), tdn = keyToDn_(today);
  var a = dnToEpoch_(tdn, tz), b = dnToEpoch_(tdn + 366, tz);
  var out = [], series = {};
  calendarList_(s).forEach(function (c) {
    if (!c.show) return;
    try {
      var evs = [];
      if (c.type === 'google') {
        CalendarApp.getCalendarById(c.id).getEvents(new Date(a), new Date(b)).forEach(function (ev) {
          var o = googleEvent_(ev, c, tz);
          o.series = ev.isRecurringEvent() ? 'g' + ev.getId() : o.key;
          evs.push(o);
        });
      } else {
        icsEvents_(fetchIcs_(c.url), a, b, tz).forEach(function (ev) {
          var o = icsEvent_(ev, c);
          o.series = ev.recurring ? 'i' + c.id + ev.uid : o.key;
          evs.push(o);
        });
      }
      evs.forEach(function (o) {
        if (series[o.series]) return;
        series[o.series] = true;
        out.push({
          key: o.key, title: o.title, tagged: o.tagged, recurring: o.recurring, calId: c.id,
          day: o.allDay ? o.startKey : Utilities.formatDate(new Date(o.start), tz, 'yyyy-MM-dd'),
          start: o.allDay ? null : o.start
        });
      });
    } catch (err) {}
  });
  out.sort(function (x, y) { return x.day < y.day ? -1 : x.day > y.day ? 1 : (x.start || 0) - (y.start || 0); });
  return out.slice(0, 250);
}

function eventFromKey_(key) {
  var p = String(key).split('|');
  if (p[0] !== 'g') throw new Error('Outlook and iCloud events are view-only. Change them in Outlook or iCloud.');
  var cal = CalendarApp.getCalendarById(p[1]);
  if (!cal) throw new Error('Calendar not found');
  var ev = cal.getEventById(p[2]);
  if (!ev) throw new Error('Event not found');
  if (ev.isRecurringEvent()) throw new Error('Repeating events can only be changed in Google Calendar.');
  return { cal: cal, ev: ev };
}

function dayToDate_(day, hm) {
  var p = day.split('-'), t = (hm || '12:00').split(':');
  return new Date(wallToEpoch_(+p[0], +p[1] - 1, +p[2], +t[0], +t[1], 0, tz_()));
}

// f = { calId, title, allDay, day, endDay, startTime, endTime, location, notes, countdown }
function eventAdd_(f) {
  var s = getSettings_();
  var calId = f.calId || calendarList_(s).filter(function (c) { return c.isDefault; })[0].id;
  var cal = CalendarApp.getCalendarById(calId);
  if (!cal) throw new Error('Calendar not found');
  var title = String(f.title || '').trim().substr(0, 200);
  if (!title) throw new Error('Add a title');
  var opts = { location: f.location || '', description: f.notes || '' };
  var ev;
  if (f.allDay) {
    var endDay = f.endDay && f.endDay > f.day ? f.endDay : null;
    ev = endDay ? cal.createAllDayEvent(title, dayToDate_(f.day), dayToDate_(keyOf_(fromDn_(keyToDn_(endDay) + 1))), opts)
      : cal.createAllDayEvent(title, dayToDate_(f.day), opts);
  } else {
    var st = dayToDate_(f.day, f.startTime), en = dayToDate_(f.day, f.endTime || f.startTime);
    if (en.getTime() <= st.getTime()) en = new Date(st.getTime() + 3600000);
    ev = cal.createEvent(title, st, en, opts);
  }
  var c = { id: calId, writable: true };
  var o = googleEvent_(ev, c, tz_());
  if (f.countdown) {
    s.countdowns.push({ key: o.key, title: o.title, day: f.day, start: o.allDay ? null : o.start });
    saveSettings_({ countdowns: s.countdowns });
  }
  return o;
}

function eventUpdate_(key, f) {
  var r = eventFromKey_(key), ev = r.ev;
  if (f.title !== undefined) ev.setTitle(String(f.title).trim().substr(0, 200) || '(No title)');
  if (f.location !== undefined) ev.setLocation(f.location);
  if (f.notes !== undefined) ev.setDescription(f.notes);
  if (f.day) {
    if (f.allDay) {
      if (f.endDay && f.endDay > f.day) ev.setAllDayDates(dayToDate_(f.day), dayToDate_(keyOf_(fromDn_(keyToDn_(f.endDay) + 1))));
      else ev.setAllDayDate(dayToDate_(f.day));
    } else {
      var st = dayToDate_(f.day, f.startTime), en = dayToDate_(f.day, f.endTime || f.startTime);
      if (en.getTime() <= st.getTime()) en = new Date(st.getTime() + 3600000);
      ev.setTime(st, en);
    }
  }
  var s = getSettings_(), o = googleEvent_(ev, { id: r.cal.getId(), writable: true }, tz_()), changed = false;
  s.countdowns.forEach(function (c) {
    if (c.key !== key) return;
    c.title = o.title; c.day = f.day || c.day; c.start = o.allDay ? null : o.start; changed = true;
  });
  if (changed) saveSettings_({ countdowns: s.countdowns });
  return true;
}

function eventDelete_(key) {
  eventFromKey_(key).ev.deleteEvent();
  var s = getSettings_();
  saveSettings_({ countdowns: s.countdowns.filter(function (c) { return c.key !== key; }) });
  return true;
}

// =====================================================================
//  TASKS (Google Tasks)
// =====================================================================
function taskLists_(s) {
  var res = Tasks.Tasklists.list({ maxResults: 100 });
  var lists = (res.items || []).map(function (l, i) {
    var pref = s.lists[l.id];
    return { id: l.id, title: l.title, show: pref ? !!pref.show : i < 3 };
  });
  var order = s.listOrder || [];
  lists.forEach(function (l, i) { var k = order.indexOf(l.id); l.sort = k < 0 ? 1000 + i : k; });
  lists.sort(function (a, b) { return a.sort - b.sort; });
  lists.forEach(function (l) { delete l.sort; });
  return lists;
}

function taskItems_(listId, s) {
  var all = [], pageToken = null;
  do {
    var res = Tasks.Tasks.list(listId, { showCompleted: true, showHidden: true, maxResults: 100, pageToken: pageToken });
    (res.items || []).forEach(function (t) { all.push(t); });
    pageToken = res.nextPageToken;
  } while (pageToken && all.length < 400);
  var cutoff = Date.now() - (s.keepDoneHours || 24) * 3600000;
  var open = [], done = [];
  all.forEach(function (t) {
    if (t.parent || t.deleted || !t.title) return;
    var item = { id: t.id, title: t.title, done: t.status === 'completed', due: t.due ? t.due.substr(0, 10) : '', notes: t.notes || '' };
    if (item.done) {
      var c = t.completed ? new Date(t.completed).getTime() : 0;
      if (c >= cutoff) { item.completed = c; done.push(item); }
    } else {
      item.position = t.position || '';
      open.push(item);
    }
  });
  open.sort(function (a, b) { return a.position < b.position ? -1 : a.position > b.position ? 1 : 0; });
  done.sort(function (a, b) { return b.completed - a.completed; });
  return open.concat(done);
}

function dueValue_(day) { return day ? day + 'T00:00:00.000Z' : null; }

function taskToggle_(listId, id, done) {
  Tasks.Tasks.patch(done ? { status: 'completed' } : { status: 'needsAction', completed: null }, listId, id);
  return true;
}

function taskAdd_(listId, title, due) {
  title = String(title || '').trim().substr(0, 300);
  if (!title) throw new Error('Empty task');
  var t = { title: title };
  if (due) t.due = dueValue_(due);
  return Tasks.Tasks.insert(t, listId).id;
}

function taskUpdate_(listId, id, f) {
  var patch = {};
  if (f.title !== undefined) patch.title = String(f.title).trim().substr(0, 300) || '(untitled)';
  if (f.due !== undefined) patch.due = dueValue_(f.due);
  Tasks.Tasks.patch(patch, listId, id);
  return true;
}

function taskMove_(fromList, id, toList) {
  if (fromList === toList) return true;
  var t = Tasks.Tasks.get(fromList, id);
  var copy = { title: t.title, notes: t.notes, due: t.due, status: t.status, completed: t.completed };
  Tasks.Tasks.insert(copy, toList);
  Tasks.Tasks.remove(fromList, id);
  return true;
}

function taskDelete_(listId, id) { Tasks.Tasks.remove(listId, id); return true; }

function listAdd_(title) {
  title = String(title || '').trim().substr(0, 100);
  if (!title) throw new Error('Name the list');
  var l = Tasks.Tasklists.insert({ title: title });
  var s = getSettings_();
  s.lists[l.id] = { show: true };
  if (!s.listOrder.length) s.listOrder = taskLists_(s).map(function (x) { return x.id; }).filter(function (x) { return x !== l.id; });
  s.listOrder.push(l.id);
  saveSettings_({ lists: s.lists, listOrder: s.listOrder });
  return l.id;
}

function listRename_(id, title) {
  title = String(title || '').trim().substr(0, 100);
  if (!title) throw new Error('Name the list');
  Tasks.Tasklists.patch({ title: title }, id);
  return true;
}

function listDelete_(id) {
  Tasks.Tasklists.remove(id);
  var s = getSettings_();
  delete s.lists[id];
  ['left', 'right'].forEach(function (side) { s.pf[side].lists = (s.pf[side].lists || []).filter(function (x) { return x !== id; }); });
  saveSettings_({ lists: s.lists, listOrder: s.listOrder.filter(function (x) { return x !== id; }), pf: s.pf });
  return true;
}

// =====================================================================
//  WEATHER + PLACES (Open-Meteo, free, no key)
// =====================================================================
function weatherData_(s) {
  var ck = 'wx_' + s.lat + '_' + s.lon + '_' + s.unit;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + s.lat + '&longitude=' + s.lon +
    '&current=temperature_2m,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&temperature_unit=' + s.unit + '&timezone=auto&forecast_days=8';
  var j = JSON.parse(UrlFetchApp.fetch(url).getContentText());
  var days = [];
  for (var i = 0; i < j.daily.time.length; i++) {
    days.push({
      day: j.daily.time[i],
      hi: Math.round(j.daily.temperature_2m_max[i]), lo: Math.round(j.daily.temperature_2m_min[i]),
      rain: j.daily.precipitation_probability_max ? j.daily.precipitation_probability_max[i] : null,
      text: wxText_(j.daily.weather_code[i]), icon: wxIcon_(j.daily.weather_code[i])
    });
  }
  var out = {
    temp: Math.round(j.current.temperature_2m), text: wxText_(j.current.weather_code),
    icon: wxIcon_(j.current.weather_code), unit: s.unit === 'celsius' ? 'C' : 'F', days: days
  };
  cache.put(ck, JSON.stringify(out), 20 * 60);
  return out;
}

function wxText_(c) {
  if (c === 0) return 'Clear';
  if (c <= 2) return 'Partly cloudy';
  if (c === 3) return 'Cloudy';
  if (c <= 48) return 'Fog';
  if (c <= 57) return 'Drizzle';
  if (c <= 67) return 'Rain';
  if (c <= 77) return 'Snow';
  if (c <= 82) return 'Showers';
  if (c <= 86) return 'Snow showers';
  return 'Thunderstorm';
}

function wxIcon_(c) {
  if (c === 0) return 'sun';
  if (c <= 2) return 'partly';
  if (c <= 48) return 'cloud';
  if (c <= 67 || (c >= 80 && c <= 82)) return 'rain';
  if (c <= 86) return 'snow';
  return 'storm';
}

function geocode_(q) {
  q = String(q || '').trim();
  if (q.length < 2) return [];
  var j = JSON.parse(UrlFetchApp.fetch('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=' +
    encodeURIComponent(q)).getContentText());
  return (j.results || []).map(function (r) {
    return { name: [r.name, r.admin1, r.country_code === 'US' ? '' : r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude };
  });
}

// =====================================================================
//  SMALL HELPERS
// =====================================================================
function todayKey_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function dnToEpoch_(n, tz) { var f = fromDn_(n); return wallToEpoch_(f.y, f.m, f.d, 0, 0, 0, tz); }

// =====================================================================
//  .ICS PARSER with repeating events
// =====================================================================
function icsEvents_(text, winStart, winEnd, scriptTz, filter) {
  var lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  var raw = [], cur = null, depth = 0;
  lines.forEach(function (line) {
    if (line === 'BEGIN:VEVENT') { cur = { props: {} }; depth = 0; return; }
    if (!cur) return;
    if (/^BEGIN:/.test(line)) { depth++; return; }     // e.g. VALARM inside an event
    if (/^END:/.test(line) && line !== 'END:VEVENT') { depth--; return; }
    if (line === 'END:VEVENT') { raw.push(cur); cur = null; return; }
    if (depth > 0) return;
    var p = parseLine_(line);
    if (!p) return;
    (cur.props[p.name] = cur.props[p.name] || []).push(p);
  });

  var evs = raw.map(function (r) { return buildEvent_(r.props, scriptTz); }).filter(function (e) { return e && e.start; });
  if (filter) evs = evs.filter(filter);

  // Moved or cancelled single occurrences of a repeating event
  var overrides = {};
  evs.forEach(function (e) { if (e.recurrenceId) overrides[e.uid + '|' + e.recurrenceId] = true; });

  var out = [];
  var winStartDn = epochToDn_(winStart, scriptTz) - 1, winEndDn = epochToDn_(winEnd, scriptTz) + 1;
  evs.forEach(function (e) {
    if (e.cancelled) return;
    if (!e.rrule || e.recurrenceId) {
      pushOcc_(out, e, e.start, winStart, winEnd, winStartDn, winEndDn);
      return;
    }
    expandRule_(e, winStart, winEnd, winStartDn, winEndDn, overrides).forEach(function (occ) {
      pushOcc_(out, e, occ, winStart, winEnd, winStartDn, winEndDn);
    });
  });
  return out;
}

function pushOcc_(out, e, st, winStart, winEnd, winStartDn, winEndDn) {
  if (e.allDay) {
    var a = st.dn, b = a + e.durDays;
    if (b <= winStartDn || a >= winEndDn) return;
    out.push({ uid: e.uid, title: e.title, location: e.location, notes: e.notes, recurring: !!e.rrule || !!e.recurrenceId, allDay: true, startKey: keyOf_(fromDn_(a)), endKey: keyOf_(fromDn_(b)) });
  } else {
    var s = st.epoch, en = s + e.durMs;
    if (en <= winStart || s >= winEnd) return;
    if (en === s && s < winStart) return;
    out.push({ uid: e.uid, title: e.title, location: e.location, notes: e.notes, recurring: !!e.rrule || !!e.recurrenceId, allDay: false, start: s, end: en });
  }
}

function parseLine_(line) {
  // NAME;PARAM=VAL;PARAM="quoted:val":VALUE
  var i = 0, inQ = false;
  for (; i < line.length; i++) {
    var ch = line.charAt(i);
    if (ch === '"') inQ = !inQ;
    else if (ch === ':' && !inQ) break;
  }
  if (i >= line.length) return null;
  var head = line.substring(0, i), value = line.substring(i + 1);
  var parts = head.match(/("[^"]*"|[^;])+/g) || [head];
  var name = parts[0].toUpperCase(), params = {};
  for (var k = 1; k < parts.length; k++) {
    var eq = parts[k].indexOf('=');
    if (eq > 0) params[parts[k].substring(0, eq).toUpperCase()] = parts[k].substring(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name, params: params, value: value };
}

function unescapeText_(s) {
  return String(s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

function buildEvent_(props, scriptTz) {
  function one(n) { return props[n] ? props[n][0] : null; }
  var ds = one('DTSTART');
  if (!ds) return null;
  var start = parseIcsDate_(ds, scriptTz);
  if (!start) return null;
  var e = {
    uid: one('UID') ? one('UID').value : Math.random().toString(),
    title: unescapeText_(one('SUMMARY') ? one('SUMMARY').value : '(No title)'),
    location: unescapeText_(one('LOCATION') ? one('LOCATION').value : ''),
    notes: unescapeText_(one('DESCRIPTION') ? one('DESCRIPTION').value : '').substr(0, 500),
    cancelled: one('STATUS') && one('STATUS').value.toUpperCase() === 'CANCELLED',
    allDay: start.allDay,
    start: start,
    tz: start.tz
  };
  var de = one('DTEND'), du = one('DURATION');
  if (e.allDay) {
    var endD = de ? parseIcsDate_(de, scriptTz) : null;
    e.durDays = endD && endD.allDay ? Math.max(1, endD.dn - start.dn) :
      du ? Math.max(1, Math.round(parseDuration_(du.value) / 864e5)) : 1;
  } else {
    var endT = de ? parseIcsDate_(de, scriptTz) : null;
    e.durMs = endT && !endT.allDay ? Math.max(0, endT.epoch - start.epoch) : du ? parseDuration_(du.value) : 0;
  }
  if (one('RRULE')) e.rrule = parseRrule_(one('RRULE').value, start, scriptTz);
  e.exdates = {};
  (props.EXDATE || []).forEach(function (p) {
    p.value.split(',').forEach(function (v) {
      var d = parseIcsDate_({ params: p.params, value: v }, scriptTz);
      if (d) e.exdates[d.allDay ? 'd' + d.dn : 'd' + epochToDn_(d.epoch, e.tz) + 't' + d.epoch] = true;
    });
  });
  var rid = one('RECURRENCE-ID');
  if (rid) {
    var r = parseIcsDate_(rid, scriptTz);
    if (r) e.recurrenceId = r.allDay ? 'd' + r.dn : String(r.epoch);
  }
  return e;
}

// Returns {allDay, dn, y, m, d, h, mi, s, tz, epoch}
function parseIcsDate_(p, scriptTz) {
  var v = String(p.value).trim();
  var m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z?))?$/);
  if (!m) return null;
  var y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (m[4] === undefined || (p.params && p.params.VALUE === 'DATE')) {
    return { allDay: true, y: y, m: mo, d: d, dn: dn_(y, mo, d) };
  }
  var h = +m[4], mi = +m[5], s = +(m[6] || 0);
  if (m[7] === 'Z') {
    return { allDay: false, y: y, m: mo, d: d, h: h, mi: mi, s: s, tz: 'UTC', epoch: Date.UTC(y, mo, d, h, mi, s) };
  }
  var tz = ianaTz_(p.params && p.params.TZID, scriptTz);
  return { allDay: false, y: y, m: mo, d: d, h: h, mi: mi, s: s, tz: tz, epoch: wallToEpoch_(y, mo, d, h, mi, s, tz) };
}

function parseDuration_(v) {
  var m = String(v).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  var ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

var WD_ = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule_(v, start, scriptTz) {
  var r = { interval: 1, wkst: 1 };
  v.split(';').forEach(function (kv) {
    var p = kv.split('='), k = (p[0] || '').toUpperCase(), val = p[1] || '';
    if (k === 'FREQ') r.freq = val.toUpperCase();
    else if (k === 'INTERVAL') r.interval = Math.max(1, +val || 1);
    else if (k === 'COUNT') r.count = +val;
    else if (k === 'UNTIL') {
      var u = parseIcsDate_({ params: {}, value: val }, scriptTz);
      if (u) r.until = u.allDay ? (start.allDay ? u.dn : wallToEpoch_(u.y, u.m, u.d, 23, 59, 59, start.tz)) :
        (start.allDay ? epochToDn_(u.epoch, scriptTz) : u.epoch);
    }
    else if (k === 'BYDAY') r.byday = val.split(',').map(function (x) {
      var mm = x.match(/^([+-]?\d+)?([A-Z]{2})$/i);
      return mm ? { n: mm[1] ? +mm[1] : 0, wd: WD_[mm[2].toUpperCase()] } : null;
    }).filter(Boolean);
    else if (k === 'BYMONTHDAY') r.bymonthday = val.split(',').map(Number);
    else if (k === 'BYMONTH') r.bymonth = val.split(',').map(function (x) { return +x - 1; });
    else if (k === 'BYSETPOS') r.bysetpos = val.split(',').map(Number);
    else if (k === 'WKST') r.wkst = WD_[val.toUpperCase()];
  });
  return r.freq ? r : null;
}

// Returns a list of occurrence starts ({dn} or {epoch}) that may touch the window.
function expandRule_(e, winStart, winEnd, winStartDn, winEndDn, overrides) {
  var r = e.rrule, st = e.start, out = [];
  var dn0 = st.dn !== undefined ? st.dn : dn_(st.y, st.m, st.d);
  var count = 0, guard = 0;

  function monthDays(y, m) {
    var first = dn_(y, m, 1), len = dn_(y, m + 1, 1) - first, res = [];
    if (r.byday) {
      r.byday.forEach(function (b) {
        var all = [];
        for (var i = 0; i < len; i++) if (fromDn_(first + i).wd === b.wd) all.push(first + i);
        if (b.n > 0 && all[b.n - 1] !== undefined) res.push(all[b.n - 1]);
        else if (b.n < 0 && all[all.length + b.n] !== undefined) res.push(all[all.length + b.n]);
        else if (b.n === 0) res = res.concat(all);
      });
      if (r.bymonthday) res = res.filter(function (x) { return monthDayOk(x, first, len); });
    } else if (r.bymonthday) {
      r.bymonthday.forEach(function (md) {
        var day = md > 0 ? md : len + md + 1;
        if (day >= 1 && day <= len) res.push(first + day - 1);
      });
    } else {
      if (st.d <= len) res.push(first + st.d - 1);
    }
    return res;
  }
  function monthDayOk(x, first, len) {
    var day = x - first + 1;
    return r.bymonthday.some(function (md) { return (md > 0 ? md : len + md + 1) === day; });
  }
  function setpos(list) {
    list = uniqSort_(list);
    if (!r.bysetpos) return list;
    var res = [];
    r.bysetpos.forEach(function (p) {
      var x = p > 0 ? list[p - 1] : list[list.length + p];
      if (x !== undefined) res.push(x);
    });
    return uniqSort_(res);
  }

  for (var period = 0; guard < 20000; period++) {
    var cands = [];
    if (r.freq === 'DAILY') {
      cands = [dn0 + period * r.interval];
    } else if (r.freq === 'WEEKLY') {
      var ws = dn0 - ((fromDn_(dn0).wd - r.wkst + 7) % 7) + period * 7 * r.interval;
      var wds = r.byday ? r.byday.map(function (b) { return b.wd; }) : [fromDn_(dn0).wd];
      cands = setpos(wds.map(function (wd) { return ws + ((wd - r.wkst + 7) % 7); }));
    } else if (r.freq === 'MONTHLY') {
      var mi = st.y * 12 + st.m + period * r.interval;
      cands = setpos(monthDays(Math.floor(mi / 12), mi % 12));
    } else if (r.freq === 'YEARLY') {
      var y = st.y + period * r.interval;
      var months = r.bymonth || [st.m];
      months.forEach(function (m) { cands = cands.concat(monthDays(y, m)); });
      cands = setpos(cands);
    } else {
      break;
    }
    if (r.freq === 'DAILY' && r.byday) {
      var okWd = r.byday.map(function (b) { return b.wd; });
      cands = cands.filter(function (x) { return okWd.indexOf(fromDn_(x).wd) >= 0; });
    }
    if (r.bymonth && r.freq !== 'YEARLY') {
      cands = cands.filter(function (x) { return r.bymonth.indexOf(fromDn_(x).m) >= 0; });
    }

    var periodStart = cands.length ? cands[0] : null;
    for (var i = 0; i < cands.length; i++) {
      guard++;
      var dn = cands[i];
      if (dn < dn0) continue;
      count++;
      if (r.count && count > r.count) return out;
      if (st.allDay) {
        if (r.until !== undefined && dn > r.until) return out;
        if (dn > winEndDn) return out;
        if (e.exdates['d' + dn] || overrides[e.uid + '|d' + dn]) continue;
        if (dn + e.durDays >= winStartDn) out.push({ dn: dn });
      } else {
        if (r.until !== undefined) {
          if (r.untilDn === undefined) r.untilDn = epochToDn_(r.until, e.tz);
          if (dn > r.untilDn + 1) return out;
        }
        if (dn > winEndDn) return out;
        if (!r.count && dn < winStartDn - Math.ceil(e.durMs / 864e5) - 1) continue;   // far in the past
        var f = fromDn_(dn);
        var ep = wallToEpoch_(f.y, f.m, f.d, st.h, st.mi, st.s, e.tz);
        if (r.until !== undefined && ep > r.until) return out;
        if (overrides[e.uid + '|' + ep]) continue;
        if (isExdate_(e, dn, ep)) continue;
        out.push({ epoch: ep });
      }
    }
    if (periodStart !== null && periodStart > winEndDn) return out;
    if (period > 100000) return out;
    // Monthly/yearly periods with no matching days still advance; stop if far past the window.
    if (!cands.length) {
      var approx = r.freq === 'YEARLY' ? dn_(st.y + period * r.interval, 0, 1) :
        r.freq === 'MONTHLY' ? dn_(st.y, st.m + period * r.interval, 1) : dn0;
      if (approx > winEndDn) return out;
    }
  }
  return out;
}

function isExdate_(e, dn, ep) {
  if (e.exdates['d' + dn + 't' + ep]) return true;
  if (e.exdates['d' + dn]) return true;   // EXDATE given as a plain date
  return false;
}

function uniqSort_(a) {
  a = a.slice().sort(function (x, y) { return x - y; });
  return a.filter(function (x, i) { return i === 0 || x !== a[i - 1]; });
}

// =====================================================================
//  DATE HELPERS
// =====================================================================
function tz_() { return Session.getScriptTimeZone(); }

function dn_(y, m, d) { return Math.round(Date.UTC(y, m, d) / 864e5); }
function fromDn_(n) {
  var dt = new Date(n * 864e5);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), wd: dt.getUTCDay() };
}
function keyOf_(f) { return f.y + '-' + pad2_(f.m + 1) + '-' + pad2_(f.d); }
function keyToDn_(k) { var p = k.split('-'); return dn_(+p[0], +p[1] - 1, +p[2]); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function tzOffsetMin_(epoch, tz) {
  var z = Utilities.formatDate(new Date(epoch), tz, 'Z');   // e.g. -0500
  var sign = z.charAt(0) === '-' ? -1 : 1;
  return sign * (parseInt(z.substr(1, 2), 10) * 60 + parseInt(z.substr(3, 2), 10));
}

// Local wall-clock time in a time zone -> milliseconds since 1970
function wallToEpoch_(y, m, d, h, mi, s, tz) {
  var guess = Date.UTC(y, m, d, h, mi, s);
  var off = tzOffsetMin_(guess, tz);
  var t = guess - off * 60000;
  var off2 = tzOffsetMin_(t, tz);
  if (off2 !== off) t = guess - off2 * 60000;
  return t;
}

function epochToDn_(epoch, tz) {
  return keyToDn_(Utilities.formatDate(new Date(epoch), tz, 'yyyy-MM-dd'));
}

// Outlook uses Windows time zone names. Map them to standard ones.
var WIN_TZ_ = {
  'eastern standard time': 'America/New_York', 'us eastern standard time': 'America/Indiana/Indianapolis',
  'central standard time': 'America/Chicago', 'mountain standard time': 'America/Denver',
  'us mountain standard time': 'America/Phoenix', 'pacific standard time': 'America/Los_Angeles',
  'alaskan standard time': 'America/Anchorage', 'hawaiian standard time': 'Pacific/Honolulu',
  'atlantic standard time': 'America/Halifax', 'newfoundland standard time': 'America/St_Johns',
  'canada central standard time': 'America/Regina', 'sa pacific standard time': 'America/Bogota',
  'central standard time (mexico)': 'America/Mexico_City', 'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik', 'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest', 'romance standard time': 'Europe/Paris',
  'central european standard time': 'Europe/Warsaw', 'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev', 'gtb standard time': 'Europe/Bucharest',
  'israel standard time': 'Asia/Jerusalem', 'india standard time': 'Asia/Kolkata',
  'china standard time': 'Asia/Shanghai', 'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul', 'singapore standard time': 'Asia/Singapore',
  'aus eastern standard time': 'Australia/Sydney', 'e. australia standard time': 'Australia/Brisbane',
  'new zealand standard time': 'Pacific/Auckland', 'e. south america standard time': 'America/Sao_Paulo',
  'utc': 'UTC', 'coordinated universal time': 'UTC'
};

function ianaTz_(tzid, fallback) {
  if (!tzid) return fallback;
  var s = String(tzid).replace(/^\/+/, '').trim();
  if (/^[A-Za-z]+\/[A-Za-z_\-\/]+$/.test(s) || s === 'UTC') return s;
  var low = s.toLowerCase();
  if (WIN_TZ_[low]) return WIN_TZ_[low];
  // Names like "(UTC-05:00) Eastern Time (US & Canada)"
  if (/eastern time/.test(low)) return 'America/New_York';
  if (/central time/.test(low)) return 'America/Chicago';
  if (/arizona/.test(low)) return 'America/Phoenix';
  if (/mountain time/.test(low)) return 'America/Denver';
  if (/pacific time/.test(low)) return 'America/Los_Angeles';
  if (/alaska/.test(low)) return 'America/Anchorage';
  if (/hawaii/.test(low)) return 'Pacific/Honolulu';
  if (/\(utc\)|^utc$|coordinated universal/.test(low)) return 'UTC';
  return fallback;
}
