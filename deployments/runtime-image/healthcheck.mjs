// The image's health check: the liveness endpoint of the server on this container's port. Exit 0
// when it answers 200 within the timeout, 1 otherwise. It reads no secret and prints nothing but
// the status.
// Read through a computed name: this runs inside the image, not as a turbo task input.
const PORT_VARIABLE = 'PORT';
const port = Number(process.env[PORT_VARIABLE] || 8080);
try {
  const res = await fetch(`http://127.0.0.1:${port}/livez`, { signal: AbortSignal.timeout(4000) });
  console.log(`livez ${res.status}`);
  process.exit(res.status === 200 ? 0 : 1);
} catch {
  console.log('livez unreachable');
  process.exit(1);
}
