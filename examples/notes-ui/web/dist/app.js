// Minimal, self-contained: fetch the tenant's notes (a bearer token is required) and render them.
// The static asset carries no build tooling — it is a plain script the backend serves as-is.
//
// It lives in a FILE rather than an inline <script> because the default Content-Security-Policy a
// served frontend carries (`default-src 'self'`, no `script-src`) blocks inline code; a same-origin
// file is allowed. See the `frontend` reference in docs/spec-reference.md.
async function loadNotes(token) {
  const res = await fetch('/api/notes', { headers: { authorization: 'Bearer ' + token } });
  if (!res.ok) return;
  const notes = await res.json();
  const list = document.getElementById('notes');
  for (const note of notes) {
    const li = document.createElement('li');
    li.textContent = note.title;
    list.appendChild(li);
  }
}
// A real deployment would obtain the token via the auth flow; left as an exercise here.
window.loadNotes = loadNotes;
