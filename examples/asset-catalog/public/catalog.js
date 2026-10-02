// Asset catalog UI: list the tenant's catalog with a token the user pastes. Values from the server
// are written with textContent, never as HTML. A file, not an inline script: the default
// Content-Security-Policy a served frontend carries blocks inline code.
async function list(token) {
  const res = await fetch('/api/items', { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`listing the catalog answered ${res.status}`);
  const { items } = await res.json();
  const list = document.getElementById('items');
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = `${item.name} — ${item.file_name} (${item.content_type}, ${item.category})`;
    list.appendChild(li);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('token-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    list(form.elements.namedItem('token').value).catch((err) => {
      document.getElementById('status').textContent = err.message;
    });
  });
});
