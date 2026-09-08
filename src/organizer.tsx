import { useMemo, useState, type FormEvent } from 'react'

export type OrganizerView = 'notes' | 'calendar'
export type OrganizerNote = {
  id: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  createdAt: number
  updatedAt: number
}
export type CalendarEntry = {
  id: string
  title: string
  details: string
  location: string
  startAt: number
  endAt?: number
  reminderMinutes: number | null
  remindedAt?: number
  createdAt: number
  updatedAt: number
}
export type OrganizerRoom = { id: string, name: string }
export type OrganizerNoteInput = Pick<OrganizerNote, 'title' | 'body' | 'tags' | 'pinned'> & { id?: string }
export type CalendarEntryInput = Pick<CalendarEntry, 'title' | 'details' | 'location' | 'startAt' | 'endAt' | 'reminderMinutes'> & { id?: string }

const weekdays = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd']

export function localDateKey(value: number | Date) {
  const date = value instanceof Date ? value : new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function dateTimeLocalValue(timestamp: number) {
  const date = new Date(timestamp)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${localDateKey(date)}T${hours}:${minutes}`
}

export function defaultEventStart(day = localDateKey(new Date())) {
  const now = new Date()
  const selected = new Date(`${day}T${String(now.getHours() + 1).padStart(2, '0')}:00`)
  if (Number.isNaN(selected.getTime())) return dateTimeLocalValue(Date.now() + 60 * 60 * 1000)
  return dateTimeLocalValue(selected.getTime())
}

export function monthDays(cursor: number) {
  const first = new Date(cursor)
  const mondayOffset = (first.getDay() + 6) % 7
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset)
  return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index))
}

export function monthCursorFor(timestamp = Date.now()) {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
}

export function shiftMonth(cursor: number, amount: number) {
  const date = new Date(cursor)
  return new Date(date.getFullYear(), date.getMonth() + amount, 1).getTime()
}

function searchValue(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pl')
}

export function noteMatches(note: OrganizerNote, query: string) {
  const needle = searchValue(query.trim())
  if (!needle) return true
  return searchValue([note.title, note.body, ...note.tags].join(' ')).includes(needle)
}

export function eventMatches(entry: CalendarEntry, query: string) {
  const needle = searchValue(query.trim())
  if (!needle) return true
  const date = new Intl.DateTimeFormat('pl', { dateStyle: 'full', timeStyle: 'short' }).format(entry.startAt)
  return searchValue([entry.title, entry.details, entry.location, date].join(' ')).includes(needle)
}

export function noteShareText(note: OrganizerNote) {
  const tags = note.tags.length ? `\n\nTagi: ${note.tags.map(tag => `#${tag}`).join(' ')}` : ''
  return `📝 ${note.title}\n\n${note.body || 'Bez dodatkowej treści.'}${tags}`
}

export function eventShareText(entry: CalendarEntry) {
  const start = new Intl.DateTimeFormat('pl', { dateStyle: 'full', timeStyle: 'short' }).format(entry.startAt)
  const end = entry.endAt ? ` – ${new Intl.DateTimeFormat('pl', { timeStyle: 'short' }).format(entry.endAt)}` : ''
  const location = entry.location ? `\nMiejsce: ${entry.location}` : ''
  const details = entry.details ? `\n\n${entry.details}` : ''
  return `📅 ${entry.title}\n${start}${end}${location}${details}`
}

export function dueReminderEntries(entries: CalendarEntry[], now = Date.now()) {
  return entries.filter(entry => {
    if (entry.reminderMinutes === null || entry.remindedAt) return false
    const remindAt = entry.startAt - entry.reminderMinutes * 60_000
    return now >= remindAt && now <= entry.startAt + 6 * 60 * 60 * 1000
  })
}

function formatEntryDate(entry: CalendarEntry) {
  const start = new Intl.DateTimeFormat('pl', { dateStyle: 'medium', timeStyle: 'short' }).format(entry.startAt)
  const end = entry.endAt ? ` – ${new Intl.DateTimeFormat('pl', { timeStyle: 'short' }).format(entry.endAt)}` : ''
  return `${start}${end}`
}

function OrganizerGlyph({ name }: { name: 'note' | 'calendar' | 'search' | 'lock' | 'bell' | 'share' | 'pin' | 'close' }) {
  const paths = {
    note: <><path d="M5 3h11l3 3v15H5z"/><path d="M9 10h6M9 14h6M9 18h4M16 3v4h4"/></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    share: <><circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/></>,
    pin: <><path d="m14 4 6 6-4 1-4 5-4-4 5-4z"/><path d="m9 15-5 5"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>
}

export function MiniCalendar({ events, onOpen }: { events: CalendarEntry[], onOpen: (day: string) => void }) {
  const cursor = monthCursorFor()
  const today = localDateKey(new Date())
  const days = monthDays(cursor)
  const eventDays = new Set(events.map(entry => localDateKey(entry.startAt)))
  return <section className="mini-calendar" aria-label="Mini kalendarz">
    <button className="mini-calendar-title" type="button" onClick={() => onOpen(today)}>
      <span><OrganizerGlyph name="calendar"/></span>
      <strong>{new Intl.DateTimeFormat('pl', { month: 'long', year: 'numeric' }).format(cursor)}</strong>
      <b aria-hidden="true">›</b>
    </button>
    <div className="mini-calendar-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
    <div className="mini-calendar-grid">{days.map(day => {
      const key = localDateKey(day)
      const outside = day.getMonth() !== new Date(cursor).getMonth()
      return <button key={key} type="button" className={`${key === today ? 'today' : ''} ${outside ? 'outside' : ''} ${eventDays.has(key) ? 'has-event' : ''}`} onClick={() => onOpen(key)} aria-label={new Intl.DateTimeFormat('pl', { dateStyle: 'full' }).format(day)}>{day.getDate()}</button>
    })}</div>
  </section>
}

type OrganizerWorkspaceProps = {
  view: OrganizerView
  notes: OrganizerNote[]
  events: CalendarEntry[]
  rooms: OrganizerRoom[]
  query: string
  selectedDay: string
  monthCursor: number
  notice: string
  notificationPermission: NotificationPermission | 'unsupported'
  onView: (view: OrganizerView) => void
  onQuery: (query: string) => void
  onSelectDay: (day: string) => void
  onMonthCursor: (cursor: number) => void
  onOpenMenu: () => void
  onSaveNote: (input: OrganizerNoteInput) => void
  onDeleteNote: (id: string) => void
  onSaveEvent: (input: CalendarEntryInput) => void
  onDeleteEvent: (id: string) => void
  onShare: (kind: OrganizerView, id: string, roomId: string) => Promise<void>
  onEnableReminders: () => Promise<void>
}

export function OrganizerWorkspace(props: OrganizerWorkspaceProps) {
  const [noteEditor, setNoteEditor] = useState<OrganizerNoteInput | null>(null)
  const [eventEditor, setEventEditor] = useState<(Omit<CalendarEntryInput, 'startAt' | 'endAt'> & { startAt: string, endAt: string }) | null>(null)
  const [shareItem, setShareItem] = useState<{ kind: OrganizerView, id: string } | null>(null)
  const [shareRoomId, setShareRoomId] = useState('')
  const [shareBusy, setShareBusy] = useState(false)
  const noteResults = useMemo(() => props.notes.filter(note => noteMatches(note, props.query)).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt), [props.notes, props.query])
  const eventResults = useMemo(() => props.events.filter(entry => eventMatches(entry, props.query)).sort((a, b) => a.startAt - b.startAt), [props.events, props.query])
  const calendarDays = monthDays(props.monthCursor)
  const eventsForDay = eventResults.filter(entry => localDateKey(entry.startAt) === props.selectedDay)
  const eventCounts = new Map<string, number>()
  props.events.forEach(entry => eventCounts.set(localDateKey(entry.startAt), (eventCounts.get(localDateKey(entry.startAt)) ?? 0) + 1))
  const searching = Boolean(props.query.trim())

  function openNewEvent() {
    const startAt = defaultEventStart(props.selectedDay)
    setEventEditor({ title: '', details: '', location: '', startAt, endAt: '', reminderMinutes: 30 })
  }

  function editEvent(entry: CalendarEntry) {
    setEventEditor({ id: entry.id, title: entry.title, details: entry.details, location: entry.location, startAt: dateTimeLocalValue(entry.startAt), endAt: entry.endAt ? dateTimeLocalValue(entry.endAt) : '', reminderMinutes: entry.reminderMinutes })
  }

  function submitEvent(event: FormEvent) {
    event.preventDefault()
    if (!eventEditor) return
    const startAt = new Date(eventEditor.startAt).getTime()
    const endAt = eventEditor.endAt ? new Date(eventEditor.endAt).getTime() : undefined
    if (!Number.isFinite(startAt) || (endAt && endAt < startAt)) return
    props.onSaveEvent({ ...eventEditor, title: eventEditor.title.trim(), details: eventEditor.details.trim(), location: eventEditor.location.trim(), startAt, endAt })
    props.onSelectDay(localDateKey(startAt))
    setEventEditor(null)
  }

  async function share() {
    if (!shareItem || !shareRoomId) return
    setShareBusy(true)
    try { await props.onShare(shareItem.kind, shareItem.id, shareRoomId); setShareItem(null); setShareRoomId('') }
    finally { setShareBusy(false) }
  }

  const noteCards = noteResults.map(note => <article className="organizer-card note-card" key={note.id}>
    <header><span><OrganizerGlyph name="note"/></span><div><h3>{note.title}</h3><small>Edytowano {new Intl.DateTimeFormat('pl', { dateStyle: 'medium', timeStyle: 'short' }).format(note.updatedAt)}</small></div>{note.pinned && <b className="pin-badge" title="Przypięta"><OrganizerGlyph name="pin"/></b>}</header>
    <p>{note.body || 'Notatka bez dodatkowej treści.'}</p>
    {note.tags.length > 0 && <div className="organizer-tags">{note.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}
    <footer><button type="button" onClick={() => setNoteEditor({ id: note.id, title: note.title, body: note.body, tags: note.tags, pinned: note.pinned })}>Edytuj</button><button type="button" onClick={() => setShareItem({ kind: 'notes', id: note.id })}><OrganizerGlyph name="share"/>Udostępnij</button><button className="danger-link" type="button" onClick={() => { if (window.confirm('Usunąć tę notatkę z tego urządzenia?')) props.onDeleteNote(note.id) }}>Usuń</button></footer>
  </article>)

  const eventCards = (searching ? eventResults : eventsForDay).map(entry => <article className="organizer-card event-card" key={entry.id}>
    <time><b>{new Date(entry.startAt).getDate()}</b><span>{new Intl.DateTimeFormat('pl', { month: 'short' }).format(entry.startAt)}</span></time>
    <div className="event-card-copy"><h3>{entry.title}</h3><strong>{formatEntryDate(entry)}</strong>{entry.location && <small>{entry.location}</small>}{entry.details && <p>{entry.details}</p>}{entry.reminderMinutes !== null && <span className="reminder-chip"><OrganizerGlyph name="bell"/>{entry.reminderMinutes === 0 ? 'W chwili rozpoczęcia' : `${entry.reminderMinutes} min wcześniej`}</span>}</div>
    <footer><button type="button" onClick={() => editEvent(entry)}>Edytuj</button><button type="button" onClick={() => setShareItem({ kind: 'calendar', id: entry.id })}><OrganizerGlyph name="share"/>Udostępnij</button><button className="danger-link" type="button" onClick={() => { if (window.confirm('Usunąć to wydarzenie z kalendarza?')) props.onDeleteEvent(entry.id) }}>Usuń</button></footer>
  </article>)

  return <section className="organizer-shell">
    <header className="organizer-header">
      <button className="mobile-logo organizer-menu" type="button" onClick={props.onOpenMenu} aria-label="Otwórz menu"><OrganizerGlyph name="calendar"/></button>
      <div><span>Prywatna przestrzeń</span><h1>Organizer</h1></div>
      <button className="organizer-add" type="button" onClick={() => props.view === 'notes' ? setNoteEditor({ title: '', body: '', tags: [], pinned: false }) : openNewEvent()}>＋ {props.view === 'notes' ? 'Nowa notatka' : 'Nowe wydarzenie'}</button>
    </header>
    <div className="organizer-toolbar">
      <div className="organizer-tabs" role="tablist" aria-label="Sekcje organizera"><button role="tab" aria-selected={props.view === 'notes'} onClick={() => props.onView('notes')}><OrganizerGlyph name="note"/>Notatki <b>{props.notes.length}</b></button><button role="tab" aria-selected={props.view === 'calendar'} onClick={() => props.onView('calendar')}><OrganizerGlyph name="calendar"/>Kalendarz <b>{props.events.length}</b></button></div>
      <label className="organizer-search"><OrganizerGlyph name="search"/><span className="sr-only">Szukaj w notatkach i kalendarzu</span><input type="search" value={props.query} onChange={event => props.onQuery(event.target.value)} placeholder="Szukaj w notatkach i wydarzeniach…"/></label>
    </div>
    <div className="organizer-privacy"><OrganizerGlyph name="lock"/><div><strong>Domyślnie prywatne</strong><small>Dane są zapisane osobno dla tego konta na tym urządzeniu. Do rozmowy trafia tylko kopia, którą samodzielnie udostępnisz.</small></div></div>
    {props.notice && <p className="organizer-notice" role="status">{props.notice}</p>}
    <div className="organizer-content">
      {searching ? <section className="organizer-search-results"><header><div><span>Wyniki wyszukiwania</span><h2>Notatki i wydarzenia</h2></div><b>{noteResults.length + eventResults.length}</b></header><h3 className="organizer-section-title">Notatki <span>{noteResults.length}</span></h3><div className="notes-grid">{noteCards.length ? noteCards : <p className="organizer-empty">Brak pasujących notatek.</p>}</div><h3 className="organizer-section-title">Wydarzenia <span>{eventResults.length}</span></h3><div className="event-list">{eventCards.length ? eventCards : <p className="organizer-empty">Brak pasujących wydarzeń.</p>}</div></section> : props.view === 'notes' ? <section><div className="organizer-section-heading"><div><span>Twoja wiedza</span><h2>Notatki</h2></div><p>Porządkuj pomysły tagami i przypinaj najważniejsze.</p></div><div className="notes-grid">{noteCards.length ? noteCards : <button className="organizer-empty-action" type="button" onClick={() => setNoteEditor({ title: '', body: '', tags: [], pinned: false })}><OrganizerGlyph name="note"/><strong>Pierwsza notatka</strong><span>Zapisz informację, do której chcesz wrócić.</span></button>}</div></section> : <section className="calendar-layout">
        <div className="calendar-main"><div className="calendar-heading"><button type="button" onClick={() => props.onMonthCursor(shiftMonth(props.monthCursor, -1))} aria-label="Poprzedni miesiąc">‹</button><div><span>Kalendarz</span><h2>{new Intl.DateTimeFormat('pl', { month: 'long', year: 'numeric' }).format(props.monthCursor)}</h2></div><button type="button" onClick={() => props.onMonthCursor(shiftMonth(props.monthCursor, 1))} aria-label="Następny miesiąc">›</button></div><div className="calendar-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{calendarDays.map(day => { const key = localDateKey(day); const count = eventCounts.get(key) ?? 0; return <button type="button" key={key} className={`${key === props.selectedDay ? 'selected' : ''} ${key === localDateKey(new Date()) ? 'today' : ''} ${day.getMonth() !== new Date(props.monthCursor).getMonth() ? 'outside' : ''}`} onClick={() => props.onSelectDay(key)}><span>{day.getDate()}</span>{count > 0 && <b>{count}</b>}</button> })}</div></div>
        <aside className="day-agenda"><header><div><span>Wybrany dzień</span><h2>{new Intl.DateTimeFormat('pl', { dateStyle: 'full' }).format(new Date(`${props.selectedDay}T12:00`))}</h2></div><button type="button" onClick={openNewEvent}>＋</button></header><section className="reminder-settings"><OrganizerGlyph name="bell"/><div><strong>Przypomnienia urządzenia</strong><small>{props.notificationPermission === 'granted' ? 'Włączone. Treść wydarzenia pozostaje ukryta w powiadomieniu.' : props.notificationPermission === 'denied' ? 'Zablokowane w ustawieniach przeglądarki.' : props.notificationPermission === 'unsupported' ? 'Niedostępne w tej przeglądarce.' : 'Włącz, aby otrzymywać dyskretne przypomnienia.'}</small></div>{props.notificationPermission === 'default' && <button type="button" onClick={() => void props.onEnableReminders()}>Włącz</button>}</section><div className="event-list">{eventCards.length ? eventCards : <button className="organizer-empty-action compact" type="button" onClick={openNewEvent}><OrganizerGlyph name="calendar"/><strong>Wolny dzień</strong><span>Dodaj wydarzenie lub przypomnienie.</span></button>}</div></aside>
      </section>}
    </div>
    {noteEditor && <div className="modal-layer" role="presentation"><section className="modal organizer-editor" role="dialog" aria-modal="true" aria-labelledby="note-editor-title"><button className="icon-button modal-close" type="button" onClick={() => setNoteEditor(null)} aria-label="Zamknij"><OrganizerGlyph name="close"/></button><span className="modal-icon"><OrganizerGlyph name="note"/></span><h2 id="note-editor-title">{noteEditor.id ? 'Edytuj notatkę' : 'Nowa notatka'}</h2><p>Notatka pozostanie prywatna, dopóki jej nie udostępnisz.</p><form onSubmit={event => { event.preventDefault(); props.onSaveNote({ ...noteEditor, title: noteEditor.title.trim(), body: noteEditor.body.trim(), tags: noteEditor.tags.map(tag => tag.trim().replace(/^#/, '')).filter(Boolean) }); setNoteEditor(null) }}><label>Tytuł<input autoFocus required maxLength={100} value={noteEditor.title} onChange={event => setNoteEditor(current => current && ({ ...current, title: event.target.value }))} placeholder="np. Ustalenia ze spotkania"/></label><label>Treść<textarea rows={9} maxLength={10000} value={noteEditor.body} onChange={event => setNoteEditor(current => current && ({ ...current, body: event.target.value }))} placeholder="Zapisz szczegóły…"/></label><label>Tagi<input maxLength={200} value={noteEditor.tags.join(', ')} onChange={event => setNoteEditor(current => current && ({ ...current, tags: event.target.value.split(',') }))} placeholder="projekt, ważne, pomysł"/></label><label className="setting-toggle"><span><strong>Przypnij notatkę</strong><small>Pokaż ją na początku listy.</small></span><input type="checkbox" checked={noteEditor.pinned} onChange={event => setNoteEditor(current => current && ({ ...current, pinned: event.target.checked }))}/></label><button className="primary-button">Zapisz notatkę</button></form></section></div>}
    {eventEditor && <div className="modal-layer" role="presentation"><section className="modal organizer-editor" role="dialog" aria-modal="true" aria-labelledby="event-editor-title"><button className="icon-button modal-close" type="button" onClick={() => setEventEditor(null)} aria-label="Zamknij"><OrganizerGlyph name="close"/></button><span className="modal-icon"><OrganizerGlyph name="calendar"/></span><h2 id="event-editor-title">{eventEditor.id ? 'Edytuj wydarzenie' : 'Nowe wydarzenie'}</h2><p>Wydarzenie jest prywatne. Przypomnienie nie pokazuje jego treści na ekranie blokady.</p><form onSubmit={submitEvent}><label>Nazwa wydarzenia<input autoFocus required maxLength={120} value={eventEditor.title} onChange={event => setEventEditor(current => current && ({ ...current, title: event.target.value }))} placeholder="np. Spotkanie z zespołem"/></label><div className="organizer-form-row"><label>Początek<input required type="datetime-local" value={eventEditor.startAt} onChange={event => setEventEditor(current => current && ({ ...current, startAt: event.target.value }))}/></label><label>Koniec — opcjonalnie<input type="datetime-local" min={eventEditor.startAt} value={eventEditor.endAt} onChange={event => setEventEditor(current => current && ({ ...current, endAt: event.target.value }))}/></label></div><label>Miejsce<input maxLength={160} value={eventEditor.location} onChange={event => setEventEditor(current => current && ({ ...current, location: event.target.value }))} placeholder="Adres lub nazwa miejsca"/></label><label>Szczegóły<textarea rows={5} maxLength={5000} value={eventEditor.details} onChange={event => setEventEditor(current => current && ({ ...current, details: event.target.value }))} placeholder="Opis, agenda, potrzebne informacje…"/></label><label>Przypomnienie<select value={eventEditor.reminderMinutes === null ? 'none' : String(eventEditor.reminderMinutes)} onChange={event => setEventEditor(current => current && ({ ...current, reminderMinutes: event.target.value === 'none' ? null : Number(event.target.value) }))}><option value="none">Bez przypomnienia</option><option value="0">W chwili rozpoczęcia</option><option value="5">5 minut wcześniej</option><option value="15">15 minut wcześniej</option><option value="30">30 minut wcześniej</option><option value="60">1 godzinę wcześniej</option><option value="1440">1 dzień wcześniej</option></select></label><button className="primary-button">Zapisz wydarzenie</button></form></section></div>}
    {shareItem && <div className="modal-layer" role="presentation"><section className="modal organizer-share-dialog" role="dialog" aria-modal="true" aria-labelledby="organizer-share-title"><button className="icon-button modal-close" type="button" onClick={() => setShareItem(null)} aria-label="Zamknij"><OrganizerGlyph name="close"/></button><span className="modal-icon"><OrganizerGlyph name="share"/></span><h2 id="organizer-share-title">Udostępnij kopię</h2><p>Wybierz szyfrowaną rozmowę. Oryginał nadal pozostanie prywatny i nie będzie aktualizował wysłanej kopii.</p>{props.rooms.length ? <><label>Rozmowa<select value={shareRoomId} onChange={event => setShareRoomId(event.target.value)}><option value="">Wybierz rozmowę…</option>{props.rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label><button className="primary-button" type="button" disabled={!shareRoomId || shareBusy} onClick={() => void share()}>{shareBusy ? 'Udostępnianie…' : 'Wyślij do rozmowy'}</button></> : <p className="organizer-empty">Nie masz jeszcze rozmowy, do której można wysłać kopię.</p>}</section></div>}
  </section>
}
