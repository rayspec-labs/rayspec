// Team notes UI: sign in, pick the user's organization, then list, add, edit and delete its notes.
//
// It reads `/app-version.json`, which the build writes from the release spec, for the application
// version it shows and the note fields it edits — so one UI serves every release. The application
// version is the application's own and is not the runtime version.
//
// Every value from the server is written with textContent, never as HTML.

const PAGE_SIZE = 20;
const state = { token: '', fields: [], cursor: null };

const $ = (id) => document.getElementById(id);

function status(text) {
  $('status').textContent = text;
}

async function api(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (state.token !== '') headers.authorization = `Bearer ${state.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${res.status}`);
  return res;
}

async function loadVersion() {
  const res = await fetch('/app-version.json');
  const info = await res.json();
  $('app-version').textContent = info.version;
  state.fields = info.fields;
  const container = $('note-fields');
  container.replaceChildren();
  for (const field of state.fields) {
    const label = document.createElement('label');
    label.textContent = field;
    const input = document.createElement(field === 'content' ? 'textarea' : 'input');
    input.name = field;
    input.required = field === 'title';
    label.appendChild(input);
    container.appendChild(label);
  }
}

async function signIn(email, password) {
  const login = await api('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  state.token = (await login.json()).accessToken;
  const { orgs } = await (await api('/v1/orgs')).json();
  if (orgs.length === 0) throw new Error('this account belongs to no organization');
  const switched = await api(`/v1/orgs/${encodeURIComponent(orgs[0].id)}/switch`, {
    method: 'POST',
  });
  state.token = (await switched.json()).accessToken;
}

function noteItem(note) {
  const li = document.createElement('li');
  const title = document.createElement('strong');
  title.textContent = note.title;
  li.appendChild(title);
  if (typeof note.label === 'string' && note.label !== '') {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = note.label;
    li.appendChild(label);
  }
  if (typeof note.content === 'string') {
    const content = document.createElement('p');
    content.textContent = note.content;
    li.appendChild(content);
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => startEdit(note));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Delete';
  remove.addEventListener('click', () => removeNote(note.id).catch((e) => status(e.message)));
  li.append(edit, remove);
  return li;
}

async function loadPage(reset) {
  if (reset) {
    state.cursor = null;
    $('notes').replaceChildren();
  }
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (state.cursor !== null) query.set('after', state.cursor);
  const res = await api(`/api/notes?${query}`);
  const notes = await res.json();
  for (const note of notes) $('notes').appendChild(noteItem(note));
  state.cursor = notes.length === PAGE_SIZE ? res.headers.get('x-next-cursor') : null;
  $('more').hidden = state.cursor === null;
}

function formValues() {
  const form = $('note-form');
  const values = {};
  for (const field of state.fields) {
    const value = form.elements.namedItem(field).value;
    values[field] = field === 'label' && value === '' ? null : value;
  }
  return values;
}

function startEdit(note) {
  const form = $('note-form');
  form.elements.namedItem('id').value = note.id;
  for (const field of state.fields) form.elements.namedItem(field).value = note[field] ?? '';
  $('save').textContent = 'Save note';
  $('cancel').hidden = false;
}

function resetForm() {
  $('note-form').reset();
  $('note-form').elements.namedItem('id').value = '';
  $('save').textContent = 'Add note';
  $('cancel').hidden = true;
}

async function saveNote() {
  const id = $('note-form').elements.namedItem('id').value;
  const body = JSON.stringify(formValues());
  if (id === '') await api('/api/notes', { method: 'POST', body });
  else await api(`/api/notes/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  resetForm();
  await loadPage(true);
}

async function removeNote(id) {
  await api(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await loadPage(true);
}

function on(id, event, handler) {
  $(id).addEventListener(event, (e) => {
    e.preventDefault();
    handler().catch((err) => status(err.message));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadVersion().catch((e) => status(e.message));
  on('login', 'submit', async () => {
    const form = $('login');
    await signIn(form.elements.namedItem('email').value, form.elements.namedItem('password').value);
    form.hidden = true;
    $('notes-view').hidden = false;
    status('');
    await loadPage(true);
  });
  on('note-form', 'submit', saveNote);
  on('cancel', 'click', async () => resetForm());
  on('more', 'click', async () => loadPage(false));
});
